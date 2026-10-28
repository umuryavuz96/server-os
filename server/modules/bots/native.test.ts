import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeBots, botsProvider, cleanPrompt, shq, type Exec } from "./native";

// A fake tmux: a set of live sessions shared with every other program on the machine, and a log of the commands.
function fakeTmux(live: string[]) {
  const sessions = new Set(live);
  const calls: { cmd: string[]; stdin?: string }[] = [];
  const exec: Exec = (cmd, stdin) => {
    calls.push({ cmd, stdin });
    const [, sub, ...a] = cmd;
    const t = (a[a.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:$/, "");
    switch (sub) {
      case "list-sessions": return sessions.size ? { code: 0, out: [...sessions].join("\n") } : { code: 1, out: "no server running" };
      case "new-session": sessions.add(a[a.indexOf("-s") + 1]); return { code: 0, out: "" };
      case "kill-session": return sessions.delete(t) ? { code: 0, out: "" } : { code: 1, out: "can't find session" };
      case "capture-pane": return sessions.has(t) ? { code: 0, out: `screen of ${t}\n\n` } : { code: 1, out: "can't find pane" };
      default: return { code: 0, out: "" };
    }
  };
  return { sessions, calls, exec };
}

function setup(live: string[] = [], env = "") {
  const home = mkdtempSync(join(tmpdir(), "sos-native-"));
  const claudeJson = join(home, "claude.json");
  writeFileSync(claudeJson, JSON.stringify({ numStartups: 7, projects: { "/other": { hasTrustDialogAccepted: false, allowedTools: ["x"] } } }));
  writeFileSync(join(home, "env"), env);
  const t = fakeTmux(live);
  const none = "/nonexistent";
  const bots = new NativeBots({ home, exec: t.exec, claudeJson, envFile: join(home, "env"), pidAlive: () => false,
    agmsg: { dir: none }, catalogPaths: { claudeDir: none, agentsSkills: none, claudeJson: none, mcpJson: none } });
  return { home, claudeJson, bots, ...t };
}

const OWNER = ["bot-main", "bot-karpuz", "bot-voice", "sos", "work"];

test("lists only prefixed sessions, never the owner's", async () => {
  const { bots, exec } = setup([...OWNER, "sos-orphan"]);
  expect([...bots.sessions()]).toEqual(["sos-orphan"]);
  expect(bots.list()).toEqual([]); // the orphan isn't a known bot either
  bots.create({ name: "main" }); // a bot whose plain name equals the owner's "bot-main" tail
  expect(bots.list().map((b) => [b.channel, b.running])).toEqual([["main", false]]);
  expect(bots.alive("main")).toBe(false);
  expect(bots.terminal("main").ok).toBe(false);
  expect((await bots.send("main", "hi")).ok).toBe(false);
  expect((await bots.stop("main")).ok).toBe(true);
  expect(exec(["tmux", "list-sessions"]).out.split("\n")).toEqual(expect.arrayContaining(OWNER));
});

test("every tmux command targets an exact <prefix><name> session", async () => {
  const { bots, calls, sessions } = setup(OWNER);
  bots.create({ name: "testbot", model: "haiku" });
  expect((await bots.launch("testbot", null, 0)).ok).toBe(true);
  expect(sessions.has("sos-testbot")).toBe(true);
  expect(bots.terminal("testbot")).toMatchObject({ ok: true, contents: "screen of sos-testbot" });
  expect((await bots.send("testbot", "hello")).ok).toBe(true);
  expect(bots.key("testbot", "Escape").ok).toBe(true);
  expect((await bots.stop("testbot")).ok).toBe(true);
  for (const { cmd } of calls) {
    const i = cmd.indexOf("-t"), s = cmd.indexOf("-s");
    if (i >= 0) expect(cmd[i + 1]).toMatch(/^=sos-testbot:?$/);
    if (s >= 0) expect(cmd[s + 1]).toBe("sos-testbot");
  }
  for (const o of OWNER) expect(sessions.has(o)).toBe(true);
});

test("a custom prefix is honoured and validated", () => {
  const home = mkdtempSync(join(tmpdir(), "sos-native-"));
  const t = fakeTmux(["sos-a", "lab-a"]);
  const b = new NativeBots({ home, prefix: "lab-", exec: t.exec, claudeJson: join(home, "c.json"), envFile: join(home, "env"), agmsg: { dir: "/nonexistent" } });
  expect([...b.sessions()]).toEqual(["lab-a"]);
  expect(() => new NativeBots({ home, prefix: "a b;" })).toThrow();
});

test("create pre-accepts the folder trust without clobbering ~/.claude.json", () => {
  const { bots, claudeJson, home } = setup();
  const r = bots.create({ name: "recipes", model: "sonnet", effort: "high", permissionMode: "acceptEdits" });
  expect(r.ok).toBe(true);
  const cwd = realpathSync(join(home, "bots", "recipes"));
  const j = JSON.parse(readFileSync(claudeJson, "utf8"));
  expect(j.projects[cwd].hasTrustDialogAccepted).toBe(true);
  expect(j.numStartups).toBe(7);
  expect(j.projects["/other"]).toEqual({ hasTrustDialogAccepted: false, allowedTools: ["x"] });
  expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
  expect(bots.get("recipes")).toMatchObject({ cwd, model: "sonnet", effort: "high", permissionMode: "acceptEdits", telegram: null });
});

test("trust leaves an unreadable ~/.claude.json alone", () => {
  const { bots, claudeJson } = setup();
  writeFileSync(claudeJson, "{ half-written");
  expect(bots.trust("/x")).toBe(false);
  expect(readFileSync(claudeJson, "utf8")).toBe("{ half-written");
});

test("create validates name, model, effort, permission mode and token variable", () => {
  const { bots } = setup();
  expect(bots.create({ name: "Bad Name" }).ok).toBe(false);
  expect(bots.create({ name: "../x" }).ok).toBe(false);
  expect(bots.create({ name: "ok", model: "gpt" }).ok).toBe(false);
  expect(bots.create({ name: "ok", effort: "huge" }).ok).toBe(false);
  expect(bots.create({ name: "ok", permissionMode: "yolo" }).ok).toBe(false);
  expect(bots.create({ name: "ok", tokenEnv: "123456:ABCDEF" }).ok).toBe(false); // a token, not a variable name
  expect(bots.create({ name: "ok" }).ok).toBe(true);
  expect(bots.create({ name: "ok" }).ok).toBe(false); // duplicate
});

test("launch script: flags, resume and quoting", async () => {
  const { bots, home } = setup();
  bots.create({ name: "qq", model: "haiku", effort: "low" });
  const b = bots.get("qq")!;
  const s = bots.launchScript({ ...b, cwd: "/tmp/it's here" }, "last", null);
  expect(s).toContain(`cd '/tmp/it'\\''s here' || exit 1`);
  expect(s).toMatch(/exec '[^']*claude' '--model' 'haiku' '--effort' 'low' '--permission-mode' 'dontAsk' '--continue'\n/);
  expect(s).not.toContain("--channels");
  expect(bots.launchScript(b, "0b7c6a8e-1111-2222-3333-444455556666", null)).toContain(`'--resume' '0b7c6a8e-1111-2222-3333-444455556666'`);
  expect((await bots.launch("qq", "not-a-session; rm -rf /", 0)).ok).toBe(false);
  expect((await bots.launch("qq", "0b7c6a8e-1111-2222-3333-444455556666", 0)).ok).toBe(false); // not in its folder
  expect((await bots.launch("qq", null, 0)).ok).toBe(true);
  expect(statSync(join(home, "data", "bots", "qq", "launch.sh")).mode & 0o777).toBe(0o700);
  expect((await bots.launch("qq", null, 0)).ok).toBe(false); // already running
});

test("telegram: token comes from the named ~/.env variable, written only to the 0600 state file", async () => {
  const token = "123456789:" + "A".repeat(35);
  const { bots, home } = setup([], `TELEGRAM_TB_TOKEN=${token}\n`);
  bots.create({ name: "tb", tokenEnv: "TELEGRAM_TB_TOKEN" });
  expect(readFileSync(join(home, "data", "bots.json"), "utf8")).not.toContain(token);
  expect(bots.list()[0]).toMatchObject({ tokenSet: true, tokenKey: "TELEGRAM_TB_TOKEN", telegram: true });
  expect((await bots.launch("tb", null, 0)).ok).toBe(true);
  const envFile = join(home, "data", "bots", "tb", "telegram", ".env");
  expect(readFileSync(envFile, "utf8")).toBe(`TELEGRAM_BOT_TOKEN=${token}\n`);
  expect(statSync(envFile).mode & 0o777).toBe(0o600);
  const script = readFileSync(join(home, "data", "bots", "tb", "launch.sh"), "utf8");
  expect(script).toContain("'--channels' 'plugin:telegram@claude-plugins-official'");
  expect(script).toContain(`TELEGRAM_STATE_DIR='${join(home, "data", "bots", "tb", "telegram")}'`);
  expect(script).not.toContain(token);

  bots.create({ name: "notoken", tokenEnv: "MISSING_VAR" });
  expect(await bots.launch("notoken", null, 0)).toMatchObject({ ok: false });
});

test("send: bracketed paste of cleaned text via a tmux buffer, then Enter", async () => {
  const { bots, calls } = setup();
  bots.create({ name: "pp" });
  await bots.launch("pp", null, 0);
  calls.length = 0;
  await bots.send("pp", "line 1\r\nline 2 $(rm -rf ~) `x` 'q' \x1b[201~\x07done");
  expect(calls.map((c) => c.cmd.slice(1, 2)[0])).toEqual(["list-sessions", "load-buffer", "paste-buffer", "send-keys"]);
  expect(calls[1].stdin).toBe("line 1\nline 2 $(rm -rf ~) `x` 'q' [201~done");
  expect(calls[2].cmd).toContain("-p");
  expect(calls[3].cmd.at(-1)).toBe("Enter");
});

test("cleanPrompt and shq", () => {
  expect(cleanPrompt("a\tb\nc\x1b[2Jd\x00\x9b")).toBe("a\tb\nc[2Jd");
  expect(shq("it's")).toBe(`'it'\\''s'`);
});

test("remove stops the session, forgets the bot, keeps its folder", async () => {
  const { bots, sessions, home } = setup(OWNER);
  bots.create({ name: "gone" });
  await bots.launch("gone", null, 0);
  expect((await bots.remove("gone")).ok).toBe(true);
  expect(sessions.has("sos-gone")).toBe(false);
  expect(bots.get("gone")).toBeNull();
  expect(existsSync(join(home, "bots", "gone", "CLAUDE.md"))).toBe(true);
  expect(existsSync(join(home, "data", "bots", "gone"))).toBe(false);
  for (const o of OWNER) expect(sessions.has(o)).toBe(true);
});

test("handle: the /cos/* actions the Bots page uses", async () => {
  const { bots } = setup();
  expect((await bots.handle("bot/create", { name: "hh", model: "haiku" })).status).toBe(200);
  expect(((await bots.handle("botSessions", {})).body as { botSessions: { provider: string }[] }).botSessions[0].provider).toBe("native");
  expect((await bots.handle("bot/skill-scope", { channel: "hh" })).status).toBe(404);
  expect((await bots.handle("bot/conversations", { channel: "hh" })).body).toEqual({ ok: true, conversations: [] });
  expect((await bots.handle("bot/set-token", { channel: "hh", tokenEnv: "TG_H" })).status).toBe(200);
  expect(bots.get("hh")!.telegram).toEqual({ tokenEnv: "TG_H" });
});

test("botsProvider: one manager, or Claude OS and native side by side", () => {
  expect(botsProvider(undefined, true, true)).toBe("claudeOS");
  expect(botsProvider(undefined, false, true)).toBe("native");
  expect(botsProvider(undefined, false, false)).toBe(null);
  expect(botsProvider("native", true, true)).toBe("native");
  expect(botsProvider("native", true, false)).toBe(null);
  expect(botsProvider("claudeOS", false, true)).toBe(null);
  expect(botsProvider("both", true, true)).toBe("both");
  expect(botsProvider("both", true, false)).toBe("claudeOS"); // no tmux/claude: Claude OS alone
  expect(botsProvider("both", false, true)).toBe("native");
  expect(botsProvider("both", true, true, true)).toBe(null); // demo
});
