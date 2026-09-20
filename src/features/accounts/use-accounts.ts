import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { listen } from "@tauri-apps/api/event"

import {
  addCodexAccount,
  cancelReauthenticateCodexAccount,
  deleteCodexAccount,
  getAccounts,
  pollReauthenticateCodexAccount,
  renameCodexAccount,
  setActiveAccount,
  startReauthenticateCodexAccount,
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

function isNetworkUsageError(account: CodexAccount) {
  return account.usageErrorKind === "network"
}

function mergeUsage(
  previous: CodexAccount,
  incoming: CodexAccount,
): CodexAccount {
  if (!incoming.usageError) {
    return incoming
  }

  // Authentication/CLI failures are authoritative: keeping old quota values
  // would make an invalid account look current (for example, showing a stale
  // 4% after the stored credential has been revoked). Preserve last-known
  // usage only for transient service/transport failures.
  const preservePreviousUsage =
    incoming.usageErrorKind === "network" ||
    incoming.usageErrorKind === "timeout" ||
    incoming.usageErrorKind === "appServer" ||
    incoming.usageErrorKind === "unknown"

  if (!preservePreviousUsage) {
    return incoming
  }

  return {
    ...incoming,
    plan: incoming.planType ? incoming.plan : previous.plan,
    fiveHour: incoming.fiveHour ?? previous.fiveHour,
    weekly: incoming.weekly ?? previous.weekly,
    credits: incoming.credits ?? previous.credits,
    bankedResets: incoming.bankedResets ?? previous.bankedResets,
    planType: incoming.planType ?? previous.planType,
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
 * It may still contain useful usage values, including the current Codex plan
 * reported by rateLimits/read, but it must not overwrite account membership,
 * labels, active state, or email with an older snapshot.
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
      plan: usage.plan,
      planType: usage.planType,
      credits: usage.credits,
      bankedResets: usage.bankedResets,
      usageErrorKind: usage.usageErrorKind,
      usageError: usage.usageError,
    }
  })
}

function snapshotHasGlobalNetworkError(snapshot: AccountsSnapshot) {
  return (
    snapshot.accounts.length > 0 &&
    snapshot.accounts.every((account) =>
      isNetworkUsageError(account),
    )
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
  const usageRevisionRef = useRef(0)
  const pendingLabelsRef = useRef(new Map<string, string>())

  const beginMetadataMutation = useCallback(() => {
    metadataRevisionRef.current += 1
  }, [])

  const completeMetadataMutation = useCallback(() => {
    metadataRevisionRef.current += 1
  }, [])

  const beginUsageMutation = useCallback(() => {
    metadataRevisionRef.current += 1
    usageRevisionRef.current += 1
  }, [])

  const completeUsageMutation = useCallback(() => {
    metadataRevisionRef.current += 1
    usageRevisionRef.current += 1
  }, [])

  const applySnapshot = useCallback((snapshot: AccountsSnapshot) => {
    setAccounts((previous) =>
      mergeAuthoritativeAccounts(
        previous,
        snapshot.accounts,
        pendingLabelsRef.current,
      ),
    )

    const hasGlobalNetworkError =
      snapshotHasGlobalNetworkError(snapshot)

    if (hasGlobalNetworkError) {
      setAutoRefreshPaused(true)
    } else {
      setAutoRefreshPaused(false)
      setLastUpdatedAt(snapshot.fetchedAt)
    }

    setError(null)
  }, [])

  const applyRefreshSnapshot = useCallback(
    (
      snapshot: AccountsSnapshot,
      startedMetadataRevision: number,
      startedUsageRevision: number,
    ) => {
      const isUsageStale =
        startedUsageRevision !== usageRevisionRef.current

      // Account switching, add/delete, and reauthentication can change which
      // credential a usage request represents. Never let a refresh that began
      // before or during one of those mutations overwrite the authoritative
      // snapshot returned by the mutation itself.
      if (isUsageStale) {
        return
      }

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

      const hasGlobalNetworkError =
        snapshotHasGlobalNetworkError(snapshot)

      if (hasGlobalNetworkError) {
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
    const startedUsageRevision = usageRevisionRef.current

    const request = (async () => {
      setIsRefreshing(true)

      try {
        const snapshot = await getAccounts()
        applyRefreshSnapshot(
          snapshot,
          startedMetadataRevision,
          startedUsageRevision,
        )
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
    beginUsageMutation()

    try {
      const snapshot = await setActiveAccount(accountId)
      completeUsageMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeUsageMutation()

      const message =
        typeof cause === "string"
          ? cause
          : cause instanceof Error
            ? cause.message
            : "Unable to switch Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginUsageMutation, completeUsageMutation])

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
    beginUsageMutation()

    try {
      const snapshot = await addCodexAccount()
      completeUsageMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeUsageMutation()

      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to add Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginUsageMutation, completeUsageMutation])

  const startReauthentication = useCallback(async (accountId: string) => {
    return startReauthenticateCodexAccount(accountId)
  }, [])

  const pollReauthentication = useCallback(async (sessionId: string) => {
    const response = await pollReauthenticateCodexAccount(sessionId)

    if (response.status === "succeeded" && response.snapshot) {
      // Make every usage request that started before sign-in completion stale
      // before applying the authoritative post-login snapshot.
      beginUsageMutation()
      completeUsageMutation()
      applySnapshot(response.snapshot)
    }

    return response
  }, [applySnapshot, beginUsageMutation, completeUsageMutation])

  const cancelReauthentication = useCallback(async (sessionId: string) => {
    await cancelReauthenticateCodexAccount(sessionId)
  }, [])

  const deleteAccount = useCallback(async (accountId: string) => {
    setError(null)
    beginUsageMutation()

    try {
      const snapshot = await deleteCodexAccount(accountId)
      completeUsageMutation()
      applySnapshot(snapshot)
    } catch (cause) {
      completeUsageMutation()

      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to delete Codex account."

      setError(message)
      throw cause
    }
  }, [applySnapshot, beginUsageMutation, completeUsageMutation])

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

  const networkError =
    accounts.length > 0 &&
    accounts.every((account) => isNetworkUsageError(account))
      ? accounts.find((account) => account.usageError)?.usageError ?? null
      : null

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
    startReauthentication,
    pollReauthentication,
    cancelReauthentication,
    deleteAccount,
    updateRefreshSettings,
  }
}
