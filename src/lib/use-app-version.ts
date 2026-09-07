import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void getVersion()
      .then((value) => {
        if (!cancelled) {
          setVersion(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVersion(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return version
}
