# CodexGauge Development Rules

This file is the project-level implementation guide for future Codex/Coding Agent work. Read the current repository, this file, README files, relevant source, and existing tests before changing code. Prefer requirements-driven changes: preserve existing architecture and behavior unless the requested feature requires a change.

## Product scope

CodexGauge is a small cross-platform Tauri desktop utility for Codex usage/account management.

Core user-facing capabilities:

- Manage multiple Codex accounts locally.
- Show 5-hour / weekly usage and reset information.
- Switch between saved accounts.
- Re-authenticate unavailable accounts.
- Notify when configured reset times are reached.
- Support English and Simplified Chinese.
- Support Windows x64 and macOS Universal (Intel x86_64 + Apple Silicon arm64).

Do not expand product scope while fixing a bounded bug.

## Stack

- Tauri v2 + Rust
- Vite + React 19 + TypeScript
- Tailwind CSS v4
- shadcn-style components built on Base UI
- Bun for JS dependency management / scripts

Keep Tauri JS and Rust packages compatible. The project intentionally pins important Tauri versions exactly to prevent Windows/macOS environments from resolving different minor versions. Do not casually replace exact versions with broad `^2` ranges.

## Cross-platform invariants

### Windows

- Keep the existing custom title/header controls on the right.
- Windows credential protection continues to use the existing DPAPI path.
- Do not regress Windows behavior while fixing macOS-specific issues.

### macOS

- Use the native macOS traffic-light controls; do not draw fake red/yellow/green buttons in React.
- `src-tauri/tauri.macos.conf.json` uses an overlay native title bar.
- Verified traffic-light position is:

```json
"trafficLightPosition": {
  "x": 13,
  "y": 16
}
```

- The current app header height is `h-9` (36 px).
- macOS release target is Universal DMG (`universal-apple-darwin`) so one package supports Intel and Apple Silicon.
- The current project uses ad-hoc signing (`"signingIdentity": "-"`) because there is no Apple Developer / Developer ID certificate. Do not pretend this removes Gatekeeper warnings.

## Window layout and overlay architecture

This is a hard UI architecture rule.

The native macOS title bar / traffic lights and `AppHeader` are outside the application content surface. All application-level dialogs must be positioned relative to the content area below `AppHeader`, not relative to the whole WebView/window.

The layout is:

```text
App
├─ AppHeader
└─ #app-content-root   (position: relative; flex: 1; overflow: hidden)
   ├─ main application content
   └─ Dialog / AlertDialog portal content
```

Implementation:

- `src/lib/app-content-root.ts` owns the shared `appContentRootRef`.
- `App.tsx` attaches that ref to `#app-content-root` immediately below `AppHeader`.
- Base UI `Dialog.Portal` and `AlertDialog.Portal` must default to that shared ref.
- Dialog backdrops and viewports use `position: absolute; inset: 0` inside `#app-content-root`.
- Do **not** portal app dialogs directly to `body` unless a specific feature has a documented reason.
- Do **not** solve traffic-light collisions with per-dialog `top: 36px`, `100vh - 36px`, transforms, or tab-specific offsets.
- Do **not** reintroduce `--window-titlebar-safe-top`; modal placement should follow the actual content DOM container instead of duplicated pixel math.

Dialog behavior:

- Ordinary dialogs / alert dialogs are centered within `#app-content-root`.
- The Settings dialog uses `fillViewport` and fills the content surface (with the primitive's small viewport inset). Its outer position and size must not change when switching Settings tabs.
- Long settings content scrolls inside the Settings content pane; the Settings dialog itself stays fixed.
- Overlay/backdrop covers the application content surface, not the native title-bar/traffic-light area.

When adding a new modal primitive, make it use the same portal boundary.

## Tailwind v4 / theme rules

Global theme infrastructure belongs in `src/index.css`. Avoid platform-specific component CSS hacks unless there is a demonstrated native platform requirement.

### Critical Tailwind v4 border fix

Tailwind v4 defaults unspecified border colors to `currentColor`. This caused macOS borders to appear black in light mode and white in dark mode because the border inherited the text color.

Keep this base-layer fallback:

```css
@layer base {
  *,
  ::before,
  ::after,
  ::backdrop,
  ::file-selector-button {
    border-color: var(--border);
  }
}
```

Do not remove it or replace it with macOS-specific border colors.

Theme tokens remain semantic and shared between platforms. Current important values include:

- Light background: `--background: oklch(1 0 0)`
- Light border/input/sidebar-border use the shadcn-style OKLCH tokens.
- Dark primary text is intentionally softened to `--foreground: oklch(0.92 0 0)` to avoid overly bright desktop text.
- App outer surface uses `bg-background`, not `bg-muted/20`.

Specific utility classes such as `border-destructive`, `border-emerald-*`, `border-transparent`, etc. must continue to override the base border fallback.

## Account and credential rules

Credentials are sensitive. Never move them to plaintext storage merely to simplify macOS behavior.

- Windows: preserve the existing DPAPI-backed storage behavior.
- macOS: use macOS Keychain.
- macOS saved accounts use one CodexGauge-owned credential vault plus in-process caching; avoid one Keychain read/write per account per refresh.
- Avoid rewriting an unchanged Keychain payload.
- Preserve migration behavior for older per-account Keychain entries when present.
- CodexGauge must only access credentials it created; do not enumerate or read unrelated Keychain items.
- `~/.codex/auth.json` is the current Codex CLI login state and is conceptually separate from CodexGauge's saved-account vault.

### Account actions

- A single saved account must never show a meaningless "Switch" action.
- The only account may be deleted; deleting the only/current account must also clear the current Codex auth state so it is not immediately re-imported.
- With multiple accounts, the current active account must normally be switched away from before deletion.
- Delete is an icon-only action with tooltip/accessible label unless product requirements explicitly change it.

## Add-account / re-authentication flow

Adding an account is a cancellable login session, not a blocking command.

Required behavior:

1. User explicitly starts generation of a sign-in link.
2. CodexGauge returns and displays the URL.
3. Do **not** automatically open the default browser.
4. Provide both `Copy link` and `Open in browser` so users can choose a non-default browser.
5. Poll the login session asynchronously.
6. The dialog can always be closed while waiting; closing must cancel/terminate the backend login session.
7. `Regenerate sign-in link` cancels the old session before creating a new one.
8. Protect against stale async responses: an old start request must not resurrect a closed/replaced session.
9. Do not leave orphaned Codex/app-server login processes after close/retry.

Long login URLs must be visually truncated with ellipsis; the copy/open actions use the complete URL.

## Codex CLI process rules

macOS GUI apps do not reliably inherit the user's interactive shell `PATH`.

- Reuse the existing Codex CLI resolver/path-search logic.
- Do not introduce new direct `Command::new("codex")` call sites that bypass the resolver.
- Common macOS installation locations (Homebrew, npm global, Volta, Bun, asdf/mise, pnpm, nvm/fnm, etc.) must remain discoverable through the existing resolver.
- When switching/deleting/re-authenticating accounts, preserve the existing coordination with Codex processes and file watchers.

## Proxy rules

Custom proxy mode must explicitly set all common variants for Codex child processes because macOS GUI applications may not inherit shell proxy variables and Codex may use more than one networking path:

```text
HTTP_PROXY
HTTPS_PROXY
ALL_PROXY
http_proxy
https_proxy
all_proxy
NO_PROXY
no_proxy
```

`NO_PROXY/no_proxy` must include local loopback addresses.

Proxy connection testing is network reachability testing, not account-auth testing.

- Current probe target: `https://chatgpt.com/`
- Do not use `account/rateLimits/read` or another authenticated Codex endpoint as the proxy test.
- A valid HTTP response from ChatGPT means DNS/TCP/TLS/proxy routing reached the target even if the HTTP status is not a successful account-auth status.
- Authentication failures such as `401 token_invalidated` must be reported as account/login problems, not as proxy failures.
- Custom-proxy UI should not repeat the entered URL in a redundant "detected proxy" message. Connection-test results are a separate status.

## Notifications

The current app sends desktop notifications through the Tauri notification plugin from Rust. Preserve cross-platform native notification behavior. Reset notifications must remain independent from proxy/account UI state.

## i18n

- Supported UI languages: English and Simplified Chinese.
- New production UI strings should be added to both locale resources rather than hardcoded in components.
- Keep error localization mappings synchronized when adding new Rust/backend error messages that surface to users.

## UI consistency

- Reuse existing shadcn/Base UI primitives and Tailwind tokens.
- Keep system fonts via the current font stack; do not force Windows typography onto macOS or vice versa.
- Avoid raw native form controls when platform-dependent appearance would be visibly inconsistent; use the project's styled primitives/patterns.
- Do not create an entire macOS-specific visual theme. Only platform-specific window/system behavior should differ.
- Avoid fixing WebView differences with one-off macOS color overrides before checking computed CSS and token resolution.

## Release workflow

- Windows release remains Windows installer output.
- macOS release remains one Universal DMG for Intel + Apple Silicon.
- GitHub Release Notes are generated automatically from the previous tag/release to the current tag (`generateReleaseNotes: true`).
- Do not commit Apple certificates, signing passwords, tokens, Codex credentials, or other secrets.

## Validation before considering a change complete

For bounded frontend changes, at minimum verify the relevant interaction manually on both themes. For cross-platform/window/account work, validate the applicable items below:

```text
bun install
bun run build
bun tauri dev
```

Rust-side changes should also pass Cargo checks/builds when the environment permits.

macOS release validation should include a real packaged build, not only dev mode:

```text
bun tauri build --target universal-apple-darwin
```

Important manual regression checks:

- Windows title controls still work.
- macOS native traffic lights remain aligned at x=13/y=16.
- Dialogs never overlap the title bar and do not jump when content/tab height changes.
- Settings dialog remains fixed while tab content scrolls internally.
- Light background is white; dark foreground is not excessively bright.
- Default borders resolve to `var(--border)`, not `currentColor`.
- Add-account session can be copied/opened/cancelled/regenerated without orphan processes.
- Single-account action set has delete but no switch.
- Proxy test does not misclassify invalid Codex authentication as a proxy failure.
- Existing Windows account storage and switching behavior still work.

If the local environment cannot run Bun/Rust/Tauri, say so explicitly; do not claim a build/test passed based only on static inspection.
