import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import { UpdateDialog } from "@/components/update-dialog"
import {
  getUpdateSettings,
  saveUpdateSettings,
} from "@/lib/settings-service"
import {
  checkForAppUpdate,
  installAppUpdate,
  type AppUpdateInfo,
} from "@/lib/update-service"

type UpdateCheckResult = "idle" | "upToDate" | "available" | "error"

type AppUpdateContextValue = {
  checking: boolean
  installing: boolean
  result: UpdateCheckResult
  error: string | null
  availableUpdate: AppUpdateInfo | null
  checkNow: () => Promise<AppUpdateInfo | null>
}

type AppUpdateProviderProps = {
  children: ReactNode
}

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null)
let automaticCheckStarted = false

export function AppUpdateProvider({ children }: AppUpdateProviderProps) {
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult>("idle")
  const [error, setError] = useState<string | null>(null)
  const [availableUpdate, setAvailableUpdate] =
    useState<AppUpdateInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const runCheck = useCallback(async (
    respectIgnoredVersion: boolean,
  ): Promise<AppUpdateInfo | null> => {
    setChecking(true)
    setError(null)

    try {
      const [update, preferences] = await Promise.all([
        checkForAppUpdate(),
        getUpdateSettings(),
      ])

      if (!update) {
        setAvailableUpdate(null)
        setResult("upToDate")
        return null
      }

      setAvailableUpdate(update)
      setResult("available")

      const ignored = preferences.ignoredVersion === update.version
      if (!respectIgnoredVersion || !ignored) {
        setDialogOpen(true)
      }

      return update
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : String(cause)
      setError(message)
      setResult("error")
      throw cause
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (automaticCheckStarted) {
      return
    }

    automaticCheckStarted = true

    void runCheck(true).catch(() => {
      // Startup update checks are intentionally silent. Manual checks surface errors.
    })
  }, [runCheck])

  const checkNow = useCallback(async () => {
    return runCheck(false)
  }, [runCheck])

  const install = useCallback(async () => {
    setInstalling(true)
    setError(null)

    try {
      await installAppUpdate()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : String(cause),
      )
      setInstalling(false)
    }
  }, [])

  const skip = useCallback(async () => {
    if (!availableUpdate) {
      setDialogOpen(false)
      return
    }

    setError(null)

    try {
      await saveUpdateSettings({
        ignoredVersion: availableUpdate.version,
      })
      setDialogOpen(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : String(cause),
      )
    }
  }, [availableUpdate])

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      checking,
      installing,
      result,
      error,
      availableUpdate,
      checkNow,
    }),
    [availableUpdate, checkNow, checking, error, installing, result],
  )

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <UpdateDialog
        open={dialogOpen}
        update={availableUpdate}
        installing={installing}
        error={error}
        onOpenChange={setDialogOpen}
        onInstall={install}
        onSkip={skip}
      />
    </AppUpdateContext.Provider>
  )
}

export function useAppUpdate(): AppUpdateContextValue {
  const context = useContext(AppUpdateContext)

  if (!context) {
    throw new Error("useAppUpdate must be used inside AppUpdateProvider")
  }

  return context
}
