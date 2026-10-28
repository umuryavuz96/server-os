---
name: add-job
description: Create a scheduled or on-demand job on the server's built-in scheduler — shell command, Claude prompt, or HTTP check. Use for "every night…", "remind me…", "check X every…", "run this daily", backups, reports.
---

# Add a job

1. **Pick the kind:**
   - **command:** a shell command or script. It runs with `/bin/sh -c` in the home folder. Exit 0 = OK.
   - **claude:** a prompt for work that needs judgement (summaries, triage, reports). It runs `claude -p` in this folder on the owner's subscription.
     - Give it only the tools it needs via `allowedTools`, e.g. `["mcp__server-os__server_status", "Bash(df *)"]`.
   - **http:** a URL that must answer a status (default 200). This is the simplest uptime check.
2. **Schedule:** 5-field cron in the server's local time (`0 3 * * *` = 03:00 daily), or `@every 15m`. Leave it empty for manual or webhook-only jobs.
3. **Scripts:** if the command is longer than one line, write it to `../jobs/<id>/run.sh` (create the folder first or after `create_job`) and point `command` at it.
4. `create_job` with a clear `name`, a one-line `about` for the ID card, and a `category`.
5. **Test:** `run_job`, then `job_runs` to read the output and exit code. Fix until it passes.
6. Tell the owner the schedule in plain words and when the next run is (`list_jobs`, `nextRun`).
