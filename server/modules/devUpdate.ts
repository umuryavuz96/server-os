// Developer-mode update: a git checkout may fast-forward to origin when that cannot lose or overwrite anything.
// Pure of the server (only git is run) so update.ts, the tests and the detached helper's job file share one decision.
// Never forced: no stash, no reset of the user's work, untracked files are never touched.
import { spawnSync } from "node:child_process";

export interface DevState {
  ok: boolean;
  /** Why applying is off, in words for the panel. null when ok. */
  reason: string | null;
  branch?: string; upstream?: string; head?: string; target?: string; behind?: number;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Local-only check (no network): is this checkout safe to fast-forward to its upstream as of the last fetch? */
export function devState(repo: string): DevState {
  const br = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!br.ok || !br.out) return { ok: false, reason: "The checkout is on a detached HEAD. Check out a branch that tracks origin first." };
  const branch = br.out;
  const remote = git(repo, ["config", `branch.${branch}.remote`]).out;
  const up = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok || !up.out || remote !== "origin") return { ok: false, branch, reason: `Branch ${branch} doesn't track origin, so there is nothing to update from. Set it with: git branch -u origin/${branch}` };
  const upstream = up.out;
  const head = git(repo, ["rev-parse", "HEAD"]).out, target = git(repo, ["rev-parse", "@{u}"]).out;
  const base = { branch, upstream, head, target };
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]).out.split("\n").filter(Boolean).length;
  if (dirty) return { ok: false, ...base, reason: `Local changes in ${plural(dirty, "file")}: commit or stash them first.` };
  const ahead = Number(git(repo, ["rev-list", "--count", "@{u}..HEAD"]).out) || 0;
  if (ahead) return { ok: false, ...base, reason: `Your branch has ${plural(ahead, "commit")} that ${ahead === 1 ? "is" : "are"} not on GitHub. Push or rebase them first.` };
  const behind = Number(git(repo, ["rev-list", "--count", "HEAD..@{u}"]).out) || 0;
  if (!behind) return { ok: false, ...base, behind, reason: `${upstream} has no new commits yet, so there is nothing to pull.` };
  return { ok: true, ...base, behind, reason: null };
}

/** Does the diff between two commits touch dependency manifests (so `bun install` is needed)? */
export function depsChanged(repo: string, from: string, to: string): boolean {
  const r = git(repo, ["diff", "--name-only", from, to, "--", "package.json", "bun.lock", "bun.lockb"]);
  return !r.ok || r.out.length > 0; // can't tell → install, which is harmless
}

/** Commands (argv lists, run in the repo) that put the checkout back on `prevSha`. Fast-forward only ever moved
 *  HEAD forward on a clean tree, so the hard reset can't discard user work; untracked files are untouched. */
export function rollbackSteps(prevSha: string, bun: string, installDeps: boolean): string[][] {
  return [["git", "reset", "--hard", prevSha], ...(installDeps ? [[bun, "install"]] : []), [bun, "run", "build"]];
}

/** The rollback decision: healthy → keep; otherwise roll back whenever we know a previous commit. */
export function needsRollback(healthy: boolean, prevSha: string | undefined): boolean { return !healthy && !!prevSha; }
