import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import App from "./App"
import { Toaster } from "@/components/ui/toast"
import "./index.css"
import {
  I18nProvider,
  loadInitialLanguage,
} from "@/i18n"
import { showMainWindow } from "@/lib/window-service"
import {
  applyTheme,
  loadInitialTheme,
  ThemeProvider,
} from "@/theme"
import { AppUpdateProvider } from "@/update"
import { PostHogProvider } from '@posthog/react'
import {APP_CONFIG} from "@/config/app-config.ts";

const options = {
  api_host: APP_CONFIG.posthogHost,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  disable_session_recording: true,
} as const

async function bootstrap() {
  const [initialLanguage, initialTheme] = await Promise.all([
    loadInitialLanguage(),
    loadInitialTheme(),
  ])

  // Apply the persisted/system theme before the hidden native window is shown.
  // This prevents a light flash when the user is using the dark theme.
  applyTheme(initialTheme)

  const root = createRoot(document.getElementById("root")!)

  flushSync(() => {
    root.render(
      <StrictMode>
        <PostHogProvider apiKey={import.meta.env.VITE_POSTHOG_PROJECT_TOKEN} options={options}>
          <ThemeProvider initialTheme={initialTheme}>
            <I18nProvider initialLanguage={initialLanguage}>
              <AppUpdateProvider>
                <App />
                <Toaster timeout={3000} limit={3} />
              </AppUpdateProvider>
            </I18nProvider>
          </ThemeProvider>
        </PostHogProvider>
      </StrictMode>,
    )
  })

  await showMainWindow()
}

void bootstrap().catch((error) => {
  console.error("CodexGauge bootstrap failed", error)

  // Avoid leaving the application permanently hidden if an unexpected
  // frontend bootstrap error occurs.
  void showMainWindow().catch(() => undefined)
})
