# Configuration

Server OS reads `config/server-os.yaml` in its home folder (`SERVER_OS_HOME`, default `~/server-os`).
Every key is optional. The wizard writes one for you, and `server-os init` writes a commented template.

```yaml
name: home-server          # shown in the panel, the apps and /api/v1/info
auth: token                # off: anyone who can reach the server may use it (fine behind Tailscale)
                           # token: only paired devices (server-os pair)
port: 3094                 # written by the wizard; the service reads PORT
reach: tailscale           # tailscale | local | public — how the wizard set up access
host: home-server.local    # host name used in links to installed apps
externalDisk: /mnt/data    # a second disk shown next to "/" (also explorable in the Storage tab)
storage:
  logDirs: [~/scripts/logs]   # folders "Trim old logs" prunes (default: logs/ here + ~/Library/Logs on macOS)

logging:
  level: info              # debug | info | warn | error
  maxFileMB: 10            # logs/server.jsonl rotates at this size (audit.jsonl is never rotated)

names:                     # optional: every app gets http://<app>.<suffix> (the setup wizard writes this)
  suffix: home
  dns: adguard             # adguard (one rewrite per name) | wildcard (*.home → this server, set once) | sslip
  caddyfile: /opt/homebrew/etc/Caddyfile   # must contain: import <home>/data/caddy/*.caddy
  ips: [192.168.1.10, 100.64.0.5]          # LAN first, then Tailscale
  adguard: { url: "http://127.0.0.1:3080", envFile: <home>/data/names.env }

stateDir: <home>/data      # where vitals history, uptime buckets and lifecycle events are kept

otlp:                      # optional: also ship logs to an OpenTelemetry collector
  endpoint: http://localhost:4318
  headers: { Authorization: "Bearer …" }

integrations:              # optional links to things already running on the machine
  claudeOS: http://127.0.0.1:3090/api      # optional external bot manager; without it Server OS runs bots itself
  homeAssistant: { url: "http://192.168.1.10:8123", tokenEnv: HA_TOKEN }   # allowDomains: [light, switch, ...] to change what dashboard cards may control
  adguard: { url: "http://127.0.0.1:3080", userEnv: ADGUARD_USER, passwordEnv: ADGUARD_PASSWORD }
  unbound: true                            # read unbound-control stats
  telegramBots: true                       # Claude Code Telegram channels in ~/.claude/channels
  cron:                                    # off unless set: list the user crontab as the Jobs tab
    history: ~/scripts/logs/notify_cron_history.jsonl   # optional: notify-bot JSONL → last-run status + Alerts
    cards: ~/scripts/crontabs/jobs.json                 # optional: job ID cards, see "Job ID cards" below
    logs: ~/scripts/logs                                # optional: per-job <name>.log files
    launchd: com.me.                                    # optional: also list your launchd agents with this label prefix (~/Library/LaunchAgents)
  channelsDir: ~/.claude/channels          # channel folders (launch.command, bot.pid); default for telegramBots, launch flags for claudeOS bots
  house: false                             # feature flag: the 3D House tab. Off unless true (needs homeAssistant); your own plan is saved in config/house.json
  houseVoice:                              # off unless set: the Voice page (chat + desk speaker), see docs/voice-chat.md
    dir: ~/projects/house-voice            # listener project: listen.py, config.json, status.json, .venv
    session: house-voice                   # its tmux session (default house-voice)
    voiceLaunch: ~/.claude/channels/voice/launch.command   # starts the bot's voice session (app voice screen + desk speaker)
    voiceSession: bot-voice                # tmux session for it (default bot-voice)
    # channel: voice                       # the voice bot's channel (default voice)
    # name: Ada                            # the assistant's name in the chat (default: first heading of its CLAUDE.md)
  stt:                                     # optional: speech to text for the voice chat (these are the defaults)
    # whisper: /opt/homebrew/bin/whisper-cli
    # model: ~/.whisper-models/ggml-small.bin   # else ggml-base.bin, ggml-base.en.bin, any ggml-*.bin there
    # ffmpeg: /opt/homebrew/bin/ffmpeg
  speakers:                                # optional: answer on a Home Assistant speaker (e.g. Sonos), output only
    baseUrl: http://192.168.1.10           # this panel as the speaker can reach it on the LAN (it fetches the reply clip)
    entities: [media_player.living_room]   # default: Home Assistant players named "Sonos…"
  elevenLabs: { keyEnv: ELEVENLABS_API_KEY }   # optional: ~/.env variable with an ElevenLabs key (usage card needs "User: read")
  screen:                                  # off unless enabled: System → Mac screen / Server screen (macOS Screen Sharing, or a VNC server on Linux, in the browser)
    enabled: true                          # see docs/permissions.md, "Remote screen"
    resizeDisplay: true                    # macOS: while a web session is open, switch the Mac's display to 1080p/720p (non-HiDPI) so the picture is fast; the original mode is restored on disconnect, idle, takeover, shutdown and next start. true = Screen Sharing's virtual display only, any = a real monitor too, false = never
    # host: 127.0.0.1                      # loopback only (anything else turns the feature off); port: 5900
    # idleMinutes: 5                       # closes after this long without keyboard / pointer input
    # maxMinutes: 30                       # and after this long in any case
  catalog: ~/scripts/svc-control           # off unless set: hand-written catalog.json (+ gates/, icons/) for apps outside the installer
  webhooks:                                # existing webhook listeners to watch
    - { slug: deploy, label: Deploy, description: "push → build", service: com.example.deploy, port: 9000, log: /tmp/deploy.log }

costs:                     # optional: the Usage and Costs tabs (they work without it)
  currency: EUR            # what totals are shown in (default USD)
  usdRate: 0.86            # how many of that currency one USD is worth: list prices in the provider registry are USD (default 1)
  kwhPrice: 0.30           # electricity per kWh in that currency (default 0.30)
  envFile: ~/.env          # file whose variable NAMES are matched against the provider registry (default ~/.env)
  power:                   # this machine's draw; built-in table: server/modules/machinePower.json
    # idleW: 4             # watts at idle (default from the table, matched on the machine model)
    # maxW: 40             # watts under full CPU load
    # haEntity: sensor.server_plug_power   # a Home Assistant power sensor (W or kW, needs integrations.homeAssistant) replaces the estimate
  # modelPrices: ~/server-os/config/model-prices.json   # { "models": [{ "match": "opus", "in": 5, "out": 25 }] } $/MTok, checked before the built-in table

bots:                      # optional: the Bots tab
  provider: native         # native (default without integrations.claudeOS) | claudeOS (default with it) | both
  prefix: sos-             # tmux session prefix for native bots
  team: server-os          # agmsg team every native bot joins (agent name = bot name)
  # agmsg: { dir: ~/.agents/skills/agmsg, storage: ~/agmsg-store }   # another agmsg install / message store
  # telegram: { ownerChatIds: [123456789] }                          # pre-approved in every bot's access.json
  # approvalPing: [python3, ~/scripts/lib/tg_rich.py, --bot, notify, --text]   # run (message appended) when a bot waits on a permission ask
```

Secrets never go in this file. `tokenEnv`, `userEnv` and `passwordEnv` name variables in `~/.env`.

## Bots

The Bots tab works with one of two bot managers:

- **native** (default): Server OS runs every bot itself, as a Claude Code session in a tmux session named `<prefix><bot>`
  (default prefix `sos-`). It only ever lists, reads, types into or stops sessions with that prefix, so tmux sessions
  you started some other way are left alone. Needs `tmux` and the `claude` CLI (signed in once); without them the tab is
  hidden and `#bots` shows a setup hint.
- **claudeOS**: an external Claude OS bot manager at `integrations.claudeOS`. Server OS forwards the lifecycle calls to it.
  Set `bots.provider: native` to use the built-in manager even when `integrations.claudeOS` is set.
- **both**: Claude OS bots and native bots side by side in one list. Calls for a native bot are answered by Server OS,
  every other bot is forwarded to Claude OS, and new bots are created natively. A native bot with the same name as a
  Claude OS bot replaces it in the list, which is how a bot moves over (stop it in Claude OS and disable its launcher
  first: only one poller may use a Telegram token). Without tmux or `claude`, this falls back to Claude OS alone.

Native bots are kept in `<home>/data/bots.json` (name, model, effort, permission mode, Telegram token variable). Each
bot works in `<home>/bots/<name>`, or in an existing folder it adopts (see below); creating it writes a starter `CLAUDE.md` and pre-accepts the folder in
`~/.claude.json` (`projects[<dir>].hasTrustDialogAccepted`) so the session doesn't stall on the trust prompt. Its
launch script, `run.pid` and Telegram state live in `<home>/data/bots/<name>`. Start a bot fresh, resume its last
session (`--continue`) or a given one (`--resume <id>` from `~/.claude/projects/<folder>/`). Deleting a bot stops it
and forgets it; its folder is kept.

For Telegram, a bot names a variable in `~/.env` (e.g. `TELEGRAM_RECIPES_TOKEN`) that holds the BotFather token. The
token is read when the bot starts and written only to the plugin's state file (`<home>/data/bots/<name>/telegram/.env`,
mode 0600); the bot runs with `--channels plugin:telegram@claude-plugins-official`. Never reuse a token another
running bot already polls with: two pollers on one token break both.

**Adopting an existing bot.** `POST /cos/bot/create` (and the New bot form's *Existing folder*) takes `dir`: an existing
folder the bot uses in place. Its `CLAUDE.md` persona, `.claude/skills`, `.claude/settings.local.json` and its own
`.mcp.json` servers are kept (own servers stay enabled); `.claude/settings.json` is rewritten from the workspace, so move
any rules you need into the workspace's allow/deny lists first. Server OS never creates or deletes an adopted folder.
Two more fields help a bot keep its identity: `team` (its agmsg team, when not `bots.team`) and `telegramStateDir` (an
existing Telegram plugin state folder with its `access.json` and inbox, used instead of `<home>/data/bots/<name>/telegram`;
needs `tokenEnv`). The bot still runs in `<prefix><name>`.

Claude Code's Monitor tool ends a monitor after 30 minutes, and agmsg's inbox stream (`watch.sh`) is one. Every 30 seconds Server OS reads each running bot's transcript for that expiry (no model call). If the stream expired, nothing newer is running and the bot has been idle for a while, it types one short turn asking the bot to start the stream again.

### Answering permission asks from the panel

A bot that asks before using a tool (permission mode `default`/`acceptEdits`, or a tool its rules don't allow) normally waits in its terminal. Add `agent/hooks/permission-relay.sh` as a `PermissionRequest` command hook in the bot's Claude Code settings (`timeout` a little above the wait, for example 620) and the ask also appears on the Bots tab as a "Needs your OK" card: Allow, Always allow (applies Claude Code's first suggested rule) or Deny. The hook posts to `POST /api/v1/approvals/hook` on 127.0.0.1 (set `SERVER_OS_URL` if the panel listens elsewhere) and waits `SD_APPROVAL_WAIT` seconds (default 600). When nobody answers, the server can't be reached, or the session isn't a running bot of this panel, the hook prints nothing and exits 0, so Claude Code asks in the terminal as usual; answering in the terminal first cancels the card. The bot is found by its session id, then its folder, then `TELEGRAM_STATE_DIR`. Asks live in memory only.

### Bot workspaces

Every native bot is its own agent, in the spirit of OpenClaw: own folder and identity, own scope and tool policy, own
skills and MCP servers, own secrets, and a seat in a team so bots can message each other. All of it is written as
plain Claude Code configuration inside the bot's folder, so `<home>/data/bots/<name>/launch.sh` (or `claude` run in the
folder) behaves the same without Server OS. Edit it in the Bots tab under **Workspace**; changes apply on restart.

| What | Written to |
|---|---|
| Scope: folders it may read (and which it may write), network on/off, *Read anywhere* (no `blockReadsOutsideWorkingDirectories`; secret paths stay denied), optional Claude Code sandbox | `<bot>/.claude/settings.json`: `permissions.allow` `Read(//dir/**)` / `Edit(//dir/**)`, `additionalDirectories`, `blockReadsOutsideWorkingDirectories: true`, `sandbox.filesystem` (`denyRead: ["~/"]` + `allowRead`/`allowWrite`), `sandbox.network.allowedDomains: []` when off. Extra folders are also passed as `--add-dir`. |
| Tool rules: preset `safe` (no `rm -rf`, `sudo`, `git push`, `curl \| sh`, tmux, launchctl…), `dev`, `full`, plus your own allow/deny rules | `permissions.allow` / `deny`; `~/.env`, `~/.ssh`, `~/.aws`, `~/.claude.json`, `~/.claude/channels` are always denied, and the bot can't edit its own `.claude/` or `.mcp.json`. New bots start in `dontAsk` mode: anything no rule allows is refused instead of waiting on a prompt nobody sees. |
| Skills, plugins, MCP servers | Global skills (`~/.claude/skills`) and plugins on by default, switched off with `skillOverrides` / `enabledPlugins`; skills from `~/.agents/skills` linked into `<bot>/.claude/skills`; user MCP servers (`~/.claude.json`) blocked with `deniedMcpServers`; `~/.mcp.json` servers copied into `<bot>/.mcp.json` (0600) and approved with `enabledMcpjsonServers`. Global files are only read. |
| Secrets | `<home>/data/bots/<name>/secrets.env` (0600) with only the ticked `~/.env` variables. The launch script re-runs itself under `env -i`, so the session gets those, `PATH`, `HOME`/`USER`/`TERM`/`LANG`/`TMPDIR`/`TMUX` and nothing else. |
| Isolated (off by default) | `CLAUDE_CONFIG_DIR=<home>/data/bots/<name>/claude`: own plugins, MCP, memory and login. It needs one `/login` in its terminal on first start. Global skills and user MCP servers are then opt-in, through the bot folder. |
| Use my global instructions (off by default for new bots) | Off: `claudeMdExcludes` lists your `~/.claude/CLAUDE.md` and `~/.claude/rules/**` (absolute glob patterns) in `<bot>/.claude/settings.json`, so the bot doesn't inherit your own working rules. Bots saved before the option existed keep them. Not needed when Isolated. |
| Identity | A marked block in `<bot>/CLAUDE.md`: name, role, owner (`owner.name`), the other bots and how to message them. The rest of the file is the persona, edited under Instructions. |
| Telegram owners | `bots.telegram.ownerChatIds` (+ per-bot ids) are added to `allowFrom` in the plugin's `access.json` before start; a new file gets `dmPolicy: allowlist`. |

The bot still runs as your OS user. The scope is Claude Code's permission system (plus the sandbox if you turn it on),
not an OS account: without the sandbox, shell commands are limited by rules, not by the kernel.

**Bots talking to each other.** Every native bot joins [agmsg](https://github.com/fujibee/agmsg) (MIT; cross-agent
messaging over a shared SQLite file) in the team `bots.team` with its own name, using agmsg's own scripts only
(`join.sh`, `delivery.sh set monitor`, `leave.sh` on delete). Delivery is agmsg's `monitor` mode: a SessionStart hook in
`<bot>/.claude/settings.local.json` asks the session to stream its inbox with the Monitor tool, and Server OS gives a
freshly started bot that first turn. Join the same team from your own session (`/agmsg`) to talk to the bots. The Bots
tab shows each bot's team and last messages (`history.sh`). Without agmsg, bots run alone and the tab shows how to
install it: `npx agmsg`. `bots.agmsg.storage` sets `AGMSG_STORAGE_PATH` (the message store) for the bots and Server
OS; team files stay in the agmsg folder, so a fully separate setup is a separate `bots.agmsg.dir`.

## Environment

| Variable | Default | |
|---|---|---|
| `SERVER_OS_HOME` | `~/server-os` | home folder. `SERVER_DASH_HOME` and `config/server-dash.yaml` (the pre-rename names) still work |
| `PORT` | `3094` | HTTP port |
| `HOST` | `127.0.0.1` | listen address. Use `0.0.0.0` to serve the LAN directly; keep loopback behind Tailscale Serve or a proxy |

## Auth and pairing

- With `auth: token`, every API call needs `Authorization: Bearer <token>`, or `?token=` for EventSource.
- `GET /api/v1/info` and `POST /api/v1/pair` stay open.
- `server-os pair` uses the local admin key in `data/admin.key` (mode 0600) to open a 5-minute, single-use, 6-digit code.
- Apps trade the code for a device token. The server stores only its SHA-256 hash.
- Revoke a device with `server-os revoke <id>`, or from the app's settings.

## Logs and traces

- **Server log:** `logs/server.jsonl`, one JSON object per line: `time`, `level`, `service`, `message`, `trace_id`, `span_id`, `attributes`.
- **Audit log:** `logs/audit.jsonl` records `actor`, `action`, `target` and `result` for every change, whether it came from a device, the web panel, the agent or a webhook.
- **Trace ids:** send a W3C `traceparent` header to join your own trace; every response returns one.
- **In the panel:** the Logs page groups errors and opens any trace as a timeline (`GET /api/v1/traces/{id}`).

## Job ID cards

Every job (crontab, launchd agent, built-in) is expected to have a full card. `integrations.cron.cards` points at a JSON file: crontab jobs are keyed by job name, launchd agents by label. Keys starting with `_` are notes.

```json
"disk-clean": {
  "category": "Maintenance", "reports": "Notify bot, weekly summary", "project": "~/scripts/disk-clean",
  "about": "Two plain sentences: what it does and why.",
  "touches": { "apps": ["Docker"], "paths": ["~/Library/Caches (cleared, 1-5 GB)"], "data": "Deletes regenerable caches older than 7 days" },
  "uses": { "tools": ["python3", "docker"], "apis": [], "secrets": ["ADGUARD_PASSWORD"], "model": "" },
  "risk": "destructive"
}
```

`risk` is `read-only`, `writes` or `destructive` (deletes, overwrites or restarts something). Secrets are variable names, never values; anything that is not a name is dropped. Built-in jobs carry the same `about`, `touches`, `uses` and `risk` fields in `job.yaml`, and creating one without them is rejected. A card is complete with `about`, something under `touches`, `uses.tools` or `uses.apis`, and `risk`. `bun run server/cli.ts jobs:check` lists the jobs whose card is incomplete and exits 1.

The panel shows an icon for each app, tool and API: the matching app from the Apps tab (by name or `.home` address), a brand logo (selfh.st icons through jsDelivr), or a generic icon. When an entry is not matched, add an optional `icons` map from the entry as written to an app name, a selfh.st logo name or `lucide:<icon>`: `"icons": { "My gadget": "Car Finder", "rclone": "lucide:cloud" }`.

## Usage and Costs

**Usage** lists the paid and metered services found on this device, one card each: plan, usage bars with reset time, monthly cost, status and a billing link. Nothing is configured; a service appears when one of its rules matches, and a fresh install with nothing found shows an empty state.

- Variable names in `costs.envFile` (default `~/.env`) are matched against `server/modules/usageProviders.json`. Only names are read for discovery. A value is read inside the server only to call that provider's own usage or billing endpoint, and is never stored, logged or sent to the panel.
- Signed-in command line tools (`gh auth status`, `tailscale status`), installed apps (Docker Desktop, Cursor) and profiles (Claude Code's `~/.claude.json`) are detected too.
- Usage is read where an official API exists: Claude Code subscription windows, ElevenLabs characters (key needs "User: read"), Cloudflare plan per zone (token with Zone: read), GitHub plan and Actions minutes, and month-to-date spend for OpenAI and Anthropic when an admin key is present (`OPENAI_ADMIN_KEY`, an `sk-ant-admin…` key). Everything else shows as discovered with "Set price" and a billing link. Reads are cached for 10 minutes (5 after an error), time out after 8 s and back off after a 429; a failing service only fails its own card.
- **Your numbers win.** Tap a card to set what you pay per month, a plan name, the renewal day or to hide it. They are stored in `config/usage.json` (`{ "services": { "elevenlabs": { "monthly": 22, "plan": "Creator", "renewalDay": 12 } }, "fixed": [] }`). Changing them needs a paired device or the admin key.
- Add a provider with one entry in `usageProviders.json`: `id`, `name`, `icon` (a selfh.st slug or `lucide:<name>`), `kind` (paid, free or local), `billing` link, and `detect` rules (`env` regexes, `bin` + `login`, `file`, `app`). `prices` (monthly USD by plan name) or `flat` give a list-price estimate.

**Costs** adds up what it takes to run the server per month: subscriptions and paid services (from Usage), electricity, and fixed costs you add (domains, VPS, hardware). The headline splits what is counted (prices you set or a service reported, fixed costs, a measured power reading) from what is estimated (list prices, electricity from CPU load).

- Electricity: `costs.power.haEntity` reads a Home Assistant power sensor; without it the draw is estimated from CPU load between the machine's idle and full-load watts (`machinePower.json`, matched on the machine model, overridable with `idleW` / `maxW`). A sample every minute builds a daily kWh history in `data/costs-power.json`.
- AI use of the server: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) are summed per bot, project and the main session, over the last 30 days, and priced at API list prices from `server/modules/modelPrices.json` (override with `costs.modelPrices`). A subscription covers these sessions, so this is shown as "what it would cost at API prices" next to the total and never added to it. Read offsets are kept in `data/costs-ai.json`, so only new lines are read after the first scan.

## Home Assistant cards

With `integrations.homeAssistant` set (URL plus a long-lived token in the env variable `tokenEnv`, default `HA_TOKEN`), dashboards get eight more card types: `entity`, `toggle`, `climate`, `camera`, `media`, `history`, `button` and `group`. Each holds the entity in `query.entity` (`query.entities` for a group; `history` also takes `range` and `points`). In the card editor, pick the entity from a searchable list. `docs/examples/house-dashboard.json` is a complete example (Dashboards, Import).

- **Live state.** The server keeps one WebSocket to Home Assistant and pushes changes of the entities your dashboards show (the `haEntities` slice). If the socket can't be opened it polls `/api/states` every 5 s and retries the socket. The token never reaches the browser; camera stills and history are fetched by the server.
- **What cards may control.** Service calls go through `POST /ha/call` and only for `integrations.homeAssistant.allowDomains`, default `[light, switch, fan, climate, media_player, scene, script, input_boolean, cover]`. Locks, alarm panels, buttons and everything else are read-only unless you list them. A call must name its entities (`entity_id`), each in the same allowed domain as the service; `area_id`, `device_id`, `"all"` and `reload` are refused. Calls are written to the audit log.
- **Trying it safely.** `POST /ha/call?dry=1`, or starting the server with `HA_DRY_RUN=1`, checks a call and returns what it would send without sending it.
- **History** is bucketed by the server into fixed steps; a state holds until it changes, and the chart has a gap before the first state it knows. Home Assistant's recorder decides how far back it goes (10 days by default).
