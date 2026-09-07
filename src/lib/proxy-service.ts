import { invoke } from "@tauri-apps/api/core"

export type ProxyMode =
  | "noProxy"
  | "systemProxy"
  | "customProxy"

export type ProxySettings = {
  mode: ProxyMode
  customProxy: string | null
}

export async function getProxySettings(): Promise<ProxySettings> {
  return invoke<ProxySettings>("get_proxy_settings")
}

export async function saveProxySettings(
  settings: ProxySettings,
): Promise<ProxySettings> {
  return invoke<ProxySettings>("save_proxy_settings", {
    settings,
  })
}

export async function testProxyConnection(
  settings: ProxySettings,
): Promise<string> {
  return invoke<string>("test_proxy_connection", {
    settings,
  })
}
