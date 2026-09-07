import { invoke } from "@tauri-apps/api/core"

import type { AccountsSnapshot } from "@/features/accounts/types"

export async function getAccounts(): Promise<AccountsSnapshot> {
  return invoke<AccountsSnapshot>("list_codex_accounts")
}

export async function setActiveAccount(
  accountId: string,
): Promise<AccountsSnapshot> {
  return invoke<AccountsSnapshot>("switch_codex_account", {
    accountId,
  })
}

export async function renameCodexAccount(
  accountId: string,
  label: string,
): Promise<AccountsSnapshot> {
  const normalizedLabel = label.trim()

  if (!normalizedLabel) {
    throw new Error("Account name cannot be empty.")
  }

  return invoke<AccountsSnapshot>("rename_codex_account", {
    accountId,
    label: normalizedLabel,
  })
}

export async function addCodexAccount(): Promise<AccountsSnapshot> {
  return invoke<AccountsSnapshot>("add_codex_account")
}

export async function deleteCodexAccount(
  accountId: string,
): Promise<AccountsSnapshot> {
  return invoke<AccountsSnapshot>("delete_codex_account", {
    accountId,
  })
}
