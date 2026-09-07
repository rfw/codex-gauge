use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Updater, UpdaterExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    app.updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
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
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let Some(update) = updater(&app)?
        .check()
        .await
        .map_err(|error| {
            log::error!("Unable to check for updates before installation: {error}");
            "Unable to install update.".to_string()
        })?
    else {
        return Err("No application update is currently available.".to_string());
    };

    let target_version = update.version.clone();
    log::info!("Installing application update to version {target_version}");

    update
        .download_and_install(|_, _| {}, || {})
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
