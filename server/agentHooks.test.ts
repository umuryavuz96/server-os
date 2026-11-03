import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let d = "";
const base = { env: { SECRET: "x" }, model: "opus", hooks: {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "node ~/.claude/hooks/skill-dispatch.js", timeout: 5 }, { type: "command", command: "/x/triage.py", timeout: 6 }] }],
  PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "/x/agent-pretrust.py", timeout: 10 }] }],
} };
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "hooks-"));
  process.env.CLAUDE_SETTINGS_FILE = join(d, "settings.json"); process.env.HOOKS_DATA_DIR = join(d, "data"); process.env.HOOK_LOG_DIR = join(d, "logs");
  writeFileSync(process.env.CLAUDE_SETTINGS_FILE, JSON.stringify(base, null, 2));
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

test("list gives names, ids, timeouts", async () => {
  const { listHooks } = await import("./agentHooks");
  const l = listHooks();
  expect(l.length).toBe(3);
  expect(l.find((h) => h.name === "Prompt triage")?.timeout).toBe(6);
  expect(l.find((h) => h.event === "PreToolUse")?.matcher).toBe("Agent");
});
test("off then on restores the exact file, other keys untouched, backup made", async () => {
  const { listHooks, setHookEnabled, backups } = await import("./agentHooks");
  const before = readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8");
  const id = listHooks().find((h) => h.name === "Prompt triage")!.id;
  const off = setHookEnabled(id, false);
  expect(off.find((h) => h.id === id)?.enabled).toBe(false);
  const mid = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8"));
  expect(mid.env.SECRET).toBe("x");
  expect(mid.hooks.UserPromptSubmit[0].hooks.length).toBe(1);
  expect(backups().length).toBe(1);
  setHookEnabled(id, true);
  expect(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).toBe(before);
});
test("last hook of an event leaves no empty event; rollback restores", async () => {
  const { listHooks, setHookEnabled, rollback } = await import("./agentHooks");
  const id = listHooks().find((h) => h.event === "PreToolUse")!.id;
  setHookEnabled(id, false);
  expect(JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).hooks.PreToolUse).toBeUndefined();
  rollback();
  expect(JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).hooks.PreToolUse.length).toBe(1);
  expect(listHooks().filter((h) => !h.enabled).length).toBe(0);
});
test("unknown id throws and leaves no temp files", async () => {
  const { setHookEnabled } = await import("./agentHooks");
  expect(() => setHookEnabled("nope", false)).toThrow();
  expect(readdirSync(d).filter((n) => n.includes("tmp")).length).toBe(0);
});
test("log stats count failures and latency", async () => {
  const { logStats } = await import("./agentHooks");
  mkdtempSync; process.env.HOOK_LOG_DIR = d;
  writeFileSync(join(d, "t.jsonl"), [{ ts: "2026-11-02T10:00:00", ms: 100 }, { ts: "2026-11-02T10:01:00", ms: 300, err: "boom" }].map((x) => JSON.stringify(x)).join("\n"));
  const s = logStats("t.jsonl");
  expect(s.runs).toBe(2); expect(s.failures).toBe(1); expect(s.avgMs).toBe(200);
});

test("a line appended to a hook log fires an event; no timer", async () => {
  const { onHookFire, hookNodes } = await import("./agentHooks");
  mkdirSync(process.env.HOOK_LOG_DIR!, { recursive: true });
  writeFileSync(join(process.env.HOOK_LOG_DIR!, "triage.jsonl"), JSON.stringify({ ts: "2026-11-02T10:00:00", ms: 5 }) + "\n"); // old line: not replayed
  const got: { script: string; ok: boolean; ms: number | null }[] = [];
  const off = onHookFire((f) => got.push(f));
  await new Promise((r) => setTimeout(r, 100));
  appendFileSync(join(process.env.HOOK_LOG_DIR!, "triage.jsonl"), JSON.stringify({ ts: "2026-11-02T10:05:00", ms: 120, err: "x" }) + "\n");
  for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
  off();
  expect(got).toEqual([expect.objectContaining({ script: "triage.py", ok: false, ms: 120 })]);
  expect(hookNodes().some((n) => n.script === "triage.py")).toBe(true);
});

test("dry-run lines never fire; skip lines fire as skipped with their reason", async () => {
  const { onHookFire } = await import("./agentHooks");
  mkdirSync(process.env.HOOK_LOG_DIR!, { recursive: true });
  const f = join(process.env.HOOK_LOG_DIR!, "auto-ack.jsonl");
  writeFileSync(f, "");
  const got: { skipped?: boolean; reason?: string; ms: number | null }[] = [];
  const off = onHookFire((x) => got.push(x));
  await new Promise((r) => setTimeout(r, 100));
  appendFileSync(f, JSON.stringify({ ts: "2026-11-02T10:05:00", ack: "x", dry: true }) + "\n" + JSON.stringify({ ts: "2026-11-02T10:06:00", skip: true, reason: "greeting", dry: true }) + "\n"
    + JSON.stringify({ ts: "2026-11-02T10:07:00", skip: true, reason: "greeting", latency_ms: 9 }) + "\n" + JSON.stringify({ ts: "2026-11-02T10:08:00", ack: "Checking", latency_ms: 8 }) + "\n");
  for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  off();
  expect(got.length).toBe(2);
  expect(got[0]).toEqual(expect.objectContaining({ skipped: true, reason: "greeting", ms: 9 }));
  expect(got[1].skipped).toBeUndefined();
});
