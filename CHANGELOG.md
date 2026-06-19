# Change Log

All notable changes to the "UsageBar" extension will be documented in this file.

## [0.1.0]

### Added

- Status bar items for Claude Code, OpenAI Codex CLI, Mistral, DeepSeek, Antigravity
- Settings panel with per-provider auth configuration
- OAuth credential reading for Claude (`~/.claude/.credentials.json`) and Codex (`~/.codex/auth.json`)
- Browser cookie import from Firefox (macOS) for Mistral
- VS Code secret storage for API keys and cookies
- Configurable refresh intervals: manual, 1m, 2m, 5m, 15m, 30m
- Three progress bar styles: blocks, dots, percent
- Percent display mode toggle: used or remaining
- Warning/error background when usage exceeds 90%/100%
