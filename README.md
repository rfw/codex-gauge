# CodexGauge

**English** | [简体中文](README.zh-CN.md)

<p style="text-align: center">
  <img src="docs/images/main.png" alt="CodexGauge" width="700">
</p>

<p style="text-align: center">
  A local Codex usage monitor and multi-account manager for Windows and macOS.
</p>

<p style="text-align: center">
  <a href="https://github.com/rfw/codex-gauge/releases/latest">Download latest release</a>
</p>

CodexGauge is a local-first desktop application for monitoring Codex usage limits, viewing reset times, receiving reset notifications, and managing multiple user-owned Codex accounts.

Built with Tauri 2, Rust, React, TypeScript, Vite, Bun, Tailwind CSS, and shadcn/ui.

> **Independent project:** CodexGauge is not affiliated with, endorsed by, certified by, or sponsored by OpenAI.

## Features

- **Usage monitoring** — View Codex 5-hour and weekly usage limits, reset times, and remaining credits when available.
- **Multi-account management** — Add and manage multiple Codex accounts locally.
- **Quick account switching** — Manually switch the active Codex account without maintaining separate Codex environments.
- **Reset notifications** — Receive a system notification when the next effective 5-hour or weekly quota reset is reached.
- **Next reset overview** — See the earliest relevant reset across all managed accounts.
- **Banked resets** — View available banked resets and expiration information when provided by Codex.
- **Automatic refresh** — Refresh usage data automatically at a configurable interval.
- **Proxy support** — Use no proxy, the system proxy, or a custom HTTP/HTTPS proxy.
- **Themes** — System, light, and dark modes.
- **Languages** — English and Simplified Chinese, with automatic system-language detection.

## Supported platforms

| Platform | Build |
| --- | --- |
| Windows | x64 |
| macOS | Universal — Intel and Apple Silicon |

The macOS Universal build runs on both Intel Macs and Apple Silicon Macs such as M1, M2, M3, M4, and later generations.

## Requirements

The official OpenAI Codex CLI must be installed and available to CodexGauge.

Verify it with:

```bash
codex --version
```

Codex Desktop / ChatGPT Desktop is not required.

## Install

Download the latest release from:

https://github.com/rfw/codex-gauge/releases/latest

### Windows

Download the Windows installer and launch it normally.

Windows may display a SmartScreen or unknown-publisher warning when the installer is not code-signed.

### macOS

Download the Universal `.dmg`. The same build supports both Intel and Apple Silicon Macs.

Current macOS releases use ad-hoc signing and are not notarized with Apple Developer ID. macOS may block the first launch. If that happens, open:

**System Settings → Privacy & Security → Open Anyway**

Then confirm the launch. This is only required because the app is distributed without an Apple Developer certificate.

## Account management

CodexGauge keeps one shared Codex home directory and switches only the active authentication credentials. Codex sessions, history, memory, and configuration remain shared.

Account credentials are stored locally using platform-specific protection:

- **Windows:** Windows DPAPI
- **macOS:** macOS Keychain

Before switching, CodexGauge validates the target account so an invalid or expired login does not replace the current working account.

CodexGauge does not automatically rotate accounts based on quota state.

## Usage and reset notifications

CodexGauge reads usage through the official local Codex app-server protocol and displays the available 5-hour and weekly quota windows.

Reset times are shown in the user's local time. When reset notifications are enabled, CodexGauge sends a native system notification after the next effective reset time is reached.

Automatic usage refresh can be configured from 30 seconds up to 5 hours.

## Language

CodexGauge currently supports:

- English
- Simplified Chinese

The default setting follows the system language. A manually selected language is saved locally and restored on the next launch.

## Privacy and security

- No CodexGauge application backend.
- No telemetry by default.
- Account credentials stay on the local device.
- Windows credentials are protected with DPAPI.
- macOS credentials are stored in Keychain.
- Diagnostic logs are local and are not uploaded automatically.
- Authentication tokens and raw `auth.json` contents are not intentionally written to logs.
- CodexGauge does not provide shared accounts, credential pools, or automatic quota-based account rotation.

## Development

Install dependencies:

```bash
bun install
```

Run in development mode:

```bash
bun tauri dev
```

Build the frontend:

```bash
bun run build
```

Build the desktop application:

```bash
bun tauri build
```

Build a Universal macOS application:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
bun tauri build --target universal-apple-darwin
```

Release tags matching `v*` trigger the GitHub Actions release workflow, which builds the Windows release and the Universal macOS release.

## Project scope

CodexGauge is designed for manually managing accounts owned and controlled by the user.

It is not intended to pool credentials between users, automatically rotate accounts to evade rate limits, provide shared accounts, or represent itself as an official OpenAI product.

## License

MIT. See [LICENSE](LICENSE).

## Trademark notice

CodexGauge is an independent open-source project and is not affiliated with, endorsed by, certified by, or sponsored by OpenAI.

OpenAI and its related product names, logos, and marks are the property of their respective owners.
