import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-names-"));
const names = await import("./names");
const { run } = await import("../lib");

describe("names", () => {
  const calls: string[][] = [];
  let caddyfile = "";
  beforeAll(() => {
    caddyfile = join(mkdtempSync(join(tmpdir(), "sd-caddy-")), "Caddyfile");
    writeFileSync(caddyfile, `{\n\tadmin off\n}\nimport ${names.snippetDir()}/*.caddy\n`);
    // validate runs the real caddy binary against the temp file when one is installed (a dev Mac); CI runners have none,
    // so there it is stubbed to pass and the test still checks the snippet, the call order and the refusals. Reload is never run for real.
    const real = !!Bun.which("caddy");
    names.useCaddyRunner(async (args) => { calls.push(args); return args[0] === "validate" && real ? run(["caddy", ...args], 30_000) : { code: 0, out: "" }; });
  });
  test("hosts", () => {
    expect(names.hostFor({ suffix: "home", caddyfile: "", dns: "wildcard", ips: [] }, "jellyfin")).toBe("jellyfin.home");
    expect(names.hostFor({ suffix: ".lan", caddyfile: "", dns: "wildcard", ips: [] }, "x")).toBe("x.lan");
    expect(names.hostFor({ suffix: "home", caddyfile: "", dns: "sslip", ips: ["192.0.2.135"] }, "x")).toBe("x.192-0-2-135.sslip.io");
  });
  test("add writes a valid site, reloads, refuses a taken name; remove deletes it", async () => {
    const n = { suffix: "home", caddyfile, dns: "wildcard" as const, ips: ["192.0.2.135"] };
    expect(await names.addName("whoami", 8099, n)).toBe("http://whoami.home");
    const f = join(names.snippetDir(), "whoami.caddy");
    expect(readFileSync(f, "utf8")).toContain("reverse_proxy localhost:8099");
    expect(calls.map((c) => c[0])).toEqual(["validate", "reload"]);
    await expect(names.addName("whoami", 9000, n)).rejects.toThrow("already points");
    expect(await names.removeName("whoami", n)).toBeNull();
    expect(existsSync(f)).toBe(false);
    await expect(names.addName("Bad Id", 1, n)).rejects.toThrow("bad app id");
  });
});
