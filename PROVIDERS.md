# Providers

Each provider fetches usage data via a distinct auth strategy. This file documents the strategy, data source, and responsible file for auditing.

---

## Claude

**File:** `src/providers/claude.ts`

| Strategy | How |
|----------|-----|
| **OAuth (primary)** | Reads `~/.claude/.credentials.json` → access + refresh token. Falls back to VS Code secret store (`claude.credentials`). Auto-refreshes via `https://claude.ai/api/auth/oauth/token`. |
| **Session cookie (fallback)** | VS Code secret store (`claude.sessionCookie`). Hits `https://claude.ai/api/organizations/{org}/usage`. |

Usage endpoint: `https://api.anthropic.com/api/oauth/usage`

---

## Codex (OpenAI Codex CLI)

**File:** `src/providers/codex.ts`

| Strategy | How |
|----------|-----|
| **OAuth (primary)** | Reads `~/.codex/auth.json` → access + refresh token. Auto-refreshes via `https://chatgpt.com/backend-api/auth/session` if token is older than 8 days. |
| **CLI PTY (fallback)** | Spawns `codex` binary in sandbox mode (`-s read-only -a untrusted app-server`) and reads JSON from its stdio. |

Usage endpoint: `https://chatgpt.com/backend-api/wham/usage`

---

## Mistral

**File:** `src/providers/mistral.ts`

| Strategy | How |
|----------|-----|
| **Firefox cookie import (auto)** | Reads `~/Library/Application Support/Firefox/Profiles/*/cookies.sqlite` via `sqlite3` CLI; extracts `admin.mistral.ai` cookies. macOS only. |
| **Manual cookie (fallback)** | VS Code secret store (`mistral.adminCookie`). Paste a full `Cookie:` header from `admin.mistral.ai`. |

Usage endpoints:
- Monthly billing: `https://admin.mistral.ai/api/billing/v2/usage`
- Vibe quota: `https://console.mistral.ai/api-ui/trpc/billing.vibeUsage`

---

## DeepSeek

**File:** `src/providers/deepseek.ts`

| Strategy | How |
|----------|-----|
| **API key** | `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` env var, or VS Code secret store (`deepseek.apiKey`). |

Usage endpoints:
- Balance: `https://api.deepseek.com/user/balance`
- Monthly cost: `https://platform.deepseek.com/api/v0/usage/amount` + `/cost`

---

## Antigravity (Google Cloud Code / Gemini)

**File:** `src/providers/antigravity.ts`

| Strategy | How |
|----------|-----|
| **antigravity-usage OAuth (primary)** | Reads tokens from `antigravity-usage` CLI file storage: `~/.config/antigravity-usage/accounts/{email}/tokens.json` (or legacy `tokens.json`). Auto-refreshes by delegating to `antigravity-usage refresh`. |
| **Manual OAuth token (fallback)** | VS Code secret store (`antigravity.googleOAuthToken`). No auto-refresh. |
| **Local language server (probe)** | Queries `https://localhost:{port}/exa.language_server_pb.LanguageServerService/GetQuotaSummary` — port discovered from running Antigravity process args. Used as a secondary signal. |

Usage endpoint: `https://cloudcode-pa.googleapis.com` (`loadCodeAssist` + `fetchAvailableModels`)
