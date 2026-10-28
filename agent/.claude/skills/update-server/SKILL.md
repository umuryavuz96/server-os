---
name: update-server
description: Update installed apps (pull new images / brew upgrade) and Server OS itself, safely. Use for "update everything", "upgrade X", "is there a new version", monthly maintenance.
---

# Update the server

1. **Inventory:** `list_apps` and `../apps/*/app.yaml`, which give the method (compose / brew) per app.
2. **Docker apps:** for each `../apps/<id>/compose.yaml`:
   - `docker compose -p sd-<id> -f compose.yaml pull`;
   - if a new image arrived, `docker compose -p sd-<id> -f compose.yaml up -d`;
   - check the app answers.
   - One app at a time. Never update a database container together with its app without reading the release notes.
3. **Homebrew:** `brew outdated`, then `brew upgrade <formula>` for the server's formulae only (the ones in `app.yaml` files), then `brew services restart <formula>`.
4. **Server OS itself:** use the built-in updater. Never `git pull` or copy files into the install yourself.
   - `update_check`: it returns `current`, `latest` (tag, release notes), `updateAvailable`, `canApply` and `blocked`.
   - If `blocked` is set, tell the owner what it says. Homebrew means `brew upgrade server-os`, Docker means pull the
     image, and a git checkout is developer mode, where the owner updates it themselves. Stop there.
   - Otherwise summarize the release notes for the owner and ask before applying. A major version, or a beta, always
     needs a yes.
   - `update_apply` starts it. The updater verifies the signature, unpacks the new version, switches over, restarts and
     rolls back by itself if the new version doesn't answer within about 45 s. The restart drops your connection: wait
     about a minute, then `update_status`. `last` says `ok`, or the `reason` and `rolledBack`.
   - Don't apply the same version again after a rollback. Report the reason; `../logs/update.log` has the details.
5. Record each app update with `audit_note` (Server OS's own updates are audited by the updater) (`app.update`, target = app + old→new version). Report what changed and anything that failed.
6. Ask first if an update is a major version, or the owner relies on the app right now.
