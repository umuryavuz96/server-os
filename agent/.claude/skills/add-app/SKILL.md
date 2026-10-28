---
name: add-app
description: Install a self-hosted app on this server — from the Discover catalog when possible, otherwise by writing a Server OS recipe. Use for "install X", "set up X", "I want X", or an install request in inbox/.
---

# Add an app

1. **Find it:** `search_catalog` with the app's name, then `catalog_entry` for the best hit.
   - Check its `install` options, ranked best first: recipe, casaos, linuxserver, brew, cask.
   - If the project is archived, tell the owner and suggest a maintained alternative from the same category.
2. **Plan:** `plan_install` with the chosen method. Read the compose file:
   - Image tag: avoid ancient tags. `latest` is fine for home use.
   - Ports: `{{port:N}}` is filled with a free port at install time.
   - Volumes: everything must live under `{{data}}`.
   - Required env vars without a value: ask the owner, or pick safe defaults and say so.
   - Privileged mode, host networking, `/var/run/docker.sock` mounts: only if the app truly needs them, and tell the owner.
3. **Install:** `install_app`, then poll `operation_status` every ~5 s until `ok` or `failed`.
4. **Verify:**
   - The app shows up in `list_apps` with state `on`.
   - Its URL answers: `href` in `app.yaml`, or `curl -sI` the port.
   - Then make it ready to use with the **finish-app** skill (admin account, first-run wizard, ready card).
5. **No automatic method?** Write a recipe in `../config/recipes/<id>.yaml` (format below).
   - Base it on the project's official docker-compose or Homebrew formula.
   - Put first-run steps you worked out in the recipe's `setup:` field, so the next install goes faster.
   - Then `reload_recipes`, `search_catalog` for it (its catalog id is the recipe's), and `install_app` with method `recipe`.
6. **Done:** if this came from `inbox/`, move the request to `inbox/done/` with a one-line result.

## Recipe format
```yaml
id: my-app                  # lowercase, dashes
name: My App
description: One sentence.
category: Media Streaming
website: https://…
repo: https://github.com/…
logo: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/my-app.svg
docker:
  compose: |
    services:
      my-app:
        image: org/my-app:latest
        container_name: sd-my-app
        restart: unless-stopped
        environment: { TZ: "{{tz}}", PUID: "{{puid}}", PGID: "{{pgid}}" }
        ports: ["{{port:8080}}:8080"]
        volumes: ["{{data}}:/data"]
# or:  brew: { formula: name, service: true }   web: { port: 1234 }
notes: What the owner must know after installing (one line).
setup: |
  First-run steps for the agent, e.g.:
  docker exec sd-my-app my-app user create --admin --name <owner> --password <admin_password secret>
  Then set SIGNUPS=false in compose.yaml and restart.
```
