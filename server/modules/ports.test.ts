import { describe, expect, test } from "bun:test";
import { buildReport, parseCaddy, parseDockerPorts, parseNetstat, parseSs, scopeOf } from "./ports";

describe("ports", () => {
  test("macOS netstat: addresses merge per port+process; scope from the addresses", () => {
    const out = [
      "tcp4  0 0  127.0.0.1.3094   *.*  LISTEN  0 0 131072 131072  bun:61987  00100",
      "tcp6  0 0  *.8096           *.*  LISTEN  0 0 131072 131072  com.docker.backe:9084 00100",
      "tcp4  0 0  *.8096           *.*  LISTEN  0 0 131072 131072  com.docker.backe:9084 00100",
      "tcp4  0 0  100.64.0.127.443 *.* LISTEN 0 0 131072 131072  tailscaled:120 00100",
      "tcp4  0 0  127.0.0.1.80     10.0.0.2.5000 ESTABLISHED 0 0 1 1 caddy:1 00100",
      "tcp4  0 0  127.0.0.1.54781  *.*  LISTEN  0 0 131072 131072  python3.13:84650  00100 00000006",
    ].join("\n");
    const l = parseNetstat(out, "tcp");
    expect(l.map((x) => [x.port, x.scope, x.process, x.pid])).toEqual([[3094, "local", "bun", 61987], [8096, "network", "com.docker.backe", 9084], [443, "tailnet", "tailscaled", 120], [54781, "local", "python3.13", 84650]]);
    expect(l[1].addresses).toEqual(["0.0.0.0"]);
  });
  test("Linux ss", () => {
    const l = parseSs(`tcp LISTEN 0 4096 0.0.0.0:3094 0.0.0.0:* users:(("bun",pid=812,fd=13))\ntcp LISTEN 0 4096 [::1]:5432 [::]:* users:(("postgres",pid=90,fd=5))`);
    expect(l.map((x) => [x.port, x.scope, x.process, x.pid])).toEqual([[3094, "network", "bun", 812], [5432, "local", "postgres", 90]]);
  });
  test("known services are named, not flagged", () => {
    const rep = buildReport([{ port: 22, proto: "tcp", addresses: ["0.0.0.0"], scope: "network", process: "launchd", pid: 1 },
      { port: 53, proto: "udp", addresses: ["0.0.0.0"], scope: "network", process: "AdGuardHome", pid: 9 }], [], [], []);
    expect(rep.rows.map((r) => [r.service, r.issue])).toEqual([["SSH", null], ["AdGuard Home (DNS)", null]]);
  });
  test("scope", () => {
    expect(scopeOf(["127.0.0.1", "::1"])).toBe("local");
    expect(scopeOf(["100.64.0.127"])).toBe("tailnet");
    expect(scopeOf(["0.0.0.0"])).toBe("network");
    expect(scopeOf(["192.0.2.135"])).toBe("network");
  });
  test("docker ports", () => {
    const m = parseDockerPorts("jellyfin|0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp\nappwrite|80/tcp\nweb|127.0.0.1:8085->80/tcp");
    expect(m).toEqual([
      { container: "jellyfin", hostIp: "0.0.0.0", hostPort: 8096, containerPort: 8096, proto: "tcp" },
      { container: "web", hostIp: "127.0.0.1", hostPort: 8085, containerPort: 80, proto: "tcp" },
    ]);
  });
  test("Caddy sites → ports, nested blocks and imports", () => {
    const files: Record<string, string> = { "/etc/caddy/sites/a.caddy": "http://x.home {\n reverse_proxy 127.0.0.1:4000\n}\n" };
    const r = parseCaddy(`{\n admin off\n}\n# comment\nhttp://jellyfin.home, http://media.home {\n\theader {\n\t\t-Server\n\t}\n\treverse_proxy localhost:8096\n}\nhttp://ha.home {\n reverse_proxy 192.0.2.81:8123\n}\nimport sites/*.caddy\n`,
      "/etc/caddy/Caddyfile", (p) => files[p], () => ["a.caddy", "b.txt"]);
    expect(r.map((x) => [x.name, x.port])).toEqual([["jellyfin.home", 8096], ["media.home", 8096], ["x.home", 4000]]);
  });
  test("report: app matching, names, unknown network listeners, names pointing nowhere", () => {
    const rep = buildReport(
      [{ port: 8096, proto: "tcp", addresses: ["0.0.0.0"], scope: "network", process: "docker", pid: 1 },
       { port: 3043, proto: "tcp", addresses: ["0.0.0.0"], scope: "network", process: "Python", pid: 50 },
       { port: 8384, proto: "tcp", addresses: ["0.0.0.0"], scope: "network", process: "syncthing", pid: 70 }],
      [{ container: "jellyfin", hostIp: "0.0.0.0", hostPort: 8096, containerPort: 8096, proto: "tcp" }],
      [{ name: "jellyfin.home", port: 8096, file: "f" }, { name: "old.home", port: 9999, file: "f" }],
      [{ name: "Jellyfin", docker: ["jellyfin"] }, { name: "Ege Log", pids: [50] }]);
    expect(rep.rows.map((r) => [r.port, r.app, r.names, r.issue])).toEqual([[3043, "Ege Log", [], null], [8096, "Jellyfin", ["jellyfin.home"], null], [8384, null, [], "unknown"]]);
    expect(rep.deadNames.map((d) => d.name)).toEqual(["old.home"]);
    expect(rep.counts).toMatchObject({ total: 3, network: 3, docker: 1, issues: 1 });
  });
});
