import { createRef } from "react"

export const APP_CONTENT_ROOT_ID = "app-content-root"

/**
 * Shared portal target for application-level overlays.
 *
 * The native macOS title bar is outside this React surface. Dialogs and
 * alert dialogs must render inside this root so they are always positioned
 * below AppHeader/traffic lights and never depend on viewport safe-area math.
 */
export const appContentRootRef = createRef<HTMLDivElement>()
