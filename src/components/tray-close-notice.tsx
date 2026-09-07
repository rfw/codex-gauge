import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"

import { useI18n } from "@/i18n"
import { showTrayCloseNotification } from "@/lib/tray-service"

const FIRST_CLOSE_EVENT = "codexgauge://tray-close-hint"

export function TrayCloseNotice() {
  const { t } = useI18n()

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void listen(FIRST_CLOSE_EVENT, () => {
      void showTrayCloseNotification(
        t("tray.closeHintTitle"),
        t("tray.closeHintDescription"),
      ).catch(() => undefined)
    }).then((cleanup) => {
      if (disposed) {
        cleanup()
        return
      }

      unlisten = cleanup
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [t])

  return null
}
