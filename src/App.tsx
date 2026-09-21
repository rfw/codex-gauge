import { useEffect, useRef, useState, type ReactNode } from "react"
import { RefreshCw, Settings2 } from "lucide-react"

import { AccountCard } from "@/components/account-card"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { AppHeader } from "@/components/app-header"
import { CodexCliRequiredDialog } from "@/components/codex-cli-required-dialog"
import { TrayCloseNotice } from "@/components/tray-close-notice"
import {
  SettingsDialog,
  type SettingsTab,
} from "@/components/settings-dialog"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { useAccounts } from "@/features/accounts/use-accounts"
import { useI18n } from "@/i18n"
import {
  isNetworkOrProxyErrorMessage,
  localizeErrorMessage,
} from "@/i18n/errors"
import {
  formatClockTime,
  formatPollingInterval,
  formatResetTime,
} from "@/lib/format"
import {
  getRuntimeStatus,
  type RuntimeStatus,
} from "@/lib/runtime-service"
import type { CodexAccount } from "@/features/accounts/types"
import {
  getNotificationSettings,
  type NotificationSettings,
} from "@/lib/settings-service"
import { showSystemNotification } from "@/lib/tray-service"

export default function App() {
  const { t } = useI18n()
  const [runtimeStatus, setRuntimeStatus] =
    useState<RuntimeStatus | null>(null)

  useEffect(() => {
    let disposed = false

    void getRuntimeStatus()
      .then((status) => {
        if (!disposed) {
          setRuntimeStatus(status)
        }
      })
      .catch(() => {
        if (!disposed) {
          setRuntimeStatus({
            codexCliInstalled: false,
            codexCliVersion: null,
          })
        }
      })

    return () => {
      disposed = true
    }
  }, [])

  let content: ReactNode

  if (!runtimeStatus) {
    content = (
      <main className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("app.checkingCodexCli")}
      </main>
    )
  } else if (!runtimeStatus.codexCliInstalled) {
    content = (
      <main className="min-h-0 flex-1 text-foreground">
        <CodexCliRequiredDialog />
      </main>
    )
  } else {
    content = <CodexGaugeApp />
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-muted/20 text-foreground">
      <AppHeader />
      {content}
      <TrayCloseNotice />
    </div>
  )
}

type NextResetCandidate = {
  account: CodexAccount
  kind: "fiveHour" | "weekly"
  resetsAt: number
}

function resetEventKey(candidate: NextResetCandidate) {
  return `${candidate.account.id}:${candidate.kind}:${candidate.resetsAt}`
}

function CodexGaugeApp() {
  const { locale, t } = useI18n()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] =
    useState<SettingsTab>("general")
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  )
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings | null>(null)
  const pendingResetRef = useRef<NextResetCandidate | null>(null)
  const notifiedResetKeysRef = useRef(new Set<string>())

  const {
    accounts,
    isLoading,
    isRefreshing,
    error,
    networkError,
    lastUpdatedAt,
    refreshSettings,
    autoRefreshPaused,
    refresh,
    switchAccount,
    renameAccount,
    addAccount,
    startReauthentication,
    pollReauthentication,
    cancelReauthentication,
    deleteAccount,
    updateRefreshSettings,
  } = useAccounts()

  function openSettings(tab: SettingsTab = "general") {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000))
    }, 30_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let disposed = false

    void getNotificationSettings()
      .then((settings) => {
        if (!disposed) {
          setNotificationSettings(settings)
        }
      })
      .catch(() => {
        if (!disposed) {
          setNotificationSettings({
            resetNotificationsEnabled: true,
          })
        }
      })

    return () => {
      disposed = true
    }
  }, [])

  async function handleSwitchAccount(accountId: string) {
    const accountLabel = accounts.find((account) => account.id === accountId)?.label

    await switchAccount(accountId)

    if (accountLabel) {
      toast.add({
        title: t("account.switchSuccess", { account: accountLabel }),
        type: "success",
      })
    }
  }

  const pollingLabel = !refreshSettings.enabled
    ? t("app.autoRefreshOff")
    : autoRefreshPaused
      ? t("app.autoRefreshPaused")
      : t("app.autoRefreshInterval", {
          interval: formatPollingInterval(
            refreshSettings.intervalSeconds,
            locale,
          ),
        })

  const updatedTime = formatClockTime(lastUpdatedAt, locale)
  const updatedLabel = updatedTime
    ? t("app.updated", { time: updatedTime })
    : t("app.notUpdated")

  const accountCountLabel = t(
    accounts.length === 1
      ? "app.accountCountOne"
      : "app.accountCountMany",
    { count: accounts.length },
  )

  const nextReset = accounts.reduce<NextResetCandidate | null>(
    (current, account) => {
      const weeklyRemaining = account.weekly
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round(100 - account.weekly.usedPercent),
            ),
          )
        : null
      const weeklyExhausted =
        weeklyRemaining !== null && weeklyRemaining <= 0

      const kind: NextResetCandidate["kind"] = weeklyExhausted
        ? "weekly"
        : "fiveHour"
      const resetsAt = weeklyExhausted
        ? account.weekly?.resetsAt ?? null
        : account.fiveHour?.resetsAt ?? null

      if (!resetsAt || resetsAt <= nowSeconds) {
        return current
      }

      if (!current || resetsAt < current.resetsAt) {
        return { account, kind, resetsAt }
      }

      return current
    },
    null,
  )

  useEffect(() => {
    if (notificationSettings?.resetNotificationsEnabled !== true) {
      pendingResetRef.current = null
      return
    }

    const pending = pendingResetRef.current

    if (pending && nowSeconds >= pending.resetsAt) {
      const key = resetEventKey(pending)

      pendingResetRef.current = null

      if (!notifiedResetKeysRef.current.has(key)) {
        notifiedResetKeysRef.current.add(key)

        const bodyKey =
          pending.kind === "weekly"
            ? "notifications.weeklyResetBody"
            : "notifications.fiveHourResetBody"

        void showSystemNotification(
          t("notifications.resetTitle"),
          t(bodyKey, { account: pending.account.label }),
        ).catch(() => undefined)
      }
    }

    if (nextReset && nextReset.resetsAt > nowSeconds) {
      const key = resetEventKey(nextReset)

      if (!notifiedResetKeysRef.current.has(key)) {
        pendingResetRef.current = nextReset
      }
    } else if (
      pendingResetRef.current &&
      pendingResetRef.current.resetsAt > nowSeconds
    ) {
      pendingResetRef.current = null
    }
  }, [
    nextReset?.account.id,
    nextReset?.account.label,
    nextReset?.kind,
    nextReset?.resetsAt,
    notificationSettings?.resetNotificationsEnabled,
    nowSeconds,
    t,
  ])

  const nextResetTime = formatResetTime(
    nextReset?.resetsAt ?? null,
    locale,
  )

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-3">
        <header className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {!isLoading ? (
                <span className="text-sm font-semibold text-foreground">
                  {accountCountLabel}
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <AddAccountDialog
                  onAdd={addAccount}
                  disabled={isLoading}
              />

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-sm"
                onClick={() => openSettings()}
                disabled={isLoading}
              >
                <Settings2 className="size-3.5" />
                {t("app.settings")}
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-sm"
                onClick={() => void refresh()}
                disabled={isLoading || isRefreshing}
              >
                <RefreshCw
                  className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                />
                {isRefreshing ? t("app.refreshing") : t("app.refresh")}
              </Button>
            </div>
          </div>

          <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">{t("app.nextReset")}</span>

              {nextReset && nextResetTime ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className="max-w-36 truncate font-medium text-foreground"
                    title={nextReset.account.label}
                  >
                    {nextReset.account.label}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0 font-semibold tabular-nums text-[#ce00ff]">
                    {nextResetTime}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t("app.nextResetUnavailable")}</span>
                </>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span>{pollingLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{updatedLabel}</span>
            </div>
          </div>
        </header>

        {networkError ? (
          <div className="mb-2.5 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                {t("app.networkErrorTitle")}
              </p>
              <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-400/80">
                {t("app.networkErrorDescription")}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-sm"
                onClick={() => openSettings("proxy")}
              >
                {t("app.settings")}
              </Button>

              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-sm"
                disabled={isRefreshing}
                onClick={() => void refresh()}
              >
                {t("app.retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            className={
              isNetworkOrProxyErrorMessage(error)
                ? "mb-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-400"
                : "mb-2.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            }
          >
            {localizeErrorMessage(error, t)}
          </div>
        ) : null}

        <section className="space-y-2">
          {isLoading ? (
            <AccountCard.Skeleton />
          ) : accounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-background/40 px-4 py-8 text-center">
              <p className="text-sm font-medium">
                {t("app.noAccounts")}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t("app.noAccountsDescription")}
              </p>
            </div>
          ) : (
            accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                highlightNextReset={
                  nextReset && account.id === nextReset.account.id
                    ? nextReset.kind
                    : null
                }
                onSwitch={handleSwitchAccount}
                onRename={renameAccount}
                onStartReauthentication={startReauthentication}
                onPollReauthentication={pollReauthentication}
                onCancelReauthentication={cancelReauthentication}
                onDelete={deleteAccount}
              />
            ))
          )}
        </section>

        <SettingsDialog
          open={settingsOpen}
          initialTab={settingsTab}
          onOpenChange={setSettingsOpen}
          onProxySaved={async () => {
            await refresh()
          }}
          onRefreshSaved={updateRefreshSettings}
          onNotificationSaved={setNotificationSettings}
        />
      </div>
    </main>
  )
}
