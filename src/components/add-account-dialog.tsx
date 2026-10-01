import { useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink, Loader2, Plus, RotateCcw } from "lucide-react"

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

type AddAccountDialogProps = {
  onStart: () => Promise<ReauthStartResponse>
  onPoll: (sessionId: string) => Promise<ReauthPollResponse>
  onCancel: (sessionId: string) => Promise<void>
  disabled?: boolean
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

export function AddAccountDialog({
  onStart,
  onPoll,
  onCancel,
  disabled = false,
}: AddAccountDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<DialogPhase>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const generationRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)
  const pendingStartRef = useRef<Promise<void> | null>(null)
  const pendingCancelRef = useRef<Promise<void> | null>(null)

  function clearSessionState() {
    sessionIdRef.current = null
    setSessionId(null)
    setAuthUrl(null)
    setCopied(false)
  }

  function cancelSession(sessionIdToCancel: string) {
    const pending = onCancel(sessionIdToCancel).catch(() => undefined)
    pendingCancelRef.current = pending

    void pending.finally(() => {
      if (pendingCancelRef.current === pending) {
        pendingCancelRef.current = null
      }
    })

    return pending
  }

  function openDialog() {
    if (disabled) {
      return
    }

    setOpen(true)
    setPhase("idle")
    setError(null)
    clearSessionState()
  }

  function closeDialog() {
    generationRef.current += 1
    const activeSessionId = sessionIdRef.current

    setOpen(false)
    setPhase("idle")
    setError(null)
    clearSessionState()

    if (activeSessionId) {
      void cancelSession(activeSessionId)
    }
  }

  async function beginSignIn() {
    if (disabled) {
      return
    }

    const generation = ++generationRef.current

    setPhase("preparing")
    setError(null)
    clearSessionState()

    const previousStart = pendingStartRef.current
    if (previousStart) {
      await previousStart
    }

    const pendingCancel = pendingCancelRef.current
    if (pendingCancel) {
      await pendingCancel
    }

    if (generation !== generationRef.current || !open) {
      return
    }

    let resolveStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve
    })
    pendingStartRef.current = startGate

    try {
      const response = await onStart()

      if (generation !== generationRef.current || !open) {
        await onCancel(response.sessionId).catch(() => undefined)
        return
      }

      sessionIdRef.current = response.sessionId
      setSessionId(response.sessionId)
      setAuthUrl(response.authUrl)
      setPhase("waiting")

      try {
        await openExternalUrl(response.authUrl)
      } catch {
        setError(t("reauth.openFailed"))
      }
    } catch (cause) {
      if (generation !== generationRef.current) {
        return
      }

      setPhase("error")
      setError(errorMessage(cause, "Unable to start Codex sign-in."))
    } finally {
      resolveStart()
      if (pendingStartRef.current === startGate) {
        pendingStartRef.current = null
      }
    }
  }

  async function restartSignIn() {
    generationRef.current += 1
    const activeSessionId = sessionIdRef.current

    setError(null)
    clearSessionState()

    if (activeSessionId) {
      await cancelSession(activeSessionId)
    }

    if (!open) {
      return
    }

    await beginSignIn()
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
        size="sm"
        className="h-8 px-2.5 text-sm"
        disabled={disabled}
        onClick={openDialog}
      >
        <Plus className="size-3.5" />
        {t("add.trigger")}
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
            <DialogTitle>{t("add.title")}</DialogTitle>
            <DialogDescription>{t("add.description")}</DialogDescription>
          </DialogHeader>

          <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            {t("add.notice")}
          </div>

          {phase === "preparing" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("reauth.preparing")}</span>
            </div>
          ) : null}

          {phase === "waiting" ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                <span>{t("add.waiting")}</span>
              </div>

              {authUrl ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied ? t("reauth.copied") : t("reauth.copy")}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void handleOpenBrowser()}
                  >
                    <ExternalLink className="size-3.5" />
                    {t("reauth.openBrowser")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {authUrl ? (
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("reauth.urlLabel")}
              </p>

              <button
                type="button"
                className="block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md border bg-background px-3 py-2 text-left text-xs text-foreground underline-offset-2 transition-colors hover:bg-muted/40 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                title={authUrl}
                onClick={() => void handleOpenBrowser()}
              >
                {authUrl}
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {localizeErrorMessage(error, t)}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {phase === "error" ? t("common.close") : t("common.cancel")}
            </Button>

            {phase === "idle" ? (
              <Button type="button" onClick={() => void beginSignIn()}>
                <ExternalLink className="size-4" />
                {t("add.continue")}
              </Button>
            ) : null}

            {phase === "waiting" || phase === "error" ? (
              <Button
                type="button"
                onClick={() => void restartSignIn()}
              >
                <RotateCcw className="size-4" />
                {phase === "waiting" ? t("add.restart") : t("add.retry")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
