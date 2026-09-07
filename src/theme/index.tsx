import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import {
  getThemeSettings,
  saveThemeSettings,
} from "@/lib/settings-service"
import type { ThemePreference } from "@/theme/types"

type ThemeContextValue = {
  theme: ThemePreference
  resolvedTheme: "light" | "dark"
  setTheme: (theme: ThemePreference) => Promise<void>
}

type ThemeProviderProps = {
  initialTheme: ThemePreference
  children: ReactNode
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
}

function resolveTheme(theme: ThemePreference): "light" | "dark" {
  if (theme === "system") {
    return systemPrefersDark() ? "dark" : "light"
  }

  return theme
}

export function applyTheme(theme: ThemePreference): "light" | "dark" {
  const resolved = resolveTheme(theme)
  const root = document.documentElement

  root.classList.toggle("dark", resolved === "dark")
  root.style.colorScheme = resolved

  return resolved
}

export async function loadInitialTheme(): Promise<ThemePreference> {
  try {
    const settings = await getThemeSettings()
    return settings.theme
  } catch {
    return "system"
  }
}

export function ThemeProvider({
  initialTheme,
  children,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme)
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(
    () => applyTheme(initialTheme),
  )

  useEffect(() => {
    setResolvedTheme(applyTheme(theme))
  }, [theme])

  useEffect(() => {
    if (theme !== "system") {
      return
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      setResolvedTheme(applyTheme("system"))
    }

    media.addEventListener("change", handleChange)

    return () => {
      media.removeEventListener("change", handleChange)
    }
  }, [theme])

  const setTheme = useCallback(async (nextTheme: ThemePreference) => {
    const previousTheme = theme

    setThemeState(nextTheme)
    setResolvedTheme(applyTheme(nextTheme))

    try {
      const saved = await saveThemeSettings({ theme: nextTheme })
      setThemeState(saved.theme)
      setResolvedTheme(applyTheme(saved.theme))
    } catch (error) {
      setThemeState(previousTheme)
      setResolvedTheme(applyTheme(previousTheme))
      throw error
    }
  }, [theme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
    }),
    [resolvedTheme, setTheme, theme],
  )

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)

  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider")
  }

  return context
}

export type { ThemePreference } from "@/theme/types"
