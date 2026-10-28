import { beforeEach, expect, test } from "bun:test";
import { minutesLeft, parseUsage, resetUsageCache, usage } from "./cloudVoice";

const reply = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const env = { ELEVENLABS_API_KEY: "k" };
beforeEach(resetUsageCache);

test("subscription JSON becomes used / limit / percent / minutes", () => {
  const u = parseUsage({ character_count: 1000, character_limit: 10000, next_character_count_reset_unix: 1790000000, tier: "payg", status: "active" });
  expect(u).toEqual({ state: "ok", used: 1000, limit: 10000, percent: 10, resetsAt: 1790000000, tier: "payg", status: "active", minutesLeft: 100 });
  expect(minutesLeft(0, 10000)).toBe(111); // 10000 credits / 0.1 per character / 900 characters a minute
  expect(parseUsage({}).state).toBe("error");
});

test("no key, missing permission and network failure each get their own state", async () => {
  expect((await usage(reply(200, {}), 1, {})).state).toBe("no-key");
  resetUsageCache();
  expect((await usage(reply(401, { detail: { status: "missing_permissions" } }), 1, env)).state).toBe("needs-permission");
  resetUsageCache();
  expect((await usage(reply(401, { detail: { status: "invalid_api_key" } }), 1, env)).state).toBe("error");
  expect((await usage((async () => { throw new Error("down"); }) as unknown as typeof fetch, 1, env)).state).toBe("error");
});

test("usage is cached for 60 seconds", async () => {
  let n = 0;
  const f = (async () => { n++; return new Response(JSON.stringify({ character_count: n, character_limit: 100 })); }) as unknown as typeof fetch;
  await usage(f, 1000, env); await usage(f, 30_000, env);
  expect(n).toBe(1);
  await usage(f, 62_000, env);
  expect(n).toBe(2);
});
