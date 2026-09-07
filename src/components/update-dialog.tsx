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
import { useI18n } from "@/i18n"
import type { AppUpdateInfo } from "@/lib/update-service"

type UpdateDialogProps = {
  open: boolean
  update: AppUpdateInfo | null
  installing: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onInstall: () => void | Promise<void>
  onSkip: () => void | Promise<void>
}

export function UpdateDialog({
  open,
  update,
  installing,
  error,
  onOpenChange,
  onInstall,
  onSkip,
}: UpdateDialogProps) {
  const { t } = useI18n()

  if (!update) {
    return null
  }

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

        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            {t("update.installFailed")}
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
              ? t("update.installing")
              : t("update.updateNow")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
