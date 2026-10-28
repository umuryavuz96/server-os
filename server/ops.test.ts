import { test, expect } from "bun:test";
import { humanSchedule, nextRun, prevRun, jobName, parseAgent } from "./ops";
import { setSlice, setMapEntry, subscribe } from "./store";

test("humanSchedule", () => {
  expect(humanSchedule("*/5 * * * *")).toBe("every 5 min");
  expect(humanSchedule("15 * * * *")).toBe("hourly at :15");
  expect(humanSchedule("0 9 * * *")).toBe("daily 09:00");
  expect(humanSchedule("0 15 * * 1-5")).toBe("weekdays 15:00");
  expect(humanSchedule("0 4 * * 0")).toBe("Sun 04:00");
  expect(humanSchedule("30 11 */5 * *")).toBe("every 5 days 11:30");
  expect(humanSchedule("0 8 1 * *")).toBe("monthly on day 1, 08:00");
});

test("nextRun", () => {
  const from = new Date(2026, 9, 21, 15, 2, 30); // Wed 21 Oct 2026 15:02:30 local
  expect(new Date(nextRun("*/5 * * * *", from)! * 1000).getMinutes()).toBe(5);
  const d = new Date(nextRun("0 4 * * 0", from)! * 1000);
  expect([d.getDay(), d.getHours(), d.getDate()]).toEqual([0, 4, 25]);
  expect(new Date(nextRun("0 9 * * *", from)! * 1000).getDate()).toBe(22);
});

test("jobName", () => {
  expect(jobName(`/x/lib/cron_wrap.sh --summary='deploy ok' "toolpile-deploy" /bin/bash /x/deploy.sh`)).toEqual(["toolpile-deploy", true]);
  expect(jobName(`/x/lib/cron_wrap.sh "yt-likes" /venv/python /x/sync.py`)).toEqual(["yt-likes", true]);
  expect(jobName(`/Users/u/scripts/docker-watchdog/watchdog.sh`)).toEqual(["docker-watchdog watchdog", false]);
  expect(jobName(`/bin/bash /Users/u/bots/karpuz/crons/morning-checkin.sh`)).toEqual(["karpuz morning-checkin", false]);
});

test("store only broadcasts real changes", () => {
  const seen: string[] = [];
  const off = subscribe((ev, d) => seen.push(ev + ":" + JSON.stringify(d)));
  expect(setSlice("t", { a: 1 })).toBe(true);
  expect(setSlice("t", { a: 1 })).toBe(false);
  expect(setMapEntry("m", "x", { s: "on" })).toBe(true);
  expect(setMapEntry("m", "x", { s: "on" })).toBe(false);
  expect(setMapEntry("m", "y", { s: "off" })).toBe(true);
  off();
  expect(seen.length).toBe(3);
});

test("prevRun is the last slot at or before now, nextRun the first after", () => {
  const from = new Date(2026, 9, 22, 10, 7, 30);
  expect(new Date(prevRun("*/5 * * * *", from)! * 1000).getMinutes()).toBe(5);
  expect(new Date(nextRun("*/5 * * * *", from)! * 1000).getMinutes()).toBe(10);
  expect(new Date(prevRun("0 4 * * 0", from)! * 1000).getDay()).toBe(0);
});

import { historyRange } from "./system";
test("historyRange returns aligned fixed-step buckets with nulls, never more than asked", () => {
  const r = historyRange("cpu", "24h", 120);
  expect(r.step).toBeGreaterThanOrEqual(300);
  expect(r.t.length).toBe(r.avg.length);
  expect(r.t.length).toBeLessThanOrEqual(Math.ceil(86400 / r.step) + 1);
  expect(r.t.every((t, i) => i === 0 || t - r.t[i - 1] === r.step)).toBe(true);
  r.avg.forEach((v, i) => { if (v !== null) expect(r.min[i]!).toBeLessThanOrEqual(r.max[i]!); });
});

test("parseAgent: launchd plist -> schedule", () => {
  const a = parseAgent({ ProgramArguments: ["/x/guard.sh", "-v"], StartInterval: 60, StandardOutPath: "/x/g.log" });
  expect([a.when, a.schedule, a.always, a.command, a.log]).toEqual(["every 60 s", "StartInterval 60", false, "/x/guard.sh -v", "/x/g.log"]);
  expect(parseAgent({ StartInterval: 3600 }).when).toBe("every 1 h");
  expect(parseAgent({ StartInterval: 600 }).when).toBe("every 10 min");
  expect(parseAgent({ StartCalendarInterval: { Hour: 4, Minute: 5 } }).when).toBe("daily 04:05");
  expect(parseAgent({ StartCalendarInterval: { Weekday: 0, Hour: 9, Minute: 0 } }).when).toBe("Sun 09:00");
  expect(parseAgent({ StartCalendarInterval: [{ Hour: 8, Minute: 0 }, { Hour: 20, Minute: 30 }] }).when).toBe("daily 08:00, daily 20:30");
  expect(parseAgent({ StartCalendarInterval: { Minute: 15 } }).when).toBe("hourly at :15");
  const svc = parseAgent({ Program: "/bin/svc", KeepAlive: true, RunAtLoad: true, StandardErrorPath: "/x/e.log" });
  expect([svc.when, svc.always, svc.command, svc.log]).toEqual(["always running", true, "/bin/svc", "/x/e.log"]);
  expect(parseAgent({ RunAtLoad: true }).when).toBe("at login");
  expect(parseAgent({}).when).toBe("on demand");
});
