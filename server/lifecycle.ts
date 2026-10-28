// Lifecycle + health for EVERY app (our own standard, not just Uptime Kuma's few monitors):
//  - probe each running app every minute: HTTP on its href if it has one, else "is it running"
//  - hourly buckets (7 days) -> uptime 24 h / 7 d; switched-off time never counts as downtime
//  - every state change / health flip is an event in server-os-events.jsonl (up since, restarts)
//  - log collection: Docker container logs (Engine API) + launchd StandardOut/ErrorPath files
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, run, every } from "./lib";
import { STATE_DIR } from "./core/config";
import { setSlice, getSlice } from "./store";
import { findItem, type AppState } from "./apps";

const EVENTS = join(STATE_DIR, "server-os-events.jsonl");
const BUCKETS = join(STATE_DIR, "server-os-uptime.json");
const AGENTS = join(HOME, "Library/LaunchAgents");

export interface LifeEvent { t: number; app: string; kind: "state" | "health"; from: string; to: string; detail?: string }
interface Bucket { h: number; ok: number; n: number }
export interface Life { uptime24: number | null; uptime7d: number | null; healthy: boolean | null; code: number | null; since: number | null; restarts7d: number; lastChange: number | null; checkedVia: "http" | "process" }

let buckets: Record<string, Bucket[]> = {};
try { buckets = JSON.parse(readFileSync(BUCKETS, "utf8")); } catch {}
let events: LifeEvent[] = [];
try { events = readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).slice(-2000).map((l) => JSON.parse(l)); } catch {}
const lastState = new Map<string, string>(), lastHealth = new Map<string, boolean>(), lastCode = new Map<string, number | null>();
for (const e of events) (e.kind === "state" ? lastState.set(e.app, e.to) : lastHealth.set(e.app, e.to === "up"));

let lastBucketWrite = 0, logLines = events.length;
function record(e: LifeEvent) {
  events.push(e); if (events.length > 2000) events = events.slice(-2000);
  appendFileSync(EVENTS, JSON.stringify(e) + "\n");
  if (++logLines > 4000) { writeFileSync(EVENTS, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); logLines = events.length; } // bounded file
}

/** Called by apps.ts whenever an app's derived state is computed. */
export function noteState(app: AppState) {
  const prev = lastState.get(app.name);
  if (prev === app.state) return;
  lastState.set(app.name, app.state);
  if (prev !== undefined) record({ t: now(), app: app.name, kind: "state", from: prev, to: app.state });
  else if (!events.some((e) => e.app === app.name)) record({ t: now(), app: app.name, kind: "state", from: "unknown", to: app.state, detail: "first seen" });
}
const now = () => Math.floor(Date.now() / 1000);

async function probe(href: string): Promise<number> {
  const r = await run(["/usr/bin/curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6", "-k", href], 9_000);
  return Number(r.out.trim().slice(-3)) || 0;
}

async function probeAll() {
  const apps = Object.values(getSlice<Record<string, AppState>>("apps") ?? {});
  if (!apps.length) { setTimeout(probeAll, 3000); return; } // right after a restart the app list is not known yet: retry soon, not in a minute
  const hour = Math.floor(now() / 3600);
  await Promise.all(apps.map(async (a) => {
    if (a.state === "off") return; // switched off on purpose: not downtime
    let ok: boolean, code: number | null = null;
    if (a.href.startsWith("http") && a.kind !== "lock") { code = await probe(a.href); ok = code > 0 && code < 500; }
    else ok = a.state === "on";
    lastCode.set(a.name, code);
    const b = (buckets[a.name] ??= []);
    if (b.at(-1)?.h !== hour) b.push({ h: hour, ok: 0, n: 0 });
    b.at(-1)!.n++; if (ok) b.at(-1)!.ok++;
    while (b.length && b[0].h < hour - 24 * 7) b.shift();
    const prev = lastHealth.get(a.name);
    if (prev !== ok) { lastHealth.set(a.name, ok); if (prev !== undefined || !ok) record({ t: now(), app: a.name, kind: "health", from: prev === undefined ? "unknown" : prev ? "up" : "down", to: ok ? "up" : "down", detail: code != null ? `HTTP ${code || "no answer"}` : undefined }); }
  }));
  if (Date.now() - lastBucketWrite > 300_000) { lastBucketWrite = Date.now(); writeFileSync(BUCKETS, JSON.stringify(buckets)); } // throttled
  await refreshRealStarts(apps);
  publish(apps);
}

// Real start time of what is running now (container StartedAt / process start), refreshed every 10 min.
// Used for "up since" until our own event log has seen a start.
const realStart = new Map<string, number>();
let realAt = 0;
async function refreshRealStarts(apps: AppState[]) {
  if (!apps.length || Date.now() - realAt < 600_000) return; // apps not known yet right after start: try again next round
  realAt = Date.now();
  const ld = await run(["launchctl", "list"], 10_000);
  const pids = new Map(ld.out.split("\n").slice(1).map((l) => l.split("\t")).filter((p) => /^\d+$/.test(p[0])).map((p) => [p[2], p[0]]));
  await Promise.all(apps.filter((a) => a.state !== "off").map(async (a) => {
    const it = findItem(a.name); if (!it) return;
    const starts: number[] = [];
    for (const c of it.docker ?? []) {
      const j = await fetch(`http://localhost/containers/${encodeURIComponent(c)}/json`, { unix: join(HOME, ".docker/run/docker.sock"), signal: AbortSignal.timeout(5000) } as RequestInit).then((r) => r.json()).catch(() => null);
      const t = Date.parse(j?.State?.StartedAt ?? ""); if (t > 0) starts.push(t / 1000);
    }
    for (const l of it.launchd ?? []) {
      const pid = pids.get(l); if (!pid) continue;
      const r = await run(["ps", "-o", "lstart=", "-p", pid], 4_000); const t = Date.parse(r.out.trim()); if (t > 0) starts.push(t / 1000);
    }
    if (starts.length) realStart.set(a.name, Math.floor(Math.max(...starts)));
  }));
}

function pct(bs: Bucket[], fromHour: number) {
  let ok = 0, n = 0;
  for (const b of bs) if (b.h > fromHour) { ok += b.ok; n += b.n; }
  return n ? Math.round((ok / n) * 1000) / 10 : null;
}
function publish(apps: AppState[]) {
  const hour = Math.floor(now() / 3600), week = now() - 7 * 86400;
  const out: Record<string, Life> = {};
  for (const a of apps) {
    const evs = events.filter((e) => e.app === a.name);
    const upEv = [...evs].reverse().find((e) => (e.kind === "state" && e.to !== "off") || (e.kind === "health" && e.to === "up"));
    const offEv = [...evs].reverse().find((e) => (e.kind === "state" && e.to === "off") || (e.kind === "health" && e.to === "down"));
    out[a.name] = {
      uptime24: pct(buckets[a.name] ?? [], hour - 24), uptime7d: pct(buckets[a.name] ?? [], hour - 24 * 7),
      healthy: a.state === "off" ? null : lastHealth.get(a.name) ?? null, code: lastCode.get(a.name) ?? null,
      since: a.state === "off" ? (offEv?.t ?? null) : upEv && upEv.detail !== "first seen" && (!offEv || upEv.t >= offEv.t) ? upEv.t : realStart.get(a.name) ?? upEv?.t ?? null,
      restarts7d: evs.filter((e) => e.t >= week && ((e.kind === "state" && e.from === "off" && e.to !== "off") || (e.kind === "health" && e.from === "down" && e.to === "up"))).length,
      lastChange: evs.at(-1)?.t ?? null,
      checkedVia: a.href.startsWith("http") && a.kind !== "lock" ? "http" : "process",
    };
  }
  setSlice("life", out);
}

export function appEvents(name: string, limit = 50) { return events.filter((e) => e.app === name).slice(-limit).reverse(); }

// ---------- logs ----------
function demux(buf: Uint8Array) { // Docker multiplexed stream: [stream, 0,0,0, size(4 BE)] + payload
  let out = "", i = 0; const dec = new TextDecoder();
  while (i + 8 <= buf.length) { const size = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7]; out += dec.decode(buf.subarray(i + 8, i + 8 + size)); i += 8 + size; }
  return i === 0 ? dec.decode(buf) : out;
}
function tailFile(path: string, lines = 150) {
  try { const s = readFileSync(path, "utf8"); return s.split("\n").slice(-lines).join("\n"); } catch { return ""; }
}
export async function appLogs(name: string) {
  const it = findItem(name);
  if (!it) return { ok: false, error: "unknown app" };
  const sections: { source: string; text: string }[] = [];
  for (const c of it.docker ?? []) {
    try {
      const res = await fetch(`http://localhost/containers/${encodeURIComponent(c)}/logs?stdout=1&stderr=1&tail=150&timestamps=1`, { unix: join(HOME, ".docker/run/docker.sock"), signal: AbortSignal.timeout(8000) } as RequestInit);
      sections.push({ source: `docker · ${c}`, text: res.ok ? demux(new Uint8Array(await res.arrayBuffer())) : `(no logs: HTTP ${res.status})` });
    } catch (e) { sections.push({ source: `docker · ${c}`, text: `(Docker not answering: ${e})` }); }
  }
  for (const l of it.launchd ?? []) {
    const plist = join(AGENTS, l + ".plist");
    const paths = new Set<string>();
    for (const key of ["StandardOutPath", "StandardErrorPath"]) { const r = await run(["/usr/bin/plutil", "-extract", key, "raw", plist], 4_000); if (r.code === 0 && r.out.startsWith("/")) paths.add(r.out.trim()); }
    if (!paths.size) sections.push({ source: `launchd · ${l}`, text: "(this service does not write a log file)" });
    for (const p of paths) sections.push({ source: `launchd · ${l} · ${p.replace(HOME, "~")}`, text: existsSync(p) ? tailFile(p) || "(empty)" : "(log file not created yet)" });
  }
  if (it.utm) sections.push({ source: `vm · ${it.utm}`, text: "Virtual machine logs live inside Home Assistant (Settings → System → Logs)." });
  if (it.gate) sections.push({ source: `site · ${it.gate}`, text: "Static site served by Caddy; no per-site log." });
  if (!sections.length) sections.push({ source: "—", text: "No log source known for this app." });
  return { ok: true, sections, events: appEvents(name) };
}

export function startLifecycle() {
  every(60_000, probeAll);
}
