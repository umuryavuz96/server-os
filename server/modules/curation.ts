// Discover's hand-made layer: editor's picks (rotating weekly), "Instead of …" (services → apps that replace them),
// starter packs and "works well with" pairs. Source: curation/curated.yaml in the repo; a user's
// <home>/config/curated.yaml, when present, is merged over it (its keys win).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";

export interface Pick { id: string; kicker: string; why: string }
export interface Pack { id: string; name: string; blurb: string; tint: string; apps: string[] }
export interface Pair { id: string; why: string }
export interface Curation { picks: Pick[]; replaces: Record<string, string[]>; packs: Pack[]; pairs: Record<string, Pair[]> }

const FILES = () => [join(import.meta.dir, "../../curation/curated.yaml"), join(dir("config"), "curated.yaml")];

let cached: { at: number; c: Curation } | null = null;
export function curation(): Curation {
  if (cached && Date.now() - cached.at < 60_000) return cached.c;
  const c: Curation = { picks: [], replaces: {}, packs: [], pairs: {} };
  for (const f of FILES()) {
    if (!existsSync(f)) continue;
    try {
      const y = (Bun.YAML.parse(readFileSync(f, "utf8")) ?? {}) as Partial<Curation>;
      if (y.picks) c.picks = y.picks;
      if (y.packs) c.packs = y.packs;
      Object.assign(c.replaces, y.replaces ?? {});
      Object.assign(c.pairs, y.pairs ?? {});
    } catch { /* a broken user file never hides the curated one */ }
  }
  cached = { at: Date.now(), c };
  return c;
}

/** app id → the services it replaces ("Google Photos", …), for cards, search and the app page. */
export function replacesById(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [svc, ids] of Object.entries(curation().replaces)) for (const id of ids) out.set(id, [...(out.get(id) ?? []), svc]);
  return out;
}

/** ISO-ish week number (days since epoch shifted to Monday), so everyone sees the same set. */
export const weekIndex = (now = Date.now()) => Math.floor((now / 86_400_000 + 3) / 7);

/** This week's three picks. */
export function weeklyPicks(n = 3, week = weekIndex()): Pick[] {
  const p = curation().picks;
  if (p.length <= n) return p;
  return Array.from({ length: n }, (_, i) => p[(week * n + i) % p.length]);
}
