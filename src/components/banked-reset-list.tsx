import { useMemo, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import type { BankedResets } from "@/features/accounts/types"
import { useI18n } from "@/i18n"
import {
  formatExpirationDate,
  formatExpirationShort,
} from "@/lib/format"

type BankedResetListProps = {
  resets: BankedResets
}

function getNextExpiration(resets: BankedResets) {
  const timestamps = resets.items
    .map((reset) => reset.expiresAt)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)

  return timestamps[0] ?? null
}

export function BankedResetList({
  resets,
}: BankedResetListProps) {
  const { locale, t } = useI18n()
  const [isExpanded, setIsExpanded] = useState(false)

  const nextExpiration = useMemo(
    () => getNextExpiration(resets),
    [resets],
  )

  const nextExpirationLabel = formatExpirationShort(
    nextExpiration,
    locale,
  )

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((value) => !value)}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium">
            {t("banked.title")}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("banked.availableCount", {
              count: resets.availableCount,
            })}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {nextExpirationLabel ? (
            <span>
              {t("banked.nextExpiry", {
                date: nextExpirationLabel,
              })}
            </span>
          ) : (
            <span>{t("banked.expiryUnavailable")}</span>
          )}

          {isExpanded ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </div>
      </button>

      {isExpanded ? (
        <div className="mt-2 overflow-hidden rounded-md border bg-muted/10">
          {resets.items.length > 0 ? (
            <>
              <div className="divide-y">
                {resets.items.map((reset, index) => (
                  <div
                    key={reset.id}
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {reset.label?.trim() ||
                          t("banked.resetFallback", {
                            index: index + 1,
                          })}
                      </p>

                      {reset.details?.trim() ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {reset.details}
                        </p>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t("banked.expires")}
                      </p>
                      <p className="mt-0.5 text-sm font-medium tabular-nums">
                        {formatExpirationDate(reset.expiresAt, locale) ??
                          t("common.unknown")}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {resets.items.length < resets.availableCount ? (
                <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                  {t("banked.showing", {
                    shown: resets.items.length,
                    total: resets.availableCount,
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t(
                resets.availableCount === 1
                  ? "banked.availableOne"
                  : "banked.availableMany",
                { count: resets.availableCount },
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
