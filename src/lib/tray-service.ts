import { invoke } from "@tauri-apps/api/core"

export async function showTrayCloseNotification(
  title: string,
  body: string,
): Promise<void> {
  await invoke<void>("show_tray_close_notification", {
    title,
    body,
  })
}

export async function updateTrayMenuLabels(
  showLabel: string,
  quitLabel: string,
): Promise<void> {
  await invoke<void>("update_tray_menu_labels", {
    showLabel,
    quitLabel,
  })
}
