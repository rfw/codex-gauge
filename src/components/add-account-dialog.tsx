import { useState } from "react"
import { ExternalLink, Loader2, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useI18n } from "@/i18n"

type AddAccountDialogProps = {
  onAdd: () => Promise<void>
  disabled?: boolean
}

export function AddAccountDialog({
  onAdd,
  disabled = false,
}: AddAccountDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)

  async function handleAdd() {
    setIsAdding(true)

    try {
      await onAdd()
      setOpen(false)
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isAdding && !disabled) {
          setOpen(nextOpen)
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-sm"
            disabled={disabled}
          />
        }
      >
        <Plus className="size-3.5" />
        {t("add.trigger")}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>

          <DialogDescription>
            {t("add.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          {t("add.notice")}
        </div>

        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                disabled={isAdding}
              />
            }
          >
            {t("common.cancel")}
          </DialogClose>

          <Button
            type="button"
            disabled={isAdding}
            onClick={() => void handleAdd()}
          >
            {isAdding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}

            {isAdding ? t("add.waiting") : t("add.continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
