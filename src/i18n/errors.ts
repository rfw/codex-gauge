import type { Translate } from "@/i18n"
import type { TranslationKey } from "@/i18n/resources/en-US"

const exactErrors: Partial<Record<string, TranslationKey>> = {
  "Unable to refresh Codex usage.": "errors.refresh",
  "Unable to switch Codex account.": "errors.switch",
  "Stored account authentication is unavailable.":
    "errors.switchCredentialUnavailable",
  "Stored account sign-in has expired. Re-add the account before switching.":
    "errors.switchAuthExpired",
  "Unable to verify the target account. Check your network or proxy settings and try again.":
    "errors.switchPreflightNetwork",
  "Unable to verify the target account before switching.":
    "errors.switchPreflightFailed",
  "Unable to update Codex authentication.": "errors.switchWriteFailed",
  "Account switch verification failed. The previous account was restored.":
    "errors.switchVerificationFailed",
  "Unable to rename Codex account.": "errors.rename",
  "Unable to add Codex account.": "errors.add",
  "Unable to delete Codex account.": "errors.delete",
  "Account name cannot be empty.": "errors.accountNameEmpty",
  "Account not found.": "errors.accountNotFound",
  "The current account cannot be deleted. Switch to another account first.":
    "errors.currentAccountDelete",
  "Codex CLI was not found.": "errors.usageCliNotFound",
  "Codex did not return usage data in time.": "errors.usageTimeout",
  "Codex authentication could not be verified.": "errors.usageAuth",
  "Unable to reach ChatGPT. Check Network proxy settings.":
    "errors.usageNetwork",
  "Codex app-server could not provide usage data.":
    "errors.usageAppServer",
  "Usage data is temporarily unavailable.": "errors.usageUnavailable",
}

export function localizeErrorMessage(
  message: string,
  t: Translate,
): string {
  const exactKey = exactErrors[message]

  if (exactKey) {
    return t(exactKey)
  }

  const runningMatch = message.match(
    /^Codex is currently running \((.+)\)\. Close Codex CLI or Codex Desktop before switching accounts\.$/,
  )

  if (runningMatch) {
    return t("errors.codexRunning", {
      processes: runningMatch[1],
    })
  }

  return message
}
