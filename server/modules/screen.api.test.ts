import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two real servers in child processes: one with the remote screen on (pointed at a fake VNC server in this process),
// one with it off. auth: token, so anonymous callers are refused before the screen code runs.
const port = 3300 + Math.floor(Math.random() * 400), offPort = port + 450;
const base = `http://127.0.0.1:${port}/api/v1`, wsUrl = `ws://127.0.0.1:${port}/api/v1/screen/ws`;
let on: ReturnType<typeof Bun.spawn>, off: ReturnType<typeof Bun.spawn>, homeOn: string, homeOff: string, key = "";
const received: number[] = [];
const vnc = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
  open(s) { s.write("RFB 003.889\n"); },
  data(s, d) { received.push(...d); if (d[0] === 0x52) s.write(new Uint8Array([1, 30])); }, // answers the client's version with "ARD only"
} });

async function start(home: string, p: number, yaml: string) {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "server-os.yaml"), yaml);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../index.ts")], { env: { ...process.env, PORT: String(p), SERVER_OS_HOME: home }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${p}/api/v1/info`).then((r) => r.ok).catch(() => false)) return proc; await Bun.sleep(250); }
  throw new Error("server did not start");
}
beforeAll(async () => {
  homeOn = mkdtempSync(join(tmpdir(), "sos-screen-on-")); homeOff = mkdtempSync(join(tmpdir(), "sos-screen-off-"));
  [on, off] = await Promise.all([
    start(homeOn, port, `auth: token\nintegrations:\n  screen: { enabled: true, port: ${vnc.port}, idleMinutes: 0.03, maxMinutes: 1 }\n`),
    start(homeOff, offPort, "auth: token\n"),
  ]);
  await fetch(base + "/info", { headers: { Authorization: "Bearer x" } }); // makes the admin key
  await fetch(`http://127.0.0.1:${offPort}/api/v1/info`, { headers: { Authorization: "Bearer x" } });
  key = readFileSync(join(homeOn, "data", "admin.key"), "utf8").trim();
});
afterAll(() => { on?.kill(); off?.kill(); vnc.stop(true); rmSync(homeOn, { recursive: true, force: true }); rmSync(homeOff, { recursive: true, force: true }); });

const upgrade = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
const open = (headers: Record<string, string>) => new Promise<{ ws: WebSocket; first: Uint8Array }>((res, rej) => {
  const ws = new WebSocket(wsUrl, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => res({ ws, first: new Uint8Array(e.data as ArrayBuffer) });
  ws.onerror = () => rej(new Error("ws error"));
});

test("off unless configured: 404 and no capability", async () => {
  const k = readFileSync(join(homeOff, "data", "admin.key"), "utf8").trim();
  expect((await fetch(`http://127.0.0.1:${offPort}/api/v1/screen/ws`, { headers: { ...upgrade, Authorization: `Bearer ${k}` } })).status).toBe(404);
  const s = await (await fetch(`http://127.0.0.1:${offPort}/api/v1/screen`, { headers: { Authorization: `Bearer ${k}` } })).json() as { enabled: boolean };
  expect(s.enabled).toBe(false);
  expect(((await (await fetch(`http://127.0.0.1:${offPort}/api/v1/info`)).json()) as { capabilities: string[] }).capabilities).not.toContain("screen");
  expect(((await (await fetch(base + "/info")).json()) as { capabilities: string[] }).capabilities).toContain("screen");
});

test("guard: anonymous 401, the agent 403, a foreign Origin 403, plain GET 426", async () => {
  expect((await fetch(base + "/screen/ws", { headers: upgrade })).status).toBe(401);
  expect((await fetch(base + "/screen/ws", { headers: { ...upgrade, Authorization: `Bearer ${key}`, "X-Actor": "agent" } })).status).toBe(403);
  expect((await fetch(base + "/screen/ws", { headers: { ...upgrade, Authorization: `Bearer ${key}`, Origin: "http://evil.example" } })).status).toBe(403);
  expect((await fetch(base + "/screen/ws", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(426);
});

test("pipes bytes both ways, one session at a time, closes when idle, audits open and close", async () => {
  const { ws, first } = await open({ Authorization: `Bearer ${key}`, Origin: `http://127.0.0.1:${port}` });
  expect(new TextDecoder().decode(first)).toBe("RFB 003.889\n");
  ws.send(new TextEncoder().encode("RFB 003.008\n"));
  await Bun.sleep(200);
  expect(new TextDecoder().decode(new Uint8Array(received))).toBe("RFB 003.008\n");
  // A second viewer is refused while the first is open.
  expect((await fetch(base + "/screen/ws", { headers: { ...upgrade, Authorization: `Bearer ${key}` } })).status).toBe(409);
  const s = await (await fetch(base + "/screen", { headers: { Authorization: `Bearer ${key}` } })).json() as { active: unknown; listening: boolean };
  expect(s.active).not.toBeNull();
  expect(s.listening).toBe(true);
  // Screen-update requests keep flowing but do not count as input: idle (0.03 min ≈ 1.8 s) closes it with 4001.
  const timer = setInterval(() => ws.readyState === 1 && ws.send(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 10, 0, 10])), 300);
  const code = await new Promise<number>((res) => { ws.onclose = (e) => res(e.code); });
  clearInterval(timer);
  expect(code).toBe(4001);
  await Bun.sleep(100);
  const audit = await (await fetch(base + "/audit?action=screen.close", { headers: { Authorization: `Bearer ${key}` } })).json() as { audit: { action: string; attributes: { reason: string } }[] };
  expect(audit.audit[0].attributes.reason).toBe("Closed after no input");
  const opened = await (await fetch(base + "/audit?action=screen.open", { headers: { Authorization: `Bearer ${key}` } })).json() as { audit: { result: string }[] };
  expect(opened.audit.map((a) => a.result)).toContain("ok");
  expect(opened.audit.map((a) => a.result)).toContain("failed"); // the refused second viewer and the bad origin
}, 15_000);

test("takeover=1 replaces a stuck session", async () => {
  const a = await open({ Authorization: `Bearer ${key}` });
  const closed = new Promise<number>((res) => { a.ws.onclose = (e) => res(e.code); });
  const b = await new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(wsUrl + "?takeover=1", { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
    ws.onopen = () => res(ws); ws.onerror = () => rej(new Error("ws error"));
  });
  expect(await closed).toBe(4003);
  b.close();
});
