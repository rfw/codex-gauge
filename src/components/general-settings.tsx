import { useState } from "react"
import { LoaderCircle } from "lucide-react"

import { useI18n } from "@/i18n"
import type { LanguagePreference } from "@/i18n/types"
import { useTheme } from "@/theme"
import type { ThemePreference } from "@/theme/types"

export function GeneralSettingsPanel() {
  const { language, t, setLanguage } = useI18n()
  const { theme, setTheme } = useTheme()
  const [savingField, setSavingField] = useState<"language" | "theme" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleLanguageChange(
    nextLanguage: LanguagePreference,
  ) {
    if (nextLanguage === language || savingField) {
      return
    }

    setSavingField("language")
    setError(null)

    try {
      await setLanguage(nextLanguage)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("general.saveError"),
      )
    } finally {
      setSavingField(null)
    }
  }

  async function handleThemeChange(nextTheme: ThemePreference) {
    if (nextTheme === theme || savingField) {
      return
    }

    setSavingField("theme")
    setError(null)

    try {
      await setTheme(nextTheme)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("general.themeSaveError"),
      )
    } finally {
      setSavingField(null)
    }
  }

  return (
    <div>
      <div>
        <h3 className="text-sm font-semibold">
          {t("general.title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("general.description")}
        </p>
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="app-language"
            className="text-sm font-medium"
          >
            {t("general.language")}
          </label>

          <select
            id="app-language"
            value={language}
            disabled={savingField !== null}
            className="mt-1.5 h-8 w-full rounded-md border bg-background px-2.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) =>
              void handleLanguageChange(
                event.target.value as LanguagePreference,
              )
            }
          >
            <option value="system">
              {t("general.systemDefault")}
            </option>
            <option value="en-US">
              {t("general.english")}
            </option>
            <option value="zh-CN">
              {t("general.simplifiedChinese")}
            </option>
          </select>

          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("general.languageDescription")}
          </p>
        </div>

        <div>
          <label
            htmlFor="app-theme"
            className="text-sm font-medium"
          >
            {t("general.theme")}
          </label>

          <select
            id="app-theme"
            value={theme}
            disabled={savingField !== null}
            className="mt-1.5 h-8 w-full rounded-md border bg-background px-2.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) =>
              void handleThemeChange(
                event.target.value as ThemePreference,
              )
            }
          >
            <option value="system">
              {t("general.systemDefault")}
            </option>
            <option value="light">
              {t("general.light")}
            </option>
            <option value="dark">
              {t("general.dark")}
            </option>
          </select>

          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("general.themeDescription")}
          </p>
        </div>
      </div>

      {savingField ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {savingField === "language"
            ? t("general.saving")
            : t("general.savingTheme")}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}
