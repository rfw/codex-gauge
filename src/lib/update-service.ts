import { Channel, invoke } from "@tauri-apps/api/core"

export type AppUpdateInfo = {
  version: string
  currentVersion: string
  notes: string | null
}

export type UpdateDownloadEvent =
  | {
      event: "Started"
      data: {
        contentLength: number | null
      }
    }
  | {
      event: "Progress"
      data: {
        chunkLength: number
      }
    }
  | {
      event: "Finished"
    }

export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  return invoke<AppUpdateInfo | null>("check_for_app_update")
}

export async function installAppUpdate(
  onEvent: (event: UpdateDownloadEvent) => void,
): Promise<void> {
  const channel = new Channel<UpdateDownloadEvent>()
  channel.onmessage = onEvent

  await invoke<void>("install_app_update", {
    onEvent: channel,
  })
}
