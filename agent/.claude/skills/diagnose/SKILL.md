---
name: diagnose
description: Find out why something on the server is broken or slow — an app down, a job failing, high RAM/CPU/disk, the server unreachable. Use for "X is down", "why is it slow", "something's wrong", failing jobs, alerts.
---

# Diagnose

1. `server_status`, then `error_summary`. Note every failing job, unhealthy app and error group.
2. **Narrow it down:**
   - **App down:** `app_logs` for that app; `docker ps -a`, `docker logs --tail 100 <container>`; check the port answers.
   - **Job failing:** `job_runs` (output + exit code); `get_trace` with the run's trace id.
   - **Slow / resources:** `query_metric` for ram, swap, cpu, load, disk over `24h` and `7d`; `docker stats --no-stream`; `top -l 1 -o mem` (macOS) or `top -bn1` (Linux).
   - **Disk:** `df -h`, `du -sh ../apps/*/data`; see the **clean-disk** skill.
3. **Find the cause** and state it with evidence: a log line, a metric, a trace id. If you're not sure, say what you ruled out.
4. **Fix** what is safe and reversible: restart a crashed app with `set_app_power` off/on, re-run a job.
   - Ask before anything else: config changes, upgrades, deleting data.
5. **Verify** the fix (status, health, a fresh job run). Report the cause, the fix and anything to watch.
