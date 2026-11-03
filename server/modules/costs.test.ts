import { expect, test } from "bun:test";
import { compose, consumer, costUsd, estimateWatts, ingest, addSample, pickMachine, priceFor, loadPrices, summarize, dayKey, type Tok } from "./costs";
import { buildService, PROVIDERS } from "./usage";

const table = loadPrices();
test("model prices: specific ids first, unknown models have no price", () => {
  expect(priceFor("claude-opus-5-5", table)).toMatchObject({ in: 4, out: 20 });
  expect(priceFor("claude-opus-4-8", table)).toMatchObject({ in: 5, out: 25 });
  expect(priceFor("claude-sonnet-5-5", table)).toMatchObject({ in: 2, out: 10 });
  expect(priceFor("claude-sonnet-4-5-20250929", table)).toMatchObject({ in: 3, out: 15 });
  expect(priceFor("claude-fable-5-1", table)).toMatchObject({ in: 10, out: 50 });
  expect(priceFor("model-3", table)).toBeNull();
});
test("cost: cache reads at 0.1x by default, writes 1.25x (5 min) and 2x (1 h)", () => {
  const p = { match: "x", in: 10, out: 50 };
  const t: Tok = [1e6, 1e6, 1e6, 1e6, 1e6, 1];
  expect(costUsd(t, p)).toBeCloseTo(10 + 50 + 1 + 12.5 + 20, 6);
  expect(costUsd(t, { ...p, cacheRead: 0.25 })).toBeCloseTo(10 + 50 + 0.25 + 12.5 + 20, 6);
});
test("transcript lines: last copy per message wins, synthetic and non-usage lines are skipped", () => {
  const line = (id: string, out: number, model = "claude-opus-5-5") => JSON.stringify({ type: "assistant", uuid: id + out, requestId: "r" + id, timestamp: "2026-10-20T10:00:00Z", message: { id, model, usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 10 } } } });
  const days: Parameters<typeof ingest>[2] = {};
  ingest([line("a", 5), line("a", 90), line("b", 7, "<synthetic>"), JSON.stringify({ type: "user" }), "{broken"].join("\n") + "\n", "alphabot", days);
  const d = days[dayKey(Date.parse("2026-10-20T10:00:00Z"))].alphabot["claude-opus-5-5"];
  expect(d).toEqual([2, 90, 100, 10, 30, 1]);
});
test("consumers: bots, main session, projects, memory observer", () => {
  expect(consumer("/Users/me/bots/alphabot", "/Users/me")).toEqual({ label: "alphabot", kind: "bot" });
  expect(consumer("/Users/me", "/Users/me")).toEqual({ label: "Main session", kind: "main" });
  expect(consumer("/Users/me/projects/app", "/Users/me")).toEqual({ label: "app", kind: "project" });
  expect(consumer("/x/.claude-mem/observer", "/Users/me").kind).toBe("system");
});
test("summary: per-day cost, top consumers sorted, unpriced tokens counted", () => {
  const today = dayKey(Date.now());
  const st = { files: { "/a": { off: 1, label: "bot1", kind: "bot" } }, days: { [today]: { bot1: { "claude-opus-5-5": [1e6, 0, 0, 0, 0, 1] as Tok }, other: { "claude-sonnet-5-5": [1e6, 0, 0, 0, 0, 1] as Tok, "model-3": [500, 0, 0, 0, 0, 1] as Tok } } } };
  const s = summarize(st, table);
  expect(s.today).toBe(6); expect(s.month).toBe(6); expect(s.unpriced).toBe(500);
  expect(s.top.map((t) => [t.label, t.cost])).toEqual([["bot1", 4], ["other", 2]]);
  expect(s.top[0].kind).toBe("bot");
});
test("power: table lookup, config override, linear estimate, samples capped at 5 minutes", () => {
  expect(pickMachine("Mac16,10")).toMatchObject({ name: "Mac mini M4", idleW: 4, maxW: 40 });
  expect(pickMachine("Mac16,10", { idleW: 6 })).toMatchObject({ idleW: 6, maxW: 40 });
  expect(pickMachine("???").name).toBe("Generic server");
  const m = { name: "x", idleW: 10, maxW: 50 };
  expect(estimateWatts(m, 0, 8)).toBe(10); expect(estimateWatts(m, 4, 8)).toBe(30); expect(estimateWatts(m, 99, 8)).toBe(50);
  const st = { days: {}, last: 0 }; const t0 = Date.parse("2026-10-20T10:00:00");
  addSample(st, 36, false, t0); addSample(st, 36, false, t0 + 60_000); addSample(st, 36, true, t0 + 60_000 + 3_600_000);
  const d = (st.days as any)[dayKey(t0)];
  expect(d.s).toBe(60 + 300); expect(d.wh).toBeCloseTo((36 * 360) / 3600, 6); expect(d.measured).toBe(300);
});
test("headline: counted vs estimated, electricity from watts x price, AI stays out of the total", () => {
  const svc = (id: string, monthly: number, src: "manual" | "estimate") => ({ ...buildService(PROVIDERS.find((p) => p.id === "ollama")!, { via: [] }, null), id, name: id, monthly, costSource: src, kind: "paid" as const });
  const usage = { services: [svc("a", 20, "manual"), svc("b", 100, "estimate")], totals: { monthly: 120, known: 20, actual: 20, estimated: 100, unknown: 2 }, currency: "EUR", checkedAt: 1, scanning: false };
  const ai = summarize({ files: {}, days: { [dayKey(Date.now())]: { x: { "claude-opus-5-5": [1e6, 0, 0, 0, 0, 1] as Tok } } } }, table);
  const c = compose({ usage, fixed: [{ id: "d", name: "Domain", monthly: 3 }], power: { days: {}, last: 0 }, ai, machine: { name: "t", idleW: 10, maxW: 10 }, watts: 10, measuredNow: false, price: 0.3, cur: "EUR", now: Date.now() });
  expect(c.electricity.kwhMonth).toBeCloseTo(7.3, 1); expect(c.electricity.monthly).toBeCloseTo(2.19, 2);
  expect(c.headline.actual).toBe(23); expect(c.headline.estimate).toBeCloseTo(102.19, 2); expect(c.headline.monthly).toBeCloseTo(125.19, 2);
  expect(c.ai.month).toBe(4); expect(c.subscriptions.unknown).toBe(2); expect(c.trend.length).toBe(30);
  const measured = compose({ usage, fixed: [], power: { days: {}, last: 0 }, ai, machine: { name: "t", idleW: 10, maxW: 10 }, watts: 10, measuredNow: true, price: 0.3, cur: "EUR", now: Date.now() });
  expect(measured.electricity.source).toBe("measured"); expect(measured.headline.actual).toBeCloseTo(20 + 2.19, 2);
});
