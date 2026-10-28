// Per-bot policy for native bots, written as plain Claude Code config so a bot behaves the same when it is started by
// hand from its folder: <botdir>/.claude/settings.json (scope, tool rules, sandbox, skill/plugin/MCP switches),
// <botdir>/.mcp.json, <botdir>/.claude/skills/* links, the identity block in <botdir>/CLAUDE.md, the Telegram
// access.json and the secrets file the launch script loads. Everything here is pure (no I/O) except where noted.
// Keys follow https://code.claude.com/docs/en/settings-reference (checked against json.schemastore.org/claude-code-settings.json).
import { join } from "node:path";

export const PRESETS = ["safe", "dev", "full"] as const;
export type Preset = (typeof PRESETS)[number];
export interface BotFolder { path: string; write: boolean }
/** readAnywhere: the Read tool may open files outside the bot's folders (secret files stay denied). */
export interface BotScope { folders: BotFolder[]; network: boolean; sandbox: boolean; readAnywhere: boolean }
export interface BotTools { preset: Preset; allow: string[]; deny: string[] }
export interface BotPolicy {
  scope: BotScope; tools: BotTools;
  /** Skill id → on/off. Ids: "global:<name>" (~/.claude/skills), "agents:<name>" (~/.agents/skills). Unlisted = default. */
  skills: Record<string, boolean>;
  /** Plugin id ("name@marketplace") → on/off. Unlisted = as installed. */
  plugins: Record<string, boolean>;
  /** MCP id ("user:<name>" from ~/.claude.json, "mcpjson:<name>" from ~/.mcp.json) → on/off. Unlisted = default. */
  mcp: Record<string, boolean>;
  /** Names of ~/.env variables the bot gets. Nothing else from ~/.env reaches it. */
  secrets: string[];
  /** Own CLAUDE_CONFIG_DIR (plugins, MCP, memory, login) under <home>/data/bots/<name>/claude. */
  isolated: boolean;
  /** Load the owner's global ~/.claude/CLAUDE.md and ~/.claude/rules. Off: they are listed in claudeMdExcludes. */
  globalInstructions: boolean;
  role: string;
}

export const defaultPolicy = (): BotPolicy => ({
  scope: { folders: [], network: true, sandbox: false, readAnywhere: false }, tools: { preset: "safe", allow: [], deny: [] },
  skills: {}, plugins: {}, mcp: {}, secrets: [], isolated: false, globalInstructions: false, role: "",
});

/** Fill in what an older bots.json entry lacks. */
export function withDefaults(p: Partial<BotPolicy> | undefined): BotPolicy {
  const d = defaultPolicy();
  // a bot saved before this option existed keeps what it had: the global instructions
  if (p && p.globalInstructions === undefined) d.globalInstructions = true;
  return { ...d, ...(p ?? {}), scope: { ...d.scope, ...(p?.scope ?? {}) }, tools: { ...d.tools, ...(p?.tools ?? {}) } };
}

// Claude Code accepts these tool names in rules (the schema's permissionRule pattern), plus mcp__*.
const TOOL_RULE = /^((Agent|Bash|Edit|Glob|Grep|KillShell|LSP|Monitor|MultiEdit|NotebookEdit|Read|Skill|TaskCreate|TaskGet|TaskList|TaskOutput|TaskStop|TaskUpdate|TodoWrite|ToolSearch|WebFetch|WebSearch|Write)(\([^)]+\))?|mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?)$/;
export const validRule = (r: string) => TOOL_RULE.test(r) && r.length <= 300;

/** Shell commands no preset below "full" lets a bot run. */
const ALWAYS_DENY_BASH = ["sudo *", "su *", "tmux *", "launchctl *", "crontab *", "osascript *", "security *", "killall *", "pkill *"];
const PRESET_RULES: Record<Preset, { allow: string[]; deny: string[] }> = {
  safe: {
    allow: ["Read", "Glob", "Grep", "Skill", "TodoWrite", "TaskOutput", "TaskStop",
      ...["mkdir *", "touch *", "cp *", "mv *", "git status*", "git diff*", "git log*", "git add *", "git commit *", "jq *", "date*", "sort *", "uniq *"].map((c) => `Bash(${c})`)],
    deny: [...["rm -rf *", "rm -fr *", "rm -r *", "git push*", "curl * | sh*", "curl * | bash*", "curl *|sh*", "curl *|bash*", "wget * | sh*", "wget * | bash*",
      "chmod -R *", "chown *", "dd *", "mkfs*", "diskutil *", ...ALWAYS_DENY_BASH].map((c) => `Bash(${c})`)],
  },
  dev: {
    allow: ["Read", "Glob", "Grep", "Skill", "TodoWrite", "TaskOutput", "TaskStop", "Agent", "Bash", "NotebookEdit"],
    deny: [...["rm -rf /*", "rm -rf ~*", "rm -rf $HOME*", "git push --force*", "git push -f*", "curl * | sh*", "curl * | bash*", "wget * | sh*", "wget * | bash*",
      ...ALWAYS_DENY_BASH].map((c) => `Bash(${c})`)],
  },
  full: { allow: ["Read", "Glob", "Grep", "Skill", "TodoWrite", "TaskOutput", "TaskStop", "Agent", "Bash", "NotebookEdit"], deny: [] },
};
export const presetRules = (p: Preset) => PRESET_RULES[p];

/** Files a bot never reads or edits with its tools, whatever the preset. */
const SECRET_PATHS = ["~/.env", "~/.env.*", "~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.claude.json", "~/.claude/channels/**", "~/.config/gh/**", "**/.env"];
const SECRET_BASH = ["* ~/.env*", "*/.env", "*/.env *", "*/.env.*", "*$HOME/.env*", "* .env", "* .env *", "*~/.ssh*", "*.claude/channels*"];
const NET_BASH = ["curl *", "wget *", "nc *", "ncat *", "ssh *", "scp *", "sftp *", "rsync *", "git clone *", "git fetch*", "git pull*", "npm install*", "pip install*"];

export interface SettingsCtx {
  cwd: string; home: string; permissionMode: string;
  /** The owner's Claude config folder (~/.claude): where the global CLAUDE.md and rules live. */
  claudeDir: string;
  /** agmsg scripts folder, its skill folder and message store (allowed through the scope and sandbox). Null = agmsg not installed. */
  agmsg: { scripts: string; skillDir: string; storage: string | null } | null;
  /** Catalog entries, to turn ids into names. */
  globalSkills: { id: string; name: string }[]; userMcp: string[]; mcpjsonOn: string[]; mcpjsonOff: string[];
  /** Every MCP server the bot has (its tools get an allow rule, since dontAsk would deny them). */
  mcpOn: string[];
}

/** Absolute path as a Read/Edit rule path ("//abs/**"). */
const ruleAbs = (p: string) => `/${p.replace(/\/+$/, "")}/**`;

/** <botdir>/.claude/settings.json for one bot. */
export function settingsJson(p: BotPolicy, c: SettingsCtx): Record<string, unknown> {
  const pr = presetRules(p.tools.preset);
  const folders = [{ path: c.cwd, write: true }, ...p.scope.folders.filter((f) => f.path !== c.cwd)];
  const allow = new Set<string>(pr.allow);
  for (const f of folders) { allow.add(`Read(${ruleAbs(f.path)})`); if (f.write) allow.add(`Edit(${ruleAbs(f.path)})`); }
  if (p.tools.preset !== "safe") allow.add("Write");
  if (p.scope.network) { allow.add("WebFetch"); allow.add("WebSearch"); if (p.scope.sandbox) allow.add("WebFetch(domain:*)"); }
  if (c.agmsg) for (const s of ["send.sh", "inbox.sh", "history.sh", "team.sh", "whoami.sh", "check-inbox.sh", "watch.sh", "delivery.sh"]) {
    allow.add(`Bash(${c.agmsg.scripts}/${s} *)`);
    allow.add(`Bash(bash ${c.agmsg.scripts}/${s} *)`);
  }
  for (const n of c.mcpOn) allow.add(`mcp__${n}`);
  const deny = new Set<string>(pr.deny);
  for (const s of SECRET_PATHS) { deny.add(`Read(${s})`); deny.add(`Edit(${s})`); }
  for (const s of SECRET_BASH) deny.add(`Bash(${s})`);
  // its own config: a bot can't widen its scope by editing it
  for (const f of [".claude/**", ".mcp.json"]) deny.add(`Edit(${ruleAbs(c.cwd).slice(0, -3)}/${f})`);
  if (!p.scope.network) { deny.add("WebFetch"); deny.add("WebSearch"); for (const s of NET_BASH) deny.add(`Bash(${s})`); allow.delete("WebFetch"); allow.delete("WebSearch"); }
  for (const r of p.tools.allow) if (validRule(r)) allow.add(r);
  for (const r of p.tools.deny) if (validRule(r)) { deny.add(r); allow.delete(r); }

  const extra = folders.slice(1).map((f) => f.path);
  const s: Record<string, unknown> = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: {
      defaultMode: c.permissionMode, allow: [...allow], deny: [...deny],
      ...(extra.length ? { additionalDirectories: extra } : {}),
      ...(p.scope.readAnywhere ? {} : { blockReadsOutsideWorkingDirectories: true }),
      ...(p.tools.preset !== "full" ? { disableBypassPermissionsMode: "disable" } : {}),
    },
  };
  if (p.scope.sandbox) {
    const ag = c.agmsg ? [c.agmsg.skillDir, ...(c.agmsg.storage ? [c.agmsg.storage] : [])] : [];
    s.sandbox = {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["~/"], allowRead: [...folders.map((f) => f.path), ...ag],
        allowWrite: [...folders.filter((f) => f.write).map((f) => f.path), ...ag],
        denyWrite: [join(c.cwd, ".claude", "settings.json")],
      },
      network: { allowedDomains: [] },
      credentials: { files: ["~/.env", "~/.ssh", "~/.aws"].map((path) => ({ path, mode: "deny" })) },
    };
  }
  const overrides = Object.fromEntries(c.globalSkills.filter((g) => p.skills[g.id] === false).map((g) => [g.name, "off"]));
  if (Object.keys(overrides).length && !p.isolated) s.skillOverrides = overrides;
  const pluginsOff = Object.entries(p.plugins).filter(([, on]) => on === false);
  if (pluginsOff.length && !p.isolated) s.enabledPlugins = Object.fromEntries(pluginsOff.map(([id]) => [id, false]));
  const userOff = c.userMcp.filter((n) => p.mcp[`user:${n}`] === false);
  if (userOff.length && !p.isolated) s.deniedMcpServers = userOff.map((serverName) => ({ serverName }));
  // absolute glob patterns (docs: "Exclude specific CLAUDE.md files"); an isolated bot never reads ~/.claude anyway
  if (!p.globalInstructions && !p.isolated) s.claudeMdExcludes = [join(c.claudeDir, "CLAUDE.md"), join(c.claudeDir, "rules", "**")];
  if (c.mcpjsonOn.length) s.enabledMcpjsonServers = c.mcpjsonOn;
  if (c.mcpjsonOff.length) s.disabledMcpjsonServers = c.mcpjsonOff;
  return s;
}

/** Only the chosen ~/.env keys, as a sh file the launch script sources (values single-quoted). */
export function secretsFile(env: Record<string, string>, keys: string[]): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return keys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && env[k] !== undefined).map((k) => `${k}=${q(env[k])}\n`).join("");
}

/** The official telegram plugin's access.json (plugins/telegram server.ts `Access`), with the owner chats pre-approved.
 *  An existing file keeps its policy, groups and pending pairings; owners are added to allowFrom. */
export function accessJson(existing: Record<string, unknown> | null, owners: string[]): Record<string, unknown> {
  const a = existing ?? { dmPolicy: owners.length ? "allowlist" : "pairing", allowFrom: [], groups: {}, pending: {} };
  const allow = Array.isArray(a.allowFrom) ? (a.allowFrom as unknown[]).map(String) : [];
  for (const o of owners) if (!allow.includes(o)) allow.push(o);
  return { ...a, dmPolicy: a.dmPolicy ?? "pairing", allowFrom: allow, groups: a.groups ?? {}, pending: a.pending ?? {} };
}
export const validChatId = (s: string) => /^-?\d{1,20}$/.test(s);

export const IDENTITY_START = "<!-- server-os:identity:start -->";
export const IDENTITY_END = "<!-- server-os:identity:end -->";
export interface IdentityCtx {
  name: string; role: string; owner: string; tmux: string; cwd: string;
  team: string | null; scripts: string | null; peers: { name: string; role: string }[];
}

/** The OpenClaw-style identity block: who the bot is, who it works for, which bots it can reach and how. */
export function identityBlock(i: IdentityCtx): string {
  const lines = [IDENTITY_START, "## Identity", "",
    `- Name: **${i.name}**`, `- Role: ${i.role || "general assistant"}`, `- Owner: ${i.owner}`,
    `- Runs under Server OS in tmux session \`${i.tmux}\`; your folder is \`${i.cwd}\`. Work only there unless your settings add more folders.`, ""];
  if (i.team && i.scripts) {
    lines.push("## Other agents (agmsg)", "",
      `You are agent \`${i.name}\` in the agmsg team \`${i.team}\`. Members you can reach:`, "",
      ...(i.peers.length ? i.peers.map((p) => `- \`${p.name}\`${p.role ? ` — ${p.role}` : ""}`) : ["- (no other bots yet)"]),
      `- the owner's own sessions, if they joined \`${i.team}\` (check with the team command)`, "",
      `- Send: \`${i.scripts}/send.sh ${i.team} ${i.name} <agent> "<message>"\``,
      `- Inbox: \`${i.scripts}/inbox.sh ${i.team} ${i.name}\``,
      `- Team: \`${i.scripts}/team.sh ${i.team}\``,
      "", "Messages for you arrive on the agmsg inbox stream (the Monitor the session starts). Answer the sender with send.sh. Use only these scripts; never open agmsg's database or team files.", "");
  }
  lines.push(IDENTITY_END);
  return lines.join("\n");
}

/** Put the identity block into a CLAUDE.md, replacing an older one and keeping everything else (the persona). */
export function withIdentity(md: string, block: string): string {
  const a = md.indexOf(IDENTITY_START), b = md.indexOf(IDENTITY_END);
  if (a >= 0 && b > a) return md.slice(0, a) + block + md.slice(b + IDENTITY_END.length);
  const nl = md.indexOf("\n");
  return md.startsWith("# ") && nl > 0 ? `${md.slice(0, nl + 1)}\n${block}\n${md.slice(nl + 1)}` : `${block}\n\n${md}`;
}
