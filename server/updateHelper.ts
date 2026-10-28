#!/usr/bin/env bun
// Self-update finisher. server/modules/update.ts has already unpacked and verified the new version and pointed
// <home>/current at it; this runs detached from the server (its own session, or its own systemd unit) because the
// restart kills the server:
//   1. restart the service, 2. wait for /api/v1/health to report the new version,
//   3. if it doesn't within the timeout: point current back at the old version, restart, wait for it again,
//   4. write <home>/data/update-result.json (the server reads it, audits it and shows it), prune old versions.
// Usage: bun server/updateHelper.ts <job.json>   — imports nothing from the server, so a broken new version can't break it.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface UpdateJob {
  home: string; from: string; to: string; fromDir: string; toDir: string; health: string; timeoutMs: number;
  restart: string[]; startedAt: number;
  /** Developer-mode (git checkout) update: how to put the working tree back if the new commit doesn't come up. */
  git?: { repo: string; prevSha: string; rollback: string[][] };
}

const job = JSON.parse(readFileSync(process.argv[2], "utf8")) as UpdateJob;
const LOG = join(job.home, "logs", "update.log");
const say = (m: string) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* best effort */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Atomically point <home>/current at versions/<dir> (relative, so the home folder can move). */
function link(dir: string) {
  const tmp = join(job.home, `current.${process.pid}.tmp`);
  try { unlinkSync(tmp); } catch { /* none */ }
  symlinkSync(join("versions", basename(dir)), tmp);
  renameSync(tmp, join(job.home, "current"));
}

async function restart() {
  say(`restart: ${job.restart.join(" ")}`);
  const p = Bun.spawn(job.restart, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) say(`restart exited ${code}: ${(await new Response(p.stderr).text()).trim()}`);
}

/** Healthy = /api/v1/health answers ok with the expected version. Returns null, or the last reason it wasn't. */
async function waitHealthy(version: string): Promise<string | null> {
  const until = Date.now() + job.timeoutMs;
  let why = "no answer";
  await sleep(1500);
  while (Date.now() < until) {
    try {
      const r = await fetch(job.health, { signal: AbortSignal.timeout(3000) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; version?: string };
      if (r.ok && b.ok && b.version === version) return null;
      why = r.ok ? `still reports version ${b.version ?? "?"}` : `health answered HTTP ${r.status}`;
    } catch (e) { why = /refused|ECONNREFUSED|Unable to connect/i.test(String(e)) ? "the server is not answering" : String((e as Error).message ?? e); }
    await sleep(1000);
  }
  return `${version} was not healthy within ${Math.round(job.timeoutMs / 1000)} s (${why})`;
}

function result(r: Record<string, unknown>) {
  const f = join(job.home, "data", "update-result.json");
  writeFileSync(`${f}.tmp`, JSON.stringify({ from: job.from, to: job.to, at: Date.now(), ...r }, null, 2));
  renameSync(`${f}.tmp`, f);
}

/** Keep the running version and the one before it; drop every other version and any leftover staging folder. */
function prune(keep: string[]) {
  const vd = join(job.home, "versions"), names = new Set(keep.map((k) => basename(k)));
  for (const n of existsSync(vd) ? readdirSync(vd) : []) if (!names.has(n)) { say(`prune ${n}`); rmSync(join(vd, n), { recursive: true, force: true }); }
}

say(`update ${job.from} → ${job.to} (pid ${process.pid})`);
await sleep(1000); // let the server finish answering the apply request
await restart();
const bad = await waitHealthy(job.to);
if (!bad) {
  say(`ok: ${job.to} is healthy`);
  result({ ok: true });
  if (!job.git) prune([job.toDir, job.fromDir]);
} else {
  say(`failed: ${bad}; rolling back to ${job.from}`);
  if (job.git) {
    for (const cmd of job.git.rollback) {
      const p = Bun.spawn(cmd, { cwd: job.git.repo, stdout: "pipe", stderr: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV")) as Record<string, string> });
      if ((await p.exited) !== 0) say(`rollback step failed: ${cmd.join(" ")}: ${(await new Response(p.stderr).text()).trim().slice(-300)}`);
    }
  } else link(job.fromDir);
  await restart();
  const back = await waitHealthy(job.from);
  say(back ? `rollback did not come up: ${back}` : `rolled back: ${job.from} is healthy`);
  result({ ok: false, reason: bad, rolledBack: !back, ...(back ? { rollbackError: back } : {}) });
  if (!job.git) rmSync(job.toDir, { recursive: true, force: true });
}
try { unlinkSync(process.argv[2]); } catch { /* gone */ }
