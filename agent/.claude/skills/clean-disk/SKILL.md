---
name: clean-disk
description: Free disk space safely — Docker leftovers, caches, old logs, large app data. Use for "disk is full", "free up space", disk alerts, or when the disk metric passes 85%.
---

# Clean the disk

1. Measure first: `df -h`, `query_metric disk 7d`, `docker system df`, `du -sh ../apps/*/data ../logs ../data/catalog`.
2. **Safe without asking** (report what was freed):
   - `docker image prune -f` (dangling images only), `docker builder prune -f`;
   - `brew cleanup` (old versions and downloads);
   - Server OS's own rotated logs older than 30 days.
3. **Ask first, showing sizes:**
   - `docker image prune -a` (unused images: re-downloads later);
   - `docker volume prune` (can delete data);
   - large files inside an app's `data/` (media, backups).
4. **Never:** delete anything in `data/` (database, keys), anything outside the server's folders without the owner naming it, or Time Machine / system files.
5. Report before → after (`df -h`) and the biggest remaining consumers.
