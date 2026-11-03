// Job ID cards: what a job does, what it touches, what it uses and how risky it is. One shape for crontab jobs (jobs.json, keyed by
// job name), launchd agents (keyed by label) and built-in scheduler jobs (fields of job.yaml). Every job is expected to have a full card.
export const RISKS = ["read-only", "writes", "destructive"] as const;
export type Risk = (typeof RISKS)[number];
export interface Touches { apps?: string[]; paths?: string[]; data?: string }
export interface Uses { tools?: string[]; apis?: string[]; secrets?: string[]; model?: string }
export interface Card { category?: string; about?: string; reports?: string; project?: string; touches?: Touches; uses?: Uses; risk?: Risk;
  /** Optional icon hints for entries the panel cannot match by name: label (as written under apps/tools/apis) -> an app name from the Apps tab, a selfh.st logo slug, or "lucide:<name>". */
  icons?: Record<string, string> }

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A list from a JSON array or a comma-separated string (the editor sends strings); blanks dropped. */
const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
/** Drops empty lists and texts; undefined when nothing is left. */
const only = <T extends object>(o: T): T | undefined => {
  const e = Object.entries(o).filter(([, v]) => (Array.isArray(v) ? v.length : v));
  return e.length ? (Object.fromEntries(e) as T) : undefined;
};
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Secrets are listed by variable NAME only: anything that does not look like a name is dropped, so a pasted value never gets stored. */
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function parseTouches(v: unknown): Touches | undefined {
  const o = obj(v);
  return only({ apps: list(o.apps), paths: list(o.paths), data: text(o.data) });
}
export function parseUses(v: unknown): Uses | undefined {
  const o = obj(v);
  return only({ tools: list(o.tools), apis: list(o.apis), secrets: list(o.secrets).filter((s) => VAR.test(s)), model: text(o.model) });
}
/** icons: label -> hint, both short plain strings; anything else is dropped. */
function parseIcons(v: unknown): Record<string, string> | undefined {
  const e = Object.entries(obj(v)).flatMap(([k, h]) => (typeof h === "string" && /^[\w .:\/-]{1,60}$/.test(h.trim()) && k.length <= 120 ? [[k, h.trim()] as const] : []));
  return e.length ? Object.fromEntries(e) : undefined;
}
export function parseCard(raw: unknown): Card {
  const o = obj(raw);
  const c: Card = { category: text(o.category), about: text(o.about), reports: text(o.reports), project: text(o.project), touches: parseTouches(o.touches), uses: parseUses(o.uses),
    risk: RISKS.find((r) => r === o.risk), icons: parseIcons(o.icons) };
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Card;
}
/** What a card still lacks. A card is complete with an about, something under touches, tools or APIs under uses, and a risk. */
export function cardGaps(c: Card | undefined): string[] {
  const g: string[] = [];
  if (!c?.about) g.push("about");
  if (!c?.touches) g.push("touches");
  if (!c?.uses?.tools?.length && !c?.uses?.apis?.length) g.push("uses");
  if (!c?.risk) g.push("risk");
  return g;
}
/** For new built-in jobs: a clear rejection message, or null when the card is complete. */
export function newJobCardError(spec: unknown): string | null {
  const g = cardGaps(parseCard(spec));
  return g.length ? `ID card incomplete, missing: ${g.join(", ")}. Every job needs about (two plain sentences: what and why), touches {apps, paths, data}, uses {tools, apis, secrets (variable names only), model} and risk (read-only | writes | destructive).` : null;
}
