// What Server OS needs from the OS: macOS privacy (TCC) grants, or on Linux the group / path / systemd / firewall access its
// features rely on. One inventory, what each is for, whether it is granted, how to fix it.
// Read-only toward macOS: probes only try a cheap read; nothing here writes TCC.db, uses sudo or tccutil.
// A probe that can raise a system popup (Local Network, volumes, folders) is "active": it runs only when the user asks
// (Re-check, or the setup wizard while they are at the Mac), never from the plain status list.
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { config, ROOT, STATE_DIR } from "../core/config";
import { HOME, run } from "../lib";
import { dockerSocket } from "../docker";

export type PermStatus = "granted" | "missing" | "unknown" | "not-needed";
export type MacPermId = "full-disk-access" | "local-network" | "removable-volumes" | "files-folders" | "microphone" | "automation";
export type LinuxPermId = "docker-access" | "path-access" | "linger" | "firewall" | "selinux";
export type PermId = MacPermId | LinuxPermId;

export interface PermProcess { role: string; path: string }
export interface Permission {
  id: PermId;
  title: string;
  /** Plain-language reason, shown to the user. */
  why: string;
  /** Features that use it, in this install. */
  features: string[];
  /** true: a missing grant breaks something that is switched on in this config. */
  required: boolean;
  /** Does this config use it at all? false -> status "not-needed". */
  needed: boolean;
  status: PermStatus;
  /** Why the status is what it is (shown under the chip). */
  detail: string;
  /** Can the check raise a macOS popup? Then it runs only on an explicit re-check. */
  active: boolean;
  /** Program(s) that must hold the grant: the binary path macOS keys the grant on. */
  processes: PermProcess[];
  /** How the user grants it: "dialog" = macOS shows an Allow popup when the program first tries (the server can trigger it);
   *  "settings" = only a switch in System Settings (no prompt API); "" = not a macOS grant. */
  how: "dialog" | "settings" | "";
  /** macOS: the System Settings pane to open. Empty on Linux. */
  settingsUrl: string;
  /** Linux: commands to copy and run (there is no Settings pane to open). Empty on macOS. */
  fix: string[];
  /** macOS: the exact entries the user switches on under the program (folder names, volume names, the app to control).
   *  Empty: nothing is configured, so the guide names the usual ones. */
  targets?: string[];
}

const PANE = "x-apple.systempreferences:com.apple.preference.security?";
/** System Settings anchors (macOS 13-26). */
export const DEEP_LINKS: Record<MacPermId, string> = {
  "full-disk-access": PANE + "Privacy_AllFiles",
  "local-network": PANE + "Privacy_LocalNetwork",
  "removable-volumes": PANE + "Privacy_RemovableVolume",
  "files-folders": PANE + "Privacy_FilesAndFolders",
  "microphone": PANE + "Privacy_Microphone",
  "automation": PANE + "Privacy_Automation",
};

// ---- what this config touches -------------------------------------------------------------------------------------

const PROTECTED_HOME = ["Desktop", "Documents", "Downloads"];
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
export const isLan = (host: string) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || /\.(local|home|lan)$/i.test(host);

/** Config values that are folders the server reads. */
function configuredPaths(c = config): string[] {
  const I = c.integrations;
  const out = [ROOT, STATE_DIR, c.externalDisk, ...(c.storage?.logDirs ?? []), I.catalog, I.channelsDir, I.houseVoice?.dir, I.houseVoice?.voiceLaunch,
    I.cron?.history, I.cron?.cards, I.cron?.logs, c.bots?.agmsg?.dir, c.bots?.agmsg?.storage];
  return out.filter((p): p is string => !!p).map((p) => resolve(tilde(p)));
}
/** Desktop / Documents / Downloads folders (the Files and Folders list) that the config points into. */
export function protectedFolders(c = config): string[] {
  const hit = new Set<string>();
  for (const p of configuredPaths(c)) for (const d of PROTECTED_HOME) {
    const root = join(HOME, d);
    if (p === root || p.startsWith(root + "/")) hit.add(root);
  }
  return [...hit];
}
export const volumePaths = (c = config) => configuredPaths(c).filter((p) => p.startsWith("/Volumes/")).map((p) => p.split("/").slice(0, 3).join("/"));
/** host:port of the LAN integrations the server calls. */
export function lanTargets(c = config): { host: string; port: number }[] {
  const I = c.integrations;
  return [I.homeAssistant?.url, I.adguard?.url].filter((u): u is string => !!u).flatMap((u) => {
    try { const x = new URL(u); return isLan(x.hostname) ? [{ host: x.hostname, port: Number(x.port) || (x.protocol === "https:" ? 443 : 80) }] : []; } catch { return []; }
  });
}

// ---- processes ----------------------------------------------------------------------------------------------------

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export const bunPath = () => real(process.execPath);
export const claudePath = () => real(Bun.which("claude") ?? join(HOME, ".local/bin/claude"));
const tmuxPath = () => real(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => { try { return !!realpathSync(p); } catch { return false; } }) ?? "tmux");

// ---- probes -------------------------------------------------------------------------------------------------------

export interface ProbeResult { status: PermStatus; detail: string }

/** Files macOS only lets a program with Full Disk Access open. Some Macs lack the first one, so the next is tried. */
const FDA_PROBES = [join(HOME, "Library/Application Support/com.apple.TCC/TCC.db"), "/Library/Application Support/com.apple.TCC/TCC.db", join(HOME, "Library/Safari")];

/** Full Disk Access: opening a protected file or folder read-only. A refusal is silent (FDA never shows a popup). */
export function probeFullDiskAccess(paths: string[] = FDA_PROBES): ProbeResult {
  let last = "ENOENT";
  for (const p of paths) {
    try { if (statSync(p).isDirectory()) readdirSync(p); else closeSync(openSync(p, constants.O_RDONLY)); return { status: "granted", detail: "Can read protected system folders." }; }
    catch (e) {
      last = (e as NodeJS.ErrnoException).code ?? "error";
      if (last === "EPERM" || last === "EACCES") return { status: "missing", detail: "Protected folders (Mail, Messages, Safari, …) are blocked, so the storage scan skips them." };
    }
  }
  return { status: "unknown", detail: `Could not test (${last}).` };
}

/** Default gateway from `route -n get default` (no network traffic). */
export async function gatewayHost(): Promise<string | null> {
  const r = await run(["/sbin/route", "-n", "get", "default"], 3000);
  return /gateway:\s*(\S+)/.exec(r.out)?.[1] ?? null;
}

/** TCP connect with a timeout. connected / refused: packets flowed. unreachable: macOS blocked it. timeout: no answer. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<"connected" | "refused" | "unreachable" | "timeout"> {
  return new Promise((res) => {
    const s = connect({ host, port });
    const done = (v: "connected" | "refused" | "unreachable" | "timeout") => { s.destroy(); res(v); };
    s.setTimeout(timeoutMs, () => done("timeout"));
    s.once("connect", () => done("connected"));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" ? "refused" : e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" || e.code === "EPERM" ? "unreachable" : "timeout"));
  });
}

/** Local Network: connect from this process (bun) to a LAN host. The first try can raise the macOS popup. */
export async function probeLocalNetwork(c = config, gateway: () => Promise<string | null> = gatewayHost, tcp = tcpProbe): Promise<ProbeResult> {
  const g = lanTargets(c).length ? null : await gateway();
  const t = lanTargets(c)[0] ?? (g ? { host: g, port: 80 } : null);
  if (!t) return { status: "unknown", detail: "No LAN host to test. Check in System Settings." };
  const r = await tcp(t.host, t.port);
  if (r === "connected" || r === "refused") return { status: "granted", detail: `Reached ${t.host}.` };
  if (r === "unreachable") return { status: "missing", detail: `macOS blocked the connection to ${t.host} (No route to host).` };
  return { status: "unknown", detail: `${t.host} did not answer in time. Check in System Settings.` };
}

/** Removable and network volumes: listing a folder on the volume is what macOS gates. */
export function probeVolumes(vols: string[], list: (p: string) => unknown = (p) => readdirSync(p)): ProbeResult {
  for (const v of vols) {
    try { list(v); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return { status: "missing", detail: `Cannot list ${v}.` };
      return { status: "unknown", detail: `${v} is not available (${code ?? "error"}).` };
    }
  }
  return { status: "granted", detail: `Can list ${vols.join(", ")}.` };
}

/** Desktop / Documents / Downloads: listing the folder is what macOS gates (and what raises the popup). */
export function probeFolders(dirs: string[]): ProbeResult {
  for (const d of dirs) try { readdirSync(d); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return { status: "missing", detail: `Cannot open ${d}.` };
  }
  return { status: "granted", detail: `Can open ${dirs.join(", ")}.` };
}

/** The entries the user switches on under the program in System Settings (see Permission.targets). */
export function targetsFor(id: PermId, c = config): string[] {
  if (id === "files-folders") return protectedFolders(c).map((f) => f.split("/").pop()! + " Folder");
  if (id === "removable-volumes") return volumePaths(c).map((v) => v.split("/").pop()!);
  if (id === "automation") return ["System Events"];
  return [];
}

// ---- the list -----------------------------------------------------------------------------------------------------

type Def = Omit<Permission, "status" | "detail" | "settingsUrl" | "fix" | "targets"> & { passive?: () => ProbeResult };

export function definitions(c = config): Def[] {
  const I = c.integrations, lan = lanTargets(c), vols = volumePaths(c), folders = protectedFolders(c);
  const bots = !!(I.claudeOS || c.bots?.provider === "native" || I.telegramBots);
  const bun = { role: "Server OS (bun)", path: bunPath() };
  return [
    {
      id: "full-disk-access", how: "settings", title: "Full Disk Access",
      why: "Lets the Storage page size protected folders (Mail, Messages, Safari, Photos library data). Without it those folders are skipped and the totals are low. Bots started by Server OS also read projects anywhere in your home folder.",
      features: ["Storage scan", ...(bots ? ["Bots (Claude Code sessions)"] : [])], required: false, needed: true, active: false,
      processes: [bun, ...(bots ? [{ role: "Bots (claude)", path: claudePath() }, { role: "Bot sessions (tmux)", path: tmuxPath() }] : [])],
      passive: probeFullDiskAccess,
    },
    {
      id: "local-network", how: "dialog", title: "Local Network",
      why: "Lets the server talk to devices on your home network. macOS blocks this for programs you have not approved; the server then reports those devices as offline.",
      features: [...(I.homeAssistant ? ["Home Assistant"] : []), ...(I.adguard ? ["AdGuard Home"] : []), "Apps and devices on your network"], required: lan.length > 0, needed: true, active: true,
      processes: [bun],
    },
    {
      id: "removable-volumes", how: "dialog", title: "Removable & network volumes",
      why: "Lets the server read apps and data that live on an external drive or a network share.",
      features: ["External disk on the Storage page", "Apps or data stored on a drive"], required: vols.length > 0, needed: vols.length > 0, active: true,
      processes: [bun],
    },
    {
      id: "files-folders", how: "dialog", title: "Files & Folders",
      why: "Lets the server open your Desktop, Documents or Downloads folder. Your config points into one of them.",
      features: ["Folders named in config/server-os.yaml"], required: folders.length > 0, needed: folders.length > 0, active: true,
      processes: [bun],
    },
    {
      id: "microphone", how: "settings", title: "Microphone",
      why: "The desk speaker listens for the wake word. It runs inside tmux, so tmux is the program that needs the grant.",
      features: ["House voice"], required: false, needed: !!I.houseVoice?.dir, active: false,
      processes: [{ role: "House voice (tmux)", path: tmuxPath() }],
    },
    {
      id: "automation", how: "dialog", title: "Automation",
      why: "Used once by the setup wizard to open the agent in a new Terminal window. The server itself never needs it.",
      features: ["Setup wizard hand-over"], required: false, needed: false, active: false,
      processes: [{ role: "Terminal running the wizard", path: "Terminal.app / iTerm" }],
    },
  ];
}

/** Probe for one id. Active ones may raise a macOS popup, so callers run them only on request. */
export async function check(id: MacPermId, c = config): Promise<ProbeResult> {
  const vols = volumePaths(c), folders = protectedFolders(c);
  switch (id) {
    case "full-disk-access": return probeFullDiskAccess();
    case "local-network": return probeLocalNetwork(c);
    case "removable-volumes": return vols.length ? probeVolumes(vols) : { status: "not-needed", detail: "No external volume is configured." };
    case "files-folders": return folders.length ? probeFolders(folders) : { status: "not-needed", detail: "Config does not point into Desktop, Documents or Downloads." };
    case "microphone": return { status: "unknown", detail: "macOS only asks when the speaker first listens. Check in System Settings." };
    case "automation": return { status: "unknown", detail: "Cannot be checked without a popup. Check in System Settings." };
  }
}

/** The list for the API. Passive probes run now; active ones report "unknown" until `active` names them. */
export async function listPermissions(opts: { active?: PermId[]; platform?: NodeJS.Platform; cfg?: typeof config; sys?: LinuxSys } = {}): Promise<Permission[]> {
  const c = opts.cfg ?? config, platform = opts.platform ?? process.platform;
  if (platform === "linux") return linuxPermissions(opts.sys ?? realSys(), c);
  if (platform !== "darwin") return [];
  const out: Permission[] = [];
  for (const d of definitions(c)) {
    const { passive, ...rest } = d;
    let r: ProbeResult;
    if (!d.needed) r = { status: "not-needed", detail: d.id === "automation" ? "The server does not use it." : "Your config does not use this." };
    else if (d.active && !opts.active?.includes(d.id)) r = { status: "unknown", detail: "Not tested yet. Press Re-check: macOS may ask you to allow it." };
    else r = passive ? passive() : await check(d.id as MacPermId, c);
    out.push({ ...rest, ...r, settingsUrl: DEEP_LINKS[d.id as MacPermId], fix: [], targets: targetsFor(d.id, c) });
  }
  return out;
}

// ---- Linux --------------------------------------------------------------------------------------------------------
// No TCC here. What Server OS features really depend on: Docker socket access (group `docker`), reading the folders
// the config names (and mounts under /mnt, /media), systemd user lingering so services outlive the login, the host
// firewall when the panel is served beyond loopback, and SELinux when it is enforcing. Audited against the code:
// Logs reads Server OS's own JSON log files (no journal access needed) and sudo is used only by the macOS storage
// cleanup, so neither is listed. AppArmor denials need root to read, so they are not probed. Every probe is read-only
// and never uses sudo; every fix is a command for the user to copy.

export interface LinuxSys {
  uid: number; user: string; env: Record<string, string | undefined>;
  access(path: string, mode: number): "ok" | "denied" | "missing";
  exists(path: string): boolean;
  readFile(path: string): string | null;
  readdir(path: string): "ok" | "denied" | "missing";
  run(cmd: string[]): Promise<{ code: number; out: string }>;
  which(name: string): string | null;
  socket: string;
}
const errKind = (e: unknown): "denied" | "missing" => ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "denied");
export function realSys(): LinuxSys {
  return {
    uid: process.getuid?.() ?? -1, user: process.env.USER || process.env.LOGNAME || "$USER", env: process.env,
    access: (p, m) => { try { accessSync(p, m); return "ok"; } catch (e) { return errKind(e); } },
    exists: existsSync,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    readdir: (p) => { try { readdirSync(p); return "ok"; } catch (e) { return errKind(e); } },
    run: (cmd) => run(cmd, 4000), which: (n) => Bun.which(n), socket: dockerSocket(),
  };
}

/** Mount points under /mnt and /media from /proc/mounts (external disks, network shares). */
export function externalMounts(procMounts: string): string[] {
  const out = new Set<string>();
  for (const line of procMounts.split("\n")) {
    const mp = line.split(" ")[1]?.replace(/\\040/g, " ");
    if (mp && /^\/(mnt|media)\/./.test(mp)) out.add(mp);
  }
  return [...out];
}

const isLoopbackHost = (h: string | undefined) => !h || ["127.0.0.1", "localhost", "::1"].includes(h);

export async function linuxPermissions(sys: LinuxSys, c = config): Promise<Permission[]> {
  const bun = { role: "Server OS (bun)", path: bunPath() };
  const base = { settingsUrl: "", processes: [bun], active: false, how: "" as const };
  const out: Permission[] = [];
  const add = (p: Omit<Permission, "settingsUrl" | "processes" | "active" | "fix" | "how"> & { fix?: string[] }) => out.push({ ...base, fix: [], ...p });
  const root = sys.uid === 0, user = sys.user;

  // Docker: the Apps page and every Docker-based app talk to the Engine API over its socket.
  const dockerHere = sys.exists(sys.socket) || !!sys.which("docker");
  {
    const a = root ? "ok" : sys.access(sys.socket, constants.R_OK | constants.W_OK);
    add({ id: "docker-access", title: "Docker access", why: "Lets Server OS list, start and stop Docker containers and install Docker-based apps. The Docker socket belongs to the `docker` group.",
      features: ["Apps (Docker)", "Installing apps"], required: dockerHere, needed: dockerHere,
      ...(a === "ok" ? { status: "granted", detail: `Can use ${sys.socket}.` } : a === "denied"
        ? { status: "missing", detail: `${user} cannot use ${sys.socket}. Add it to the docker group, then log out and in (or restart the Server OS service).` }
        : { status: "unknown", detail: `${sys.socket} not found: Docker is not running or not installed.` }),
      fix: a === "denied" ? [`sudo usermod -aG docker ${user}`, "# then log out and back in, or restart Server OS from a new login"] : a === "missing" ? ["sudo systemctl enable --now docker"] : [] });
  }

  // Paths: folders named in the config, plus external mounts. Missing folders are ignored (not created yet).
  {
    const paths = [...new Set(configuredPaths(c))].filter((p) => sys.readdir(p) !== "missing" || sys.access(p, constants.R_OK) !== "missing");
    const mounts = externalMounts(sys.readFile("/proc/mounts") ?? "");
    const bad = [...new Set([...paths, ...mounts])].filter((p) => sys.readdir(p) === "denied");
    const underMount = bad.some((p) => /^\/(mnt|media)\//.test(p));
    add({ id: "path-access", title: "Folder & disk access", why: "Lets the server read the folders in its config and the disks mounted under /mnt and /media (Storage scan, apps and data kept on another disk).",
      features: ["Storage scan", "Folders named in config/server-os.yaml"], required: bad.length > 0 && !!bad.find((p) => paths.includes(p)), needed: true,
      ...(bad.length ? { status: "missing", detail: `Cannot read: ${bad.join(", ")}.` } : { status: "granted", detail: `Can read ${paths.length} configured folder${paths.length === 1 ? "" : "s"}${mounts.length ? ` and ${mounts.length} mounted disk${mounts.length === 1 ? "" : "s"}` : ""}.` }),
      fix: bad.flatMap((p) => [`sudo setfacl -R -m u:${user}:rX '${p}'   # read access for ${user}, keeps the owner`, ...(underMount ? [`# disk mounted as another user? remount with: uid=$(id -u),gid=$(id -g) in its /etc/fstab options`] : [])]).slice(0, 4) });
  }

  // systemd user lingering: the panel and bots run as `systemctl --user` services that stop at logout without it.
  {
    const systemd = sys.exists("/run/systemd/system");
    let status: PermStatus = "unknown", detail = "systemd not detected.";
    if (systemd && !root) {
      const r = await sys.run(["loginctl", "show-user", String(sys.uid), "-p", "Linger"]);
      if (/Linger=yes/.test(r.out)) { status = "granted"; detail = "Services keep running after you log out."; }
      else if (/Linger=no/.test(r.out)) { status = "missing"; detail = "User services stop when you log out (and do not start at boot until you log in)."; }
      else detail = "Could not read the lingering state.";
    } else if (root) { status = "granted"; detail = "Running as root: system services are not tied to a login."; }
    add({ id: "linger", title: "Run after logout (lingering)", why: "Server OS and its bots run as systemd user services. Without lingering they stop when the last session ends and do not start at boot.",
      features: ["Server OS service", "Bots"], required: false, needed: systemd && !root, status, detail,
      fix: status === "missing" ? [`sudo loginctl enable-linger ${user}`] : [] });
  }

  // Firewall: only matters when the panel is served beyond loopback (HOST=0.0.0.0). Behind Caddy / Tailscale it is not.
  {
    const exposed = !isLoopbackHost(sys.env.HOST), port = sys.env.PORT || "3094";
    let status: PermStatus = "granted", detail = "The panel listens on loopback only; the firewall is not involved.", fw = "", fix: string[] = [];
    if (exposed) {
      const [ufw, fwd] = await Promise.all([sys.run(["systemctl", "is-active", "ufw"]), sys.run(["systemctl", "is-active", "firewalld"])]);
      fw = /^active/m.test(fwd.out) ? "firewalld" : /^active/m.test(ufw.out) ? "ufw" : "";
      if (!fw) detail = "No ufw or firewalld is running.";
      else {
        status = "unknown"; detail = `${fw} is active and the panel listens on ${sys.env.HOST}:${port}. If other devices cannot reach it, open the port (reading firewall rules needs root, so this is not tested).`;
        fix = fw === "ufw" ? [`sudo ufw allow ${port}/tcp`] : [`sudo firewall-cmd --permanent --add-port=${port}/tcp`, "sudo firewall-cmd --reload"];
      }
    }
    add({ id: "firewall", title: "Firewall", why: "A host firewall can block other devices from reaching the panel when it listens on the network (HOST=0.0.0.0).",
      features: ["Panel on the LAN"], required: false, needed: exposed, status, detail, fix });
  }

  // SELinux (Fedora, RHEL family): enforcing mode can deny a container reading a bind-mounted folder.
  {
    const enforcing = sys.readFile("/sys/fs/selinux/enforce")?.trim() === "1";
    add({ id: "selinux", title: "SELinux", why: "With SELinux enforcing, a Docker container may be refused a folder it bind-mounts from your home or another disk, even when the permissions look right.",
      features: ["Docker apps with bind mounts"], required: false, needed: enforcing,
      status: enforcing ? "unknown" : "not-needed",
      detail: enforcing ? "SELinux is enforcing. If an app says permission denied on its folder, look for denials; this is not tested (it needs root)." : "SELinux is not enforcing here.",
      fix: enforcing ? ["sudo ausearch -m avc -ts recent   # lists recent denials", "# in the app's compose file, add :z to a volume:  ./data:/data:z"] : [] });
  }
  return out;
}

const LINUX_IDS = ["docker-access", "path-access", "linger", "firewall", "selinux"];
export const isPermId = (s: string): s is PermId => s in DEEP_LINKS || LINUX_IDS.includes(s);

/** Open the System Settings pane on this Mac. */
export async function openSettings(id: PermId) { return run(["/usr/bin/open", DEEP_LINKS[id as MacPermId]], 5000); }

export interface FixDeps {
  open(id: PermId): Promise<{ code: number }>;
  /** Starts the macOS popup. Resolves "prompt" when it is (probably) up, or what macOS had already decided: then no popup comes. */
  trigger(id: MacPermId): Promise<"prompt" | "granted" | "denied">;
}

/** Folders and disks for an explicit Fix: the configured ones, else every protected home folder / external volume, so the
 *  button always reaches something macOS asks about (with nothing configured it used to probe nothing and show nothing). */
function fixTargets(id: "files-folders" | "removable-volumes"): string[] {
  if (id === "files-folders") { const f = protectedFolders(); return f.length ? f : PROTECTED_HOME.map((d) => join(HOME, d)); }
  const v = volumePaths(); if (v.length) return v;
  try { return readdirSync("/Volumes").map((n) => "/Volumes/" + n).filter((p) => { try { return !lstatSync(p).isSymbolicLink(); } catch { return false; } }); } catch { return []; }
}

/** List each path in a child `ls` so a popup never blocks the server. The child runs as this program, so macOS asks about
 *  it. A child that is still waiting after ~1.5 s means the popup is up; one that ends at once means macOS had decided. */
async function askByListing(paths: string[]): Promise<"prompt" | "granted" | "denied"> {
  if (!paths.length) return "granted";
  const kids = paths.map((p) => Bun.spawn(["/bin/ls", p], { stdout: "ignore", stderr: "ignore" }));
  const settled = await Promise.race([Promise.all(kids.map((k) => k.exited)), Bun.sleep(1500).then(() => null)]);
  if (settled === null) { for (const k of kids) k.unref(); return "prompt"; }
  return settled.every((c) => c === 0) ? "granted" : "denied";
}
const realFixDeps: FixDeps = {
  open: openSettings,
  async trigger(id) {
    // The first attempt by this program is what makes macOS ask.
    if (id === "removable-volumes" || id === "files-folders") return askByListing(fixTargets(id));
    if (id === "local-network") void probeLocalNetwork().catch(() => {});
    else if (id === "automation") {
      // Asks "bun wants to control System Events". Not awaited: osascript waits for the click and killing it would drop the popup.
      try { Bun.spawn(["/usr/bin/osascript", "-e", 'tell application "System Events" to return name'], { stdout: "ignore", stderr: "ignore" }).unref(); } catch { /* no osascript */ }
    }
    return "prompt";
  },
};

/** The Fix button. A permission macOS asks about with a popup gets that popup (`did: "prompt"`); one that has no prompt, or
 *  whose popup the user can no longer get (`pane: true`, after a "Don't Allow"), opens its System Settings pane (`did: "pane"`). */
export async function fixPermission(id: MacPermId, o: { pane?: boolean } = {}, deps: FixDeps = realFixDeps): Promise<{ ok: boolean; did: "prompt" | "pane" | "granted"; denied?: boolean }> {
  const d = definitions().find((x) => x.id === id);
  if (d?.how === "dialog" && !o.pane) {
    const got = await deps.trigger(id);
    if (got === "prompt") return { ok: true, did: "prompt" };
    if (got === "granted") return { ok: true, did: "granted" };
    // Denied before: macOS never asks twice, so the switch in Settings is the only way left.
    const r = await deps.open(id);
    return { ok: r.code === 0, did: "pane", denied: true };
  }
  const r = await deps.open(id);
  return { ok: r.code === 0, did: "pane" };
}

/** What the audit and log line of a Fix records beyond ok / failed: the outcome, so a log shows what macOS did. */
export const fixAttrs = (r: { did: string; denied?: boolean }): Record<string, unknown> => ({ did: r.did, denied: r.denied === true });

/** Required permission that is missing: what the Overview banner shows. */
export const missingRequired = (l: Permission[]) => l.filter((p) => p.required && p.status === "missing");
