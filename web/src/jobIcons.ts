// Picks an icon for the free-text entries on a job's ID card ("AdGuard Home API (:3080)", "docker exec", "Telegram notify bot").
// Order: an explicit hint from the card, then the earliest match among the Apps tab (by name or .home host), then known brands
// (selfh.st logos through jsDelivr, the same CDN the Discover tab uses), then a generic Lucide icon, then a letter tile.
import type { AppState } from "./store";
import { ICONS, type IconName } from "./icons";

export type Glyph =
  | { kind: "app"; app: AppState; key: string }
  | { kind: "brand"; url: string; fallback: IconName; key: string }
  | { kind: "lucide"; icon: IconName; key: string }
  | { kind: "letter"; key: string };

export const brandUrl = (slug: string) => `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/${slug}.svg`;

// [pattern, selfh.st slug or "lucide:<icon>"]. The earliest match in the label wins; on a tie the first row wins.
const RULES: [RegExp, string][] = [
  [/\bdocker\b/, "docker"], [/\b(?:homebrew|brew)\b/, "lucide:beer"], [/\bnpm\b/, "npm"], [/\bbun\b/, "bun"],
  [/\bpython[\d.]*\b|\.venv|\buvicorn\b|\bfastapi\b|\bhttpx\b|\buv\b|\bmlx\b|pytorch/, "python"],
  [/\bnode(?:\.js)?\b|\bnext\b|\bremotion\b/, "node-js"], [/\bhono\b|\bfastapi\b/, "lucide:zap"], [/\bvite\b/, "vite"], [/\bgit\b/, "git"], [/\bgithub\b/, "github"],
  [/\btelegram\b|\bnotify(?:_cron\.py| bot)|\bnotify\b/, "telegram"], [/\bcloudflare\b|\bcf tunnel\b/, "cloudflare"], [/\btailscale\b/, "tailscale"],
  [/\banthropic\b|\bclaude\b/, "claude"], [/\bposthog\b/, "posthog"], [/\bsupabase\b/, "supabase"], [/\bstripe\b/, "stripe"], [/\blemonsqueezy\b/, "lucide:shopping-cart"],
  [/\bobsidian\b/, "obsidian"], [/\bicloud\b/, "icloud"], [/\bcaddy\b/, "caddy"], [/\bpostgres(?:ql)?\b|\bpg_dump\b/, "postgresql"], [/\bphp\b|\bocc\b/, "php"],
  [/\bchrome\b/, "chrome"], [/\bgmail\b/, "gmail"], [/\byoutube\b/, "youtube"], [/\bgoogle news\b/, "google-news"], [/\bgoogle\b/, "google"],
  [/\byahoo\b|\byfinance\b/, "yahoo"], [/\bminecraft\b|\brcon\b/, "minecraft"], [/\bjava\b|\bopenjdk\b|\bpaper\.jar\b/, "java"], [/\btwitter\b|\bx\/twitter\b/, "twitter"],
  [/\binfisical\b/, "infisical"], [/\bn8n\b/, "n8n"], [/\byt-dlp\b/, "yt-dlp"], [/\bandroid\b|\badb\b/, "android"],
  [/\bxcode\b|\bxcrun\b|\bsimctl\b|\bosascript\b|\bapple\b|\bairplay\b|\bmacos\b/, "apple"],
  [/\bsqlite3?\b|\brag\.db\b|\bdashboard\.db\b|\bsqlite-vec\b|\bdatabase\b/, "lucide:database"], [/\btmux\b|\biterm2?\b|\bbotgw\b/, "lucide:square-terminal"],
  [/\blaunchctl\b|\blaunchd\b|\btmutil\b/, "lucide:cog"], [/\bffmpeg\b/, "lucide:clapperboard"], [/\bcron_wrap\b/, "lucide:timer"],
  [/\btrading ?212\b|\bfinnhub\b|\bsec (?:edgar|filings)\b|\bedgar\b/, "lucide:trending-up"], [/\bautoscout24\b|\brdw\b/, "lucide:car"],
  [/\bkokoro\b|\bchatterbox\b|\btts\b|\bcoqui\b|\bpiper\b|\bvoice\b/, "lucide:audio-lines"], [/\butm\b/, "lucide:monitor"], [/\biphone\b/, "lucide:smartphone"],
  [/\bwebhooks?\b/, "lucide:webhook"], [/\brss\b/, "lucide:rss"],
  [/^(?:bash|zsh|sh|curl|find|grep|ps|pgrep|pkill|lsof|df|ls|date|tar|gzip|openssl|open|ssh|sshpass|php occ|requests|urllib|soundfile)\b/, "lucide:terminal"],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const host = (href: string) => { try { return new URL(href).hostname; } catch { return ""; } };
const compile = (apps: AppState[]) => apps.flatMap((a) => {
  const n = a.name.toLowerCase(), h = host(a.href).toLowerCase();
  const pats = [new RegExp(`(?<![\\w])${esc(n)}(?![\\w])`)];
  if (h.endsWith(".home")) pats.push(new RegExp(`(?<![\\w.])${esc(h)}(?![\\w])`));
  return pats.map((re) => [re, a] as const);
});
let cache: { apps: AppState[]; pats: ReturnType<typeof compile> } | null = null;

function fromHint(hint: string, apps: AppState[]): Glyph | null {
  const h = hint.trim();
  const app = apps.find((a) => a.name.toLowerCase() === h.toLowerCase());
  if (app) return { kind: "app", app, key: "app:" + app.name };
  if (h.startsWith("lucide:")) return h.slice(7) in ICONS ? { kind: "lucide", icon: h.slice(7) as IconName, key: h } : null;
  return /^[a-z0-9-]+$/.test(h) ? { kind: "brand", url: brandUrl(h), fallback: "package" as IconName, key: "brand:" + h } : null;
}

/** label: the entry as written on the card; hint: optional card.icons[label]. */
export function resolveGlyph(label: string, apps: AppState[], hint?: string): Glyph {
  if (hint) { const g = fromHint(hint, apps); if (g) return g; }
  if (!cache || cache.apps !== apps) cache = { apps, pats: compile(apps) };
  const l = label.toLowerCase();
  let best: { at: number; g: Glyph } | null = null;
  for (const [re, app] of cache.pats) { const m = re.exec(l); if (m && (!best || m.index < best.at)) best = { at: m.index, g: { kind: "app", app, key: "app:" + app.name } }; }
  for (const [re, to] of RULES) {
    const m = re.exec(l);
    if (!m || (best && m.index >= best.at)) continue;
    best = { at: m.index, g: to.startsWith("lucide:") ? { kind: "lucide", icon: to.slice(7) as IconName, key: to } : { kind: "brand", url: brandUrl(to), fallback: "package" as IconName, key: "brand:" + to } };
  }
  return best?.g ?? { kind: "letter", key: "letter:" + l };
}

/** "Docker Desktop (kill -9 and relaunch)" -> name + note, so a tile shows the app and keeps the detail small. */
export function splitLabel(label: string): { name: string; note: string } {
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(label.trim());
  return m && m[1] ? { name: m[1], note: m[2] } : { name: label.trim(), note: "" };
}

export type PathEffect = "deleted" | "truncated" | "written" | "";
export interface PathRow { path: string; effect: PathEffect; icon: IconName }
/** "~/Library/Caches/* older than 14d (deleted)" -> the path, its effect and an icon by what it looks like. */
export function parsePath(raw: string): PathRow {
  const m = /\((deleted|truncated|written|cleared|removed|rewritten|appended|created|updated)\)\s*$/i.exec(raw);
  const w = m?.[1].toLowerCase() ?? "";
  const effect: PathEffect = /deleted|removed|cleared/.test(w) ? "deleted" : w === "truncated" ? "truncated" : w ? "written" : "";
  const path = m ? raw.slice(0, m.index).trim() : raw.trim();
  const l = path.toLowerCase();
  const icon: IconName = /\.env\b|secret/.test(l) ? "key-round" : /\.(db|sqlite)\b|\bdatabase\b/.test(l) ? "database" : /\blogs?\b|\.log\b/.test(l) ? "file-text"
    : /cache|derived ?data|tmp|scratchpad/.test(l) ? "archive" : /\.[a-z0-9]{1,5}$/.test(l) && !l.endsWith("/*") ? "file-text" : "folder";
  return { path, effect, icon };
}
