export type QuotaWindow = {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number | null
}

export type CreditBalance = {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export type BankedReset = {
  id: string
  label?: string | null
  details?: string | null
  expiresAt: number | null
}

export type BankedResets = {
  availableCount: number
  items: BankedReset[]
}

export type CodexAccount = {
  id: string
  label: string
  email?: string | null
  plan: string
  isActive: boolean
  fiveHour: QuotaWindow | null
  weekly: QuotaWindow | null
  credits: CreditBalance | null
  bankedResets: BankedResets | null
  usageError?: string | null
}

export type AccountsSnapshot = {
  accounts: CodexAccount[]
  fetchedAt: number
}
