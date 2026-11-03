import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestSession, sessionOf } from "./agentUsage";
import { usageMode } from "./modelRouting";
import type { Tok } from "./modules/costs";

const line = (id: string, ts: string, out: number, model = "claude-sonnet-5-5") => JSON.stringify({ type: "assistant", uuid: id, timestamp: ts, message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100 } } }) + "\n";

test("ingest sums tokens per model, skips lines before the week, takes the last copy of a streamed message", () => {
  const t: Record<string, Tok> = {};
  ingestSession(line("a", "2026-11-01T10:00:00Z", 5) + line("a", "2026-11-01T10:00:01Z", 50) + line("b", "2026-10-20T10:00:00Z", 999) + line("c", "2026-11-01T11:00:00Z", 7, "claude-opus-5-5"), Date.parse("2026-10-30T00:00:00Z"), t);
  expect(t["claude-sonnet-5-5"]).toEqual([10, 50, 100, 0, 0, 1]);
  expect(t["claude-opus-5-5"][1]).toBe(7);
});
test("a subagent log counts for its parent session", () => {
  expect(sessionOf("/p/-proj/abc-123.jsonl")).toBe("abc-123");
  expect(sessionOf("/p/-proj/abc-123/subagents/agent-9.jsonl")).toBe("abc-123");
});

let d = "";
beforeEach(() => { d = mkdtempSync(join(tmpdir(), "mr-")); process.env.USAGE_GUARD_FILE = join(d, "none.json"); process.env.USAGE_OVERRIDE_FILE = join(d, "none"); });
afterEach(() => { rmSync(d, { recursive: true, force: true }); delete process.env.SD_USAGE_FILE; });
const cfg = { usage: { window: { value: "max" }, stale_hours: { value: 3 }, pace: { enabled: { value: true }, projected_pct: { value: 110 }, min_elapsed: { value: 0.25 } }, modes: { careful: { min_pct: { value: 60 } }, eco: { min_pct: { value: 80 } }, reserve: { min_pct: { value: 50 } } } } };
function usage(pct: number, hoursLeft: number, key = "seven_day") {
  const now = Date.now() / 1000; process.env.SD_USAGE_FILE = join(d, "u.json");
  writeFileSync(process.env.SD_USAGE_FILE, JSON.stringify({ last: { fetchedAt: now, windows: [{ key, pct, resetsAt: now + hoursLeft * 3600, hours: 168 }] } }));
}
test("mode follows the thresholds; reserve never below 90", () => {
  usage(30, 120); expect(usageMode(cfg).mode).toBe("normal");
  usage(65, 30); expect(usageMode(cfg).mode).toBe("careful");
  usage(85, 30); expect(usageMode(cfg).mode).toBe("eco");
  usage(91, 30); expect(usageMode(cfg).mode).toBe("reserve");
  expect(usageMode(cfg).thresholds.reserve).toBe(90);
});
test("pace escalates one mode, never to reserve; stale snapshot means normal", () => {
  usage(66, 107); // 36% of the week gone, 66% used: projects far over 110%
  const m = usageMode(cfg); expect(m.mode).toBe("eco"); expect(m.pace).toContain("on pace");
  usage(88, 20); expect(usageMode(cfg).mode).toBe("eco"); // eco + pace: capped, not reserve
  writeFileSync(process.env.SD_USAGE_FILE!, JSON.stringify({ last: { fetchedAt: Date.now() / 1000 - 5 * 3600, windows: [{ key: "seven_day", pct: 95, resetsAt: Date.now() / 1000 + 3600, hours: 168 }] } }));
  expect(usageMode(cfg).mode).toBe("normal");
});

import { copyFileSync, readFileSync, readdirSync } from "node:fs";
import { checkValue, decisions, fieldsOf, readConfig, saveChanges } from "./modelRouting";
const REAL = join(import.meta.dir, "..", "var", "config", "model-routing.json");
test.skipIf(!existsSync(REAL))("routing form: fields cover the config, edits are checked, saved with a backup, only value changes", () => {
  process.env.MODEL_ROUTING_FILE = join(d, "model-routing.json"); copyFileSync(REAL, process.env.MODEL_ROUTING_FILE);
  const cfg = readConfig()!, f = fieldsOf(cfg), by = (p: string) => f.find((x) => x.path === p)!;
  for (const p of ["points.scope_step", "expect.high", "expect_keywords.high", "roles.qa.points", "roles.qa.light", "bands", "floors.risk_opus", "usage.window", "usage.pace.enabled", "usage.modes.eco.min_pct", "usage.modes.reserve.min_pct"]) expect(by(p)).toBeTruthy();
  expect(by("bands").type).toBe("bands");
  expect(by("usage.modes.reserve.min_pct").locked).toBeTruthy();
  expect(checkValue(by("usage.modes.reserve.min_pct"), 85)).toContain("at least 90");
  expect(checkValue(by("points.scope_step"), 1.5)).toBeTruthy();
  expect(checkValue(by("usage.window"), "bogus")).toBeTruthy();
  const before = JSON.parse(readFileSync(process.env.MODEL_ROUTING_FILE, "utf8"));
  saveChanges({ "points.scope_step": 2, "roles.qa.light": false, "usage.modes.eco.min_pct": 82, "expect_keywords.low": ["quick", "tiny"] });
  const after = JSON.parse(readFileSync(process.env.MODEL_ROUTING_FILE, "utf8"));
  expect(after.points.scope_step.value).toBe(2); expect(after.points.scope_step.min).toBe(before.points.scope_step.min);
  expect(after.roles.qa.light).toBe(false); expect(after.usage.modes.eco.min_pct.value).toBe(82); expect(after.expect_keywords.low.value).toEqual(["quick", "tiny"]);
  expect(readdirSync(d).filter((n) => n.includes(".bak-serverdash-")).length).toBe(1);
  expect(() => saveChanges({ "usage.modes.careful.min_pct": 85 })).toThrow(/careful < eco/);
  expect(() => saveChanges({ "nope.x": 1 })).toThrow(/not a setting/);
  expect(() => saveChanges({ "usage.modes.reserve.min_pct": 80 })).toThrow();
  const bands = structuredClone(after.bands.value); bands[1].max_score = 0; // would not ascend
  expect(() => saveChanges({ bands })).toThrow(/limits that go up/);
  saveChanges({ bands: after.bands.value.map((b: any, i: number) => (i === 0 ? { ...b, effort: "medium" } : b)) });
  expect(JSON.parse(readFileSync(process.env.MODEL_ROUTING_FILE, "utf8")).bands.value[0].effort).toBe("medium");
});
test("decisions come newest first", () => {
  process.env.MODEL_ROUTING_LOG = join(d, "m.jsonl");
  writeFileSync(process.env.MODEL_ROUTING_LOG, [{ ts: "a", agent: "x", model: "sonnet" }, { ts: "b", agent: "y", model: "opus" }].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n");
  expect(decisions().map((x) => x.ts)).toEqual(["b", "a"]);
});
