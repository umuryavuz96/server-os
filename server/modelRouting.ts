// Agent model routing (rules: ~/.claude/rules/agent-model-routing.md; the picker is ~/scripts/lib/pick-model.sh).
// This module reads var/config/model-routing.json and works out the current usage mode the same way pick-model.sh does,
// so the Agents tab can show it. The mode is a read of the live Claude usage windows; nothing here spawns agents.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./lib";
import { dir } from "./core/config";

export type Mode = "normal" | "careful" | "eco" | "reserve";
export interface WindowUse { key: string; pct: number; resetsAt: number | null; hours: number }
export interface ModeInfo { mode: Mode; basePct: number; usagePct: number; windows: WindowUse[]; pace: string | null; source: string; override: boolean; thresholds: { careful: number; eco: number; reserve: number } }

export const CONFIG_PATH = () => process.env.MODEL_ROUTING_FILE ?? join(dir("config"), "model-routing.json");
const GUARD = () => process.env.USAGE_GUARD_FILE ?? join(HOME, ".claude", "hooks", "state", "usage.json");
const SD_USAGE = () => process.env.SD_USAGE_FILE ?? join(dir("data"), "claude-usage.json");
const OVERRIDE = () => process.env.USAGE_OVERRIDE_FILE ?? join(HOME, ".claude", "hooks", "state", "usage-override");

type Cfg = Record<string, any>;
const V = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
export function readConfig(): Cfg | null { try { return JSON.parse(readFileSync(CONFIG_PATH(), "utf8")); } catch { return null; } }
const j = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

/** The fresher of usage-guard's snapshot and Server Dash's own cache (what pick-model.sh does). */
export function liveWindows(staleHours: number, now = Date.now() / 1000): { ws: WindowUse[]; source: string } {
  const hours = (k: string) => (k.startsWith("five_hour") ? 5 : 168);
  const cands: { ts: number; src: string; ws: WindowUse[] }[] = [];
  const g = j(GUARD());
  if (g?.windows) cands.push({ ts: Number(g.ts ?? 0), src: "usage-guard", ws: Object.entries<any>(g.windows).map(([k, w]) => ({ key: k, pct: Number(w.used ?? 0), resetsAt: w.resets_at ?? null, hours: hours(k) })) });
  const l = j(SD_USAGE())?.last;
  if (l?.windows) cands.push({ ts: Number(l.fetchedAt ?? 0), src: "server-dash", ws: (l.windows as any[]).map((w) => ({ key: w.key, pct: Number(w.pct), resetsAt: w.resetsAt ?? null, hours: w.hours ?? hours(w.key) })) });
  const fresh = cands.filter((c) => c.ts && now - c.ts < staleHours * 3600);
  if (!fresh.length) return { ws: [], source: "none (stale or missing)" };
  const best = fresh.reduce((a, b) => (b.ts > a.ts ? b : a));
  return { ws: best.ws.filter((w) => (w.key === "five_hour" || w.key === "seven_day") && !(w.resetsAt && Number(w.resetsAt) < now)), source: best.src };
}

export function usageMode(cfg: Cfg | null = readConfig(), now = Date.now() / 1000): ModeInfo {
  const U = cfg?.usage ?? {}, M = U.modes ?? {};
  const th = { careful: V(M.careful?.min_pct) ?? 60, eco: V(M.eco?.min_pct) ?? 80, reserve: Math.max(90, V(M.reserve?.min_pct) ?? 90) };
  const { ws, source } = liveWindows(V(U.stale_hours) ?? 3, now);
  const pick = V(U.window) ?? "max";
  const sel = pick === "max" ? ws : ws.filter((w) => w.key === pick);
  const usage = Math.max(0, ...sel.map((w) => w.pct));
  const order: Mode[] = ["normal", "careful", "eco", "reserve"];
  let mode: Mode = usage >= th.reserve ? "reserve" : usage >= th.eco ? "eco" : usage >= th.careful ? "careful" : "normal";
  const base = usage; let pace: string | null = null;
  const pc = U.pace ?? {};
  if ((V(pc.enabled) ?? true) && mode !== "reserve") {
    for (const w of ws) {
      if (!w.resetsAt) continue;
      const elapsed = 1 - (Number(w.resetsAt) - now) / (w.hours * 3600);
      if (elapsed >= (V(pc.min_elapsed) ?? 0.25) && w.pct / elapsed >= (V(pc.projected_pct) ?? 110)) {
        const nm = order[Math.min(order.indexOf(mode) + 1, 2)];
        if (nm !== mode) { pace = `${w.key === "seven_day" ? "week" : "5 h"} ${Math.round(w.pct)}% used after ${Math.round(elapsed * 100)}% of the window: on pace for ${Math.round(w.pct / elapsed)}%`; mode = nm; }
        break;
      }
    }
  }
  let override = false;
  try { override = existsSync(OVERRIDE()) && now - (statSync(OVERRIDE()).mtimeMs / 1000) < 7200; } catch { /* none */ }
  return { mode, basePct: base, usagePct: usage, windows: ws, pace, source, override, thresholds: th };
}

// ---------- the settings form: every tunable of model-routing.json, validated, saved safely ----------
import { copyFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Hono } from "hono";
import { requireAdmin, type Env } from "./core/http";

export const MODELS = ["haiku", "sonnet", "opus", "fable"], EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export interface Field { path: string; group: string; label: string; hint?: string; type: "int" | "float" | "bool" | "enum" | "string[]" | "bands"; value: any; min?: number; max?: number; options?: string[]; locked?: string }
const GROUPS: Record<string, string> = { points: "Scoring", expect: "Expectation points", expect_keywords: "Expectation words", roles: "Roles", bands: "Score bands", floors: "Risk floors", usage: "Usage modes" };
const LOG = () => process.env.MODEL_ROUTING_LOG ?? join(HOME, "scripts", "logs", "model-routing.jsonl");

export function fieldsOf(cfg: Cfg): Field[] {
  const out: Field[] = [];
  const walk = (o: any, path: string[]) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const top = path[0];
    if (top === "roles" && path.length === 2) {
      const r = path[1];
      out.push({ path: `roles.${r}.points`, group: GROUPS.roles, label: `${r}: points`, hint: o.description, type: "int", value: o.points, min: -5, max: 5 });
      out.push({ path: `roles.${r}.writes`, group: GROUPS.roles, label: `${r}: writes code`, type: "bool", value: o.writes });
      out.push({ path: `roles.${r}.light`, group: GROUPS.roles, label: `${r}: light role`, type: "bool", value: o.light });
      return;
    }
    if ("type" in o && "value" in o) {
      const p = path.join(".");
      out.push({ path: p, group: GROUPS[top] ?? top, label: path.slice(path[0] === "usage" ? 1 : 0).join(" › ").replace(/_/g, " "), hint: o.description, type: o.type === "band[]" ? "bands" : o.type, value: o.value, min: o.min, max: o.max, options: o.options,
        ...(p === "usage.modes.reserve.min_pct" ? { locked: "Never below 90: the last 10% is the emergency reserve" } : {}) });
      return;
    }
    for (const [k, v] of Object.entries(o)) if (!(path.length === 0 && (k === "version" || k === "description"))) walk(v, [...path, k]);
  };
  walk(cfg, []);
  return out;
}

export function checkValue(f: Field, v: unknown): string | null {
  switch (f.type) {
    case "int": if (!Number.isInteger(v)) return "whole number"; break;
    case "float": if (typeof v !== "number" || !Number.isFinite(v)) return "number"; break;
    case "bool": return typeof v === "boolean" ? null : "on or off";
    case "enum": return f.options?.includes(v as string) ? null : `one of ${f.options?.join(", ")}`;
    case "string[]": return Array.isArray(v) && v.length <= 40 && v.every((x) => typeof x === "string" && x.trim() && x.length <= 40) ? null : "a list of short words";
    case "bands": {
      if (!Array.isArray(v) || !v.length || v.length > 8) return "1 to 8 bands";
      for (let i = 0; i < v.length; i++) {
        const b = v[i] as { max_score: unknown; model: unknown; effort: unknown }, last = i === v.length - 1;
        if (!MODELS.includes(b.model as string) || !EFFORTS.includes(b.effort as string)) return "a known model and effort per band";
        if (last ? b.max_score !== null : typeof b.max_score !== "number" || !Number.isFinite(b.max_score)) return last ? "the last band has no limit" : "a score limit per band";
        if (i && !last && (b.max_score as number) <= ((v[i - 1] as { max_score: number }).max_score)) return "limits that go up";
      }
      return null;
    }
  }
  if (typeof v === "number") { if (f.min !== undefined && v < f.min) return `at least ${f.min}`; if (f.max !== undefined && v > f.max) return `at most ${f.max}`; }
  return null;
}

const setPath = (cfg: any, path: string, v: unknown) => {
  const parts = path.split("."), last = parts.pop()!; let o = cfg;
  for (const k of parts) { o = o?.[k]; if (!o) return false; }
  if (path.startsWith("roles.")) { if (!(last in o)) return false; o[last] = v; return true; }
  const node = o[last];
  if (node && typeof node === "object" && !Array.isArray(node) && "value" in node) { node.value = v; return true; }
  return false;
};

/** The whole config must still make sense: usage modes in order, reserve at 90 or more. */
export function checkWhole(cfg: Cfg): string | null {
  const M = cfg.usage?.modes ?? {}, c = V(M.careful?.min_pct), e = V(M.eco?.min_pct), r = V(M.reserve?.min_pct);
  if (r < 90) return "Reserve cannot start below 90%";
  if (!(c < e && e <= r)) return "Usage modes must go up: careful < eco ≤ reserve";
  return null;
}

const backupsOf = () => { const f = CONFIG_PATH(), pre = basename(f) + ".bak-serverdash-"; return existsSync(dirname(f)) ? readdirSync(dirname(f)).filter((n) => n.startsWith(pre)).sort() : []; };

/** Apply {path: value} changes, check them all, back the file up, write atomically. Throws with a plain message. */
export function saveChanges(changes: Record<string, unknown>): Cfg {
  const cfg = readConfig(); if (!cfg) throw new Error("model-routing.json is missing or broken");
  const fields = new Map(fieldsOf(cfg).map((f) => [f.path, f]));
  const errs: string[] = [];
  for (const [path, v] of Object.entries(changes)) {
    const f = fields.get(path);
    if (!f) { errs.push(`${path}: not a setting`); continue; }
    const bad = checkValue(f, v);
    if (bad) { errs.push(`${f.label}: needs ${bad}`); continue; }
    if (!setPath(cfg, path, v)) errs.push(`${path}: not a setting`);
  }
  const whole = errs.length ? null : checkWhole(cfg);
  if (errs.length || whole) throw new Error(errs[0] ?? whole!);
  const f = CONFIG_PATH(), b = `${f}.bak-serverdash-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`;
  copyFileSync(f, b);
  for (const old of backupsOf().slice(0, -10)) try { unlinkSync(join(dirname(f), old)); } catch { /* ignore */ }
  const t = f + ".tmp-serverdash";
  writeFileSync(t, JSON.stringify(cfg, null, 2));
  JSON.parse(readFileSync(t, "utf8"));
  renameSync(t, f);
  return cfg;
}

export interface Decision { ts: string; agent: string; job: string; mode: string; usage: number | null; model: string; effort: string; score: number | null; reason: string; status: string; warnings: string[] }
export function decisions(limit = 30): Decision[] {
  try {
    return readFileSync(LOG(), "utf8").split("\n").filter(Boolean).slice(-limit).reverse().map((l) => { try { const j = JSON.parse(l); return { ts: j.ts, agent: j.agent ?? "", job: j.job ?? "", mode: j.mode ?? "", usage: j.usage ?? null, model: j.model ?? "", effort: j.effort ?? "", score: j.score ?? null, reason: j.reason ?? "", status: j.status ?? "", warnings: j.warnings ?? [] }; } catch { return null; } }).filter((x): x is Decision => !!x);
  } catch { return []; }
}

const payload = () => { const cfg = readConfig(); return { fields: cfg ? fieldsOf(cfg) : [], mode: usageMode(cfg), decisions: decisions(), backups: backupsOf(), error: cfg ? null : "model-routing.json is missing or broken" }; };
export function modelRoutingRoutes(api: Hono<Env>) {
  api.get("/agent-routing", (c) => c.json(payload()));
  api.put("/agent-routing", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { changes?: Record<string, unknown> };
    if (!body.changes || typeof body.changes !== "object") return c.json({ error: "changes needed" }, 400);
    try { saveChanges(body.changes); return c.json(payload()); } catch (e) { return c.json({ error: String((e as Error).message) }, 400); }
  });
}
