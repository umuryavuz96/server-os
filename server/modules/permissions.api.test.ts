import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real server in a child process, on a scratch home and a spare port. The `open` route is only tried with a bad id:
// a good one would open System Settings.
let proc: ReturnType<typeof Bun.spawn>, home: string;
const port = 3300 + Math.floor(Math.random() * 500), base = `http://127.0.0.1:${port}/api/v1`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "sos-perm-api-"));
  proc = Bun.spawn(["bun", join(import.meta.dir, "../index.ts")], { env: { ...process.env, PORT: String(port), SERVER_OS_HOME: home }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 60; i++) { if (await fetch(base + "/info").then((r) => r.ok).catch(() => false)) return; await Bun.sleep(250); }
  throw new Error("server did not start");
});
afterAll(() => { proc?.kill(); rmSync(home, { recursive: true, force: true }); });

test("GET /permissions lists the inventory with a status each", async () => {
  const j = await (await fetch(base + "/permissions")).json() as { platform: string; permissions: { id: string; status: string; settingsUrl: string; processes: unknown[]; targets?: string[] }[]; missingRequired: string[] };
  if (j.platform === "linux") { expect(j.permissions.map((p) => p.id)).toEqual(["docker-access", "path-access", "linger", "firewall", "selinux"]); return; }
  if (j.platform !== "darwin") { expect(j.permissions).toEqual([]); return; }
  expect(j.permissions.map((p) => p.id)).toEqual(["full-disk-access", "local-network", "removable-volumes", "files-folders", "microphone", "automation"]);
  for (const p of j.permissions) { expect(["granted", "missing", "unknown", "not-needed"]).toContain(p.status); expect(p.settingsUrl).toStartWith("x-apple.systempreferences:"); expect(p.processes.length).toBeGreaterThan(0); }
  expect(j.permissions.find((p) => p.id === "automation")!.targets).toEqual(["System Events"]);
  expect(j.permissions.find((p) => p.id === "local-network")!.status).toBe("unknown"); // active probe: not run by a plain GET
  expect(j.missingRequired).toEqual([]);
});

test("POST /permissions/:id/check refreshes one entry", async () => {
  const r = await fetch(base + "/permissions/full-disk-access/check", { method: "POST" });
  expect(r.status).toBe(200);
  const j = await r.json() as { permission: { id: string } | null };
  if (process.platform === "darwin") expect(j.permission?.id).toBe("full-disk-access");
});

test("unknown ids are 404 problems; open needs the admin key", async () => {
  const r = await fetch(base + "/permissions/nope/check", { method: "POST" });
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toContain("application/problem+json");
  expect((await fetch(base + "/permissions/full-disk-access/open", { method: "POST" })).status).toBe(403); // anonymous: nothing opens
  await fetch(base + "/info", { headers: { Authorization: "Bearer x" } }); // the server makes its admin key on the first token it sees
  const key = readFileSync(join(home, "data", "admin.key"), "utf8").trim();
  expect((await fetch(base + "/permissions/nope/open", { method: "POST", headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);
});

test("/info advertises the capability on macOS", async () => {
  const j = await (await fetch(base + "/info")).json() as { capabilities: string[]; platform: string };
  expect(j.capabilities.includes("permissions")).toBe(j.platform === "darwin" || j.platform === "linux");
});
