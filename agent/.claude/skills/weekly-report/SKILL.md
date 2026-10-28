---
name: weekly-report
description: Write a short weekly health report of the server — uptime, failures, resource trends, updates and suggestions. Use for "weekly report", "how was the week", or from a scheduled claude job.
---

# Weekly report

Gather:
- `server_status`;
- `query_metric` for ram, disk, swap and cpu over `7d` (points 7): averages and peaks;
- `alerts` with days 7;
- `error_summary`;
- `list_jobs` (failing ones and how long they have been failing);
- `read_logs` level warn, limit 100 (themes, not every line).

Write (≤ 25 lines, plain words, no raw logs):
1. **One-line verdict:** all good, or what needs attention.
2. **Uptime:** apps that were down or restarted, and for how long.
3. **Jobs:** runs, failures and their causes.
4. **Resources:** RAM / disk / swap trend, with numbers. Flag disk > 85% or growing > 2%/week.
5. **Suggestions:** at most 3, concrete (an update, a cleanup, an app to switch off to save RAM).

To make this run every week, create a `claude` job with **add-job**:
- schedule `0 9 * * 1`;
- prompt "Use the weekly-report skill and print the report.";
- allowedTools with the read-only server-os tools.
