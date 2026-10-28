import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage, parseDu, parseSize } from "./storage";

// Everything runs in a temp tree with a fake `du` and stubbed commands: no real cleanup, no real scan.
let root: string, home: string;
const calls: string[][] = [];
let gate: Promise<void> | null = null;
const fakeRun = async (cmd: string[]) => {
  calls.push(cmd);
  if (cmd[0] === "du") {
    const p = cmd[cmd.length - 1];
    if (!existsSync(p)) return { code: 1, out: `du: ${p}: No such file or directory` };
    const kids = readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `8\t${join(p, e.name)}`);
    const blocked = `du: ${home}/Documents/x: Operation not permitted`;
    return { code: 0, out: cmd[1] === "-skx" ? `2048\t${p}\n${blocked}` : [...kids, `${8 * kids.length + 4}\t${p}`, blocked].join("\n") };
  }
  if (cmd[0] === "docker" && gate) await gate;
  return { code: cmd[0] === "docker" ? 0 : 1, out: cmd[0] === "docker" ? "ok" : "" };
};
const make = () => createStorage({ home, data: root, cacheFile: join(root, "data/storage-cache.json"), logFile: join(root, "logs/storage-cleanup.log"),
  logDirs: [join(root, "oldlogs")], platform: "linux", run: fakeRun, settleMs: 0 });
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(10); };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "storage-test-")));
  home = join(root, "home");
  mkdirSync(join(home, "projects/app"), { recursive: true });
  writeFileSync(join(home, "projects/notes.txt"), "x".repeat(20000));
  mkdirSync(join(root, "oldlogs"), { recursive: true });
  mkdirSync(join(home, ".local/share/Trash/files"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("storage parsing", () => {
  test("parseSize understands docker's units", () => {
    expect(parseSize("1.5GB")).toBe(1.5e9);
    expect(parseSize("12kB")).toBe(12e3);
    expect(parseSize("0B")).toBe(0);
    expect(parseSize(undefined)).toBe(0);
  });
  test("parseDu: sizes in bytes; privacy blocks listed, plain permission errors ignored", () => {
    const r = parseDu("4\t/a/b\n8\t/a\ndu: /Users/u/Documents: Operation not permitted\ndu: /private/x: Permission denied");
    expect([...r.sizes]).toEqual([["/a/b", 4096], ["/a", 8192]]);
    expect(r.denied).toEqual(["/Users/u/Documents"]);
  });
});

describe("storage module", () => {
  test("first payload starts a scan; shapes match the Python service; cache is written", async () => {
    const s = make();
    const first = s.payload();
    expect(Object.keys(first)).toEqual(["volumes", "scan", "actions", "now"]);
    expect(first.scan.state).toBe("scanning");
    expect(Object.keys(first.scan)).toEqual(["state", "started", "finished", "duration", "groups", "error", "denied"]);
    expect(Object.keys(first.actions[0])).toEqual(["id", "label", "risk", "desc", "cmd", "volume", "estimate", "available", "note", "run"]);
    expect(Object.keys(first.volumes[0])).toEqual(["label", "path", "total", "used", "free", "pct"]);
    await until(() => s.scanState() === "ready");
    const p = s.payload();
    expect(p.scan.groups.map((g) => g.id)).toEqual(["home", "library", "notable", "outside", "system", "docker"]);
    expect(p.scan.groups[0].items.length).toBe(0); // fake du reports 2 MB per folder: under the 100 MB cut-off
    expect(p.scan.denied).toEqual([join(home, "Documents/x")]);
    expect(JSON.parse(readFileSync(join(root, "data/storage-cache.json"), "utf8")).groups.length).toBe(6);
    expect(make().payload().scan.state).toBe("ready"); // a fresh instance reads the cache: the page is instant
  });
  test("a folder the OS blocked once is not walked again, but still listed as not scanned", async () => {
    expect(JSON.parse(readFileSync(join(root, "data/storage-cache.json"), "utf8")).skip).toEqual([join(home, "Documents/x")]);
    const s = make();
    calls.length = 0;
    expect(s.rescan().started).toBe(true);
    await until(() => s.scanState() === "ready");
    const du = calls.filter((c) => c[0] === "du");
    expect(du.length).toBeGreaterThan(0);
    expect(du.every((c) => c.includes("--exclude=x"))).toBe(true);
    expect(s.payload().scan.denied).toContain(join(home, "Documents/x"));
  });
  test("linux has no macOS-only cleanups", () => {
    expect(make().payload().actions.map((a) => a.id)).toEqual(["logs", "brew", "devcache", "docker", "docker_unused", "trash"]);
  });
  test("drill: guards, async scan, plain files included, top children sorted", async () => {
    const s = make();
    expect(s.drill("", false)).toEqual({ err: { status: 400, detail: "path required" } });
    expect(s.drill("/etc", false)).toMatchObject({ err: { status: 403 } });
    expect(s.drill(join(home, "projects/notes.txt"), false)).toMatchObject({ err: { status: 404 } });
    expect(s.drill(join(home, "nope"), false)).toMatchObject({ err: { status: 404 } });
    const dir = join(home, "projects");
    expect(s.drill(dir, false)).toEqual({ body: { state: "scanning", path: dir, children: [] } });
    await until(() => (s.drill(dir, false) as { body: { state: string } }).body.state === "ready");
    const r = (s.drill(dir, false) as { body: { children: { name: string; dir: boolean; bytes: number }[]; total: number; path: string; count: number } }).body;
    expect(r.total).toBe(12 * 1024);
    expect(r.count).toBe(2);
    expect(r.children.map((c) => [c.name, c.dir])).toEqual([["notes.txt", false], ["app", true]]);
    expect(r.children[0].bytes).toBeGreaterThanOrEqual(20000); // st_blocks × 512
  });
  test("run: needs a known id and confirm; only one cleanup at a time; logs; trash and logs cleanups touch only their folders", async () => {
    const s = make();
    expect(s.runAction("rm-rf", true)).toMatchObject({ err: { status: 404 } });
    expect(s.runAction("trash", false)).toMatchObject({ err: { status: 400 } });
    // old log is removed, a fresh one and a non-log file stay
    const old = join(root, "oldlogs/old.log"), fresh = join(root, "oldlogs/new.log"), other = join(root, "oldlogs/keep.txt");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const t = Date.now() / 1000 - 40 * 86400;
    utimesSync(old, t, t); utimesSync(other, t, t);
    writeFileSync(join(home, ".local/share/Trash/files/junk"), "x");
    const w: { done?: Promise<void> } = {};
    const done: string[] = [];
    expect(s.runAction("logs", true, (st) => done.push(st.state), w)).toEqual({ body: { ok: true, id: "logs", state: "running" } });
    expect(s.runAction("trash", true)).toMatchObject({ err: { status: 409 } });
    await w.done;
    expect(done).toEqual(["done"]);
    expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
    const run = s.payload().actions.find((a) => a.id === "logs")!.run!;
    expect(run).toMatchObject({ state: "done", rc: 0 });
    expect(run.log[0]).toMatch(/^deleted 1 log file\(s\) older than 30 days/);
    const w2: { done?: Promise<void> } = {};
    s.runAction("trash", true, undefined, w2);
    await w2.done;
    expect(readdirSync(join(home, ".local/share/Trash/files"))).toEqual([]);
    expect(readFileSync(join(root, "logs/storage-cleanup.log"), "utf8")).toMatch(/logs done freed=.*GB on .* :: deleted 1 log file/);
  });
  test("a failing command marks the run failed; stubbed docker never touches real docker", async () => {
    const s = make();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const w: { done?: Promise<void> } = {};
    s.runAction("docker", true, undefined, w);
    expect(s.payload().actions.find((a) => a.id === "docker")!.run!.state).toBe("running");
    release(); await w.done; gate = null;
    expect(s.payload().actions.find((a) => a.id === "docker")!.run!.state).toBe("done");
    const w2: { done?: Promise<void> } = {};
    s.runAction("brew", true, undefined, w2); // the stub exits 1 for brew
    await w2.done;
    expect(s.payload().actions.find((a) => a.id === "brew")!.run!.state).toBe("failed");
  });
});
