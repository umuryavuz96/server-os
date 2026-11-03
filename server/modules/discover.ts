// Found on this server: things that run here but are not on the Apps tab yet — Caddy sites (main Caddyfile + imported
// snippets), Docker containers and running LaunchAgents that are neither in catalog.json nor installed by Server OS.
// "Add to Apps" writes a catalog entry (catalog.json is backed up first); "Ignore" hides one for good.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dir } from "../core/config";
import { HOME, run } from "../lib";
import { CATALOG_FILE, loadCatalog, runtimeNames, type CatalogItem } from "../apps";
import { CADDYFILES, collectListeners, parseDockerPorts, type DockerMap, type Listener } from "./ports";

export interface Site { host: string; port?: number; upstream?: string; root?: string }
export interface Candidate {
  id: string;                       // site:<host> | docker:<name> | launchd:<label>
  kind: "site" | "docker" | "launchd";
  name: string;                     // suggested display name
  href?: string; about: string;
  docker?: string[]; launchd?: string[];
  detail: string;                   // one line of evidence: where it comes from
  group: string;                    // suggested group
}

const LOCAL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)?:(\d+)/;

/** Caddy sites with what they serve: a local proxy port, another host, or a static folder. Follows `import` globs. */
export function parseSites(text: string, file: string, readFile = (p: string) => readFileSync(p, "utf8"), list = (d: string) => readdirSync(d)): Site[] {
  const sites: Site[] = [];
  const walk = (src: string, from: string, depth: number) => {
    let cur: Site[] = [], level = 0;
    for (const raw of src.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      if (level === 0 && line.startsWith("import ") && depth < 2) {
        const pat = resolve(dirname(from), line.slice(7).trim());
        const d = dirname(pat), base = pat.slice(d.length + 1);
        const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        try { for (const f of list(d).filter((f) => re.test(f)).sort()) walk(readFile(join(d, f)), join(d, f), depth + 1); } catch { /* missing folder */ }
        continue;
      }
      if (level === 0 && line.endsWith("{")) {
        const head = line.slice(0, -1).trim();
        cur = head.startsWith("(") || head.startsWith("@") ? [] : head.split(/[\s,]+/).filter(Boolean)
          .map((s) => s.replace(/^https?:\/\//, "").replace(/:\d+$/, "")).filter((s) => s && !s.startsWith(":") && s !== "*").map((host) => ({ host }));
        sites.push(...cur);
      }
      if (level >= 1 && cur.length) {
        const rp = /^reverse_proxy\s+(?:\S+\s+)*?(\S+)/.exec(line);
        if (rp && !rp[1].startsWith("{") && !rp[1].startsWith("@")) for (const s of cur) { s.upstream = rp[1]; const m = LOCAL.exec(rp[1]); if (m) s.port = Number(m[1]); }
        const root = /^root\s+(?:\S+\s+)?(\/\S+)/.exec(line);
        if (root) for (const s of cur) s.root = root[1];
      }
      level += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (level <= 0) { level = 0; cur = []; }
    }
  };
  walk(text, file, 0);
  return sites;
}

const hostOf = (href?: string) => { try { return href ? new URL(href).host.replace(/:\d+$/, "") : ""; } catch { return ""; } };
const portOf = (href?: string) => { try { const u = href ? new URL(href) : null; return u?.port ? Number(u.port) : undefined; } catch { return undefined; } };
const VENDOR = /^(com\.apple\.|com\.google\.|com\.docker\.|com\.cloudflare\.|com\.microsoft\.|com\.tailscale\.|org\.|application\.|homebrew\.mxcl\.(?:tailscale|unbound|caddy|cloudflared)$)/;

/** "it-tools" / "sd-it-tools" / "com.acme.media-server" → "It Tools" / "Media Server". */
export function niceName(raw: string): string {
  const last = raw.replace(/^sd-/, "").split(".").filter(Boolean).at(-1) ?? raw;
  return last.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export interface Inputs {
  sites: Site[]; dockerPorts: DockerMap[]; containers: string[]; launchd: Map<string, number>; listeners: Listener[];
  known: CatalogItem[]; ignored: string[]; selfPort: number; selfPid: number; plists: Set<string>;
}

/** The pure part: what is here but not on the Apps tab. */
export function findCandidates(i: Inputs): Candidate[] {
  const knownHosts = new Set(i.known.map((k) => hostOf(k.href)).filter(Boolean));
  const knownPorts = new Set(i.known.map((k) => portOf(k.href)).filter((p): p is number => !!p));
  const knownDocker = new Set(i.known.flatMap((k) => k.docker ?? []));
  const knownLaunchd = new Set(i.known.flatMap((k) => k.launchd ?? []));
  for (const k of i.known) for (const c of k.docker ?? []) for (const d of i.dockerPorts) if (d.container === c) knownPorts.add(d.hostPort);
  const pidPorts = (pid: number) => i.listeners.filter((l) => l.pid === pid && l.proto === "tcp").map((l) => l.port);
  for (const k of i.known) for (const l of k.launchd ?? []) { const pid = i.launchd.get(l); if (pid) for (const p of pidPorts(pid)) knownPorts.add(p); }

  const out: Candidate[] = [];
  const claimedDocker = new Set<string>(), claimedLaunchd = new Set<string>();
  for (const s of i.sites) {
    if (!/[a-z]/i.test(s.host) || /^\d|\.ts\.net$/.test(s.host) || knownHosts.has(s.host)) continue;
    if (s.port === i.selfPort) continue;                      // this panel
    if (s.port && knownPorts.has(s.port)) continue;            // another name for an app already listed
    if (!s.root && !s.upstream) continue;                     // a redirect / respond-only block: nothing to list
    const containers = s.port ? [...new Set(i.dockerPorts.filter((d) => d.hostPort === s.port).map((d) => d.container))] : [];
    const owner = s.port ? i.listeners.find((l) => l.port === s.port && l.pid) : undefined;
    const label = owner ? [...i.launchd].find(([l, pid]) => pid === owner.pid && !VENDOR.test(l))?.[0] : undefined;
    containers.forEach((c) => claimedDocker.add(c));
    if (label) claimedLaunchd.add(label);
    out.push({
      id: `site:${s.host}`, kind: "site", name: niceName(s.host.replace(/\.[a-z0-9]+$/i, "")), href: `http://${s.host}`,
      about: s.root ? "Static site." : "",
      ...(containers.length ? { docker: containers } : {}), ...(label ? { launchd: [label] } : {}),
      detail: s.root ? `Caddy serves ${s.root}` : `Caddy proxies ${s.host} to ${s.upstream}${containers.length ? ` (container ${containers.join(", ")})` : label ? ` (${label})` : ""}`,
      group: s.root ? "Sites" : "Other",
    });
  }
  for (const c of i.containers) {
    if (knownDocker.has(c) || claimedDocker.has(c)) continue;
    const ports = i.dockerPorts.filter((d) => d.container === c).map((d) => d.hostPort);
    if (ports.some((p) => knownPorts.has(p))) continue;
    out.push({ id: `docker:${c}`, kind: "docker", name: niceName(c), about: "", docker: [c], detail: `Docker container ${c}${ports.length ? ` (port ${ports[0]})` : ""}`, group: "Other" });
  }
  for (const [l, pid] of i.launchd) {
    if (knownLaunchd.has(l) || claimedLaunchd.has(l) || !pid || pid === i.selfPid || VENDOR.test(l) || !i.plists.has(l)) continue;
    if (pidPorts(pid).some((p) => p === i.selfPort)) continue;
    out.push({ id: `launchd:${l}`, kind: "launchd", name: niceName(l), about: "", launchd: [l], detail: `LaunchAgent ${l}, running`, group: "Other" });
  }
  const ign = new Set(i.ignored);
  return out.filter((c) => !ign.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
}

const ignoreFile = () => join(dir("data"), "discover-ignored.json");
const ignoredList = (): string[] => { try { return JSON.parse(readFileSync(ignoreFile(), "utf8")); } catch { return []; } };
export function ignore(id: string) {
  mkdirSync(dir("data"), { recursive: true });
  writeFileSync(ignoreFile(), JSON.stringify([...new Set([...ignoredList(), id])], null, 2) + "\n");
}

/** Gather the live inputs and run the finder. */
export async function discover(selfPort: number): Promise<Candidate[]> {
  const file = CADDYFILES.find(existsSync);
  const sites = file ? parseSites(readFileSync(file, "utf8"), file) : [];
  const [listeners, dk] = await Promise.all([collectListeners().catch(() => []), run(["docker", "ps", "--format", "{{.Names}}|{{.Ports}}"], 10_000)]);
  const rt = runtimeNames();
  let plists = new Set<string>();
  try { plists = new Set(readdirSync(join(HOME, "Library/LaunchAgents")).filter((f) => f.endsWith(".plist")).map((f) => f.slice(0, -6))); } catch { /* Linux / none */ }
  return findCandidates({
    sites, dockerPorts: parseDockerPorts(dk.out), containers: rt.containers, launchd: rt.launchd, listeners,
    known: loadCatalog().flatMap((g) => g.items), ignored: ignoredList(), selfPort, selfPid: process.pid, plists,
  });
}

/** Write one candidate into catalog.json (backup first). Returns the backup path, or null when the file is new. */
export function addToCatalog(c: Candidate, over: { name?: string; group?: string; about?: string }): { name: string; backup: string | null } {
  const name = (over.name ?? c.name).trim().slice(0, 60), group = (over.group ?? c.group).trim().slice(0, 40) || "Other";
  if (!name) throw new Error("A name is needed");
  const raw: { groups: { group: string; items: CatalogItem[] }[] } = existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE, "utf8")) : { groups: [] };
  if (raw.groups.some((g) => g.items.some((x) => x.name === name)) || loadCatalog().some((g) => g.items.some((x) => x.name === name))) throw new Error(`There is already an app called ${name}`);
  let backup: string | null = null;
  if (existsSync(CATALOG_FILE)) { backup = `${CATALOG_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`; copyFileSync(CATALOG_FILE, backup); }
  const item: CatalogItem = { name, ...(c.href ? { href: c.href } : {}), about: (over.about ?? c.about).trim().slice(0, 300),
    ...(c.docker ? { docker: c.docker } : {}), ...(c.launchd ? { launchd: c.launchd } : {}) };
  const g = raw.groups.find((x) => x.group === group) ?? (raw.groups.push({ group, items: [] }), raw.groups.at(-1)!);
  g.items.push(item);
  mkdirSync(dirname(CATALOG_FILE), { recursive: true });
  writeFileSync(CATALOG_FILE, JSON.stringify(raw, null, 2) + "\n");
  return { name, backup };
}
