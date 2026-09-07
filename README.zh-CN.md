# CodexGauge

[English](README.md) | **简体中文**

CodexGauge 是一个面向 Windows 的本地桌面应用，用于管理多个由用户本人拥有和控制的 Codex 账号、查看 Codex 用量限制，并手动切换当前使用的账号。

项目基于 Tauri 2、React、TypeScript、Vite、Bun、Tailwind CSS 和 shadcn/ui 构建。

> **独立项目声明：** CodexGauge 是独立开源项目，与 OpenAI 无隶属、合作、认证、赞助或官方背书关系。

## 功能

- 查看 Codex 5 小时和每周用量限制。
- 显示本地化的额度重置时间。
- 查看 Banked rate-limit reset 数量及其过期信息。
- 通过官方 Codex CLI 登录流程添加多个由用户本人拥有的 Codex 账号。
- 手动切换当前 Codex 账号。
- 修改本地账号别名。
- 删除非当前账号。
- 共用一套 `CODEX_HOME`，让 Codex 的 sessions、history、memory 和配置继续共享。
- 使用 Windows DPAPI 为当前 Windows 用户加密保存账号凭据备份。
- 监听 Codex `auth.json` 更新，并同步保存当前账号的最新凭据。
- 为 CodexGauge 启动的 Codex 进程配置：
  - 不使用代理；
  - Windows / 系统代理；
  - 自定义 HTTP / HTTPS 代理。
- 配置自动刷新用量。
- 网络不可用时保留上一次成功获取的用量数据。
- 支持英文和简体中文，并可自动跟随系统语言。
- 支持跟随系统、浅色和深色主题。
- 主窗口关闭后继续在 Windows 系统托盘运行。
- 可通过托盘恢复 CodexGauge，或从托盘菜单明确退出。
- 检查应用新版本，并安装通过签名验证的 GitHub Releases 更新。
- 在本地写入诊断日志用于排查问题，并避免主动记录认证 Token。

## 使用要求

### Windows

CodexGauge 当前以 Windows 为主要目标平台。

### 官方 Codex CLI

必须安装官方 OpenAI Codex CLI，并确保 `codex` 命令可以从 `PATH` 中访问。

检查：

```powershell
codex --version
```

如果 CodexGauge 无法检测到 Codex CLI，会阻止进入主界面，并提示用户先完成安装。

不要求安装 Codex Desktop / ChatGPT Desktop。

## 账号切换原理

CodexGauge 使用一套共享的 Codex Home：

```text
%USERPROFILE%\.codex
```

如果用户设置了 `CODEX_HOME`，则使用对应目录。

CodexGauge **不会**为每个账号永久创建一套独立的 Codex Home。sessions、history、memory、配置以及其他 Codex 本地状态继续共用，只在用户手动切换账号时替换当前认证凭据。

切换前，CodexGauge 会先保存当前账号的最新凭据。每个账号的凭据备份使用 Windows DPAPI，并绑定当前 Windows 用户上下文进行加密。

出于安全考虑，当检测到 Codex 正在运行时，CodexGauge 会阻止账号切换。

## 用量数据

CodexGauge 通过官方本地 Codex app-server 协议读取用量：

```text
codex app-server --stdio
```

并请求：

```text
account/rateLimits/read
```

额度窗口根据实际时长识别，而不是直接假设 primary / secondary 的固定顺序：

- `300` 分钟 → 5 小时额度
- `10080` 分钟 → 每周额度

CodexGauge 不实现另一套私有用量 API 客户端。

## 代理设置

CodexGauge 支持三种代理模式。

### 不使用代理

CodexGauge 会从其启动的 Codex 进程中清除代理环境变量，并关闭这些进程的 Codex 系统代理处理。

### 系统代理

CodexGauge 让其启动的 Codex 进程使用 Codex 支持的系统代理行为。

### 自定义代理

支持 HTTP 和 HTTPS，例如：

```text
http://127.0.0.1:7897
```

或：

```text
https://proxy.example.com:443
```

如果没有填写协议，CodexGauge 默认按 HTTP 处理。

CodexGauge 本身不提供代理/VPN 服务，不修改 Windows 全局代理，也不修改 `%USERPROFILE%\.codex\.env`。

## 自动刷新

自动刷新默认开启，默认间隔为 60 秒。

界面提供以下预设：

- 30 秒
- 60 秒
- 2 分钟
- 5 分钟
- 10 分钟

开启后，CodexGauge 会按设定间隔自动刷新用量。

如果无法连接 ChatGPT，CodexGauge 会保留上一次成功获取的用量数据，并暂停自动刷新；连接恢复并成功重试后再继续刷新。

## 语言

CodexGauge 当前内置：

- English
- 简体中文

默认选项为跟随 Windows 系统语言。

用户手动选择语言后，会写入 CodexGauge 本地设置，并在下次启动时恢复。

## 主题

CodexGauge 支持：

- 跟随系统
- 浅色
- 深色

选择“跟随系统”时，CodexGauge 会跟随 Windows 的浅色/深色偏好。

主题切换立即生效，并保存在本地设置中。

## 系统托盘

点击窗口右上角关闭按钮或使用 `Alt+F4` 时，CodexGauge 不会直接退出，而是继续在 Windows 系统托盘运行。

第一次关闭主窗口时，CodexGauge 会先提示用户该行为；确认后，后续关闭将直接隐藏到托盘，不再重复提示。

托盘支持：

- 左键点击恢复并聚焦 CodexGauge；
- `Open CodexGauge`；
- `Quit`。

只有通过 `Quit` 才会真正退出应用。

普通“最小化”按钮仍然只是最小化到 Windows 任务栏。

## 应用更新

CodexGauge 使用 Tauri Updater，通过 GitHub Releases 分发经过签名验证的应用更新。

应用支持：

- 启动时自动检查一次更新；
- 在 `设置 → 关于` 中手动检查更新；
- 安装可用的签名更新；
- 稍后处理；
- 忽略某一个指定版本。

“忽略此版本”只影响自动提醒。用户主动点击“检查更新”时，仍可以看到这个被忽略的版本。

Updater 更新产物必须经过加密签名。Updater 公钥可以嵌入应用配置，而签名私钥必须严格保密。

## 日志

CodexGauge 会在本地写入诊断日志，用于排查网络、Updater、Proxy、账号切换、watcher 等问题。

Windows 下通常位于：

```text
%LOCALAPPDATA%\com.codexgauge.desktop\logs\
```

对于详细内部错误，CodexGauge 可以把完整信息写入日志，而界面只显示更简洁的用户提示。

诊断日志只保存在本地，不会自动上传。

CodexGauge 不应主动记录 access token、refresh token 或完整 `auth.json` 内容。

## 开发

安装依赖：

```powershell
bun install
```

启动 Web 前端：

```powershell
bun run dev
```

启动 Tauri 应用：

```powershell
bun tauri dev
```

构建前端生产版本：

```powershell
bun run build
```

检查 Rust：

```powershell
cd src-tauri
cargo check
cd ..
```

构建 Windows 应用和安装包：

```powershell
bun tauri build
```

Tauri 构建产物位于：

```text
src-tauri\target\release\bundle\
```

## 安全与隐私

- Local-first：CodexGauge 没有自己的应用后端。
- 默认不包含遥测。
- 诊断日志保存在本地，不会自动上传。
- 账号凭据备份通过 Windows DPAPI 为当前 Windows 用户加密。
- CodexGauge 不通过本地 HTTP 服务暴露账号凭据。
- CodexGauge 不实现基于额度的自动账号轮换。
- CodexGauge 不提供共享凭据池或账号共享能力。
- CodexGauge 不会主动把认证凭据以明文形式写入账号元数据。

如果发现与认证或凭据处理有关的安全漏洞，请避免在公开 Issue 中提交 Token、认证文件或其他敏感复现数据。

## 项目范围

CodexGauge 面向由用户本人拥有并控制的账号，提供本地、手动的账号管理能力。

CodexGauge 的设计目标不包括：

- 在多个用户之间共享或汇集认证凭据；
- 自动轮换账号以规避额度限制；
- 提供共享账号或凭据池；
- 提供代理/VPN 服务；
- 将自身描述或包装为 OpenAI 官方产品。

## 许可证

MIT。详见 [LICENSE](LICENSE)。

## 商标声明

CodexGauge 是独立开源项目，与 OpenAI 无隶属、合作、认证、赞助或官方背书关系。

OpenAI 及其相关产品名称、Logo 和标识属于其相应权利人。CodexGauge 的应用身份中不使用 OpenAI Logo 或其他 OpenAI 品牌资产。
