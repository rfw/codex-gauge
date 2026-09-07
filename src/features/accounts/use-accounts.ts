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

function mergeUsage(
  previous: CodexAccount,
  incoming: CodexAccount,
): CodexAccount {
  if (!incoming.usageError) {
    return incoming
  }

  return {
    ...incoming,
    fiveHour: incoming.fiveHour ?? previous.fiveHour,
    weekly: incoming.weekly ?? previous.weekly,
    credits: incoming.credits ?? previous.credits,
    bankedResets: incoming.bankedResets ?? previous.bankedResets,
  }
}

function mergeAuthoritativeAccounts(
  previous: CodexAccount[],
  incoming: CodexAccount[],
  pendingLabels: ReadonlyMap<string, string>,
) {
  const previousById = new Map(
    previous.map((account) => [account.id, account]),
  )

  return incoming.map((account) => {
    const old = previousById.get(account.id)
    const merged = old ? mergeUsage(old, account) : account
    const pendingLabel = pendingLabels.get(account.id)

    return pendingLabel === undefined
      ? merged
      : { ...merged, label: pendingLabel }
  })
}

/**
 * A refresh that started before an account metadata mutation completed is stale.
 * It may still contain useful usage values, but it must not overwrite account
 * membership, labels, active state, email, or plan with an older snapshot.
 */
function mergeStaleRefreshUsage(
  previous: CodexAccount[],
  incoming: CodexAccount[],
) {
  const incomingById = new Map(
    incoming.map((account) => [account.id, account]),
  )

  return previous.map((account) => {
    const refreshed = incomingById.get(account.id)

    if (!refreshed) {
      return account
    }

    const usage = mergeUsage(account, refreshed)

    return {
      ...account,
      fiveHour: usage.fiveHour,
      weekly: usage.weekly,
      credits: usage.credits,
      bankedResets: usage.bankedResets,
      usageError: usage.usageError,
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
  const metadataRevisionRef = useRef(0)
  const pendingLabelsRef = useRef(new Map<string, string>())

  const beginMetadataMutation = useCallback(() => {
    metadataRevisionRef.current += 1
  }, [])

  const completeMetadataMutation = useCallback(() => {
    metadataRevisionRef.current += 1
  }, [])

  const applySnapshot = useCallback((snapshot: AccountsSnapshot) => {
    setAccounts((previous) =>
      mergeAuthoritativeAccounts(
        previous,
        snapshot.accounts,
        pendingLabelsRef.current,
      ),
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

  const applyRefreshSnapshot = useCallback(
    (snapshot: AccountsSnapshot, startedMetadataRevision: number) => {
      const isMetadataStale =
        startedMetadataRevision !== metadataRevisionRef.current

      if (isMetadataStale) {
        setAccounts((previous) =>
          mergeStaleRefreshUsage(previous, snapshot.accounts),
        )
      } else {
        setAccounts((previous) =>
          mergeAuthoritativeAccounts(
            previous,
            snapshot.accounts,
            pendingLabelsRef.current,
          ),
        )
      }

      const hasNetworkError = snapshotHasNetworkError(snapshot)

      if (hasNetworkError) {
        setAutoRefreshPaused(true)
      } else {
        setAutoRefreshPaused(false)
        setLastUpdatedAt(snapshot.fetchedAt)
      }

      setError(null)
    },
    [],
  )

  const runRefresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current
    }

    const startedMetadataRevision = metadataRevisionRef.current

    const request = (async () => {
      setIsRefreshing(true)

      try {
        const snapshot = await getAccounts()
        applyRefreshSnapshot(snapshot, startedMetadataRevision)
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
  }, [applyRefreshSnapshot])

  const refresh = useCallback(async () => {
    // Manual refresh restarts the polling interval from this moment.
    setRefreshCycle((cycle) => cycle + 1)
    setAutoRefreshPaused(false)
    await runRefresh()
  }, [runRefresh])

  const switchAccount = useCallback(async (accountId: string) => {
    setError(null)
    beginMetadataMutation()

    try {
      const snapshot = await setActiveAccount(accountId)
      completeMetadataMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeMetadataMutation()

      const message =
        typeof cause === "string"
          ? cause
          : cause instanceof Error
            ? cause.message
            : "Unable to switch Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginMetadataMutation, completeMetadataMutation])

  const renameAccount = useCallback(
    async (accountId: string, label: string) => {
      const normalizedLabel = label.trim()
      const previousLabel =
        accounts.find((account) => account.id === accountId)?.label ?? null

      setError(null)
      beginMetadataMutation()
      pendingLabelsRef.current.set(accountId, normalizedLabel)

      // Optimistic update: keep the requested label visible while the Rust
      // command runs. Any refresh snapshot that arrives during this mutation
      // is prevented from restoring an older label.
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

        // Advance the revision before applying the authoritative mutation
        // result so every refresh started before/during the rename is stale.
        completeMetadataMutation()
        applySnapshot(snapshot)
        pendingLabelsRef.current.delete(accountId)
      } catch (cause) {
        completeMetadataMutation()
        pendingLabelsRef.current.delete(accountId)

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
    [accounts, applySnapshot, beginMetadataMutation, completeMetadataMutation],
  )

  const addAccount = useCallback(async () => {
    setError(null)
    beginMetadataMutation()

    try {
      const snapshot = await addCodexAccount()
      completeMetadataMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeMetadataMutation()

      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to add Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginMetadataMutation, completeMetadataMutation])

  const deleteAccount = useCallback(async (accountId: string) => {
    setError(null)
    beginMetadataMutation()

    try {
      const snapshot = await deleteCodexAccount(accountId)
      completeMetadataMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeMetadataMutation()

      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to delete Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginMetadataMutation, completeMetadataMutation])

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
