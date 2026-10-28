// Self-updater: checks GitHub releases, and on a release install (<home>/versions/<tag> + <home>/current, see
// install/install.sh) downloads a new version, verifies its Ed25519-signed SHA256SUMS, unpacks it next to the
// running one, switches the `current` link and restarts through the service manager. server/updateHelper.ts
// (detached) waits for /api/v1/health and switches back if the new version doesn't come up.
// User data (config/, data/, logs/, apps/ …) lives in <home>, never in a version folder; migrations are the
// CREATE … IF NOT EXISTS schemas every module registers, run when the database opens on start.
// Git checkouts, Homebrew and Docker installs can check but never apply. State: <home>/data/update.json.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ROOT, VERSION, dir } from "../core/config";
import { audit, logEvent, type Trace } from "../core/logger";
import { setSlice } from "../store";
import { nextRun } from "../ops";
import { bundleName, compareSemver, detectInstallMode, modeBlock, pickRelease, SIG, SUMS, verifyBundle, type Channel, type GhRelease, type InstallMode, type Release } from "./release";
import type { UpdateJob } from "../updateHelper";

export type AutoMode = "off" | "notify" | "nightly";
export interface UpdateSettings { channel: Channel; auto: AutoMode }
export interface Outcome { ok: boolean; from: string; to: string; at: number; reason?: string; rolledBack?: boolean; rollbackError?: string }
type Phase = "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed";
interface Persisted {
  settings: UpdateSettings;
  check?: { at: number; etag?: string; releases: GhRelease[]; error?: string | null };
  backoffUntil?: number;
  last?: Outcome | null;
}

const REPO = process.env.SERVER_OS_REPO ?? "umuryavuz96/server-os";
/** Test-only: a server that answers /releases (GitHub API shape) and /download/<tag>/<file>. Signatures are still checked. */
const BASE = process.env.SERVER_OS_UPDATE_BASE?.replace(/\/$/, "");
const API_URL = BASE ? `${BASE}/releases` : `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const downloadUrl = (tag: string, file: string) => BASE ? `${BASE}/download/${tag}/${file}` : `https://github.com/${REPO}/releases/download/${tag}/${file}`;
const PORT = Number(process.env.PORT ?? 3094);
const HEALTH_HOST = !process.env.HOST || process.env.HOST === "0.0.0.0" || process.env.HOST === "::" ? "127.0.0.1" : process.env.HOST;
const DAY = 86_400_000, NIGHTLY = "30 3 * * *";
const SOURCE = resolve(import.meta.dir, "../..");
const STATE = () => join(dir("data"), "update.json");
const RESULT = () => join(dir("data"), "update-result.json");
const JOB = () => join(dir("data"), "update-job.json");

// ---------- persisted state ----------
const DEFAULTS: UpdateSettings = { channel: "stable", auto: "notify" };
let saved: Persisted = load();
function load(): Persisted {
  try {
    const p = JSON.parse(readFileSync(STATE(), "utf8")) as Persisted;
    return { ...p, settings: { ...DEFAULTS, ...(p.settings ?? {}) } };
  } catch { return { settings: { ...DEFAULTS } }; }
}
function save() {
  try {
    mkdirSync(dir("data"), { recursive: true });
    writeFileSync(`${STATE()}.tmp`, JSON.stringify(saved, null, 2));
    renameSync(`${STATE()}.tmp`, STATE());
  } catch (e) { logEvent("warn", `update state not saved: ${String(e)}`); }
}

// ---------- install + service ----------
export const installMode = (): InstallMode => detectInstallMode(SOURCE, ROOT);

/** How to restart this server: launchd sets XPC_SERVICE_NAME to the job label, systemd puts us in <unit>.service.
 *  SERVER_OS_SERVICE=launchd:<label> | systemd:<unit> overrides. null = not run by a service manager. */
export function serviceManager(env = process.env): { kind: "launchd" | "systemd"; name: string } | null {
  const o = env.SERVER_OS_SERVICE?.match(/^(launchd|systemd):(.+)$/);
  if (o) return { kind: o[1] as "launchd" | "systemd", name: o[2] };
  if (process.platform === "darwin" && env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0" && !env.XPC_SERVICE_NAME.startsWith("application.")) return { kind: "launchd", name: env.XPC_SERVICE_NAME };
  if (process.platform === "linux" && env.INVOCATION_ID) {
    try {
      const unit = readFileSync("/proc/self/cgroup", "utf8").match(/\/([^/\n]+\.service)\s*$/m)?.[1];
      if (unit) return { kind: "systemd", name: unit };
    } catch { /* no cgroup info */ }
  }
  return null;
}
const restartCmd = (s: NonNullable<ReturnType<typeof serviceManager>>) =>
  s.kind === "launchd" ? ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${s.name}`] : ["systemctl", "--user", "restart", s.name];

// ---------- status ----------
let phase: Phase = "idle", detail = "", error: string | null = null, busy = false;
let nextAutoAt = nextRun(NIGHTLY);

export function updateStatus() {
  const mode = installMode(), svc = serviceManager();
  const latest = saved.check ? pickRelease(saved.check.releases, saved.settings.channel) : null;
  const newer = !!latest && compareSemver(latest.tag, VERSION) === 1;
  const block = modeBlock(mode) ?? (svc ? null : "Server OS isn't running as a service (launchd / systemd), so it can't restart itself. Install it with install/install.sh.")
    ?? (latest && newer && !latest.signed ? `Release ${latest.tag} isn't signed; it can't be installed automatically.` : null);
  const finishing = existsSync(JOB());
  return {
    current: VERSION, mode, service: svc ? `${svc.kind}:${svc.name}` : null,
    latest: latest as Release | null, updateAvailable: newer, canApply: newer && !block && !busy && !finishing, blocked: block,
    checkedAt: saved.check?.at ?? null, checkError: saved.check?.error ?? null,
    state: finishing && phase === "idle" ? "restarting" as Phase : phase, detail: finishing && phase === "idle" ? "Waiting for the new version to answer" : detail, error,
    last: saved.last ?? null, settings: saved.settings,
    nextAutoAt: saved.settings.auto === "nightly" && nextAutoAt ? nextAutoAt * 1000 : null,
  };
}
export type UpdateStatus = ReturnType<typeof updateStatus>;
const push = () => setSlice("update", updateStatus());
const step = (p: Phase, d = "") => { phase = p; detail = d; push(); };

// ---------- check ----------
let lastManual = 0;
/** Ask GitHub for releases (conditional on the ETag, so an unchanged list costs no rate limit). */
export async function checkForUpdate(o: { manual?: boolean } = {}): Promise<UpdateStatus> {
  const now = Date.now();
  if (saved.backoffUntil && now < saved.backoffUntil) return updateStatus();
  if (o.manual && now - lastManual < 30_000) return updateStatus(); // a double click is one request
  if (o.manual) lastManual = now;
  if (busy) return updateStatus();
  const was = phase; if (was === "idle" || was === "failed") step("checking");
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": `server-os/${VERSION}`, "X-GitHub-Api-Version": "2022-11-28" };
    if (saved.check?.etag) headers["If-None-Match"] = saved.check.etag;
    const r = await fetch(API_URL, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.status === 304 && saved.check) saved.check = { ...saved.check, at: now, error: null };
    else if (r.ok) {
      const list = ((await r.json()) as GhRelease[]).slice(0, 30)
        .map(({ tag_name, name, body, draft, prerelease, published_at, html_url, assets }) => ({ tag_name, name, body: String(body ?? "").slice(0, 20_000), draft, prerelease, published_at, html_url, assets: (assets ?? []).map((a) => ({ name: a.name, size: a.size })) }));
      saved.check = { at: now, etag: r.headers.get("etag") ?? undefined, releases: list, error: null };
    } else if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000, retry = Number(r.headers.get("retry-after")) * 1000;
      saved.backoffUntil = reset > now ? reset : now + (retry > 0 ? retry : 3_600_000);
      saved.check = { releases: [], ...saved.check, at: saved.check?.at ?? 0, error: `GitHub rate limit; trying again ${new Date(saved.backoffUntil).toLocaleTimeString()}` };
    } else saved.check = { releases: [], ...saved.check, at: saved.check?.at ?? 0, error: `GitHub answered HTTP ${r.status}` };
  } catch (e) {
    saved.check = { releases: [], ...saved.check, at: saved.check?.at ?? 0, error: `Couldn't reach GitHub: ${(e as Error).message}` };
  }
  save();
  if (phase === "checking") step(was === "failed" ? "failed" : "idle", was === "failed" ? detail : "");
  else push();
  return updateStatus();
}

// ---------- apply ----------
async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { "User-Agent": `server-os/${VERSION}` }, redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`download ${basename(new URL(url).pathname)}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function sh(cmd: string[], cwd: string, timeoutMs: number): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(t);
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 2).join(" ")} failed: ${(err || out).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
}
function relink(target: string) {
  const tmp = join(ROOT, `current.${process.pid}.tmp`);
  try { unlinkSync(tmp); } catch { /* none */ }
  symlinkSync(join("versions", basename(target)), tmp);
  renameSync(tmp, join(ROOT, "current")); // rename over the old link: atomic, never a moment without `current`
}

/** Start an update to the latest release. Returns at once; progress is pushed as the `update` slice. */
export function applyUpdate(actor: string, trace?: Trace): { ok: true; to: string } | { ok: false; error: string } {
  const s = updateStatus();
  if (busy || s.state === "restarting") return { ok: false, error: "An update is already running" };
  if (!s.latest || !s.updateAvailable) return { ok: false, error: "Server OS is up to date" };
  if (s.blocked) return { ok: false, error: s.blocked };
  const svc = serviceManager()!, rel = s.latest, tag = rel.tag;
  busy = true; error = null;
  audit(actor, "update.apply", `${VERSION}→${tag}`, "ok", trace);
  void (async () => {
    const versions = join(ROOT, "versions"), staging = join(versions, `.staging-${tag}-${Date.now()}`);
    try {
      const fromDir = realpathSync(SOURCE), toDir = join(versions, tag);
      if (resolve(fromDir) === resolve(toDir)) throw new Error(`${tag} is already the running folder`);
      mkdirSync(join(staging, "tree"), { recursive: true });
      step("downloading", `Downloading ${tag}`);
      const name = bundleName(tag);
      const [bundle, sums, sig] = await Promise.all([download(downloadUrl(tag, name)), download(downloadUrl(tag, SUMS)), download(downloadUrl(tag, SIG))]);
      step("verifying", "Checking the signature and checksum");
      const bad = verifyBundle({ bundle, sums, sig }, name);
      if (bad) throw new Error(`Refused: ${bad}`);
      writeFileSync(join(staging, name), bundle);
      step("installing", `Unpacking ${tag}`);
      await sh(["tar", "-xzf", join(staging, name), "-C", join(staging, "tree")], staging, 120_000);
      const tree = join(staging, "tree");
      if (!existsSync(join(tree, "server", "index.ts"))) throw new Error("The bundle has no server/index.ts");
      const v = (JSON.parse(readFileSync(join(tree, "package.json"), "utf8")) as { version?: string }).version;
      if (v !== rel.version) throw new Error(`The bundle says it is ${v}, expected ${rel.version}`);
      step("installing", "Installing dependencies");
      await sh([process.execPath, "install", "--production", "--frozen-lockfile"], tree, 600_000);
      rmSync(toDir, { recursive: true, force: true });
      renameSync(tree, toDir);
      rmSync(staging, { recursive: true, force: true });
      const job: UpdateJob = { home: ROOT, from: VERSION, to: rel.version, fromDir, toDir, health: `http://${HEALTH_HOST}:${PORT}/api/v1/health`,
        timeoutMs: Number(process.env.SERVER_OS_UPDATE_TIMEOUT_MS) || 45_000, restart: restartCmd(svc), startedAt: Date.now() };
      writeFileSync(JOB(), JSON.stringify(job, null, 2));
      relink(toDir);
      step("restarting", `Restarting into ${tag}`);
      logEvent("info", `update ${VERSION} → ${tag}: switching`, { from: VERSION, to: tag, service: `${svc.kind}:${svc.name}` }, trace);
      // The helper outlives us: its own session under launchd, its own transient unit under systemd (a restart kills the service's whole cgroup).
      const helper = [process.execPath, join(fromDir, "server", "updateHelper.ts"), JOB()];
      const argv = svc.kind === "systemd" ? ["systemd-run", "--user", "--collect", "--quiet", `--unit=server-os-update-${Date.now()}`, ...helper] : helper;
      spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", cwd: ROOT }).unref();
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      error = (e as Error).message;
      audit(actor, "update.result", `${VERSION}→${tag}`, "failed", trace, { reason: error, stage: phase });
      saved.last = { ok: false, from: VERSION, to: rel.version, at: Date.now(), reason: error, rolledBack: false };
      save();
      busy = false;
      step("failed", error);
    }
  })();
  return { ok: true, to: tag };
}

/** What the helper wrote after the restart: shown on the panel and audited once, by whichever version is running. */
function consumeResult() {
  if (!existsSync(RESULT())) return;
  try {
    const r = JSON.parse(readFileSync(RESULT(), "utf8")) as Outcome;
    unlinkSync(RESULT());
    saved.last = r; save();
    audit("updater", "update.result", `${r.from}→${r.to}`, r.ok ? "ok" : "failed", undefined, r.ok ? {} : { reason: r.reason, rolledBack: r.rolledBack });
    push();
  } catch (e) { logEvent("warn", `update result unreadable: ${String(e)}`); }
}

export function saveSettings(b: Record<string, unknown>, actor: string, trace?: Trace): UpdateSettings | string {
  const channel = b.channel ?? saved.settings.channel, auto = b.auto ?? saved.settings.auto;
  if (channel !== "stable" && channel !== "beta") return "channel must be stable or beta";
  if (!["off", "notify", "nightly"].includes(String(auto))) return "auto must be off, notify or nightly";
  const changedChannel = channel !== saved.settings.channel;
  saved.settings = { channel, auto: auto as AutoMode };
  save();
  audit(actor, "update.settings", "", "ok", trace, { ...saved.settings });
  push();
  if (changedChannel || !saved.check) void checkForUpdate();
  return saved.settings;
}

/** Daily check (unless auto is off), nightly apply at 03:30 local when auto is nightly, outcomes from the helper. */
export function startUpdater() {
  // A stale job file (the helper died, or the machine rebooted mid-update) would block updates forever.
  try { if (existsSync(JOB()) && Date.now() - lstatSync(JOB()).mtimeMs > 10 * 60_000) unlinkSync(JOB()); } catch { /* ignore */ }
  consumeResult();
  push();
  setInterval(consumeResult, 5_000);
  const tick = async () => {
    const st = saved.settings;
    if (st.auto !== "off" && Date.now() - (saved.check?.at ?? 0) > DAY) await checkForUpdate();
    if (nextAutoAt && Date.now() / 1000 >= nextAutoAt) {
      nextAutoAt = nextRun(NIGHTLY);
      const s = updateStatus();
      const failedBefore = saved.last && !saved.last.ok && saved.last.to === s.latest?.version; // don't retry a failed version every night
      if (st.auto === "nightly" && s.canApply && !failedBefore) applyUpdate("updater");
      push();
    }
  };
  setTimeout(() => void tick(), 15_000); // after start-up, so a fresh boot isn't slowed by it
  setInterval(() => void tick(), 60_000);
}
