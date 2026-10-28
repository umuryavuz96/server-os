// App logins: where each app's username + password live, and revealing them to the owner on request.
// Sources, in order: what Server OS made when it installed the app (apps/<id>/.secret + the ready card), logins
// linked by hand (data/app-logins.json: names of ~/.env variables), ~/.env variables whose names match the app
// (ADGUARD_USER + ADGUARD_PASSWORD), and password-like variables in the app's Docker containers. Listing returns
// names only; values are read at reveal time, never cached, and every reveal is audited by the caller.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../lib";
import { dir } from "../core/config";
import { dockerApi } from "../docker";
import { getSecrets, listInstalled } from "./installer";

export interface Login {
  /** Stable id within the app: "installer:<secret>", "linked", "env:<PREFIX>", "docker:<container>:<VAR>". */
  id: string;
  label: string;
  source: "installer" | "linked" | "env" | "docker";
  /** A login you type into the app, or the password of a database behind it. */
  kind: "login" | "database";
  /** Where the values come from, for the owner (variable names, never values). */
  from: string;
  /** A username that isn't secret (typed by the owner or written on the ready card). */
  user: string | null;
  hasUser: boolean;
}
export interface Revealed { user: string | null; password: string | null }
interface Link { user?: string; userEnv?: string; passwordEnv: string }

// Only passwords: API keys, tokens and signing secrets are machine credentials, not logins.
const PASS_SUFFIX = /_?(PASSWORD|PASSWD|PASS|PW)$/;
const USER_SUFFIXES = ["_USER", "_USERNAME", "_LOGIN", "_EMAIL", "USER", "USERNAME"];
const DB = /(POSTGRES|MYSQL|MARIADB|CLICKHOUSE|MONGO|REDIS|(^|_)DB(_|$)|DBPASS|SUPABASE_DB)/;
/** The username variable that goes with a password variable: NEXTCLOUD_ADMIN_PASSWORD → NEXTCLOUD_ADMIN_USER. */
function userKeyFor(pass: string, keys: string[]) {
  const prefix = pass.replace(PASS_SUFFIX, "");
  return USER_SUFFIXES.map((s) => prefix + s).find((k) => keys.includes(k)) ?? null;
}
const nice = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const linksFile = () => join(dir("data"), "app-logins.json");
const readLinks = (): Record<string, Link> => { try { return JSON.parse(readFileSync(linksFile(), "utf8")); } catch { return {}; } };

/** Words that name an app: "AdGuard Home" + container "adguard" → adguard, home. A name of short words also counts
 *  run together ("Ege Log" → egelog), so EGE_LOG_PASSWORD still finds it. */
export function tokens(name: string, docker: string[] = []) {
  const joined = [name, ...docker].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 4);
  return [...new Set([...[name, ...docker].flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/)), ...joined]
    .filter((t) => t.length >= 4 && !["home", "server", "the", "panel", "admin", "app"].includes(t)))];
}
/** QBIT_PASSWORD belongs to qbittorrent: the variable's first word (or its first two run together, EGE_LOG → egelog)
 *  and an app word start the same way (4+ letters). */
export function matches(key: string, words: string[]) {
  const parts = key.replace(PASS_SUFFIX, "").toLowerCase().split("_");
  return [parts[0], parts.slice(0, 2).join("")].some((head) => head.length >= 4 && words.some((w) => w.startsWith(head) || head.startsWith(w)));
}

/** ~/.env logins for an app: each password variable whose first word matches the app, with its username variable. */
function envLogins(words: string[], env: Record<string, string>): Login[] {
  const keys = Object.keys(env);
  return keys.filter((k) => PASS_SUFFIX.test(k) && matches(k, words)).map((k) => {
    const u = userKeyFor(k, keys);
    return { id: `env:${k}`, label: nice(k.replace(PASS_SUFFIX, "")) || "Login", source: "env" as const, kind: DB.test(k) ? "database" as const : "login" as const,
      from: `~/.env ${[u, k].filter(Boolean).join(" + ")}`, user: null, hasUser: !!u };
  });
}

async function containerEnv(name: string): Promise<Record<string, string>> {
  const c = await dockerApi<{ Config?: { Env?: string[] } }>(`/containers/${encodeURIComponent(name)}/json`, {}, 5000);
  return Object.fromEntries((c?.Config?.Env ?? []).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
}

export async function listLogins(app: { name: string; docker?: string[] }): Promise<Login[]> {
  const out: Login[] = [];
  const inst = listInstalled().find((a) => a.name === app.name);
  if (inst?.ready?.secret || Object.keys(getSecrets(inst?.id ?? "")).length) {
    const secrets = Object.keys(getSecrets(inst!.id));
    const main = inst!.ready?.secret ?? secrets[0];
    for (const s of secrets) out.push({ id: `installer:${s}`, label: s === main ? "Admin account" : s, source: "installer", kind: "login", from: "made by Server OS at install", user: s === main ? inst!.ready?.username ?? null : null, hasUser: s === main && !!inst!.ready?.username });
  }
  const link = readLinks()[app.name];
  if (link) out.push({ id: "linked", label: "Login", source: "linked", kind: "login", from: `~/.env ${[link.userEnv, link.passwordEnv].filter(Boolean).join(" + ")}`, user: link.user ?? null, hasUser: !!(link.user || link.userEnv) });
  const words = tokens(app.name, app.docker);
  if (words.length) out.push(...envLogins(words, loadEnv()).filter((l) => !link || !l.from.includes(link.passwordEnv)));
  // Container variables, once per name (the same database password often sits in several containers).
  const seen = new Set(out.map((l) => l.from.split(" ").pop()));
  for (const c of app.docker ?? []) {
    const env = await containerEnv(c).catch((): Record<string, string> => ({}));
    const keys = Object.keys(env);
    // A ~/.env password whose username only the container has (NEXTCLOUD_ADMIN_USER).
    for (const l of out) if (l.source === "env" && !l.hasUser) { const u = userKeyFor(l.id.slice(4), keys); if (u) { l.hasUser = true; l.from += ` (user ${u} in ${c})`; } }
    for (const k of keys.filter((k) => PASS_SUFFIX.test(k) && env[k])) {
      if (seen.has(k)) continue;
      seen.add(k);
      const u = userKeyFor(k, keys);
      out.push({ id: `docker:${c}:${k}`, label: nice(k.replace(PASS_SUFFIX, "")) || c, source: "docker", kind: DB.test(k) ? "database" : "login", from: `container ${c} ${[u, k].filter(Boolean).join(" + ")}`, user: null, hasUser: !!u });
    }
  }
  return out;
}

/** The values of one login — only ids that listLogins would return for this app. */
export async function revealLogin(app: { name: string; docker?: string[] }, id: string): Promise<Revealed | null> {
  if (!(await listLogins(app)).some((l) => l.id === id)) return null;
  const [kind, ...rest] = id.split(":");
  if (kind === "installer") {
    const inst = listInstalled().find((a) => a.name === app.name)!;
    return { user: inst.ready?.secret === rest[0] ? inst.ready?.username ?? null : null, password: getSecrets(inst.id)[rest[0]] ?? null };
  }
  if (kind === "linked") {
    const l = readLinks()[app.name]; const env = loadEnv();
    return { user: l.user ?? (l.userEnv ? env[l.userEnv] ?? null : null), password: env[l.passwordEnv] ?? null };
  }
  if (kind === "env") {
    const env = loadEnv(), k = rest[0], u = userKeyFor(k, Object.keys(env));
    let user = u ? env[u] : null;
    for (const c of user ? [] : app.docker ?? []) { const ce = await containerEnv(c).catch((): Record<string, string> => ({})); const cu = userKeyFor(k, Object.keys(ce)); if (cu) { user = ce[cu]; break; } }
    return { user, password: env[k] ?? null };
  }
  if (kind === "docker") {
    const [c, k] = rest; const env = await containerEnv(c), u = userKeyFor(k, Object.keys(env));
    return { user: u ? env[u] : null, password: env[k] ?? null };
  }
  return null;
}

/** Link (or unlink with null) a login made of ~/.env variable names for an app. */
export function linkLogin(appName: string, link: Link | null): string | null {
  const env = loadEnv();
  if (link) {
    if (!/^[A-Z0-9_]{2,80}$/.test(link.passwordEnv) || !(link.passwordEnv in env)) return "Pick a variable that exists in ~/.env";
    if (link.userEnv && !(link.userEnv in env)) return "The username variable isn't in ~/.env";
  }
  const all = readLinks();
  if (link) all[appName] = { passwordEnv: link.passwordEnv, ...(link.userEnv ? { userEnv: link.userEnv } : {}), ...(link.user ? { user: link.user.slice(0, 120) } : {}) };
  else delete all[appName];
  mkdirSync(dir("data"), { recursive: true });
  writeFileSync(linksFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return null;
}

/** Names of ~/.env variables that look like credentials (for the "link a login" picker). */
export const envKeyNames = () => Object.keys(loadEnv()).filter((k) => PASS_SUFFIX.test(k) || USER_SUFFIXES.some((u) => k.endsWith(u))).sort();
