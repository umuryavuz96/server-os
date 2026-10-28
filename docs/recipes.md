# Recipes

A recipe is a small YAML manifest that installs one app.

- Curated recipes live in `recipes/` in this repo.
- Your own go in `<home>/config/recipes/`. They win over curated ones with the same `id`.
- Recipes appear in Discover as "Server OS recipe (tested)" and rank above every other install method.

```yaml
id: uptime-kuma                 # lowercase letters, digits, dashes
name: Uptime Kuma
description: Self-hosted monitoring with status pages and notifications.
category: Monitoring
website: https://uptime.kuma.pet
repo: https://github.com/louislam/uptime-kuma
logo: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/uptime-kuma.svg
platforms: [darwin, linux]      # optional; default both
notes: Anything the owner must know after installing.
setup: |                        # optional: first-run steps for the agent (admin user, close sign-ups, …)
  docker exec sd-uptime-kuma …
docker:
  compose: |
    services:
      uptime-kuma:
        image: louislam/uptime-kuma:2
        container_name: sd-uptime-kuma
        restart: unless-stopped
        ports: ["{{port:3001}}:3001"]
        volumes: ["{{data}}:/app/data"]
  linux: |                      # optional: used on Linux instead (e.g. network_mode: host, which Docker Desktop on macOS lacks)
    services: …
```

Or, for a Homebrew service:

```yaml
brew: { formula: ollama, service: true }
web: { port: 11434 }
```

## Placeholders

| | Becomes |
|---|---|
| `{{data}}` | the app's data folder, `<home>/apps/<id>/data` |
| `{{port:N}}` | a free host port, `N` when free. The same placeholder gets the same port. The first one is the app's web port unless `web.port` says otherwise |
| `{{tz}}` | the server's time zone |
| `{{puid}}` / `{{pgid}}` | the server user's ids |

## How an install runs

1. The installer writes `apps/<id>/compose.yaml` and runs `docker compose -p sd-<id> up -d`, or runs `brew install` and `brew services start`.
2. It downloads the logo and waits up to 90 s for the web UI.
3. With `apps.link` in `server-os.yaml`, it runs that command to give the app an address (e.g. `http://<id>.home`).
4. It writes `apps/<id>/app.yaml`, which puts the app on the Apps tab with an on/off switch.
5. **Setup.** When Claude Code is installed (and `apps.agentSetup` isn't `false`), a background agent run
   (`claude -p` in `<home>/agent`, skill `finish-app`) makes the app ready to use: it creates the admin account
   with a generated password, runs the first-run wizard through the app's API, closes sign-ups, and checks the login.
   It ends with a **ready card**: the address, the user name, the password (kept in `apps/<id>/.secret`, mode 600)
   and anything left for a person to do.
6. Progress of every step, the agent's too, streams to the panel and the apps (`operations` slice), logged under
   one trace id.

Apps with no automatic install method can be handed to the agent from Discover: the same kind of background run
writes a recipe, installs it and sets it up.

Uninstalling keeps `data/` unless you ask to purge it.

## Contributing a recipe

- Base the recipe on the project's official compose file.
- Keep every volume under `{{data}}`.
- Test it with `POST /api/v1/apps/plan` (dry run), then a real install and uninstall.
- Open a pull request.
