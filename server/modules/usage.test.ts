import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, buildService, cleanOverride, deleteFixed, discover, fetchCached, loadOverrides, matchEnv, nextRenewal, resetCache, setFixed, setOverride, sortServices, totals, type Provider, type Service } from "./usage";

const P = (id: string) => PROVIDERS.find((p) => p.id === id)!;
const det = { via: ["x"] };
const tmp = () => join(mkdtempSync(join(tmpdir(), "us-")), "usage.json");
beforeEach(() => resetCache());

test("registry entries are unique and complete", () => {
  expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  for (const p of PROVIDERS) { expect(p.name && p.icon && p.billing.startsWith("https://")).toBeTruthy(); expect(Object.keys(p.detect).length).toBeGreaterThan(0); for (const r of p.detect.env ?? []) new RegExp(r); }
});
test("env names match the provider registry, values are not involved", () => {
  const names = ["ANTHROPICS_API_KEY", "KILO_ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ELEVENLABS_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_NOTIFY_CHAT_ID", "THISISEVEN_SUPABASE_DB_PASS", "GOOGLE_PASSWORD", "CLOUDFLARE_ZONE_ID_TOOLPILE", "CLOUDFLARE_API_TOKEN"];
  expect(matchEnv(P("anthropic-api"), names)).toEqual(["ANTHROPICS_API_KEY", "KILO_ANTHROPIC_API_KEY"]);
  expect(matchEnv(P("elevenlabs"), names)).toEqual(["ELEVENLABS_API_KEY"]);
  expect(matchEnv(P("telegram"), names)).toEqual(["TELEGRAM_BOT_TOKEN"]);
  expect(matchEnv(P("supabase"), names)).toEqual(["THISISEVEN_SUPABASE_DB_PASS"]);
  expect(matchEnv(P("cloudflare"), names)).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(matchEnv(P("gemini"), names)).toEqual([]);
});
test("discovery lists a provider once per rule hit and needs the sign-in for CLIs", async () => {
  const d = await discover(["OPENAI_API_KEY"], async () => false);
  expect(d.find((x) => x.provider.id === "openai")?.via).toEqual(["1 variable in the env file"]);
  expect(d.find((x) => x.provider.id === "github")).toBeUndefined(); // gh may be installed, but not signed in
});

const fixed = (id: string, extra: Partial<Service> = {}): Service => ({ ...buildService(P("ollama"), det, null), id, ...extra });
test("manual price wins over api and list price; plan override wins over the api plan", () => {
  const el = buildService(P("elevenlabs"), det, { res: { plan: "Creator", meters: [{ label: "Characters", used: 5, limit: 10, unit: "chars", pct: 50, resetsAt: null }] }, at: Date.now() });
  expect(el.monthly).toBe(22); expect(el.costSource).toBe("estimate");
  const man = buildService(P("elevenlabs"), det, { res: { plan: "Creator" } , at: 1 }, { monthly: 18, plan: "Annual Creator" });
  expect(man.monthly).toBe(18); expect(man.costSource).toBe("manual"); expect(man.plan).toBe("Annual Creator"); expect(man.planManual).toBe(true);
  const api = buildService(P("openai"), det, { res: { costUsd: 12.5 }, at: 1 });
  expect(api.monthly).toBe(12.5); expect(api.costSource).toBe("api");
});
test("status: near at 80 percent, error from the fetcher, unknown for paid services with no data", () => {
  const m = (pct: number) => ({ res: { meters: [{ label: "x", used: pct, limit: 100, unit: "%", pct, resetsAt: null }] }, at: 1 });
  expect(buildService(P("claude-code"), det, m(79)).status).toBe("ok");
  expect(buildService(P("claude-code"), det, m(80)).status).toBe("near");
  expect(buildService(P("claude-code"), det, { res: { error: "x" }, at: 1 }).status).toBe("error");
  expect(buildService(P("stripe"), det, null).status).toBe("unknown");
  expect(buildService(P("stripe"), det, null).monthly).toBeNull();
  expect(buildService(P("docker"), det, null)).toMatchObject({ status: "ok", monthly: 0, costSource: "free" });
});
test("flat yearly prices show per month", () => { expect(buildService(P("apple-developer"), det, null).monthly).toBe(8.25); });
test("totals split counted from estimated, skip hidden, count unpriced paid services", () => {
  const list = [fixed("a", { monthly: 20, costSource: "manual" }), fixed("b", { monthly: 10, costSource: "estimate" }), fixed("c", { monthly: 99, costSource: "manual", hidden: true }), fixed("d", { kind: "paid", monthly: null, costSource: null })];
  expect(totals(list, [{ id: "x", name: "Domain", monthly: 2 }])).toEqual({ monthly: 32, known: 22, actual: 22, estimated: 10, unknown: 1 });
});
test("sort: near limit first, then errors, then by cost", () => {
  const near = (id: string, pct: number) => fixed(id, { status: "near", meters: [{ label: "", used: pct, limit: 100, unit: "%", pct, resetsAt: null }] });
  const out = sortServices([fixed("cheap", { monthly: 5 }), fixed("err", { status: "error" }), near("n1", 85), near("n2", 95), fixed("dear", { monthly: 50 })]);
  expect(out.map((s) => s.id)).toEqual(["n2", "n1", "err", "dear", "cheap"]);
});
test("override file: merge, validate, clear, fixed costs", () => {
  const f = tmp();
  expect(setOverride("elevenlabs", { monthly: "22", plan: " Creator ", renewalDay: 5, hidden: true }, f)).toBeNull();
  expect(loadOverrides(f).services.elevenlabs).toEqual({ monthly: 22, plan: "Creator", renewalDay: 5, hidden: true });
  expect(setOverride("elevenlabs", {}, f)).toBeNull(); // empty = back to automatic
  expect(loadOverrides(f).services.elevenlabs).toBeUndefined();
  expect(cleanOverride({ monthly: -1 })).toContain("monthly"); expect(cleanOverride({ renewalDay: 32 })).toContain("renewalDay"); expect(cleanOverride({ plan: "x".repeat(61) })).toContain("plan");
  expect(setOverride("../etc", {}, f)).toBe("unknown service id");
  expect(setFixed("domain", { name: "Domain", monthly: 1.5 }, f)).toBeNull(); expect(setFixed("domain", { name: "Domain", monthly: 2 }, f)).toBeNull();
  expect(loadOverrides(f).fixed).toEqual([{ id: "domain", name: "Domain", monthly: 2 }]);
  expect(setFixed("d", { name: "", monthly: 1 }, f)).toContain("name");
  expect(deleteFixed("domain", f)).toBe(true); expect(deleteFixed("domain", f)).toBe(false);
  expect(loadOverrides(join(tmpdir(), "none-" + Date.now() + ".json"))).toEqual({ services: {}, fixed: [] });
});
test("renewal day clamps to short months and rolls to next month", () => {
  const now = Date.UTC(2026, 1, 10, 0); // 10 Feb 2026
  expect(new Date(nextRenewal(31, now) * 1000).toISOString().slice(0, 10)).toBe("2026-02-28");
  expect(new Date(nextRenewal(5, now) * 1000).toISOString().slice(0, 10)).toBe("2026-03-05");
});
test("fetch cache: 10 minutes, errors retry sooner, a 429 backs off, a crash stays on its own card", async () => {
  let n = 0;
  const p: Provider = { ...P("elevenlabs"), fetch: "elevenlabs" };
  const ctx = (f: typeof fetch) => ({ keys: ["k"], names: ["ELEVENLABS_API_KEY"], fetcher: f, now: Date.now() });
  const ok = (async () => { n++; return new Response(JSON.stringify({ character_count: 5, character_limit: 10, tier: "creator", next_character_count_reset_unix: 1 })); }) as unknown as typeof fetch;
  const a = await fetchCached(p, ctx(ok)); await fetchCached(p, ctx(ok));
  expect(n).toBe(1); expect(a?.res.meters?.[0].pct).toBe(50); expect(a?.res.plan).toBe("Creator");
  await fetchCached(p, ctx(ok), true); expect(n).toBe(2);
  resetCache();
  const limited = (async () => { n++; return new Response("{}", { status: 429 }); }) as unknown as typeof fetch;
  const r = await fetchCached(p, ctx(limited)); expect(r?.res.error).toContain("rate limiting");
  await fetchCached(p, ctx(ok), true); expect(n).toBe(3); // forced, but still inside the backoff: no new request
  resetCache();
  const boom = (async () => { throw new Error("secret-value-in-message"); }) as unknown as typeof fetch;
  const b = await fetchCached(p, ctx(boom));
  expect(b?.res.error).toBe("Couldn't reach the service"); expect(JSON.stringify(b)).not.toContain("secret");
});
