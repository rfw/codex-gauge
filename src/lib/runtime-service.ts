import { invoke } from "@tauri-apps/api/core"

export type RuntimeStatus = {
  codexCliInstalled: boolean
  codexCliVersion: string | null
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("get_runtime_status")
}

export async function openCodexInstallGuide(): Promise<void> {
  return invoke<void>("open_codex_install_guide")
}

export async function closeCodexGauge(): Promise<void> {
  return invoke<void>("close_codex_gauge")
}
