<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/wordmark-dark.svg">
  <img src="docs/assets/brand/wordmark-light.svg" alt="Server OS" width="320">
</picture>

### A home server you run with an AI agent.

Live panel · app on/off switches · jobs · alerts · a root [Claude Code](https://claude.com/claude-code) agent · iPhone app (coming soon)

[![CI](https://github.com/umuryavuz96/server-os/actions/workflows/ci.yml/badge.svg)](https://github.com/umuryavuz96/server-os/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/umuryavuz96/server-os?include_prereleases)](https://github.com/umuryavuz96/server-os/releases) ![Platform: macOS first, Linux experimental](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20(experimental)-lightgrey) ![Status: early preview](https://img.shields.io/badge/status-early%20preview-orange)

[**Install**](#install) · [**Features**](#features) · [**Screenshots**](#screenshots) · [**Docs**](#documentation) · [**iOS app**](#ios-app)

<br>

<img src="docs/assets/static/overview.png" alt="Server OS overview: memory, CPU, disk, swap and network tiles, plus what needs attention" width="900">

</div>

> **Early preview.** Server OS runs a real home server today, but expect rough edges and breaking changes before 1.0. **macOS is the main platform; Linux is experimental** (the installer and service are tested on Ubuntu 24.04 arm64).

## Why Server OS

- **One place for the whole box.** Docker apps, launchd services, VMs, scheduled jobs, ports, logs and disk space in a single live panel, over one SSE stream with no polling.
- **Switches that work.** Every app has a real on/off switch. It asks first, and the change goes into an audit log.
- **An agent that does the chores.** A pre-instructed Claude Code session, on your own Claude subscription, installs apps, schedules jobs, diagnoses problems and explains what happened.
- **Yours, and open.** Self-hosted, MIT licensed, plain files in `~/server-os`, and a documented [OpenAPI](spec/openapi.yaml) API. Nothing leaves your machine unless you add an integration.

## Features

### Monitor

<table>
<tr>
<td width="46%" valign="top">

**Live vitals.** CPU, memory, disk, swap and network with sparklines and range charts. A "needs attention" list sits on top.

**Logs and traces.** Structured JSON logs with OpenTelemetry field names. Errors are grouped, and any W3C trace id opens as a timeline.

**Ports.** Every listening port, who owns it and who can reach it.

</td>
<td width="54%">

<img src="docs/assets/motion/vitals.gif" alt="Animated: gauges and sparklines moving as vitals change" width="520">

</td>
</tr>
</table>

### Control

<table>
<tr>
<td width="46%" valign="top">

**Apps with on/off switches.** Docker Compose apps, launchd services and VMs. See status, RAM and uptime, and stop or start each one behind a confirm dialog.

**Discover.** Search 1,600+ self-hostable apps from [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted-data), the CasaOS App Store, LinuxServer.io, Homebrew and curated recipes. Install with one click (Docker Compose or Homebrew) and watch it step by step. Apps with no automatic method can be handed to the agent.

**Storage.** Volumes, where the space goes, and one-tap cleanups.

**macOS permissions.** Which privacy grants (Full Disk Access, Local Network, …) each feature needs, whether they are granted, and a one-click way to System Settings, in the setup wizard and the panel. See [macOS permissions](docs/permissions.md).

**Mac screen / Server screen.** macOS only accepts a privacy switch from a person at the Mac. Turn on `integrations.screen` and the panel shows the machine's own screen through noVNC (macOS Screen Sharing, or a VNC server such as x11vnc, wayvnc, TigerVNC or krfb on Linux), so you can click that switch from any browser, phone included. Owner only, one session at a time, closes when idle, audited. On Linux the Permissions page lists the access Server OS needs (Docker group, readable disks, lingering, firewall) with commands to copy.

</td>
<td width="54%">

<img src="docs/assets/motion/toggle.gif" alt="Animated: stopping and starting Jellyfin from the app drawer, each behind a confirm dialog" width="520">
<br><br>
<img src="docs/assets/motion/install.gif" alt="Animated: searching Discover for FreshRSS and installing it step by step" width="520">

</td>
</tr>
</table>

### Automate

<table>
<tr>
<td width="46%" valign="top">

**Jobs.** A built-in scheduler (cron or `@every 10m`). A job is a shell command, a **Claude prompt** (run with `claude -p` on your subscription) or an HTTP check. Run history keeps output, exit code and trace id.

**Webhooks.** Every job can have a webhook, and existing webhook listeners can be watched.

**Alerts.** Messages from the last 24 hours, grouped by job.

**Dashboards as JSON.** A 12-column grid of cards (charts, gauges, apps, jobs, logs, Claude usage, text). Edit them in the panel and share them as files.

</td>
<td width="54%">

<img src="docs/assets/motion/jobs.gif" alt="Animated: running the backup-photos job, with the status flipping to running and the log streaming in" width="520">

</td>
</tr>
</table>

### Agents

<table>
<tr>
<td width="46%" valign="top">

**The root agent.** `agent/` holds its `CLAUDE.md`, nine skills (add-app, add-job, add-webhook, clean-disk, diagnose, finish-app, remove-app, update-server, weekly-report) and a dependency-free **MCP server** that gives Claude the whole API as tools. A hook records every shell command and file edit it makes.

**Bots.** Run Claude Code bots from the panel: create one (model, effort, permissions, optional Telegram), start it fresh or resume a past session, read its live feed and terminal, send messages, and change model or effort. Server OS runs each bot in its own tmux session; all it needs is `tmux` and the `claude` CLI.

**Agent workspaces.** Each bot is its own agent: its own folder and identity, a scope (folders, network, optional sandbox), a tool policy (safe, dev or full plus your rules), its own skills, plugins and MCP servers, only the secrets you tick, and optionally its own Claude config. It is all written as Claude Code settings in the bot's folder. Bots message each other, and you, through [agmsg](https://github.com/fujibee/agmsg). See [Bot workspaces](docs/configuration.md#bot-workspaces).

**Audit log.** Who did what: device, web panel, agent or webhook.

</td>
<td width="54%">

<img src="docs/assets/static/bots.png" alt="Bots page: a Claude Code session chat with its controls" width="520">

</td>
</tr>
</table>

### Mobile

<table>
<tr>
<td width="46%" valign="top">

**iPhone and iPad apps** *(in progress, not available yet)*. Pair with a one-time 6-digit code (or QR), then watch vitals, flip switches, run jobs and read alerts from anywhere you can reach the server. Devices get their own revocable tokens.

</td>
<td width="54%" align="center">

<img src="docs/assets/static/mobile-overview.png" alt="Overview on a phone" width="125">
<img src="docs/assets/static/mobile-apps.png" alt="Apps on a phone" width="125">
<img src="docs/assets/static/mobile-jobs.png" alt="Jobs on a phone" width="125">

</td>
</tr>
</table>

**And a real API.** Everything lives under `/api/v1`, described in [`spec/openapi.yaml`](spec/openapi.yaml) (OpenAPI 3.1). Errors follow RFC 9457, and traces follow W3C `traceparent`. Optional OTLP export ships logs to your collector.

## Screenshots

All shots come from [demo mode](#try-it-without-installing) with made-up data.

<details>
<summary><b>Show the gallery</b></summary>
<br>

<table>
<tr>
<td width="50%"><img src="docs/assets/static/apps.png" alt="Apps: status, RAM, uptime, filter by group"><br><sub><b>Apps.</b> Status, RAM, uptime, filter by group.</sub></td>
<td width="50%"><img src="docs/assets/static/app-detail.png" alt="App drawer with rocker switch, health and uptime"><br><sub><b>App drawer.</b> Rocker switch, health and uptime.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/jobs.png" alt="Jobs: next up, status, last and next run"><br><sub><b>Jobs.</b> Next up, status, last and next run.</sub></td>
<td><img src="docs/assets/static/job-log.png" alt="One job with its command and log"><br><sub><b>Job log.</b> One job with its command and output.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/alerts.png" alt="Alerts over 24 hours grouped by job"><br><sub><b>Alerts.</b> 24 hours, grouped by job.</sub></td>
<td><img src="docs/assets/static/webhooks.png" alt="Webhook receivers and their state"><br><sub><b>Webhooks.</b> Receivers and their state.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/storage.png" alt="Storage: volumes, where the space goes, cleanups"><br><sub><b>Storage.</b> Volumes, where the space goes, one-tap cleanups.</sub></td>
<td><img src="docs/assets/static/logs.png" alt="Logs: grouped problems and structured log lines"><br><sub><b>Logs.</b> Grouped problems and structured lines.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/discover.png" alt="Discover: editor's pick and Instead of"><br><sub><b>Discover.</b> Editor's pick, "Instead of…" and more.</sub></td>
<td><img src="docs/assets/static/discover-install.png" alt="An install in progress with its checklist"><br><sub><b>Install.</b> Progress with a checklist.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/ports.png" alt="Ports: every listening port, owner and reachability"><br><sub><b>Ports.</b> Owner and who can reach it.</sub></td>
<td><img src="docs/assets/static/dashboards.png" alt="A JSON dashboard of cards"><br><sub><b>Dashboards.</b> A JSON dashboard of cards.</sub></td>
</tr>
<tr>
<td><img src="docs/assets/static/welcome.png" alt="First visit: create the owner account"><br><sub><b>Welcome.</b> Create the owner account.</sub></td>
<td><img src="docs/assets/static/pairing.png" alt="Connect a device with a QR code and one-time code"><br><sub><b>Pairing.</b> QR code and one-time code.</sub></td>
</tr>
</table>

<p align="center">
<img src="docs/assets/static/mobile-alerts.png" alt="Alerts on a phone" width="170">
<img src="docs/assets/static/mobile-discover.png" alt="Discover on a phone" width="170">
</p>

The full page: [`overview-full.png`](docs/assets/static/overview-full.png). Captions and MP4 clips: [`docs/assets/`](docs/assets/README.md).

</details>

## Install

**macOS** is the supported platform. **Linux is experimental**: the one-line installer, signed release check, systemd user service and updater are tested on a fresh Ubuntu 24.04 (arm64). Run `sudo loginctl enable-linger $USER` so the service survives logout, and run the installer from a terminal (it asks questions).

```sh
curl -fsSL https://raw.githubusercontent.com/umuryavuz96/server-os/main/install/install.sh | sh
```

<details>
<summary><b>Homebrew, Docker, from source</b></summary>
<br>

**Homebrew**

```sh
brew install umuryavuz96/tap/server-os && server-os-setup
```

**Docker** (Linux hosts; the native service is the recommended install)

```sh
docker run -d -p 3094:3094 -v server-os:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/umuryavuz96/server-os
```

The Docker socket lets Server OS start, stop and install containers on the host. Leave it out for a read-only panel.

**From source** (needs [Bun](https://bun.sh); Go for the wizard)

```sh
git clone https://github.com/umuryavuz96/server-os && cd server-os
bun install
bun run start            # panel on http://localhost:3094, home folder ~/server-os
```

</details>

The setup wizard:

1. Checks the machine: OS, disk, Bun, Docker, Tailscale.
2. Installs Claude Code and checks your login.
3. Asks for a name, a home folder and how you reach the server (Tailscale, local network, or your own proxy).
4. Lays out `~/server-os`.
5. Installs the service (launchd, or systemd on Linux).
6. Shows the panel URL with a pairing code and QR.
7. Opens a terminal running `claude` in `~/server-os/agent`.

Re-run it any time: it repairs and never overwrites your changes. `server-os-setup --dry-run` shows every step without doing it.

### Try it without installing

Demo mode serves a made-up "homelab" and reads nothing from your machine:

```sh
SERVER_OS_DEMO=1 SERVER_OS_HOME=$(mktemp -d) bun run start
```

### Use

| | |
|---|---|
| Panel | `http://<server>:3094` (or your Tailscale / proxy URL) |
| Pair a phone | `server-os pair`, then enter the 6-digit code in the app |
| Devices | `server-os devices`, `server-os revoke <id>` |
| Talk to the agent | `cd ~/server-os/agent && claude` |
| API | `GET /api/v1/info`, then see [`spec/openapi.yaml`](spec/openapi.yaml) |

### Updating

Server OS updates itself from signed GitHub releases. No git is involved. Open **Settings** in the panel, or watch for the
"Update available" card on Overview, and press **Update**. The server then:

1. downloads the release and checks the Ed25519 signature on `SHA256SUMS`, then the checksum (it refuses on any mismatch);
2. unpacks it into `~/server-os/versions/<tag>/` and points `~/server-os/current` at it;
3. restarts through launchd or systemd and waits up to 45 s for `/api/v1/health` to report the new version;
4. if the new version doesn't answer, switches back and restarts the previous one. The panel shows "Updated to vX" or
   "Update failed, rolled back" with the reason.

The last two versions are kept. Your config, data, apps and logs live in `~/server-os`, outside the version folders.
Database migrations run when the server starts. Under **Settings** you can pick the channel (stable, or beta for
prereleases) and the automatic mode: off, *tell me* (the default: check once a day) or *install at night* (03:30). The
agent uses the same API (`GET /api/v1/update`, `POST /api/v1/update/check`, `POST /api/v1/update/apply`).

Homebrew installs update with `brew upgrade server-os`, and Docker installs by pulling the new image. A git checkout
(developer mode) can check for updates, but the updater never writes over a working tree, so update it with `git pull`.
Maintainers: see [RELEASING.md](RELEASING.md).

## Configuration

Everything is optional. Config lives in `~/server-os/config/server-os.yaml`; secrets stay in environment variables, never in the file.

```yaml
name: home-server
auth: token                # off | token (only paired devices)
reach: tailscale           # tailscale | local | public

integrations:              # optional links to things already on the machine
  homeAssistant: { url: "http://192.168.1.10:8123", tokenEnv: HA_TOKEN }
  adguard: { url: "http://127.0.0.1:3080", userEnv: ADGUARD_USER, passwordEnv: ADGUARD_PASSWORD }
  unbound: true            # read unbound-control stats
  telegramBots: true       # Claude Code Telegram channels in ~/.claude/channels
  cron:                    # list the user crontab as the Jobs tab
    history: ~/scripts/logs/notify_cron_history.jsonl
otlp:
  endpoint: http://localhost:4318
```

Every key, the environment variables, auth and logging: [`docs/configuration.md`](docs/configuration.md).

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    Web[Vue panel]
    iOS[iPhone / iPad app]
    Agent[Claude Code agent<br/>via MCP]
  end
  subgraph Server["Server OS (Bun + Hono)"]
    API["/api/v1 + SSE"]
    Sched[Scheduler]
    Coll[Collectors]
    Inst[Installer]
    DB[(SQLite + JSONL logs)]
  end
  subgraph Host
    Docker[Docker Compose]
    Launchd[launchd / systemd]
    VMs[VMs]
    Sys[CPU, disk, ports]
  end
  Web & iOS & Agent --> API
  API --> Sched & Coll & Inst
  Sched & Coll & Inst --> DB
  Inst --> Docker
  Coll --> Docker & Launchd & VMs & Sys
```

Everything the panel and the phone do goes through the same documented API, and so does the agent.

```
~/server-os/
├─ config/server-os.yaml    name, auth, port, reach, logging, integrations, otlp
├─ config/recipes/          your own app recipes
├─ agent/                   the root agent: CLAUDE.md, .claude/ (skills, MCP, hooks), inbox/
├─ apps/<id>/               installed apps: app.yaml, compose.yaml, data/
├─ jobs/<id>/job.yaml       built-in jobs
├─ dashboards/<id>.json     JSON dashboards
├─ logs/                    server.jsonl (rotated), audit.jsonl (kept)
└─ data/                    SQLite, catalog cache, icons, admin.key
```

| Folder | What |
|---|---|
| `server/` | Bun + Hono server: API, SSE, collectors, scheduler, catalog, installer, logs |
| `web/` | Vue 3 panel |
| `setup/` | the wizard (Go, Bubble Tea v2) |
| `agent/` | the root agent kit |
| `recipes/` | curated app recipes |
| `spec/` | OpenAPI and dashboard JSON Schema |
| `install/` | install script, launchd/systemd units, Homebrew formula |

## iOS app

> **Status: in progress, not available yet.** A public TestFlight link will be shared here once the beta is ready.

Native iPhone and iPad apps (SwiftUI) talk to the same API and pair with `server-os pair`. They live in a separate repository.

## Documentation

- [Configuration](docs/configuration.md)
- [App recipes](docs/recipes.md)
- [OpenAPI spec](spec/openapi.yaml)
- [Screenshots and clips](docs/assets/README.md)
- [Changelog](CHANGELOG.md)

## Roadmap

- [ ] First tagged release (0.1.0) with published binaries and Homebrew tap
- [ ] Test and harden Linux (systemd, Docker)
- [ ] Public iOS and iPadOS app release
- [ ] More curated app recipes
- [ ] API stability promise at 1.0

Ideas and bugs are welcome in [issues](https://github.com/umuryavuz96/server-os/issues).

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

```sh
bun install
bun run dev:web                  # panel with hot reload
bun test server && bun run typecheck
cd setup && go test ./...
```

## Security

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md) and do not open a public issue. With `auth: off`, anyone who can reach the server can use it, so only use that behind Tailscale or a trusted network.

## Credits

- **Catalog data:** [awesome-selfhosted-data](https://github.com/awesome-selfhosted/awesome-selfhosted-data) (CC BY-SA 3.0), [CasaOS AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore) (Apache-2.0), [LinuxServer.io](https://www.linuxserver.io), [Homebrew](https://formulae.brew.sh).
- **Logos:** [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Apache-2.0).
- **Wizard:** built with [Charm](https://charm.land).

## License

MIT. See [LICENSE](LICENSE).
