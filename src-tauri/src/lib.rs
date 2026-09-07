mod accounts;
mod runtime;
mod settings;
mod tray;
mod usage;
mod updater;

use tauri::Manager;

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn production_webview_restrictions() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::{Flags, PlatformOptions};

    tauri_plugin_prevent_default::Builder::new()
        .with_flags(Flags::empty())
        .platform(
            PlatformOptions::new()
                .browser_accelerator_keys(false)
                .default_context_menus(false)
                .dev_tools(false),
        )
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    let builder = builder.plugin(production_webview_restrictions());

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let version = app.package_info().version.to_string();
            log::info!("CodexGauge v{version} started");

            tray::setup_tray(app)?;

            app.manage(accounts::AuthWatcherState::new());

            if runtime::codex_cli_status().codex_cli_installed {
                if let Err(error) = accounts::start_auth_watcher(app.handle().clone()) {
                    log::error!("Auth watcher could not start: {error}");
                }
            }

            Ok(())
        })
        .on_window_event(tray::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            runtime::get_runtime_status,
            runtime::open_codex_install_guide,
            runtime::open_external_url,
            runtime::close_codex_gauge,
            tray::show_main_window,
            tray::minimize_main_window,
            tray::close_main_window,
            tray::start_main_window_drag,
            tray::hide_main_window_to_tray,
            tray::show_tray_close_notification,
            accounts::list_codex_accounts,
            accounts::add_codex_account,
            accounts::rename_codex_account,
            accounts::switch_codex_account,
            accounts::delete_codex_account,
            settings::get_proxy_settings,
            settings::save_proxy_settings,
            settings::test_proxy_connection,
            settings::get_refresh_settings,
            settings::save_refresh_settings,
            settings::get_language_settings,
            settings::save_language_settings,
            settings::get_theme_settings,
            settings::save_theme_settings,
            settings::get_update_settings,
            settings::save_update_settings,
            updater::check_for_app_update,
            updater::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
