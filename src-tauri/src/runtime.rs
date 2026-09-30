use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::AppHandle;

const CODEX_INSTALL_GUIDE_URL: &str = "https://github.com/openai/codex";
const BACKGROUND_STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const UPDATER_GRACE_TIMEOUT: Duration = Duration::from_secs(2);
const FORCE_KILL_TIMEOUT: Duration = Duration::from_secs(2);

static RESOLVED_CODEX_EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    pub(crate) codex_cli_installed: bool,
    pub(crate) codex_cli_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexProcessRole {
    Blocking,
    ManagedAppServer,
    Updater,
}

#[derive(Debug, Clone)]
struct CodexProcessSnapshot {
    pid: u32,
    role: CodexProcessRole,
    label: String,
}


pub(crate) fn codex_executable() -> PathBuf {
    if let Some(path) = RESOLVED_CODEX_EXECUTABLE.get() {
        return path.clone();
    }

    #[cfg(target_os = "macos")]
    if let Some(path) = resolve_macos_codex_executable() {
        let _ = RESOLVED_CODEX_EXECUTABLE.set(path.clone());
        return path;
    }

    PathBuf::from("codex")
}

#[cfg(target_os = "macos")]
fn resolve_macos_codex_executable() -> Option<PathBuf> {
    if let Some(path) = find_executable_on_current_path("codex") {
        return Some(path);
    }

    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.extend([
            home.join(".local/bin/codex"),
            home.join(".npm-global/bin/codex"),
            home.join(".volta/bin/codex"),
            home.join(".bun/bin/codex"),
            home.join(".asdf/shims/codex"),
            home.join(".local/share/mise/shims/codex"),
            home.join("Library/pnpm/codex"),
        ]);

        append_versioned_codex_candidates(&home.join(".nvm/versions/node"), "bin/codex", &mut candidates);
        append_versioned_codex_candidates(
            &home.join(".fnm/node-versions"),
            "installation/bin/codex",
            &mut candidates,
        );
        append_versioned_codex_candidates(
            &home.join(".local/share/fnm/node-versions"),
            "installation/bin/codex",
            &mut candidates,
        );
    }

    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn find_executable_on_current_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;

    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "macos")]
fn append_versioned_codex_candidates(root: &Path, suffix: &str, candidates: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    let mut version_dirs = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();

    version_dirs.sort_by(|left, right| right.cmp(left));

    for version_dir in version_dirs {
        candidates.push(version_dir.join(suffix));
    }
}

#[tauri::command]
pub fn get_runtime_status() -> RuntimeStatus {
    codex_cli_status()
}

#[tauri::command]
pub fn open_codex_install_guide() -> Result<(), String> {
    open_external_url(CODEX_INSTALL_GUIDE_URL.to_string())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();

    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only HTTP and HTTPS URLs can be opened.".to_string());
    }

    tauri_plugin_opener::open_url(trimmed, None::<&str>)
        .map_err(|error| format!("Failed to open URL: {error}"))
}

#[tauri::command]
pub fn close_codex_gauge(app: AppHandle) {
    app.exit(0);
}

pub(crate) fn codex_cli_status() -> RuntimeStatus {
    match codex_version_output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_string();

            let stderr = String::from_utf8_lossy(&output.stderr)
                .trim()
                .to_string();

            let version = if !stdout.is_empty() {
                Some(stdout)
            } else if !stderr.is_empty() {
                Some(stderr)
            } else {
                None
            };

            RuntimeStatus {
                codex_cli_installed: true,
                codex_cli_version: version,
            }
        }
        Ok(_) | Err(_) => RuntimeStatus {
            codex_cli_installed: false,
            codex_cli_version: None,
        },
    }
}

/// Account switching must never terminate an interactive/user-owned Codex
/// process. Managed daemon processes are handled separately by
/// `stop_codex_background_services` and therefore do not block switching.
pub(crate) fn ensure_codex_not_running() -> Result<(), String> {
    let running = running_blocking_codex_processes();

    if running.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Codex is currently running ({}). Close Codex CLI or Codex Desktop before switching accounts.",
        running.into_iter().collect::<Vec<_>>().join(", ")
    ))
}

/// Stops Codex-managed background services before auth.json is replaced.
///
/// Normal lifecycle mechanisms are always attempted first:
/// - the updater receives its supported graceful shutdown request;
/// - the managed app-server is stopped through `codex app-server daemon stop`.
///
/// If either service remains alive, only the explicitly recognized daemon
/// process is force-terminated. Unknown/interactive Codex processes are never
/// killed and continue to block the account switch.
pub(crate) fn stop_codex_background_services(codex_home: &Path) -> Result<(), String> {
    ensure_codex_not_running()?;

    stop_updater_processes(codex_home);
    stop_managed_app_server(codex_home);

    // One last fallback handles a daemon/updater that raced a restart while the
    // two normal stop paths were running.
    let remaining = running_background_processes();
    if !remaining.is_empty() {
        log::warn!(
            "Codex background services remained after graceful stop; force terminating: {}",
            format_processes(&remaining)
        );
        force_kill_background_processes(&remaining);
    }

    if !wait_until_no_background_processes(FORCE_KILL_TIMEOUT) {
        let remaining = running_background_processes();
        log::error!(
            "Unable to stop Codex background services: {}",
            format_processes(&remaining)
        );
        cleanup_daemon_state(codex_home);
        return Err("Unable to stop Codex background services.".to_string());
    }

    cleanup_daemon_state(codex_home);

    // The user may have opened a new TUI while the background services were
    // shutting down. Never replace credentials underneath that new session.
    ensure_codex_not_running()
}

fn stop_updater_processes(codex_home: &Path) {
    let updaters = background_processes_by_role(CodexProcessRole::Updater);

    if updaters.is_empty() {
        return;
    }

    log::info!(
        "Stopping Codex daemon updater before account switch: {}",
        format_processes(&updaters)
    );

    request_updater_shutdown(codex_home, &updaters);

    if wait_until_role_stopped(CodexProcessRole::Updater, UPDATER_GRACE_TIMEOUT) {
        cleanup_updater_shutdown_files(codex_home);
        return;
    }

    let remaining = background_processes_by_role(CodexProcessRole::Updater);
    log::warn!(
        "Codex daemon updater did not stop gracefully; force terminating: {}",
        format_processes(&remaining)
    );
    force_kill_background_processes(&remaining);
    let _ = wait_until_role_stopped(CodexProcessRole::Updater, FORCE_KILL_TIMEOUT);
    cleanup_updater_shutdown_files(codex_home);
}

fn stop_managed_app_server(codex_home: &Path) {
    let managed = background_processes_by_role(CodexProcessRole::ManagedAppServer);

    if managed.is_empty() {
        return;
    }

    log::info!(
        "Stopping Codex managed app-server before account switch: {}",
        format_processes(&managed)
    );

    match codex_daemon_stop_output(codex_home) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !stdout.is_empty() {
                log::info!("Codex daemon stop: {stdout}");
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            log::warn!(
                "Codex daemon stop command failed with status {}{}",
                output.status,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            );
        }
        Err(error) => {
            log::warn!("Unable to run Codex daemon stop command: {error}");
        }
    }

    // The official daemon stop command already has its own graceful window.
    // Give process enumeration a short moment to observe its exit before the
    // CodexGauge fallback is used.
    if wait_until_role_stopped(
        CodexProcessRole::ManagedAppServer,
        Duration::from_millis(750),
    ) {
        return;
    }

    let remaining = background_processes_by_role(CodexProcessRole::ManagedAppServer);
    log::warn!(
        "Codex managed app-server remained after daemon stop; force terminating: {}",
        format_processes(&remaining)
    );
    force_kill_background_processes(&remaining);
    let _ = wait_until_role_stopped(CodexProcessRole::ManagedAppServer, FORCE_KILL_TIMEOUT);
}

#[cfg(target_os = "windows")]
fn request_updater_shutdown(codex_home: &Path, updaters: &[CodexProcessSnapshot]) {
    let updater_pids = updaters.iter().map(|process| process.pid).collect::<BTreeSet<_>>();
    let state_dir = codex_home.join("app-server-daemon");
    let mut requested = BTreeSet::new();

    for file_name in ["app-server-updater.pid", "daemon-updater.pid"] {
        let pid_file = state_dir.join(file_name);
        let Some(pid) = read_daemon_pid_record(&pid_file) else {
            continue;
        };

        if !updater_pids.contains(&pid) {
            continue;
        }

        let shutdown_file = pid_file.with_extension("shutdown");
        match fs::write(&shutdown_file, pid.to_string()) {
            Ok(()) => {
                requested.insert(pid);
                log::info!(
                    "Requested graceful Codex updater shutdown for PID {pid} using {}",
                    shutdown_file.display()
                );
            }
            Err(error) => {
                log::warn!(
                    "Unable to request graceful Codex updater shutdown for PID {pid}: {error}"
                );
            }
        }
    }

    for pid in updater_pids.difference(&requested) {
        log::warn!(
            "No matching Codex updater PID state file was available for PID {pid}; force fallback will be used if it remains running"
        );
    }
}

#[cfg(unix)]
fn request_updater_shutdown(_codex_home: &Path, updaters: &[CodexProcessSnapshot]) {
    use sysinfo::Signal;

    let system = System::new_all();

    for updater in updaters {
        let Some(process) = system
            .processes()
            .values()
            .find(|process| process.pid().as_u32() == updater.pid)
        else {
            continue;
        };

        match process.kill_with(Signal::Term) {
            Some(true) => log::info!(
                "Requested graceful Codex updater shutdown with SIGTERM for PID {}",
                updater.pid
            ),
            Some(false) | None => log::warn!(
                "Unable to send graceful shutdown signal to Codex updater PID {}; force fallback will be used if it remains running",
                updater.pid
            ),
        }
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
fn request_updater_shutdown(_codex_home: &Path, updaters: &[CodexProcessSnapshot]) {
    if !updaters.is_empty() {
        log::warn!("Graceful Codex updater shutdown is unsupported on this platform");
    }
}

fn force_kill_background_processes(targets: &[CodexProcessSnapshot]) {
    if targets.is_empty() {
        return;
    }

    let target_pids = targets.iter().map(|process| process.pid).collect::<BTreeSet<_>>();
    let system = System::new_all();

    for process in system.processes().values() {
        let pid = process.pid().as_u32();

        if !target_pids.contains(&pid) {
            continue;
        }

        let Some(snapshot) = snapshot_codex_process(process) else {
            continue;
        };

        if !matches!(
            snapshot.role,
            CodexProcessRole::ManagedAppServer | CodexProcessRole::Updater
        ) {
            continue;
        }

        if process.kill() {
            log::warn!(
                "Force-termination requested for {} (PID {})",
                snapshot.label,
                snapshot.pid
            );
        } else {
            log::error!(
                "Failed to force-terminate {} (PID {})",
                snapshot.label,
                snapshot.pid
            );
        }
    }
}

fn codex_version_output() -> Result<Output, std::io::Error> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        Command::new("cmd.exe")
            .args(["/D", "/C", "codex", "--version"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(codex_executable())
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    }
}

fn codex_daemon_stop_output(codex_home: &Path) -> Result<Output, std::io::Error> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        Command::new("cmd.exe")
            .args(["/D", "/C", "codex", "app-server", "daemon", "stop"])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(codex_executable())
            .args(["app-server", "daemon", "stop"])
            .env("CODEX_HOME", codex_home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    }
}

fn running_blocking_codex_processes() -> BTreeSet<String> {
    running_codex_processes()
        .into_iter()
        .filter(|process| process.role == CodexProcessRole::Blocking)
        .map(|process| process.label)
        .collect()
}

fn running_background_processes() -> Vec<CodexProcessSnapshot> {
    running_codex_processes()
        .into_iter()
        .filter(|process| {
            matches!(
                process.role,
                CodexProcessRole::ManagedAppServer | CodexProcessRole::Updater
            )
        })
        .collect()
}

fn background_processes_by_role(role: CodexProcessRole) -> Vec<CodexProcessSnapshot> {
    running_codex_processes()
        .into_iter()
        .filter(|process| process.role == role)
        .collect()
}

fn running_codex_processes() -> Vec<CodexProcessSnapshot> {
    let system = System::new_all();

    system
        .processes()
        .values()
        .filter_map(snapshot_codex_process)
        .collect()
}

fn snapshot_codex_process(process: &sysinfo::Process) -> Option<CodexProcessSnapshot> {
    let name = process.name().to_string_lossy();
    let executable = process
        .exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let command_line = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");

    let (role, label) = classify_codex_process(&name, &executable, &command_line)?;

    Some(CodexProcessSnapshot {
        pid: process.pid().as_u32(),
        role,
        label: label.to_string(),
    })
}

fn classify_codex_process(
    name: &str,
    executable: &str,
    command_line: &str,
) -> Option<(CodexProcessRole, &'static str)> {
    let name = name.to_ascii_lowercase();
    let executable = executable.to_ascii_lowercase();
    let command_line = command_line.to_ascii_lowercase();

    if name == "codex.exe" || name == "codex" {
        if is_codex_updater_command(&command_line) {
            return Some((CodexProcessRole::Updater, "Codex daemon updater"));
        }

        if is_managed_app_server(&executable, &command_line) {
            return Some((
                CodexProcessRole::ManagedAppServer,
                "Codex managed app-server",
            ));
        }

        if command_line.contains("app-server") {
            return Some((CodexProcessRole::Blocking, "Codex app-server"));
        }

        if executable.contains("\\openai\\codex\\")
            || executable.contains("/openai/codex/")
            || executable.contains("openai.codex_")
            || executable.contains("/codex.app/contents/macos/")
        {
            return Some((CodexProcessRole::Blocking, "Codex Desktop runtime"));
        }

        return Some((CodexProcessRole::Blocking, "Codex CLI"));
    }

    if name == "chatgpt.exe" || name == "chatgpt" {
        let is_codex_desktop = executable.contains("openai.codex_")
            || executable.contains("\\openai\\codex\\")
            || executable.contains("/openai/codex/")
            || command_line.contains("openai.codex_")
            || command_line.contains("\\openai\\codex\\")
            || command_line.contains("/openai/codex/");

        if is_codex_desktop {
            return Some((CodexProcessRole::Blocking, "Codex Desktop"));
        }
    }

    None
}

fn is_codex_updater_command(command_line: &str) -> bool {
    command_line.contains("app-server daemon pid-update-loop")
}

fn is_managed_app_server(executable: &str, command_line: &str) -> bool {
    if !command_line.contains("app-server") {
        return false;
    }

    if command_line.contains("--managed-daemon") {
        return true;
    }

    let managed_package = executable.contains("\\packages\\app-server-daemon\\")
        || executable.contains("/packages/app-server-daemon/")
        || executable.contains("\\packages\\standalone\\")
        || executable.contains("/packages/standalone/");

    managed_package
        && command_line.contains("--listen")
        && command_line.contains("unix://")
}

fn wait_until_role_stopped(role: CodexProcessRole, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;

    loop {
        if background_processes_by_role(role).is_empty() {
            return true;
        }

        if Instant::now() >= deadline {
            return false;
        }

        thread::sleep(BACKGROUND_STOP_POLL_INTERVAL);
    }
}

fn wait_until_no_background_processes(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;

    loop {
        if running_background_processes().is_empty() {
            return true;
        }

        if Instant::now() >= deadline {
            return false;
        }

        thread::sleep(BACKGROUND_STOP_POLL_INTERVAL);
    }
}

fn format_processes(processes: &[CodexProcessSnapshot]) -> String {
    processes
        .iter()
        .map(|process| format!("{} PID {}", process.label, process.pid))
        .collect::<Vec<_>>()
        .join(", ")
}

fn read_daemon_pid_record(path: &Path) -> Option<u32> {
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();

    if let Ok(pid) = trimmed.parse::<u32>() {
        return Some(pid);
    }

    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    value
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
}

fn cleanup_updater_shutdown_files(codex_home: &Path) {
    let state_dir = codex_home.join("app-server-daemon");

    for file_name in ["app-server-updater.shutdown", "daemon-updater.shutdown"] {
        match fs::remove_file(state_dir.join(file_name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!("Unable to remove stale Codex updater shutdown file: {error}");
            }
        }
    }
}

fn cleanup_daemon_state(codex_home: &Path) {
    cleanup_updater_shutdown_files(codex_home);

    let state_dir = codex_home.join("app-server-daemon");
    let system = System::new_all();
    let live_pids = system
        .processes()
        .keys()
        .map(|pid| pid.as_u32())
        .collect::<BTreeSet<_>>();

    for file_name in [
        "app-server.pid",
        "daemon.pid",
        "app-server-updater.pid",
        "daemon-updater.pid",
    ] {
        let path = state_dir.join(file_name);
        let Some(pid) = read_daemon_pid_record(&path) else {
            continue;
        };

        if live_pids.contains(&pid) {
            continue;
        }

        match fs::remove_file(&path) {
            Ok(()) => log::info!("Removed stale Codex daemon PID file {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!(
                "Unable to remove stale Codex daemon PID file {}: {error}",
                path.display()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_windows_managed_daemon() {
        let result = classify_codex_process(
            "codex.exe",
            r"C:\Users\Administrator\.codex\packages\app-server-daemon\releases\0.159.2-x86_64-pc-windows-msvc\bin\codex.exe",
            r#""C:\Users\Administrator\.codex\packages\app-server-daemon\releases\0.159.2-x86_64-pc-windows-msvc\bin\codex.exe" app-server --listen unix:// --managed-daemon"#,
        );

        assert_eq!(
            result,
            Some((
                CodexProcessRole::ManagedAppServer,
                "Codex managed app-server"
            ))
        );
    }

    #[test]
    fn classifies_daemon_updater() {
        let result = classify_codex_process(
            "codex.exe",
            r"C:\Users\Administrator\.codex\packages\app-server-daemon\releases\0.159.2-x86_64-pc-windows-msvc\bin\codex.exe",
            r#""C:\Users\Administrator\.codex\packages\app-server-daemon\releases\0.159.2-x86_64-pc-windows-msvc\bin\codex.exe" app-server daemon pid-update-loop"#,
        );

        assert_eq!(
            result,
            Some((CodexProcessRole::Updater, "Codex daemon updater"))
        );
    }

    #[test]
    fn direct_app_server_is_a_blocker_not_a_managed_service() {
        let result = classify_codex_process(
            "codex",
            "/usr/local/bin/codex",
            "codex app-server --remote-control --listen unix://",
        );

        assert_eq!(
            result,
            Some((CodexProcessRole::Blocking, "Codex app-server"))
        );
    }

    #[test]
    fn classifies_macos_codex_desktop_bundle() {
        let result = classify_codex_process(
            "codex",
            "/Applications/Codex.app/Contents/MacOS/Codex",
            "/Applications/Codex.app/Contents/MacOS/Codex",
        );

        assert_eq!(
            result,
            Some((CodexProcessRole::Blocking, "Codex Desktop runtime"))
        );
    }

    #[test]
    fn normal_cli_is_a_blocker() {
        let result = classify_codex_process(
            "codex.exe",
            r"C:\Users\Administrator\AppData\Roaming\nvm\v22.20.0\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
            r"C:\Users\Administrator\AppData\Roaming\nvm\v22.20.0\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
        );

        assert_eq!(result, Some((CodexProcessRole::Blocking, "Codex CLI")));
    }
}
