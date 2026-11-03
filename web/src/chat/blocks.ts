// The voice chat's message model, pure (no Vue, no DOM), so the server's tests cover it (server/modules/voiceChat.test.ts).
// - turns(): the bot's feed items → chat turns: what the person said, and the assistant's answer with the work and the
//   web pages it used in between.
// - segments(): an answer's text → markdown and component blocks. The agent writes a fenced block whose language is a
//   component name and whose body is JSON (docs/voice-chat.md):
//     ```card     {"title", "subtitle"?, "body"?, "image"?, "url"?, "badge"?, "fields"?: [{"label","value"}]}
//     ```sources  [{"title","url","snippet"?}]   (or {"items": [...]})
//     ```chart    {"type": "bar"|"line", "title"?, "unit"?, "labels": [...], "series": [{"name","values": [...]}]}
//   and the living-room widgets (weather, timer, home, media, image, steps, stat, compare, agenda: asWidget below).
//   A block that isn't valid JSON or doesn't fit its shape is shown as code (the panel) or left out (the TV), never
//   half drawn. TTS skips all of them.

export interface WebSource { title: string; url: string; domain: string; snippet?: string; error?: string }
export interface FeedLike {
  id: string; kind: "user" | "assistant" | "step" | "event"; ts: number; text?: string; via?: string; nonce?: string; local?: string; error?: string;
  tool?: string; title?: string; detail?: string; status?: "running" | "ok" | "error"; ms?: number; sources?: WebSource[]; summary?: string;
}

// ---------- what the person sent ----------
export const CHAT_PREFIX = "[Chat] ";
/** Spoken messages carry the language like the apps send them: "[Voice] …", or "[Voice tr] …" for Turkish. The TV
 *  kiosk sends "[TV] …" / "[TV tr] …": spoken too, but answered for a screen across the room (docs/voice-chat.md). */
export const voicePrefix = (lang: string | null | undefined, tv = false) => `[${tv ? "TV" : "Voice"}${lang === "tr" ? " tr" : ""}] `;
const PREFIX_RE = /^\s*\[(Voice|TV|Chat)(?:\s+([a-z]{2}))?\]\s*/;
export function stripPrefix(text: string): { text: string; mode: "voice" | "chat" | null; lang: string | null; tv?: true } {
  const m = text.match(PREFIX_RE);
  if (!m || (m[1] === "Chat" && m[2])) return { text, mode: null, lang: null };
  return { text: text.slice(m[0].length), mode: m[1] === "Chat" ? "chat" : "voice", lang: m[2] ?? null, ...(m[1] === "TV" ? { tv: true as const } : {}) };
}

// ---------- component blocks ----------
export interface Card { title: string; subtitle?: string; body?: string; image?: string; url?: string; badge?: string; fields?: { label: string; value: string }[] }
export interface Chart { type: "bar" | "line"; title?: string; unit?: string; labels: string[]; series: { name: string; values: (number | null)[] }[] }
export type Segment =
  | { type: "md"; text: string }
  | { type: "code"; lang: string; code: string; broken?: true }
  | { type: "card"; card: Card }
  | { type: "sources"; sources: WebSource[] }
  | { type: "chart"; chart: Chart }
  | { type: "widget"; w: Widget };
export const WIDGETS = ["weather", "timer", "home", "media", "image", "steps", "stat", "compare", "agenda"] as const;
export const COMPONENTS = ["card", "sources", "chart", ...WIDGETS] as const;

/** http(s) only: a block can't smuggle javascript: or data: links into the page. */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : undefined; } catch { return undefined; }
}
export const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

export function asCard(v: unknown): Card | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const title = str(o.title, 160);
  if (!title) return null;
  const fields = Array.isArray(o.fields) ? o.fields.flatMap((f) => {
    const x = f as Record<string, unknown>; const label = str(x?.label, 60), value = x?.value == null ? undefined : String(x.value).slice(0, 120);
    return label && value ? [{ label, value }] : [];
  }).slice(0, 8) : undefined;
  return { title, subtitle: str(o.subtitle, 160), body: str(o.body, 1200), image: safeUrl(o.image), url: safeUrl(o.url), badge: str(o.badge, 24), ...(fields?.length ? { fields } : {}) };
}
export function asSources(v: unknown): WebSource[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : null;
  if (!list) return null;
  const out = list.flatMap((x) => {
    const o = x as Record<string, unknown>; const url = safeUrl(o?.url);
    return url ? [{ url, domain: domainOf(url), title: str(o.title, 160) ?? domainOf(url), ...(str(o.snippet, 300) ? { snippet: str(o.snippet, 300) } : {}) }] : [];
  });
  return out.length ? out.slice(0, 12) : null;
}
export function asChart(v: unknown): Chart | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.labels) || !Array.isArray(o.series) || !o.labels.length || o.labels.length > 60) return null;
  const labels = o.labels.map((l) => String(l).slice(0, 24));
  const series = o.series.flatMap((s) => {
    const x = s as Record<string, unknown>;
    if (!Array.isArray(x?.values)) return [];
    const values = labels.map((_, i) => { const n = Number((x.values as unknown[])[i]); return (x.values as unknown[])[i] == null || !Number.isFinite(n) ? null : n; });
    return values.some((n) => n !== null) ? [{ name: str(x.name, 40) ?? "", values }] : [];
  }).slice(0, 4);
  if (!series.length) return null;
  return { type: o.type === "line" ? "line" : "bar", title: str(o.title, 120), unit: str(o.unit, 12), labels, series };
}

// ---------- living-room widgets ----------
export type WxIcon = "sun" | "partly" | "cloud" | "rain" | "drizzle" | "storm" | "snow" | "fog" | "wind" | "night";
export interface Weather { kind: "weather"; place?: string; unit: string; now?: { temp: number; summary?: string; icon: WxIcon; feels?: number }; high?: number; low?: number;
  rain?: number; wind?: string; hours: { label: string; temp: number; icon: WxIcon; rain?: number }[]; days: { label: string; high: number; low: number; icon: WxIcon; rain?: number }[] }
export interface Timer { kind: "timer"; label?: string; seconds?: number; until?: string }
export type HomeKind = "light" | "switch" | "plug" | "climate" | "sensor" | "media" | "lock" | "cover" | "fan" | "scene" | "door" | "other";
export interface HomeTiles { kind: "home"; title?: string; items: { name: string; state: string; type: HomeKind; on: boolean; area?: string }[] }
export interface Media { kind: "media"; title: string; artist?: string; album?: string; source?: string; image?: string; state: "playing" | "paused" | "idle"; position?: number; duration?: number }
export interface Images { kind: "image"; items: { url: string; caption?: string; credit?: string }[] }
export interface Steps { kind: "steps"; title?: string; ordered: boolean; items: { title: string; detail?: string; done?: boolean }[] }
export interface Stats { kind: "stat"; items: { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down" | "flat"; note?: string }[] }
export interface Compare { kind: "compare"; title?: string; items: string[]; rows: { label: string; values: string[] }[]; pick?: number }
export interface Agenda { kind: "agenda"; title?: string; items: { time?: string; title: string; detail?: string; where?: string; day?: string }[] }
export type Widget = Weather | Timer | HomeTiles | Media | Images | Steps | Stats | Compare | Agenda;

/** https only for pictures: an http one would be blocked on the https panel anyway. */
export const safeImage = (u: unknown) => { const x = safeUrl(u); return x?.startsWith("https:") ? x : undefined; };
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A list given as the block itself or as its "items". */
const listOf = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : Array.isArray(obj(v)?.items) ? (obj(v)!.items as unknown[]) : null);
const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const txt = (v: unknown, n: number) => (typeof v === "number" && Number.isFinite(v) ? String(v) : str(v, n));
const pct = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.round(Math.min(100, Math.max(0, n <= 1 && n > 0 && !Number.isInteger(n) ? n * 100 : n))); };
const WX: [RegExp, WxIcon][] = [[/thunder|storm|lightning/, "storm"], [/snow|sleet|hail/, "snow"], [/drizzle/, "drizzle"], [/rain|shower/, "rain"], [/fog|mist|haze/, "fog"],
  [/wind|gale/, "wind"], [/night|moon|clear-night/, "night"], [/partly|partial|sun.*cloud|cloud.*sun|few|scattered|bright interval/, "partly"], [/cloud|overcast|grey|gray/, "cloud"], [/sun|clear|fair/, "sun"]];
export function wxIcon(icon: unknown, summary?: unknown): WxIcon {
  for (const s of [icon, summary]) { const t = typeof s === "string" ? s.toLowerCase() : ""; if (t) for (const [re, i] of WX) if (re.test(t)) return i; }
  return "cloud";
}
const HOME_KINDS: HomeKind[] = ["light", "switch", "plug", "climate", "sensor", "media", "lock", "cover", "fan", "scene", "door", "other"];
const ON_STATES = /^(on|open|opening|playing|unlocked|heat|cool|heating|cooling|auto|home|active|running|detected)$/i;

export function asWidget(kind: string, v: unknown): Widget | null {
  const o = obj(v);
  switch (kind) {
    case "weather": {
      if (!o) return null;
      const n = obj(o.now), nt = num(n?.temp);
      const now = n && nt !== undefined ? { temp: nt, summary: str(n.summary, 60), icon: wxIcon(n.icon, n.summary), ...(num(n.feels) !== undefined ? { feels: num(n.feels) } : {}) } : undefined;
      const hours = (Array.isArray(o.hours) ? o.hours : []).flatMap((h) => { const x = obj(h), t = num(x?.temp), l = txt(x?.label ?? x?.time, 12);
        return x && t !== undefined && l ? [{ label: l, temp: t, icon: wxIcon(x.icon, x.summary), ...(pct(x.rain) !== undefined ? { rain: pct(x.rain) } : {}) }] : []; }).slice(0, 8);
      const days = (Array.isArray(o.days) ? o.days : []).flatMap((d) => { const x = obj(d), hi = num(x?.high), lo = num(x?.low), l = txt(x?.label ?? x?.day, 12);
        return x && hi !== undefined && lo !== undefined && l ? [{ label: l, high: hi, low: lo, icon: wxIcon(x.icon, x.summary), ...(pct(x.rain) !== undefined ? { rain: pct(x.rain) } : {}) }] : []; }).slice(0, 7);
      if (!now && !hours.length && !days.length) return null;
      return { kind, place: str(o.place, 60), unit: str(o.unit, 2)?.toUpperCase() === "F" ? "F" : "C", now, high: num(o.high), low: num(o.low), rain: pct(o.rain), wind: txt(o.wind, 24), hours, days };
    }
    case "timer": {
      if (!o) return null;
      const s = num(o.seconds) ?? (num(o.minutes) !== undefined ? num(o.minutes)! * 60 : undefined);
      const until = typeof o.until === "string" && Number.isFinite(Date.parse(o.until)) ? new Date(o.until).toISOString() : undefined;
      if (s !== undefined && s > 0 && s <= 86_400) return { kind, label: str(o.label, 60), seconds: Math.round(s) };
      if (until) return { kind, label: str(o.label, 60), until };
      return null;
    }
    case "home": {
      const items = (listOf(v) ?? []).flatMap((x) => { const d = obj(x), name = str(d?.name, 40), state = txt(d?.state ?? d?.value, 32);
        if (!d || !name || !state) return [];
        const t = (str(d.type ?? d.kind, 12) ?? "other").toLowerCase() as HomeKind;
        return [{ name, state, type: HOME_KINDS.includes(t) ? t : "other", on: typeof d.on === "boolean" ? d.on : ON_STATES.test(state), ...(str(d.area, 30) ? { area: str(d.area, 30) } : {}) }];
      }).slice(0, 12);
      return items.length ? { kind, title: str(o?.title, 60), items } : null;
    }
    case "media": {
      const title = str(o?.title, 120);
      if (!o || !title) return null;
      const st = str(o.state, 10)?.toLowerCase();
      const position = num(o.position), duration = num(o.duration);
      return { kind, title, artist: str(o.artist, 80), album: str(o.album, 80), source: str(o.source, 60), image: safeImage(o.image), state: st === "paused" ? "paused" : st === "idle" || st === "off" ? "idle" : "playing",
        ...(duration && duration > 0 ? { duration, position: Math.min(duration, Math.max(0, position ?? 0)) } : {}) };
    }
    case "image": {
      const items = (listOf(v) ?? (o ? [o] : [])).flatMap((x) => { const d = obj(x), url = safeImage(d?.url ?? d?.src);
        return d && url ? [{ url, caption: str(d.caption ?? d.alt, 140), credit: str(d.credit, 60) }] : []; }).slice(0, 4);
      return items.length ? { kind, items } : null;
    }
    case "steps": {
      const items = (listOf(v) ?? []).flatMap((x) => { if (typeof x === "string") return str(x, 160) ? [{ title: str(x, 160)! }] : [];
        const d = obj(x), title = str(d?.title ?? d?.text, 160);
        return d && title ? [{ title, ...(str(d.detail, 240) ? { detail: str(d.detail, 240) } : {}), ...(typeof d.done === "boolean" ? { done: d.done } : {}) }] : []; }).slice(0, 12);
      return items.length ? { kind, title: str(o?.title, 80), ordered: o?.ordered !== false, items } : null;
    }
    case "stat": {
      const items = (listOf(v) ?? (o ? [o] : [])).flatMap((x) => { const d = obj(x), label = str(d?.label, 60), value = txt(d?.value, 24);
        if (!d || !label || !value) return [];
        const tr = str(d.trend, 5)?.toLowerCase();
        return [{ label, value, unit: str(d.unit, 12), delta: txt(d.delta, 24), trend: tr === "up" || tr === "down" || tr === "flat" ? tr : undefined, note: str(d.note, 100) } as Stats["items"][number]];
      }).slice(0, 4);
      return items.length ? { kind, items } : null;
    }
    case "compare": {
      if (!o || !Array.isArray(o.items) || !Array.isArray(o.rows)) return null;
      const items = o.items.map((x) => txt(x, 40) ?? "").slice(0, 4);
      if (items.length < 2 || items.some((x) => !x)) return null;
      const rows = o.rows.flatMap((r) => { const d = obj(r), label = str(d?.label, 40);
        return d && label && Array.isArray(d.values) ? [{ label, values: items.map((_, i) => txt((d.values as unknown[])[i], 60) ?? "–") }] : []; }).slice(0, 10);
      const pick = num(o.pick);
      return rows.length ? { kind, title: str(o.title, 80), items, rows, ...(pick !== undefined && Number.isInteger(pick) && pick >= 0 && pick < items.length ? { pick } : {}) } : null;
    }
    case "agenda": {
      const items = (listOf(v) ?? []).flatMap((x) => { const d = obj(x), title = str(d?.title, 120);
        return d && title ? [{ title, time: txt(d.time, 20), detail: str(d.detail, 160), where: str(d.where, 60), day: str(d.day, 24) }] : []; }).slice(0, 8);
      return items.length ? { kind, title: str(o?.title, 60), items } : null;
    }
  }
  return null;
}

/** Text → markdown and component segments, in order. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /^```([\w-]*)[^\n]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm;
  let last = 0, m: RegExpExecArray | null;
  const md = (s: string) => { if (s.trim()) out.push({ type: "md", text: s.replace(/^\n+|\n+$/g, "") }); };
  while ((m = re.exec(text))) {
    md(text.slice(last, m.index));
    last = m.index + m[0].length;
    const lang = m[1].toLowerCase(), body = m[2].replace(/\n$/, "");
    let parsed: unknown = undefined;
    if ((COMPONENTS as readonly string[]).includes(lang)) { try { parsed = JSON.parse(body); } catch { parsed = undefined; } }
    const card = lang === "card" ? asCard(parsed) : null, sources = lang === "sources" ? asSources(parsed) : null, chart = lang === "chart" ? asChart(parsed) : null;
    const w = (WIDGETS as readonly string[]).includes(lang) ? asWidget(lang, parsed) : null;
    if (card) out.push({ type: "card", card });
    else if (sources) out.push({ type: "sources", sources });
    else if (chart) out.push({ type: "chart", chart });
    else if (w) out.push({ type: "widget", w });
    else out.push({ type: "code", lang, code: body, ...((COMPONENTS as readonly string[]).includes(lang) ? { broken: true as const } : {}) });
    if (m[0].length === 0) re.lastIndex++;
  }
  md(text.slice(last));
  return out;
}

/** The text without component blocks (what copy and speech use). */
export const plainText = (text: string) => segments(text).filter((s) => s.type === "md" || s.type === "code").map((s) => (s.type === "md" ? s.text : "```" + s.lang + "\n" + s.code + "\n```")).join("\n\n");

// ---------- turns ----------
export type Turn =
  | { key: string; type: "user"; item: FeedLike; text: string; mode: "voice" | "chat" | null; lang: string | null; tv?: true }
  | { key: string; type: "assistant"; ts: number; replies: FeedLike[]; steps: FeedLike[]; sources: WebSource[]; running: boolean; after: string | null }
  | { key: string; type: "event"; item: FeedLike };

/** Pages from the turn's web steps, then any the replies list in ```sources blocks; one card per URL. */
export function turnSources(steps: FeedLike[], replies: FeedLike[] = []): WebSource[] {
  const seen = new Set<string>(), out: WebSource[] = [];
  const add = (s: WebSource) => { const k = s.url.replace(/[#?].*$/, "").replace(/\/$/, ""); if (!seen.has(k)) { seen.add(k); out.push(s); } };
  for (const st of steps) for (const s of st.sources ?? []) if (safeUrl(s.url) && !s.error) add(s);
  for (const r of replies) for (const sg of segments(r.text ?? "")) if (sg.type === "sources") sg.sources.forEach(add);
  return out.slice(0, 16);
}

export function turns(items: FeedLike[]): Turn[] {
  const out: Turn[] = [];
  let cur: Extract<Turn, { type: "assistant" }> | null = null, lastUser: string | null = null;
  for (const it of items) {
    if (it.kind === "user") {
      cur = null; lastUser = it.id;
      const p = stripPrefix(it.text ?? "");
      out.push({ key: it.id, type: "user", item: it, ...p });
    } else if (it.kind === "event") {
      cur = null;
      out.push({ key: it.id, type: "event", item: it });
    } else {
      if (!cur) { cur = { key: "a" + it.id, type: "assistant", ts: it.ts, replies: [], steps: [], sources: [], running: false, after: lastUser }; out.push(cur); }
      if (it.kind === "step") { cur.steps.push(it); cur.running ||= it.status === "running"; }
      else if (it.text?.trim()) cur.replies.push(it);
    }
  }
  for (const t of out) if (t.type === "assistant") t.sources = turnSources(t.steps, t.replies);
  return out.filter((t) => t.type !== "assistant" || t.replies.length || t.steps.length);
}

/** One friendly line for what the assistant is doing right now. */
export function activity(step: FeedLike | null | undefined, working: { step: string | null } | null): string | null {
  if (!working) return null;
  if (!step || step.status !== "running") return working.step ? `${working.step}…` : "Thinking…";
  const d = (step.detail ?? "").replace(/\s+/g, " ").trim();
  const q = d.length > 60 ? d.slice(0, 60) + "…" : d;
  switch (step.tool) {
    case "WebSearch": return q ? `Searching the web for “${q}”…` : "Searching the web…";
    case "WebFetch": return `Reading ${domainOf(d) || "a page"}…`;
    case "Read": case "Grep": case "Glob": return "Looking through files…";
    case "Shell": return step.title && step.title !== "Ran a command" ? `${step.title}…` : "Running a command…";
    case "Agent": case "Task": return "Asking a helper…";
  }
  return `${step.title ?? "Working"}…`;
}

/** A site's icon, from DuckDuckGo's icon service (no cookies); the card falls back to the first letter. */
export const favicon = (domain: string) => (domain ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico` : "");
