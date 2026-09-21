import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import {
  getNotificationSettings,
  saveNotificationSettings,
  type NotificationSettings,
} from "@/lib/settings-service"

type NotificationSettingsPanelProps = {
  onSaved?: (settings: NotificationSettings) => void | Promise<void>
}

export function NotificationSettingsPanel({
  onSaved,
}: NotificationSettingsPanelProps) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    void getNotificationSettings()
      .then((settings) => {
        if (!disposed) {
          setEnabled(settings.resetNotificationsEnabled)
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("notifications.readError"),
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
      const saved = await saveNotificationSettings({
        resetNotificationsEnabled: enabled,
      })

      setEnabled(saved.resetNotificationsEnabled)
      setMessage(t("notifications.saved"))
      await onSaved?.(saved)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("notifications.saveError"),
      )
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        {t("notifications.loading")}
      </div>
    )
  }

  return (
    <div>
      <div>
        <h3 className="text-sm font-semibold">
          {t("notifications.title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("notifications.description")}
        </p>
      </div>

      <label className="mt-4 flex cursor-pointer items-start justify-between gap-4 rounded-md border px-3 py-2.5">
        <span>
          <span className="block text-sm font-medium">
            {t("notifications.resetNotifications")}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("notifications.resetNotificationsDescription")}
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
