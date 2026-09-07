use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::accounts::{
    self, BankedResetView, BankedResetsView, QuotaWindowView, StoredAccount,
};
use crate::settings::{self, ProxySettings};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const RATE_LIMITS_TIMEOUT: Duration = Duration::from_secs(45);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_STDERR_LINES: usize = 12;

const TEMP_CODEX_CONFIG: &str = r#"cli_auth_credentials_store = "file"
"#;

#[derive(Debug, Clone, Default)]
pub(crate) struct AccountUsage {
    pub(crate) five_hour: Option<QuotaWindowView>,
    pub(crate) weekly: Option<QuotaWindowView>,
    pub(crate) banked_resets: Option<BankedResetsView>,
}

pub(crate) fn read_account_usage(
    app: &AppHandle,
    account: &StoredAccount,
    active_account_id: Option<&str>,
) -> Result<AccountUsage, String> {
    let proxy = settings::load_proxy_settings(app)?.proxy;

    if active_account_id == Some(account.id.as_str()) {
        return read_active_account_usage(app, account, &proxy);
    }

    read_inactive_account_usage(app, account, &proxy)
}

pub(crate) fn test_proxy_connection(
    app: &AppHandle,
    proxy: &ProxySettings,
) -> Result<(), String> {
    let codex_home = accounts::main_codex_home(app)?;
    query_rate_limits_with_proxy(&codex_home, proxy).map(|_| ())
}

pub(crate) fn validate_account_auth_for_switch(
    app: &AppHandle,
    account: &StoredAccount,
    auth_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let proxy = settings::load_proxy_settings(app)?.proxy;
    let temp = tempfile::tempdir()
        .map_err(|error| format!("Failed to create temporary switch validation environment: {error}"))?;

    fs::write(temp.path().join("config.toml"), TEMP_CODEX_CONFIG)
        .map_err(|error| format!("Failed to prepare temporary switch validation config: {error}"))?;

    fs::write(temp.path().join("auth.json"), auth_bytes)
        .map_err(|error| format!("Failed to prepare temporary switch validation auth: {error}"))?;

    query_rate_limits_with_proxy(temp.path(), &proxy)
        .map_err(|error| format!("Pre-switch account validation failed: {error}"))?;

    let refreshed_auth = fs::read(temp.path().join("auth.json"))
        .map_err(|error| format!("Failed to read refreshed switch validation auth: {error}"))?;

    let identity = accounts::parse_auth_identity(&refreshed_auth)
        .map_err(|error| format!("Refreshed switch authentication is invalid: {error}"))?;

    if identity.id != account.id {
        return Err(
            "Refreshed switch credential identity does not match the selected account."
                .to_string(),
        );
    }

    accounts::persist_account_auth(app, &identity, &refreshed_auth)?;

    Ok(refreshed_auth)
}

fn read_active_account_usage(
    app: &AppHandle,
    account: &StoredAccount,
    proxy: &ProxySettings,
) -> Result<AccountUsage, String> {
    let codex_home = accounts::main_codex_home(app)?;
    let result = query_rate_limits_with_proxy(&codex_home, proxy)?;

    let auth_path = codex_home.join("auth.json");

    if let Ok(auth_bytes) = fs::read(auth_path) {
        if let Ok(identity) = accounts::parse_auth_identity(&auth_bytes) {
            if identity.id == account.id {
                accounts::persist_account_auth(app, &identity, &auth_bytes)?;
            }
        }
    }

    parse_usage_response(&result)
}

fn read_inactive_account_usage(
    app: &AppHandle,
    account: &StoredAccount,
    proxy: &ProxySettings,
) -> Result<AccountUsage, String> {
    let auth_bytes = accounts::load_account_auth(app, account)?;
    let temp = tempfile::tempdir()
        .map_err(|error| format!("Failed to create temporary usage environment: {error}"))?;

    fs::write(temp.path().join("config.toml"), TEMP_CODEX_CONFIG)
        .map_err(|error| format!("Failed to prepare temporary Codex config: {error}"))?;

    fs::write(temp.path().join("auth.json"), &auth_bytes)
        .map_err(|error| format!("Failed to prepare temporary Codex auth: {error}"))?;

    let result = query_rate_limits_with_proxy(temp.path(), proxy)?;

    if let Ok(updated_auth) = fs::read(temp.path().join("auth.json")) {
        if let Ok(identity) = accounts::parse_auth_identity(&updated_auth) {
            if identity.id == account.id {
                accounts::persist_account_auth(app, &identity, &updated_auth)?;
            }
        }
    }

    parse_usage_response(&result)
}

fn query_rate_limits_with_proxy(
    codex_home: &Path,
    proxy: &ProxySettings,
) -> Result<Value, String> {
    let mut child = spawn_app_server(codex_home, proxy)?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was unavailable.".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;

    let (stdout_tx, stdout_rx) = mpsc::channel::<String>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();

    std::thread::Builder::new()
        .name("codexgauge-app-server-stdout".to_string())
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
        .map_err(|error| format!("Failed to start app-server stdout reader: {error}"))?;

    std::thread::Builder::new()
        .name("codexgauge-app-server-stderr".to_string())
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
        .map_err(|error| format!("Failed to start app-server stderr reader: {error}"))?;

    let mut diagnostics = VecDeque::with_capacity(MAX_STDERR_LINES);

    let result = (|| {
        send_message(
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

        read_response(
            &stdout_rx,
            &stderr_rx,
            &mut child,
            1,
            "initialize",
            INITIALIZE_TIMEOUT,
            &mut diagnostics,
        )?;

        send_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "initialized",
                "params": {}
            }),
        )?;

        send_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "account/rateLimits/read"
            }),
        )?;

        read_response(
            &stdout_rx,
            &stderr_rx,
            &mut child,
            2,
            "account/rateLimits/read",
            RATE_LIMITS_TIMEOUT,
            &mut diagnostics,
        )
    })();

    drop(stdin);
    terminate_child(&mut child);

    result
}

fn spawn_app_server(
    codex_home: &Path,
    proxy: &ProxySettings,
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
            .map_err(|error| format!("Failed to start Codex app-server: {error}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("codex");

        command
            .args([
                "-c",
                config_override,
                "app-server",
                "--stdio",
            ])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        settings::configure_codex_command(&mut command, proxy)?;

        command
            .spawn()
            .map_err(|error| format!("Failed to start Codex app-server: {error}"))
    }
}

fn send_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let line = serde_json::to_string(message)
        .map_err(|error| format!("Failed to encode app-server request: {error}"))?;

    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to send app-server request: {error}"))
}

fn read_response(
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
        drain_stderr(stderr_rx, diagnostics);

        match child.try_wait() {
            Ok(Some(status)) => {
                drain_stderr(stderr_rx, diagnostics);

                return Err(with_diagnostics(
                    format!(
                        "Codex app-server exited before {operation} returned a response ({status})."
                    ),
                    diagnostics,
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(with_diagnostics(
                    format!("Failed to inspect Codex app-server process: {error}"),
                    diagnostics,
                ));
            }
        }

        let now = Instant::now();

        if now >= deadline {
            drain_stderr(stderr_rx, diagnostics);

            return Err(with_diagnostics(
                format!(
                    "Timed out after {}s waiting for Codex app-server {operation} response.",
                    timeout.as_secs()
                ),
                diagnostics,
            ));
        }

        let remaining = deadline.saturating_duration_since(now);
        let wait_for = remaining.min(PROCESS_POLL_INTERVAL);

        match stdout_rx.recv_timeout(wait_for) {
            Ok(line) => {
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => continue,
                };

                if !response_id_matches(&message, expected_id) {
                    continue;
                }

                if let Some(error) = message.get("error") {
                    drain_stderr(stderr_rx, diagnostics);

                    return Err(with_diagnostics(
                        format!(
                            "Codex app-server returned an error for {operation}: {error}"
                        ),
                        diagnostics,
                    ));
                }

                return message.get("result").cloned().ok_or_else(|| {
                    with_diagnostics(
                        format!(
                            "Codex app-server {operation} response did not contain a result."
                        ),
                        diagnostics,
                    )
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                drain_stderr(stderr_rx, diagnostics);

                return Err(with_diagnostics(
                    format!(
                        "Codex app-server stdout closed before {operation} returned a response."
                    ),
                    diagnostics,
                ));
            }
        }
    }
}

fn response_id_matches(message: &Value, expected_id: i64) -> bool {
    let Some(id) = message.get("id") else {
        return false;
    };

    id.as_i64() == Some(expected_id)
        || id
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
            == Some(expected_id)
}

fn drain_stderr(
    stderr_rx: &mpsc::Receiver<String>,
    diagnostics: &mut VecDeque<String>,
) {
    while let Ok(line) = stderr_rx.try_recv() {
        let line = line.trim();

        if line.is_empty() {
            continue;
        }

        if diagnostics.len() == MAX_STDERR_LINES {
            diagnostics.pop_front();
        }

        diagnostics.push_back(line.to_string());
    }
}

fn with_diagnostics(message: String, diagnostics: &VecDeque<String>) -> String {
    if diagnostics.is_empty() {
        return message;
    }

    format!(
        "{message} app-server stderr: {}",
        diagnostics.iter().cloned().collect::<Vec<_>>().join(" | ")
    )
}

fn terminate_child(child: &mut Child) {
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

fn parse_usage_response(result: &Value) -> Result<AccountUsage, String> {
    let snapshot = preferred_rate_limit_snapshot(result);

    let mut usage = AccountUsage::default();

    if let Some(snapshot) = snapshot {
        for key in ["primary", "secondary"] {
            let Some(window) = snapshot.get(key) else {
                continue;
            };

            let Some(parsed) = parse_window(window) else {
                continue;
            };

            match parsed.window_duration_mins {
                300 => usage.five_hour = Some(parsed),
                10_080 => usage.weekly = Some(parsed),
                _ => {}
            }
        }
    }

    usage.banked_resets = parse_banked_resets(result.get("rateLimitResetCredits"));

    Ok(usage)
}

fn preferred_rate_limit_snapshot(result: &Value) -> Option<&Value> {
    result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get("codex"))
        .or_else(|| result.get("rateLimits"))
        .filter(|value| value.is_object())
}

fn parse_window(value: &Value) -> Option<QuotaWindowView> {
    if value.is_null() {
        return None;
    }

    let used_percent = value.get("usedPercent")?.as_f64()?;
    let window_duration_mins = value
        .get("windowDurationMins")
        .and_then(value_as_u64)?;

    let resets_at = value.get("resetsAt").and_then(value_as_i64);

    Some(QuotaWindowView {
        used_percent,
        window_duration_mins,
        resets_at,
    })
}

fn parse_banked_resets(value: Option<&Value>) -> Option<BankedResetsView> {
    let summary = value?.as_object()?;

    let available_count = summary
        .get("availableCount")
        .and_then(value_as_u64)
        .unwrap_or(0);

    let items = summary
        .get("credits")
        .and_then(Value::as_array)
        .map(|credits| {
            credits
                .iter()
                .filter_map(parse_banked_reset)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(BankedResetsView {
        available_count,
        items,
    })
}

fn parse_banked_reset(value: &Value) -> Option<BankedResetView> {
    let id = value.get("id")?.as_str()?.to_string();

    let label = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let details = value
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let expires_at = value.get("expiresAt").and_then(value_as_i64);

    Some(BankedResetView {
        id,
        label,
        details,
        expires_at,
    })
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}
