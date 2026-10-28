// Storage module: disk explorer + one-tap cleanups (the Storage tab). Ported from the old Python svc-control storage.py.
//   GET  /storage              volumes (live) + the cached scan + cleanup actions with their status
//   GET  /storage/drill?path=  top 15 children of a folder (home or the external disk only), async + cached
//   POST /storage/rescan       start a fresh background scan
//   POST /storage/run {id}     run one whitelisted cleanup in the background
// Safety: cleanups are a FIXED whitelist (ACTIONS). No request value ever becomes a delete path or a shell command.
// Drill-down is read-only `du`. Never touched: Docker volumes/containers, app data, Photos/Mail, ~/.claude, VM disks.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOME, ENV, run as sh, sleep, type RunResult } from "../lib";
import { config, dir } from "../core/config";

type Runner = (cmd: string[], timeoutMs?: number) => Promise<RunResult>;
export interface StorageOpts {
  home: string;
  /** Second disk (config.externalDisk), if any. */
  ext?: string;
  /** Volume that holds the home folder; "/System/Volumes/Data" on macOS, "/" elsewhere. */
  data: string;
  cacheFile: string;
  logFile: string;
  /** Folders the "Trim old logs" cleanup looks in. */
  logDirs: string[];
  platform: NodeJS.Platform;
  run: Runner;
  /** Where the sudo password for snapshot thinning comes from (empty = try without). */
  sudoPassword?: string;
  settleMs: number;
}

const SCAN_TTL = 600_000; // ms a scan stays fresh
const DRILL_TTL = 600_000;
const LOG_AGE_DAYS = 30;
const CACHE_AGE_DAYS = 14;
const MB = 2 ** 20;
const now = () => Date.now() / 1000; // the API reports epoch seconds, like the Python service did

export interface Item { label: string; path: string | null; bytes: number; note?: string | null }
export interface Group { id: string; label: string; note: string; items: Item[] }
export interface RunStatus { state: "running" | "done" | "failed"; started: number; finished?: number; log: string[]; freed: number | null; rc?: number }
type Err = { err: { status: number; detail: string } };
const fail = (status: number, detail: string): Err => ({ err: { status, detail } });

const LOG_RE = /\.(log|out|err|ips|crash|spin|hang|diag|gz)(\.\d+)?(\.gz)?$/i;
const CACHE_KEEP = new Set(["ms-playwright", "ms-playwright-mcp", "Homebrew"]); // Playwright browsers are needed by MCP; brew has its own action
const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

export function parseSize(s: string | undefined): number {
  const m = (s ?? "").match(/^([\d.]+)\s*([kKMGT]?B)/);
  return m ? Math.floor(parseFloat(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1)) : 0;
}

/** Home-relative folders macOS privacy protection always guards (TCC), never walked by the scan. */
export const PROTECTED = ["Library/Mail", "Library/Messages", "Library/Safari", "Library/Calendars", "Library/Reminders", "Library/HomeKit",
  "Library/Accounts", "Library/Biome", "Library/Suggestions", "Library/IdentityServices", "Library/Cookies", "Library/Metadata/CoreSpotlight",
  "Library/Application Support/AddressBook", "Library/Application Support/CallHistoryDB", "Library/Application Support/CallHistoryTransactions",
  "Library/Application Support/FaceTime", "Library/Application Support/com.apple.TCC"];

/** `du` prints "<kb>\t<path>" lines; stderr is merged in, so privacy blocks ("Operation not permitted") ride along. */
export function parseDu(out: string): { sizes: Map<string, number>; denied: string[] } {
  const sizes = new Map<string, number>(), denied: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.indexOf("\t");
    if (t > 0 && /^\d+$/.test(line.slice(0, t))) { sizes.set(line.slice(t + 1), Number(line.slice(0, t)) * 1024); continue; }
    const m = line.match(/^du: (.+?): Operation not permitted/); // TCC block; plain "Permission denied" (root-owned) is expected noise
    if (m) denied.push(m[1]);
  }
  return { sizes, denied };
}

export function createStorage(o: StorageOpts) {
  const { home, ext, data, run, platform } = o;
  const mac = platform === "darwin";
  const h = (p: string) => join(home, p);
  const extName = ext ? basename(ext) : "";
  const extVol = ext ?? data; // where Docker lives: the external disk when there is one
  const trashes = mac ? [h(".Trash"), ...(ext ? [join(ext, ".Trashes", String(process.getuid?.() ?? 501))] : [])]
    : [h(".local/share/Trash/files"), h(".local/share/Trash/info"), ...(ext ? [join(ext, `.Trash-${process.getuid?.() ?? 1000}`)] : [])];

  const scan = { state: "idle" as "idle" | "scanning" | "ready" | "error", started: null as number | null, finished: null as number | null, duration: null as number | null,
    groups: [] as Group[], estimates: {} as Record<string, number | null>, avail: {} as Record<string, boolean>, notes: {} as Record<string, string | null>,
    error: null as string | null, denied: [] as string[] };
  const drills = new Map<string, { state: string; ts: number; children: unknown[]; total: number | null; count?: number }>();
  const denied = new Set<string>(); // folders du couldn't read (macOS privacy protection; the server lacks Full Disk Access)
  // Folders macOS blocked before are not walked again: each attempt shows an "access blocked" notification on the
  // Mac (2026-10-23). They stay listed as not scanned. Learned per scan and kept in the cache; seeded with the
  // folders macOS always protects, so even the first scan doesn't ask.
  const skip = new Set<string>(mac ? PROTECTED.map(h) : []);
  const runs = new Map<string, RunStatus>();
  let running = false; // one cleanup at a time so the freed-bytes measurement is honest

  try { // the last scan survives restarts, so the page is instant
    const c = JSON.parse(readFileSync(o.cacheFile, "utf8"));
    for (const k of ["started", "finished", "duration", "groups", "estimates", "avail", "notes", "denied"] as const) if (c[k] !== undefined) (scan as Record<string, unknown>)[k] = c[k];
    for (const p of c.skip ?? c.denied ?? []) skip.add(p); // caches from before 2026-10-23 only have the shown list
    scan.state = "ready";
  } catch { /* no cache yet */ }

  // ---------------------------------------------------------------- helpers
  function noteDenied(list: string[]) {
    for (let p of list) {
      if (p.startsWith(home + "/")) p = home + "/" + p.slice(home.length + 1).split("/").slice(0, 3).join("/"); // collapse to ~/a/b/c so the list stays short
      denied.add(p);
    }
  }
  /** Size in bytes of one path (stays on one filesystem). null if missing. */
  async function duK(path: string, timeout = 180_000): Promise<number | null> {
    if (!existsSyncL(path)) return null;
    if (skip.has(path)) { noteDenied([path]); return null; }
    const r = await run(["du", "-skx", ...ignores(), path], timeout);
    const { sizes, denied: d } = parseDu(r.out);
    noteDenied(d);
    const last = [...sizes.values()].pop();
    return last ?? null;
  }
  /** {path: bytes} for the path and its descendants up to `depth` (one du pass). */
  async function duDepth(path: string, depth: number, timeout = 600_000): Promise<Map<string, number>> {
    const r = await run(["du", "-k", "-x", ...ignores(), "-d", String(depth), path], timeout);
    const { sizes, denied: d } = parseDu(r.out);
    noteDenied(d);
    return sizes;
  }
  /** du options that leave the skipped folders out. They match by name, so a skipped name is skipped everywhere
   *  under the walked path; fine for sizes, and far better than a privacy prompt. */
  function ignores(): string[] {
    const names = [...new Set([...skip].map((p) => basename(p)))].filter(Boolean);
    return mac ? names.flatMap((n) => ["-I", n]) : names.map((n) => `--exclude=${n}`);
  }
  const existsSyncL = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  function vol(path: string, label: string) {
    try {
      const s = statfsSync(path);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return { label, path, total, used: total - free, free, pct: Math.round(((total - free) * 1000) / total) / 10 };
    } catch (e) { return { label, path, error: String(e) }; }
  }
  const freeBytes = (path: string): number | null => { try { const s = statfsSync(path); return s.bavail * s.bsize; } catch { return null; } };
  const within = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.replace(/\/$/, "") + "/"));
  function logLine(msg: string) {
    try {
      mkdirSync(dirname(o.logFile), { recursive: true });
      appendFileSync(o.logFile, `${new Date().toLocaleString("sv-SE")} ${msg}\n`);
    } catch { /* a missing log must not break a cleanup */ }
  }
  function remove(fp: string) {
    try { rmSync(fp, { recursive: true, force: true }); } catch { /* best effort, like the old service */ }
  }
  const lastLine = (s: string, dflt: string) => s.trim().split("\n").pop() || dflt;

  // ------------------------------------------------- file-walk based cleanups
  function* oldLogs(): Generator<[string, number]> {
    const cut = Date.now() - LOG_AGE_DAYS * 86400_000;
    const walk = function* (d: string): Generator<[string, number]> {
      let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = join(d, e.name);
        if (e.isDirectory()) { yield* walk(fp); continue; }
        if (!e.isFile() || !LOG_RE.test(e.name)) continue; // symlinks are neither (Dirent isFile is false for them)
        try { const st = lstatSync(fp); if (st.mtimeMs < cut) yield [fp, st.size]; } catch { /* vanished */ }
      }
    };
    for (const root of o.logDirs) yield* walk(root);
  }
  function oldCaches(): string[] {
    const cut = Date.now() - CACHE_AGE_DAYS * 86400_000, base = h("Library/Caches"), out: string[] = [];
    let names: string[]; try { names = readdirSync(base); } catch { return out; }
    for (const n of names) {
      const fp = join(base, n);
      if (CACHE_KEEP.has(n)) continue;
      try { const st = lstatSync(fp); if (!st.isSymbolicLink() && st.mtimeMs < cut) out.push(fp); } catch { /* vanished */ }
    }
    return out;
  }
  function trashEntries(): string[] {
    const out: string[] = [];
    for (const t of trashes) { try { for (const n of readdirSync(t)) out.push(join(t, n)); } catch { /* no trash here */ } }
    return out;
  }

  // ------------------------------------------------------------- the actions
  type Say = (m: string) => void;
  const actTrash = async (say: Say) => { const l = trashEntries(); l.forEach(remove); say(`removed ${l.length} item(s) from Trash`); };
  const actBrew = async (say: Say) => { const r = await run(["brew", "cleanup", "-s", "--prune=all"], 900_000); say(lastLine(r.out, "brew cleanup done")); return r.code; };
  async function actDocker(say: Say) {
    const a = await run(["docker", "image", "prune", "-f"], 600_000); say("dangling images: " + lastLine(a.out, "ok"));
    const b = await run(["docker", "builder", "prune", "-f"], 600_000); say("build cache: " + lastLine(b.out, "ok"));
    return a.code || b.code;
  }
  const actDockerUnused = async (say: Say) => { const r = await run(["docker", "image", "prune", "-a", "-f"], 900_000); say("unused images: " + lastLine(r.out, "ok")); return r.code; };
  async function actDevcache(say: Say) {
    const steps: [string, string[]][] = [["npm", ["npm", "cache", "clean", "--force"]], ["pnpm", ["pnpm", "store", "prune"]], ["bun", [h(".bun/bin/bun"), "pm", "cache", "rm"]],
      ["uv", ["uv", "cache", "clean"]], ["pip", ["pip3", "cache", "purge"]]];
    let bad = 0;
    for (const [name, cmd] of steps) {
      const have = (await run(["sh", "-c", 'command -v "$1"', "sh", cmd[0]], 5_000)).code === 0;
      if (!have) { say(`${name}: not installed, skipped`); continue; }
      const r = await run(cmd, 600_000);
      say(`${name}: ${r.code === 0 ? "ok" : "exit " + r.code}`);
      if (r.code !== 0) bad++;
    }
    return bad < steps.length ? 0 : 1;
  }
  async function actXcode(say: Say) {
    let n = 0;
    for (const d of [h("Library/Developer/Xcode/DerivedData"), h("Library/Developer/Xcode/iOS DeviceSupport")]) {
      try { for (const name of readdirSync(d)) { remove(join(d, name)); n++; } } catch { /* not there */ }
    }
    say(`removed ${n} DerivedData / DeviceSupport item(s)`);
  }
  const actSims = async (say: Say) => { const r = await run(["xcrun", "simctl", "delete", "unavailable"], 600_000); say(r.out || "deleted unavailable simulators"); return r.code; };
  async function actLogs(say: Say) {
    let n = 0, b = 0;
    for (const [fp, sz] of [...oldLogs()]) { try { unlinkSync(fp); n++; b += sz; } catch { /* skip */ } }
    say(`deleted ${n} log file(s) older than ${LOG_AGE_DAYS} days (${(b / MB).toFixed(1)} MB)`);
  }
  async function actCaches(say: Say) { const l = oldCaches(); l.forEach(remove); say(`removed ${l.length} cache folder(s) untouched for ${CACHE_AGE_DAYS}+ days`); }
  async function actSnapshots(say: Say) {
    const cmd = ["tmutil", "thinlocalsnapshots", "/", "999999999999", "4"];
    let r: RunResult;
    if (o.sudoPassword) { // the password goes in on stdin, never on a command line
      const p = Bun.spawn(["sudo", "-S", "-p", "", ...cmd], { stdin: new Blob([o.sudoPassword + "\n"]), stdout: "pipe", stderr: "pipe" });
      const t = setTimeout(() => p.kill(), 600_000);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      clearTimeout(t);
      r = { code: await p.exited, out: (out + err).trim() };
    } else r = await run(cmd, 600_000);
    say(r.out.replace(/\n/g, " ").slice(0, 300) || "thin requested");
    return r.code;
  }

  interface Action { id: string; label: string; risk: "safe" | "careful"; vol: string; fn: (say: Say) => Promise<number | void>; desc: string; cmd: string; mac?: boolean }
  const logDirsTxt = o.logDirs.map((d) => d.replace(home, "~")).join(" ");
  const ALL: Action[] = [
    { id: "logs", label: "Trim old logs", risk: "safe", vol: data, fn: actLogs,
      desc: `Deletes log and crash-report files older than ${LOG_AGE_DAYS} days in ${o.logDirs.map((d) => d.replace(home, "~")).join(", ")}. Recent logs stay.`,
      cmd: `find ${logDirsTxt} -type f -mtime +${LOG_AGE_DAYS} -name '*.log|*.ips|*.gz…' -delete` },
    { id: "brew", label: "Homebrew cleanup", risk: "safe", vol: data, fn: actBrew,
      desc: "Removes old Homebrew downloads and outdated package versions. Installed tools keep working.", cmd: "brew cleanup -s --prune=all" },
    { id: "devcache", label: "Developer package caches", risk: "safe", vol: data, fn: actDevcache,
      desc: "Clears npm, pnpm, bun, uv and pip download caches. Packages re-download when next needed. npx MCP servers (~/.npm/_npx) are kept.",
      cmd: "npm cache clean --force; pnpm store prune; bun pm cache rm; uv cache clean; pip3 cache purge" },
    { id: "caches", label: "Stale app caches", risk: "safe", vol: data, fn: actCaches, mac: true,
      desc: `Removes ~/Library/Caches folders untouched for ${CACHE_AGE_DAYS}+ days. Apps rebuild them. Playwright browsers are kept.`,
      cmd: `find ~/Library/Caches -mindepth 1 -maxdepth 1 -mtime +${CACHE_AGE_DAYS} ! -name 'ms-playwright*' -exec rm -rf {} +` },
    { id: "xcode", label: "Xcode build leftovers", risk: "safe", vol: data, fn: actXcode, mac: true,
      desc: "Deletes Xcode DerivedData and iOS DeviceSupport. Both regenerate on the next build or device connect.",
      cmd: "rm -rf ~/Library/Developer/Xcode/DerivedData/* ~/Library/Developer/Xcode/iOS\\ DeviceSupport/*" },
    { id: "sims", label: "Unavailable simulators", risk: "safe", vol: data, fn: actSims, mac: true,
      desc: "Deletes simulator devices whose runtime is no longer installed.", cmd: "xcrun simctl delete unavailable" },
    { id: "docker", label: "Docker leftovers", risk: "safe", vol: extVol, fn: actDocker,
      desc: "Removes dangling (untagged) images and the build cache. Containers, volumes and in-use images are untouched." + (ext ? ` Docker lives on ${extName}; its disk image may release space to macOS slowly.` : ""),
      cmd: "docker image prune -f && docker builder prune -f" },
    { id: "docker_unused", label: "Unused Docker images", risk: "careful", vol: extVol, fn: actDockerUnused,
      desc: "Removes every image no container uses (stopped containers keep theirs, so a paused stack is safe). A future compose up may need to re-pull. Volumes untouched.",
      cmd: "docker image prune -a -f" },
    { id: "trash", label: "Empty Trash", risk: "careful", vol: data, fn: actTrash,
      desc: `Permanently deletes everything in the Trash (internal${ext ? ` and ${extName}` : ""}). Cannot be undone.`,
      cmd: "rm -rf " + trashes.map((t) => t.replace(home, "~") + "/*").join(" ") },
    { id: "snapshots", label: "Thin Time Machine snapshots", risk: "careful", vol: data, fn: actSnapshots, mac: true,
      desc: "Asks macOS to purge local Time Machine snapshots (uses sudo). macOS-update snapshots (com.apple.os.update-*) are not affected; those go away when the pending update installs.",
      cmd: "sudo tmutil thinlocalsnapshots / 999999999999 4" },
  ];
  const ACTIONS = ALL.filter((a) => mac || !a.mac); // the macOS-only cleanups simply don't exist elsewhere
  const ABY = new Map(ACTIONS.map((a) => [a.id, a]));

  // ------------------------------------------------------------------ scan
  /** System-level APFS volumes du can't see (Preboot, VM swap, simulator runtime images). */
  async function apfsBreakdown(): Promise<Item[]> {
    if (!mac) return [];
    const r = await run(["sh", "-c", "diskutil apfs list -plist | plutil -convert json -o - -"], 30_000); // the plist → JSON via plutil (no plist parser in Bun)
    if (r.code) return [];
    let d: { Containers?: { Volumes?: { Name?: string; Roles?: string[]; CapacityInUse?: number }[] }[] };
    try { d = JSON.parse(r.out); } catch { return []; }
    const items: Item[] = [];
    const NOTES: Record<string, string> = { System: "sealed macOS, untouchable", Preboot: "normally 6–8 GB; bloated by a staged macOS update — installing the update shrinks it",
      VM: "swap — shrinks only after a reboot / less RAM pressure", Recovery: "recovery OS", Update: "update staging" };
    for (const c of d.Containers ?? []) {
      const vols = c.Volumes ?? [];
      const roles = new Set(vols.flatMap((v) => v.Roles ?? []));
      if (roles.has("Data") && roles.has("System")) {
        for (const v of vols) {
          const role = v.Roles?.[0] ?? "?";
          if (role === "Data") continue;
          items.push({ label: `${v.Name} (${role})`, path: null, bytes: v.CapacityInUse ?? 0, note: NOTES[role] ?? "" });
        }
      } else if (vols.some((v) => (v.Name ?? "").includes("Simulator"))) {
        for (const v of vols) items.push({ label: v.Name ?? "?", path: null, bytes: v.CapacityInUse ?? 0, note: "simulator runtime image — remove in Xcode › Settings › Platforms if unused" });
      }
    }
    return items;
  }
  async function unavailableSims(): Promise<number | null> {
    const r = await run(["xcrun", "simctl", "list", "devices", "unavailable", "-j"], 60_000);
    if (r.code) return null;
    try {
      let tot = 0;
      for (const lst of Object.values(JSON.parse(r.out).devices ?? {}) as { dataPath?: string }[][])
        for (const d of lst) if (d.dataPath) tot += (await duK(dirname(d.dataPath))) ?? 0;
      return tot;
    } catch { return null; }
  }
  async function dockerDf(): Promise<Record<string, string>[]> {
    const r = await run(["docker", "system", "df", "--format", "{{json .}}"], 60_000);
    if (r.code) return [];
    const rows: Record<string, string>[] = [];
    for (const l of r.out.split("\n")) { try { rows.push(JSON.parse(l)); } catch { /* not a row */ } }
    return rows;
  }
  async function dockerDangling(): Promise<number | null> {
    const r = await run(["docker", "images", "-f", "dangling=true", "--format", "{{.Size}}"], 60_000);
    return r.code === 0 ? r.out.split("\n").reduce((s, l) => s + parseSize(l), 0) : null;
  }
  const tmSnapshots = async () => mac ? (await run(["tmutil", "listlocalsnapshots", "/"], 30_000)).out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("com.apple.")) : [];

  async function doScan() {
    const t0 = Date.now();
    denied.clear();
    noteDenied([...skip].filter(existsSyncL));
    const groups: Group[] = [], sizes = new Map<string, number>();
    const byBytes = (a: Item, b: Item) => b.bytes - a.bytes;

    // 1) home top level (each child on its own, Library walked 2 deep in one pass)
    const homeItems: Item[] = [];
    let names: string[] = []; try { names = readdirSync(home); } catch { /* unreadable home */ }
    for (const n of names) {
      const fp = join(home, n);
      let link = false; try { link = lstatSync(fp).isSymbolicLink(); } catch { /* gone */ }
      if (link || n === "Library") continue;
      const b = await duK(fp, 300_000);
      if (b) sizes.set(fp, b);
      if (b && b >= 100 * MB) homeItems.push({ label: "~/" + n, path: fp, bytes: b });
    }
    const lib = await duDepth(h("Library"), 2, 900_000);
    for (const [p, b] of lib) sizes.set(p, b);
    if (lib.get(h("Library"))) homeItems.push({ label: "~/Library", path: h("Library"), bytes: lib.get(h("Library"))! });
    homeItems.sort(byBytes);
    groups.push({ id: "home", label: "Home folders", note: "Top-level folders in ~ (internal SSD only)", items: homeItems.slice(0, 25) });

    // 2) inside Library
    const libItems: Item[] = [], SUBS = ["Application Support", "Containers", "Group Containers", "Caches", "Developer"];
    for (const sub of SUBS) {
      const base = h("Library/" + sub);
      const kids = [...lib].filter(([p]) => dirname(p) === base).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [p, b] of kids) if (b >= 200 * MB) {
        libItems.push({ label: `${sub} › ${basename(p)}`, path: p, bytes: b, note: p.endsWith("com.docker.install") ? "Docker Desktop installer leftovers — removed safely before (2026-09-09); ask Claude" : null });
      }
    }
    for (const [p, b] of lib) if (dirname(p) === h("Library") && !SUBS.includes(basename(p)) && b >= 500 * MB) libItems.push({ label: basename(p), path: p, bytes: b });
    libItems.sort(byBytes);
    groups.push({ id: "library", label: "Inside ~/Library", note: "Biggest app data and caches", items: libItems.slice(0, 20) });

    // 3) notable known spots
    const sz = async (p: string) => sizes.get(p) ?? await duK(p);
    const brewCache = mac || Bun.which("brew") ? (await run(["brew", "--cache"], 20_000)).out.trim() || h("Library/Caches/Homebrew") : h("Library/Caches/Homebrew");
    const notable: [string, string, string][] = [
      ["Homebrew download cache", brewCache, "regenerable — Homebrew cleanup"],
      ["npm cache", h(".npm/_cacache"), "regenerable — developer caches"],
      ["npx MCP packages", h(".npm/_npx"), "keep — bots re-download MCP servers"],
      ["pnpm store", h("Library/pnpm/store"), "regenerable — developer caches"],
      ["bun cache", h(".bun/install/cache"), "regenerable — developer caches"],
      ["uv cache", h(".cache/uv"), "regenerable — developer caches"],
      ["pip cache", h("Library/Caches/pip"), "regenerable — developer caches"],
      ["Hugging Face models", h(".cache/huggingface"), "keep — downloaded models"],
      ["Xcode DerivedData", h("Library/Developer/Xcode/DerivedData"), "regenerable"],
      ["Xcode Archives", h("Library/Developer/Xcode/Archives"), "keep — app store builds"],
      ["iOS DeviceSupport", h("Library/Developer/Xcode/iOS DeviceSupport"), "regenerable"],
      ["Simulator devices", h("Library/Developer/CoreSimulator"), "Skip/iOS work"],
      ["Swift toolchains", h("Library/Developer/Toolchains"), "Skip/iOS work"],
      ["Trash", trashes[0], "Empty Trash"],
      ["Downloads", h("Downloads"), "review by hand"],
      ...o.logDirs.map((d): [string, string, string] => [`Logs (${d.replace(home, "~")})`, d, "old ones — trim logs"]),
      ["iPhone/iPad backups", h("Library/Application Support/MobileSync/Backup"), "review by hand"],
      ["Claude transcripts", h(".claude/projects"), "report only — memory + history"],
      ["Superpowers archive", h(".config/superpowers"), "report only — prune only with the owner's OK"],
      ["Home Assistant VM", h("Library/Containers/com.utmapp.UTM"), "keep — VM disk"],
      ["Chrome profile", h("Library/Application Support/Google/Chrome"), "keep"],
      ["Playwright browsers", h("Library/Caches/ms-playwright"), "keep — Playwright MCP"],
    ];
    const nItems: Item[] = [];
    for (const [label, p, note] of notable) { const b = await sz(p); if (b) nItems.push({ label, path: p, bytes: b, note }); }
    const snaps = await tmSnapshots(), tm = snaps.filter((s) => s.includes("TimeMachine"));
    if (mac) nItems.push({ label: "Local snapshots", path: null, bytes: 0, note: `${snaps.length} snapshot(s): ${tm.length} Time Machine, ${snaps.length - tm.length} macOS update — size not reported by macOS` });
    nItems.sort(byBytes);
    groups.push({ id: "notable", label: "Known space eaters", note: "Caches, dev tools, backups, logs", items: nItems });

    // 4) outside home (report only — drill-down is limited to home + the external disk)
    const outside: [string, string, string][] = mac ? [
      ["Applications", "/Applications", "installed apps"],
      ["Homebrew", "/opt/homebrew", "installed formulae — Homebrew cleanup trims old versions"],
      ["System-wide Library", "/Library", "shared app data, simulator caches"],
      ["System var (temp, caches, db)", "/System/Volumes/Data/private/var", "macOS-managed"],
      ["macOS assets (AssetsV2)", "/System/Volumes/Data/System/Library/AssetsV2", "macOS-managed downloads: update assets, simulator runtimes"],
    ] : [["System software", "/usr", "installed packages and libraries"], ["System var (logs, caches, db)", "/var", "OS-managed"], ["Optional software", "/opt", "installed outside the package manager"]];
    const oItems: Item[] = [];
    for (const [label, p, note] of outside) { const b = await duK(p, 300_000); if (b) oItems.push({ label, path: null, bytes: b, note: note + " · " + p }); }
    oItems.sort(byBytes);
    groups.push({ id: "outside", label: "Outside home", note: "Big system folders on the internal disk (read-only view)", items: oItems });

    // 5) system / APFS
    groups.push({ id: "system", label: "macOS system", note: "APFS volumes that folder sizes can't see", items: (await apfsBreakdown()).sort(byBytes) });

    // 6) docker
    const ddf = await dockerDf();
    groups.push({ id: "docker", label: ext ? `Docker (${extName})` : "Docker", note: ext ? `Lives on ${extName}, not the internal disk` : "Images, containers, volumes and build cache",
      items: ddf.map((r) => ({ label: `Docker ${(r.Type ?? "").toLowerCase()}`, path: null, bytes: parseSize(r.Size), note: `${r.TotalCount} total, ${r.Active} active, reclaimable ${r.Reclaimable}` })) });

    // estimates: what each cleanup would free
    const sumP = async (ps: string[]) => { let t = 0; for (const p of ps) t += (await sz(p)) ?? 0; return t; };
    const est: Record<string, number | null> = {};
    est.logs = [...oldLogs()].reduce((s, [, n]) => s + n, 0);
    est.brew = (await sz(brewCache)) ?? 0;
    est.devcache = await sumP([h(".npm/_cacache"), h("Library/pnpm/store"), h(".bun/install/cache"), h(".cache/uv"), h("Library/Caches/pip")]);
    est.caches = await sumP(oldCaches());
    est.xcode = await sumP([h("Library/Developer/Xcode/DerivedData"), h("Library/Developer/Xcode/iOS DeviceSupport")]);
    est.sims = mac ? await unavailableSims() : null;
    est.docker = ((await dockerDangling()) ?? 0) + ddf.filter((r) => r.Type === "Build Cache").reduce((s, r) => s + parseSize(r.Size), 0);
    const img = ddf.find((r) => r.Type === "Images");
    est.docker_unused = img ? parseSize(img.Reclaimable) : null;
    est.trash = await sumP(trashEntries());
    est.snapshots = null;
    const avail = { sims: est.sims !== null, snapshots: tm.length > 0 };
    const notes = { sims: avail.sims ? null : "Xcode isn't installed (only Command Line Tools), so simctl is unavailable.",
      snapshots: tm.length ? null : `No Time Machine snapshots right now — only ${snaps.length} macOS-update snapshot(s), which this can't remove.` };
    Object.assign(scan, { state: "ready", finished: now(), duration: Math.round((Date.now() - t0) / 100) / 10, groups, estimates: est, avail, notes, error: null,
      denied: [...denied].filter((p) => p.startsWith(home)).sort().slice(0, 12) });
    for (const p of denied) skip.add(p);
    try {
      mkdirSync(dirname(o.cacheFile), { recursive: true });
      const { started, finished, duration, estimates, avail: av, notes: nt, denied: dn } = scan;
      writeFileSync(o.cacheFile + ".tmp", JSON.stringify({ started, finished, duration, groups, estimates, avail: av, notes: nt, denied: dn, skip: [...skip] }));
      renameSync(o.cacheFile + ".tmp", o.cacheFile);
    } catch { /* the cache is a nicety */ }
  }

  /** Start a background scan unless one runs or the last one is fresh (force skips the freshness check). */
  function startScan(force = false): boolean {
    if (scan.state === "scanning") return false;
    if (!force && scan.finished && Date.now() - scan.finished * 1000 < SCAN_TTL && scan.groups.length) return false;
    Object.assign(scan, { state: "scanning", started: now() });
    doScan().catch((e) => Object.assign(scan, { state: "error", error: String(e), finished: now() }));
    return true;
  }

  // ----------------------------------------------------------------- drill
  const roots = [realpathSync(home), ...(ext && existsSyncL(ext) ? [realpathSync(ext)] : [])];

  async function drillScan(p: string) {
    const res = await duDepth(p, 1);
    const total = res.get(p) ?? null; res.delete(p);
    try { // du -d can't list plain files (-a and -d are exclusive on macOS) — add them from lstat
      for (const e of readdirSync(p, { withFileTypes: true })) if (!e.isDirectory()) { const fp = join(p, e.name); res.set(fp, lstatSync(fp).blocks * 512); }
    } catch { /* unreadable folder */ }
    const kids = [...res].map(([k, b]) => { let d = false; try { d = lstatSync(k).isDirectory(); } catch { /* gone */ } return { name: basename(k), path: k, bytes: b, dir: d }; });
    kids.sort((a, b) => b.bytes - a.bytes);
    drills.set(p, { state: "ready", ts: now(), total, children: kids.slice(0, 15), count: kids.length });
  }
  function drill(raw: string, force: boolean): Err | { body: unknown } {
    if (!raw) return fail(400, "path required");
    let p = resolve(raw.startsWith("~") ? home + raw.slice(1) : raw);
    try { p = realpathSync(p); } catch { /* missing: the checks below say so */ }
    if (!within(p, roots)) return fail(403, `only folders under your home${ext ? ` or ${ext}` : ""}`);
    try { if (!lstatSync(p).isDirectory()) return fail(404, "not a folder"); } catch { return fail(404, "not a folder"); }
    const d = drills.get(p);
    if (d && (d.state === "scanning" || (!force && now() - d.ts < DRILL_TTL / 1000))) return { body: { ...d, path: p } };
    drills.set(p, { state: "scanning", ts: now(), children: [], total: null });
    drillScan(p).catch(() => drills.set(p, { state: "ready", ts: now(), children: [], total: null, count: 0 }));
    return { body: { state: "scanning", path: p, children: [] } };
  }

  // ------------------------------------------------------------------- run
  async function runThread(a: Action, st: RunStatus, onDone?: (st: RunStatus) => void) {
    const before = freeBytes(a.vol);
    try {
      const rc = (await a.fn((m) => st.log.push(m))) || 0;
      await sleep(o.settleMs); // let APFS settle before measuring
      const after = freeBytes(a.vol);
      Object.assign(st, { state: rc === 0 ? "done" : "failed", freed: Math.max(0, (after ?? 0) - (before ?? 0)), finished: now(), rc });
    } catch (e) {
      st.log.push("error: " + String(e));
      Object.assign(st, { state: "failed", finished: now(), freed: 0 });
    } finally { running = false; }
    logLine(`${a.id} ${st.state} freed=${((st.freed ?? 0) / 1e9).toFixed(2)}GB on ${a.vol} :: ${st.log.join("; ")}`);
    scan.estimates[a.id] = st.state === "done" ? 0 : scan.estimates[a.id] ?? null; // estimates are stale now
    onDone?.(st);
  }
  /** Starts the cleanup in the background; onDone fires when it ends (the server audits there). */
  function runAction(id: string, confirm: boolean, onDone?: (st: RunStatus) => void, wait?: { done?: Promise<void> }): Err | { body: unknown } {
    const a = ABY.get(id);
    if (!a) return fail(404, "unknown action");
    if (!confirm) return fail(400, "confirm required");
    if (running) return fail(409, "another cleanup is running");
    running = true;
    const st: RunStatus = { state: "running", started: now(), log: [], freed: null };
    runs.set(id, st);
    const done = runThread(a, st, onDone);
    if (wait) wait.done = done; // tests await it
    return { body: { ok: true, id, state: "running" } };
  }

  // ------------------------------------------------------------------ API
  function payload() {
    startScan(); // no-op when fresh or already scanning
    const pick = { state: scan.state, started: scan.started, finished: scan.finished, duration: scan.duration, groups: scan.groups, error: scan.error, denied: scan.denied };
    const volumes = [vol(data, "Internal SSD"), ...(ext ? [vol(ext, extName)] : [])];
    const actions = ACTIONS.map((a) => ({ id: a.id, label: a.label, risk: a.risk, desc: a.desc, cmd: a.cmd, volume: a.vol === ext ? extName : "Internal",
      estimate: scan.estimates[a.id] ?? null, available: scan.avail[a.id] ?? true, note: scan.notes[a.id] ?? null, run: runs.get(a.id) ?? null }));
    return { volumes, scan: pick, actions, now: now() };
  }
  function rescan() { const started = startScan(true); drills.clear(); return { ok: true, started }; }

  return { payload, drill, rescan, runAction, actionIds: () => ACTIONS.map((a) => a.id), scanState: () => scan.state };
}

/** True when this machine can run the module: needs a POSIX `du`. */
export const storageAvailable = () => process.platform !== "win32" && !!Bun.which("du");

let singleton: ReturnType<typeof createStorage> | null = null;
/** The server's instance: roots and cache live under the Server OS home; macOS gets its extras. */
export function storage() {
  const mac = process.platform === "darwin";
  return singleton ??= createStorage({
    home: HOME, ext: config.externalDisk, data: mac ? "/System/Volumes/Data" : "/",
    cacheFile: join(dir("data"), "storage-cache.json"), logFile: join(dir("logs"), "storage-cleanup.log"),
    logDirs: config.storage?.logDirs?.map((d) => d.replace(/^~/, HOME)) ?? [dir("logs"), ...(mac ? [join(HOME, "Library/Logs")] : [])],
    platform: process.platform, run: sh, sudoPassword: ENV.SUDO_PASSWORD, settleMs: 1500,
  });
}
