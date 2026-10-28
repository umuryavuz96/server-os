import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, loadUsageState, saveUsageState } from "./claude";

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
