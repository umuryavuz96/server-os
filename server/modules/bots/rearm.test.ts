import { test, expect } from "bun:test";
import { expiredWatcher, rearmPrompt, REARM_GRACE_MS } from "./rearm";
import type { BgJob } from "./transcript";

const job = (o: Partial<BgJob>): BgJob => ({ id: "j1", taskId: "t", kind: "monitor", name: "agmsg inbox stream", command: "/s/watch.sh sid /p claude-code",
  started: 0, ended: null, endReason: null, events: 0, lastEvent: null, lastEventAt: null, timeoutMs: null, rearms: 0, request: null, ...o });
const idle = { working: null, lastActivity: 0 };
const T = 3_600_000;

test("an expired agmsg watcher is re-armed once the grace time has passed and the bot is idle", () => {
  const j = job({ ended: 1000, endReason: "timed out" });
  expect(expiredWatcher([j], idle, 1000 + REARM_GRACE_MS + 1, new Set())).toBe(j);
  expect(rearmPrompt(j)).toContain("/s/watch.sh sid /p claude-code");
});

test("not yet: grace time, busy bot, recent activity, already handled", () => {
  const j = job({ ended: T, endReason: "timed out" });
  const done = new Set<string>();
  expect(expiredWatcher([j], idle, T + 1000, done)).toBeNull();
  expect(expiredWatcher([j], { working: { since: 1, step: null }, lastActivity: 0 }, T + REARM_GRACE_MS * 2, done)).toBeNull();
  expect(expiredWatcher([j], { working: null, lastActivity: T + REARM_GRACE_MS * 2 - 1000 }, T + REARM_GRACE_MS * 2, done)).toBeNull();
  done.add("j1");
  expect(expiredWatcher([j], idle, T + REARM_GRACE_MS * 2, done)).toBeNull();
});

test("never for: a running or newer watcher, a stopped or replaced one, other monitors, no watcher at all", () => {
  const now = 10 * T;
  const old = job({ id: "a", started: 1, ended: 2, endReason: "timed out" });
  expect(expiredWatcher([old, job({ id: "b", started: 5 })], idle, now, new Set())).toBeNull(); // re-armed by the bot itself
  expect(expiredWatcher([job({ ended: 2, endReason: "stopped" })], idle, now, new Set())).toBeNull();
  expect(expiredWatcher([job({ ended: 2, endReason: "replaced" })], idle, now, new Set())).toBeNull();
  expect(expiredWatcher([job({ command: "tail -f x", ended: 2, endReason: "timed out" })], idle, now, new Set())).toBeNull();
  expect(expiredWatcher([], idle, now, new Set())).toBeNull();
});

test("from a real transcript: expiry notice → re-arm after the grace time, once the turn it started has ended", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Transcript } = await import("./transcript");
  const ts = (s: number) => new Date(Date.UTC(2026, 9, 27, 3, 0, s)).toISOString();
  const L = (o: object) => JSON.stringify(o) + "\n";
  const p = join(mkdtempSync(join(tmpdir(), "sd-rearm-")), "s.jsonl");
  writeFileSync(p,
    L({ type: "assistant", uuid: "a1", timestamp: ts(0), message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: "/s/watch.sh sid /p claude-code", description: "agmsg inbox stream", timeout_ms: 1800000 } }], usage: {} } }) +
    L({ type: "user", uuid: "r1", timestamp: ts(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "m1", content: "Monitor started (task abc123, expires in 30m)" }] } }) +
    L({ type: "user", uuid: "n1", timestamp: ts(1800), message: { role: "user", content: "<task-notification>\n<task-id>abc123</task-id>\n<summary>Monitor event</summary>\n<event>[Monitor expired after 30m with 0 events delivered.]</event>\n</task-notification>" } }) +
    L({ type: "system", subtype: "turn_duration", timestamp: ts(1805) }));
  const t = new Transcript(p); t.update();
  const end = Date.parse(ts(1800)), s = { working: t.meta.working, lastActivity: end };
  expect(t.meta.working).toBeNull();
  expect(expiredWatcher(t.jobs.values(), s, end + 30_000, new Set())).toBeNull(); // grace
  const j = expiredWatcher(t.jobs.values(), { ...s, lastActivity: end }, end + REARM_GRACE_MS + 1, new Set());
  expect(j?.command).toBe("/s/watch.sh sid /p claude-code");
});
