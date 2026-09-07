import type { AccountsSnapshot } from "@/features/accounts/types"

const now = Math.floor(Date.now() / 1000)
const day = 24 * 60 * 60

export const mockAccountsSnapshot: AccountsSnapshot = {
  fetchedAt: Date.now(),
  accounts: [
    {
      id: "personal",
      label: "Personal",
      email: "personal@example.com",
      plan: "ChatGPT Plus",
      isActive: true,
      fiveHour: {
        usedPercent: 23,
        windowDurationMins: 300,
        resetsAt: now + 2 * 60 * 60 + 18 * 60,
      },
      weekly: {
        usedPercent: 58,
        windowDurationMins: 10080,
        resetsAt: now + 4 * day,
      },
      bankedResets: {
        availableCount: 2,
        items: [
          {
            id: "reset-personal-1",
            label: "Full banked reset",
            expiresAt: now + 14 * day,
          },
          {
            id: "reset-personal-2",
            label: "Full banked reset",
            expiresAt: now + 20 * day,
          },
        ],
      },
    },
    {
      id: "secondary",
      label: "Secondary",
      email: "secondary@example.com",
      plan: "ChatGPT Plus",
      isActive: false,
      fiveHour: {
        usedPercent: 6,
        windowDurationMins: 300,
        resetsAt: now + 4 * 60 * 60 + 12 * 60,
      },
      weekly: {
        usedPercent: 19,
        windowDurationMins: 10080,
        resetsAt: now + 6 * day,
      },
      bankedResets: {
        availableCount: 1,
        items: [
          {
            id: "reset-secondary-1",
            label: "Full banked reset",
            expiresAt: now + 11 * day,
          },
        ],
      },
    },
  ],
}
