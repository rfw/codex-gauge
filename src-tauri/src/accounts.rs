use atomic_write_file::AtomicWriteFile;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use notify::{Event, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::runtime;
use crate::settings;
use crate::usage::{self, AccountUsage};

const METADATA_VERSION: u32 = 1;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);
const SELF_WRITE_TTL: Duration = Duration::from_secs(5);
const TEMP_CODEX_CONFIG: &str = r#"cli_auth_credentials_store = "file"
"#;

pub struct AuthWatcherState {
    self_writes: Mutex<Vec<SelfWriteGuard>>,
}

impl AuthWatcherState {
    pub fn new() -> Self {
        Self {
            self_writes: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Debug)]
struct SelfWriteGuard {
    expected_hash: String,
    expires_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountsMetadata {
    version: u32,
    accounts: Vec<StoredAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAccount {
    pub(crate) id: String,
    label: String,
    email: Option<String>,
    plan: String,
    pub(crate) credential_file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsSnapshot {
    accounts: Vec<AccountView>,
    fetched_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountView {
    id: String,
    label: String,
    email: Option<String>,
    plan: String,
    is_active: bool,
    five_hour: Option<QuotaWindowView>,
    weekly: Option<QuotaWindowView>,
    banked_resets: Option<BankedResetsView>,
    usage_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaWindowView {
    pub(crate) used_percent: f64,
    pub(crate) window_duration_mins: u64,
    pub(crate) resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BankedResetView {
    pub(crate) id: String,
    pub(crate) label: Option<String>,
    pub(crate) details: Option<String>,
    pub(crate) expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BankedResetsView {
    pub(crate) available_count: u64,
    pub(crate) items: Vec<BankedResetView>,
}

#[derive(Debug, Clone)]
pub(crate) struct AuthIdentity {
    pub(crate) id: String,
    email: Option<String>,
    plan: String,
}

pub fn start_auth_watcher(app: AppHandle) -> Result<(), String> {
    let codex_home = main_codex_home(&app)?;

    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("Failed to create Codex home for watcher: {error}"))?;

    std::thread::Builder::new()
        .name("codexgauge-auth-watcher".to_string())
        .spawn(move || {
            if let Err(error) = auth_watch_loop(app, codex_home) {
                log::error!("Auth watcher stopped: {error}");
            }
        })
        .map_err(|error| format!("Failed to spawn auth watcher: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn list_codex_accounts(app: AppHandle) -> Result<AccountsSnapshot, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        import_current_account_if_needed(&app)?;
        build_snapshot_with_usage(&app)
    })
    .await
    {
        Ok(Ok(snapshot)) => Ok(snapshot),
        Ok(Err(error)) => {
            log::error!("Unable to refresh Codex accounts and usage: {error}");
            Err("Unable to refresh Codex usage.".to_string())
        }
        Err(error) => {
            log::error!("Codex account refresh task failed: {error}");
            Err("Unable to refresh Codex usage.".to_string())
        }
    }
}

#[tauri::command]
pub async fn add_codex_account(app: AppHandle) -> Result<AccountsSnapshot, String> {
    let result: Result<AccountsSnapshot, String> = async {
        let proxy_settings = settings::load_proxy_settings(&app)?.proxy;

        let temp = tempfile::tempdir()
            .map_err(|error| format!("Failed to create temporary Codex home: {error}"))?;

        fs::write(temp.path().join("config.toml"), TEMP_CODEX_CONFIG)
            .map_err(|error| format!("Failed to prepare temporary Codex config: {error}"))?;

        let temp_home = temp.path().to_path_buf();

        let status = tauri::async_runtime::spawn_blocking(move || {
            run_codex_login(&temp_home, &proxy_settings)
        })
        .await
        .map_err(|error| format!("Codex login task failed: {error}"))??;

        if !status.success() {
            return Err(match status.code() {
                Some(code) => format!("Codex login did not complete successfully (exit code {code})."),
                None => "Codex login was interrupted.".to_string(),
            });
        }

        let auth_path = temp.path().join("auth.json");
        let auth_bytes = fs::read(&auth_path).map_err(|error| {
            format!(
                "Codex login completed but no readable auth.json was produced: {error}"
            )
        })?;

        let identity = parse_auth_identity(&auth_bytes)?;
        persist_account_auth(&app, &identity, &auth_bytes)?;

        tauri::async_runtime::spawn_blocking(move || build_snapshot_with_usage(&app))
            .await
            .map_err(|error| format!("Failed to refresh accounts after login: {error}"))?
    }
    .await;

    match result {
        Ok(snapshot) => {
            log::info!("Codex account added successfully");
            Ok(snapshot)
        }
        Err(error) => {
            log::error!("Unable to add Codex account: {error}");
            Err("Unable to add Codex account.".to_string())
        }
    }
}

#[tauri::command]
pub async fn rename_codex_account(
    app: AppHandle,
    account_id: String,
    label: String,
) -> Result<AccountsSnapshot, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let next_label = label.trim();

        if next_label.is_empty() {
            return Err("Account name cannot be empty.".to_string());
        }

        let mut metadata = load_metadata(&app)?;
        let account = metadata
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or_else(|| "Account not found.".to_string())?;

        account.label = next_label.to_string();
        save_metadata(&app, &metadata)?;

        build_snapshot_with_usage(&app)
    })
    .await
    {
        Ok(Ok(snapshot)) => Ok(snapshot),
        Ok(Err(error)) if error == "Account name cannot be empty." || error == "Account not found." => {
            Err(error)
        }
        Ok(Err(error)) => {
            log::error!("Unable to rename Codex account: {error}");
            Err("Unable to rename Codex account.".to_string())
        }
        Err(error) => {
            log::error!("Codex account rename task failed: {error}");
            Err("Unable to rename Codex account.".to_string())
        }
    }
}

#[tauri::command]
pub async fn switch_codex_account(
    app: AppHandle,
    account_id: String,
) -> Result<AccountsSnapshot, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        runtime::ensure_codex_not_running()?;
        import_current_account_if_needed(&app)?;

        let metadata = load_metadata(&app)?;
        let target = metadata
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .cloned()
            .ok_or_else(|| "Account not found.".to_string())?;

        let stored_target_auth = load_account_auth(&app, &target)?;
        let target_identity = parse_auth_identity(&stored_target_auth)?;

        if target_identity.id != target.id {
            return Err(
                "Stored credential identity does not match the selected account.".to_string(),
            );
        }

        // Validate the target account in an isolated CODEX_HOME before touching
        // the real ~/.codex/auth.json. Codex app-server may refresh an expired
        // access token here; the refreshed auth is persisted before switching.
        let target_auth =
            usage::validate_account_auth_for_switch(&app, &target, &stored_target_auth)?;

        let main_auth_path = main_codex_home(&app)?.join("auth.json");

        if let Some(parent) = main_auth_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create Codex home: {error}"))?;
        }

        let previous_auth = fs::read(&main_auth_path).ok();
        let expected_hash = auth_content_hash(&target_auth);

        install_self_write_guard(&app, &expected_hash)?;

        if let Err(error) = atomic_write(&main_auth_path, &target_auth) {
            return Err(format!("Failed to switch Codex account: {error}"));
        }

        let verification = fs::read(&main_auth_path)
            .map_err(|error| format!("Failed to verify switched auth.json: {error}"))
            .and_then(|bytes| parse_auth_identity(&bytes));

        match verification {
            Ok(identity) if identity.id == target.id => build_snapshot_with_usage(&app),
            Ok(_) | Err(_) => {
                if let Some(previous) = previous_auth {
                    let rollback_hash = auth_content_hash(&previous);
                    let _ = install_self_write_guard(&app, &rollback_hash);
                    let _ = atomic_write(&main_auth_path, &previous);
                } else {
                    let _ = fs::remove_file(&main_auth_path);
                }

                Err(
                    "Account switch verification failed. The previous auth was restored."
                        .to_string(),
                )
            }
        }
    })
    .await
    {
        Ok(Ok(snapshot)) => {
            log::info!("Codex account switch completed successfully");
            Ok(snapshot)
        }
        Ok(Err(error))
            if error.starts_with("Codex is currently running (") || error == "Account not found." =>
        {
            Err(error)
        }
        Ok(Err(error)) => {
            log::error!("Unable to switch Codex account: {error}");

            let lower = error.to_ascii_lowercase();

            if lower.contains("pre-switch account validation failed") {
                if lower.contains("unauthorized")
                    || lower.contains("401")
                    || lower.contains("authentication")
                    || lower.contains("not authenticated")
                    || lower.contains("not logged in")
                    || lower.contains("refresh token")
                    || lower.contains("token expired")
                    || lower.contains("invalid_grant")
                {
                    Err(
                        "Stored account sign-in has expired. Re-add the account before switching."
                            .to_string(),
                    )
                } else if lower.contains("backend-api/wham/usage")
                    || lower.contains("error sending request for url")
                    || lower.contains("connect")
                    || lower.contains("dns")
                    || lower.contains("proxy")
                {
                    Err(
                        "Unable to verify the target account. Check your network or proxy settings and try again."
                            .to_string(),
                    )
                } else {
                    Err("Unable to verify the target account before switching.".to_string())
                }
            } else if lower.contains("stored credential identity")
                || lower.contains("credential")
                || lower.contains("decrypt")
                || lower.contains("authentication")
                || lower.contains("id_token")
                || lower.contains("auth.json")
            {
                Err("Stored account authentication is unavailable.".to_string())
            } else if lower.contains("failed to switch codex account")
                || lower.contains("failed to create codex home")
                || lower.contains("permission")
                || lower.contains("access is denied")
            {
                Err("Unable to update Codex authentication.".to_string())
            } else if lower.contains("account switch verification failed") {
                Err(
                    "Account switch verification failed. The previous account was restored."
                        .to_string(),
                )
            } else {
                Err("Unable to switch Codex account.".to_string())
            }
        }
        Err(error) => {
            log::error!("Codex account switch task failed: {error}");
            Err("Unable to switch Codex account.".to_string())
        }
    }
}

#[tauri::command]
pub async fn delete_codex_account(
    app: AppHandle,
    account_id: String,
) -> Result<AccountsSnapshot, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let active_id = current_account_id(&app);

        if active_id.as_deref() == Some(account_id.as_str()) {
            return Err(
                "The current account cannot be deleted. Switch to another account first."
                    .to_string(),
            );
        }

        let mut metadata = load_metadata(&app)?;
        let position = metadata
            .accounts
            .iter()
            .position(|account| account.id == account_id)
            .ok_or_else(|| "Account not found.".to_string())?;

        let removed = metadata.accounts.remove(position);

        save_metadata(&app, &metadata)?;

        let credential_path = credential_dir(&app)?.join(&removed.credential_file);

        match fs::remove_file(&credential_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!("Could not remove an orphaned credential file: {error}");
            }
        }

        emit_accounts_changed(&app);
        build_snapshot_with_usage(&app)
    })
    .await
    {
        Ok(Ok(snapshot)) => Ok(snapshot),
        Ok(Err(error))
            if error == "Account not found."
                || error.starts_with("The current account cannot be deleted.") =>
        {
            Err(error)
        }
        Ok(Err(error)) => {
            log::error!("Unable to delete Codex account: {error}");
            Err("Unable to delete Codex account.".to_string())
        }
        Err(error) => {
            log::error!("Codex account delete task failed: {error}");
            Err("Unable to delete Codex account.".to_string())
        }
    }
}

fn build_snapshot_with_usage(app: &AppHandle) -> Result<AccountsSnapshot, String> {
    let metadata = load_metadata(app)?;
    let active_id = current_account_id(app);

    let mut accounts = Vec::with_capacity(metadata.accounts.len());

    for account in metadata.accounts {
        let (usage, usage_error) =
            match usage::read_account_usage(app, &account, active_id.as_deref()) {
                Ok(usage) => (usage, None),
                Err(error) => {
                    log::warn!("Could not read usage for a Codex account: {error}");

                    (
                        AccountUsage::default(),
                        Some(classify_usage_error(&error)),
                    )
                }
            };

        accounts.push(AccountView {
            is_active: active_id.as_deref() == Some(account.id.as_str()),
            id: account.id,
            label: account.label,
            email: account.email,
            plan: account.plan,
            five_hour: usage.five_hour,
            weekly: usage.weekly,
            banked_resets: usage.banked_resets,
            usage_error,
        });
    }

    Ok(AccountsSnapshot {
        accounts,
        fetched_at: unix_millis(),
    })
}

fn classify_usage_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();

    if lower.contains("not found")
        && (lower.contains("codex") || lower.contains("path"))
    {
        return "Codex CLI was not found.".to_string();
    }

    if lower.contains("timed out") {
        return "Codex did not return usage data in time.".to_string();
    }

    if lower.contains("authentication")
        || lower.contains("auth.json")
        || lower.contains("id_token")
        || lower.contains("credential")
    {
        return "Codex authentication could not be verified.".to_string();
    }

    if lower.contains("backend-api/wham/usage")
        || lower.contains("error sending request for url")
        || lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("proxy")
    {
        return "Unable to reach ChatGPT. Check Network proxy settings.".to_string();
    }

    if lower.contains("app-server") {
        return "Codex app-server could not provide usage data.".to_string();
    }

    "Usage data is temporarily unavailable.".to_string()
}

fn auth_watch_loop(app: AppHandle, codex_home: PathBuf) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = tx.send(result);
    })
    .map_err(|error| format!("Failed to create filesystem watcher: {error}"))?;

    watcher
        .watch(&codex_home, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Failed to watch Codex home: {error}"))?;

    loop {
        let first = rx
            .recv()
            .map_err(|error| format!("Auth watcher channel closed: {error}"))?;

        match first {
            Ok(event) if event_touches_auth_json(&event) => {}
            Ok(_) => continue,
            Err(error) => {
                log::warn!("Auth watcher event error: {error}");
                continue;
            }
        }

        let deadline = Instant::now() + WATCH_DEBOUNCE;

        loop {
            let now = Instant::now();

            if now >= deadline {
                break;
            }

            match rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    log::warn!("Auth watcher event error: {error}");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Auth watcher channel disconnected.".to_string())
                }
            }
        }

        if let Err(error) = handle_auth_json_change(&app) {
            log::error!("Could not process auth.json change: {error}");
        }
    }
}

fn event_touches_auth_json(event: &Event) -> bool {
    event.paths.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("auth.json"))
            .unwrap_or(false)
    })
}

fn handle_auth_json_change(app: &AppHandle) -> Result<(), String> {
    let auth_path = main_codex_home(app)?.join("auth.json");

    let auth_bytes = match fs::read(&auth_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            emit_accounts_changed(app);
            return Ok(());
        }
        Err(error) => return Err(format!("Failed to read changed auth.json: {error}")),
    };

    let hash = auth_content_hash(&auth_bytes);

    if is_expected_self_write(app, &hash)? {
        return Ok(());
    }

    let identity = match parse_auth_identity(&auth_bytes) {
        Ok(identity) => identity,
        Err(_) => {
            emit_accounts_changed(app);
            return Ok(());
        }
    };

    persist_account_auth(app, &identity, &auth_bytes)?;
    emit_accounts_changed(app);

    Ok(())
}

fn install_self_write_guard(app: &AppHandle, expected_hash: &str) -> Result<(), String> {
    let state = app.state::<AuthWatcherState>();
    let mut guards = state
        .self_writes
        .lock()
        .map_err(|_| "Auth watcher state lock was poisoned.".to_string())?;

    let now = Instant::now();
    guards.retain(|guard| guard.expires_at > now);

    guards.push(SelfWriteGuard {
        expected_hash: expected_hash.to_string(),
        expires_at: now + SELF_WRITE_TTL,
    });

    Ok(())
}

fn is_expected_self_write(app: &AppHandle, hash: &str) -> Result<bool, String> {
    let state = app.state::<AuthWatcherState>();
    let mut guards = state
        .self_writes
        .lock()
        .map_err(|_| "Auth watcher state lock was poisoned.".to_string())?;

    let now = Instant::now();
    guards.retain(|guard| guard.expires_at > now);

    Ok(guards.iter().any(|guard| guard.expected_hash == hash))
}

fn emit_accounts_changed(app: &AppHandle) {
    let _ = app.emit("codex-accounts-changed", ());
}

fn run_codex_login(
    codex_home: &Path,
    proxy: &settings::ProxySettings,
) -> Result<ExitStatus, String> {
    let config_override = settings::codex_config_override(proxy);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let probe = Command::new("cmd.exe")
            .args(["/D", "/C", "where", "codex"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to locate Codex CLI: {error}"))?;

        if !probe.success() {
            return Err(
                "Codex CLI was not found in PATH. Install Codex CLI or restart CodexGauge after updating PATH."
                    .to_string(),
            );
        }

        let mut command = Command::new("cmd.exe");

        command
            .args([
                "/D",
                "/C",
                "codex",
                "-c",
                config_override,
                "login",
            ])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        settings::configure_codex_command(&mut command, proxy)?;

        command
            .status()
            .map_err(|error| format!("Failed to start Codex login: {error}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("codex");

        command
            .args(["-c", config_override, "login"])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1");

        settings::configure_codex_command(&mut command, proxy)?;

        command
            .status()
            .map_err(|error| format!("Failed to start Codex login: {error}"))
    }
}

fn import_current_account_if_needed(app: &AppHandle) -> Result<(), String> {
    let auth_path = main_codex_home(app)?.join("auth.json");

    let auth_bytes = match fs::read(&auth_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read current Codex authentication: {error}"
            ))
        }
    };

    let identity = match parse_auth_identity(&auth_bytes) {
        Ok(identity) => identity,
        Err(_) => return Ok(()),
    };

    persist_account_auth(app, &identity, &auth_bytes)
}

pub(crate) fn persist_account_auth(
    app: &AppHandle,
    identity: &AuthIdentity,
    auth_bytes: &[u8],
) -> Result<(), String> {
    let mut metadata = load_metadata(app)?;
    let credential_file = format!("{}.bin", identity.id);

    save_account_auth(app, &credential_file, auth_bytes)?;

    if let Some(existing) = metadata
        .accounts
        .iter_mut()
        .find(|account| account.id == identity.id)
    {
        existing.email = identity.email.clone();
        existing.plan = identity.plan.clone();
        existing.credential_file = credential_file;
    } else {
        let next_index = metadata.accounts.len() + 1;

        metadata.accounts.push(StoredAccount {
            id: identity.id.clone(),
            label: format!("Account {next_index}"),
            email: identity.email.clone(),
            plan: identity.plan.clone(),
            credential_file,
        });
    }

    save_metadata(app, &metadata)
}

fn save_account_auth(
    app: &AppHandle,
    credential_file: &str,
    auth_bytes: &[u8],
) -> Result<(), String> {
    let encrypted = protect_secret(auth_bytes)?;
    let path = credential_dir(app)?.join(credential_file);

    atomic_write(&path, &encrypted)
        .map_err(|error| format!("Failed to securely store Codex credentials: {error}"))
}

pub(crate) fn load_account_auth(
    app: &AppHandle,
    account: &StoredAccount,
) -> Result<Vec<u8>, String> {
    let path = credential_dir(app)?.join(&account.credential_file);
    let encrypted = fs::read(&path)
        .map_err(|error| format!("Failed to read stored credentials: {error}"))?;

    unprotect_secret(&encrypted)
}

#[cfg(target_os = "windows")]
fn protect_secret(input: &[u8]) -> Result<Vec<u8>, String> {
    windows_dpapi::encrypt_data(input, windows_dpapi::Scope::User, None)
        .map_err(|error| format!("Windows DPAPI encryption failed: {error}"))
}

#[cfg(target_os = "windows")]
fn unprotect_secret(input: &[u8]) -> Result<Vec<u8>, String> {
    windows_dpapi::decrypt_data(input, windows_dpapi::Scope::User, None)
        .map_err(|error| format!("Windows DPAPI decryption failed: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn protect_secret(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("Secure credential storage is currently implemented for Windows only.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_secret(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("Secure credential storage is currently implemented for Windows only.".to_string())
}

pub(crate) fn parse_auth_identity(auth_bytes: &[u8]) -> Result<AuthIdentity, String> {
    let auth: Value = serde_json::from_slice(auth_bytes)
        .map_err(|error| format!("Invalid Codex auth.json: {error}"))?;

    let tokens = auth
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| "Only ChatGPT token authentication is supported.".to_string())?;

    let token_account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Codex auth.json does not contain a ChatGPT id_token.".to_string())?;

    let claims = decode_jwt_payload(id_token)?;

    let profile = claims
        .get("https://api.openai.com/profile")
        .and_then(Value::as_object);

    let auth_claims = claims
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object);

    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let claim_account_id = auth_claims
        .and_then(|value| value.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let user_id = auth_claims
        .and_then(|value| {
            value
                .get("chatgpt_user_id")
                .or_else(|| value.get("user_id"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let identity_seed = token_account_id
        .or(claim_account_id)
        .or(user_id)
        .or_else(|| email.clone())
        .ok_or_else(|| "Unable to determine a stable ChatGPT account identity.".to_string())?;

    let plan = auth_claims
        .and_then(|value| value.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .map(display_plan)
        .unwrap_or_else(|| "ChatGPT".to_string());

    Ok(AuthIdentity {
        id: stable_account_id(&identity_seed),
        email,
        plan,
    })
}

fn decode_jwt_payload(jwt: &str) -> Result<Value, String> {
    let payload = jwt
        .split('.')
        .nth(1)
        .ok_or_else(|| "Invalid ChatGPT id_token.".to_string())?;

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .map_err(|error| format!("Unable to decode ChatGPT id_token: {error}"))?;

    serde_json::from_slice(&decoded)
        .map_err(|error| format!("Unable to parse ChatGPT id_token claims: {error}"))
}

fn stable_account_id(identity_seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"CodexGauge/account/");
    hasher.update(identity_seed.as_bytes());

    let digest = hasher.finalize();
    let hex = format!("{digest:x}");

    hex[..24].to_string()
}

fn auth_content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn display_plan(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return "ChatGPT".to_string();
    }

    let words = trimmed
        .split(['_', '-', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();

            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>()
                        + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    format!("ChatGPT {words}")
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve CodexGauge app data directory: {error}"))?;

    fs::create_dir_all(&path)
        .map_err(|error| format!("Unable to create CodexGauge app data directory: {error}"))?;

    Ok(path)
}

fn credential_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app_data_dir(app)?.join("credentials");

    fs::create_dir_all(&path)
        .map_err(|error| format!("Unable to create credential directory: {error}"))?;

    Ok(path)
}

fn metadata_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("accounts.json"))
}

fn load_metadata(app: &AppHandle) -> Result<AccountsMetadata, String> {
    let path = metadata_path(app)?;

    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AccountsMetadata {
                version: METADATA_VERSION,
                accounts: Vec::new(),
            })
        }
        Err(error) => return Err(format!("Failed to read account metadata: {error}")),
    };

    let mut metadata: AccountsMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid account metadata: {error}"))?;

    if metadata.version == 0 {
        metadata.version = METADATA_VERSION;
    }

    Ok(metadata)
}

fn save_metadata(app: &AppHandle, metadata: &AccountsMetadata) -> Result<(), String> {
    let path = metadata_path(app)?;
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| format!("Failed to serialize account metadata: {error}"))?;

    atomic_write(&path, &bytes)
        .map_err(|error| format!("Failed to save account metadata: {error}"))
}

pub(crate) fn main_codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = env::var("CODEX_HOME") {
        let trimmed = value.trim();

        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Unable to resolve user home directory: {error}"))?;

    Ok(home.join(".codex"))
}

fn current_account_id(app: &AppHandle) -> Option<String> {
    let auth_path = main_codex_home(app).ok()?.join("auth.json");
    let auth_bytes = fs::read(auth_path).ok()?;
    parse_auth_identity(&auth_bytes).ok().map(|identity| identity.id)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = AtomicWriteFile::open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.commit()
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
