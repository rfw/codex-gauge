import { LoaderCircle } from "lucide-react"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useI18n } from "@/i18n"
import type { AppUpdateInfo } from "@/lib/update-service"

type UpdateInstallPhase = "idle" | "downloading" | "installing"
type UpdateInstallFailure = "download" | "install" | null

type UpdateDialogProps = {
  open: boolean
  update: AppUpdateInfo | null
  installing: boolean
  installPhase: UpdateInstallPhase
  installFailure: UpdateInstallFailure
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
  onOpenChange: (open: boolean) => void
  onInstall: () => void | Promise<void>
  onSkip: () => void | Promise<void>
}

function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"]
  let value = Math.max(0, bytes)
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 ? 0 : 1
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits,
  }).format(value)

  return `${formatted} ${units[unitIndex]}`
}

export function UpdateDialog({
  open,
  update,
  installing,
  installPhase,
  installFailure,
  downloadedBytes,
  totalBytes,
  error,
  onOpenChange,
  onInstall,
  onSkip,
}: UpdateDialogProps) {
  const { locale, t } = useI18n()

  if (!update) {
    return null
  }

  const progressPercent = totalBytes !== null && totalBytes > 0
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : null

  const progressDetail = totalBytes !== null && totalBytes > 0
    ? t("update.downloadSize", {
        downloaded: formatBytes(downloadedBytes, locale),
        total: formatBytes(totalBytes, locale),
      })
    : downloadedBytes > 0
      ? t("update.downloadedSize", {
          downloaded: formatBytes(downloadedBytes, locale),
        })
      : null

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!installing) {
          onOpenChange(nextOpen)
        }
      }}
    >
      <AlertDialogContent className="gap-4">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("update.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("update.description", {
              version: `v${update.version}`,
              current: `v${update.currentVersion}`,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {installing ? (
          <div className="space-y-2.5 rounded-md border bg-muted/20 px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">
                {installPhase === "installing"
                  ? t("update.installing")
                  : t("update.downloading")}
              </span>
              {progressPercent !== null ? (
                <span className="tabular-nums text-muted-foreground">
                  {progressPercent}%
                </span>
              ) : null}
            </div>

            <Progress
              value={installPhase === "installing" ? 100 : (progressPercent ?? 0)}
              aria-label={t("update.downloadProgress")}
            />

            {installPhase === "downloading" && progressDetail ? (
              <div className="text-xs tabular-nums text-muted-foreground">
                {progressDetail}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs leading-relaxed text-destructive">
            {installFailure === "download"
              ? t("update.downloadFailed")
              : t("update.installFailed")}
          </div>
        ) : null}

        <AlertDialogFooter className="sm:flex-wrap">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={installing}
            onClick={() => void onSkip()}
          >
            {t("update.skipVersion")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={installing}
            onClick={() => onOpenChange(false)}
          >
            {t("update.later")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={installing}
            onClick={() => void onInstall()}
          >
            {installing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : null}
            {installing
              ? installPhase === "installing"
                ? t("update.installing")
                : t("update.downloading")
              : error
                ? t("update.retry")
                : t("update.updateNow")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
