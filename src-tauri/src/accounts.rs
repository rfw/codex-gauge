use atomic_write_file::AtomicWriteFile;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use notify::{Event, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
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
const REAUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOGIN_APP_SERVER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const LOGIN_MAX_STDERR_LINES: usize = 12;

pub struct AuthWatcherState {
    self_writes: Mutex<Vec<SelfWriteGuard>>,
    last_observed_auth: Mutex<Option<ObservedAuth>>,
}

impl AuthWatcherState {
    pub fn new() -> Self {
        Self {
            self_writes: Mutex::new(Vec::new()),
            last_observed_auth: Mutex::new(None),
        }
    }
}


pub struct ReauthSessionState {
    sessions: Mutex<HashMap<String, ReauthSession>>,
}

impl ReauthSessionState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct ReauthSession {
    account_id: String,
    login_id: String,
    started_at: Instant,
    _temp: tempfile::TempDir,
    child: Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::Receiver<String>,
    stderr_rx: mpsc::Receiver<String>,
    diagnostics: VecDeque<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReauthStartResponse {
    session_id: String,
    auth_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReauthPollResponse {
    status: ReauthPollStatus,
    snapshot: Option<AccountsSnapshot>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReauthPollStatus {
    Pending,
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone)]
struct ObservedAuth {
    account_id: String,
    auth_bytes: Vec<u8>,
    hash: String,
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
    plan_type: Option<String>,
    is_active: bool,
    five_hour: Option<QuotaWindowView>,
    weekly: Option<QuotaWindowView>,
    credits: Option<CreditBalanceView>,
    banked_resets: Option<BankedResetsView>,
    usage_error_kind: Option<UsageErrorKind>,
    usage_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum UsageErrorKind {
    Cli,
    Timeout,
    Auth,
    Network,
    AppServer,
    Unknown,
}

#[derive(Debug, Clone)]
struct ClassifiedUsageError {
    kind: UsageErrorKind,
    message: &'static str,
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
pub(crate) struct CreditBalanceView {
    pub(crate) has_credits: bool,
    pub(crate) unlimited: bool,
    pub(crate) balance: Option<String>,
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
pub async fn start_reauthenticate_codex_account(
    app: AppHandle,
    account_id: String,
) -> Result<ReauthStartResponse, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        start_reauthentication_session(&app, &account_id)
    })
    .await
    {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error))
            if error == "Account not found."
                || error == "Another Codex sign-in is already in progress." =>
        {
            Err(error)
        }
        Ok(Err(error)) => {
            log::error!("Unable to start Codex account reauthentication: {error}");
            Err("Unable to start Codex sign-in.".to_string())
        }
        Err(error) => {
            log::error!("Codex account reauthentication start task failed: {error}");
            Err("Unable to start Codex sign-in.".to_string())
        }
    }
}

#[tauri::command]
pub async fn poll_reauthenticate_codex_account(
    app: AppHandle,
    session_id: String,
) -> Result<ReauthPollResponse, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        poll_reauthentication_session(&app, &session_id)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            log::error!("Codex account reauthentication poll task failed: {error}");
            Err("Unable to complete Codex sign-in.".to_string())
        }
    }
}

#[tauri::command]
pub fn cancel_reauthenticate_codex_account(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let state = app.state::<ReauthSessionState>();
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Codex sign-in state lock was poisoned.".to_string())?;

    let Some(mut session) = sessions.remove(&session_id) else {
        return Ok(());
    };

    drop(sessions);
    cancel_reauth_session(&mut session);
    Ok(())
}

fn start_reauthentication_session(
    app: &AppHandle,
    account_id: &str,
) -> Result<ReauthStartResponse, String> {
    {
        let metadata = load_metadata(app)?;
        if !metadata.accounts.iter().any(|account| account.id == account_id) {
            return Err("Account not found.".to_string());
        }
    }

    {
        let state = app.state::<ReauthSessionState>();
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Codex sign-in state lock was poisoned.".to_string())?;

        if !sessions.is_empty() {
            return Err("Another Codex sign-in is already in progress.".to_string());
        }
    }

    let proxy = settings::load_proxy_settings(app)?.proxy;
    let temp = tempfile::tempdir()
        .map_err(|error| format!("Failed to create temporary Codex sign-in environment: {error}"))?;

    fs::write(temp.path().join("config.toml"), TEMP_CODEX_CONFIG)
        .map_err(|error| format!("Failed to prepare temporary Codex sign-in config: {error}"))?;

    let mut child = spawn_login_app_server(temp.path(), &proxy)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was unavailable for sign-in.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable for sign-in.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable for sign-in.".to_string())?;

    let (stdout_tx, stdout_rx) = mpsc::channel::<String>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();

    std::thread::Builder::new()
        .name("codexgauge-login-app-server-stdout".to_string())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if stdout_tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| format!("Failed to start sign-in stdout reader: {error}"))?;

    std::thread::Builder::new()
        .name("codexgauge-login-app-server-stderr".to_string())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if stderr_tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| format!("Failed to start sign-in stderr reader: {error}"))?;

    let mut diagnostics = VecDeque::with_capacity(LOGIN_MAX_STDERR_LINES);

    let start_result = (|| {
        send_login_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "codex_gauge",
                        "title": "CodexGauge",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }
            }),
        )?;

        read_login_response(
            &stdout_rx,
            &stderr_rx,
            &mut child,
            1,
            "initialize",
            LOGIN_APP_SERVER_RESPONSE_TIMEOUT,
            &mut diagnostics,
        )?;

        send_login_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "initialized",
                "params": {}
            }),
        )?;

        send_login_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "account/login/start",
                "params": {
                    "type": "chatgpt",
                    "codexStreamlinedLogin": false,
                    "useHostedLoginSuccessPage": false
                }
            }),
        )?;

        read_login_response(
            &stdout_rx,
            &stderr_rx,
            &mut child,
            2,
            "account/login/start",
            LOGIN_APP_SERVER_RESPONSE_TIMEOUT,
            &mut diagnostics,
        )
    })();

    let result = match start_result {
        Ok(result) => result,
        Err(error) => {
            terminate_login_child(&mut child);
            return Err(error);
        }
    };

    if result.get("type").and_then(Value::as_str) != Some("chatgpt") {
        terminate_login_child(&mut child);
        return Err("Codex app-server returned an unexpected sign-in method.".to_string());
    }

    let login_id = match result
        .get("loginId")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        Some(login_id) => login_id,
        None => {
            terminate_login_child(&mut child);
            return Err("Codex app-server did not return a sign-in id.".to_string());
        }
    };
    let auth_url = match result
        .get("authUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        Some(auth_url) => auth_url,
        None => {
            terminate_login_child(&mut child);
            return Err("Codex app-server did not return a sign-in URL.".to_string());
        }
    };

    let session = ReauthSession {
        account_id: account_id.to_string(),
        login_id: login_id.clone(),
        started_at: Instant::now(),
        _temp: temp,
        child,
        stdin,
        stdout_rx,
        stderr_rx,
        diagnostics,
    };

    let state = app.state::<ReauthSessionState>();
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Codex sign-in state lock was poisoned.".to_string())?;
    sessions.insert(login_id.clone(), session);

    Ok(ReauthStartResponse {
        session_id: login_id,
        auth_url,
    })
}

fn poll_reauthentication_session(
    app: &AppHandle,
    session_id: &str,
) -> Result<ReauthPollResponse, String> {
    enum TerminalState {
        Succeeded,
        Failed(String),
        TimedOut,
    }

    let state = app.state::<ReauthSessionState>();
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Codex sign-in state lock was poisoned.".to_string())?;

    let terminal = {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Codex sign-in session is no longer available.".to_string())?;

        if session.started_at.elapsed() >= REAUTH_LOGIN_TIMEOUT {
            Some(TerminalState::TimedOut)
        } else {
            drain_login_stderr(&session.stderr_rx, &mut session.diagnostics);

            let mut terminal = None;

            while let Ok(line) = session.stdout_rx.try_recv() {
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => continue,
                };

                if message.get("method").and_then(Value::as_str)
                    != Some("account/login/completed")
                {
                    continue;
                }

                let Some(params) = message.get("params") else {
                    continue;
                };

                if params.get("loginId").and_then(Value::as_str)
                    != Some(session.login_id.as_str())
                {
                    continue;
                }

                if params.get("success").and_then(Value::as_bool) == Some(true) {
                    terminal = Some(TerminalState::Succeeded);
                } else {
                    let detail = params
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex sign-in failed.");
                    log::warn!("Codex reauthentication failed: {detail}");
                    terminal = Some(TerminalState::Failed(
                        "Codex sign-in was not completed successfully.".to_string(),
                    ));
                }

                break;
            }

            if terminal.is_none() {
                match session.child.try_wait() {
                    Ok(Some(status)) => {
                        drain_login_stderr(&session.stderr_rx, &mut session.diagnostics);
                        log::warn!(
                            "Codex sign-in app-server exited before login completed: {status}; diagnostics: {}",
                            session
                                .diagnostics
                                .iter()
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(" | ")
                        );
                        terminal = Some(TerminalState::Failed(
                            "Codex sign-in was not completed successfully.".to_string(),
                        ));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        log::error!("Failed to inspect Codex sign-in app-server: {error}");
                        terminal = Some(TerminalState::Failed(
                            "Unable to complete Codex sign-in.".to_string(),
                        ));
                    }
                }
            }

            terminal
        }
    };

    let Some(terminal) = terminal else {
        return Ok(ReauthPollResponse {
            status: ReauthPollStatus::Pending,
            snapshot: None,
            error: None,
        });
    };

    let mut session = sessions
        .remove(session_id)
        .ok_or_else(|| "Codex sign-in session is no longer available.".to_string())?;
    drop(sessions);

    match terminal {
        TerminalState::TimedOut => {
            cancel_reauth_session(&mut session);
            Ok(ReauthPollResponse {
                status: ReauthPollStatus::TimedOut,
                snapshot: None,
                error: None,
            })
        }
        TerminalState::Failed(error) => {
            terminate_login_child(&mut session.child);
            Ok(ReauthPollResponse {
                status: ReauthPollStatus::Failed,
                snapshot: None,
                error: Some(error),
            })
        }
        TerminalState::Succeeded => {
            // The managed sign-in has completed and auth.json is already
            // persisted inside the isolated CODEX_HOME. Stop this app-server
            // before updating the real auth file so it cannot be mistaken for
            // a user-run Codex process by any other runtime checks.
            terminate_login_child(&mut session.child);
            let finalize_result = finalize_reauthentication(app, &mut session);

            match finalize_result {
                Ok(snapshot) => Ok(ReauthPollResponse {
                    status: ReauthPollStatus::Succeeded,
                    snapshot: Some(snapshot),
                    error: None,
                }),
                Err(error)
                    if error == "Signed-in account does not match the selected account."
                        || error.starts_with("Codex is currently running (") =>
                {
                    Ok(ReauthPollResponse {
                        status: ReauthPollStatus::Failed,
                        snapshot: None,
                        error: Some(error),
                    })
                }
                Err(error) => {
                    log::error!("Unable to finalize Codex account reauthentication: {error}");
                    Ok(ReauthPollResponse {
                        status: ReauthPollStatus::Failed,
                        snapshot: None,
                        error: Some("Unable to complete Codex sign-in.".to_string()),
                    })
                }
            }
        }
    }
}

fn finalize_reauthentication(
    app: &AppHandle,
    session: &mut ReauthSession,
) -> Result<AccountsSnapshot, String> {
    let auth_path = session._temp.path().join("auth.json");
    let auth_bytes = fs::read(&auth_path).map_err(|error| {
        format!("Codex sign-in completed but no readable auth.json was produced: {error}")
    })?;
    let identity = parse_auth_identity(&auth_bytes)?;

    if identity.id != session.account_id {
        return Err("Signed-in account does not match the selected account.".to_string());
    }

    let target_is_active =
        current_account_id(app).as_deref() == Some(session.account_id.as_str());

    // Reauthentication keeps the same account identity, so refreshing its
    // credential file does not require the switch-account process guard.
    // This also avoids mistaking CodexGauge's own short-lived app-server
    // usage process for a user-run Codex session.
    persist_account_auth(app, &identity, &auth_bytes)?;

    if target_is_active {
        let main_auth_path = main_codex_home(app)?.join("auth.json");

        if let Some(parent) = main_auth_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create Codex home: {error}"))?;
        }

        let expected_hash = auth_content_hash(&auth_bytes);
        install_self_write_guard(app, &expected_hash)?;

        atomic_write(&main_auth_path, &auth_bytes)
            .map_err(|error| format!("Failed to update Codex authentication: {error}"))?;

        remember_observed_auth(app, &identity, &auth_bytes)?;
    }

    emit_accounts_changed(app);
    build_snapshot_with_usage(app)
}

fn cancel_reauth_session(session: &mut ReauthSession) {
    let _ = send_login_message(
        &mut session.stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "account/login/cancel",
            "params": {
                "loginId": session.login_id.clone()
            }
        }),
    );

    terminate_login_child(&mut session.child);
}

fn spawn_login_app_server(
    codex_home: &Path,
    proxy: &settings::ProxySettings,
) -> Result<Child, String> {
    let config_override = settings::codex_config_override(proxy);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut command = Command::new("cmd.exe");
        command
            .args([
                "/D",
                "/C",
                "codex",
                "-c",
                config_override,
                "app-server",
                "--stdio",
            ])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        settings::configure_codex_command(&mut command, proxy)?;
        command
            .spawn()
            .map_err(|error| format!("Failed to start Codex app-server for sign-in: {error}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("codex");
        command
            .args(["-c", config_override, "app-server", "--stdio"])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        settings::configure_codex_command(&mut command, proxy)?;
        command
            .spawn()
            .map_err(|error| format!("Failed to start Codex app-server for sign-in: {error}"))
    }
}

fn send_login_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let line = serde_json::to_string(message)
        .map_err(|error| format!("Failed to encode Codex sign-in request: {error}"))?;

    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to send Codex sign-in request: {error}"))
}

fn read_login_response(
    stdout_rx: &mpsc::Receiver<String>,
    stderr_rx: &mpsc::Receiver<String>,
    child: &mut Child,
    expected_id: i64,
    operation: &str,
    timeout: Duration,
    diagnostics: &mut VecDeque<String>,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;

    loop {
        drain_login_stderr(stderr_rx, diagnostics);

        match child.try_wait() {
            Ok(Some(status)) => {
                drain_login_stderr(stderr_rx, diagnostics);
                return Err(login_with_diagnostics(
                    format!("Codex app-server exited before {operation} completed ({status})."),
                    diagnostics,
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(login_with_diagnostics(
                    format!("Failed to inspect Codex sign-in app-server: {error}"),
                    diagnostics,
                ));
            }
        }

        let now = Instant::now();
        if now >= deadline {
            drain_login_stderr(stderr_rx, diagnostics);
            return Err(login_with_diagnostics(
                format!("Timed out waiting for Codex app-server {operation}."),
                diagnostics,
            ));
        }

        let wait_for = deadline
            .saturating_duration_since(now)
            .min(LOGIN_PROCESS_POLL_INTERVAL);

        match stdout_rx.recv_timeout(wait_for) {
            Ok(line) => {
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => continue,
                };

                let id_matches = message.get("id").and_then(Value::as_i64) == Some(expected_id)
                    || message
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<i64>().ok())
                        == Some(expected_id);

                if !id_matches {
                    continue;
                }

                if let Some(error) = message.get("error") {
                    drain_login_stderr(stderr_rx, diagnostics);
                    return Err(login_with_diagnostics(
                        format!("Codex app-server returned an error for {operation}: {error}"),
                        diagnostics,
                    ));
                }

                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| {
                        login_with_diagnostics(
                            format!("Codex app-server {operation} response did not contain a result."),
                            diagnostics,
                        )
                    });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                drain_login_stderr(stderr_rx, diagnostics);
                return Err(login_with_diagnostics(
                    format!("Codex app-server stdout closed before {operation} completed."),
                    diagnostics,
                ));
            }
        }
    }
}

fn drain_login_stderr(
    stderr_rx: &mpsc::Receiver<String>,
    diagnostics: &mut VecDeque<String>,
) {
    while let Ok(line) = stderr_rx.try_recv() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if diagnostics.len() == LOGIN_MAX_STDERR_LINES {
            diagnostics.pop_front();
        }
        diagnostics.push_back(line.to_string());
    }
}

fn login_with_diagnostics(message: String, diagnostics: &VecDeque<String>) -> String {
    if diagnostics.is_empty() {
        return message;
    }

    format!(
        "{message} app-server stderr: {}",
        diagnostics.iter().cloned().collect::<Vec<_>>().join(" | ")
    )
}

fn terminate_login_child(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => {
            let _ = child.wait();
        }
        Ok(None) | Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
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

        // Re-snapshot the current main credential immediately before replacing
        // it. Target validation can take time, and the active app-server may
        // have refreshed auth.json since the earlier import.
        if let Some(previous) = previous_auth.as_deref() {
            if let Ok(previous_identity) = parse_auth_identity(previous) {
                persist_account_auth(&app, &previous_identity, previous)?;
                remember_observed_auth(&app, &previous_identity, previous)?;
            }
        }

        let expected_hash = auth_content_hash(&target_auth);

        install_self_write_guard(&app, &expected_hash)?;

        if let Err(error) = atomic_write(&main_auth_path, &target_auth) {
            return Err(format!("Failed to switch Codex account: {error}"));
        }

        let verification = fs::read(&main_auth_path)
            .map_err(|error| format!("Failed to verify switched auth.json: {error}"))
            .and_then(|bytes| parse_auth_identity(&bytes));

        match verification {
            Ok(identity) if identity.id == target.id => {
                remember_observed_auth(&app, &identity, &target_auth)?;
                build_snapshot_with_usage(&app)
            }
            Ok(_) | Err(_) => {
                if let Some(previous) = previous_auth {
                    let rollback_hash = auth_content_hash(&previous);
                    let _ = install_self_write_guard(&app, &rollback_hash);
                    let _ = atomic_write(&main_auth_path, &previous);

                    if let Ok(previous_identity) = parse_auth_identity(&previous) {
                        let _ = remember_observed_auth(&app, &previous_identity, &previous);
                    }
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
        let (usage, classified_error) =
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

        let current_plan = usage
            .plan_type
            .as_deref()
            .map(display_plan)
            .unwrap_or_else(|| account.plan.clone());

        accounts.push(AccountView {
            is_active: active_id.as_deref() == Some(account.id.as_str()),
            id: account.id,
            label: account.label,
            email: account.email,
            plan: current_plan,
            plan_type: usage.plan_type,
            five_hour: usage.five_hour,
            weekly: usage.weekly,
            credits: usage.credits,
            banked_resets: usage.banked_resets,
            usage_error_kind: classified_error
                .as_ref()
                .map(|error| error.kind.clone()),
            usage_error: classified_error
                .map(|error| error.message.to_string()),
        });
    }

    Ok(AccountsSnapshot {
        accounts,
        fetched_at: unix_millis(),
    })
}

fn classify_usage_error(error: &str) -> ClassifiedUsageError {
    let lower = error.to_ascii_lowercase();

    if lower.contains("not found")
        && (lower.contains("codex") || lower.contains("path"))
    {
        return ClassifiedUsageError {
            kind: UsageErrorKind::Cli,
            message: "Codex CLI was not found.",
        };
    }

    if lower.contains("timed out") {
        return ClassifiedUsageError {
            kind: UsageErrorKind::Timeout,
            message: "Codex did not return usage data in time.",
        };
    }

    // Authentication failures must be checked before transport failures because
    // app-server diagnostics can include the backend URL for 401/token errors.
    if lower.contains("authentication")
        || lower.contains("auth.json")
        || lower.contains("id_token")
        || lower.contains("access token")
        || lower.contains("refresh token")
        || lower.contains("invalid_token")
        || lower.contains("unauthorized")
        || lower.contains("login required")
        || lower.contains("not logged in")
        || lower.contains("credential")
        || lower.contains("status 401")
        || lower.contains("http 401")
    {
        return ClassifiedUsageError {
            kind: UsageErrorKind::Auth,
            message: "Codex authentication could not be verified.",
        };
    }

    // Keep network classification deliberately narrow. A backend endpoint name
    // alone is not evidence of a connectivity problem; HTTP/auth failures often
    // contain the same URL.
    if lower.contains("error sending request for url")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection timed out")
        || lower.contains("failed to connect")
        || lower.contains("dns")
        || lower.contains("failed to lookup address")
        || lower.contains("name resolution")
        || lower.contains("proxy error")
        || lower.contains("proxy connect")
        || lower.contains("tls error")
        || lower.contains("certificate verify")
    {
        return ClassifiedUsageError {
            kind: UsageErrorKind::Network,
            message: "Unable to reach ChatGPT. Check Network proxy settings.",
        };
    }

    if lower.contains("app-server") {
        return ClassifiedUsageError {
            kind: UsageErrorKind::AppServer,
            message: "Codex app-server could not provide usage data.",
        };
    }

    ClassifiedUsageError {
        kind: UsageErrorKind::Unknown,
        message: "Usage data is temporarily unavailable.",
    }
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

    // Capture the currently active auth only after the filesystem watcher is
    // installed. This gives us a last-known-good handoff snapshot before an
    // external `codex login` replaces ~/.codex/auth.json with another account.
    if let Err(error) = initialize_observed_auth(&app) {
        log::warn!("Could not initialize the active Codex auth snapshot: {error}");
    }

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
            // Keep the last observed credential in memory. Codex login can
            // briefly remove/replace auth.json, and that snapshot is exactly
            // what lets us preserve the previous account when the new file
            // belongs to a different account.
            emit_accounts_changed(app);
            return Ok(());
        }
        Err(error) => return Err(format!("Failed to read changed auth.json: {error}")),
    };

    let identity = match parse_auth_identity(&auth_bytes) {
        Ok(identity) => identity,
        Err(_) => {
            emit_accounts_changed(app);
            return Ok(());
        }
    };

    let hash = auth_content_hash(&auth_bytes);

    if is_expected_self_write(app, &hash)? {
        // Internal account switches deliberately suppress normal watcher work,
        // but the last-observed snapshot still has to follow the main auth file
        // or the next external login could hand off the wrong account.
        remember_observed_auth(app, &identity, &auth_bytes)?;
        return Ok(());
    }

    handoff_previous_observed_auth(app, &identity)?;
    persist_account_auth(app, &identity, &auth_bytes)?;
    remember_observed_auth(app, &identity, &auth_bytes)?;
    emit_accounts_changed(app);

    Ok(())
}

fn initialize_observed_auth(app: &AppHandle) -> Result<(), String> {
    let auth_path = main_codex_home(app)?.join("auth.json");

    let auth_bytes = match fs::read(&auth_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read current Codex authentication for watcher initialization: {error}"
            ))
        }
    };

    let identity = match parse_auth_identity(&auth_bytes) {
        Ok(identity) => identity,
        Err(_) => return Ok(()),
    };

    persist_account_auth(app, &identity, &auth_bytes)?;
    remember_observed_auth(app, &identity, &auth_bytes)
}

fn handoff_previous_observed_auth(
    app: &AppHandle,
    next_identity: &AuthIdentity,
) -> Result<(), String> {
    let previous = {
        let state = app.state::<AuthWatcherState>();
        let observed = state
            .last_observed_auth
            .lock()
            .map_err(|_| "Auth watcher observed-auth lock was poisoned.".to_string())?;

        observed.clone()
    };

    let Some(previous) = previous else {
        return Ok(());
    };

    if previous.account_id == next_identity.id {
        return Ok(());
    }

    let previous_identity = match parse_auth_identity(&previous.auth_bytes) {
        Ok(identity) if identity.id == previous.account_id => identity,
        Ok(_) => {
            log::warn!(
                "Skipped active-auth handoff because the last observed credential identity changed unexpectedly."
            );
            return Ok(());
        }
        Err(error) => {
            log::warn!(
                "Skipped active-auth handoff because the last observed credential could not be parsed: {error}"
            );
            return Ok(());
        }
    };

    if let Err(error) = persist_account_auth(app, &previous_identity, &previous.auth_bytes) {
        // Do not discard the newly logged-in account just because preserving
        // the previous backup failed. Keep the error visible in diagnostics.
        log::error!(
            "Could not preserve the previous active Codex credential during account handoff: {error}"
        );
    } else {
        log::info!(
            "Preserved the previous active Codex credential before auth.json switched accounts"
        );
    }

    Ok(())
}

pub(crate) fn remember_active_auth(
    app: &AppHandle,
    identity: &AuthIdentity,
    auth_bytes: &[u8],
) -> Result<(), String> {
    remember_observed_auth(app, identity, auth_bytes)
}

fn remember_observed_auth(
    app: &AppHandle,
    identity: &AuthIdentity,
    auth_bytes: &[u8],
) -> Result<(), String> {
    let hash = auth_content_hash(auth_bytes);
    let state = app.state::<AuthWatcherState>();
    let mut observed = state
        .last_observed_auth
        .lock()
        .map_err(|_| "Auth watcher observed-auth lock was poisoned.".to_string())?;

    if observed
        .as_ref()
        .map(|current| current.account_id == identity.id && current.hash == hash)
        .unwrap_or(false)
    {
        return Ok(());
    }

    *observed = Some(ObservedAuth {
        account_id: identity.id.clone(),
        auth_bytes: auth_bytes.to_vec(),
        hash,
    });

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

    persist_account_auth(app, &identity, &auth_bytes)?;
    remember_observed_auth(app, &identity, &auth_bytes)
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
