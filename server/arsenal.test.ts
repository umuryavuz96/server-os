import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Env } from "./core/http";

const dir = mkdtempSync(join(tmpdir(), "arsenal-"));
beforeAll(() => {
  process.env.ARSENAL_DIR = dir; process.env.SOUL_LOG = join(dir, "log.jsonl");
  mkdirSync(join(dir, "r"));
  writeFileSync(join(dir, "r", "a.md"), "---\nname: a\n---\nBe A.");
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ generated: "x", agents: [
    { id: "r/a", name: "a", repo: "o/r", path: "r/a.md", stars: 5, licence: "MIT", category: "frontend", description: "d", tools: [], tags: [] },
    { id: "r/evil", name: "e", repo: "o/r", path: "../outside.md", stars: 1, licence: "MIT", category: "qa", description: "d", tools: [], tags: [] }] }));
  writeFileSync(join(dir, "roles.json"), JSON.stringify({ roles: { "web-dev": { default: "r/a" } } }));
  writeFileSync(join(dir, "log.jsonl"), JSON.stringify({ ts: "t", soul: "r/a", role: "web-dev", score: 4, kw: 0, reason: "role default" }) + "\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function app(actor = "admin") {
  const { arsenalRoutes } = await import("./arsenal");
  const a = new Hono<Env>(), api = new Hono<Env>();
  api.use("*", async (c, next) => { c.set("actor", actor); c.set("device", null); await next(); });
  arsenalRoutes(api); a.route("/api/v1", api); return a;
}
test("lists catalog, roles and decisions", async () => {
  const j = await (await (await app()).request("/api/v1/arsenal")).json() as any;
  expect(j.agents.length).toBe(2); expect(j.roles["web-dev"].default).toBe("r/a"); expect(j.decisions[0].soul).toBe("r/a");
});
test("persona body, and no path escape", async () => {
  const a = await app();
  expect(((await (await a.request("/api/v1/arsenal/agent?id=r/a")).json()) as any).body).toContain("Be A.");
  expect((await a.request("/api/v1/arsenal/agent?id=r/evil")).status).toBe(404);
});
test("roles save checks ids, needs admin, backs up", async () => {
  const body = (r: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
  expect((await (await app("anonymous")).request("/api/v1/arsenal/roles", body({ roles: {} }))).status).toBe(403);
  const a = await app();
  expect((await a.request("/api/v1/arsenal/roles", body({ roles: { qa: { default: "nope" } } }))).status).toBe(400);
  expect((await a.request("/api/v1/arsenal/roles", body({ roles: { qa: { default: "r/a", categories: ["qa"] } } }))).status).toBe(200);
  expect(JSON.parse(readFileSync(join(dir, "roles.json"), "utf8")).roles.qa.default).toBe("r/a");
  expect(readFileSync(join(dir, "roles.json.bak-serverdash"), "utf8")).toContain("web-dev");
});
