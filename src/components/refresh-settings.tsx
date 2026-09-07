import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import type { TranslationKey } from "@/i18n/resources/en-US"
import {
  getRefreshSettings,
  saveRefreshSettings,
  type RefreshSettings,
} from "@/lib/settings-service"

type RefreshSettingsPanelProps = {
  onSaved?: (settings: RefreshSettings) => void | Promise<void>
}

const INTERVAL_OPTIONS: Array<{
  value: number
  labelKey: TranslationKey
}> = [
  { value: 30, labelKey: "polling.30Seconds" },
  { value: 60, labelKey: "polling.60Seconds" },
  { value: 120, labelKey: "polling.2Minutes" },
  { value: 300, labelKey: "polling.5Minutes" },
  { value: 600, labelKey: "polling.10Minutes" },
  { value: 900, labelKey: "polling.15Minutes" },
  { value: 1800, labelKey: "polling.30Minutes" },
  { value: 3600, labelKey: "polling.1Hour" },
  { value: 10800, labelKey: "polling.3Hours" },
  { value: 18000, labelKey: "polling.5Hours" },
]

export function RefreshSettingsPanel({
  onSaved,
}: RefreshSettingsPanelProps) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(true)
  const [intervalSeconds, setIntervalSeconds] = useState(60)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    void getRefreshSettings()
      .then((settings) => {
        if (disposed) {
          return
        }

        setEnabled(settings.enabled)
        setIntervalSeconds(settings.intervalSeconds)
      })
      .catch((cause) => {
        if (!disposed) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("polling.readError"),
          )
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

  async function handleSave() {
    setIsSaving(true)
    setMessage(null)
    setError(null)

    try {
      const saved = await saveRefreshSettings({
        enabled,
        intervalSeconds,
      })

      setEnabled(saved.enabled)
      setIntervalSeconds(saved.intervalSeconds)
      setMessage(t("polling.saved"))
      await onSaved?.(saved)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("polling.saveError"),
      )
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        {t("polling.loading")}
      </div>
    )
  }

  return (
    <div>
      <div>
        <h3 className="text-sm font-semibold">
          {t("polling.title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("polling.description")}
        </p>
      </div>

      <label className="mt-4 flex cursor-pointer items-start justify-between gap-4 rounded-md border px-3 py-2.5">
        <span>
          <span className="block text-sm font-medium">
            {t("polling.automaticRefresh")}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("polling.automaticDescription")}
          </span>
        </span>

        <input
          type="checkbox"
          checked={enabled}
          className="mt-0.5 size-4 accent-foreground"
          onChange={(event) => {
            setEnabled(event.target.checked)
            setMessage(null)
            setError(null)
          }}
        />
      </label>

      <div className="mt-3">
        <label
          htmlFor="polling-interval"
          className="text-sm font-medium"
        >
          {t("polling.interval")}
        </label>

        <select
          id="polling-interval"
          value={intervalSeconds}
          disabled={!enabled}
          className="mt-1.5 h-8 w-full rounded-md border bg-background px-2.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => {
            setIntervalSeconds(Number(event.target.value))
            setMessage(null)
            setError(null)
          }}
        >
          {INTERVAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
              {option.value === 60
                ? ` (${t("common.default")})`
                : ""}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          {message}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          size="sm"
          className="h-8 px-2.5 text-sm"
          disabled={isSaving}
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
