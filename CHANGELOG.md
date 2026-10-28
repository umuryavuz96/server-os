# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com), and the project follows [Semantic Versioning](https://semver.org).

## [0.1.0] - Unreleased

First public preview.

### Added
- Mac screen: with `integrations.screen.enabled`, the panel shows this Mac's screen in the browser (noVNC 1.7.0 over `GET /api/v1/screen/ws`, piped to Screen Sharing on 127.0.0.1:5900). Permissions → "Fix on the Mac screen" opens the right System Settings pane, shows the screen, and re-checks when you close it. Owner only (admin key or a paired device, never the agent), same-origin, one session at a time, idle timeout and hard cap, audited. Apple's login (RFB type 30) works on plain http too, through a small AES fallback for browsers without WebCrypto. The setup wizard reports whether Screen Sharing is on. See `docs/permissions.md`.
- macOS permissions: the server lists the privacy permissions it needs (Full Disk Access, Local Network, volumes, folders, microphone) with why, which program holds the grant, status and a System Settings link. Shown in System → Permissions, as an Overview banner when a required one is missing, in the setup wizard (new step 8) and at `/api/v1/permissions`. See `docs/permissions.md`.
- `integrations.houseVoice` and `integrations.channelsDir` replace the hardcoded desk-speaker paths and tmux session names; the feature stays off unless configured.
- Live web panel: vitals with range charts, apps with on/off switches, jobs, alerts, ports, storage, logs and traces over one SSE stream.
- Discover: search self-hostable apps from several catalogs and install with Docker Compose or Homebrew.
- Built-in scheduler with shell, Claude prompt and HTTP jobs, run history and webhooks.
- JSON dashboards, structured logs with OpenTelemetry field names, trace ids, audit log, optional OTLP export.
- Versioned API under `/api/v1` described by `spec/openapi.yaml`, with device-token pairing.
- Root agent kit (`agent/`): instructions, skills, an MCP server and an audit hook.
- Setup wizard (`server-os-setup`) for macOS and Linux, launchd and systemd units, Homebrew formula.
- Demo mode: `SERVER_OS_DEMO=1` serves made-up data for screenshots and trying the UI.
- Native bot manager: without Claude OS, Server OS runs Claude Code bots itself in tmux sessions (`sos-<bot>`, prefix configurable under `bots.prefix`): create (model, effort, permission mode, optional Telegram token variable), start fresh or resume, stop, restart, delete, live terminal, send prompt, history and CLAUDE.md editing. New bot folders are pre-trusted so they don't stall on the trust prompt.
- Bot workspaces for native bots: per-bot scope (folders, network, Claude Code sandbox), tool presets (safe, dev, full) with custom allow/deny rules, skill/plugin/MCP picker, ticked `~/.env` secrets only (`env -i` launch), optional isolated `CLAUDE_CONFIG_DIR`, Telegram owner pre-approval in `access.json`, and an identity block in `CLAUDE.md`. All written as Claude Code config in the bot's folder; edited in the new Workspace tab.
- `bots.provider: both`: Claude OS bots and native bots side by side in one Bots list. Native bots can adopt an existing folder in place (`dir`), keep their agmsg team (`team`) and Telegram state folder (`telegramStateDir`), and keep their own `.mcp.json` servers on. New workspace switch *Read anywhere*. Native bots get `~/.bun/bin` on their PATH (the Telegram plugin runs on bun).
- Native bots no longer inherit the owner's global `~/.claude/CLAUDE.md` and rules by default: a per-bot "Use my global instructions" switch controls `claudeMdExcludes` in the bot's settings.
- Native bots keep their agmsg inbox stream alive: Claude Code ends a Monitor after 30 minutes and agmsg doesn't re-arm it, so Server OS reads the expiry from the bot's transcript and, once the bot is idle, sends one short re-arm turn (no model polling).
- Bots talk to each other: every native bot joins the agmsg team `bots.team` (default `server-os`) with monitor delivery; the Bots tab shows each bot's team and last messages, and how to install agmsg when it's missing.

### Notes
- New native bots default to the `dontAsk` permission mode with the `safe` preset and only their own folder in scope.
- The Bots tab uses Claude OS when `integrations.claudeOS` is set (as before) and the native manager otherwise; `bots.provider` picks one explicitly. Without tmux or the `claude` CLI and without Claude OS, the tab is hidden.
- Machine-specific integrations (`integrations.cron`, `integrations.catalog`, `stateDir`) are off unless set in `config/server-os.yaml`.
- The pre-rename names `SERVER_DASH_HOME`, `config/server-dash.yaml` and the `X-Server-Dash-Secret` webhook header are still accepted.
