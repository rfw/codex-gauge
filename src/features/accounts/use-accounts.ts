import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { listen } from "@tauri-apps/api/event"

import {
  addCodexAccount,
  deleteCodexAccount,
  getAccounts,
  renameCodexAccount,
  setActiveAccount,
} from "@/features/accounts/account-service"
import type {
  AccountsSnapshot,
  CodexAccount,
} from "@/features/accounts/types"
import {
  getRefreshSettings,
  type RefreshSettings,
} from "@/lib/settings-service"

const DEFAULT_REFRESH_SETTINGS: RefreshSettings = {
  enabled: true,
  intervalSeconds: 60,
}

function isNetworkUsageError(message?: string | null) {
  return Boolean(
    message?.includes("Unable to reach ChatGPT"),
  )
}

function mergeAccountsPreservingUsage(
  previous: CodexAccount[],
  incoming: CodexAccount[],
) {
  const previousById = new Map(
    previous.map((account) => [account.id, account]),
  )

  return incoming.map((account) => {
    const old = previousById.get(account.id)

    if (!old || !account.usageError) {
      return account
    }

    return {
      ...account,
      fiveHour: account.fiveHour ?? old.fiveHour,
      weekly: account.weekly ?? old.weekly,
      bankedResets: account.bankedResets ?? old.bankedResets,
    }
  })
}

function snapshotHasNetworkError(snapshot: AccountsSnapshot) {
  return snapshot.accounts.some((account) =>
    isNetworkUsageError(account.usageError),
  )
}

export function useAccounts() {
  const [accounts, setAccounts] = useState<CodexAccount[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [refreshSettings, setRefreshSettings] =
    useState<RefreshSettings>(DEFAULT_REFRESH_SETTINGS)
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false)
  const [refreshCycle, setRefreshCycle] = useState(0)

  const refreshPromiseRef = useRef<Promise<void> | null>(null)

  const applySnapshot = useCallback((snapshot: AccountsSnapshot) => {
    setAccounts((previous) =>
      mergeAccountsPreservingUsage(previous, snapshot.accounts),
    )

    const hasNetworkError = snapshotHasNetworkError(snapshot)

    if (hasNetworkError) {
      setAutoRefreshPaused(true)
    } else {
      setAutoRefreshPaused(false)
      setLastUpdatedAt(snapshot.fetchedAt)
    }

    setError(null)
  }, [])

  const runRefresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current
    }

    const request = (async () => {
      setIsRefreshing(true)

      try {
        const snapshot = await getAccounts()
        applySnapshot(snapshot)
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to refresh Codex usage.",
        )
      } finally {
        setIsRefreshing(false)
        setIsLoading(false)
      }
    })()

    refreshPromiseRef.current = request

    try {
      await request
    } finally {
      if (refreshPromiseRef.current === request) {
        refreshPromiseRef.current = null
      }
    }
  }, [applySnapshot])

  const refresh = useCallback(async () => {
    // Manual refresh restarts the polling interval from this moment.
    setRefreshCycle((cycle) => cycle + 1)
    setAutoRefreshPaused(false)
    await runRefresh()
  }, [runRefresh])

  const switchAccount = useCallback(async (accountId: string) => {
    setError(null)

    try {
      const snapshot = await setActiveAccount(accountId)
      applySnapshot(snapshot)
    } catch (cause) {
      const message =
        typeof cause === "string"
          ? cause
          : cause instanceof Error
            ? cause.message
            : "Unable to switch Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot])

  const renameAccount = useCallback(
    async (accountId: string, label: string) => {
      const normalizedLabel = label.trim()
      const previousLabel =
        accounts.find((account) => account.id === accountId)?.label ?? null

      setError(null)

      // Optimistic update: reflect the new label immediately instead of
      // waiting for the Rust command to return a full accounts snapshot.
      setAccounts((previous) =>
        previous.map((account) =>
          account.id === accountId
            ? { ...account, label: normalizedLabel }
            : account,
        ),
      )

      try {
        const snapshot = await renameCodexAccount(
          accountId,
          normalizedLabel,
        )
        applySnapshot(snapshot)
      } catch (cause) {
        if (previousLabel !== null) {
          setAccounts((previous) =>
            previous.map((account) =>
              account.id === accountId
                ? { ...account, label: previousLabel }
                : account,
            ),
          )
        }

        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to rename Codex account.",
        )

        throw cause
      }
    },
    [accounts, applySnapshot],
  )

  const addAccount = useCallback(async () => {
    setError(null)

    try {
      const snapshot = await addCodexAccount()
      applySnapshot(snapshot)
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to add Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot])

  const deleteAccount = useCallback(async (accountId: string) => {
    setError(null)

    try {
      const snapshot = await deleteCodexAccount(accountId)
      applySnapshot(snapshot)
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to delete Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot])

  const updateRefreshSettings = useCallback(
    async (settings: RefreshSettings) => {
      setRefreshSettings(settings)

      if (!settings.enabled) {
        setAutoRefreshPaused(false)
      }
    },
    [],
  )

  useEffect(() => {
    let disposed = false

    void getRefreshSettings()
      .then((settings) => {
        if (!disposed) {
          setRefreshSettings(settings)
        }
      })
      .catch(() => {
        if (!disposed) {
          setRefreshSettings(DEFAULT_REFRESH_SETTINGS)
        }
      })

    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    void runRefresh()
  }, [runRefresh])

  useEffect(() => {
    if (!refreshSettings.enabled || autoRefreshPaused) {
      return
    }

    const intervalMs = Math.max(
      15,
      refreshSettings.intervalSeconds,
    ) * 1000

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void runRefresh()
      }
    }, intervalMs)

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        !autoRefreshPaused
      ) {
        void runRefresh()
      }
    }

    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    )

    return () => {
      window.clearInterval(interval)
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      )
    }
  }, [
    autoRefreshPaused,
    refreshCycle,
    refreshSettings.enabled,
    refreshSettings.intervalSeconds,
    runRefresh,
  ])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void listen("codex-accounts-changed", () => {
      void runRefresh()
    }).then((dispose) => {
      if (disposed) {
        dispose()
      } else {
        unlisten = dispose
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [runRefresh])

  const networkError = accounts
    .map((account) => account.usageError)
    .find((message) => isNetworkUsageError(message)) ?? null

  return {
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
  }
}
