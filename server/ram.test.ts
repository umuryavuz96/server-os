import { expect, test } from "bun:test";
import { buildRam, groupName, parseEtime, parseSwap, parseVmStat, resetRing, trackMovers, type RamInput, type RamOverview } from "./ram";

const ov: RamOverview = { totalMB: 16384, usedMB: 9000, pressure: "normal", swapUsedMB: 0, swapTotalMB: 0, compressedMB: 0, wiredMB: 3000, appMB: 0, cachedMB: 0, freeMB: 0 };

test("parseVmStat uses the page size and Activity Monitor formulas inputs", () => {
  const c = parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                    100.\nPages wired down:                             10.\nAnonymous pages:  50.\nPages purgeable: 5.\nFile-backed pages: 20.\nPages occupied by compressor: 7.\nPages speculative: 1.\n")!;
  expect(c.wired).toBe(163840);
  expect(c.anonymous).toBe(50 * 16384);
  expect(parseVmStat("garbage")).toBeNull();
});
test("parseSwap and parseEtime", () => {
  expect(parseSwap("total = 6144.00M  used = 5221.88M  free = 922.12M  (encrypted)")).toEqual({ totalMB: 6144, usedMB: 5222 });
  expect(parseEtime("1-02:03:04")).toBe(93784);
  expect(parseEtime("03:04")).toBe(184);
  expect(parseEtime("02:03:04")).toBe(7384);
});
test("groupName never leaks arguments", () => {
  expect(groupName("npm exec foo --api-key SECRET")).toBe("npm");
  expect(groupName("/Applications/Foo.app/Contents/MacOS/Foo")).toBe("Foo");
});

const base = (): RamInput => ({
  rss: new Map([[1, 1024 * 500], [2, 1024 * 100], [3, 1024 * 200], [4, 1024 * 50], [5, 1024 * 80]]),
  kids: new Map([[1, [2]]]), comms: new Map([[1, "/x/claude"], [2, "/bin/bun run secret"], [3, "/x/node"], [4, "/x/node"], [5, "/x/panelproc"]]),
  etimes: new Map([[3, 60]]), claimed: new Set([5]), vmMem: new Map([["HomeAssistant", 2100]]), dockerVm: { pid: 9, mb: 1000 },
  containerMem: new Map([["a", 300], ["b", 100]]), containerApp: new Map([["a", "App A"]]),
  apps: [{ name: "P", group: "g", mem: 80, memSrc: "process", state: "on" }, { name: "D", group: "g", mem: 300, memSrc: "docker", state: "on" }],
  sessions: [{ pid: 1, sessionId: "s", cwd: "/Users/x/proj", name: "bot-main", status: "busy", startedAt: 1, tmux: null }], agentByPid: new Map([[1, "t/a"]]), nowSec: 1000,
});
test("buildRam: claude tree, grouping, vms, no double counting", () => {
  resetRing();
  const { slice, full } = buildRam(base(), ov, new Map([["HomeAssistant", 2048]]));
  expect(slice.claude).toEqual([expect.objectContaining({ pid: 1, name: "bot-main", agent: "t/a", mb: 600, n: 2 })]);
  expect(full).toHaveLength(1); // pids 3+4 -> "node"; 5 claimed
  expect(full[0]).toMatchObject({ name: "node", mb: 250, n: 2 });
  expect(full[0].procs[0]).toMatchObject({ pid: 3, upSec: 60 });
  const d = slice.vms.find((v) => v.kind === "docker")!;
  expect(d.items[0]).toEqual({ name: "a", mb: 300, app: "App A" });
  expect(d.overheadMB).toBe(600);
  expect(slice.vms.every((v) => v.running)).toBe(true); // rows exist only for VMs with a live host footprint
  expect(slice.vms.find((v) => v.name === "HomeAssistant")!.configuredMB).toBe(2048);
  // docker-measured app is inside the VM footprint, only the process app counts
  expect(slice.breakdown.find((b) => b.key === "apps")!.mb).toBe(80);
  expect(JSON.stringify(slice)).not.toContain("secret");
});
test("trackMovers: grows, new, gone over a span", () => {
  resetRing();
  trackMovers([{ kind: "process", name: "a", mb: 100 }, { kind: "process", name: "b", mb: 500 }], 0);
  const r = trackMovers([{ kind: "process", name: "a", mb: 400 }, { kind: "process", name: "c", mb: 200 }], 600);
  expect(r.spanMin).toBe(10);
  expect(r.up.map((m) => [m.name, m.deltaMB, m.isNew])).toEqual([["a", 300, false], ["c", 200, true]]);
  expect(r.down.map((m) => [m.name, m.gone])).toEqual([["b", true]]);
});
test("noteBundles maps group names to outer .app path only", async () => {
  const { noteBundles, iconOk } = await import("./ram");
  noteBundles(new Map([[1, "/Applications/Foo.app/Contents/Frameworks/Bar.app/Contents/MacOS/x"], [2, "/usr/bin/plain"]]));
  expect(iconOk("Foo")).toBe(false);
});
test("trackMovers: nothing sampled or reported during warm-up", () => {
  resetRing();
  const a = trackMovers([{ kind: "vm", name: "Docker", mb: 0 }], 0, 60);
  expect(a).toEqual({ spanMin: 0, up: [], down: [] });
  trackMovers([{ kind: "vm", name: "Docker", mb: 5000 }], 61, 60); // first real sample already has Docker
  const r = trackMovers([{ kind: "vm", name: "Docker", mb: 5010 }], 300, 60);
  expect(r.up).toEqual([]);
});

test("buildRam: bare runtimes are named after the app they belong to", () => {
  resetRing();
  const inp = base();
  // pid 3 (node) is a launchd job root, pid 4 (node) its child; pid 5 is claimed
  inp.kids = new Map([[1, [2]], [3, [4]]]);
  inp.resolve = { launchd: new Map([["com.example.server-dash", 3]]), portPid: new Map(), caddyTarget: new Map(), catalog: [], iconDir: "/nonexistent" };
  const { full } = buildRam(inp, ov, new Map());
  expect(full).toHaveLength(1);
  expect(full[0]).toMatchObject({ name: "Server OS", app: true, src: "/app-icons/icon.svg", bins: ["node"], n: 2 });
  expect(full[0].procs[0].bin).toBe("node");
});

test("buildRam list: one row per thing, bundles expand, nothing counted twice", () => {
  resetRing();
  const inp = base();
  inp.comms.set(6, "/usr/libexec/syspolicyd"); inp.rss.set(6, 1024 * 40);
  inp.claimBy = new Map([[5, "P"]]);
  inp.comms.set(7, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"); inp.rss.set(7, 1024 * 30);
  const { slice } = buildRam(inp, ov, new Map());
  const dk = slice.list.find((r) => r.kind === "docker")!;
  expect(dk.mb).toBe(1030); expect(dk.kids.find((k) => k.key === "h:Docker")!.name).toBe("Docker Desktop");
  expect(slice.list.some((r) => r.key === "g:Docker")).toBe(false);
  const keys = slice.list.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
  const docker = slice.list.find((r) => r.kind === "docker")!;
  expect(docker.kids.map((k) => [k.name, k.mb]).sort((a, b) => +b[1] - +a[1])).toEqual([["Docker VM itself", 600], ["App A", 300], ["b", 100], ["Docker Desktop", 30]]);
  // docker-measured panel app D has no row of its own (it is inside Docker)
  expect(slice.list.some((r) => r.name === "D")).toBe(false);
  const p = slice.list.find((r) => r.key === "panel:P")!;
  expect(p).toMatchObject({ mb: 80, sub: "1 process", href: "#apps?open=P", kids: [] }); // one process: a link, nothing to open
  const cl = slice.list.find((r) => r.kind === "claude")!;
  expect(cl.mb).toBe(600); expect(cl.kids[0].name).toBe("bot-main");
  const mac = slice.list.find((r) => r.kind === "macos")!;
  expect(mac.mb).toBe(3000 + 40);
  expect(mac.kids.map((k) => k.name)).toEqual(["Wired memory", "syspolicyd"]);
  expect(slice.list.some((r) => r.key === "g:syspolicyd")).toBe(false);
  expect(slice.list.find((r) => r.key === "g:node")!.kids).toHaveLength(2);
  expect(slice.list.map((r) => r.mb)).toEqual([...slice.list.map((r) => r.mb)].sort((a, b) => b - a));
  expect(JSON.stringify(slice.list)).not.toContain("secret");
});

test("simulator processes are one group, program names keep no arguments", async () => {
  const { binName } = await import("./ram");
  const sim = "/private/var/run/x/Runtimes/iOS 27.1.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/logd";
  expect(groupName(sim)).toBe("iOS Simulator");
  expect(binName(sim)).toBe("logd");
  expect(binName("npm exec foo --api-key SECRET")).toBe("npm");
  expect(binName("(bash)")).toBe("bash");
});

test("parseTopMem reads top's MEM column, withFootprint keeps RSS for pids top has not seen", async () => {
  const { parseTopMem, withFootprint } = await import("./ram");
  const m = parseTopMem("PID    MEM\n1      25M\n174    643M+\n99534  7472K\n7      1.5G-\n8      512B\nnoise\n");
  expect([...m]).toEqual([[1, 25600], [174, 658432], [99534, 7472], [7, 1572864], [8, 0.5]]);
  expect([...withFootprint(new Map([[1, 99], [2, 50], [3, 0]]), m)]).toEqual([[1, 25600], [2, 50], [3, 0]]);
});
