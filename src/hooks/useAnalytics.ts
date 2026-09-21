import { useCallback, useEffect, useState } from "react"
import { usePostHog } from "@posthog/react"
import { getVersion } from "@tauri-apps/api/app"

const DAILY_ACTIVE_KEY = "codexgauge:last_daily_active_date"

function getLocalDateKey(): string {
    const now = new Date()

    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")

    return `${year}-${month}-${day}`
}

export function useAnalytics(accountCount: number) {
    const posthog = usePostHog()
    const [appVersion, setAppVersion] = useState<string>()

    useEffect(() => {
        getVersion()
            .then(setAppVersion)
            .catch(() => {
                // Analytics 失败不能影响主程序
            })
    }, [])

    const captureDailyActive = useCallback(() => {
        if (!posthog || !appVersion) {
            return
        }

        const today = getLocalDateKey()
        const lastDate = localStorage.getItem(DAILY_ACTIVE_KEY)

        if (lastDate === today) {
            return
        }

        posthog.capture("daily_active", {
            account_count: accountCount,
            app_version: appVersion,
        })

        localStorage.setItem(DAILY_ACTIVE_KEY, today)
    }, [posthog, accountCount, appVersion])

    return {
        posthog,
        appVersion,
        captureDailyActive,
    }
}