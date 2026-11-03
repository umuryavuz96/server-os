// Usage tab: finds the paid / metered services present on this device and reads their usage where the provider has an official API.
//
// Discovery is rule based (server/modules/usageProviders.json): variable NAMES in the env file, executables that are signed in, app bundles and files.
// Values are read only inside a fetcher, to call that provider's own usage/billing endpoint; they are never stored, logged or sent to the panel.
// Results are cached per service (10 min; errors retry after 5; a 429 backs off with claude.ts' doubling schedule) and a failing provider only fails its own card.
// The owner's manual numbers (price, plan, renewal day, hide) live in <home>/config/usage.json and always win over anything discovered.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, every, loadEnv, run } from "../lib";
import { config, dir } from "../core/config";
import { logEvent } from "../core/logger";
import { getSlice, setSlice } from "../store";
import { backoffMs, type ClaudeUsage } from "../claude";
import { parseUsage } from "./cloudVoice";
import REGISTRY from "./usageProviders.json";

export interface Provider {
  id: string; name: string; icon: string; fallback?: string; kind: "paid" | "free" | "local"; group: string; billing: string; note?: string; fetch?: string;
  detect: { env?: string[]; bin?: string; login?: string[]; file?: string[]; app?: string[] };
  prices?: Record<string, number>; flat?: { usd: number; per: "month" | "year" };
}
export interface Meter { label: string; used: number; limit: number | null; unit: string; pct: number | null; resetsAt: number | null }
export interface FetchResult { plan?: string | null; meters?: Meter[]; costUsd?: number | null; spend?: { label: string; usd: number } | null; note?: string | null; error?: string | null; backoff?: number }
export type Status = "ok" | "near" | "error" | "unknown";
export type CostSource = "manual" | "api" | "estimate" | "free" | null;
export interface Service {
  id: string; name: string; icon: string; fallback: string; group: string; kind: Provider["kind"]; via: string[]; plan: string | null; planManual: boolean; meters: Meter[];
  spend: { label: string; amount: number } | null; monthly: number | null; costSource: CostSource; renewalDay: number | null; renewsAt: number | null;
  status: Status; error: string | null; note: string | null; checkedAt: number | null; billing: string; hidden: boolean;
}
export interface Override { monthly?: number; plan?: string; renewalDay?: number; hidden?: boolean }
export interface FixedCost { id: string; name: string; monthly: number; note?: string }
export interface OverridesFile { services: Record<string, Override>; fixed: FixedCost[] }
export interface UsageSnapshot { services: Service[]; totals: Totals; currency: string; checkedAt: number | null; scanning: boolean }
export interface Totals { monthly: number; known: number; estimated: number; unknown: number; actual: number }

export const PROVIDERS = (REGISTRY as { providers: Provider[] }).providers;
const cfg = () => config.costs ?? {};
export const currency = () => cfg().currency ?? "USD";
export const usdRate = () => (cfg().usdRate && cfg().usdRate! > 0 ? cfg().usdRate! : 1);
const usd = (v: number) => Math.round(v * usdRate() * 100) / 100;
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

// ---- discovery --------------------------------------------------------------------------------------------------------------------------

/** Variable names (never values) of the env file that hold something. */
export function envNames(path = tilde(cfg().envFile ?? "~/.env")): { names: string[]; env: Record<string, string> } {
  const env = loadEnv(path);
  return { names: Object.keys(env).filter((k) => env[k]), env };
}

/** The names of `names` a provider claims. */
export function matchEnv(p: Provider, names: string[]): string[] {
  const res = (p.detect.env ?? []).map((s) => new RegExp(s));
  return names.filter((n) => res.some((r) => r.test(n))).sort();
}

const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(HOME, ".local/bin"), join(HOME, ".bun/bin"), join(HOME, ".cargo/bin"), "/Applications/Tailscale.app/Contents/MacOS", "/usr/local/go/bin"];
export function which(bin: string): string | null {
  for (const d of [...(process.env.PATH ?? "").split(":"), ...BIN_DIRS]) { const f = join(d, bin); if (d && existsSync(f)) return f; }
  return null;
}

export interface Detection { provider: Provider; via: string[]; envNames: string[] }
/** Which providers are present on this device. Spawns only the cheap sign-in checks (6 s each, in parallel). */
export async function discover(names: string[], probe: (bin: string, args: string[]) => Promise<boolean> = async (b, a) => (await run([b, ...a], 6_000)).code === 0): Promise<Detection[]> {
  const out = await Promise.all(PROVIDERS.map(async (p): Promise<Detection | null> => {
    const via: string[] = [], en = matchEnv(p, names);
    if (en.length) via.push(`${en.length} variable${en.length > 1 ? "s" : ""} in the env file`);
    for (const f of p.detect.file ?? []) if (existsSync(tilde(f))) via.push("signed-in profile");
    for (const a of p.detect.app ?? []) if (existsSync(a)) via.push("app installed");
    if (p.detect.bin) {
      const b = which(p.detect.bin);
      if (b && (!p.detect.login || (await probe(b, p.detect.login)))) via.push(p.detect.login ? `${p.detect.bin} signed in` : `${p.detect.bin} installed`);
    }
    return via.length ? { provider: p, via: [...new Set(via)], envNames: en } : null;
  }));
  return out.filter((d): d is Detection => !!d);
}

// ---- fetchers (official usage / billing endpoints only) ---------------------------------------------------------------------------------

export interface Ctx { keys: string[]; names: string[]; fetcher: typeof fetch; now: number }
const J = { "User-Agent": "server-os" };
const monthStart = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const pct = (used: number, limit: number | null) => (limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null);
/** One short, value-free sentence for a failed HTTP call. */
const httpErr = (name: string, status: number) => (status === 401 ? `${name} rejected the key` : status === 403 ? `${name} key lacks permission` : status === 429 ? `${name} is rate limiting` : `${name} answered ${status}`);
async function getJson(c: Ctx, url: string, headers: Record<string, string>): Promise<{ status: number; body: any } | { error: string }> {
  try {
    const r = await c.fetcher(url, { headers: { ...J, ...headers }, signal: AbortSignal.timeout(8_000) });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  } catch (e) { return { error: (e as Error)?.name === "TimeoutError" ? "Timed out" : "Couldn't reach the service" }; }
}

type Fetcher = (c: Ctx, p: Provider) => Promise<FetchResult>;
export const FETCHERS: Record<string, Fetcher> = {
  async elevenlabs(c) {
    const r = await getJson(c, "https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": c.keys[0] });
    if ("error" in r) return { error: r.error };
    if (!r.body) return { error: r.status === 401 || r.status === 403 ? "Key needs the User: read permission" : httpErr("ElevenLabs", r.status), backoff: r.status === 429 ? 1 : 0 };
    const u = parseUsage(r.body);
    if (u.state !== "ok") return { error: u.message };
    return { plan: u.tier.replace(/^./, (x) => x.toUpperCase()), meters: [{ label: "Characters", used: u.used, limit: u.limit, unit: "chars", pct: u.percent, resetsAt: u.resetsAt }] };
  },
  async openai(c) {
    const key = c.keys[c.names.findIndex((n) => /ADMIN/.test(n))] ?? c.keys[0];
    const r = await getJson(c, `https://api.openai.com/v1/organization/costs?start_time=${Math.floor(monthStart(c.now) / 1000)}&bucket_width=1d&limit=31`, { Authorization: `Bearer ${key}` });
    if ("error" in r) return { error: r.error };
    if (r.status === 401 || r.status === 403) return { note: "Key present. Spend needs an admin key (set OPENAI_ADMIN_KEY)." };
    if (!r.body) return { error: httpErr("OpenAI", r.status), backoff: r.status === 429 ? 1 : 0 };
    const total = ((r.body.data ?? []) as any[]).flatMap((b) => b.results ?? []).reduce((a, x) => a + Number(x.amount?.value ?? 0), 0);
    return { spend: { label: "Month to date", usd: total }, costUsd: total };
  },
  async anthropic(c) {
    const key = c.keys.find((k) => k.startsWith("sk-ant-admin"));
    if (!key) return { note: "Key present. Spend needs an Admin API key (sk-ant-admin…)." };
    const r = await getJson(c, `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${new Date(monthStart(c.now)).toISOString().slice(0, 19)}Z&limit=31`, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if ("error" in r) return { error: r.error };
    if (!r.body) return { error: httpErr("Anthropic", r.status), backoff: r.status === 429 ? 1 : 0 };
    const cents = ((r.body.data ?? []) as any[]).flatMap((b) => b.results ?? []).reduce((a, x) => a + Number(x.amount ?? 0), 0);
    return { spend: { label: "Month to date", usd: cents / 100 }, costUsd: cents / 100 };
  },
  async cloudflare(c) {
    const PRICE: Record<string, number> = { free: 0, pro: 25, business: 250 };
    let sawAuth = false;
    for (const key of c.keys.slice(0, 3)) {
      const r = await getJson(c, "https://api.cloudflare.com/client/v4/zones?per_page=50", { Authorization: `Bearer ${key}` });
      if ("error" in r) return { error: r.error };
      if (r.status === 429) return { error: httpErr("Cloudflare", 429), backoff: 1 };
      if (!r.body?.success) { sawAuth ||= r.status === 403; continue; }
      const plans = ((r.body.result ?? []) as any[]).map((z) => String(z.plan?.name ?? "").replace(/ website$/i, "")).filter(Boolean);
      const counts = plans.reduce<Record<string, number>>((a, p) => ({ ...a, [p]: (a[p] ?? 0) + 1 }), {});
      const known = plans.every((p) => p.toLowerCase() in PRICE);
      return { plan: Object.entries(counts).map(([p, n]) => `${p} × ${n}`).join(", ") || "No zones", costUsd: known ? plans.reduce((a, p) => a + PRICE[p.toLowerCase()], 0) : null };
    }
    return sawAuth ? { note: "Token present. Plan needs a token with Zone: read." } : { error: "Cloudflare rejected the token" };
  },
  async github(c) {
    let key = c.keys[0];
    if (!key) { const g = which("gh"); const t = g ? await run([g, "auth", "token"], 5_000) : null; key = t?.code === 0 ? t.out.split("\n")[0].trim() : ""; }
    if (!key) return { note: "Signed in, but no token to read the plan with." };
    const h = { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json" };
    const u = await getJson(c, "https://api.github.com/user", h);
    if ("error" in u) return { error: u.error };
    if (!u.body) return { error: httpErr("GitHub", u.status), backoff: u.status === 429 ? 1 : 0 };
    const plan = String(u.body.plan?.name ?? "") || null, d = new Date(c.now);
    const out: FetchResult = { plan: plan ? plan.replace(/^./, (x) => x.toUpperCase()) : null };
    const b = await getJson(c, `https://api.github.com/users/${encodeURIComponent(String(u.body.login))}/settings/billing/usage?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`, h);
    if (!("error" in b) && b.body) {
      const mins = ((b.body.usageItems ?? []) as any[]).filter((x) => /actions/i.test(x.product) && /minute/i.test(x.unitType)).reduce((a, x) => a + Number(x.grossQuantity ?? x.quantity ?? 0), 0);
      const lim = plan === "pro" ? 3000 : plan === "free" ? 2000 : null;
      out.meters = [{ label: "Actions minutes", used: Math.round(mins), limit: lim, unit: "min", pct: pct(mins, lim), resetsAt: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000) }];
    }
    return out;
  },
};

// ---- cache + overrides ------------------------------------------------------------------------------------------------------------------

export const TTL_OK = 600_000, TTL_ERR = 300_000;
interface Entry { at: number; res: FetchResult; retryAt: number; strikes: number }
const cache = new Map<string, Entry>();
export const resetCache = () => cache.clear();

/** Fetch with the per-service cache: fresh for 10 min (5 on errors), never inside a 429 backoff. */
export async function fetchCached(p: Provider, c: Ctx, force = false): Promise<{ res: FetchResult; at: number } | null> {
  const f = p.fetch ? FETCHERS[p.fetch] : null;
  if (!f) return null;
  const e = cache.get(p.id), now = Date.now();
  if (e && (now < e.retryAt || (!force && now - e.at < (e.res.error ? TTL_ERR : TTL_OK)))) return { res: e.res, at: e.at };
  let res: FetchResult;
  try { res = await f(c, p); } catch (x) { res = { error: "Unexpected answer" }; logEvent("warn", `Usage fetch for ${p.id} crashed`, { module: "usage", error: String((x as Error)?.message ?? x).slice(0, 80) }); }
  const strikes = res.backoff ? (e?.strikes ?? 0) + 1 : 0;
  if (res.error && res.error !== e?.res.error) logEvent("warn", `Usage read for ${p.id} failed: ${res.error}`, { module: "usage" });
  cache.set(p.id, { at: now, res, strikes, retryAt: res.backoff ? now + backoffMs(strikes) : 0 });
  return { res, at: now };
}

const overridesFile = () => join(dir("config"), "usage.json");
export function loadOverrides(file = overridesFile()): OverridesFile {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return { services: o.services && typeof o.services === "object" ? o.services : {}, fixed: Array.isArray(o.fixed) ? o.fixed.filter((f: FixedCost) => f && typeof f.id === "string" && Number.isFinite(f.monthly)) : [] };
  } catch { return { services: {}, fixed: [] }; }
}
function saveOverrides(o: OverridesFile, file = overridesFile()) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(o, null, 2) + "\n"); }

/** Validate a patch from the panel. Returns the cleaned override, or a sentence saying what is wrong. `null` values clear a field. */
export function cleanOverride(b: Record<string, unknown>): Override | string {
  const o: Override = {};
  if (b.monthly != null) { const n = Number(b.monthly); if (!Number.isFinite(n) || n < 0 || n > 1e6) return "monthly must be a number from 0 to 1,000,000"; o.monthly = Math.round(n * 100) / 100; }
  if (b.plan != null) { const s = String(b.plan).trim(); if (s.length > 60) return "plan: at most 60 characters"; if (s) o.plan = s; }
  if (b.renewalDay != null && b.renewalDay !== "") { const n = Number(b.renewalDay); if (!Number.isInteger(n) || n < 1 || n > 31) return "renewalDay must be a whole number from 1 to 31"; o.renewalDay = n; }
  if (b.hidden === true) o.hidden = true;
  return o;
}
export function setOverride(id: string, b: Record<string, unknown>, file = overridesFile()): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return "unknown service id";
  const o = cleanOverride(b);
  if (typeof o === "string") return o;
  const all = loadOverrides(file);
  if (Object.keys(o).length) all.services[id] = o; else delete all.services[id];
  saveOverrides(all, file);
  return null;
}
export function setFixed(id: string, b: Record<string, unknown>, file = overridesFile()): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return "id: lower-case letters, digits and dashes";
  const name = String(b.name ?? "").trim(), monthly = Number(b.monthly);
  if (!name || name.length > 60) return "name: 1 to 60 characters";
  if (!Number.isFinite(monthly) || monthly < 0 || monthly > 1e6) return "monthly must be a number from 0 to 1,000,000";
  const all = loadOverrides(file), note = b.note ? String(b.note).slice(0, 120) : undefined;
  all.fixed = [...all.fixed.filter((f) => f.id !== id), { id, name, monthly: Math.round(monthly * 100) / 100, ...(note ? { note } : {}) }];
  saveOverrides(all, file);
  return null;
}
export function deleteFixed(id: string, file = overridesFile()): boolean {
  const all = loadOverrides(file), n = all.fixed.length;
  all.fixed = all.fixed.filter((f) => f.id !== id);
  if (all.fixed.length !== n) saveOverrides(all, file);
  return all.fixed.length !== n;
}

// ---- merge + totals ---------------------------------------------------------------------------------------------------------------------

/** Next renewal (epoch seconds) for a day-of-month, clamped to short months. */
export function nextRenewal(day: number, now = Date.now()): number {
  const d = new Date(now);
  const at = (y: number, m: number) => Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()), 12);
  let t = at(d.getUTCFullYear(), d.getUTCMonth());
  if (t < now) t = at(d.getUTCFullYear(), d.getUTCMonth() + 1);
  return Math.floor(t / 1000);
}

/** Build one card: provider + detection + fetched numbers + the owner's overrides (manual price, plan, hide always win). */
export function buildService(p: Provider, det: { via: string[] }, f: { res: FetchResult; at: number } | null, ov: Override = {}, now = Date.now()): Service {
  const res = f?.res ?? {}, plan = ov.plan ?? res.plan ?? null, meters = res.meters ?? [];
  let monthly: number | null = null, costSource: CostSource = null;
  if (ov.monthly != null) { monthly = ov.monthly; costSource = "manual"; }
  else if (res.costUsd != null) { monthly = usd(res.costUsd); costSource = "api"; }
  else {
    const price = plan ? p.prices?.[plan.toLowerCase()] : undefined;
    if (price != null) { monthly = usd(price); costSource = price === 0 ? "free" : "estimate"; }
    else if (p.flat) { monthly = usd(p.flat.per === "year" ? p.flat.usd / 12 : p.flat.usd); costSource = "estimate"; }
    else if (p.kind !== "paid") { monthly = 0; costSource = "free"; }
  }
  const worst = Math.max(0, ...meters.map((m) => m.pct ?? 0));
  const status: Status = res.error ? "error" : worst >= 80 ? "near" : meters.length || f || p.kind !== "paid" ? "ok" : "unknown";
  return {
    id: p.id, name: p.name, icon: p.icon, fallback: p.fallback ?? "package", group: p.group, kind: p.kind, via: det.via, plan, planManual: !!ov.plan, meters,
    spend: res.spend ? { label: res.spend.label, amount: usd(res.spend.usd) } : null, monthly, costSource, renewalDay: ov.renewalDay ?? null,
    renewsAt: ov.renewalDay ? nextRenewal(ov.renewalDay, now) : null, status, error: res.error ?? null, note: res.note ?? (meters.length ? null : p.note ?? null),
    checkedAt: f ? Math.floor(f.at / 1000) : null, billing: p.billing, hidden: !!ov.hidden,
  };
}

const RANK: Record<Status, number> = { near: 0, error: 1, ok: 2, unknown: 3 };
/** Near-limit first, then errors, then by monthly cost (paid before free), then name. */
export function sortServices(a: Service[]): Service[] {
  const worst = (s: Service) => Math.max(0, ...s.meters.map((m) => m.pct ?? 0));
  return [...a].sort((x, y) => RANK[x.status] - RANK[y.status] || (x.status === "near" ? worst(y) - worst(x) : 0) || (y.monthly ?? -1) - (x.monthly ?? -1) || x.name.localeCompare(y.name));
}

/** Monthly total over visible services. manual = the owner typed it, api = read from the provider, estimate = list price. Unknown = paid services with no price. */
export function totals(services: Service[], fixed: FixedCost[] = []): Totals {
  const vis = services.filter((s) => !s.hidden);
  const sum = (src: CostSource[]) => vis.filter((s) => s.monthly && src.includes(s.costSource)).reduce((a, s) => a + s.monthly!, 0);
  const actual = sum(["manual", "api"]) + fixed.reduce((a, f) => a + f.monthly, 0), estimated = sum(["estimate"]);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { monthly: r(actual + estimated), known: r(actual), actual: r(actual), estimated: r(estimated), unknown: vis.filter((s) => s.kind === "paid" && s.monthly == null).length };
}

// ---- collector --------------------------------------------------------------------------------------------------------------------------

let found: Detection[] = [], checkedAt: number | null = null, scanning = false, lastScan = 0;
export function publishUsage() {
  const ov = loadOverrides(), claude = getSlice<ClaudeUsage | null>("claudeUsage") ?? null;
  // Claude Code is read live from the claudeUsage slice (claude.ts owns its rate limiting); the others come from the per-service cache.
  const services = found.map((d) => {
    const e = cache.get(d.provider.id);
    const f = d.provider.fetch === "claude" ? { res: claudeResult(claude), at: (claude?.fetchedAt ?? 0) * 1000 || Date.now() } : e ? { res: e.res, at: e.at } : null;
    return buildService(d.provider, d, f, ov.services[d.provider.id]);
  });
  setSlice("usage", { services: sortServices(services), totals: totals(services, ov.fixed), currency: currency(), checkedAt, scanning } satisfies UsageSnapshot);
}
export const claudeResult = (u: ClaudeUsage | null): FetchResult => {
  if (!u) return { note: "Waiting for the first read of Claude Code's usage." };
  // every window the API returned (5-hour, week, per-model, new ones); an older saved state only has session/week
  const list = u.windows ?? [
    ...(u.session ? [{ label: "5-hour session", ...u.session }] : []), ...(u.week ? [{ label: "Week", ...u.week }] : []),
  ];
  const meters: Meter[] = list.map((w) => ({ label: w.label, used: w.pct, limit: 100, unit: "%", pct: w.pct, resetsAt: w.resetsAt }));
  return { plan: u.plan, meters, error: meters.length ? null : u.error, note: meters.length && u.error ? "Last read failed, showing the previous numbers." : u.noSessionLimit ? "No 5-hour limit on this plan." : null };
};

/** Discover and fetch everything now (force bypasses the 10 min cache but not a 429 backoff). At most one scan every 30 s. */
export async function scanUsage(force = false) {
  if (scanning || (force && Date.now() - lastScan < 30_000)) return;
  scanning = true; lastScan = Date.now(); publishUsage();
  try {
    const { names, env } = envNames();
    found = await discover(names);
    await Promise.all(found.map((d) => {
      const keys = d.envNames.map((n) => env[n]);
      return fetchCached(d.provider, { keys, names: d.envNames, fetcher: fetch, now: Date.now() }, force);
    }));
    checkedAt = Math.floor(Date.now() / 1000);
  } catch (e) { logEvent("warn", "Usage scan failed", { module: "usage", error: String((e as Error)?.message ?? e).slice(0, 80) }); }
  scanning = false;
  publishUsage();
}

export function startUsageCollectors() {
  every(600_000, () => scanUsage());
  every(30_000, () => publishUsage());
}
