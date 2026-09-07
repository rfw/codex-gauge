import { useEffect, useState } from "react"
import { Globe2, Info, Network, RefreshCw } from "lucide-react"

import { AboutSettingsPanel } from "@/components/about-settings"
import { GeneralSettingsPanel } from "@/components/general-settings"
import { ProxySettingsPanel } from "@/components/proxy-settings"
import { RefreshSettingsPanel } from "@/components/refresh-settings"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useI18n } from "@/i18n"
import type { TranslationKey } from "@/i18n/resources/en-US"
import type { RefreshSettings } from "@/lib/settings-service"

export type SettingsTab = "general" | "proxy" | "polling" | "about"

type SettingsDialogProps = {
  open: boolean
  initialTab?: SettingsTab
  onOpenChange: (open: boolean) => void
  onProxySaved?: () => void | Promise<void>
  onRefreshSaved?: (settings: RefreshSettings) => void | Promise<void>
}

const tabs: Array<{
  id: SettingsTab
  labelKey: TranslationKey
  icon: typeof Network
}> = [
  {
    id: "general",
    labelKey: "settings.general",
    icon: Globe2,
  },
  {
    id: "proxy",
    labelKey: "settings.proxy",
    icon: Network,
  },
  {
    id: "polling",
    labelKey: "settings.polling",
    icon: RefreshCw,
  },
  {
    id: "about",
    labelKey: "settings.about",
    icon: Info,
  },
]

export function SettingsDialog({
  open,
  initialTab = "general",
  onOpenChange,
  onProxySaved,
  onRefreshSaved,
}: SettingsDialogProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab)
    }
  }, [initialTab, open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!h-[calc(100vh-10px)] !w-[calc(100vw-10px)] !max-w-none grid-rows-[auto_minmax(0,1fr)] gap-4 p-4 sm:!max-w-none">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[132px_1fr] overflow-hidden rounded-md border">
          <nav className="border-r bg-muted/20 p-2">
            <div className="space-y-1">
              {tabs.map((tab) => {
                const Icon = tab.icon
                const active = activeTab === tab.id

                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
                      active
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                    }`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <Icon className="size-3.5" />
                    {t(tab.labelKey)}
                  </button>
                )
              })}
            </div>
          </nav>

          <div className="min-h-0 min-w-0 overflow-y-auto p-4">
            {activeTab === "general" ? (
              <GeneralSettingsPanel />
            ) : null}

            {activeTab === "proxy" ? (
              <ProxySettingsPanel onSaved={onProxySaved} />
            ) : null}

            {activeTab === "polling" ? (
              <RefreshSettingsPanel onSaved={onRefreshSaved} />
            ) : null}

            {activeTab === "about" ? (
              <AboutSettingsPanel />
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
