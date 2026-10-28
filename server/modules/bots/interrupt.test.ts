import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript";
import { DashSent } from "./dashsent";
import { paneBusy, settleAfterInterrupt, clearIfStale } from "./idle";

const T = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const L = (o: object) => JSON.stringify(o) + "\n";
const user = (uuid: string, content: unknown, s: number, extra = {}) => L({ type: "user", uuid, timestamp: T(s), message: { role: "user", content }, ...extra });
const asst = (uuid: string, content: unknown[], s: number) => L({ type: "assistant", uuid, timestamp: T(s), message: { role: "assistant", model: "claude-sonnet-5-5", content } });
const file = (lines: string) => { const p = join(mkdtempSync(join(tmpdir(), "sd-int-")), "s.jsonl"); writeFileSync(p, lines); return p; };
const tool = (id: string, s: number) => asst("a" + id, [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 99", description: "Wait" } }], s);
const parse = (lines: string) => { const t = new Transcript(file(lines)); t.update(); return t; };

// ---- every shape Claude Code writes when Escape stops a turn (checked against real ~/.claude/projects transcripts) ----
const shapes: [string, string][] = [
  ["a text block in an array (during thinking / streaming)", user("i", [{ type: "text", text: "[Request interrupted by user]" }], 5)],
  ["a plain string", user("i", "[Request interrupted by user]", 5)],
  ["with a trailing newline", user("i", [{ type: "text", text: "[Request interrupted by user]\n" }], 5)],
  ["flagged isMeta", user("i", [{ type: "text", text: "[Request interrupted by user]" }], 5, { isMeta: true })],
  ["for tool use, after the rejected tool_result", user("r", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "The user doesn't want to proceed" }], 4) + user("i", [{ type: "text", text: "[Request interrupted by user for tool use]" }], 5)],
  ["sharing a message with the tool_result", user("i", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "rejected" }, { type: "text", text: "[Request interrupted by user for tool use]\n" }], 5)],
];
for (const [name, line] of shapes) {
  test(`interrupt clears Working: ${name}`, () => {
    const t = parse(user("u", "do the thing", 0) + tool("t1", 2) + line);
    expect(t.meta.working).toBeNull();
    expect(t.items.filter((i) => i.kind === "event").map((i) => i.text)).toEqual(["Interrupted"]);
    expect(t.items.find((i) => i.id === "t1")?.status).not.toBe("running"); // no tool left spinning
  });
}

test("interrupt text mixed with real text keeps the text and still stops", () => {
  const t = parse(user("u", "go", 0) + user("m", [{ type: "text", text: "[Request interrupted by user]\n" }, { type: "text", text: "or wait, do X instead" }], 3));
  expect(t.meta.working?.since).toBe(Date.parse(T(3)));
  expect(t.items.map((i) => `${i.kind}:${i.text}`)).toEqual(["user:go", "event:Interrupted", "user:or wait, do X instead"]);
});

test("a sub-agent being interrupted does not end the main turn", () => {
  const t = parse(user("u", "go", 0) + user("s", [{ type: "text", text: "[Request interrupted by user]" }], 2, { isSidechain: true }));
  expect(t.meta.working).not.toBeNull();
});

// ---- the fallback: nothing at all is written when a turn is stopped before output ----
test("markStopped clears Working, closes steps and adds one event; later real line adds no second", () => {
  const p = file(user("u", "think hard", 0) + tool("t1", 1));
  const t = new Transcript(p); t.update();
  expect(t.meta.working).not.toBeNull();
  const ids = t.markStopped(Date.parse(T(4)), "Interrupted");
  expect(t.meta.working).toBeNull();
  expect(ids).toContain("t1");
  expect(t.items.find((i) => i.id === "t1")?.status).toBe("error");
  expect(t.items.filter((i) => i.text === "Interrupted")).toHaveLength(1);
  expect(t.update()).toContain("t1"); // the next update() still reports what changed, for SSE readers
  appendFileSync(p, user("i", [{ type: "text", text: "[Request interrupted by user]" }], 5));
  t.update();
  expect(t.items.filter((i) => i.text === "Interrupted")).toHaveLength(1);
  expect(t.markStopped(Date.parse(T(9)), "Interrupted")).toEqual([]); // nothing working, nothing to do
});

test("paneBusy reads Claude Code's status line", () => {
  expect(paneBusy("✻ Thinking… (12s · esc to interrupt)\n\n❯ \n  ⏵⏵ bypass permissions on")).toBe(true);
  expect(paneBusy("\x1b[2m✻ Crunched for 24s · done 10:39 AM\x1b[0m\n❯ \n  ⏵⏵ bypass permissions on")).toBe(false);
  expect(paneBusy("   \n\n")).toBeNull();
  expect(paneBusy("esc to interrupt\n" + "x\n".repeat(30))).toBe(false); // old scrollback doesn't count
});

test("settleAfterInterrupt: idle pane clears Working when the transcript wrote nothing", async () => {
  const t = new Transcript(file(user("u", "go", 0))); t.update();
  const panes = ["✻ Thinking… (esc to interrupt)", "✻ Thinking… (esc to interrupt)", "⎿ Interrupted · What should Claude do instead?\n❯ "];
  let n = 0;
  const r = await settleAfterInterrupt(t, () => panes[Math.min(n++, 2)], { stepMs: 1, graceMs: 1 });
  expect(r.stopped).toBe(true);
  expect(t.meta.working).toBeNull();
  expect(t.items.at(-1)).toMatchObject({ kind: "event", text: "Interrupted" });
});

test("settleAfterInterrupt: a pane that stays busy is reported, not faked", async () => {
  const t = new Transcript(file(user("u", "go", 0))); t.update();
  const r = await settleAfterInterrupt(t, () => "✻ Working (esc to interrupt)", { waitMs: 20, stepMs: 5 });
  expect(r).toMatchObject({ stopped: false, busy: true });
  expect(t.meta.working).not.toBeNull();
});

test("settleAfterInterrupt: an unreadable pane is not treated as stopped", async () => {
  const t = new Transcript(file(user("u", "go", 0))); t.update();
  expect((await settleAfterInterrupt(t, () => null, { waitMs: 10, stepMs: 2 })).stopped).toBe(false);
  expect(t.meta.working).not.toBeNull();
});

test("settleAfterInterrupt: Claude Code's own line arriving in the grace period wins", async () => {
  const p = file(user("u", "go", 0)); const t = new Transcript(p); t.update();
  const r = await settleAfterInterrupt(t, () => { appendFileSync(p, user("i", [{ type: "text", text: "[Request interrupted by user]" }], 3)); return "❯ "; }, { graceMs: 1 });
  expect(r.stopped).toBe(true);
  expect(t.items.filter((i) => i.kind === "event")).toHaveLength(1);
});

test("staleness guard: only an old Working plus an idle pane is cleared", async () => {
  const mk = () => { const t = new Transcript(file(user("u", "go", 0))); t.update(); return t; };
  const t0 = Date.parse(T(0));
  let t = mk();
  expect((await clearIfStale(t, () => "❯ ", { now: t0 + 30_000 })).cleared).toBe(false); // fresh: pane isn't even asked
  expect((await clearIfStale(t, () => "✻ (esc to interrupt)", { now: t0 + 600_000 })).cleared).toBe(false); // long tool call
  expect(t.meta.working).not.toBeNull();
  expect((await clearIfStale(t, () => null, { now: t0 + 600_000 })).cleared).toBe(false);
  const asked: number[] = [];
  expect((await clearIfStale(t, () => (asked.push(1), "❯ "), { now: t0 + 600_000 })).cleared).toBe(true);
  expect(t.meta.working).toBeNull();
  expect(t.items.some((i) => i.text === "Interrupted")).toBe(false); // not an interrupt, no event
  t = mk();
  const none: number[] = [];
  await clearIfStale(t, () => (none.push(1), "❯ "), { now: t0 + 1000 });
  expect(none).toEqual([]);
});

// ---- the same prompt, once ----
test("a dash prompt is claimed once; sending the same text twice on purpose shows twice", () => {
  const sent = new DashSent();
  sent.add("b", "run the report", "n1", Date.parse(T(0)));
  const mk = (lines: string) => { const t = new Transcript(file(lines), (x, ts) => sent.claim("b", x, ts)); t.update(); return t; };
  const t = mk(user("u1", "run the report", 1));
  expect(t.items).toHaveLength(1);
  expect(t.items[0]).toMatchObject({ via: "dash", nonce: "n1" });
  // one send never labels two lines (an echo of the text typed by hand in the terminal stays "terminal")
  const again = new Transcript(file(user("u1", "run the report", 1) + user("u2", "run the report", 2)), (x, ts) => sent.claim("b", x, ts)); again.update();
  expect(again.items.map((i) => i.via)).toEqual(["terminal", "terminal"]); // already claimed above
  // two deliberate sends of the same text: two entries, two nonces
  const s2 = new DashSent();
  s2.add("b", "ok", "a", Date.parse(T(0))); s2.add("b", "ok", "b", Date.parse(T(1)));
  const t2 = new Transcript(file(user("x1", "ok", 2) + user("x2", " ok ", 3)), (x, ts) => s2.claim("b", x, ts)); t2.update();
  expect(t2.items.map((i) => i.nonce)).toEqual(["a", "b"]);
});

test("a queued dash prompt is claimed through the queued_command attachment too", () => {
  const sent = new DashSent(); sent.add("b", "later please", "q1", Date.parse(T(0)));
  const t = new Transcript(file(L({ type: "attachment", uuid: "q", timestamp: T(30), attachment: { type: "queued_command", prompt: "later please" } })), (x, ts) => sent.claim("b", x, ts)); t.update();
  expect(t.items[0]).toMatchObject({ kind: "user", via: "dash", nonce: "q1" });
});

test("claims expire and can't come from the future", () => {
  const sent = new DashSent(); const t0 = Date.parse(T(100));
  sent.add("b", "x", "n", t0);
  expect(sent.claim("b", "x", t0 - 60_000)).toBeNull(); // a line older than the send is not its echo
  expect(sent.claim("b", "x", t0 + 31 * 60_000)).toBeNull();
  expect(sent.claim("b", "x", t0 + 1000)).toEqual({ nonce: "n" });
});

// ---- readers share one parser ----
test("changedSince gives every reader its own view (update() alone loses items to other readers)", () => {
  const p = file(user("u", "go", 0) + tool("t1", 1));
  const t = new Transcript(p); t.update();
  const feed = t.changedSince(0);
  expect(feed.ids).toEqual(["u", "t1"]);
  appendFileSync(p, user("r", [{ type: "tool_result", tool_use_id: "t1", content: "done" }], 3));
  t.update(); // another reader (snapshot, re-arm watcher) takes the ids from update()
  expect(t.changedSince(feed.cursor).ids).toEqual(["t1"]); // the feed still sees the step finish
});
