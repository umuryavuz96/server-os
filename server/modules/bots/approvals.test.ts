import { test, expect } from "bun:test";
import { Approvals, hookOutput, resolveChannel, summarize, trimInput, type Approval } from "./approvals";

const ask = (o: Partial<Approval> = {}): Approval => ({ id: "a1", channel: "voice", tool: "Bash", summary: "ls", created: 1, expires: Date.now() + 60_000, cwd: "/x", input: {}, suggestion: null, ...o });

test("summaries are one readable line per tool", () => {
  expect(summarize("Bash", { command: "rm -rf\n  node_modules" })).toBe("rm -rf node_modules");
  expect(summarize("Write", { file_path: "/a/b.txt", content: "x" })).toBe("/a/b.txt");
  expect(summarize("WebFetch", { url: "https://x.y" })).toBe("https://x.y");
  expect(summarize("mcp__x__y", { n: 1, q: "hello" })).toBe("hello");
  expect(summarize("Bash", { command: "x".repeat(500) }).length).toBe(161);
  expect(Object.values(trimInput({ content: "y".repeat(9000) }))[0]).toHaveLength(4001);
});

test("allow, always allow (first suggestion) and deny answer in Claude Code's contract", () => {
  const sug = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" };
  const a = ask({ suggestion: sug });
  expect(hookOutput(a, { behavior: "allow" })).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  expect(hookOutput(a, { behavior: "allow", always: true }).hookSpecificOutput.decision).toEqual({ behavior: "allow", updatedPermissions: [sug] });
  expect(hookOutput(ask(), { behavior: "allow", always: true }).hookSpecificOutput.decision).toEqual({ behavior: "allow" }); // nothing to remember
  expect(hookOutput(a, { behavior: "deny", message: " no " }).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "no" });
  expect((hookOutput(a, { behavior: "deny" }).hookSpecificOutput.decision as { message: string }).message).toContain("denied");
});

test("an ask settles once: decided, withdrawn or expired", async () => {
  let changes = 0;
  const s = new Approvals(() => changes++);
  const p = s.add(ask());
  expect(s.pending("voice")).toHaveLength(1);
  expect(s.pending("other")).toHaveLength(0);
  expect(s.counts()).toEqual({ voice: 1 });
  expect(s.decide("a1", { behavior: "allow" })).toBe(true);
  expect(await p).toEqual({ behavior: "allow" });
  expect(s.decide("a1", { behavior: "deny" })).toBe(false);
  const w = s.add(ask({ id: "a2" }));
  s.withdraw("a2");
  expect(await w).toBeNull();
  expect(await s.add(ask({ id: "a3", expires: Date.now() + 5 }))).toBeNull();
  expect(s.pending()).toHaveLength(0);
  expect(changes).toBe(6);
});

test("Telegram pings are deduped per ask and rate-limited per bot", () => {
  const sent: string[] = [];
  const s = new Approvals(() => {}, (t) => sent.push(t));
  void s.add(ask({ id: "1" })); void s.add(ask({ id: "2" })); void s.add(ask({ id: "3", summary: "pwd" }));
  expect(sent).toEqual(["🔐 voice asks: Bash ls — answer in Server Dash Bots tab"]);
  void s.add(ask({ id: "4", channel: "telegram" }));
  expect(sent[1]).toContain("main asks");
  for (const a of s.pending()) s.withdraw(a.id);
});

test("the asking bot is found by session, folder, then Telegram state folder; stopped bots never match", () => {
  const bots = [{ channel: "voice", cwd: "/h/bots/voice", pid: 11, running: true }, { channel: "telegram", cwd: "/h", pid: 12, running: true }, { channel: "old", cwd: "/h/bots/old", pid: null, running: false }];
  const of = (pid: number) => (pid === 11 ? "s-voice" : "s-main");
  expect(resolveChannel(bots, { sessionId: "s-main", cwd: "/zzz" }, of)).toBe("telegram");
  expect(resolveChannel(bots, { cwd: "/h/bots/voice/" }, of)).toBe("voice");
  expect(resolveChannel(bots, { stateDir: "/data/bots/voice/telegram" }, of)).toBe("voice");
  expect(resolveChannel(bots, { stateDir: "/x/.claude/channels/voice" }, of)).toBe("voice");
  expect(resolveChannel(bots, { cwd: "/h/bots/old" }, of)).toBeNull();
  expect(resolveChannel(bots, {}, of)).toBeNull();
});
