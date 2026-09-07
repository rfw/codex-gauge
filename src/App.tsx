import { useEffect, useState, type ReactNode } from "react"
import { CircleCheckBig, RefreshCw, Settings2 } from "lucide-react"

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
import { useAccounts } from "@/features/accounts/use-accounts"
import { useI18n } from "@/i18n"
import { localizeErrorMessage } from "@/i18n/errors"
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

function CodexGaugeApp() {
  const { locale, t } = useI18n()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [switchSuccessAccount, setSwitchSuccessAccount] = useState<string | null>(null)
  const [settingsTab, setSettingsTab] =
    useState<SettingsTab>("general")
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  )

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
    deleteAccount,
    updateRefreshSettings,
  } = useAccounts()

  function openSettings(tab: SettingsTab = "general") {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  useEffect(() => {
    if (!switchSuccessAccount) {
      return
    }

    const timeout = window.setTimeout(() => {
      setSwitchSuccessAccount(null)
    }, 2500)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [switchSuccessAccount])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000))
    }, 30_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  async function handleSwitchAccount(accountId: string) {
    const accountLabel = accounts.find((account) => account.id === accountId)?.label

    await switchAccount(accountId)

    if (accountLabel) {
      setSwitchSuccessAccount(accountLabel)
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

  type NextResetCandidate = {
    account: CodexAccount
    kind: "fiveHour" | "weekly"
    resetsAt: number
  }

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

              <AddAccountDialog
                onAdd={addAccount}
                disabled={isLoading}
              />

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
          <div className="mb-2.5 flex items-center justify-between gap-3 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t("app.networkErrorTitle")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
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
          <div className="mb-2.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
                onDelete={deleteAccount}
              />
            ))
          )}
        </section>

        {switchSuccessAccount ? (
          <div
            role="status"
            aria-live="polite"
            className="fixed left-1/2 top-12 z-50 flex max-w-[320px] -translate-x-1/2 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
          >
            <CircleCheckBig className="size-4 shrink-0 text-emerald-500" />
            <span>
              {t("account.switchSuccess", {
                account: switchSuccessAccount,
              })}
            </span>
          </div>
        ) : null}

        <SettingsDialog
          open={settingsOpen}
          initialTab={settingsTab}
          onOpenChange={setSettingsOpen}
          onProxySaved={async () => {
            await refresh()
          }}
          onRefreshSaved={updateRefreshSettings}
        />
      </div>
    </main>
  )
}
