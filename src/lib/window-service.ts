import { invoke } from "@tauri-apps/api/core"

export async function minimizeMainWindow() {
  await invoke("minimize_main_window")
}

export async function closeMainWindow() {
  await invoke("close_main_window")
}

export async function startMainWindowDrag() {
  await invoke("start_main_window_drag")
}

export async function showMainWindow() {
  await invoke("show_main_window")
}
