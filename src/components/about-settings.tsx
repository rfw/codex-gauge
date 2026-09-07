import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { APP_CONFIG } from "@/config/app-config"
import { useI18n } from "@/i18n"
import { openExternalUrl } from "@/lib/settings-service"
import { useAppVersion } from "@/lib/use-app-version"
import { useAppUpdate } from "@/update"

export function AboutSettingsPanel() {
  const version = useAppVersion()
  const { t } = useI18n()
  const {
    checking,
    result,
    error,
    availableUpdate,
    checkNow,
  } = useAppUpdate()

  return (
    <div>
      <div>
        <h3 className="text-sm font-semibold">
          {t("about.title")}
        </h3>
        <div className={"pt-6 pb-2"}>
          <img src="/logo.png" className={"block w-16"} alt=""/>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("about.description")}
        </p>
      </div>

      <dl className="mt-4 divide-y rounded-md border">
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("about.version")}
              </dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums">
                {version ? `v${version}` : t("common.unknown")}
              </dd>
            </div>

            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-sm"
                disabled={checking}
                onClick={() => void checkNow().catch(() => undefined)}
            >
              {checking ? (
                  <LoaderCircle className="size-3 animate-spin" />
              ) : (
                  <RefreshCw className="size-3" />
              )}
              {checking
                  ? t("update.checking")
                  : t("update.checkForUpdates")}
            </Button>
          </div>

          {result === "upToDate" ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("update.upToDate")}
              </p>
          ) : null}

          {result === "available" && availableUpdate ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("update.available", {
                  version: `v${availableUpdate.version}`,
                })}
              </p>
          ) : null}

          {result === "error" && error ? (
              <p className="mt-1.5 text-xs text-destructive">
                {t("update.checkFailed")}
              </p>
          ) : null}
        </div>

        <div className="px-3 py-2.5">
          <dt className="text-xs text-muted-foreground">
            {t("about.repository")}
          </dt>
          <dd className="mt-1 flex items-center justify-between gap-3">
            <code
              className="min-w-0 truncate text-xs"
              title={APP_CONFIG.repositoryUrl}
            >
              {APP_CONFIG.repositoryUrl}
            </code>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-sm"
              onClick={() => void openExternalUrl(APP_CONFIG.repositoryUrl)}
            >
              <ExternalLink className="size-3" />
              {t("common.open")}
            </Button>
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {t("about.disclaimer")}
      </p>
    </div>
  )
}
