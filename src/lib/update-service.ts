import { invoke } from "@tauri-apps/api/core"

export type AppUpdateInfo = {
  version: string
  currentVersion: string
  notes: string | null
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  return invoke<AppUpdateInfo | null>("check_for_app_update")
}

export async function installAppUpdate(): Promise<void> {
  return invoke<void>("install_app_update")
}
