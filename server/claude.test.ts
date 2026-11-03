import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, loadUsageState, parseUsage, planName, saveUsageState } from "./claude";

const u = { plan: "Max", session: { pct: 12, resetsAt: 1 }, week: { pct: 40, resetsAt: 2 }, fetchedAt: 100, error: null };

test("backoff doubles per 429 and caps at 15 min", () => {
  const mid = () => 0.5;
  expect(backoffMs(1, 0, mid)).toBe(180_000);
  expect(backoffMs(2, 0, mid)).toBe(360_000);
  expect(backoffMs(3, 0, mid)).toBe(720_000);
  expect(backoffMs(4, 0, mid)).toBe(900_000);
  expect(backoffMs(9, 600, mid)).toBe(900_000);
});
test("backoff jitter stays within 20%", () => {
  expect(backoffMs(1, 0, () => 0)).toBe(144_000);
  expect(backoffMs(1, 0, () => 1)).toBe(216_000);
});
test("state round-trips and drops the stale error", () => {
  const f = join(mkdtempSync(join(tmpdir(), "cu-")), "x", "u.json");
  saveUsageState({ last: { ...u, error: "Usage API HTTP 429" }, retryAt: 999, strikes: 2 }, f);
  const st = loadUsageState(f);
  expect(st.retryAt).toBe(999); expect(st.strikes).toBe(2);
  expect(st.last?.session?.pct).toBe(12); expect(st.last?.error).toBeNull();
});
test("missing or corrupt state loads empty", () => {
  const d = mkdtempSync(join(tmpdir(), "cu-"));
  expect(loadUsageState(join(d, "none.json")).last).toBeNull();
  Bun.write(join(d, "bad.json"), "{nope");
  expect(loadUsageState(join(d, "bad.json")).retryAt).toBe(0);
});
const W = (pct: number | string, at: string | null = "2026-11-02T10:00:00Z") => ({ utilization: pct, resets_at: at });
const T = Math.floor(Date.parse("2026-11-02T10:00:00Z") / 1000);
test("usage: both windows", () => {
  const u = parseUsage({ five_hour: W(42.5), seven_day: W("26") }, "Max", 1);
  expect(u.session).toEqual({ pct: 42.5, resetsAt: T });
  expect(u.week).toEqual({ pct: 26, resetsAt: T });
  expect(u.windows?.map((w) => [w.key, w.label, w.hours])).toEqual([["five_hour", "Session · 5 h", 5], ["seven_day", "Week", 168]]);
  expect(u.noSessionLimit).toBe(false);
});
test("usage: only the week (no 5-hour limit on Ultra)", () => {
  const u = parseUsage({ five_hour: null, seven_day: W(26), seven_day_opus: null }, "Ultra", 1);
  expect(u.session).toBeNull();
  expect(u.windows?.map((w) => w.key)).toEqual(["seven_day"]);
  expect(u.noSessionLimit).toBe(true);
  // five_hour simply missing is not "no limit": we can't tell
  expect(parseUsage({ seven_day: W(26) }, null, 1).noSessionLimit).toBe(false);
});
test("usage: extra model windows and unknown ones, in order, non-windows skipped", () => {
  const u = parseUsage({ seven_day_sonnet: W(3), extra_usage: { is_enabled: true, monthly_limit: 50 }, seven_day_haiku: W(1), seven_day: W(26), seven_day_opus: W(9), five_hour: W(10), weird_thing: W(5, null) }, null, 1);
  expect(u.windows?.map((w) => w.label)).toEqual(["Session · 5 h", "Week", "Week · Opus", "Week · Sonnet", "Week · Haiku", "Weird thing"]);
  expect(u.windows?.find((w) => w.key === "weird_thing")?.hours).toBeNull();
});
test("usage: unreadable windows are dropped", () => {
  const u = parseUsage({ five_hour: { utilization: "n/a" }, seven_day: null }, null, 1);
  expect(u.session).toBeNull(); expect(u.week).toBeNull(); expect(u.windows).toEqual([]);
});
test("plan names: Max 20x is Ultra now, Max 5x is Max", () => {
  expect(planName("max", "default_claude_max_20x")).toBe("Ultra");
  expect(planName("max", "default_claude_max_5x")).toBe("Max");
  expect(planName("pro", "")).toBe("Pro");
  expect(planName(null, "x")).toBeNull();
});
test("old saved state is relabelled", () => {
  const f = join(mkdtempSync(join(tmpdir(), "cu-")), "u.json");
  saveUsageState({ last: { ...u, plan: "Max 20x" }, retryAt: 0, strikes: 0 }, f);
  expect(loadUsageState(f).last?.plan).toBe("Ultra");
});
test("usage: a switched-off extra usage block is not a window", () => {
  const extra = (on: boolean) => ({ is_enabled: on, monthly_limit: 100, used_credits: 0, utilization: 0, currency: "USD" });
  expect(parseUsage({ five_hour: null, seven_day: W(29), extra_usage: extra(false), tangelo: null, limits: [] }, "Ultra", 1).windows?.map((w) => w.key)).toEqual(["seven_day"]);
  expect(parseUsage({ seven_day: W(29), extra_usage: extra(true) }, "Ultra", 1).windows?.map((w) => w.label)).toEqual(["Week", "Extra usage"]);
});
