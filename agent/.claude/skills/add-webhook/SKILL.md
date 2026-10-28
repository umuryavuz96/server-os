---
name: add-webhook
description: Let another service trigger work on this server through an HTTP POST (deploy on push, run on form submit, home-automation events). Use for "webhook", "trigger from GitHub/Home Assistant/IFTTT", "when X happens run Y".
---

# Add a webhook

1. A webhook is a job with `webhook: true`. Create it with **add-job**; usually it has no schedule.
2. The request body reaches the job on stdin and in `$SD_PAYLOAD`.
   - For JSON, parse it with `jq`, e.g. `echo "$SD_PAYLOAD" | jq -r .ref`.
3. `job_webhook` returns the URL path and secret.
   - The caller sends `POST <server>/api/v1/hooks/<id>` with header `X-Server-OS-Secret: <secret>`, or `?secret=` if it can't set headers.
4. **Reachability:** the server must be reachable by the caller.
   - Tailscale-only servers can only be called from the tailnet.
   - For public callers (GitHub), the owner needs a tunnel or proxy. Explain the options; don't open ports yourself.
5. **Test:** `curl -X POST -H "X-Server-OS-Secret: …" -d '{"test":true}' http://127.0.0.1:<port>/api/v1/hooks/<id>`, then `job_runs`.
6. Hand the owner the URL and secret through the panel (Jobs, then the job, then Edit, which shows them). Don't paste secrets into chat logs.
