import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n, type Translate } from "@/i18n"
import {
  getProxySettings,
  saveProxySettings,
  testProxyConnection,
  type ProxyMode,
  type ProxySettings,
} from "@/lib/settings-service"

type ProxySettingsPanelProps = {
  onSaved?: () => void | Promise<void>
}

type ValidationResult = {
  normalized: string | null
  scheme: "HTTP" | "HTTPS" | null
  error: string | null
}

function validateCustomProxy(
  value: string,
  t: Translate,
): ValidationResult {
  const trimmed = value.trim()

  if (!trimmed) {
    return {
      normalized: null,
      scheme: null,
      error: t("proxy.enterAddress"),
    }
  }

  const lower = trimmed.toLowerCase()

  if (
    lower.startsWith("socks://") ||
    lower.startsWith("socks4://") ||
    lower.startsWith("socks5://") ||
    lower.startsWith("socks5h://")
  ) {
    return {
      normalized: null,
      scheme: null,
      error: t("proxy.socksUnsupported"),
    }
  }

  const candidate = trimmed.includes("://")
    ? trimmed
    : `http://${trimmed}`

  try {
    const url = new URL(candidate)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        normalized: null,
        scheme: null,
        error: t("proxy.httpHttpsOnly"),
      }
    }

    if (!url.hostname) {
      return {
        normalized: null,
        scheme: null,
        error: t("proxy.hostRequired"),
      }
    }

    if (!url.port) {
      return {
        normalized: null,
        scheme: null,
        error: t("proxy.portRequired"),
      }
    }

    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return {
        normalized: null,
        scheme: null,
        error: t("proxy.hostPortOnly"),
      }
    }

    const scheme = url.protocol === "https:" ? "HTTPS" : "HTTP"

    return {
      normalized: `${url.protocol}//${url.hostname}:${url.port}`,
      scheme,
      error: null,
    }
  } catch {
    return {
      normalized: null,
      scheme: null,
      error: t("proxy.invalidUrl"),
    }
  }
}

export function ProxySettingsPanel({
  onSaved,
}: ProxySettingsPanelProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<ProxyMode>("systemProxy")
  const [customProxy, setCustomProxy] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const validation = useMemo(
    () => validateCustomProxy(customProxy, t),
    [customProxy, t],
  )

  useEffect(() => {
    let disposed = false

    void getProxySettings()
      .then((settings) => {
        if (disposed) {
          return
        }

        setMode(settings.mode)
        setCustomProxy(settings.customProxy ?? "")
      })
      .catch(() => {
        if (!disposed) {
          setError(t("proxy.readError"))
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [t])

  function currentSettings(): ProxySettings | null {
    if (mode !== "customProxy") {
      return {
        mode,
        customProxy: null,
      }
    }

    if (validation.error || !validation.normalized) {
      setError(validation.error ?? t("proxy.invalidUrl"))
      return null
    }

    return {
      mode,
      customProxy: validation.normalized,
    }
  }

  async function handleTest() {
    const settings = currentSettings()

    if (!settings) {
      return
    }

    setIsTesting(true)
    setMessage(null)
    setError(null)

    try {
      await testProxyConnection(settings)

      if (settings.mode === "noProxy") {
        setMessage(t("proxy.connectedNoProxy"))
      } else if (settings.mode === "systemProxy") {
        setMessage(t("proxy.connectedSystem"))
      } else {
        setMessage(
          t("proxy.connectedCustom", {
            scheme: validation.scheme ?? "HTTP",
          }),
        )
      }
    } catch {
      setError(t("proxy.connectionError"))
    } finally {
      setIsTesting(false)
    }
  }

  async function handleSave() {
    const settings = currentSettings()

    if (!settings) {
      return
    }

    setIsSaving(true)
    setMessage(null)
    setError(null)

    try {
      const saved = await saveProxySettings(settings)
      setMode(saved.mode)
      setCustomProxy(saved.customProxy ?? "")
      setMessage(t("proxy.saved"))
      await onSaved?.()
    } catch {
      setError(t("proxy.saveError"))
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        {t("proxy.loading")}
      </div>
    )
  }

  return (
    <div>
      <div>
        <h3 className="text-sm font-semibold">
          {t("proxy.title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("proxy.description")}
        </p>
      </div>

      <div className="mt-3 space-y-2">
        <ProxyOption
          checked={mode === "noProxy"}
          title={t("proxy.noProxy")}
          description={t("proxy.noProxyDescription")}
          onSelect={() => {
            setMode("noProxy")
            setMessage(null)
            setError(null)
          }}
        />

        <ProxyOption
          checked={mode === "systemProxy"}
          title={t("proxy.systemProxy")}
          description={t("proxy.systemProxyDescription")}
          onSelect={() => {
            setMode("systemProxy")
            setMessage(null)
            setError(null)
          }}
        />

        <ProxyOption
          checked={mode === "customProxy"}
          title={t("proxy.customProxy")}
          description={t("proxy.customProxyDescription")}
          onSelect={() => {
            setMode("customProxy")
            setMessage(null)
            setError(null)
          }}
        />
      </div>

      {mode === "customProxy" ? (
        <div className="mt-3 border-t pt-3">
          <label
            htmlFor="custom-proxy"
            className="text-sm font-medium"
          >
            {t("proxy.httpUrl")}
          </label>

          <Input
            id="custom-proxy"
            value={customProxy}
            className="mt-1.5 h-8 font-mono text-sm"
            placeholder="http://127.0.0.1:7897"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              setCustomProxy(event.target.value)
              setMessage(null)
              setError(null)
            }}
          />

          <div className="mt-1.5 min-h-4 text-xs">
            {customProxy.trim() && !validation.error && validation.scheme ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3" />
                {t("proxy.detected", {
                  scheme: validation.scheme,
                })}
                {validation.normalized ? ` · ${validation.normalized}` : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("proxy.help")}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          {message}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2.5 text-sm"
          disabled={isTesting || isSaving}
          onClick={() => void handleTest()}
        >
          {isTesting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : null}
          {isTesting ? t("proxy.testing") : t("proxy.testConnection")}
        </Button>

        <Button
          type="button"
          size="sm"
          className="h-8 px-2.5 text-sm"
          disabled={isTesting || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : null}
          {isSaving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  )
}

type ProxyOptionProps = {
  checked: boolean
  title: string
  description: string
  onSelect: () => void
}

function ProxyOption({
  checked,
  title,
  description,
  onSelect,
}: ProxyOptionProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors hover:bg-muted/30">
      <input
        type="radio"
        name="proxy-mode"
        checked={checked}
        className="mt-0.5 size-3.5 accent-foreground"
        onChange={onSelect}
      />

      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  )
}
