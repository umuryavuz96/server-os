import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The home folder is read at import time, so point it at a temp dir before loading the modules.
const root = mkdtempSync(join(tmpdir(), "sd-test-"));
process.env.SERVER_OS_HOME = root;
const { Database } = await import("bun:sqlite");
const cfg = await import("./config");
const dev = await import("./devices");
const logger = await import("./logger");

const { useDatabase } = await import("./db");
beforeAll(() => useDatabase(new Database(":memory:")));

describe("config", () => {
  test("defaults without a file, auth off", () => {
    const c = cfg.loadConfig(join(root, "missing.yaml"));
    expect(c.auth).toBe("off");
    expect(c.logging.maxFileMB).toBe(10);
  });
  test("init lays out the folder once and the template parses", () => {
    cfg.initLayout(); // other test files may have created some folders already (one process, one home)
    expect(cfg.initLayout()).toEqual([]);
    for (const d of cfg.DIRS) expect(existsSync(cfg.dir(d))).toBe(true);
    const c = cfg.loadConfig();
    expect(c.auth).toBe("off");
    expect(c.logging.level).toBe("info");
  });
});

describe("pairing", () => {
  test("code → token → verify → revoke", () => {
    const { code } = dev.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    const r = dev.completePairing(code, "Umur's iPad", "ipados");
    if (!r.ok) throw new Error(r.error);
    expect(dev.verify(r.token)?.id).toBe(r.device.id);
    expect(dev.completePairing(code, "x", "y").ok).toBe(false); // single use
    expect(dev.listDevices().length).toBe(1);
    expect(dev.revoke(r.device.id)).toBe(true);
    expect(dev.verify(r.token)).toBeNull();
  });
  test("expires and locks after 5 wrong guesses", () => {
    const now = Date.now();
    const { code } = dev.startPairing(now);
    expect(dev.completePairing(code, "a", "b", now + 5 * 60_000 + 1).ok).toBe(false);
    const p = dev.startPairing(now);
    const wrong = p.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) dev.completePairing(wrong, "a", "b", now);
    expect(dev.completePairing(p.code, "a", "b", now).ok).toBe(false);
  });
  test("tokens are stored hashed", () => {
    const { code } = dev.startPairing();
    const r = dev.completePairing(code, "n", "p");
    if (!r.ok) throw new Error(r.error);
    expect(JSON.stringify(dev.listDevices())).not.toContain(r.token);
  });
});

describe("logging", () => {
  test("traceparent keeps the caller's trace id, new span", () => {
    const t = logger.fromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(t.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(t.span_id).not.toBe("00f067aa0ba902b7");
    expect(logger.fromTraceparent("garbage").trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
  test("audit writes one JSON line with OTel ids", () => {
    const tr = logger.newTrace();
    logger.audit("device:x", "app.start", "jellyfin", "ok", tr);
    const f = join(cfg.dir("logs"), "audit.jsonl");
    expect(existsSync(f)).toBe(true);
    const rec = JSON.parse(readFileSync(f, "utf8").trim().split("\n").pop()!);
    expect(rec).toMatchObject({ actor: "device:x", action: "app.start", target: "jellyfin", trace_id: tr.trace_id });
  });
});

describe("http", async () => {
  const { Hono } = await import("hono");
  const http = await import("./http");
  const make = () => {
    const app = new Hono<import("./http").Env>();
    app.use("*", http.tracing);
    app.use("*", http.requireAuth((p) => p.endsWith("/info")));
    app.get("/info", (c) => c.json({ ok: true }));
    app.get("/state", (c) => c.json({ actor: c.get("actor") }));
    app.get("/devices", http.requireAdmin, (c) => c.json([]));
    return app;
  };
  test("auth off: open, traceparent on every response, device admin still needs a key", async () => {
    const app = make();
    const r = await app.request("/state");
    expect(r.status).toBe(200);
    expect(r.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect((await app.request("/devices")).status).toBe(403);
    expect((await app.request("/devices", { headers: { Authorization: `Bearer ${dev.adminKey()}` } })).status).toBe(200);
  });
  test("auth token: 401 problem+json without a token, info stays open", async () => {
    cfg.config.auth = "token";
    try {
      const app = make();
      const r = await app.request("/state");
      expect(r.status).toBe(401);
      expect(r.headers.get("content-type")).toBe("application/problem+json");
      expect((await app.request("/info")).status).toBe(200);
      const { code } = dev.startPairing();
      const p = dev.completePairing(code, "phone", "ios");
      if (!p.ok) throw new Error(p.error);
      const ok = await app.request("/state", { headers: { Authorization: `Bearer ${p.token}` } });
      expect(await ok.json()).toEqual({ actor: `device:${p.device.id}` });
      expect((await app.request(`/state?token=${p.token}`)).status).toBe(200);
    } finally { cfg.config.auth = "off"; }
  });
});

describe("otlp", () => {
  test("log record maps to the OTLP JSON shape", () => {
    const tr = logger.newTrace();
    const r = logger.toOtlp("warn", "disk at 91%", { pct: 91, mount: "/", ok: false, ratio: 0.5 }, tr, new Date(1_700_000_000_000));
    expect(r).toMatchObject({ timeUnixNano: "1700000000000000000", severityNumber: 13, severityText: "WARN", body: { stringValue: "disk at 91%" }, traceId: tr.trace_id, spanId: tr.span_id });
    expect(r.attributes).toEqual([
      { key: "pct", value: { intValue: "91" } }, { key: "mount", value: { stringValue: "/" } },
      { key: "ok", value: { boolValue: false } }, { key: "ratio", value: { doubleValue: 0.5 } },
    ]);
  });
  test("exports batches to <endpoint>/v1/logs", async () => {
    const got: any[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (req) => { got.push({ path: new URL(req.url).pathname, body: await req.json() }); return new Response(null, { status: 200 }); } });
    cfg.config.otlp = { endpoint: `http://127.0.0.1:${srv.port}` };
    try {
      logger.logEvent("error", "boom", { a: 1 });
      await Bun.sleep(2300);
      expect(got[0].path).toBe("/v1/logs");
      expect(got[0].body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).toBe("boom");
    } finally { cfg.config.otlp = undefined; srv.stop(true); }
  });
});

describe("browser sign-in", async () => {
  const { Hono } = await import("hono");
  const http = await import("./http");
  test("the sd_token cookie authenticates like a Bearer token; the cookie is HttpOnly + SameSite=Strict", async () => {
    cfg.config.auth = "token";
    try {
      const app = new Hono<import("./http").Env>();
      app.use("*", http.requireAuth(() => false));
      app.get("/state", (c) => c.json({ actor: c.get("actor") }));
      const { code } = dev.startPairing();
      const p = dev.completePairing(code, "Safari on Mac", "web");
      if (!p.ok) throw new Error(p.error);
      const ok = await app.request("/state", { headers: { cookie: `other=1; sd_token=${encodeURIComponent(p.token)}` } });
      expect(ok.status).toBe(200);
      expect((await app.request("/state", { headers: { cookie: "sd_token=nope" } })).status).toBe(401);
      const set = http.signInCookie({ req: { header: () => "https", url: "http://x/" } } as never, p.token);
      expect(set).toContain("HttpOnly");
      expect(set).toContain("SameSite=Strict");
      expect(set).toContain("Secure");
    } finally { cfg.config.auth = "off"; }
  });
});

describe("owner account", async () => {
  const owner = await import("./owner");
  test("setup token exists until the owner is created, then dies", async () => {
    const { db } = await import("./db");
    db().run("DELETE FROM owner");
    const t = owner.setupToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(owner.setupToken()).toBe(t); // stable
    expect(await owner.createOwner("u", "short")).toContain("Username");
    expect(await owner.createOwner("umur", "short")).toContain("10 characters");
    expect(await owner.createOwner("umur", "correct horse battery")).toBeNull();
    expect(owner.setupToken()).toBeNull();
    expect(await owner.createOwner("other", "correct horse battery")).toContain("already");
  });
  test("verify: right password + case-insensitive name; wrong ones fail", async () => {
    expect(await owner.verifyOwner("Umur", "correct horse battery")).toBe(true);
    expect(await owner.verifyOwner("umur", "wrong password!!")).toBe(false);
    expect(await owner.verifyOwner("someone", "correct horse battery")).toBe(false);
  });
  test("5 failures in 15 minutes lock that address", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) owner.noteFailure("1.2.3.4", now);
    expect(owner.tooManyAttempts("1.2.3.4", now)).toBe(true);
    expect(owner.tooManyAttempts("1.2.3.4", now + 16 * 60_000)).toBe(false);
    expect(owner.tooManyAttempts("5.6.7.8", now)).toBe(false);
  });
  test("change password", async () => {
    expect(await owner.changePassword("nope nope nope", "another long one")).toContain("wrong");
    expect(await owner.changePassword("correct horse battery", "another long one")).toBeNull();
    expect(await owner.verifyOwner("umur", "another long one")).toBe(true);
  });
});
