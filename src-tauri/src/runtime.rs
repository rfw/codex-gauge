use serde::Serialize;
use std::collections::BTreeSet;
use std::process::{Command, Output, Stdio};
use sysinfo::System;
use tauri::AppHandle;

const CODEX_INSTALL_GUIDE_URL: &str = "https://github.com/openai/codex";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    pub(crate) codex_cli_installed: bool,
    pub(crate) codex_cli_version: Option<String>,
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

pub(crate) fn ensure_codex_not_running() -> Result<(), String> {
    let running = running_codex_processes();

    if running.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Codex is currently running ({}). Close Codex CLI or Codex Desktop before switching accounts.",
        running.into_iter().collect::<Vec<_>>().join(", ")
    ))
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
        Command::new("codex")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    }
}

fn running_codex_processes() -> BTreeSet<String> {
    let system = System::new_all();
    let mut found = BTreeSet::new();

    for process in system.processes().values() {
        let name = process.name().to_string_lossy().to_ascii_lowercase();

        let executable = process
            .exe()
            .map(|path| path.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        let command_line = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();

        if name == "codex.exe" || name == "codex" {
            if command_line.contains("app-server") {
                found.insert("Codex app-server".to_string());
            } else if executable.contains("\\openai\\codex\\")
                || executable.contains("/openai/codex/")
                || executable.contains("openai.codex_")
            {
                found.insert("Codex Desktop runtime".to_string());
            } else {
                found.insert("Codex CLI".to_string());
            }

            continue;
        }

        if name == "chatgpt.exe" || name == "chatgpt" {
            let is_codex_desktop =
                executable.contains("openai.codex_")
                    || executable.contains("\\openai\\codex\\")
                    || executable.contains("/openai/codex/")
                    || command_line.contains("openai.codex_")
                    || command_line.contains("\\openai\\codex\\")
                    || command_line.contains("/openai/codex/");

            if is_codex_desktop {
                found.insert("Codex Desktop".to_string());
            }
        }
    }

    found
}
