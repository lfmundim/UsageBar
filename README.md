# UsageBar

**AI coding assistant usage in your VS Code status bar.**

UsageBar is a VS Code extension that displays real-time usage metrics—token counts, rate limit windows, costs, and account balances—for your AI coding tools, directly in the editor's status bar. A sidebar settings panel lets you configure each provider without leaving VS Code.

> Inspired by and based on [CodexBar](https://github.com/steipete/CodexBar) by [@steipete](https://github.com/steipete) — a macOS menu bar app with the same provider coverage. UsageBar brings the same philosophy cross-platform into VS Code.

---

## Supported Providers

| Provider | What is tracked | Auth method |
|---|---|---|
| **Claude Code** (Anthropic) | Session %, weekly %, model-specific windows, monthly cost | OAuth credentials, session cookie, or CLI (`claude /usage`) |
| **OpenAI Codex CLI** | 5-hour session %, weekly %, credits balance | OAuth (`~/.codex/auth.json`), CLI RPC, or browser cookie |
| **Mistral** | Monthly spend (pay-as-you-go) or Vibe plan % | Browser session cookie (auto-imported or manual) |
| **DeepSeek** | API credit balance (USD or CNY) | API key (`DEEPSEEK_API_KEY` env or VS Code secret) |
| **Antigravity** (Google Cloud Code) | Gemini + Claude/GPT quota %, reset times | Local language server, `agy` CLI, or Google OAuth |

---

## Features

- **Status bar items** — one per enabled provider; shows usage % or balance with a compact text progress bar
- **Configurable refresh** — manual, or automatic at 1 / 2 / 5 / 15 / 30 minute intervals
- **Sidebar settings panel** — enable/disable providers, input API keys, choose auth source, configure display options
- **Secure secret storage** — API keys stored in VS Code's built-in secret store (OS keychain-backed), never in plaintext settings
- **Auto cookie import** — reads browser session cookies from Safari, Chrome, and Firefox for providers that use web auth (macOS)
- **Cost scanning** — optionally scans local JSONL session logs from Claude and Codex CLIs to compute daily token costs
- **Cross-platform** — macOS, Linux, Windows

---

## Installation

Install from the VS Code Marketplace:

1. Open VS Code
2. Press `Ctrl+P` / `Cmd+P` → type `ext install lfmundim.usagebar`
3. Reload VS Code
4. Open the **UsageBar** panel in the sidebar (activity bar icon) to configure providers

Or install the `.vsix` directly:

```bash
code --install-extension usagebar-x.y.z.vsix
```

---

## Quick Start

### Claude Code

UsageBar automatically reads Claude CLI credentials from `~/.claude/.credentials.json` (created when you log in with `claude login`). No manual setup required for most users.

To use the web API instead, paste a `Cookie:` header from a logged-in `claude.ai` request in the sidebar settings.

### OpenAI Codex CLI

UsageBar reads OAuth credentials from `~/.codex/auth.json` (created by `codex login`). No manual setup needed.

### Mistral

UsageBar can import your `admin.mistral.ai` session cookie automatically from your default browser (macOS only). On Linux/Windows, paste the cookie manually in the sidebar settings.

### DeepSeek

Set `DEEPSEEK_API_KEY` in your environment, or enter the key in the sidebar settings. Get a key at https://platform.deepseek.com/api_keys.

### Antigravity

If the Antigravity app or `agy` CLI is installed and running, UsageBar detects it automatically via the local language server. No additional config required.

---

## Configuration

All settings live under the `usagebar.*` VS Code configuration namespace.

| Setting | Default | Description |
|---|---|---|
| `usagebar.refreshInterval` | `"5m"` | Refresh frequency: `"manual"`, `"1m"`, `"2m"`, `"5m"`, `"15m"`, `"30m"` |
| `usagebar.providers.claude.enabled` | `true` | Enable Claude status bar item |
| `usagebar.providers.claude.source` | `"auto"` | Auth source: `"auto"`, `"oauth"`, `"web"`, `"cli"` |
| `usagebar.providers.codex.enabled` | `true` | Enable Codex status bar item |
| `usagebar.providers.codex.source` | `"auto"` | Auth source: `"auto"`, `"oauth"`, `"cli"` |
| `usagebar.providers.mistral.enabled` | `true` | Enable Mistral status bar item |
| `usagebar.providers.mistral.cookieSource` | `"auto"` | Cookie source: `"auto"`, `"manual"` |
| `usagebar.providers.deepseek.enabled` | `true` | Enable DeepSeek status bar item |
| `usagebar.providers.antigravity.enabled` | `true` | Enable Antigravity status bar item |
| `usagebar.providers.antigravity.source` | `"auto"` | Source: `"auto"`, `"cli"`, `"oauth"` |
| `usagebar.display.showProviderLabel` | `true` | Show provider name prefix in status bar |
| `usagebar.display.progressBarStyle` | `"blocks"` | Progress bar style: `"blocks"`, `"dots"`, `"percent"` |
| `usagebar.costTracking.enabled` | `false` | Enable local JSONL cost scanning for Claude and Codex |
| `usagebar.costTracking.historyDays` | `30` | Days of JSONL history to scan |

API keys and cookies are stored securely via VS Code's secret storage API (not in `settings.json`).

---

## Architecture

```
src/
  extension.ts              # activate() / deactivate()
  providers/
    base.ts                 # ProviderInterface, UsageSnapshot types
    claude.ts               # Claude Code provider
    codex.ts                # OpenAI Codex CLI provider
    mistral.ts              # Mistral provider
    deepseek.ts             # DeepSeek provider
    antigravity.ts          # Antigravity provider
  statusBar/
    controller.ts           # Manages StatusBarItem instances
    renderer.ts             # Text + progress bar rendering
  sidebar/
    settingsProvider.ts     # WebviewViewProvider for sidebar panel
    webview/                # HTML/CSS/JS for the settings UI
  store/
    usageStore.ts           # State holder; orchestrates refresh timer
  auth/
    cookieImporter.ts       # Browser cookie extraction (macOS)
    oauthManager.ts         # Claude + Codex OAuth token management
  config/
    settings.ts             # VS Code configuration wrapper
```

Each provider implements `ProviderInterface`:

```typescript
interface ProviderInterface {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  fetch(): Promise<UsageSnapshot>;
}
```

---

## Contributing

Pull requests welcome. Please open an issue first for large changes.

```bash
git clone https://github.com/lfmundim/UsageBar
cd UsageBar
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

---

## Credits

- [CodexBar](https://github.com/steipete/CodexBar) by [@steipete](https://github.com/steipete) — the macOS menu bar app that inspired this project. The provider integration logic, API endpoints, auth strategies, and data parsing approaches in UsageBar are directly derived from studying CodexBar's open-source implementation.

---

## License

MIT — see [LICENSE](LICENSE).
