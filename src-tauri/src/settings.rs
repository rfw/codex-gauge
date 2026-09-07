use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

use crate::usage;

const SETTINGS_VERSION: u32 = 5;

const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    #[serde(default = "settings_version")]
    version: u32,
    #[serde(default)]
    pub(crate) proxy: ProxySettings,
    #[serde(default)]
    pub(crate) refresh: RefreshSettings,
    #[serde(default)]
    pub(crate) language: LanguageSettings,
    #[serde(default)]
    pub(crate) theme: ThemeSettings,
    #[serde(default)]
    pub(crate) update: UpdateSettings,
    #[serde(default)]
    pub(crate) tray: TraySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxySettings {
    pub(crate) mode: ProxyMode,
    #[serde(default)]
    pub(crate) custom_proxy: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProxyMode {
    NoProxy,
    SystemProxy,
    CustomProxy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshSettings {
    pub(crate) enabled: bool,
    pub(crate) interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageSettings {
    pub(crate) language: LanguagePreference,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum LanguagePreference {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "zh-CN")]
    ZhCn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThemeSettings {
    pub(crate) theme: ThemePreference,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSettings {
    #[serde(default)]
    pub(crate) ignored_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraySettings {
    #[serde(default)]
    pub(crate) close_hint_shown: bool,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: ProxyMode::SystemProxy,
            custom_proxy: None,
        }
    }
}

impl Default for RefreshSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: 60,
        }
    }
}

impl Default for LanguageSettings {
    fn default() -> Self {
        Self {
            language: LanguagePreference::System,
        }
    }
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            proxy: ProxySettings::default(),
            refresh: RefreshSettings::default(),
            language: LanguageSettings::default(),
            theme: ThemeSettings::default(),
            update: UpdateSettings::default(),
            tray: TraySettings::default(),
        }
    }
}

#[tauri::command]
pub fn get_proxy_settings(app: AppHandle) -> Result<ProxySettings, String> {
    load_settings(&app)
        .map(|settings| settings.proxy)
        .map_err(|error| {
            log::error!("Unable to read proxy settings: {error}");
            "Unable to read proxy settings.".to_string()
        })
}

#[tauri::command]
pub fn save_proxy_settings(
    app: AppHandle,
    settings: ProxySettings,
) -> Result<ProxySettings, String> {
    let normalized = normalize_proxy_settings(settings)?;
    let mut app_settings = load_settings(&app).map_err(|error| {
        log::error!("Unable to load settings before saving proxy settings: {error}");
        "Unable to save proxy settings.".to_string()
    })?;

    app_settings.version = SETTINGS_VERSION;
    app_settings.proxy = normalized.clone();

    save_app_settings(&app, &app_settings).map_err(|error| {
        log::error!("Unable to save proxy settings: {error}");
        "Unable to save proxy settings.".to_string()
    })?;

    log::info!("Proxy settings saved: mode={:?}", normalized.mode);
    Ok(normalized)
}

#[tauri::command]
pub async fn test_proxy_connection(
    app: AppHandle,
    settings: ProxySettings,
) -> Result<String, String> {
    let normalized = normalize_proxy_settings(settings)?;
    let mode = normalized.mode;

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        usage::test_proxy_connection(&app, &normalized)?;

        Ok(match normalized.mode {
            ProxyMode::NoProxy => "Connected without a proxy.".to_string(),
            ProxyMode::SystemProxy => "Connected using the system proxy.".to_string(),
            ProxyMode::CustomProxy => {
                let scheme = normalized
                    .custom_proxy
                    .as_deref()
                    .and_then(|value| value.split_once("://"))
                    .map(|(scheme, _)| scheme.to_ascii_uppercase())
                    .unwrap_or_else(|| "HTTP".to_string());

                format!("Connected using the {scheme} proxy.")
            }
        })
    })
    .await;

    match result {
        Ok(Ok(message)) => {
            log::info!("Proxy connection test succeeded: mode={mode:?}");
            Ok(message)
        }
        Ok(Err(error)) => {
            log::error!("Proxy connection test failed: mode={mode:?}; {error}");
            Err("Unable to connect using this proxy setting.".to_string())
        }
        Err(error) => {
            log::error!("Proxy connection test task failed: mode={mode:?}; {error}");
            Err("Unable to connect using this proxy setting.".to_string())
        }
    }
}

#[tauri::command]
pub fn get_refresh_settings(app: AppHandle) -> Result<RefreshSettings, String> {
    Ok(load_settings(&app)?.refresh)
}

#[tauri::command]
pub fn save_refresh_settings(
    app: AppHandle,
    settings: RefreshSettings,
) -> Result<RefreshSettings, String> {
    let normalized = normalize_refresh_settings(settings)?;
    let mut app_settings = load_settings(&app)?;
    app_settings.version = SETTINGS_VERSION;
    app_settings.refresh = normalized.clone();
    save_app_settings(&app, &app_settings)?;
    Ok(normalized)
}

#[tauri::command]
pub fn get_language_settings(app: AppHandle) -> Result<LanguageSettings, String> {
    Ok(load_settings(&app)?.language)
}

#[tauri::command]
pub fn save_language_settings(
    app: AppHandle,
    settings: LanguageSettings,
) -> Result<LanguageSettings, String> {
    let mut app_settings = load_settings(&app)?;
    app_settings.version = SETTINGS_VERSION;
    app_settings.language = settings.clone();
    save_app_settings(&app, &app_settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn get_theme_settings(app: AppHandle) -> Result<ThemeSettings, String> {
    Ok(load_settings(&app)?.theme)
}

#[tauri::command]
pub fn save_theme_settings(
    app: AppHandle,
    settings: ThemeSettings,
) -> Result<ThemeSettings, String> {
    let mut app_settings = load_settings(&app)?;
    app_settings.version = SETTINGS_VERSION;
    app_settings.theme = settings.clone();
    save_app_settings(&app, &app_settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn get_update_settings(app: AppHandle) -> Result<UpdateSettings, String> {
    Ok(load_settings(&app)?.update)
}

#[tauri::command]
pub fn save_update_settings(
    app: AppHandle,
    mut settings: UpdateSettings,
) -> Result<UpdateSettings, String> {
    settings.ignored_version = settings
        .ignored_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let mut app_settings = load_settings(&app)?;
    app_settings.version = SETTINGS_VERSION;
    app_settings.update = settings.clone();
    save_app_settings(&app, &app_settings)?;
    Ok(settings)
}

pub(crate) fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;

    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default());
        }
        Err(error) => return Err(format!("Failed to read CodexGauge settings: {error}")),
    };

    let mut settings: AppSettings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid CodexGauge settings: {error}"))?;

    settings.proxy = normalize_proxy_settings(settings.proxy)?;
    settings.refresh = normalize_refresh_settings(settings.refresh)?;

    Ok(settings)
}

pub(crate) fn load_proxy_settings(app: &AppHandle) -> Result<AppSettings, String> {
    load_settings(app)
}

pub(crate) fn tray_close_hint_shown(app: &AppHandle) -> Result<bool, String> {
    Ok(load_settings(app)?.tray.close_hint_shown)
}

pub(crate) fn mark_tray_close_hint_shown(app: &AppHandle) -> Result<(), String> {
    let mut app_settings = load_settings(app)?;
    app_settings.version = SETTINGS_VERSION;
    app_settings.tray.close_hint_shown = true;
    save_app_settings(app, &app_settings)
}


pub(crate) fn configure_codex_command(
    command: &mut Command,
    settings: &ProxySettings,
) -> Result<(), String> {
    for key in PROXY_ENV_KEYS {
        command.env_remove(key);
    }

    match settings.mode {
        ProxyMode::NoProxy => {}
        ProxyMode::SystemProxy => {}
        ProxyMode::CustomProxy => {
            let proxy = settings
                .custom_proxy
                .as_deref()
                .ok_or_else(|| "Custom proxy URL is required.".to_string())?;

            command
                .env("HTTP_PROXY", proxy)
                .env("HTTPS_PROXY", proxy)
                .env("http_proxy", proxy)
                .env("https_proxy", proxy)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1");
        }
    }

    Ok(())
}

pub(crate) fn codex_config_override(settings: &ProxySettings) -> &'static str {
    match settings.mode {
        ProxyMode::SystemProxy => "features.respect_system_proxy=true",
        ProxyMode::NoProxy | ProxyMode::CustomProxy => "features.respect_system_proxy=false",
    }
}

fn normalize_proxy_settings(mut settings: ProxySettings) -> Result<ProxySettings, String> {
    match settings.mode {
        ProxyMode::NoProxy | ProxyMode::SystemProxy => {
            settings.custom_proxy = None;
        }
        ProxyMode::CustomProxy => {
            let raw = settings
                .custom_proxy
                .as_deref()
                .ok_or_else(|| "Enter an HTTP proxy address.".to_string())?;

            settings.custom_proxy = Some(normalize_proxy_url(raw)?);
        }
    }

    Ok(settings)
}

fn normalize_refresh_settings(settings: RefreshSettings) -> Result<RefreshSettings, String> {
    if !(15..=18000).contains(&settings.interval_seconds) {
        return Err("Polling interval must be between 15 and 18000 seconds.".to_string());
    }

    Ok(settings)
}

fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err("Enter an HTTP proxy address.".to_string());
    }

    if trimmed.chars().any(char::is_whitespace) {
        return Err("Proxy URL cannot contain spaces.".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    let (scheme, remainder) = candidate
        .split_once("://")
        .ok_or_else(|| "Invalid proxy URL.".to_string())?;

    let scheme = scheme.to_ascii_lowercase();

    if scheme != "http" && scheme != "https" {
        if scheme.starts_with("socks") {
            return Err(
                "SOCKS proxy is not supported. Enter an HTTP or HTTPS proxy."
                    .to_string(),
            );
        }

        return Err("Only HTTP and HTTPS proxies are supported.".to_string());
    }

    let authority = remainder.trim_end_matches('/');

    if authority.is_empty() {
        return Err("Proxy host is required.".to_string());
    }

    if authority.contains('/') || authority.contains('?') || authority.contains('#') {
        return Err(
            "Proxy URL must contain only a host and port, for example http://127.0.0.1:7897."
                .to_string(),
        );
    }

    if authority.contains('@') {
        return Err("Proxy URLs with embedded credentials are not supported yet.".to_string());
    }

    let (host, port_text) = if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| "Invalid IPv6 proxy address.".to_string())?;

        let host = &authority[..=end];
        let suffix = &authority[end + 1..];

        let port = suffix
            .strip_prefix(':')
            .ok_or_else(|| "Proxy URL must include a port.".to_string())?;

        (host, port)
    } else {
        authority
            .rsplit_once(':')
            .ok_or_else(|| "Proxy URL must include a port.".to_string())?
    };

    if host.trim().is_empty() {
        return Err("Proxy host is required.".to_string());
    }

    let port = port_text
        .parse::<u16>()
        .map_err(|_| "Proxy port must be between 1 and 65535.".to_string())?;

    if port == 0 {
        return Err("Proxy port must be between 1 and 65535.".to_string());
    }

    Ok(format!("{scheme}://{host}:{port}"))
}

fn settings_version() -> u32 {
    SETTINGS_VERSION
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve CodexGauge settings directory: {error}"))?;

    fs::create_dir_all(&dir)
        .map_err(|error| format!("Unable to create CodexGauge settings directory: {error}"))?;

    Ok(dir.join("settings.json"))
}

fn save_app_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Failed to serialize CodexGauge settings: {error}"))?;

    atomic_write(&settings_path(app)?, &bytes)
        .map_err(|error| format!("Failed to save CodexGauge settings: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = AtomicWriteFile::open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.commit()
}
