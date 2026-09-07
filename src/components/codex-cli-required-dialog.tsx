import { useState } from "react"
import { ExternalLink } from "lucide-react"

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
import {
  closeCodexGauge,
  openCodexInstallGuide,
} from "@/lib/runtime-service"

export function CodexCliRequiredDialog() {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [isOpening, setIsOpening] = useState(false)

  async function handleOpenGuide() {
    setIsOpening(true)
    setError(null)

    try {
      await openCodexInstallGuide()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("cli.openGuideError"),
      )
    } finally {
      setIsOpening(false)
    }
  }

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("cli.title")}
          </AlertDialogTitle>

          <AlertDialogDescription>
            {t("cli.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void closeCodexGauge()}
          >
            {t("common.close")}
          </Button>

          <Button
            type="button"
            disabled={isOpening}
            onClick={() => void handleOpenGuide()}
          >
            <ExternalLink className="size-4" />
            {isOpening ? t("cli.opening") : t("cli.openGuide")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
