// Discover: a searchable bank of self-hostable software, merged from live sources
// and indexed with SQLite FTS5. Each source refreshes on its own interval; its raw entries are cached in
// data/catalog/<source>.json so a restart never needs the network.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";
import { db, schema } from "../core/db";
import { logEvent } from "../core/logger";
import { curation, replacesById, weeklyPicks, weekIndex, type Pick } from "./curation";
import { GENRES, genreOf, getGenre } from "./genres";

export type Method = "recipe" | "casaos" | "linuxserver" | "brew" | "cask" | "dockerhub";
/** One way to install an entry, ranked by METHOD_RANK (curated recipe first). */
export interface InstallOption { method: Method; ref: string; label: string }
export interface SourceEntry {
  name: string; description?: string; category?: string; sub?: string; website?: string; repo?: string; license?: string;
  stars?: number; updated?: string; archived?: boolean; logo?: string; install?: InstallOption;
  screenshots?: string[]; arch?: string[];
}
/** How far an install gets on its own: a tested recipe (ready to use), another automatic method, or only the agent. */
export type Tier = "ready" | "oneclick" | "agent";
/** Maintenance, from the last update: active ≤ 6 months, slowing ≤ 18 months, stale older, or archived. */
export type Health = "active" | "slowing" | "stale" | "archived" | "unknown";
export interface CatalogItem {
  id: string; name: string; description: string; category: string; website: string | null; repo: string | null;
  license: string | null; stars: number | null; updated: string | null; archived: boolean; logo: string | null;
  sources: string[]; install: InstallOption[];
  /** Discover shelf (genres.ts) and the finer sub-category, e.g. "Video Streaming". */
  genre: string; sub: string | null; tier: Tier;
  health: Health; replaces: string[]; screenshots: string[]; arch: string[] | null;
}
export interface Source { id: string; label: string; attribution: string; everyHours: number; fetch: () => Promise<SourceEntry[]> }

export const METHOD_RANK: Method[] = ["recipe", "casaos", "linuxserver", "brew", "cask", "dockerhub"];
const UA = { "User-Agent": "server-os (+https://github.com/umuryavuz96)" };
const cacheDir = () => join(dir("data"), "catalog");
const getJSON = async (url: string) => { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
const getText = async (url: string) => { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); };

export const slugify = (s: string) => s.toLowerCase().replace(/\.(io|app|org|com)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** awesome-selfhosted tags look like "Media Streaming - Video Streaming": the top level is the category, the rest the sub-category. */
const topCategory = (t?: string) => (t ?? "").split(" - ")[0].trim() || "Other";
const subCategory = (t?: string) => (t ?? "").split(" - ").slice(1).join(" - ").trim() || undefined;

// ---------- sources ----------
async function readTarball(url: string, want: (path: string) => boolean): Promise<Map<string, string>> {
  const tmp = join(cacheDir(), `dl-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, "a.tgz");
  await Bun.write(tgz, await fetch(url, { headers: UA, signal: AbortSignal.timeout(300_000) }));
  const p = Bun.spawn(["tar", "xzf", tgz, "-C", tmp], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error("tar failed");
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(join(d, f.name), r);
      else if (want(r)) out.set(r, readFileSync(join(d, f.name), "utf8"));
    }
  };
  walk(tmp, "");
  Bun.spawn(["rm", "-rf", tmp]);
  return out;
}

const awesomeSelfhosted: Source = {
  id: "awesome-selfhosted", label: "awesome-selfhosted", everyHours: 24,
  attribution: "awesome-selfhosted-data, CC BY-SA 3.0 — https://github.com/awesome-selfhosted/awesome-selfhosted-data",
  async fetch() {
    const files = await readTarball("https://codeload.github.com/awesome-selfhosted/awesome-selfhosted-data/tar.gz/refs/heads/master", (p) => /\/software\/[^/]+\.yml$/.test(p));
    const out: SourceEntry[] = [];
    for (const text of files.values()) {
      try {
        const y = Bun.YAML.parse(text) as Record<string, any>;
        if (!y?.name) continue;
        out.push({ name: y.name, description: y.description, category: topCategory(y.tags?.[0]), sub: subCategory(y.tags?.[0]), website: y.website_url, repo: y.source_code_url,
          license: y.licenses?.join(", "), stars: y.stargazers_count, updated: y.updated_at, archived: !!y.archived, logo: y.icon_url });
      } catch { /* one bad file never sinks the source */ }
    }
    return out;
  },
};

const CASA_RAW = "https://raw.githubusercontent.com/IceWhaleTech/CasaOS-AppStore/main/Apps";
const casaos: Source = {
  id: "casaos", label: "CasaOS App Store", everyHours: 24 * 7,
  attribution: "CasaOS AppStore, Apache-2.0 — https://github.com/IceWhaleTech/CasaOS-AppStore",
  async fetch() {
    // The repo tarball is ~250 MB of screenshots; list the tree once and pull only each compose file.
    const tree = await getJSON("https://api.github.com/repos/IceWhaleTech/CasaOS-AppStore/git/trees/main?recursive=1");
    const apps = (tree.tree as { path: string }[]).map((t) => /^Apps\/([^/]+)\/docker-compose\.yml$/.exec(t.path)?.[1]).filter(Boolean) as string[];
    const out: SourceEntry[] = [];
    for (let i = 0; i < apps.length; i += 12) {
      await Promise.all(apps.slice(i, i + 12).map(async (app) => {
        try {
          const y = Bun.YAML.parse(await getText(`${CASA_RAW}/${encodeURIComponent(app)}/docker-compose.yml`)) as Record<string, any>;
          const x = y["x-casaos"] ?? {};
          const desc = x.tagline?.en_US ?? x.description?.en_US ?? "";
          out.push({ name: x.title?.en_US ?? app, description: String(desc).split("\n")[0].slice(0, 400), category: x.category,
            website: x.project_url, logo: x.icon, install: { method: "casaos", ref: app, label: "Docker (CasaOS compose)" },
            screenshots: (x.screenshot_link ?? []).filter((u: unknown) => typeof u === "string").slice(0, 6), arch: x.architectures });
        } catch { /* skip */ }
      }));
    }
    return out;
  },
};

const linuxserver: Source = {
  id: "linuxserver", label: "LinuxServer.io", everyHours: 24,
  attribution: "LinuxServer.io images — https://www.linuxserver.io",
  async fetch() {
    const d = await getJSON("https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false");
    return (d.data.repositories.linuxserver as Record<string, any>[]).filter((i) => !i.deprecated).map((i) => ({
      name: i.name, description: i.description, category: String(i.category ?? "").split(",")[0] || undefined,
      website: i.project_url, repo: i.github_url, stars: i.stars, updated: String(i.version_timestamp ?? "").slice(0, 10), logo: i.project_logo,
      install: { method: "linuxserver", ref: i.name, label: "Docker (LinuxServer.io image)" },
    }));
  },
};

const homebrew: Source = {
  id: "homebrew", label: "Homebrew", everyHours: 24 * 7,
  attribution: "Homebrew formulae and casks — https://formulae.brew.sh",
  async fetch() {
    // Only formulae that run as a service, and casks: a library or CLI tool is not something you "host".
    const [f, c] = await Promise.all([getJSON("https://formulae.brew.sh/api/formula.json"), process.platform === "darwin" ? getJSON("https://formulae.brew.sh/api/cask.json") : []]);
    const out: SourceEntry[] = (f as Record<string, any>[]).filter((x) => x.service && !x.deprecated && !x.disabled).map((x) => ({
      name: x.name, description: x.desc, website: x.homepage, license: x.license ?? undefined,
      install: { method: "brew", ref: x.name, label: "Homebrew service" },
    }));
    for (const x of c as Record<string, any>[]) if (!x.deprecated && !x.disabled && x.desc)
      out.push({ name: x.name?.[0] ?? x.token, description: x.desc, website: x.homepage, install: { method: "cask", ref: x.token, label: "Homebrew cask (Mac app)" } });
    return out;
  },
};

const recipes: Source = {
  id: "recipes", label: "Server OS recipes", everyHours: 1,
  attribution: "Server OS recipes, MIT",
  async fetch() {
    const { listRecipes } = await import("./recipes");
    return listRecipes().map((r) => ({ name: r.name, description: r.description, category: r.category, website: r.website, repo: r.repo, logo: r.logo,
      install: { method: "recipe", ref: r.id, label: "Server OS recipe (tested)" } }));
  },
};

export const SOURCES: Source[] = [recipes, awesomeSelfhosted, casaos, linuxserver, homebrew];

// ---------- logos ----------
// Two icon libraries made for dashboards (homarr-labs/dashboard-icons, Apache-2.0; selfh.st/icons, CC BY 4.0),
// matched by name. They beat the sources' own logos (consistent, square, transparent); then the source's logo,
// the repo owner's avatar, the site's favicon, and only then a letter. Both serve svg/<name>.svg next to png/<name>.png.
const ICONS = {
  id: "icons", everyHours: 24 * 7,
  async fetch(): Promise<Record<string, string>> {
    const [dash, selfhst] = await Promise.all([
      getJSON("https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/tree.json").catch(() => ({ svg: [] })),
      getJSON("https://cdn.jsdelivr.net/gh/selfhst/icons@main/index.json").catch(() => []),
    ]);
    const out: Record<string, string> = {};
    for (const r of selfhst as { Reference: string; SVG?: string }[]) if (r.SVG === "Yes") out[r.Reference] = `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/${r.Reference}.svg`;
    for (const f of (dash as { svg?: string[] }).svg ?? []) { const k = f.replace(/\.svg$/, ""); if (!/-(light|dark)$/.test(k)) out[k] = `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${k}.svg`; }
    return out;
  },
};
async function refreshIcons(force: boolean): Promise<boolean> {
  const row = db().query("SELECT fetched FROM catalog_sources WHERE id = 'icons'").get() as { fetched: number } | null;
  if (!force && row && Date.now() - row.fetched < ICONS.everyHours * 3600_000) return false;
  try {
    const m = await ICONS.fetch();
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), "icons.json"), JSON.stringify(m));
    db().run("INSERT OR REPLACE INTO catalog_sources (id, fetched, count, error) VALUES ('icons', ?, ?, NULL)", [Date.now(), Object.keys(m).length]);
    return true;
  } catch (e) { logEvent("warn", `icon index failed: ${String(e)}`); return false; }
}
/** Best logo for an entry: an icon library hit by id / name / repo name, else its own logo, else the GitHub owner's avatar. */
function logoFor(it: CatalogItem, icons: Record<string, string>): string | null {
  const repoName = it.repo?.match(/github\.com\/[^/]+\/([^/#?]+)/i)?.[1];
  const keys = [it.id, it.id.replace(/-/g, ""), slugify(it.name).replace(/-(server|app|web|ngx|io)$/, ""), repoName && slugify(repoName)].filter(Boolean) as string[];
  for (const k of keys) if (icons[k]) return icons[k];
  if (it.logo) return it.logo;
  // GitHub and Gitea/Forgejo hosts (Codeberg) serve the owner's avatar at /<owner>.png.
  const forge = it.repo?.match(/^https:\/\/(github\.com|codeberg\.org)\/([^/#?]+)/i);
  if (forge) return `https://${forge[1]}/${forge[2]}.png${forge[1] === "github.com" ? "?size=128" : ""}`;
  // Last resort: the website's favicon, through DuckDuckGo's icon service (only the domain is sent).
  const host = (it.website ?? it.repo)?.match(/^https?:\/\/([^/:#?]+)/i)?.[1];
  return host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : null;
}
/** Entries known only to Homebrew (Mac apps, CLI services) are hidden unless the search asks for scope "all". */
const SELFHOSTED = new Set(["recipes", "awesome-selfhosted", "casaos", "linuxserver"]);

// ---------- index ----------
const CATALOG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
    stars INTEGER, updated TEXT, installable INTEGER NOT NULL, selfhosted INTEGER NOT NULL DEFAULT 1, genre TEXT NOT NULL DEFAULT 'other',
    tier TEXT NOT NULL DEFAULT 'agent', health TEXT NOT NULL DEFAULT 'unknown', data TEXT NOT NULL)`,
  "CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(id UNINDEXED, name, description, category, tokenize = 'unicode61 remove_diacritics 2')",
  "CREATE TABLE IF NOT EXISTS catalog_sources (id TEXT PRIMARY KEY, fetched INTEGER NOT NULL, count INTEGER NOT NULL, error TEXT)",
];
schema(...CATALOG_SCHEMA);

const readCache = (id: string): SourceEntry[] => { try { return JSON.parse(readFileSync(join(cacheDir(), `${id}.json`), "utf8")); } catch { return []; } };

/** Merge every source's cached entries by normalised name into one catalog and rebuild the search index. */
export function rebuild(): number {
  const merged = new Map<string, CatalogItem>();
  for (const s of SOURCES) for (const e of readCache(s.id)) {
    const id = slugify(e.name);
    if (!id) continue;
    const cur = merged.get(id) ?? { id, name: e.name, description: "", category: "", website: null, repo: null, license: null, stars: null, updated: null, archived: false, logo: null, sources: [], install: [], genre: "other", sub: null, tier: "agent" as Tier, health: "unknown" as Health, replaces: [], screenshots: [], arch: null };
    // First non-empty value wins, in SOURCES order (curated recipes, then awesome-selfhosted's descriptions).
    cur.description ||= e.description ?? "";
    cur.category ||= e.category ?? "";
    cur.sub ??= e.sub ?? null;
    if (!cur.screenshots.length && e.screenshots?.length) cur.screenshots = e.screenshots;
    cur.arch ??= e.arch ?? null;
    cur.website ??= e.website ?? null; cur.repo ??= e.repo ?? null; cur.license ??= e.license ?? null; cur.logo ??= e.logo ?? null;
    cur.stars = Math.max(cur.stars ?? 0, e.stars ?? 0) || null;
    if (e.updated && (!cur.updated || e.updated > cur.updated)) cur.updated = e.updated;
    cur.archived ||= !!e.archived;
    if (!cur.sources.includes(s.id)) cur.sources.push(s.id);
    if (e.install && !cur.install.some((o) => o.method === e.install!.method)) cur.install.push(e.install);
    merged.set(id, cur);
  }
  const reps = replacesById(), now = Date.now();
  let icons: Record<string, string> = {};
  try { icons = JSON.parse(readFileSync(join(cacheDir(), "icons.json"), "utf8")); } catch { /* not fetched yet */ }
  const d = db();
  d.transaction(() => {
    d.run("DELETE FROM catalog"); d.run("DELETE FROM catalog_fts");
    const ins = d.prepare("INSERT INTO catalog (id, name, description, category, stars, updated, installable, selfhosted, genre, tier, health, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const fts = d.prepare("INSERT INTO catalog_fts (id, name, description, category) VALUES (?, ?, ?, ?)");
    for (const it of merged.values()) {
      it.install.sort((a, b) => METHOD_RANK.indexOf(a.method) - METHOD_RANK.indexOf(b.method));
      it.category ||= "Other";
      it.genre = genreOf(it.category) !== "other" || !it.sub ? genreOf(it.category) : genreOf(it.sub);
      it.tier = it.install[0]?.method === "recipe" ? "ready" : it.install.some((o) => o.method !== "dockerhub") ? "oneclick" : "agent";
      const age = it.updated ? (now - Date.parse(it.updated)) / 86_400_000 : NaN;
      it.health = it.archived ? "archived" : Number.isNaN(age) ? "unknown" : age <= 183 ? "active" : age <= 548 ? "slowing" : "stale";
      it.replaces = reps.get(it.id) ?? [];
      it.logo = logoFor(it, icons);
      ins.run(it.id, it.name, it.description, it.category, it.stars, it.updated, it.install.length ? 1 : 0, it.sources.some((x) => SELFHOSTED.has(x)) ? 1 : 0, it.genre, it.tier, it.health, JSON.stringify(it));
      // "replace google photos" finds Immich: the services it replaces are searchable with its description.
      fts.run(it.id, it.name, `${it.description}${it.replaces.length ? ` replaces ${it.replaces.join(", ")}` : ""}`, `${it.category} ${it.sub ?? ""}`);
    }
  })();
  return merged.size;
}

export async function refreshSource(s: Source): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const entries = await s.fetch();
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), `${s.id}.json`), JSON.stringify(entries));
    db().run("INSERT OR REPLACE INTO catalog_sources (id, fetched, count, error) VALUES (?, ?, ?, NULL)", [s.id, Date.now(), entries.length]);
    logEvent("info", `catalog source ${s.id}: ${entries.length} entries`, { source: s.id });
    return { ok: true, count: entries.length };
  } catch (e) {
    db().run("INSERT INTO catalog_sources (id, fetched, count, error) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET fetched = excluded.fetched, error = excluded.error", [s.id, Date.now(), String(e)]);
    logEvent("warn", `catalog source ${s.id} failed: ${String(e)}`, { source: s.id });
    return { ok: false, count: 0, error: String(e) };
  }
}

/** Re-read recipes now (after the agent wrote one), so install_app can use it right away. */
export async function refreshRecipes() { const r = await refreshSource(recipes); rebuild(); return r; }

let refreshing = false;
/** Refresh sources that are due (or all with force), then rebuild the index. */
export async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const seen = new Map((db().query("SELECT id, fetched FROM catalog_sources").all() as { id: string; fetched: number }[]).map((r) => [r.id, r.fetched]));
    let changed = false;
    for (const s of SOURCES) if (force || Date.now() - (seen.get(s.id) ?? 0) > s.everyHours * 3600_000) { await refreshSource(s); changed = true; }
    if (await refreshIcons(force)) changed = true;
    if (changed || !(db().query("SELECT COUNT(*) AS n FROM catalog").get() as { n: number }).n) rebuild();
  } finally { refreshing = false; }
}

export interface SearchQuery { q?: string; category?: string; genre?: string; tier?: Tier; fresh?: boolean; installable?: boolean; scope?: "selfhosted" | "all"; sort?: "relevance" | "stars" | "updated" | "name"; limit?: number; offset?: number }
export interface Facets { tiers: Record<Tier, number>; categories: { category: string; count: number }[]; hidden: number }
export function search(o: SearchQuery): { total: number; items: CatalogItem[]; facets: Facets } {
  // Each filter is tagged with its dimension, so a facet's counts can leave its own filter out
  // (the tier buttons show how many each tier would give with everything else applied).
  const conds: { dim: string; sql: string; args: (string | number)[] }[] = [];
  let from = "catalog c";
  const terms = (o.q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length) { from = "catalog_fts f JOIN catalog c ON c.id = f.id"; conds.push({ dim: "q", sql: "catalog_fts MATCH ?", args: [terms.map((t) => `"${t}"*`).join(" ")] }); }
  if (o.category) conds.push({ dim: "category", sql: "c.category = ?", args: [o.category] });
  if (o.genre) conds.push({ dim: "genre", sql: "c.genre = ?", args: [o.genre] });
  if (o.tier) conds.push({ dim: "tier", sql: "c.tier = ?", args: [o.tier] });
  if (o.fresh) conds.push({ dim: "fresh", sql: "c.health NOT IN ('stale', 'archived')", args: [] });
  if (o.installable) conds.push({ dim: "installable", sql: "c.installable = 1", args: [] });
  if (o.scope !== "all") conds.push({ dim: "scope", sql: "c.selfhosted = 1", args: [] });
  const build = (skip?: string) => {
    const cs = conds.filter((c) => c.dim !== skip);
    return { w: cs.length ? `WHERE ${cs.map((c) => c.sql).join(" AND ")}` : "", a: cs.flatMap((c) => c.args) };
  };
  const { w, a: args } = build();
  const sort = o.sort ?? (terms.length ? "relevance" : "stars");
  // (No porter stemmer: it stems the typed prefix — "jelly" → "jelli" — so prefix search would miss "jellyfin".)
  // Exact name hits first, then BM25 (name weighted 10×) boosted by popularity and having an install method
  // (bm25 is negative — lower is better — so the boost multiplies it).
  const order = sort === "relevance" && terms.length ? `(lower(c.name) = ?) DESC, bm25(catalog_fts, 0, 10, 1, 2) * (1 + 0.5 * c.installable + COALESCE(c.stars, 0) / (COALESCE(c.stars, 0) + 5000.0))` : sort === "updated" ? "c.updated DESC" : sort === "name" ? "c.name COLLATE NOCASE" : "c.stars DESC NULLS LAST, c.name";
  const orderArgs = sort === "relevance" && terms.length ? [(o.q ?? "").trim().toLowerCase()] : [];
  const total = (db().query(`SELECT COUNT(*) AS n FROM ${from} ${w}`).get(...args) as { n: number }).n;
  const rows = db().query(`SELECT c.data FROM ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, ...orderArgs, Math.min(o.limit ?? 30, 100), o.offset ?? 0) as { data: string }[];
  const ft = build("tier"), fc = build("category"), ff = build("fresh");
  const tiers = { ready: 0, oneclick: 0, agent: 0 } as Record<Tier, number>;
  for (const r of db().query(`SELECT c.tier AS tier, COUNT(*) AS n FROM ${from} ${ft.w} GROUP BY c.tier`).all(...ft.a) as { tier: Tier; n: number }[]) tiers[r.tier] = r.n;
  const cats = db().query(`SELECT c.category AS category, COUNT(*) AS count FROM ${from} ${fc.w} GROUP BY c.category ORDER BY count DESC LIMIT 40`).all(...fc.a) as { category: string; count: number }[];
  const hidden = o.fresh ? (db().query(`SELECT COUNT(*) AS n FROM ${from} ${ff.w}`).get(...ff.a) as { n: number }).n - total : 0;
  return { total, items: rows.map((r) => JSON.parse(r.data)), facets: { tiers, categories: cats, hidden } };
}

export const getItem = (id: string): CatalogItem | null => { const r = db().query("SELECT data FROM catalog WHERE id = ?").get(id) as { data: string } | null; return r ? JSON.parse(r.data) : null; };
/** Genres with their size, sub-shelves (categories) and a few logos for the tile. */
export function genres() {
  const counts = new Map((db().query("SELECT genre, COUNT(*) AS n, SUM(tier != 'agent') AS installable FROM catalog WHERE selfhosted = 1 GROUP BY genre").all() as { genre: string; n: number; installable: number }[]).map((r) => [r.genre, r]));
  const cats = db().query("SELECT genre, category, COUNT(*) AS count FROM catalog WHERE selfhosted = 1 GROUP BY genre, category ORDER BY count DESC").all() as { genre: string; category: string; count: number }[];
  const logos = db().query("SELECT genre, json_extract(data, '$.logo') AS logo, json_extract(data, '$.name') AS name FROM catalog WHERE selfhosted = 1 AND json_extract(data, '$.logo') IS NOT NULL AND tier != 'agent' ORDER BY stars DESC NULLS LAST").all() as { genre: string; logo: string; name: string }[];
  return GENRES.map((g) => ({
    id: g.id, label: g.label, blurb: g.blurb, icon: g.icon, count: counts.get(g.id)?.n ?? 0, installable: counts.get(g.id)?.installable ?? 0,
    categories: cats.filter((c) => c.genre === g.id).map(({ category, count }) => ({ category, count })),
    logos: logos.filter((l) => l.genre === g.id).slice(0, 4).map(({ logo, name }) => ({ logo, name })),
  })).filter((g) => g.count);
}

const rowsOf = (sql: string, ...args: (string | number)[]) => (db().query(sql).all(...args) as { data: string }[]).map((r) => JSON.parse(r.data) as CatalogItem);
const byIds = (ids: string[]) => ids.map(getItem).filter((x): x is CatalogItem => !!x);
const BASE = "FROM catalog WHERE selfhosted = 1 AND health != 'archived'";

/**
 * Discover's front page, top to bottom: editor's picks (rotate weekly), "Instead of …", starter packs, then shelves —
 * top charts, "because you run X" (from what runs on this server), recently updated, hidden gems, one per genre.
 * `running`: catalog ids of apps on this server, so shelves skip them and "because you run" has something to go on.
 */
export function home(running: Set<string> = new Set(), perShelf = 12) {
  const c = curation();
  const picks = weeklyPicks().flatMap((p) => { const it = getItem(p.id); return it ? [{ ...p, item: it }] : []; });
  const replaces = Object.entries(c.replaces).map(([service, ids]) => ({ service, items: byIds(ids) })).filter((r) => r.items.length);
  const packs = c.packs.map((p) => ({ ...p, items: byIds(p.apps) })).filter((p) => p.items.length);
  const recent = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const because = [...running].filter((id) => c.pairs[id]?.length).slice(0, 2).map((id) => ({
    id: `because:${id}`, title: `Because you run ${getItem(id)?.name ?? id}`, subtitle: "Apps people install next to it.",
    items: (c.pairs[id] ?? []).flatMap((p) => { const it = getItem(p.id); return it && !running.has(it.id) ? [{ ...it, why: p.why }] : []; }),
  }));
  const shelves = [
    { id: "top", title: "Top charts", subtitle: "The most-starred apps you can install in one click.", items: rowsOf(`SELECT data ${BASE} AND tier != 'agent' ORDER BY stars DESC NULLS LAST LIMIT ?`, perShelf) },
    ...because,
    { id: "ready", title: "Ready to use", subtitle: "Tested recipes: installed, given an address and set up for you.", items: rowsOf(`SELECT data ${BASE} AND tier = 'ready' ORDER BY stars DESC NULLS LAST LIMIT ?`, perShelf) },
    { id: "updated", title: "Recently updated", subtitle: "Well-known projects that shipped something new lately.", items: rowsOf(`SELECT data ${BASE} AND tier != 'agent' AND stars >= 1000 AND updated IS NOT NULL ORDER BY updated DESC LIMIT ?`, perShelf) },
    { id: "gems", title: "Hidden gems", subtitle: "Smaller, well-kept projects worth a look.", items: rowsOf(`SELECT data ${BASE} AND tier != 'agent' AND stars BETWEEN 300 AND 3000 AND updated >= ? ORDER BY random() LIMIT ?`, recent, perShelf) },
    ...GENRES.filter((g) => g.id !== "other").map((g) => ({ id: `genre:${g.id}`, title: g.label, subtitle: g.blurb, genre: g.id,
      items: rowsOf(`SELECT data ${BASE} AND genre = ? AND tier != 'agent' ORDER BY stars DESC NULLS LAST LIMIT ?`, g.id, perShelf) })),
  ].filter((s) => s.items.length);
  return { picks, featured: featured(), replaces, packs, shelves };
}

type Featured = Pick & { item: CatalogItem };
const SIDE_THEMES = [["network", "files", "docs", "dev", "server", "ai", "business"], ["media", "photos", "home", "productivity", "chat", "games", "web", "other"]];
function seeded(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled<T>(xs: T[], rnd: () => number) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * What the Editor's-pick slots rotate through: a hero list (starts with this week's hero, prefers apps with a
 * screenshot and a logo) and one list per side card, grouped by theme. The lists never share an app, so no app is on
 * screen twice at any moment. Same order for everyone within an ISO week.
 */
export function featured(week = weekIndex(), heroN = 7, sideN = 6): { hero: Featured[]; side: Featured[][] } {
  const rnd = seeded(week);
  const weekly = weeklyPicks(3, week);
  const curated: Featured[] = curation().picks.flatMap((p) => { const it = getItem(p.id); return it ? [{ ...p, item: it }] : []; });
  const have = new Set(curated.map((p) => p.id));
  const poolRows = rowsOf(`SELECT data ${BASE} AND tier != 'agent' ORDER BY stars DESC NULLS LAST LIMIT 120`);
  const extra: Featured[] = poolRows.filter((it) => !have.has(it.id)).map((it) => ({
    id: it.id, item: it, kicker: it.tier === "ready" ? "Ready to use" : `Top in ${getGenre(it.genre)?.label ?? it.category}`,
    why: it.description.length > 140 ? `${it.description.slice(0, 137).trimEnd()}…` : it.description,
  }));
  const taken = new Set<string>();
  const take = (xs: Featured[], n: number, into: Featured[]) => { for (const x of xs) { if (into.length >= n) break; if (!taken.has(x.id)) { taken.add(x.id); into.push(x); } } return into; };
  const wk = weekly.map((w) => curated.find((c) => c.id === w.id)).filter((x): x is Featured => !!x);
  const pool = [...shuffled(curated, rnd), ...shuffled(extra, rnd)];
  // side slots first get this week's 2nd/3rd pick, then their theme, so the hero can claim the rest by screenshot
  const sides: Featured[][] = SIDE_THEMES.map(() => []);
  sides.forEach((s, i) => { if (wk[i + 1]) take([wk[i + 1]], sideN, s); });
  const hero: Featured[] = [];
  if (wk[0]) take([wk[0]], heroN, hero);
  const shots = (x: Featured) => (x.item.screenshots?.length ? 1 : 0) + (x.item.logo ? 1 : 0);
  take([...pool].sort((a, b) => shots(b) - shots(a)), heroN, hero);
  SIDE_THEMES.forEach((theme, i) => {
    const fit = (x: Featured) => (theme.includes(x.item.genre) ? 0 : 1);
    take([...pool].sort((a, b) => fit(a) - fit(b)), sideN, sides[i]);
  });
  return { hero, side: sides };
}

/** An app's page: the entry plus similar apps, what it works well with, and the packs it is in. */
export function detail(id: string) {
  const it = getItem(id);
  if (!it) return null;
  const c = curation();
  const similar = rowsOf(`SELECT data ${BASE} AND id != ? AND (category = ? OR genre = ?) ORDER BY (category = ?) DESC, (tier != 'agent') DESC, stars DESC NULLS LAST LIMIT 6`,
    id, it.category, it.genre, it.category);
  const pairs = (c.pairs[id] ?? []).flatMap((p) => { const x = getItem(p.id); return x ? [{ ...x, why: p.why }] : []; });
  const packs = c.packs.filter((p) => p.apps.includes(id)).map(({ id, name }) => ({ id, name }));
  return { ...it, similar, pairs, packs };
}

export const categories = () => db().query("SELECT category, COUNT(*) AS count FROM catalog WHERE selfhosted = 1 GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];
export const sourceStatus = () => {
  const rows = new Map((db().query("SELECT id, fetched, count, error FROM catalog_sources").all() as { id: string; fetched: number; count: number; error: string | null }[]).map((r) => [r.id, r]));
  return SOURCES.map((s) => ({ id: s.id, label: s.label, attribution: s.attribution, everyHours: s.everyHours, fetched: rows.get(s.id)?.fetched ?? null, count: rows.get(s.id)?.count ?? 0, error: rows.get(s.id)?.error ?? null }));
};

/** Docker Hub long tail: searched live, never indexed. */
export async function dockerHub(q: string): Promise<CatalogItem[]> {
  const d = await getJSON(`https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=10`).catch(() => ({ results: [] }));
  return (d.results as Record<string, any>[]).map((r) => ({
    id: `dockerhub-${slugify(r.repo_name)}`, name: r.repo_name, description: r.short_description ?? "", category: "Docker Hub", website: `https://hub.docker.com/r/${r.repo_name.includes("/") ? r.repo_name : `_/${r.repo_name}`}`,
    repo: null, license: null, stars: r.star_count ?? null, updated: null, archived: false, logo: null, sources: ["dockerhub"],
    install: [{ method: "dockerhub", ref: r.repo_name, label: "Docker Hub image (needs the agent)" }],
    genre: "other", sub: null, tier: "agent" as Tier, health: "unknown" as Health, replaces: [], screenshots: [], arch: null,
  }));
}

export function startCatalog() {
  // The catalog table is a cache rebuilt from data/catalog/*.json: on a schema change, drop it and rebuild.
  const cols = (db().query("PRAGMA table_info(catalog)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("health")) {
    db().run("DROP TABLE IF EXISTS catalog");
    for (const sql of CATALOG_SCHEMA) db().run(sql);
    rebuild();
  }
  void refresh().catch((e) => logEvent("error", `catalog refresh: ${String(e)}`));
  setInterval(() => void refresh().catch((e) => logEvent("error", `catalog refresh: ${String(e)}`)), 3600_000);
}
