import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import { enUS, type TranslationKey } from "@/i18n/resources/en-US"
import { zhCN } from "@/i18n/resources/zh-CN"
import type {
  LanguagePreference,
  SupportedLocale,
} from "@/i18n/types"
import {
  getLanguageSettings,
  saveLanguageSettings,
} from "@/lib/settings-service"

export type TranslationParams = Record<
  string,
  string | number | null | undefined
>

export type Translate = (
  key: TranslationKey,
  params?: TranslationParams,
) => string

type I18nContextValue = {
  language: LanguagePreference
  locale: SupportedLocale
  t: Translate
  setLanguage: (language: LanguagePreference) => Promise<void>
}

type I18nProviderProps = {
  initialLanguage: LanguagePreference
  children: ReactNode
}

const resources: Record<
  SupportedLocale,
  Record<TranslationKey, string>
> = {
  "en-US": enUS,
  "zh-CN": zhCN,
}

const I18nContext = createContext<I18nContextValue | null>(null)

export async function loadInitialLanguage(): Promise<LanguagePreference> {
  try {
    const settings = await getLanguageSettings()
    return settings.language
  } catch {
    return "system"
  }
}

export function resolveSystemLocale(): SupportedLocale {
  if (typeof navigator === "undefined") {
    return "en-US"
  }

  const languages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language]

  return languages.some((language) =>
    language.toLowerCase().startsWith("zh"),
  )
    ? "zh-CN"
    : "en-US"
}

function interpolate(
  template: string,
  params?: TranslationParams,
): string {
  if (!params) {
    return template
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = params[key]
    return value === null || value === undefined ? match : String(value)
  })
}

export function I18nProvider({
  initialLanguage,
  children,
}: I18nProviderProps) {
  const [language, setLanguageState] =
    useState<LanguagePreference>(initialLanguage)
  const [systemLocale, setSystemLocale] =
    useState<SupportedLocale>(() => resolveSystemLocale())

  const locale = language === "system" ? systemLocale : language

  useEffect(() => {
    const handleLanguageChange = () => {
      setSystemLocale(resolveSystemLocale())
    }

    window.addEventListener("languagechange", handleLanguageChange)

    return () => {
      window.removeEventListener("languagechange", handleLanguageChange)
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const t = useCallback<Translate>(
    (key, params) => interpolate(resources[locale][key], params),
    [locale],
  )

  const setLanguage = useCallback(
    async (nextLanguage: LanguagePreference) => {
      const saved = await saveLanguageSettings({
        language: nextLanguage,
      })

      setLanguageState(saved.language)

      if (saved.language === "system") {
        setSystemLocale(resolveSystemLocale())
      }
    },
    [],
  )

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      locale,
      t,
      setLanguage,
    }),
    [language, locale, setLanguage, t],
  )

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)

  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider")
  }

  return context
}

export type { LanguagePreference, SupportedLocale } from "@/i18n/types"
export type { TranslationKey } from "@/i18n/resources/en-US"
