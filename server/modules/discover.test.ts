import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-discover-"));
const { addToCatalog, findCandidates, niceName, parseSites } = await import("./discover");
const { readFileSync, readdirSync } = await import("node:fs");
const { CATALOG_FILE } = await import("../apps");

const CADDY = `{\n\tadmin off\n}\n(common) {\n\tencode gzip\n}\nhttp://jellyfin.home {\n\treverse_proxy localhost:8096\n}
# art demo
http://artdemo.home {\n\troot * /srv/art/dist\n\tfile_server\n}
http://it-tools.home {\n\treverse_proxy localhost:8088\n}
http://map.home {\n\treverse_proxy 192.0.2.10:8100\n}
http://panel.home {\n\treverse_proxy localhost:3094\n}
http://old.home {\n\tredir http://new.home{uri}\n}
http://api.home {\n\treverse_proxy localhost:3045 {\n\t\theader_up X-Local 1\n\t}\n}
`;

describe("discover", () => {
  test("parseSites: proxies, static roots, snippets skipped, redirects have neither", () => {
    const s = parseSites(CADDY, "/etc/Caddyfile");
    expect(s.find((x) => x.host === "jellyfin.home")).toMatchObject({ port: 8096 });
    expect(s.find((x) => x.host === "artdemo.home")).toMatchObject({ root: "/srv/art/dist" });
    expect(s.find((x) => x.host === "map.home")).toMatchObject({ upstream: "192.0.2.10:8100" });
    expect(s.find((x) => x.host === "map.home")?.port).toBeUndefined();
    expect(s.find((x) => x.host === "api.home")).toMatchObject({ port: 3045 });
    expect(s.some((x) => x.host === "(common)" || x.host === "common")).toBe(false);
    expect(s.find((x) => x.host === "old.home")).toEqual({ host: "old.home" });
  });
  test("parseSites follows import globs", () => {
    const files: Record<string, string> = { "/c/sites/a.caddy": "http://a.home {\n reverse_proxy localhost:9001\n}\n" };
    const s = parseSites("import sites/*.caddy\n", "/c/Caddyfile", (p) => files[p], () => ["a.caddy", "b.txt"]);
    expect(s).toEqual([{ host: "a.home", upstream: "localhost:9001", port: 9001 }]);
  });
  test("names", () => {
    expect(niceName("sd-it-tools")).toBe("It Tools");
    expect(niceName("com.acme.media-server")).toBe("Media Server");
    expect(niceName("artdemo")).toBe("Artdemo");
  });
  test("finds what the Apps tab lacks, and nothing it already has", () => {
    const base = {
      sites: parseSites(CADDY, "/etc/Caddyfile"),
      dockerPorts: [{ container: "sd-it-tools", hostPort: 8088, containerPort: 80, proto: "tcp", hostIp: "0.0.0.0" }, { container: "jellyfin", hostPort: 8096, containerPort: 8096, proto: "tcp", hostIp: "0.0.0.0" }],
      containers: ["jellyfin", "sd-it-tools", "calibre-web"],
      launchd: new Map([["com.acme.carfinder", 77], ["com.apple.thing", 5], ["com.acme.server-os", 99], ["com.acme.job", 0], ["com.acme.noplist", 12]]),
      listeners: [{ port: 3045, proto: "tcp" as const, addresses: ["127.0.0.1"], scope: "local" as const, process: "bun", pid: 77 }],
      known: [{ name: "Jellyfin", href: "http://jellyfin.home", docker: ["jellyfin"] }],
      ignored: [] as string[], selfPort: 3094, selfPid: 99, plists: new Set(["com.acme.carfinder", "com.apple.thing", "com.acme.server-os", "com.acme.job"]),
    };
    const got = findCandidates(base);
    expect(got.map((c) => c.id)).toEqual(["site:api.home", "site:artdemo.home", "docker:calibre-web", "site:it-tools.home", "site:map.home"]);
    const api = got.find((c) => c.id === "site:api.home")!;
    expect(api.launchd).toEqual(["com.acme.carfinder"]);          // site + the agent behind it are one entry
    expect(got.find((c) => c.id === "site:it-tools.home")!.docker).toEqual(["sd-it-tools"]);
    expect(got.find((c) => c.id === "site:artdemo.home")).toMatchObject({ group: "Sites", href: "http://artdemo.home" });
    // the same things once listed or ignored disappear
    const listed = findCandidates({ ...base, known: [...base.known, { name: "Cars", href: "http://api.home", launchd: ["com.acme.carfinder"] }], ignored: ["docker:calibre-web"] });
    expect(listed.map((c) => c.id)).toEqual(["site:artdemo.home", "site:it-tools.home", "site:map.home"]);
  });
  test("a running agent with no site is listed on its own", () => {
    const got = findCandidates({ sites: [], dockerPorts: [], containers: [], launchd: new Map([["com.acme.tts", 40]]), listeners: [], known: [], ignored: [], selfPort: 3094, selfPid: 1, plists: new Set(["com.acme.tts"]) });
    expect(got).toMatchObject([{ id: "launchd:com.acme.tts", name: "Tts", launchd: ["com.acme.tts"] }]);
  });
  test("add writes a catalog entry, backs the file up, refuses a taken name", () => {
    const c = { id: "site:artdemo.home", kind: "site" as const, name: "Artdemo", href: "http://artdemo.home", about: "Static site.", detail: "", group: "Sites" };
    const first = addToCatalog(c, {});
    expect(first.backup).toBeNull();                                  // no catalog yet: nothing to back up
    const second = addToCatalog({ ...c, id: "docker:x", kind: "docker", name: "X", href: undefined, about: "", docker: ["x"], group: "Other" }, { name: "Box", group: "Sites" });
    expect(second.backup).toContain("catalog.json.bak-");
    const raw = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
    expect(raw.groups).toEqual([{ group: "Sites", items: [{ name: "Artdemo", href: "http://artdemo.home", about: "Static site." }, { name: "Box", about: "", docker: ["x"] }] }]);
    expect(() => addToCatalog(c, {})).toThrow("already an app");
    expect(readdirSync(CATALOG_FILE.replace(/\/[^/]+$/, "")).filter((f) => f.includes(".bak-")).length).toBe(1);
  });
});
