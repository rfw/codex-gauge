import { Minus, X } from "lucide-react"

import { useI18n } from "@/i18n"
import { useAppVersion } from "@/lib/use-app-version"
import {
  closeMainWindow,
  minimizeMainWindow,
  startMainWindowDrag,
} from "@/lib/window-service"

export function AppHeader() {
  const { t } = useI18n()
  const version = useAppVersion()

  return (
    <header className="flex h-9 shrink-0 select-none items-center border-b bg-background/95">
      <div
        className="flex h-full min-w-0 flex-1 items-center px-3"
        onMouseDown={(event) => {
          if (event.button === 0) {
            void startMainWindowDrag()
          }
        }}
      >
        <div className="pointer-events-none flex items-baseline gap-1.5">
          <h1 className="font-inter text-[15px] font-semibold tracking-[-0.03em]">
            <span className="text-[#03aefc]">Codex</span>
            <span className="text-[#d946ef]">Gauge</span>
          </h1>
          {version ? (
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              v{version}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex h-full shrink-0 items-stretch">
        <button
          type="button"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          onClick={() => void minimizeMainWindow()}
        >
          <Minus className="size-3.5" strokeWidth={1.75} />
        </button>

        <button
          type="button"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={() => void closeMainWindow()}
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
