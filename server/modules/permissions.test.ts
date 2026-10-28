import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME } from "../lib";
import { DEEP_LINKS, definitions, fixAttrs, fixPermission, targetsFor, isLan, lanTargets, listPermissions, missingRequired, probeFolders, probeFullDiskAccess, probeLocalNetwork, probeVolumes, protectedFolders, volumePaths } from "./permissions";
import type { Config } from "../core/config";

const cfg = (over: Partial<Config> = {}, integrations: Config["integrations"] = {}) =>
  ({ name: "t", auth: "off", logging: { level: "info", maxFileMB: 1 }, owner: { name: "t" }, apps: { agentSetup: false }, ...over, integrations }) as Config;
const def = (c: Config, id: string) => definitions(c).find((d) => d.id === id)!;

describe("what the config needs", () => {
  test("a bare config needs no required permission", () => {
    expect(definitions(cfg()).filter((d) => d.required)).toEqual([]);
    expect(def(cfg(), "removable-volumes").needed).toBe(false);
    expect(def(cfg(), "microphone").needed).toBe(false);
  });
  test("LAN integrations make Local Network required; public URLs do not", () => {
    expect(def(cfg({}, { homeAssistant: { url: "http://192.168.1.81:8123" } }), "local-network").required).toBe(true);
    expect(def(cfg({}, { adguard: { url: "http://adguard.home:3080" } }), "local-network").required).toBe(true);
    expect(def(cfg({}, { homeAssistant: { url: "https://ha.example.com" } }), "local-network").required).toBe(false);
    expect(lanTargets(cfg({}, { homeAssistant: { url: "http://10.0.0.5:8123" } }))).toEqual([{ host: "10.0.0.5", port: 8123 }]);
  });
  test("isLan", () => {
    for (const h of ["192.168.1.1", "10.1.2.3", "172.16.0.1", "172.31.9.9", "nas.local", "x.home"]) expect(isLan(h)).toBe(true);
    for (const h of ["172.32.0.1", "8.8.8.8", "example.com", "100.95.1.1"]) expect(isLan(h)).toBe(false);
  });
  test("external disk under /Volumes needs the volumes permission", () => {
    const c = cfg({ externalDisk: "/Volumes/ExternalSSD/data" });
    expect(volumePaths(c)).toEqual(["/Volumes/ExternalSSD"]);
    expect(def(c, "removable-volumes")).toMatchObject({ needed: true, required: true });
  });
  test("a config path in Documents needs Files & Folders", () => {
    const c = cfg({ storage: { logDirs: ["~/Documents/logs"] } });
    expect(protectedFolders(c)).toEqual([`${HOME}/Documents`]);
    expect(def(c, "files-folders").required).toBe(true);
    expect(def(cfg({ storage: { logDirs: ["~/Documentsx"] } }), "files-folders").needed).toBe(false);
  });
  test("house voice needs the microphone, granted to tmux", () => {
    const d = def(cfg({}, { houseVoice: { dir: "/opt/hv" } }), "microphone");
    expect(d.needed).toBe(true);
    expect(d.processes[0].path).toContain("tmux");
  });
  test("every id has a System Settings deep link", () => {
    for (const d of definitions(cfg())) expect(DEEP_LINKS[d.id as keyof typeof DEEP_LINKS]).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_\w+$/);
  });
  test("the bun process is named by its real path", () => {
    expect(def(cfg(), "full-disk-access").processes[0].path).toBe(require("node:fs").realpathSync(process.execPath));
  });
});

describe("probes", () => {
  test("full disk access: readable = granted, EPERM = missing, other = unknown", () => {
    const f = join(mkdtempSync(join(tmpdir(), "perm-")), "TCC.db");
    writeFileSync(f, "x");
    expect(probeFullDiskAccess([f]).status).toBe("granted");
    expect(probeFullDiskAccess([join(tmpdir(), "no-such-file-xyz")]).status).toBe("unknown");
  });
  test("local network maps connect results", async () => {
    const c = cfg({}, { homeAssistant: { url: "http://192.168.1.81:8123" } });
    const run = (r: "connected" | "refused" | "unreachable" | "timeout") => probeLocalNetwork(c, async () => null, async () => r);
    expect((await run("connected")).status).toBe("granted");
    expect((await run("refused")).status).toBe("granted");
    expect((await run("unreachable")).status).toBe("missing");
    expect((await run("timeout")).status).toBe("unknown");
  });
  test("local network falls back to the gateway, and is unknown without one", async () => {
    let seen = "";
    await probeLocalNetwork(cfg(), async () => "192.168.1.1", async (h) => { seen = h; return "connected"; });
    expect(seen).toBe("192.168.1.1");
    expect((await probeLocalNetwork(cfg(), async () => null, async () => "connected")).status).toBe("unknown");
  });
  test("volumes and folders: EPERM = missing", () => {
    const eperm = () => { throw Object.assign(new Error("x"), { code: "EPERM" }); };
    const enoent = () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); };
    expect(probeVolumes(["/Volumes/A"], eperm).status).toBe("missing");
    expect(probeVolumes(["/Volumes/A"], enoent).status).toBe("unknown");
    expect(probeVolumes(["/Volumes/A"], () => []).status).toBe("granted");
    expect(probeFolders([tmpdir()]).status).toBe("granted");
  });
});

describe("listPermissions", () => {
  test("empty on platforms with neither macOS nor Linux permissions", async () => { expect(await listPermissions({ platform: "win32" })).toEqual([]); });
  test("active probes stay unknown until asked; passive ones run", async () => {
    const c = cfg({}, { homeAssistant: { url: "http://192.168.1.81:8123" } });
    const l = await listPermissions({ platform: "darwin", cfg: c });
    const by = Object.fromEntries(l.map((p) => [p.id, p]));
    expect(by["local-network"].status).toBe("unknown");
    // The passive FDA probe opens real macOS files (TCC.db, ~/Library/Safari): on a real Mac it answers granted or missing,
    // on any other host (CI on Linux) those files do not exist, so it honestly stays unknown.
    expect(process.platform === "darwin" ? ["granted", "missing"] : ["unknown"]).toContain(by["full-disk-access"].status);
    expect(by["removable-volumes"].status).toBe("not-needed");
    expect(missingRequired(l)).toEqual([]); // unknown is never a banner
  });
  test("missingRequired only lists required + missing", () => {
    const p = (id: string, required: boolean, status: string) => ({ id, required, status }) as never;
    expect(missingRequired([p("a", true, "missing"), p("b", false, "missing"), p("c", true, "granted")]).map((x) => x.id as string)).toEqual(["a"]);
  });
});

// ---- Linux (mocked platform and system: nothing here touches the real machine) ----
import { externalMounts, linuxPermissions } from "./permissions";
import type { LinuxSys } from "./permissions";
import { dockerSocket } from "../docker";

const sys = (o: Partial<LinuxSys> & { denied?: string[]; missing?: string[]; files?: Record<string, string>; cmds?: Record<string, string> } = {}): LinuxSys => ({
  uid: 1000, user: "sam", env: {}, socket: "/var/run/docker.sock", which: () => null,
  exists: (p) => !(o.missing ?? []).includes(p),
  access: (p) => ((o.denied ?? []).includes(p) ? "denied" : (o.missing ?? []).includes(p) ? "missing" : "ok"),
  readdir: (p) => ((o.denied ?? []).includes(p) ? "denied" : (o.missing ?? []).includes(p) ? "missing" : "ok"),
  readFile: (p) => o.files?.[p] ?? null,
  run: async (cmd) => ({ code: 0, out: o.cmds?.[cmd.join(" ")] ?? "" }),
  ...o,
});
const byId = (l: Awaited<ReturnType<typeof linuxPermissions>>, id: string) => l.find((p) => p.id === id)!;

describe("Linux permissions", () => {
  test("lists only Linux needs, with copy commands and no Settings link", async () => {
    const l = await listPermissions({ platform: "linux", sys: sys() });
    expect(l.map((p) => p.id)).toEqual(["docker-access", "path-access", "linger", "firewall", "selinux"]);
    expect(l.every((p) => p.settingsUrl === "")).toBe(true);
  });
  test("docker socket: group missing -> copyable fix; root and missing socket handled", async () => {
    const denied = byId(await linuxPermissions(sys({ denied: ["/var/run/docker.sock"] })), "docker-access");
    expect(denied).toMatchObject({ status: "missing", required: true });
    expect(denied.fix[0]).toBe("sudo usermod -aG docker sam");
    expect(byId(await linuxPermissions(sys({ uid: 0, denied: ["/var/run/docker.sock"] })), "docker-access").status).toBe("granted");
    const none = byId(await linuxPermissions(sys({ missing: ["/var/run/docker.sock"] })), "docker-access");
    expect(none).toMatchObject({ status: "unknown", needed: false }); // no Docker here: not a need
  });
  test("unreadable mounts under /mnt are reported; unmounted disks are not", async () => {
    expect(externalMounts("/dev/sdb1 /mnt/data ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdc1 /media/My\\040Disk ext4 rw 0 0")).toEqual(["/mnt/data", "/media/My Disk"]);
    const ok = byId(await linuxPermissions(sys({ files: { "/proc/mounts": "/dev/sdb1 /mnt/data ext4 rw 0 0" } })), "path-access");
    expect(ok.status).toBe("granted");
    const bad = byId(await linuxPermissions(sys({ files: { "/proc/mounts": "/dev/sdb1 /mnt/data ext4 rw 0 0" }, denied: ["/mnt/data"] })), "path-access");
    expect(bad.status).toBe("missing");
    expect(bad.fix[0]).toContain("setfacl");
    expect(bad.fix[0]).toContain("/mnt/data");
  });
  test("lingering is read from loginctl and fixed with enable-linger", async () => {
    const q = "loginctl show-user 1000 -p Linger";
    const no = byId(await linuxPermissions(sys({ cmds: { [q]: "Linger=no" } })), "linger");
    expect(no.status).toBe("missing");
    expect(no.fix).toEqual(["sudo loginctl enable-linger sam"]);
    expect(byId(await linuxPermissions(sys({ cmds: { [q]: "Linger=yes" } })), "linger").status).toBe("granted");
    expect(byId(await linuxPermissions(sys({ missing: ["/run/systemd/system"] })), "linger").needed).toBe(false); // no systemd
  });
  test("firewall matters only when the panel is not loopback-only", async () => {
    expect(byId(await linuxPermissions(sys()), "firewall").needed).toBe(false);
    const fw = byId(await linuxPermissions(sys({ env: { HOST: "0.0.0.0", PORT: "3094" }, cmds: { "systemctl is-active ufw": "active" } })), "firewall");
    expect(fw).toMatchObject({ needed: true, status: "unknown" });
    expect(fw.fix).toEqual(["sudo ufw allow 3094/tcp"]);
    expect(byId(await linuxPermissions(sys({ env: { HOST: "0.0.0.0" } })), "firewall").status).toBe("granted"); // no firewall running
  });
  test("SELinux is listed only when enforcing", async () => {
    expect(byId(await linuxPermissions(sys()), "selinux").needed).toBe(false);
    expect(byId(await linuxPermissions(sys({ files: { "/sys/fs/selinux/enforce": "1\n" } })), "selinux").needed).toBe(true);
  });
  test("no probe or fix ever runs sudo", async () => {
    const ran: string[] = [];
    await linuxPermissions(sys({ env: { HOST: "0.0.0.0" }, run: async (c) => { ran.push(c.join(" ")); return { code: 0, out: "" }; } }));
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.some((c) => /sudo/.test(c))).toBe(false);
  });
  test("docker socket: DOCKER_HOST, system socket on Linux, Desktop socket on macOS", () => {
    const has = (...ps: string[]) => (p: string) => ps.includes(p);
    expect(dockerSocket("linux", { DOCKER_HOST: "unix:///run/user/1000/docker.sock" }, has())).toBe("/run/user/1000/docker.sock");
    expect(dockerSocket("linux", {}, has("/var/run/docker.sock"))).toBe("/var/run/docker.sock");
    expect(dockerSocket("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, has("/run/user/1000/docker.sock"))).toBe("/run/user/1000/docker.sock");
    expect(dockerSocket("darwin", {}, () => false)).toMatch(/\.docker\/run\/docker\.sock$/);
  });
});

describe("Fix: popup first, Settings when there is no popup", () => {
  let got: "prompt" | "granted" | "denied" = "prompt";
  const deps = () => { const calls: string[] = []; return { calls, d: { open: async (id: string) => { calls.push("open:" + id); return { code: 0 }; }, trigger: async (id: string) => { calls.push("trigger:" + id); return got; } } }; };
  test("which grants have a popup", () => {
    const how = Object.fromEntries(definitions(cfg()).map((d) => [d.id, d.how]));
    expect(how).toEqual({ "full-disk-access": "settings", "local-network": "dialog", "removable-volumes": "dialog", "files-folders": "dialog", microphone: "settings", automation: "dialog" });
  });
  test("a popup grant is triggered and Settings stays closed", async () => {
    const { calls, d } = deps();
    expect(await fixPermission("local-network", {}, d)).toEqual({ ok: true, did: "prompt" });
    expect(calls).toEqual(["trigger:local-network"]);
  });
  test("pane: true (popup already answered) opens Settings instead", async () => {
    const { calls, d } = deps();
    expect(await fixPermission("automation", { pane: true }, d)).toEqual({ ok: true, did: "pane" });
    expect(calls).toEqual(["open:automation"]);
  });
  test("Full Disk Access has no prompt API: Settings only", async () => {
    const { calls, d } = deps();
    expect(await fixPermission("full-disk-access", {}, d)).toEqual({ ok: true, did: "pane" });
    expect(calls).toEqual(["open:full-disk-access"]);
  });
  test("already allowed: no popup, nothing opened", async () => {
    got = "granted"; const { calls, d } = deps();
    expect(await fixPermission("files-folders", {}, d)).toEqual({ ok: true, did: "granted" });
    expect(calls).toEqual(["trigger:files-folders"]); got = "prompt";
  });
  test("denied before: macOS will not ask again, so Settings opens", async () => {
    got = "denied"; const { calls, d } = deps();
    expect(await fixPermission("files-folders", {}, d)).toEqual({ ok: true, did: "pane", denied: true });
    expect(calls).toEqual(["trigger:files-folders", "open:files-folders"]); got = "prompt";
  });
  test("a failed open is reported", async () => {
    expect((await fixPermission("microphone", {}, { open: async () => ({ code: 1 }), trigger: async () => "prompt" as const })).ok).toBe(false);
  });
});

describe("Fix outcome", () => {
  test("the audit attributes carry what macOS did", () => {
    expect(fixAttrs({ did: "prompt" })).toEqual({ did: "prompt", denied: false });
    expect(fixAttrs({ did: "granted" })).toEqual({ did: "granted", denied: false });
    expect(fixAttrs({ did: "pane", denied: true })).toEqual({ did: "pane", denied: true });
  });
  test("every outcome of fixPermission feeds the audit", async () => {
    const mk = (g: "prompt" | "granted" | "denied") => ({ open: async () => ({ code: 0 }), trigger: async () => g });
    expect(fixAttrs(await fixPermission("files-folders", {}, mk("prompt")))).toEqual({ did: "prompt", denied: false });
    expect(fixAttrs(await fixPermission("files-folders", {}, mk("granted")))).toEqual({ did: "granted", denied: false });
    expect(fixAttrs(await fixPermission("files-folders", {}, mk("denied")))).toEqual({ did: "pane", denied: true });
  });
  test("targets: exact folder names from the config, none when nothing is configured", () => {
    expect(targetsFor("files-folders", cfg())).toEqual([]);
    expect(targetsFor("files-folders", cfg({ externalDisk: join(HOME, "Documents/x") }))).toEqual(["Documents Folder"]);
    expect(targetsFor("removable-volumes", cfg({ externalDisk: "/Volumes/ExternalSSD/data" }))).toEqual(["ExternalSSD"]);
    expect(targetsFor("automation")).toEqual(["System Events"]);
  });
});
