import { useEffect, useRef, useState } from "react"
import { LucideBadgeCheck, LoaderCircle, Trash2 } from "lucide-react"

import { BankedResetList } from "@/components/banked-reset-list"
import { QuotaRow } from "@/components/quota-row"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { CodexAccount } from "@/features/accounts/types"
import { useI18n } from "@/i18n"

type AccountCardProps = {
  account: CodexAccount
  highlightNextReset?: boolean
  onSwitch: (accountId: string) => Promise<void>
  onRename: (accountId: string, label: string) => Promise<void>
  onDelete: (accountId: string) => Promise<void>
}

function AccountCardComponent({
  account,
  highlightNextReset = false,
  onSwitch,
  onRename,
  onDelete,
}: AccountCardProps) {
  const { t } = useI18n()
  const [isEditing, setIsEditing] = useState(false)
  const [draftLabel, setDraftLabel] = useState(account.label)
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isEditing) {
      setDraftLabel(account.label)
    }
  }, [account.label, isEditing])

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  async function commitRename() {
    const nextLabel = draftLabel.trim()

    setIsEditing(false)

    if (!nextLabel || nextLabel === account.label) {
      setDraftLabel(account.label)
      return
    }

    await onRename(account.id, nextLabel)
  }

  function cancelRename() {
    setDraftLabel(account.label)
    setIsEditing(false)
  }

  async function confirmSwitch() {
    setIsSwitching(true)

    try {
      await onSwitch(account.id)
    } finally {
      setIsSwitching(false)
    }
  }

  async function confirmDelete() {
    setIsDeleting(true)

    try {
      await onDelete(account.id)
      setDeleteConfirmOpen(false)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <Card
        className={
          account.isActive
            ? "rounded-md border-foreground/15 bg-card py-0 shadow-sm"
            : "rounded-md border-border/80 bg-card/95 py-0 shadow-none"
        }
      >
        <CardContent className="px-4 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-h-7 min-w-0 items-center gap-1.5">
                {isEditing ? (
                  <Input
                    ref={inputRef}
                    value={draftLabel}
                    maxLength={40}
                    className="h-7 w-44 px-2 text-sm font-semibold"
                    aria-label={t("account.nameAria")}
                    onChange={(event) => setDraftLabel(event.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void commitRename()
                      }

                      if (event.key === "Escape") {
                        event.preventDefault()
                        cancelRename()
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="max-w-52 cursor-text truncate rounded-sm text-left text-sm font-semibold outline-none transition-colors hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/50"
                    title={t("account.clickToRename")}
                    onClick={() => setIsEditing(true)}
                  >
                    {account.label}
                  </button>
                )}

                {account.isActive ? (
                  <TooltipProvider delay={250}>
                    <Tooltip>
                      <TooltipTrigger
                        type="button"
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 outline-none transition-colors hover:bg-emerald-500/15 focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                        aria-label={t("account.currentAria")}
                      >
                        <LucideBadgeCheck className="size-3.5" />
                      </TooltipTrigger>

                      <TooltipContent side="top">
                        {t("account.current")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
              </div>

              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <span>{account.plan}</span>

                {account.email ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{account.email}</span>
                  </>
                ) : null}
              </div>
            </div>

            {!account.isActive ? (
              <div className="-mr-1 flex shrink-0 items-center gap-1">
                <TooltipProvider delay={250}>
                  <Tooltip>
                    <TooltipTrigger
                      type="button"
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label={t("account.deleteAria")}
                      onClick={() => setDeleteConfirmOpen(true)}
                    >
                      <Trash2 className="size-3.5" />
                    </TooltipTrigger>

                    <TooltipContent side="top">
                      {t("account.delete")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-sm"
                  disabled={isSwitching}
                  onClick={() => setSwitchConfirmOpen(true)}
                >
                  {isSwitching ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : null}
                  {isSwitching
                    ? t("account.switching")
                    : t("account.switch")}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <QuotaRow
              label={t("quota.fiveHour")}
              quota={account.fiveHour}
              unavailableReason={account.usageError}
              highlightReset={highlightNextReset}
            />
            <QuotaRow
              label={t("quota.weekly")}
              quota={account.weekly}
              unavailableReason={account.usageError}
            />
          </div>

          {account.bankedResets &&
          account.bankedResets.availableCount > 0 ? (
            <div className="mt-2 border-t pt-2">
              <BankedResetList resets={account.bankedResets} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog
        open={switchConfirmOpen}
        onOpenChange={(open) => {
          if (!isSwitching) {
            setSwitchConfirmOpen(open)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("account.switchTitle", { account: account.label })}
            </AlertDialogTitle>

            <AlertDialogDescription>
              {t("account.switchDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSwitching}>
              {t("common.cancel")}
            </AlertDialogCancel>

            <AlertDialogAction
              disabled={isSwitching}
              onClick={(event) => {
                event.preventDefault()
                setSwitchConfirmOpen(false)
                void confirmSwitch()
              }}
            >
              {isSwitching
                ? t("account.switching")
                : t("account.switchAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!isDeleting) {
            setDeleteConfirmOpen(open)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("account.deleteTitle", { account: account.label })}
            </AlertDialogTitle>

            <AlertDialogDescription>
              {t("account.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("common.cancel")}
            </AlertDialogCancel>

            <AlertDialogAction
              disabled={isDeleting}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {isDeleting ? t("account.deleting") : t("account.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AccountCardSkeleton() {
  return (
    <Card className="rounded-md py-0 shadow-none">
      <CardContent className="px-4 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-1.5 h-3 w-40" />
          </div>

          <Skeleton className="h-7 w-16" />
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="rounded-md border bg-muted/20 px-3 py-2"
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-1.5 w-full" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export const AccountCard = Object.assign(AccountCardComponent, {
  Skeleton: AccountCardSkeleton,
})
