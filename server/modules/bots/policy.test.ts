import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { NativeBots, type Exec } from "./native";
import { accessJson, defaultPolicy, identityBlock, secretsFile, settingsJson, withDefaults, withIdentity, IDENTITY_START, type BotPolicy } from "./policy";

// ---------- a schema check against the trimmed Claude Code settings schema ----------
type Node = { properties?: Record<string, Node>; additionalProperties?: false; items?: Node & { pattern?: string }; enum?: unknown[] };
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-code-settings.schema.slim.json"), "utf8")) as Node;
function validate(v: unknown, n: Node, at = "$"): string[] {
  const errs: string[] = [];
  if (n.enum && !n.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (Array.isArray(v) && n.items) v.forEach((x, i) => {
    if (n.items!.pattern && !new RegExp(n.items!.pattern).test(String(x))) errs.push(`${at}[${i}]: "${x}" is not a permission rule`);
    if (n.items!.properties) errs.push(...validate(x, n.items!, `${at}[${i}]`));
  });
  else if (v && typeof v === "object" && n.properties) for (const [k, x] of Object.entries(v)) {
    if (!(k in n.properties)) { if (n.additionalProperties === false || at === "$") errs.push(`${at}.${k}: unknown key`); continue; }
    errs.push(...validate(x, n.properties[k], `${at}.${k}`));
  }
  return errs;
}

const CTX = { cwd: "/srv/bots/alpha", home: "/srv", claudeDir: "/Users/o/.claude", permissionMode: "dontAsk", agmsg: { scripts: "/a/agmsg/scripts", skillDir: "/a/agmsg", storage: "/a/store" },
  globalSkills: [{ id: "global:ponytail", name: "ponytail" }, { id: "global:pazar", name: "pazar" }], userMcp: ["posthog", "cronitor"],
  mcpjsonOn: ["playwright"], mcpjsonOff: ["supabase"], mcpOn: ["cronitor", "playwright"] };
const pol = (f: (p: BotPolicy) => void = () => {}) => { const p = defaultPolicy(); f(p); return p; };

test("settings.json for every preset × network × sandbox matches the Claude Code settings schema", () => {
  for (const preset of ["safe", "dev", "full"] as const) for (const network of [true, false]) for (const sandbox of [true, false]) {
    const s = settingsJson(pol((p) => { p.tools.preset = preset; p.scope = { folders: [{ path: "/data/shared", write: false }], network, sandbox, readAnywhere: false };
      p.skills = { "global:pazar": false }; p.plugins = { "slack@claude-plugins-official": false }; p.mcp = { "user:posthog": false, "mcpjson:playwright": true };
      p.tools.allow = ["Bash(npm run *)"]; p.tools.deny = ["WebFetch(domain:evil.example)"]; }), CTX);
    expect(validate(s, SCHEMA)).toEqual([]);
  }
});

test("safe preset: own folder only, secrets and destructive commands denied, agmsg scripts allowed", () => {
  const s = settingsJson(pol(), CTX) as { permissions: Record<string, unknown>; sandbox?: unknown };
  const { allow, deny } = s.permissions as { allow: string[]; deny: string[] };
  expect(s.permissions.defaultMode).toBe("dontAsk");
  expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  expect(s.permissions.disableBypassPermissionsMode).toBe("disable");
  expect(s.permissions.additionalDirectories).toBeUndefined();
  expect(allow).toEqual(expect.arrayContaining(["Read(//srv/bots/alpha/**)", "Edit(//srv/bots/alpha/**)", "Bash(/a/agmsg/scripts/send.sh *)", "Bash(/a/agmsg/scripts/watch.sh *)", "mcp__cronitor"]));
  expect(allow).not.toContain("Bash"); // safe never allows every command
  expect(deny).toEqual(expect.arrayContaining(["Read(~/.env)", "Bash(* ~/.env*)", "Bash(rm -rf *)", "Bash(sudo *)", "Bash(git push*)", "Bash(curl * | sh*)", "Bash(tmux *)", "Edit(//srv/bots/alpha/.claude/**)"]));
  expect(s.sandbox).toBeUndefined();
});

test("scope: extra folders, network off, sandbox", () => {
  const s = settingsJson(pol((p) => { p.scope = { folders: [{ path: "/data/ro", write: false }, { path: "/data/rw", write: true }], network: false, sandbox: true, readAnywhere: false }; }), CTX) as
    { permissions: { allow: string[]; deny: string[]; additionalDirectories: string[] }; sandbox: { filesystem: Record<string, string[]>; network: { allowedDomains: string[] } } };
  expect(s.permissions.additionalDirectories).toEqual(["/data/ro", "/data/rw"]);
  expect(s.permissions.allow).toContain("Read(//data/ro/**)");
  expect(s.permissions.allow).not.toContain("Edit(//data/ro/**)");
  expect(s.permissions.allow).toContain("Edit(//data/rw/**)");
  expect(s.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Bash(curl *)"]));
  expect(s.permissions.allow).not.toContain("WebFetch");
  expect(s.sandbox.filesystem.denyRead).toEqual(["~/"]);
  expect(s.sandbox.filesystem.allowRead).toEqual(["/srv/bots/alpha", "/data/ro", "/data/rw", "/a/agmsg", "/a/store"]);
  expect(s.sandbox.filesystem.allowWrite).toEqual(["/srv/bots/alpha", "/data/rw", "/a/agmsg", "/a/store"]);
  expect(s.sandbox.network.allowedDomains).toEqual([]);
});

test("custom rules: invalid ones are dropped, a custom deny wins over the preset allow", () => {
  const s = settingsJson(pol((p) => { p.tools.allow = ["Bash(make *)", "rm -rf /", "Nope(x)"]; p.tools.deny = ["Read"]; }), CTX) as { permissions: { allow: string[]; deny: string[] } };
  expect(s.permissions.allow).toContain("Bash(make *)");
  expect(s.permissions.allow).not.toContain("rm -rf /");
  expect(s.permissions.allow).not.toContain("Nope(x)");
  expect(s.permissions.allow).not.toContain("Read");
  expect(s.permissions.deny).toContain("Read");
});

test("secretsFile: only the chosen keys, quoted for sh", () => {
  const env = { A_KEY: "it's", B_KEY: "x", OTHER: "nope" };
  expect(secretsFile(env, ["A_KEY", "MISSING", "bad key"])).toBe(`A_KEY='it'\\''s'\n`);
});

test("accessJson: the telegram plugin's format, owners pre-approved, an existing file kept", () => {
  expect(accessJson(null, ["123456789"])).toEqual({ dmPolicy: "allowlist", allowFrom: ["123456789"], groups: {}, pending: {} });
  expect(accessJson(null, [])).toEqual({ dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} });
  const cur = { dmPolicy: "pairing", allowFrom: ["1"], groups: { "-100": { requireMention: true, allowFrom: [] } }, pending: { abc: { senderId: "9" } }, ackReaction: "👀" };
  expect(accessJson(cur, ["1", "2"])).toEqual({ ...cur, allowFrom: ["1", "2"] });
});

test("identity block: replaced in place, persona kept", () => {
  const b = identityBlock({ name: "alpha", role: "researcher", owner: "alex", tmux: "sos-alpha", cwd: "/b/alpha", team: "server-os", scripts: "/s", peers: [{ name: "beta", role: "writer" }] });
  expect(b).toContain("`beta` — writer");
  expect(b).toContain(`/s/send.sh server-os alpha <agent> "<message>"`);
  const md = withIdentity("# alpha\n\nBe brief.\n", b);
  expect(md.startsWith(`# alpha\n\n${IDENTITY_START}`)).toBe(true);
  expect(md).toContain("Be brief.");
  const again = withIdentity(md, b.replace("researcher", "editor"));
  expect(again).toContain("Role: editor");
  expect(again.split(IDENTITY_START).length).toBe(2);
});

// ---------- NativeBots with a fake world: global files to read, a fake agmsg and a recording exec ----------
function world() {
  const root = mkdtempSync(join(tmpdir(), "sos-policy-"));
  const g = { claudeDir: join(root, "dot-claude"), agentsSkills: join(root, "agents-skills"), claudeJson: join(root, "claude.json"), mcpJson: join(root, "mcp.json") };
  for (const [d, n] of [[join(g.claudeDir, "skills"), "ponytail"], [join(g.claudeDir, "skills"), "pazar"], [g.agentsSkills, "supabase"], [g.agentsSkills, "agmsg"]] as const) {
    mkdirSync(join(d, n), { recursive: true });
    writeFileSync(join(d, n, "SKILL.md"), `---\nname: ${n}\ndescription: the ${n} skill\n---\n`);
  }
  mkdirSync(join(g.claudeDir, "plugins"), { recursive: true });
  writeFileSync(join(g.claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "slack@official": [{}], "caveman@caveman": [{}] } }));
  writeFileSync(join(g.claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "caveman@caveman": true } }));
  writeFileSync(g.claudeJson, JSON.stringify({ mcpServers: { posthog: { command: "ph" }, cronitor: { command: "cr" } }, projects: {} }));
  writeFileSync(g.mcpJson, JSON.stringify({ mcpServers: { playwright: { command: "pw", env: { K: "v" } }, supabase: { url: "https://x" } } }));
  const ag = join(root, "agmsg");
  mkdirSync(join(ag, "scripts"), { recursive: true });
  for (const s of ["join.sh", "send.sh"]) writeFileSync(join(ag, "scripts", s), "");
  writeFileSync(join(root, "env"), "TELEGRAM_X=123:abc\nOPENAI_KEY=sk-1\nGH_TOKEN=ghp_2\n");
  const calls: string[][] = [];
  const live = new Set<string>();
  const exec: Exec = (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "list-sessions") return live.size ? { code: 0, out: [...live].join("\n") } : { code: 1, out: "" };
    if (cmd[1] === "new-session") live.add(cmd[cmd.indexOf("-s") + 1]);
    if (cmd.some((c) => c.endsWith("/history.sh"))) return { code: 0, out: "  ○ [2026-10-27 01:00:00] alpha → beta: ping from alpha\n  ● [2026-10-27 01:00:05] beta → alpha: pong\\nbye" };
    if (cmd.some((c) => c.endsWith("/team.sh"))) return { code: 0, out: "Team: server-os\n\n  alpha (claude-code) — /b/alpha\n  beta (claude-code) — /b/beta\n\n2 member(s)" };
    return { code: 0, out: "" };
  };
  const home = join(root, "home");
  const bots = new NativeBots({ home, exec, claudeJson: g.claudeJson, envFile: join(root, "env"), pidAlive: () => false, catalogPaths: g,
    agmsg: { dir: ag, storage: join(root, "store") }, team: "server-os", ownerChatIds: ["123456789"], ownerName: "alex" });
  return { root, g, ag, bots, calls, home };
}
const hashTree = (d: string): string => {
  const h = createHash("sha256");
  const walk = (p: string) => { for (const f of readdirSync(p).sort()) { const q = join(p, f); const st = lstatSync(q); h.update(q); if (st.isDirectory()) walk(q); else h.update(readFileSync(q)); } };
  walk(d);
  return h.digest("hex");
};

test("create: workspace files, agmsg join with the store override and monitor delivery", () => {
  const { bots, calls, ag, root } = world();
  expect(bots.create({ name: "alpha", model: "haiku", preset: "safe", role: "researcher" }).ok).toBe(true);
  const cwd = bots.get("alpha")!.cwd;
  const env = `AGMSG_STORAGE_PATH=${join(root, "store")}`;
  expect(calls).toContainEqual(["/usr/bin/env", env, "bash", join(ag, "scripts", "join.sh"), "server-os", "alpha", "claude-code", cwd]);
  expect(calls).toContainEqual(["/usr/bin/env", env, "bash", join(ag, "scripts", "delivery.sh"), "set", "monitor", "claude-code", cwd]);
  const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
  expect(validate(s, SCHEMA)).toEqual([]);
  expect(s.permissions.allow).toContain(`Bash(${join(ag, "scripts")}/send.sh *)`);
  expect(s.permissions.allow).toEqual(expect.arrayContaining(["mcp__posthog", "mcp__cronitor"])); // user servers load by default
  expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain("Role: researcher");
  expect(bots.get("alpha")!.permissionMode).toBe("dontAsk");
  bots.create({ name: "beta" });
  bots.writeWorkspace("alpha");
  expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain("- `beta`");
});

test("picker: writes only inside the bot folder; global files untouched", () => {
  const { bots, g, root } = world();
  const before = [g.claudeDir, g.agentsSkills].map(hashTree).concat([g.claudeJson, g.mcpJson].map((f) => readFileSync(f, "utf8")));
  bots.create({ name: "pick" });
  const cwd = bots.get("pick")!.cwd;
  const r = bots.saveSettings("pick", { skills: { "global:pazar": false, "agents:supabase": true }, plugins: { "slack@official": false },
    mcp: { "user:posthog": false, "mcpjson:playwright": true } });
  expect(r.ok).toBe(true);
  const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
  expect(s.skillOverrides).toEqual({ pazar: "off" });
  expect(s.enabledPlugins).toEqual({ "slack@official": false });
  expect(s.deniedMcpServers).toEqual([{ serverName: "posthog" }]);
  expect(s.enabledMcpjsonServers).toEqual(["playwright"]);
  expect(s.disabledMcpjsonServers).toEqual(["supabase"]);
  expect(s.permissions.allow).toEqual(expect.arrayContaining(["mcp__playwright", "mcp__cronitor"]));
  expect(s.permissions.allow).not.toContain("mcp__posthog");
  expect(readlinkSync(join(cwd, ".claude", "skills", "supabase"))).toBe(join(g.agentsSkills, "supabase"));
  const mcp = join(cwd, ".mcp.json");
  expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual({ mcpServers: { playwright: { command: "pw", env: { K: "v" } } } });
  expect(statSync(mcp).mode & 0o777).toBe(0o600);
  // turning things off again removes only what Server OS linked
  mkdirSync(join(cwd, ".claude", "skills", "mine"), { recursive: true });
  bots.saveSettings("pick", { skills: {}, mcp: {} });
  expect(existsSync(join(cwd, ".claude", "skills", "supabase"))).toBe(false);
  expect(existsSync(join(cwd, ".claude", "skills", "mine"))).toBe(true);
  expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual({ mcpServers: {} });
  // nothing outside the bot folder changed (the trust entry in claude.json is the one intended write)
  const after = [g.claudeDir, g.agentsSkills].map(hashTree).concat([g.mcpJson].map((f) => readFileSync(f, "utf8")));
  expect(after).toEqual([before[0], before[1], before[3]]);
  const cj = JSON.parse(readFileSync(g.claudeJson, "utf8"));
  expect(cj.mcpServers).toEqual(JSON.parse(before[2]).mcpServers);
  expect(Object.keys(cj.projects)).toEqual([cwd]);
  expect(root).toBeTruthy();
});

test("isolated: own CLAUDE_CONFIG_DIR with its own trust; global skills and user MCP opt-in via the bot folder", async () => {
  const { bots, g, home } = world();
  bots.create({ name: "iso", isolated: true, skills: { "global:ponytail": true }, mcp: { "user:cronitor": true } });
  const cwd = bots.get("iso")!.cwd;
  expect(readlinkSync(join(cwd, ".claude", "skills", "ponytail"))).toBe(join(g.claudeDir, "skills", "ponytail"));
  expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers).toEqual({ cronitor: { command: "cr" } });
  expect((await bots.launch("iso", null, 0)).ok).toBe(true);
  const cd = join(home, "data", "bots", "iso", "claude");
  expect(JSON.parse(readFileSync(join(cd, ".claude.json"), "utf8")).projects[cwd].hasTrustDialogAccepted).toBe(true);
  expect(readFileSync(join(home, "data", "bots", "iso", "launch.sh"), "utf8")).toContain(`export CLAUDE_CONFIG_DIR='${cd}'`);
});

test("globalInstructions: off by default writes claudeMdExcludes for ~/.claude/CLAUDE.md and rules; on, isolated and legacy bots do not", () => {
  const { bots, g } = world();
  const read = (n: string) => JSON.parse(readFileSync(join(bots.get(n)!.cwd, ".claude", "settings.json"), "utf8"));
  bots.create({ name: "gi-off" });
  expect(read("gi-off").claudeMdExcludes).toEqual([join(g.claudeDir, "CLAUDE.md"), join(g.claudeDir, "rules", "**")]);
  bots.create({ name: "gi-on", globalInstructions: true });
  expect(read("gi-on").claudeMdExcludes).toBeUndefined();
  bots.create({ name: "gi-iso", isolated: true });
  expect(read("gi-iso").claudeMdExcludes).toBeUndefined();
  expect(withDefaults({}).globalInstructions).toBe(true); // saved before the option existed
  expect(withDefaults(undefined).globalInstructions).toBe(false);
  expect(bots.saveSettings("gi-off", { globalInstructions: true }).ok).toBe(true);
  expect(read("gi-off").claudeMdExcludes).toBeUndefined();
});

test("secrets: only ticked ~/.env keys reach the bot, through a 0600 file; the launch script drops the rest of the environment", async () => {
  const { bots, home } = world();
  bots.create({ name: "sec", secrets: ["OPENAI_KEY"], folders: [{ path: "/private/tmp", write: false }] });
  expect((await bots.launch("sec", null, 0)).ok).toBe(true);
  const sd = join(home, "data", "bots", "sec");
  expect(readFileSync(join(sd, "secrets.env"), "utf8")).toBe("OPENAI_KEY='sk-1'\n");
  expect(statSync(join(sd, "secrets.env")).mode & 0o777).toBe(0o600);
  const sh = readFileSync(join(sd, "launch.sh"), "utf8");
  expect(sh).toContain(`exec /usr/bin/env -i "$@" /bin/sh "$0"`);
  expect(sh).toContain(`set -a; . '${join(sd, "secrets.env")}'; set +a`);
  expect(sh).not.toContain("sk-1");
  expect(sh).not.toContain("ghp_2");
  expect(sh).toMatch(/'--add-dir' '\/private\/tmp'\n/);
  // the env -i re-exec really keeps only KEEP_ENV + what the script sets
  const probe = join(sd, "probe.sh");
  writeFileSync(probe, sh.replace(/^exec '[^\n]*$/m, "env").replace(/^echo \$\$ > .*$/m, ""), { mode: 0o700 });
  const r = Bun.spawnSync(["/bin/sh", probe], { env: { HOME: "/h", USER: "u", LEAK_ME: "x", GH_TOKEN: "ghp_2", PATH: "/usr/bin:/bin" } });
  const out = r.stdout.toString();
  expect(out).toContain("OPENAI_KEY=sk-1");
  expect(out).toContain("HOME=/h");
  expect(out).not.toContain("LEAK_ME");
  expect(out).not.toContain("GH_TOKEN");
  expect(out).toContain("AGMSG_STORAGE_PATH=");
});

test("telegram: owner chats pre-approved in access.json before start", async () => {
  const { bots, home } = world();
  bots.create({ name: "tg", tokenEnv: "TELEGRAM_X" });
  bots.saveSettings("tg", { ownerChatIds: "111, 222" });
  expect((await bots.launch("tg", null, 0)).ok).toBe(true);
  const f = join(home, "data", "bots", "tg", "telegram", "access.json");
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ dmPolicy: "allowlist", allowFrom: ["123456789", "111", "222"], groups: {}, pending: {} });
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("settings validation", () => {
  const { bots } = world();
  bots.create({ name: "val" });
  expect(bots.saveSettings("val", { preset: "yolo" }).ok).toBe(false);
  expect(bots.saveSettings("val", { folders: [{ path: "/" }] }).ok).toBe(false);
  expect(bots.saveSettings("val", { folders: [{ path: "~" }] }).ok).toBe(false);
  expect(bots.saveSettings("val", { folders: [{ path: "~/.ssh" }] }).ok).toBe(false);
  expect(bots.saveSettings("val", { folders: [{ path: "relative/x" }] }).ok).toBe(false);
  expect(bots.saveSettings("val", { allow: ["rm -rf /"] }).ok).toBe(false);
  expect(bots.saveSettings("val", { secrets: ["sk-live-123=abc"] }).ok).toBe(false);
  expect(bots.saveSettings("val", { ownerChatIds: ["@me"] }).ok).toBe(false);
  expect(bots.saveSettings("val", { permissionMode: "yolo" }).ok).toBe(false);
  expect(bots.saveSettings("val", { allow: "Bash(make *)\nWebFetch(domain:example.com)", network: false, sandbox: true }).ok).toBe(true);
  expect(bots.policy(bots.get("val")!)).toMatchObject({ tools: { allow: ["Bash(make *)", "WebFetch(domain:example.com)"] }, scope: { network: false, sandbox: true } });
});

test("agmsg: members and parsed history; a missing install is reported with how to get it", async () => {
  const { bots } = world();
  bots.create({ name: "alpha" });
  expect(bots.messages("alpha")).toMatchObject({ ok: true, team: "server-os", members: ["alpha", "beta"],
    messages: [{ unread: false, from: "alpha", to: "beta", body: "ping from alpha" }, { unread: true, from: "beta", to: "alpha", body: "pong\nbye" }] });
  const h = mkdtempSync(join(tmpdir(), "sos-noag-"));
  const none = new NativeBots({ home: h, exec: () => ({ code: 1, out: "" }), agmsg: { dir: "/nonexistent" }, envFile: join(h, "env"),
    claudeJson: join(h, "claude.json"), catalogPaths: { claudeDir: "/nonexistent", agentsSkills: "/nonexistent", claudeJson: "/nonexistent", mcpJson: "/nonexistent" } });
  none.create({ name: "solo" });
  expect(none.messages("solo")).toMatchObject({ ok: true, installed: false, repo: "https://github.com/fujibee/agmsg" });
  expect((await none.handle("bot/settings", { channel: "solo" })).body).toMatchObject({ agmsg: { installed: false } });
  expect(readFileSync(join(none.get("solo")!.cwd, "CLAUDE.md"), "utf8")).not.toContain("agmsg team");
  expect(realpathSync(none.get("solo")!.cwd)).toBe(none.get("solo")!.cwd);
});

test("adopt: an existing folder is used in place with its own files, team and Telegram state folder", async () => {
  const { bots, calls, ag, root } = world();
  const dir = join(root, "old-bot"), tg = join(root, "old-channel");
  mkdirSync(join(dir, ".claude", "skills", "mine"), { recursive: true });
  mkdirSync(tg);
  writeFileSync(join(dir, "CLAUDE.md"), "# old-bot\n\nThe persona.\n");
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { broker: { command: "b" } } }));
  writeFileSync(join(tg, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["42"], groups: {}, pending: {} }));
  expect(bots.create({ name: "old-bot", dir: join(root, "missing") })).toMatchObject({ ok: false });
  expect(bots.create({ name: "old-bot", dir: "relative/path" })).toMatchObject({ ok: false });
  expect(bots.create({ name: "old-bot", dir, telegramStateDir: tg })).toMatchObject({ ok: false }); // a state folder needs a token variable
  const r = bots.create({ name: "old-bot", dir, team: "lahmacun", tokenEnv: "TELEGRAM_X", telegramStateDir: tg, preset: "full", deny: ["mcp__broker__buy"], readAnywhere: true });
  expect(r).toMatchObject({ ok: true, cwd: realpathSync(dir) });
  const b = bots.get("old-bot")!;
  expect(b).toMatchObject({ adopted: true, team: "lahmacun", telegram: { tokenEnv: "TELEGRAM_X", stateDir: realpathSync(tg) } });
  expect(existsSync(join(bots.stateDir("old-bot"), "..", "..", "..", "bots", "old-bot"))).toBe(false); // no <home>/bots/<name>
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("The persona.");
  expect(existsSync(join(dir, ".claude", "skills", "mine"))).toBe(true);
  expect(calls).toContainEqual(expect.arrayContaining([join(ag, "scripts", "join.sh"), "lahmacun", "old-bot"]));
  const s = JSON.parse(readFileSync(join(b.cwd, ".claude", "settings.json"), "utf8"));
  expect(s.enabledMcpjsonServers).toContain("broker"); // its own server stays on
  expect(s.permissions.allow).toContain("mcp__broker");
  expect(s.permissions.deny).toContain("mcp__broker__buy");
  expect(s.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined(); // readAnywhere
  expect(s.permissions.deny).toContain("Read(~/.env)"); // secrets stay denied
  expect(bots.list()[0]).toMatchObject({ team: "lahmacun", adopted: true, cwd: b.cwd });
  expect((await bots.launch("old-bot", null, 0)).ok).toBe(true);
  expect(readFileSync(join(tg, ".env"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=123:abc\n");
  expect(JSON.parse(readFileSync(join(tg, "access.json"), "utf8")).allowFrom).toEqual(["42", "123456789"]);
  expect(readFileSync(join(bots.stateDir("old-bot"), "launch.sh"), "utf8")).toContain(`TELEGRAM_STATE_DIR='${realpathSync(tg)}'`);
  expect(existsSync(join(bots.stateDir("old-bot"), "telegram"))).toBe(false);
  expect(bots.setTelegram("old-bot", "TELEGRAM_X").ok).toBe(true);
  expect(bots.get("old-bot")!.telegram?.stateDir).toBe(realpathSync(tg));
  expect((await bots.remove("old-bot")).ok).toBe(true);
  expect(existsSync(join(dir, "CLAUDE.md")) && existsSync(join(tg, "access.json"))).toBe(true);
  expect(calls).toContainEqual(expect.arrayContaining([join(ag, "scripts", "leave.sh"), "lahmacun", "old-bot"]));
});
