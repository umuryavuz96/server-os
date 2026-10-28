import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-inst-"));
const { dir } = await import("../core/config");
const inst = await import("./installer");

// A fake installed app: just its folder and app.yaml.
const app = join(dir("apps"), "demo");
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "app.yaml"), Bun.YAML.stringify({ name: "Demo", about: "", category: "Test", icon: "", href: "http://demo.local:1", method: "recipe", ref: "demo", installedAt: 1 }));

describe("secrets + ready card", () => {
  test("newSecret makes a random value once, stored mode 600", () => {
    const a = inst.newSecret("demo", "admin_password");
    expect(a).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(inst.newSecret("demo", "admin_password")).toBe(a);
    expect(inst.getSecrets("demo").admin_password).toBe(a);
    expect(statSync(join(app, ".secret")).mode & 0o777).toBe(0o600);
  });
  test("newSecret refuses bad names and unknown apps", () => {
    expect(() => inst.newSecret("demo", "../x")).toThrow();
    expect(() => inst.newSecret("nope", "a")).toThrow();
  });
  test("setReady writes the card and listInstalled returns it", () => {
    expect(() => inst.setReady("demo", { url: "http://demo.home", summary: "ok", steps: [], secret: "missing" })).toThrow(/no secret/);
    const r = inst.setReady("demo", { url: "http://demo.home", username: "owner", secret: "admin_password", summary: "Set up.", steps: ["Log in"] });
    expect(r.at).toBeGreaterThan(0);
    expect(inst.getInstalled("demo")?.ready).toMatchObject({ url: "http://demo.home", username: "owner", secret: "admin_password", steps: ["Log in"] });
  });
});
