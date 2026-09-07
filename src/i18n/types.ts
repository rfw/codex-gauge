export type LanguagePreference = "system" | "en-US" | "zh-CN"

export type SupportedLocale = Exclude<LanguagePreference, "system">
