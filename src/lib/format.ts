import type { SupportedLocale } from "@/i18n/types"

export type ResetTimeParts = {
  absolute: string
  relative: string
  isToday: boolean
}

function isSameLocalDay(a: Date, b: Date) {
  return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
  )
}

function formatRelativeReset(
    resetsAt: number,
    locale: SupportedLocale,
): string {
  const remainingMs = Math.max(0, resetsAt * 1000 - Date.now())
  const totalMinutes = Math.floor(remainingMs / 60_000)

  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  })

  if (days > 0) {
    return formatter.format(days, "day")
  }

  if (hours > 0) {
    return formatter.format(hours, "hour")
  }

  if (minutes > 0) {
    return formatter.format(minutes, "minute")
  }

  return formatter.format(0, "second")
}

/**
 * Formats a quota reset timestamp using the active locale.
 *
 * Same local day:
 *   zh-CN → 23:08
 *   en-US → 11:08 PM
 *
 * Other day:
 *   zh-CN → 2026年9月11日 13:36
 *   en-US → September 11, 2026 at 1:36 PM
 */
export function formatResetTime(
    resetsAt: number | null,
    locale: SupportedLocale,
): string | null {
  if (!resetsAt) {
    return null
  }

  const resetDate = new Date(resetsAt * 1000)
  const now = new Date()

  if (isSameLocalDay(resetDate, now)) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(resetDate)
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetDate)
}

/**
 * Backward-compatible formatter for components that still consume
 * ResetTimeParts. New UI should prefer formatResetTime().
 */
export function formatResetTimeParts(
    resetsAt: number | null,
    locale: SupportedLocale,
): ResetTimeParts | null {
  if (!resetsAt) {
    return null
  }

  const resetDate = new Date(resetsAt * 1000)
  const now = new Date()
  const absolute = formatResetTime(resetsAt, locale)

  if (!absolute) {
    return null
  }

  return {
    absolute,
    relative: formatRelativeReset(resetsAt, locale),
    isToday: isSameLocalDay(resetDate, now),
  }
}

export function formatExpirationDate(
    unixSeconds: number | null,
    locale: SupportedLocale,
): string | null {
  if (!unixSeconds) {
    return null
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(unixSeconds * 1000))
}

export function formatExpirationShort(
    unixSeconds: number | null,
    locale: SupportedLocale,
): string | null {
  if (!unixSeconds) {
    return null
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(unixSeconds * 1000))
}


export function formatPollingInterval(
  intervalSeconds: number,
  locale: SupportedLocale,
): string {
  const normalizedSeconds = Math.max(1, Math.round(intervalSeconds))

  let value = normalizedSeconds
  let unit: "second" | "minute" | "hour" = "second"

  if (normalizedSeconds % 3600 === 0) {
    value = normalizedSeconds / 3600
    unit = "hour"
  } else if (normalizedSeconds % 60 === 0) {
    value = normalizedSeconds / 60
    unit = "minute"
  }

  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value)
}

export function formatClockTime(
    unixMillis: number | null,
    locale: SupportedLocale,
): string | null {
  if (!unixMillis) {
    return null
  }

  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unixMillis))
}