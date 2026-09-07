# CodexGauge

**English** | [简体中文](README.zh-CN.md)

CodexGauge is a local Windows desktop application for managing multiple user-owned Codex accounts, viewing Codex usage limits, and manually switching the active account.

It is built with Tauri 2, React, TypeScript, Vite, Bun, Tailwind CSS, and shadcn/ui.

> **Independent project:** CodexGauge is not affiliated with, endorsed by, certified by, or sponsored by OpenAI.

## Features

- View Codex 5-hour and weekly usage limits.
- Show localized quota reset times.
- View banked rate-limit resets and their expiration details.
- Add multiple user-owned Codex accounts through the official Codex CLI login flow.
- Manually switch the active Codex account.
- Rename locally managed account labels.
- Delete non-current accounts from CodexGauge.
- Preserve one shared `CODEX_HOME` so Codex sessions, history, memory, and configuration remain shared.
- Encrypt stored account credentials with Windows DPAPI for the current Windows user.
- Detect updates to Codex `auth.json` and keep the current account credential backup synchronized.
- Configure CodexGauge-launched Codex processes to use:
  - no proxy,
  - the Windows/system proxy,
  - or a custom HTTP/HTTPS proxy.
- Configure automatic usage polling.
- Preserve the most recent successful usage values when the network is unavailable.
- Support English and Simplified Chinese, with automatic system-language detection.
- Support system, light, and dark themes.
- Keep CodexGauge running in the Windows system tray when the main window is closed.
- Restore CodexGauge from the tray or quit it explicitly from the tray menu.
- Check for application updates and install signed updates published through GitHub Releases.
- Write diagnostic logs locally for troubleshooting without intentionally logging authentication tokens.

## Requirements

### Windows

CodexGauge currently targets Windows.

### Official Codex CLI

The official OpenAI Codex CLI must be installed and available in `PATH`.

Verify it with:

```powershell
codex --version
```

If Codex CLI is not detected, CodexGauge blocks the main UI and prompts the user to install it first.

Codex Desktop / ChatGPT Desktop is not required.

## How account switching works

CodexGauge uses one shared Codex home directory:

```text
%USERPROFILE%\.codex
```

or the directory specified by `CODEX_HOME`.

CodexGauge does **not** create a separate permanent Codex home for each account. Instead, it keeps sessions, history, memory, configuration, and other local Codex state shared while manually replacing only the active authentication credentials.

Before switching accounts, CodexGauge saves the latest current credentials. Stored account credential copies are encrypted with Windows DPAPI for the current Windows user.

For safety, account switching is blocked while Codex is running.

## Usage data

CodexGauge reads usage through the official local Codex app-server protocol:

```text
codex app-server --stdio
```

and requests:

```text
account/rateLimits/read
```

Quota windows are classified by their duration rather than by assuming a fixed primary/secondary ordering:

- `300` minutes → 5-hour limit
- `10080` minutes → weekly limit

CodexGauge does not implement a separate private usage API client.

## Proxy settings

CodexGauge supports three proxy modes.

### No proxy

CodexGauge removes proxy environment variables from Codex processes it launches and disables Codex system-proxy handling for those processes.

### System proxy

CodexGauge lets the launched Codex process use the system proxy behavior supported by Codex.

### Custom proxy

CodexGauge accepts an HTTP or HTTPS proxy, for example:

```text
http://127.0.0.1:7897
```

or:

```text
https://proxy.example.com:443
```

If the scheme is omitted, CodexGauge treats the value as HTTP.

CodexGauge does not provide a proxy/VPN service, does not change the Windows global proxy configuration, and does not modify `%USERPROFILE%\.codex\.env`.

## Automatic refresh

Automatic usage refresh is enabled by default at 60 seconds.

Available UI presets include:

- 30 seconds
- 60 seconds
- 2 minutes
- 5 minutes
- 10 minutes

When enabled, usage is refreshed automatically at the selected interval.

If ChatGPT cannot be reached, CodexGauge preserves the most recent successful usage values and pauses automatic refresh until the connection succeeds again.

## Language

CodexGauge currently includes:

- English
- Simplified Chinese

The default option follows the Windows system language.

A manually selected language is persisted in CodexGauge settings and restored on the next launch.

## Theme

CodexGauge supports:

- System default
- Light
- Dark

When `System default` is selected, CodexGauge follows the Windows color-scheme preference.

Theme changes apply immediately and are persisted locally.

## System tray

Closing the main window with the window close button or `Alt+F4` does not exit CodexGauge. The application continues running in the Windows system tray.

On the first close, CodexGauge explains this behavior before hiding the window. The hint is shown only once.

The tray provides:

- left-click to restore and focus CodexGauge,
- `Open CodexGauge`,
- `Quit`.

Only `Quit` fully exits the application.

The normal minimize button continues to minimize CodexGauge to the taskbar.

## Application updates

CodexGauge uses the Tauri Updater for signed application updates distributed through GitHub Releases.

The application can:

- check for updates automatically on startup,
- check for updates manually from `Settings → About`,
- install an available signed update,
- postpone an update,
- ignore one specific version.

Ignoring a version affects automatic prompts only. A manual update check can still report the ignored version.

Updater artifacts are cryptographically signed. The updater public key is embedded in the application configuration, while the signing private key must remain secret.

## Logs

CodexGauge writes diagnostic logs locally for troubleshooting.

On Windows, logs are stored under the application's local log directory, typically:

```text
%LOCALAPPDATA%\com.codexgauge.desktop\logs\
```

Detailed internal errors can be written to the log while the UI shows a shorter user-facing message.

Diagnostic logs are local and are not uploaded automatically.

CodexGauge should not intentionally log authentication tokens, refresh tokens, or raw `auth.json` contents.

## Development

Install dependencies:

```powershell
bun install
```

Run the web frontend:

```powershell
bun run dev
```

Run the Tauri application:

```powershell
bun tauri dev
```

Frontend production build:

```powershell
bun run build
```

Rust validation:

```powershell
cd src-tauri
cargo check
cd ..
```

Build the Windows application and installer:

```powershell
bun tauri build
```

Tauri build artifacts are generated under:

```text
src-tauri\target\release\bundle\
```

## Security and privacy

- Local-first: CodexGauge has no application backend.
- No telemetry is included by default.
- Diagnostic logs are stored locally and are not uploaded automatically.
- Account credential backups are encrypted using Windows DPAPI for the current Windows user.
- CodexGauge does not expose account credentials through a local HTTP service.
- CodexGauge does not implement automatic quota-based account rotation.
- CodexGauge does not provide shared credential pools or account-sharing functionality.
- CodexGauge does not intentionally store authentication credentials in plaintext account metadata.

If you discover a credential-handling or authentication vulnerability, avoid publishing sensitive reproduction data in a public issue.

## Project scope

CodexGauge is designed for manually managing accounts owned and controlled by the user.

It is not intended to:

- pool credentials between users,
- automatically rotate accounts to evade rate limits,
- provide shared accounts or credential pools,
- provide a proxy/VPN service,
- or represent itself as an official OpenAI product.

## License

MIT. See [LICENSE](LICENSE).

## Trademark notice

CodexGauge is an independent open-source project. It is not affiliated with, endorsed by, certified by, or sponsored by OpenAI.

OpenAI and its related product names, logos, and marks are the property of their respective owner. No OpenAI logo or brand asset is incorporated into the CodexGauge application identity.
