// Costs tab: what it takes to run this server per month.
//   1. Subscriptions and paid services (Usage tab discovery + the owner's manual prices) and fixed costs the owner typed in (domains, VPS, hardware).
//   2. The server's own AI use: Claude Code transcripts (~/.claude/projects/**/*.jsonl) summed per bot / project and priced at API list prices.
//      A subscription covers these sessions, so this is "what it would cost at API prices", shown next to the bill, never added to it.
//   3. Electricity: measured from a Home Assistant power sensor when configured, else estimated from CPU load between the machine's idle and full-load watts.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform } from "node:os";
import { basename, join } from "node:path";
import { HOME, every, loadEnv, run } from "../lib";
import { config, dir } from "../core/config";
import { logEvent } from "../core/logger";
import { getSlice, setSlice } from "../store";
import { currency, loadOverrides, usdRate, type FixedCost, type UsageSnapshot } from "./usage";
import PRICES from "./modelPrices.json";
import MACHINES from "./machinePower.json";

const cfg = () => config.costs ?? {};
const r2 = (n: number) => Math.round(n * 100) / 100;
export const dayKey = (t: number) => new Date(t).toLocaleDateString("sv-SE");

// ---- AI usage at API prices -------------------------------------------------------------------------------------------------------------

export interface ModelPrice { match: string; in: number; out: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number }
export function loadPrices(extra = cfg().modelPrices): ModelPrice[] {
  let own: ModelPrice[] = [];
  try { if (extra) own = (JSON.parse(readFileSync(extra, "utf8")).models ?? []) as ModelPrice[]; } catch { /* bad file: built-ins only */ }
  return [...own, ...(PRICES as { models: ModelPrice[] }).models];
}
export const priceFor = (model: string, table: ModelPrice[]) => table.find((p) => model.toLowerCase().includes(p.match)) ?? null;

/** Tokens: [input, output, cacheRead, cacheWrite5m, cacheWrite1h, messages]. Dollars at list price. */
export type Tok = [number, number, number, number, number, number];
export function costUsd(t: Tok, p: ModelPrice): number {
  return (t[0] * p.in + t[1] * p.out + t[2] * (p.cacheRead ?? p.in * 0.1) + t[3] * (p.cacheWrite5m ?? p.in * 1.25) + t[4] * (p.cacheWrite1h ?? p.in * 2)) / 1e6;
}

/** What a transcript's working folder says about who ran it: a bot (~/bots/<name>), the main session (~), a project, or the memory observer. */
export function consumer(cwd: string, home = HOME): { label: string; kind: "bot" | "main" | "project" | "system" } {
  if (/claude-mem/.test(cwd)) return { label: "Memory observer", kind: "system" };
  const bot = /\/bots\/([^/]+)/.exec(cwd)?.[1];
  if (bot) return { label: bot, kind: "bot" };
  if (cwd === home || cwd === "") return { label: "Main session", kind: "main" };
  return { label: basename(cwd) || cwd, kind: "project" };
}

interface AiState { files: Record<string, { off: number; label: string; kind: string }>; days: Record<string, Record<string, Record<string, Tok>>> }
const aiFile = () => join(dir("data"), "costs-ai.json");
const loadAi = (): AiState => { try { return JSON.parse(readFileSync(aiFile(), "utf8")); } catch { return { files: {}, days: {} }; } };
const WINDOW_DAYS = 31;

/** Add the new assistant lines of one transcript chunk to `days`. Streaming repeats a message several times: the last copy per message id wins. */
export function ingest(chunk: string, label: string, days: AiState["days"]) {
  const last = new Map<string, { day: string; model: string; u: any }>();
  for (const line of chunk.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message, u = m?.usage;
    if (o.type !== "assistant" || !u || !m.model || m.model === "<synthetic>" || !o.timestamp) continue;
    last.set(`${m.id ?? o.uuid}|${o.requestId ?? ""}`, { day: dayKey(Date.parse(o.timestamp)), model: String(m.model), u });
  }
  for (const { day, model, u } of last.values()) {
    const c = u.cache_creation ?? {}, w1 = Number(c.ephemeral_1h_input_tokens ?? 0), w5 = c.ephemeral_5m_input_tokens != null ? Number(c.ephemeral_5m_input_tokens) : Number(u.cache_creation_input_tokens ?? 0) - w1;
    const t = ((days[day] ??= {})[label] ??= {})[model] ??= [0, 0, 0, 0, 0, 0];
    t[0] += Number(u.input_tokens ?? 0); t[1] += Number(u.output_tokens ?? 0); t[2] += Number(u.cache_read_input_tokens ?? 0); t[3] += Math.max(0, w5); t[4] += w1; t[5]++;
  }
}

function* transcripts(root: string, since: number): Generator<{ path: string; size: number }> {
  const walk = function* (d: string, depth: number): Generator<{ path: string; size: number }> {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) yield* walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) { try { const st = statSync(p); if (st.mtimeMs >= since) yield { path: p, size: st.size }; } catch { /* gone */ } }
    }
  };
  yield* walk(root, 0);
}

/** Read what is new in every recent Claude Code transcript (byte offsets are kept, so only the first run is slow). */
export async function scanTranscripts(root = join(HOME, ".claude", "projects"), st: AiState = loadAi(), now = Date.now()): Promise<AiState> {
  const since = now - WINDOW_DAYS * 86_400_000;
  for (const f of transcripts(root, since)) {
    const prev = st.files[f.path] ?? { off: 0, label: "", kind: "" };
    if (f.size <= prev.off) continue;
    let text = "";
    try { text = await Bun.file(f.path).slice(prev.off, f.size).text(); } catch { continue; }
    // only whole lines: a half-written last line is read next time
    const end = text.lastIndexOf("\n");
    if (end < 0) continue;
    text = text.slice(0, end + 1);
    if (!prev.label) {
      const cwd = /"cwd":"([^"]*)"/.exec(text)?.[1] ?? "", c = consumer(cwd);
      prev.label = c.label; prev.kind = c.kind;
    }
    ingest(text, prev.label, st.days);
    st.files[f.path] = { ...prev, off: prev.off + Buffer.byteLength(text) };
    await new Promise((r) => setTimeout(r, 0));
  }
  const cut = dayKey(now - 62 * 86_400_000);
  for (const d of Object.keys(st.days)) if (d < cut) delete st.days[d];
  for (const [p, f] of Object.entries(st.files)) if (!existsSync(p)) delete st.files[p];
  return st;
}

export interface AiSummary { available: boolean; today: number; week: number; month: number; tokens: number; unpriced: number; days: { date: string; cost: number }[]; top: { label: string; kind: string; cost: number; tokens: number; share: number; models: string[] }[]; scannedAt: number | null }
/** Price the aggregated days (USD at list price) for the last 30 days. */
export function summarize(st: AiState, table: ModelPrice[], now = Date.now()): AiSummary {
  const kinds = new Map(Object.values(st.files).map((f) => [f.label, f.kind]));
  const per = new Map<string, { cost: number; tokens: number; models: Set<string> }>();
  const days: AiSummary["days"] = [];
  let unpriced = 0, tokens = 0;
  for (let i = 29; i >= 0; i--) {
    const date = dayKey(now - i * 86_400_000);
    let cost = 0;
    for (const [label, models] of Object.entries(st.days[date] ?? {})) for (const [model, t] of Object.entries(models)) {
      const n = t[0] + t[1] + t[2] + t[3] + t[4], p = priceFor(model, table);
      tokens += n;
      if (!p) { unpriced += n; continue; }
      const c = costUsd(t, p), e = per.get(label) ?? { cost: 0, tokens: 0, models: new Set() };
      e.cost += c; e.tokens += n; e.models.add(model.replace(/^claude-/, "")); per.set(label, e); cost += c;
    }
    days.push({ date, cost: r2(cost * usdRate()) });
  }
  const sum = (n: number) => days.slice(-n).reduce((a, d) => a + d.cost, 0), month = days.reduce((a, d) => a + d.cost, 0);
  const top = [...per].map(([label, e]) => ({ label, kind: kinds.get(label) ?? "project", cost: r2(e.cost * usdRate()), tokens: e.tokens, share: month ? e.cost * usdRate() / month : 0, models: [...e.models].sort() })).sort((a, b) => b.cost - a.cost).slice(0, 8);
  return { available: Object.keys(st.days).length > 0, today: r2(sum(1)), week: r2(sum(7)), month: r2(month), tokens, unpriced, days, top, scannedAt: null };
}

// ---- electricity ------------------------------------------------------------------------------------------------------------------------

export interface Machine { name: string; idleW: number; maxW: number }
export function pickMachine(model: string, o = cfg().power ?? {}): Machine {
  const hit = (MACHINES as { machines: (Machine & { match: string })[]; default: Machine }).machines.find((m) => new RegExp(m.match).test(model));
  const base = hit ?? (MACHINES as { default: Machine }).default;
  return { name: base.name, idleW: o.idleW ?? base.idleW, maxW: o.maxW ?? base.maxW };
}
async function machineModel(): Promise<string> {
  if (platform() === "darwin") return (await run(["sysctl", "-n", "hw.model"], 3_000)).out.trim();
  for (const f of ["/sys/firmware/devicetree/base/model", "/sys/devices/virtual/dmi/id/product_name"]) try { return readFileSync(f, "utf8").replace(/\0/g, "").trim(); } catch { /* next */ }
  return cpus()[0]?.model ?? "";
}
/** Watts from the CPU load: linear between idle and full-load draw. */
export const estimateWatts = (m: Machine, load1: number, cores: number) => m.idleW + (m.maxW - m.idleW) * Math.min(1, Math.max(0, load1 / Math.max(1, cores)));

async function haWatts(): Promise<number | null> {
  const ha = config.integrations.homeAssistant, ent = cfg().power?.haEntity, token = ha ? loadEnv()[ha.tokenEnv ?? "HA_TOKEN"] : "";
  if (!ha || !ent || !token) return null;
  // curl, not fetch: macOS Local Network privacy can block LAN access for some runtimes (same reason as the HA collector).
  const r = await run(["/usr/bin/curl", "-s", "--max-time", "6", "-H", "Authorization: Bearer " + token, `${ha.url.replace(/\/$/, "")}/api/states/${encodeURIComponent(ent)}`], 10_000);
  try { const s = JSON.parse(r.out), v = Number(s.state); return Number.isFinite(v) ? v * (/^kw$/i.test(String(s.attributes?.unit_of_measurement)) ? 1000 : 1) : null; } catch { return null; }
}

interface PowerState { days: Record<string, { wh: number; s: number; measured: number }>; last: number }
const powerFile = () => join(dir("data"), "costs-power.json");
const loadPower = (): PowerState => { try { return JSON.parse(readFileSync(powerFile(), "utf8")); } catch { return { days: {}, last: 0 }; } };
let machine: Machine | null = null, lastWatts: { w: number; src: "measured" | "estimate" } | null = null;

/** Add one sample: watts held for the time since the last one (capped at 5 min, so downtime isn't counted). */
export function addSample(st: PowerState, watts: number, measured: boolean, now = Date.now()) {
  const dt = st.last ? Math.min(300, (now - st.last) / 1000) : 0;
  st.last = now;
  if (dt <= 0) return;
  const d = (st.days[dayKey(now)] ??= { wh: 0, s: 0, measured: 0 });
  d.wh += (watts * dt) / 3600; d.s += dt; if (measured) d.measured += dt;
  const cut = dayKey(now - 62 * 86_400_000);
  for (const k of Object.keys(st.days)) if (k < cut) delete st.days[k];
}
async function samplePower() {
  machine ??= pickMachine(await machineModel());
  const m = await haWatts(), w = m ?? estimateWatts(machine, loadavg()[0], cpus().length);
  lastWatts = { w, src: m != null ? "measured" : "estimate" };
  const st = loadPower(); addSample(st, w, m != null);
  mkdirSync(dir("data"), { recursive: true }); writeFileSync(powerFile(), JSON.stringify(st));
}

// ---- headline ---------------------------------------------------------------------------------------------------------------------------

export interface CostsSnapshot {
  currency: string; updatedAt: number;
  headline: { monthly: number; actual: number; estimate: number };
  subscriptions: { monthly: number; unknown: number; items: { id: string; name: string; monthly: number; source: string }[] };
  fixed: { monthly: number; items: FixedCost[] };
  electricity: { monthly: number; watts: number | null; avgWatts: number | null; kwhMonth: number; price: number; source: "measured" | "estimate"; machine: string; days: number };
  ai: AiSummary;
  trend: { date: string; cost: number; ai: number }[];
}

/** The pure part: everything a snapshot needs, from already-read inputs. */
export function compose(i: { usage: UsageSnapshot | null; fixed: FixedCost[]; power: PowerState; ai: AiSummary; machine: Machine; watts: number | null; measuredNow: boolean; price: number; cur: string; now: number }): CostsSnapshot {
  const price = i.price, services = (i.usage?.services ?? []).filter((s) => !s.hidden && s.monthly);
  const subsMonthly = services.reduce((a, s) => a + s.monthly!, 0), fixedMonthly = i.fixed.reduce((a, f) => a + f.monthly, 0);
  const dayEntries = Object.entries(i.power.days).filter(([, d]) => d.s > 3600), n = dayEntries.length;
  const avgW = n ? dayEntries.reduce((a, [, d]) => a + d.wh, 0) / dayEntries.reduce((a, [, d]) => a + d.s, 0) * 3600 : i.watts;
  const kwhMonth = avgW != null ? (avgW * 24 * 30.4) / 1000 : 0;
  const measuredShare = dayEntries.length ? dayEntries.reduce((a, [, d]) => a + d.measured, 0) / dayEntries.reduce((a, [, d]) => a + d.s, 0) : i.measuredNow ? 1 : 0;
  const elec = r2(kwhMonth * price), measured = measuredShare > 0.5;
  const estSubs = services.filter((s) => s.costSource === "estimate").reduce((a, s) => a + s.monthly!, 0);
  const actual = r2(subsMonthly - estSubs + fixedMonthly + (measured ? elec : 0)), estimate = r2(estSubs + (measured ? 0 : elec));
  const trend = i.ai.days.map((d) => {
    const w = i.power.days[d.date], kwh = w && w.s > 3600 ? w.wh / 1000 * (86400 / w.s) : (avgW ?? 0) * 24 / 1000;
    return { date: d.date, cost: r2((subsMonthly + fixedMonthly) / 30.4 + kwh * price), ai: d.cost };
  });
  return {
    currency: i.cur, updatedAt: Math.floor(i.now / 1000), headline: { monthly: r2(actual + estimate), actual, estimate },
    subscriptions: { monthly: r2(subsMonthly), unknown: i.usage?.totals.unknown ?? 0, items: services.map((s) => ({ id: s.id, name: s.name, monthly: s.monthly!, source: s.costSource ?? "estimate" })).sort((a, b) => b.monthly - a.monthly) },
    fixed: { monthly: r2(fixedMonthly), items: i.fixed },
    electricity: { monthly: elec, watts: i.watts != null ? r2(i.watts) : null, avgWatts: avgW != null ? r2(avgW) : null, kwhMonth: r2(kwhMonth), price, source: measured ? "measured" : "estimate", machine: i.machine.name, days: n },
    ai: i.ai, trend,
  };
}

let ai: AiSummary | null = null, aiBusy = false;
export function publishCosts() {
  const o = loadOverrides();
  setSlice("costs", compose({
    usage: getSlice<UsageSnapshot>("usage") ?? null, fixed: o.fixed, power: loadPower(), ai: ai ?? summarize({ files: {}, days: {} }, loadPrices()),
    machine: machine ?? pickMachine(""), watts: lastWatts?.w ?? null, measuredNow: lastWatts?.src === "measured", price: cfg().kwhPrice ?? 0.3, cur: currency(), now: Date.now(),
  }));
}
async function refreshAi() {
  if (aiBusy) return;
  aiBusy = true;
  try {
    const st = await scanTranscripts();
    mkdirSync(dir("data"), { recursive: true }); writeFileSync(aiFile(), JSON.stringify(st));
    ai = { ...summarize(st, loadPrices()), scannedAt: Math.floor(Date.now() / 1000) };
  } catch (e) { logEvent("warn", "Costs: reading Claude Code transcripts failed", { module: "costs", error: String((e as Error)?.message ?? e).slice(0, 80) }); }
  aiBusy = false;
  publishCosts();
}

export function startCostCollectors() {
  every(60_000, async () => { await samplePower(); publishCosts(); });
  every(600_000, refreshAi);
  every(30_000, () => publishCosts());
}
