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
type UpdateInstallPhase = "idle" | "downloading" | "installing"
type UpdateInstallFailure = "download" | "install" | null

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
  const [installPhase, setInstallPhase] =
    useState<UpdateInstallPhase>("idle")
  const [installFailure, setInstallFailure] =
    useState<UpdateInstallFailure>(null)
  const [downloadedBytes, setDownloadedBytes] = useState(0)
  const [totalBytes, setTotalBytes] = useState<number | null>(null)
  const [result, setResult] = useState<UpdateCheckResult>("idle")
  const [error, setError] = useState<string | null>(null)
  const [availableUpdate, setAvailableUpdate] =
    useState<AppUpdateInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const resetInstallState = useCallback(() => {
    setInstallPhase("idle")
    setInstallFailure(null)
    setDownloadedBytes(0)
    setTotalBytes(null)
  }, [])

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
        resetInstallState()
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
  }, [resetInstallState])

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
    setInstallPhase("downloading")
    setInstallFailure(null)
    setDownloadedBytes(0)
    setTotalBytes(null)
    setError(null)

    let downloaded = 0
    let expectedTotal: number | null = null
    let downloadFinished = false

    try {
      await installAppUpdate((event) => {
        switch (event.event) {
          case "Started":
            expectedTotal = event.data.contentLength
            setTotalBytes(expectedTotal)
            break

          case "Progress":
            downloaded += event.data.chunkLength
            setDownloadedBytes(downloaded)
            break

          case "Finished":
            downloadFinished = true
            setInstallPhase("installing")
            if (expectedTotal !== null) {
              setDownloadedBytes(expectedTotal)
            }
            break
        }
      })
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : String(cause),
      )
      setInstallFailure(downloadFinished ? "install" : "download")
      setInstalling(false)
      setInstallPhase("idle")
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
      resetInstallState()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : String(cause),
      )
    }
  }, [availableUpdate, resetInstallState])

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
        installPhase={installPhase}
        installFailure={installFailure}
        downloadedBytes={downloadedBytes}
        totalBytes={totalBytes}
        error={error}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            resetInstallState()
            setError(null)
          }
        }}
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
