import { Progress } from "@/components/ui/progress"
import type { QuotaWindow } from "@/features/accounts/types"
import { useI18n } from "@/i18n"
import { localizeErrorMessage } from "@/i18n/errors"
import { formatResetTime } from "@/lib/format"

type QuotaRowProps = {
  label: string
  quota: QuotaWindow | null
  unavailableReason?: string | null
  highlightReset?: boolean
}

export function QuotaRow({
  label,
  quota,
  unavailableReason,
  highlightReset = false,
}: QuotaRowProps) {
  const { locale, t } = useI18n()

  if (!quota) {
    const reason = unavailableReason
      ? localizeErrorMessage(unavailableReason, t)
      : t("quota.notProvided")

    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-muted-foreground">
            {label}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("quota.unavailable")}
          </span>
        </div>

        <Progress value={0} className="mt-2 h-1.5 opacity-35" />

        <p
          className="mt-1.5 truncate text-xs text-muted-foreground"
          title={
            unavailableReason
              ? reason
              : t("quota.notProvidedTitle")
          }
        >
          {reason}
        </p>
      </div>
    )
  }

  const remaining = Math.max(
    0,
    Math.min(100, Math.round(100 - quota.usedPercent)),
  )
  const reset = formatResetTime(quota.resetsAt, locale)


  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {t("quota.left", { percent: remaining })}
        </span>
      </div>

      <Progress value={remaining} className="mt-2 h-1.5" />

      <p
        className={
          highlightReset && reset
            ? "mt-1.5 text-xs font-medium text-[#ce00ff]"
            : "mt-1.5 text-xs text-muted-foreground"
        }
      >
        {reset
          ? t("quota.resetTime", {
              time: reset,
            })
          : t("quota.resetUnavailable")}
      </p>
    </div>
  )
}
