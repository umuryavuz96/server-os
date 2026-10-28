import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-cat-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const { dir } = await import("../core/config");
const cat = await import("./catalog");
const inst = await import("./installer");

beforeAll(() => {
  useDatabase(new Database(":memory:"));
  const d = join(dir("data"), "catalog");
  mkdirSync(d, { recursive: true });
  // Test files share one SERVER_OS_HOME per run; another file may have cached the real recipes, which would win the merge.
  rmSync(join(d, "recipes.json"), { force: true });
  writeFileSync(join(d, "awesome-selfhosted.json"), JSON.stringify([
    { name: "Jellyfin", description: "Media server for audio, video, books", category: "Media Streaming", stars: 58000, repo: "https://github.com/jellyfin/jellyfin" },
    { name: "Paperless-ngx", description: "Document management system that scans and indexes documents", category: "Document Management", stars: 30000 },
    { name: "Old Thing", description: "An abandoned media tool", category: "Media Streaming", stars: 10, archived: true },
  ]));
  writeFileSync(join(d, "linuxserver.json"), JSON.stringify([{ name: "jellyfin", description: "LSIO", stars: 900, install: { method: "linuxserver", ref: "jellyfin", label: "Docker" } }]));
  writeFileSync(join(d, "homebrew.json"), JSON.stringify([{ name: "Media Player Pro", description: "A Mac media app", install: { method: "cask", ref: "mpp", label: "cask" } }]));
  writeFileSync(join(d, "casaos.json"), JSON.stringify([{ name: "Jellyfin", description: "CasaOS desc", install: { method: "casaos", ref: "Jellyfin", label: "Docker" } }]));
});

describe("catalog", () => {
  test("merges sources by name; descriptions from the first source; install options ranked", () => {
    cat.rebuild();
    const j = cat.getItem("jellyfin")!;
    expect(j.sources.sort()).toEqual(["awesome-selfhosted", "casaos", "linuxserver"]);
    expect(j.description).toBe("Media server for audio, video, books");
    expect(j.install.map((o) => o.method)).toEqual(["casaos", "linuxserver"]);
    expect(j.stars).toBe(58000);
  });
  test("full-text search with prefixes, filters and exact-name boost", () => {
    expect(cat.search({ q: "jelly" }).items[0].id).toBe("jellyfin");
    expect(cat.search({ q: "documents" }).items.map((i) => i.id)).toEqual(["paperless-ngx"]);
    expect(cat.search({ q: "media" }).total).toBe(2); // the Homebrew-only Mac app is hidden…
    expect(cat.search({ q: "media", scope: "all" }).total).toBe(3); // …unless asked for
    expect(cat.search({ q: "media", installable: true }).items.map((i) => i.id)).toEqual(["jellyfin"]);
    expect(cat.search({ category: "Document Management" }).total).toBe(1);
    expect(cat.search({ q: "\"; DROP TABLE catalog; --" }).total).toBe(0);
    expect(cat.categories()[0]).toEqual({ category: "Media Streaming", count: 2 });
  });
});

describe("installer templates", () => {
  test("CasaOS compose → template: /DATA paths, ports, env, no devices", () => {
    const t = inst.casaToTemplate(`name: demo
services:
  demo:
    image: demo:1
    devices: ["/dev/dri:/dev/dri"]
    environment: { PUID: $PUID, TZ: $TZ }
    ports:
      - target: 80
        published: "8097"
        protocol: tcp
    volumes:
      - type: bind
        source: /DATA/AppData/$AppID/config
        target: /config
      - /DATA/Media:/media
    x-casaos: { ports: [] }
x-casaos:
  port_map: "8097"
  index: /web
`);
    expect(t.webPort).toBe(8097);
    expect(t.webPath).toBe("/web");
    expect(t.compose).not.toContain("x-casaos");
    expect(t.compose).not.toContain("/dev/dri");
    expect(t.compose).toContain("{{data}}/config");
    expect(t.compose).toContain("{{data}}/Media:/media");
    expect(t.compose).toContain("{{port:8097}}");
    expect(t.compose).toContain("{{puid}}");
  });
  test("fillTemplate picks free ports, reuses a placeholder's port, fills data/tz/ids", async () => {
    const busy = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    const { text, ports } = await inst.fillTemplate(`a: "{{port:${busy.port}}}:80"\nb: "{{port:${busy.port}}}:81"\nc: {{data}}/x\nd: {{tz}}`, "/srv/app");
    busy.stop(true);
    expect(ports.length).toBe(1);
    expect(ports[0]).not.toBe(busy.port);
    expect(text).toContain(`"${ports[0]}:80"`);
    expect(text).toContain(`"${ports[0]}:81"`);
    expect(text).toContain("/srv/app/x");
    expect(text).not.toContain("{{");
  });
});
