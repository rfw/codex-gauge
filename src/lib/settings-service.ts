import { invoke } from "@tauri-apps/api/core"

import type { LanguagePreference } from "@/i18n/types"
import type { ThemePreference } from "@/theme/types"

export type ProxyMode =
  | "noProxy"
  | "systemProxy"
  | "customProxy"

export type ProxySettings = {
  mode: ProxyMode
  customProxy: string | null
}

export type RefreshSettings = {
  enabled: boolean
  intervalSeconds: number
}

export type LanguageSettings = {
  language: LanguagePreference
}

export type ThemeSettings = {
  theme: ThemePreference
}

export type UpdateSettings = {
  ignoredVersion: string | null
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

export async function getRefreshSettings(): Promise<RefreshSettings> {
  return invoke<RefreshSettings>("get_refresh_settings")
}

export async function saveRefreshSettings(
  settings: RefreshSettings,
): Promise<RefreshSettings> {
  return invoke<RefreshSettings>("save_refresh_settings", {
    settings,
  })
}

export async function getLanguageSettings(): Promise<LanguageSettings> {
  return invoke<LanguageSettings>("get_language_settings")
}

export async function saveLanguageSettings(
  settings: LanguageSettings,
): Promise<LanguageSettings> {
  return invoke<LanguageSettings>("save_language_settings", {
    settings,
  })
}

export async function getThemeSettings(): Promise<ThemeSettings> {
  return invoke<ThemeSettings>("get_theme_settings")
}

export async function saveThemeSettings(
  settings: ThemeSettings,
): Promise<ThemeSettings> {
  return invoke<ThemeSettings>("save_theme_settings", {
    settings,
  })
}

export async function getUpdateSettings(): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("get_update_settings")
}

export async function saveUpdateSettings(
  settings: UpdateSettings,
): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("save_update_settings", {
    settings,
  })
}

export async function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_external_url", {
    url,
  })
}
