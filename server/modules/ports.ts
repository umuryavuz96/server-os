// Ports: every listening socket on the machine, who owns it (app, process, Docker container), who can reach it
// (this machine only / the tailnet / the whole network) and which name points at it (Caddy site → reverse_proxy).
// Read-only: nothing here opens or closes a port.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "../lib";

export type Scope = "local" | "tailnet" | "network";
export interface Listener { port: number; proto: "tcp" | "udp"; addresses: string[]; scope: Scope; process: string; pid: number | null }
export interface DockerMap { container: string; hostPort: number; containerPort: number; proto: string; hostIp: string }
export interface Route { name: string; port: number; file: string }
export interface PortRow {
  port: number; proto: "tcp" | "udp"; scope: Scope; addresses: string[]; process: string; pid: number | null;
  app: string | null;
  /** Not one of your apps but a known system or infrastructure service (SSH, file sharing, Caddy, …). */
  service: string | null; docker: { container: string; containerPort: number } | null; names: string[];
  issue: "unknown" | null;
}
/** deadNames: Caddy names whose port nothing listens on — usually an app that is switched off. */
export interface PortsReport { at: number; rows: PortRow[]; deadNames: Route[]; routes: number; counts: { total: number; network: number; local: number; tailnet: number; docker: number; issues: number } }

const isLocal = (a: string) => a === "127.0.0.1" || a === "::1" || a.startsWith("127.") || a === "localhost";
const isTailnet = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || a.toLowerCase().startsWith("fd7a:115c:a1e0");
export const scopeOf = (addrs: string[]): Scope =>
  addrs.every(isLocal) ? "local" : addrs.every((a) => isLocal(a) || isTailnet(a)) ? "tailnet" : "network";

/** macOS `netstat -anv`: local address is `<ip>.<port>` or `*.<port>`; the process column is `name:pid`. */
export function parseNetstat(out: string, proto: "tcp" | "udp"): Listener[] {
  const by = new Map<string, Listener>();
  for (const line of out.split("\n")) {
    if (proto === "tcp" && !line.includes("LISTEN")) continue;
    const cols = line.trim().split(/\s+/);
    if (!/^(tcp|udp)/.test(cols[0] ?? "")) continue;
    const local = cols[3] ?? "";
    const m = /^(.*)\.(\d+)$/.exec(local);
    if (!m) continue;
    const addr = m[1] === "*" ? "0.0.0.0" : m[1], port = Number(m[2]);
    // process:pid sits before a 5-digit state field; names may hold spaces and dots ("Google Chrome He:696").
    // …rhiwat shiwat <process:pid> <state>: the greedy prefix lands on the LAST "number number" before the process.
    const pm = /^.*\s\d+\s+\d+\s+(\S.*?):(\d+)\s+[0-9a-f]{5}(?:\s|$)/.exec(line);
    const process = pm?.[1] ?? "", pid = pm ? Number(pm[2]) : null;
    const key = `${port}/${proto}/${process}`;
    const cur = by.get(key) ?? { port, proto, addresses: [], scope: "local" as Scope, process, pid };
    if (!cur.addresses.includes(addr)) cur.addresses.push(addr);
    by.set(key, cur);
  }
  return [...by.values()].map((l) => ({ ...l, scope: scopeOf(l.addresses) }));
}

/** Linux `ss -Hlntup`: `LISTEN 0 4096 0.0.0.0:3094 0.0.0.0:* users:(("bun",pid=812,fd=13))`. */
export function parseSs(out: string): Listener[] {
  const by = new Map<string, Listener>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] === "udp" ? "udp" : "tcp";
    const local = cols[4] ?? "";
    const i = local.lastIndexOf(":");
    if (i < 0) continue;
    let addr = local.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (addr === "*") addr = "0.0.0.0";
    const port = Number(local.slice(i + 1));
    const pm = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const process = pm?.[1] ?? "", pid = pm ? Number(pm[2]) : null;
    const key = `${port}/${proto}/${process}`;
    const cur = by.get(key) ?? { port, proto, addresses: [], scope: "local" as Scope, process, pid };
    if (!cur.addresses.includes(addr)) cur.addresses.push(addr);
    by.set(key, cur);
  }
  return [...by.values()].map((l) => ({ ...l, scope: scopeOf(l.addresses) }));
}

/** `docker ps --format '{{.Names}}|{{.Ports}}'` → host port → container port. */
export function parseDockerPorts(out: string): DockerMap[] {
  const maps: DockerMap[] = [];
  for (const line of out.split("\n")) {
    const [container, ports] = line.split("|");
    if (!container || !ports) continue;
    for (const p of ports.split(",")) {
      const m = /^\s*(\[?[\d.:a-f]*\]?):(\d+)->(\d+)\/(\w+)/.exec(p);
      if (m && !maps.some((x) => x.container === container && x.hostPort === Number(m[2]) && x.proto === m[4]))
        maps.push({ container, hostIp: m[1].replace(/^\[|\]$/g, ""), hostPort: Number(m[2]), containerPort: Number(m[3]), proto: m[4] });
    }
  }
  return maps;
}

/** Caddy sites → the local port they proxy to. Follows `import` globs one level (snippet folders). */
export function parseCaddy(text: string, file: string, readFile = (p: string) => readFileSync(p, "utf8"), list = (d: string) => readdirSync(d)): Route[] {
  const routes: Route[] = [];
  const walk = (src: string, from: string, depth: number) => {
    let site: string[] = [], level = 0;
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
        site = line.slice(0, -1).split(/[\s,]+/).filter(Boolean).map((s) => s.replace(/^https?:\/\//, "").replace(/:\d+$/, "")).filter((s) => s && !s.startsWith(":") && s !== "*");
      }
      const pm = /reverse_proxy\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)?:(\d+)/.exec(line);
      if (pm && level >= 1) for (const name of site) routes.push({ name, port: Number(pm[1]), file: from });
      level += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (level <= 0) { level = 0; site = []; }
    }
  };
  walk(text, file, 0);
  return routes;
}

export const CADDYFILES = ["/opt/homebrew/etc/Caddyfile", "/usr/local/etc/Caddyfile", "/etc/caddy/Caddyfile"];

/** Well-known services by process name (first) or port, so they read as what they are instead of "unknown". */
const BY_PROCESS: Record<string, string> = {
  AdGuardHome: "AdGuard Home (DNS)", "io.tailscale.ipn": "Tailscale", caddy: "Caddy (reverse proxy)", unbound: "Unbound (DNS)", tailscaled: "Tailscale",
  screensharingd: "macOS Screen Sharing", ControlCenter: "macOS AirPlay receiver", rapportd: "macOS Continuity",
  kdc: "macOS Kerberos", sshd: "SSH", smbd: "File sharing (SMB)", cupsd: "Printing", "com.docker.backe": "Docker",
  cloudflared: "Cloudflare tunnel", ollama: "Ollama", postgres: "PostgreSQL", redis: "Redis", mysqld: "MySQL",
};
const BY_PORT: Record<number, string> = { 22: "SSH", 53: "DNS", 80: "Web (HTTP)", 88: "macOS Kerberos", 443: "Web (HTTPS)", 445: "File sharing (SMB)", 548: "File sharing (AFP)", 631: "Printing", 3283: "Apple Remote Desktop", 5000: "macOS AirPlay receiver", 5900: "Screen Sharing", 7000: "macOS AirPlay receiver" };
export const serviceOf = (process: string, port: number) => BY_PROCESS[process] ?? (process === "launchd" || process === "" ? BY_PORT[port] ?? null : null);

export interface AppRef { name: string; docker?: string[]; pids?: number[]; ports?: number[] }

/** Join listeners, Docker maps, Caddy routes and apps into rows; flag network listeners no app claims. */
export function buildReport(listeners: Listener[], docker: DockerMap[], routes: Route[], apps: AppRef[], at = Date.now()): PortsReport {
  const rows: PortRow[] = listeners.map((l) => {
    const dm = docker.find((d) => d.hostPort === l.port && d.proto === l.proto);
    const app = apps.find((a) => (dm && a.docker?.includes(dm.container)) || (l.pid != null && a.pids?.includes(l.pid)) || a.ports?.includes(l.port))?.name ?? null;
    const names = routes.filter((r) => r.port === l.port && l.proto === "tcp" && /[a-z]/i.test(r.name)).map((r) => r.name);
    const service = app ? null : serviceOf(l.process, l.port);
    return {
      port: l.port, proto: l.proto, scope: l.scope, addresses: l.addresses, process: l.process, pid: l.pid,
      app, service, docker: dm ? { container: dm.container, containerPort: dm.containerPort } : null, names: [...new Set(names)],
      // Worth a look: open to the network, and nothing — no app, service, container or name — explains it.
      issue: (!app && !service && !dm && !names.length && l.scope === "network" && l.port < 49152 ? "unknown" : null) as PortRow["issue"],
    };
  }).sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  const listening = new Set(rows.filter((r) => r.proto === "tcp").map((r) => r.port));
  const deadNames = routes.filter((r) => !listening.has(r.port) && /[a-z]/i.test(r.name));
  return {
    at, rows, deadNames, routes: new Set(routes.filter((r) => /[a-z]/i.test(r.name)).map((r) => r.name)).size,
    counts: {
      total: rows.length, network: rows.filter((r) => r.scope === "network").length, local: rows.filter((r) => r.scope === "local").length,
      tailnet: rows.filter((r) => r.scope === "tailnet").length, docker: rows.filter((r) => r.docker).length,
      issues: rows.filter((r) => r.issue).length,
    },
  };
}

export async function collectPorts(apps: AppRef[]): Promise<PortsReport> {
  let listeners: Listener[];
  if (process.platform === "darwin") {
    const [t, u] = await Promise.all([run(["netstat", "-anv", "-p", "tcp"], 10_000), run(["netstat", "-anv", "-p", "udp"], 10_000)]);
    // UDP: only well-known service ports; the rest is mDNS/QUIC noise from desktop apps.
    listeners = [...parseNetstat(t.out, "tcp"), ...parseNetstat(u.out, "udp").filter((l) => l.port < 1024 && l.port !== 137 && l.port !== 138)];
  } else {
    listeners = parseSs((await run(["ss", "-Hlntup"], 10_000)).out).filter((l) => l.proto === "tcp" || l.port < 1024);
  }
  const docker = parseDockerPorts((await run(["docker", "ps", "--format", "{{.Names}}|{{.Ports}}"], 10_000)).out);
  const caddy = CADDYFILES.find(existsSync);
  const routes = caddy ? parseCaddy(readFileSync(caddy, "utf8"), caddy) : [];
  return buildReport(listeners, docker, routes, apps);
}

/** Every address Caddy serves this panel on (names first, then the tailnet name over https, then plain IPs). */
export function panelAddresses(port: number): string[] {
  const caddy = CADDYFILES.find(existsSync);
  if (!caddy) return [];
  const hosts = [...new Set(parseCaddy(readFileSync(caddy, "utf8"), caddy).filter((r) => r.port === port).map((r) => r.name))];
  const rank = (h: string) => (/^\d|:/.test(h) ? 3 : h.endsWith(".ts.net") ? 2 : 1);
  return hosts.sort((a, b) => rank(a) - rank(b)).map((h) => (h.endsWith(".ts.net") ? `https://${h}` : `http://${h}`));
}
