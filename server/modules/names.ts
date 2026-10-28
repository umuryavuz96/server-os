// Local names: give every app an address like jellyfin.home. Caddy serves each name
// from its own snippet in <home>/data/caddy/<id>.caddy (the main Caddyfile imports that folder); DNS comes from
// AdGuard Home rewrites, a wildcard the owner set up once (router / Pi-hole), or sslip.io names that need no DNS.
// Set up by the wizard's optional "Local names" step; `apps.link` (a custom command) still works instead.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, dir } from "../core/config";
import { loadEnv, run } from "../lib";

export interface NamesConfig {
  /** app.<suffix>, e.g. "home" → jellyfin.home. Ignored for dns: sslip. */
  suffix: string;
  /** The main Caddyfile; it must contain `import <home>/data/caddy/*.caddy` (the wizard adds it). */
  caddyfile: string;
  /** adguard: rewrites per name · wildcard: the owner pointed *.<suffix> at this server once · sslip: <name>.<ip>.sslip.io */
  dns: "adguard" | "wildcard" | "sslip";
  /** Addresses names resolve to: LAN first, then e.g. the Tailscale IP (AdGuard gets one rewrite per address). */
  ips: string[];
  adguard?: { url: string; userEnv?: string; passwordEnv?: string; envFile?: string };
}

export const snippetDir = () => join(dir("data"), "caddy");
const snippet = (id: string) => join(snippetDir(), `${id}.caddy`);
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function hostFor(n: NamesConfig, id: string) {
  return n.dns === "sslip" ? `${id}.${(n.ips[0] ?? "127.0.0.1").replaceAll(".", "-")}.sslip.io` : `${id}.${n.suffix.replace(/^\./, "")}`;
}

/** The Caddy site for one app. Plain http: these names live on a private network (Tailscale Serve adds https). */
export const siteBlock = (host: string, port: number) => `# Server OS name — written by the installer\nhttp://${host} {\n\treverse_proxy localhost:${port}\n}\n`;

let runCaddy = (args: string[]) => run(["caddy", ...args], 30_000);
/** Tests swap the runner so nothing ever reloads a real Caddy. */
export function useCaddyRunner(fn: typeof runCaddy) { runCaddy = fn; }
async function caddy(n: NamesConfig, args: string[]) {
  return runCaddy([...args, "--config", n.caddyfile, "--adapter", "caddyfile"]);
}

function adguardAuth(n: NamesConfig) {
  const a = n.adguard!;
  const env = { ...loadEnv(), ...(a.envFile && existsSync(a.envFile) ? loadEnv(a.envFile) : {}) };
  return "Basic " + btoa(`${env[a.userEnv ?? "ADGUARD_USER"] ?? ""}:${env[a.passwordEnv ?? "ADGUARD_PASSWORD"] ?? ""}`);
}
async function adguard(n: NamesConfig, path: string, body?: unknown) {
  const r = await fetch(`${n.adguard!.url.replace(/\/$/, "")}/control/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: adguardAuth(n), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`AdGuard ${path}: HTTP ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}

/** Give app <id> its name: Caddy snippet (validated, rolled back on error), reload, DNS. Returns the URL. */
export async function addName(id: string, port: number, n: NamesConfig | undefined = config.names): Promise<string> {
  if (!n) throw new Error("names are not set up");
  if (!ID.test(id)) throw new Error("bad app id");
  const host = hostFor(n, id);
  mkdirSync(snippetDir(), { recursive: true });
  const taken = existsSync(snippet(id)) && !readFileSync(snippet(id), "utf8").includes(`localhost:${port}\n`);
  if (taken) throw new Error(`${host} already points somewhere else`);
  writeFileSync(snippet(id), siteBlock(host, port));
  const v = await caddy(n, ["validate"]);
  if (v.code !== 0) { rmSync(snippet(id), { force: true }); throw new Error(`Caddy refused the config: ${v.out.split("\n").slice(-2).join(" ")}`); }
  const r = await caddy(n, ["reload"]);
  if (r.code !== 0) throw new Error(`Caddy reload failed: ${r.out.split("\n").at(-1)}`);
  if (n.dns === "adguard") {
    const list = ((await adguard(n, "rewrite/list")) ?? []) as { domain: string; answer: string }[];
    for (const ip of n.ips) if (!list.some((x) => x.domain === host && x.answer === ip)) await adguard(n, "rewrite/add", { domain: host, answer: ip });
  }
  return `http://${host}`;
}

/** Take the name away again (uninstall / delete). Never fails the caller: problems come back as a note. */
export async function removeName(id: string, n: NamesConfig | undefined = config.names): Promise<string | null> {
  if (!n || !ID.test(id)) return null;
  const host = hostFor(n, id);
  try {
    if (existsSync(snippet(id))) { rmSync(snippet(id)); await caddy(n, ["reload"]); }
    if (n.dns === "adguard") for (const ip of n.ips) await adguard(n, "rewrite/delete", { domain: host, answer: ip }).catch(() => null);
    return null;
  } catch (e) { return `Could not fully remove ${host}: ${(e as Error).message}`; }
}
