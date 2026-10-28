import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { depsChanged, devState, needsRollback, rollbackSteps } from "./devUpdate";

const run = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
/** origin (bare) + a clone on main with one commit. Returns both, plus a helper that pushes a commit to origin from a second clone. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "devupd-"));
  const origin = join(root, "origin.git"), work = join(root, "work");
  let n = 0;
  run(root, "init", "--bare", "-b", "main", origin);
  run(root, "clone", origin, work);
  writeFileSync(join(work, "a.txt"), "1");
  writeFileSync(join(work, "package.json"), '{"version":"1.0.0"}');
  run(work, "add", "."); run(work, ...id, "commit", "-m", "init"); run(work, "push", "-u", "origin", "HEAD:main");
  run(work, "branch", "-u", "origin/main");
  const pushNew = (file = "b.txt") => {
    const other = join(root, `other${n++}`);
    run(root, "clone", origin, other);
    writeFileSync(join(other, file), "x"); run(other, "add", "."); run(other, ...id, "commit", "-m", "more"); run(other, "push", "origin", "HEAD:main");
    run(work, "fetch", "origin");
  };
  return { work, origin, pushNew };
}

describe("devState preconditions", () => {
  test("ok: clean, not ahead, behind origin; untracked files are fine", () => {
    const { work, pushNew } = setup();
    pushNew();
    writeFileSync(join(work, "scratch.txt"), "untracked");
    const s = devState(work);
    expect(s.ok).toBe(true); expect(s.behind).toBe(1); expect(s.upstream).toBe("origin/main"); expect(s.reason).toBeNull();
  });
  test("nothing to pull", () => {
    const { work } = setup();
    const s = devState(work);
    expect(s.ok).toBe(false); expect(s.reason).toContain("no new commits");
  });
  test("dirty tracked files", () => {
    const { work, pushNew } = setup();
    pushNew(); writeFileSync(join(work, "a.txt"), "changed");
    const s = devState(work);
    expect(s.ok).toBe(false); expect(s.reason).toBe("Local changes in 1 file: commit or stash them first.");
  });
  test("ahead of origin", () => {
    const { work, pushNew } = setup();
    writeFileSync(join(work, "c.txt"), "c"); run(work, "add", "."); run(work, ...id, "commit", "-m", "local");
    pushNew("d.txt");
    const s = devState(work);
    expect(s.ok).toBe(false); expect(s.reason).toContain("1 commit that is not on GitHub");
  });
  test("no upstream", () => {
    const { work } = setup();
    run(work, "branch", "--unset-upstream");
    const s = devState(work);
    expect(s.ok).toBe(false); expect(s.reason).toContain("doesn't track origin");
  });
  test("detached HEAD", () => {
    const { work } = setup();
    run(work, "checkout", "--detach");
    expect(devState(work).reason).toContain("detached");
  });
  test("depsChanged follows the manifests only", () => {
    const { work, pushNew } = setup();
    const before = run(work, "rev-parse", "HEAD");
    pushNew();
    expect(depsChanged(work, before, "origin/main")).toBe(false);
    pushNew("e.txt");
    run(work, "merge", "--ff-only", "origin/main");
    writeFileSync(join(work, "package.json"), '{"version":"1.0.1"}'); run(work, "add", "."); run(work, ...id, "commit", "-m", "bump");
    expect(depsChanged(work, before, "HEAD")).toBe(true);
  });
});

describe("rollback decision", () => {
  test("only an unhealthy update with a known previous commit rolls back", () => {
    expect(needsRollback(true, "abc")).toBe(false);
    expect(needsRollback(false, "abc")).toBe(true);
    expect(needsRollback(false, undefined)).toBe(false);
  });
  test("steps: hard reset to the previous sha, optional install, always rebuild", () => {
    expect(rollbackSteps("abc", "bun", false)).toEqual([["git", "reset", "--hard", "abc"], ["bun", "run", "build"]]);
    expect(rollbackSteps("abc", "bun", true)).toEqual([["git", "reset", "--hard", "abc"], ["bun", "install"], ["bun", "run", "build"]]);
  });
});
