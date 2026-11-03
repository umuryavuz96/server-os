import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mask, publicItem, shortCommand } from "./steps";
import { Transcript, type FeedItem } from "./transcript";

const step = (o: Partial<FeedItem>): FeedItem => ({ id: "t1", kind: "step", ts: 1, status: "ok", ...o });

test("mask hides tokens, headers, passwords and opaque keys", () => {
  const cases: [string, string][] = [
    ["curl -H 'Authorization: Bearer abc123def456ghi789' https://x", "abc123def456ghi789"],
    ["TOKEN=abcdef123456 bun run x", "abcdef123456"],
    ["ADGUARD_PASSWORD='hunter two' ls", "hunter"],
    ["--password hunter2 --user me", "hunter2"],
    ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAA"],
    ["ghp_" + "a1".repeat(15), "a1a1a1a1"],
    ["xoxb-1234567890-abcdefghij", "abcdefghij"],
    ["bot 1234567890:AAEhBP0av28ABCDEFGHIJKLMNOPQRSTUVWXYZ12 sent", "AAEhBP0av28"],
    ["postgres://user:pw123@db:5432/x", "pw123"],
    ['cat {"api_key": "zzzz9999"}', "zzzz9999"],
    ["id Zx9Kq2Lm8Vb4Nc7Hd1Jf5Gt3Rw6Ys0PaQe", "Zx9Kq2Lm8Vb4"],
  ];
  for (const [c, secret] of cases) { const m = mask(c); expect(m).not.toContain(secret); expect(m).toContain("***"); }
});

test("mask keeps ordinary text, paths and commit hashes", () => {
  const t = "Edited server/ram.ts at 3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b: 358 pass";
  expect(mask(t)).toBe(t);
});

test("shell steps lose the command line, keep a short name", () => {
  const p = publicItem(step({ tool: "Shell", title: "Ran a command", detail: "SUDO=hunter2 bun test --token abc123def456 ./server", out: "358 pass", res: "358 pass" }));
  expect(p.detail).toBe("");
  expect(p.verb).toBe("Ran");
  expect(p.target).toBe("bun test");
  expect(p.res).toBe("358 pass");
  expect(JSON.stringify(p)).not.toContain("hunter2");
  expect(JSON.stringify(p)).not.toContain("abc123def456");
});

test("shell with a description uses it as target; monitors lose the command too", () => {
  expect(publicItem(step({ tool: "Shell", title: "Run server tests", detail: "bun test" })).target).toBe("Run server tests");
  const m = publicItem(step({ tool: "Monitor", title: "Monitor · inbox stream", detail: "watch.sh --key=abc" }));
  expect([m.verb, m.target, m.detail]).toEqual(["Watching", "inbox stream", ""]);
});

test("output of commands that print credentials is dropped", () => {
  for (const cmd of ["cat ~/.env", "printenv", "grep TOKEN .env", "env | sort", "security find-generic-password -s x"]) {
    expect(publicItem(step({ tool: "Shell", detail: cmd, out: "FOO=bar" })).out).toBe("");
  }
  expect(publicItem(step({ tool: "Read", detail: "/Users/x/.env", out: "A=b" })).out).toBe("");
  expect(publicItem(step({ tool: "Shell", detail: "ls", out: "a b" })).out).toBe("a b");
});

test("file steps keep the path and get counts through", () => {
  const e = publicItem(step({ tool: "Edit", title: "Edited a.ts", detail: "/Users/x/projects/server-dash/web/src/a.ts", add: 12, del: 3 }));
  expect([e.verb, e.target, e.add, e.del]).toEqual(["Edited", "web/src/a.ts", 12, 3]);
  expect(e.detail).toBe("/Users/x/projects/server-dash/web/src/a.ts");
});

test("agmsg send and receive are labelled", () => {
  const s = publicItem(step({ tool: "Shell", detail: "bash send.sh a b c 'hi'", agmsg: { dir: "out", team: "t", peer: "web-dev-1" } }));
  expect([s.verb, s.target]).toEqual(["Sent", "web-dev-1"]);
  const r = publicItem({ id: "e", kind: "event", ts: 1, text: "x", agmsg: { dir: "in", team: "t", peer: "root" } });
  expect([r.verb, r.target]).toEqual(["Received", "root"]);
});

test("thinking is clipped to 400, text is masked, original item untouched", () => {
  const it: FeedItem = { id: "a", kind: "assistant", ts: 1, thinking: true, text: "x".repeat(900) };
  expect(publicItem(it).text!.length).toBe(401);
  expect(it.text!.length).toBe(900);
  expect(publicItem({ id: "b", kind: "assistant", ts: 1, text: "token=abcdef123456" }).text).toBe("token=***");
});

test("shortCommand", () => {
  expect(shortCommand("cd /tmp && ls")).toBe("ls");
  expect(shortCommand("cd ~/p/x && bun test ./a")).toBe("bun test");
  expect(shortCommand("FOO=1 /opt/homebrew/bin/git commit -m x")).toBe("git commit");
});

// ---- the transcript side: counts, results, agmsg detection, thinking ----
const line = (o: object) => JSON.stringify(o) + "\n";
function session(keepThinking: boolean) {
  const f = join(mkdtempSync(join(tmpdir(), "steps-")), "s.jsonl");
  writeFileSync(f, "");
  const A = (uuid: string, content: unknown[]) => appendFileSync(f, line({ type: "assistant", uuid, timestamp: new Date(1000).toISOString(), message: { role: "assistant", model: "m", content } }));
  const R = (id: string, content: string, is_error = false) => appendFileSync(f, line({ type: "user", uuid: "r" + id, timestamp: new Date(2000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } }));
  const t = new Transcript(f); t.keepThinking = keepThinking;
  return { f, t, A, R };
}

test("transcript: edit counts, test result, agmsg send, thinking only when asked", () => {
  const { t, A, R } = session(true);
  A("u1", [{ type: "thinking", thinking: "plan it" }, { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/a/b.ts", old_string: "x\ny", new_string: "x\ny\nz\nw" } },
    { type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test", description: "tests" } },
    { type: "tool_use", id: "b2", name: "Bash", input: { command: 'bash ~/.agents/skills/agmsg/scripts/send.sh agent-chat backend-1 web-dev-1 "done"' } },
    { type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } }]);
  R("b1", "x\n358 pass\n0 fail\nRan 358 tests");
  R("g1", "a.ts:1\nb.ts:2");
  t.update();
  expect(t.get("e1")).toMatchObject({ add: 4, del: 2 });
  expect(t.get("b1")!.res).toBe("358 pass");
  expect(t.get("b2")!.agmsg).toEqual({ dir: "out", team: "agent-chat", peer: "web-dev-1" });
  expect(t.get("g1")!.res).toBe("2 matches");
  expect(t.items.some((i) => i.thinking && i.text === "plan it")).toBe(true);
  const off = session(false); off.A("u1", [{ type: "thinking", thinking: "plan it" }]); off.t.update();
  expect(off.t.items.length).toBe(0);
});

test("transcript: inbox stream notice carries agmsg in", () => {
  const { f, t } = session(false);
  appendFileSync(f, line({ type: "user", uuid: "n1", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "<task-notification><task-id>x</task-id><summary>Monitor event: \"agmsg inbox stream\"</summary><event>2026-11-02T11:29:17Z | agent-chat | web-dev-1 → backend-1 | hello</event></task-notification>" } }));
  t.update();
  expect(t.items.find((i) => i.id === "n1")!.agmsg).toEqual({ dir: "in", team: "agent-chat", peer: "web-dev-1" });
});
