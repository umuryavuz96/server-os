import { expect, test } from "bun:test";
import { Hono } from "hono";
import { voiceChatRoutes } from "./voiceChatRoutes";
import type { Env } from "./core/http";

function app(actor: string) {
  const a = new Hono<Env>(), api = new Hono<Env>();
  api.use("*", async (c, next) => { c.set("actor", actor); c.set("device", null); await next(); });
  voiceChatRoutes(api, { port: 3094, demo: true });
  a.route("/api/v1", api);
  return a;
}
const post = (a: Hono<Env>, body: unknown) => a.request("/api/v1/voice/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("ack needs the admin key or a paired device", async () => {
  expect((await post(app("anonymous"), { text: "On it" })).status).toBe(403);
});
test("ack checks the text", async () => {
  const a = app("admin");
  expect((await post(a, {})).status).toBe(400);
  expect((await post(a, { text: "x".repeat(301) })).status).toBe(400);
});
test("ack reaches an open chat's stream", async () => {
  const a = app("admin");
  const res = await a.request("/api/v1/voice/ack/stream");
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  const read = async (until: RegExp) => { while (!until.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  await read(/event: ready/);
  const r = await post(a, { text: "Checking the logs now.", lang: "en" });
  expect(await r.json()).toMatchObject({ ok: true, spoken: false, listeners: 1 });
  await read(/event: ack[\s\S]*\n\n/);
  expect(buf).toContain("Checking the logs now.");
  await reader.cancel();
});
