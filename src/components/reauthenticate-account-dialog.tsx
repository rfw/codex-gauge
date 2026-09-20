import { useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  ReauthPollResponse,
  ReauthStartResponse,
} from "@/features/accounts/account-service"
import { useI18n } from "@/i18n"
import { localizeErrorMessage } from "@/i18n/errors"
import { openExternalUrl } from "@/lib/runtime-service"

type ReauthenticateAccountDialogProps = {
  accountId: string
  disabled?: boolean
  onStart: (accountId: string) => Promise<ReauthStartResponse>
  onPoll: (sessionId: string) => Promise<ReauthPollResponse>
  onCancel: (sessionId: string) => Promise<void>
}

type DialogPhase = "idle" | "preparing" | "waiting" | "error"

function errorMessage(cause: unknown, fallback: string) {
  if (typeof cause === "string") {
    return cause
  }

  if (cause instanceof Error) {
    return cause.message
  }

  return fallback
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the DOM copy fallback for WebView environments where
      // the async clipboard API is unavailable or denied.
    }
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand("copy")
  textarea.remove()

  if (!copied) {
    throw new Error("Unable to copy the sign-in link.")
  }
}

export function ReauthenticateAccountDialog({
  accountId,
  disabled = false,
  onStart,
  onPoll,
  onCancel,
}: ReauthenticateAccountDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<DialogPhase>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const generationRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)

  function clearSessionState() {
    sessionIdRef.current = null
    setSessionId(null)
    setAuthUrl(null)
    setCopied(false)
  }

  function closeDialog() {
    generationRef.current += 1
    const activeSessionId = sessionIdRef.current

    setOpen(false)
    setPhase("idle")
    setError(null)
    clearSessionState()

    if (activeSessionId) {
      void onCancel(activeSessionId).catch(() => undefined)
    }
  }

  async function beginSignIn() {
    if (disabled) {
      return
    }

    const generation = ++generationRef.current

    setOpen(true)
    setPhase("preparing")
    setError(null)
    clearSessionState()

    try {
      const response = await onStart(accountId)

      if (generation !== generationRef.current) {
        await onCancel(response.sessionId).catch(() => undefined)
        return
      }

      sessionIdRef.current = response.sessionId
      setSessionId(response.sessionId)
      setAuthUrl(response.authUrl)
      setPhase("waiting")
    } catch (cause) {
      if (generation !== generationRef.current) {
        return
      }

      setPhase("error")
      setError(
        errorMessage(cause, "Unable to start Codex sign-in."),
      )
    }
  }

  useEffect(() => {
    if (!open || phase !== "waiting" || !sessionId) {
      return
    }

    let disposed = false
    let polling = false

    const timer = window.setInterval(() => {
      if (disposed || polling) {
        return
      }

      polling = true

      void onPoll(sessionId)
        .then((response) => {
          if (disposed) {
            return
          }

          if (response.status === "pending") {
            return
          }

          sessionIdRef.current = null
          setSessionId(null)

          if (response.status === "succeeded") {
            generationRef.current += 1
            setOpen(false)
            setPhase("idle")
            setError(null)
            setAuthUrl(null)
            setCopied(false)
            return
          }

          setAuthUrl(null)
          setCopied(false)
          setPhase("error")
          setError(
            response.status === "timedOut"
              ? t("reauth.timeout")
              : response.error ?? t("reauth.failed"),
          )
        })
        .catch((cause) => {
          if (!disposed) {
            sessionIdRef.current = null
            setSessionId(null)
            setPhase("error")
            setError(
              errorMessage(cause, "Unable to complete Codex sign-in."),
            )
          }
        })
        .finally(() => {
          polling = false
        })
    }, 500)

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [open, onPoll, phase, sessionId, t])

  async function handleCopy() {
    if (!authUrl) {
      return
    }

    try {
      await copyText(authUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError(t("reauth.copyFailed"))
    }
  }

  async function handleOpenBrowser() {
    if (!authUrl) {
      return
    }

    try {
      await openExternalUrl(authUrl)
    } catch {
      setError(t("reauth.openFailed"))
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        disabled={disabled}
        onClick={() => void beginSignIn()}
      >
        {t("account.reauthenticate")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeDialog()
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t("reauth.title")}</DialogTitle>
            <DialogDescription>
              {t("reauth.description")}
            </DialogDescription>
          </DialogHeader>

          {phase === "preparing" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("reauth.preparing")}</span>
            </div>
          ) : null}

          {authUrl ? (
            <div className="space-y-2.5">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("reauth.urlLabel")}
                </p>

                <button
                  type="button"
                  className="block w-full truncate rounded-md border bg-background px-3 py-2 text-left text-xs text-foreground underline-offset-2 transition-colors hover:bg-muted/40 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  title={authUrl}
                  onClick={() => void handleOpenBrowser()}
                >
                  {authUrl}
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy()}
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? t("reauth.copied") : t("reauth.copy")}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleOpenBrowser()}
                >
                  <ExternalLink className="size-4" />
                  {t("reauth.openBrowser")}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {localizeErrorMessage(error, t)}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
