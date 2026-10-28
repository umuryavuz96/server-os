import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript, describeStep, toolName, requestPrompt, requestStates } from "./transcript";

const T = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const L = (o: object) => JSON.stringify(o) + "\n";
const user = (uuid: string, content: unknown, s: number, extra = {}) => L({ type: "user", uuid, timestamp: T(s), message: { role: "user", content }, ...extra });
const asst = (uuid: string, content: unknown[], s: number) => L({ type: "assistant", uuid, timestamp: T(s), message: { role: "assistant", model: "claude-sonnet-5-5", content, usage: { input_tokens: 10, cache_read_input_tokens: 50_000 } } });

function file(lines: string) { const d = mkdtempSync(join(tmpdir(), "sd-bots-")); const p = join(d, "s.jsonl"); writeFileSync(p, lines); return p; }

test("telegram in, tool steps, telegram reply out", () => {
  const p = file(
    user("u1", '<channel source="plugin:telegram:telegram" chat_id="1" user="umur" ts="x">What\'s up?</channel>', 0, { isMeta: true, origin: { kind: "channel" } }) +
    asst("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List files" } }], 1) +
    user("r1", [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }], 3) +
    asst("a2", [{ type: "tool_use", id: "t2", name: "mcp__plugin_telegram_telegram__reply", input: { chat_id: "1", text: "**All good**" } }], 4) +
    L({ type: "system", subtype: "turn_duration", timestamp: T(5) }));
  const t = new Transcript(p); t.update();
  expect(t.items.map((i) => `${i.kind}/${i.via ?? i.status}`)).toEqual(["user/telegram", "step/ok", "step/running", "assistant/telegram"]);
  expect(t.items[0]).toMatchObject({ text: "What's up?", from: "umur" });
  expect(t.items[1]).toMatchObject({ title: "List files", ms: 2000, out: "a\nb" });
  expect(t.meta.working).toBeNull();
  expect(t.meta.contextTokens).toBe(50_010);
});

test("context and noise stay out of the chat", () => {
  const p = file(
    user("m1", "<system-reminder>x</system-reminder>", 0) +
    user("m2", "hook stuff", 0, { isMeta: true }) +
    L({ type: "attachment", uuid: "x", timestamp: T(0), attachment: { type: "date", date: "x" } }) +
    asst("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "No response requested." }], 1));
  const t = new Transcript(p); t.update();
  expect(t.items).toEqual([]);
});

test("monitor lifecycle: start, events, expiry, re-arm, TaskStop", () => {
  const mon = (id: string, s: number) => asst("a" + id, [{ type: "tool_use", id, name: "Monitor", input: { command: "watch.sh", description: "inbox", timeout_ms: 1800000 } }], s);
  const started = (id: string, task: string, s: number) => user("r" + id, [{ type: "tool_result", tool_use_id: id, content: `Monitor started (task ${task}, expires in 30m)` }], s);
  const note = (task: string, ev: string, s: number) => user("n" + task + s, `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "inbox"</summary>\n<event>${ev}</event>\n</task-notification>`, s);
  const p = file(mon("m1", 0) + started("m1", "aaa111", 1) + note("aaa111", "hello", 2) + note("aaa111", "[Monitor expired after 30m with 1 event delivered.]", 3) + mon("m2", 4) + started("m2", "bbb222", 5));
  const t = new Transcript(p); t.update();
  const [a, b] = [t.jobs.get("m1")!, t.jobs.get("m2")!];
  expect(a).toMatchObject({ taskId: "aaa111", events: 1, lastEvent: "hello", endReason: "timed out" });
  expect(b).toMatchObject({ taskId: "bbb222", ended: null, rearms: 1 });
  appendFileSync(p, asst("a9", [{ type: "tool_use", id: "s1", name: "TaskStop", input: { task_id: "bbb222" } }], 6));
  t.update();
  expect(t.jobs.get("m2")!.endReason).toBe("stopped");
});

test("incremental reads return only changed ids, partial lines wait", () => {
  const p = file(user("u1", "hi", 0));
  const t = new Transcript(p);
  expect(t.update()).toEqual(["u1"]);
  const line = asst("a1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/y.ts" } }], 1);
  appendFileSync(p, line.slice(0, 20)); expect(t.update()).toEqual([]);
  appendFileSync(p, line.slice(20)); expect(t.update()).toEqual(["t1"]);
  appendFileSync(p, user("r1", [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: true }], 2));
  expect(t.update()).toEqual(["t1"]);
  expect(t.get("t1")).toMatchObject({ title: "Read y.ts", status: "error" });
});

test("requests: pending → running when a job carries the id, failed on SD-FAILED", () => {
  const reqs = [{ id: "sd-ab12", channel: "x", kind: "watch" as const, name: "N", what: "W", options: {}, created: 0 }, { id: "sd-cd34", channel: "x", kind: "schedule" as const, name: "N", what: "W", options: {}, created: 0 }];
  const p = file(
    asst("a1", [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: "x", description: "NS mail sd-ab12" } }], 0) +
    asst("a2", [{ type: "text", text: "SD-FAILED sd-cd34: no Gmail access" }], 1));
  const t = new Transcript(p); t.update();
  expect(requestStates(t, reqs)).toEqual([{ id: "sd-ab12", status: "running", reason: null, job: "m1" }, { id: "sd-cd34", status: "failed", reason: "no Gmail access", job: null }]);
  expect(requestStates(null, reqs)[0].status).toBe("pending");
  expect(requestPrompt(reqs[0])).toContain('Put "sd-ab12" in the job');
});

test("tool names", () => {
  expect(toolName("mcp__claude-in-chrome__navigate")).toBe("Chrome · navigate");
  expect(toolName("mcp__plugin_telegram_telegram__reply")).toBe("Telegram · reply");
  expect(describeStep("CronCreate", { cron: "0 9 * * *", prompt: "brief" }).title).toBe("Scheduled a job");
});

test("an idle compaction does not leave the bot working", () => {
  const p = file(
    user("u1", "hello", 0) + asst("a1", [{ type: "text", text: "hi" }], 1) + L({ type: "system", subtype: "turn_duration", timestamp: T(2) }) +
    L({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: T(3) }) +
    user("s1", "This session is being continued from a previous conversation that ran out of context.", 3, { isCompactSummary: true }));
  const t = new Transcript(p); t.update();
  expect(t.meta.working).toBeNull();
  expect(t.items.at(-1)).toMatchObject({ kind: "event", text: "Compacted" });
});
