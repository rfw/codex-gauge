use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, Window, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

use crate::settings;

pub(crate) const FIRST_CLOSE_EVENT: &str = "codexgauge://tray-close-hint";

pub(crate) fn setup_tray<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open CodexGauge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("codexgauge-main")
        .tooltip("CodexGauge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => restore_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub(crate) fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    api.prevent_close();

    let app = window.app_handle();
    let show_first_close_notification = match settings::tray_close_hint_shown(app) {
        Ok(true) => false,
        Ok(false) => match settings::mark_tray_close_hint_shown(app) {
            Ok(()) => true,
            Err(error) => {
                log::error!("Could not persist the tray close notification state: {error}");
                false
            }
        },
        Err(error) => {
            log::error!("Could not read tray settings: {error}");
            false
        }
    };

    if show_first_close_notification {
        // The frontend owns localized copy. Emit before hiding; the webview stays
        // alive while hidden and will send the native Windows notification.
        if let Err(error) = window.emit(FIRST_CLOSE_EVENT, ()) {
            log::error!("Could not request the tray close notification: {error}");
        }
    }

    if let Err(error) = window.hide() {
        log::error!("Could not hide CodexGauge to the system tray: {error}");
    }
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "CodexGauge main window is unavailable.".to_string())
}

#[tauri::command]
pub(crate) fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;

    window
        .show()
        .map_err(|error| format!("Unable to show CodexGauge: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Unable to focus CodexGauge: {error}"))
}

#[tauri::command]
pub(crate) fn minimize_main_window(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .minimize()
        .map_err(|error| format!("Unable to minimize CodexGauge: {error}"))
}

#[tauri::command]
pub(crate) fn close_main_window(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .close()
        .map_err(|error| format!("Unable to close CodexGauge window: {error}"))
}

#[tauri::command]
pub(crate) fn start_main_window_drag(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .start_dragging()
        .map_err(|error| format!("Unable to drag CodexGauge window: {error}"))
}

#[tauri::command]
pub(crate) fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    settings::mark_tray_close_hint_shown(&app)?;

    main_window(&app)?
        .hide()
        .map_err(|error| format!("Unable to hide CodexGauge to the system tray: {error}"))
}

#[tauri::command]
pub(crate) fn show_tray_close_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| {
            log::error!("Unable to show native tray notification: {error}");
            "Unable to show the system notification.".to_string()
        })
}

fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
