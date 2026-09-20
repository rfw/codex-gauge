import { invoke } from "@tauri-apps/api/core"

import type { AccountsSnapshot } from "@/features/accounts/types"

export type ReauthStartResponse = {
  sessionId: string
  authUrl: string
}

export type ReauthPollStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "timedOut"

export type ReauthPollResponse = {
  status: ReauthPollStatus
  snapshot: AccountsSnapshot | null
  error: string | null
}

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

export async function startReauthenticateCodexAccount(
  accountId: string,
): Promise<ReauthStartResponse> {
  return invoke<ReauthStartResponse>("start_reauthenticate_codex_account", {
    accountId,
  })
}

export async function pollReauthenticateCodexAccount(
  sessionId: string,
): Promise<ReauthPollResponse> {
  return invoke<ReauthPollResponse>("poll_reauthenticate_codex_account", {
    sessionId,
  })
}

export async function cancelReauthenticateCodexAccount(
  sessionId: string,
): Promise<void> {
  return invoke<void>("cancel_reauthenticate_codex_account", {
    sessionId,
  })
}

export async function deleteCodexAccount(
  accountId: string,
): Promise<AccountsSnapshot> {
  return invoke<AccountsSnapshot>("delete_codex_account", {
    accountId,
  })
}
