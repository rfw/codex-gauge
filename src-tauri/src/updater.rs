use serde::Serialize;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::settings::{self, ProxyMode};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    let proxy_settings = settings::load_settings(app)
        .map_err(|error| {
            log::error!("Unable to load proxy settings for updater: {error}");
            "Unable to initialize updater.".to_string()
        })?
        .proxy;

    let builder = app.updater_builder().timeout(CHECK_TIMEOUT);

    let builder = match proxy_settings.mode {
        ProxyMode::NoProxy => {
            log::info!("Updater network mode: no proxy");
            builder.no_proxy()
        }
        ProxyMode::SystemProxy => {
            // tauri-plugin-updater enables system proxy discovery by default on
            // Windows/macOS. Leaving the builder untouched here means the
            // updater follows the operating system proxy configuration.
            log::info!("Updater network mode: system proxy");
            builder
        }
        ProxyMode::CustomProxy => {
            let proxy = proxy_settings
                .custom_proxy
                .as_deref()
                .ok_or_else(|| "Custom proxy URL is required.".to_string())?;

            let proxy_url = proxy.parse().map_err(|error| {
                log::error!("Unable to parse custom proxy URL for updater: {error}");
                "Unable to initialize updater.".to_string()
            })?;

            // An explicit updater proxy applies to both the update manifest
            // request and the release-asset download. Do not log the URL.
            log::info!("Updater network mode: custom proxy");
            builder.proxy(proxy_url)
        }
    };

    builder.build().map_err(|error| {
        log::error!("Unable to initialize updater: {error}");
        "Unable to initialize updater.".to_string()
    })
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
) -> Result<Option<AppUpdateInfo>, String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| {
            log::error!("Unable to check for updates: {error}");
            "Unable to check for updates.".to_string()
        })?;

    if let Some(update) = &update {
        log::info!(
            "Application update available: current={}, available={}",
            update.current_version,
            update.version
        );
    } else {
        log::info!("Application update check completed: already up to date");
    }

    Ok(update.map(|update| AppUpdateInfo {
        version: update.version,
        current_version: update.current_version,
        notes: update.body,
    }))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let Some(mut update) = updater(&app)?
        .check()
        .await
        .map_err(|error| {
            log::error!("Unable to check for updates before installation: {error}");
            "Unable to install update.".to_string()
        })?
    else {
        return Err("No application update is currently available.".to_string());
    };

    // Keep update checks responsive, but allow substantially more time for the
    // GitHub release asset itself. The proxy selected above is preserved on the
    // Update object and is therefore also used for the download.
    update.timeout = Some(DOWNLOAD_TIMEOUT);

    let target_version = update.version.clone();
    log::info!("Installing application update to version {target_version}");

    let mut started = false;

    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                    started = true;
                }

                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| {
            log::error!("Unable to install update {target_version}: {error}");
            "Unable to install update.".to_string()
        })?;

    log::info!("Application update {target_version} installed successfully");

    #[cfg(not(target_os = "windows"))]
    app.restart();

    Ok(())
}
