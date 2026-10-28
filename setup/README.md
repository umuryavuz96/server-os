# server-os-setup

The Server OS setup wizard: one Go binary (Bubble Tea v2 + Lip Gloss v2 + Huh v2) that runs before
anything else is installed. It checks the machine, gets Claude Code installed and logged in, asks a few
questions, lays out `~/server-os`, installs the service, shows the panel URL with a pairing QR code, and
hands over to the root agent. On macOS it also walks through the privacy permissions (step 8, listed by the running server; see `docs/permissions.md`).

## Build

```sh
cd setup
go build -o server-os-setup .                                        # this machine
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o server-os-setup .  # static Linux binary
go vet ./... && go test ./...
```

## Run

```sh
./server-os-setup              # interactive wizard
./server-os-setup --dry-run    # print every action, change nothing
./server-os-setup --yes        # no questions, defaults everywhere
./server-os-setup doctor       # checks only (includes one headless `claude -p` turn)
```

| Flag | Meaning |
|---|---|
| `--dry-run` | print each action (folders, files, `launchctl`/`systemctl`, installers) instead of doing it |
| `--yes` | non-interactive: defaults, installs Bun/Claude Code if missing |
| `--home <dir>` | home folder (default `$SERVER_OS_HOME`, else `~/server-os`) |
| `--port <n>` | server port (default 3094, or the one in an existing config) |
| `--source <dir>` | the Server OS checkout (default: next to the binary, or the current folder) |
| `--plain` | plain lines instead of the live progress list (automatic when not a terminal) |

## What it does

1. **Check the machine** — OS, arch, free disk, Bun (required; offers the official installer), Homebrew,
   Docker and Tailscale (optional).
2. **Claude Code** — installs it if missing (`curl -fsSL https://claude.ai/install.sh | bash`, npm as fallback),
   then checks the login with `claude -p "reply OK" --output-format json` (60 s timeout,
   `ANTHROPIC_API_KEY` stripped so it tests the subscription login). It never handles API keys: you log in
   yourself by running `claude` in a terminal.
3. **Essentials** — home folder, server name, reach mode (Tailscale / local / public + URL), auth
   (`off` default for Tailscale, `token` otherwise) and port. An existing config gives the defaults.
4. **Lay out the disk** — `config agent apps jobs dashboards logs data`, `config/server-os.yaml`
   (same keys as `server/core/config.ts` plus `reach`, `port`, `url`), and `data/admin.key` in the server's format.
5. **Install the server** — launchd agent `dev.serveros.server` (`~/Library/LaunchAgents`) or the systemd
   user unit `server-os.service`, from the templates in `install/`; loads it and waits for `/api/v1/info`.
   It stops if another program, or a Server OS this unit didn't start, already holds the port.
6. **Panel URL + pairing** — `POST /api/v1/pair/start` with the admin key, then shows the code and a QR code
   for `serverdash://pair?url=<panel>&code=<code>`.
7. **Hand over** — copies the repo's `agent/` kit into `<home>/agent` (existing files kept) and opens a
   Terminal window running `claude` there (macOS), or prints the command (Linux).

You can run it again at any time. It creates what is missing and never overwrites a file that already
exists: config, admin key, unit file and agent files are all "create if missing".

## Layout

```
main.go                 flags, subcommands, the step flow
internal/checks         machine facts + version parsers (read-only)
internal/claude         install command, headless login check, Terminal hand-over
internal/layout         folders, config template/reader, admin key, agent-kit copy
internal/service        launchd/systemd rendering + install (templates/ mirrors install/)
internal/pair           pair/start client, panel URL, deep link, QR
internal/sys            every side effect (dry-run aware, create-if-missing writes)
internal/ui             Lip Gloss styles, Huh theme, Bubble Tea progress list
```

`internal/service/templates/` is a copy of `install/launchd` and `install/systemd` (go:embed can't reach
outside the module). A test fails if they drift apart. Edit `install/` and copy the files over.
