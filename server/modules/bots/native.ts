// Native bot manager: Claude Code sessions that Server OS runs itself, each in its own tmux session named
// <prefix><bot> (default "sos-"). Used when no Claude OS bot manager is configured (or `bots.provider: native`).
// Only tmux sessions with the prefix are ever listed, read, typed into or stopped, so sessions started by anything
// else are never touched. Bots live in <home>/data/bots.json, their working folders in <home>/bots/<name> (or an
// existing folder the bot adopts), and the per-bot launch script, run.pid and Telegram state in <home>/data/bots/<name>
// (or an existing Telegram state folder). A Telegram token is never stored in config: a bot names a variable in
// ~/.env, read when the bot starts.
// Each bot also gets an OpenClaw-style workspace (policy.ts, catalog.ts): its own scope, tool rules, skills/MCP set,
// secrets and identity, all written as Claude Code config in its folder, and an agmsg identity (agmsg.ts) so bots can
// message each other. The bot still runs as the same OS user: the scope is Claude Code's permissions (+ optional sandbox).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME, loadEnv } from "../../lib";
import { projectDir, Transcript } from "./transcript";
import { Agmsg, AGMSG_INSTALL, AGMSG_REPO } from "./agmsg";
import { applyWorkspace, defaultCatalogPaths, mcpOn, readCatalog, type CatalogPaths } from "./catalog";
import { accessJson, identityBlock, PRESETS, secretsFile, settingsJson, validChatId, validRule, withDefaults, withIdentity, type BotPolicy, type Preset } from "./policy";

export type Exec = (cmd: string[], stdin?: string) => { code: number; out: string };
export interface NativeBot {
  name: string; cwd: string; model: string; effort: string | null; permissionMode: string;
  /** stateDir: an existing Telegram plugin state folder to keep using (default <home>/data/bots/<name>/telegram). */
  telegram: { tokenEnv: string; ownerChatIds?: string[]; stateDir?: string } | null; created: number;
  policy?: Partial<BotPolicy>;
  /** Its agmsg team, when not bots.team (a bot moved in from elsewhere keeps its team). */
  team?: string;
  /** The folder existed before Server OS (adopt mode): it is used in place and never created or removed. */
  adopted?: boolean;
}
export type Result = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export const MODELS = ["fable", "opus", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** dontAsk (the default for new bots) denies whatever its rules don't allow instead of waiting on a prompt nobody sees. */
export const PERMISSION_MODES = ["dontAsk", "default", "acceptEdits", "plan", "auto", "bypassPermissions"];
export const TELEGRAM_PLUGIN = "plugin:telegram@claude-plugins-official";
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SESSION_RE = /^[0-9a-f-]{36}$/;
export const DEFAULT_PATH = `${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

/** Drop control characters but keep newlines and tabs: an ESC in a prompt could end the bracketed paste and press keys. */
export const cleanPrompt = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
/** POSIX single quotes, for the launch script. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fail = (error: string): Result => ({ ok: false, error });
/** An absolute folder path (~ expanded), real path when it exists; null if not absolute. */
const folderPath = (raw: string) => {
  const p = raw.trim().replace(/^~(?=\/|$)/, HOME);
  return p.startsWith("/") ? (existsSync(p) ? realpathSync(p) : resolve(p)) : null;
};
/** "/", the home folder itself, and secret/config folders are never a bot's folder. */
const tooBroad = (path: string) => path === "/" || path === HOME || path === realpathSync(HOME) || /\/\.(ssh|aws|gnupg|claude)(\/|$)|\/\.env/.test(path);

/** What's missing for native bots on this machine: tmux and the claude CLI. */
export function nativeMissing(path = DEFAULT_PATH): string[] {
  return (["tmux", "claude"] as const).filter((b) => !Bun.which(b, { PATH: path }));
}

export type BotsProvider = "claudeOS" | "native" | "both";
/** Which bot manager runs: bots.provider if set (both = Claude OS and native side by side), else Claude OS when
 *  integrations.claudeOS is set, else native. Native needs tmux and claude; without them only Claude OS is left. */
export function botsProvider(pref: BotsProvider | undefined, hasCos: boolean, nativeOk: boolean, demo = false): BotsProvider | null {
  if (demo) return null;
  const want = pref ?? (hasCos ? "claudeOS" : "native");
  if (want === "both") return hasCos ? (nativeOk ? "both" : "claudeOS") : nativeOk ? "native" : null;
  if (want === "native") return nativeOk ? "native" : null;
  return hasCos ? "claudeOS" : null;
}

export interface NativeOptions {
  home: string; prefix?: string; exec?: Exec; path?: string;
  /** ~/.claude.json, where the folder trust is pre-accepted. */
  claudeJson?: string;
  /** ~/.env, where Telegram token variables are read from. */
  envFile?: string;
  pidAlive?: (pid: number) => boolean;
  /** agmsg team every bot joins (bots.team, default "server-os"), the skill folder and an optional message store. */
  team?: string;
  agmsg?: { dir?: string; storage?: string | null };
  /** Telegram chat ids pre-approved in every bot's access.json (bots.telegram.ownerChatIds). */
  ownerChatIds?: string[];
  ownerName?: string;
  catalogPaths?: CatalogPaths;
}
/** Variables the bot keeps from the environment it was started in; everything else (and all of ~/.env) is dropped. */
export const KEEP_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMUX", "TMUX_PANE"];

export class NativeBots {
  readonly prefix: string;
  private readonly exec: Exec;
  private readonly path: string;
  private readonly tmux: string;
  private readonly claude: string;
  private readonly claudeJson: string;
  private readonly envFile: string;
  private readonly pidAlive: (pid: number) => boolean;
  readonly team: string;
  readonly agmsg: Agmsg;
  private readonly catalogPaths: CatalogPaths;

  constructor(private readonly o: NativeOptions) {
    this.prefix = o.prefix ?? "sos-";
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(this.prefix)) throw new Error(`bots.prefix "${this.prefix}" must be 2–20 letters, digits, - or _`);
    this.path = o.path ?? DEFAULT_PATH;
    this.tmux = Bun.which("tmux", { PATH: this.path }) ?? "tmux";
    this.claude = Bun.which("claude", { PATH: this.path }) ?? "claude";
    this.claudeJson = o.claudeJson ?? join(HOME, ".claude.json");
    this.envFile = o.envFile ?? join(HOME, ".env");
    this.pidAlive = o.pidAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    this.exec = o.exec ?? ((cmd, stdin) => {
      try {
        const r = Bun.spawnSync(cmd, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), env: { ...process.env, PATH: this.path } });
        return { code: r.exitCode ?? -1, out: (r.stdout.toString() + r.stderr.toString()).trim() };
      } catch (e) { return { code: -1, out: String(e) }; }
    });
    this.team = o.team ?? "server-os";
    if (!Agmsg.validTeam(this.team)) throw new Error(`bots.team "${this.team}" must be letters, digits, . _ or -`);
    this.agmsg = new Agmsg({ dir: o.agmsg?.dir, storage: o.agmsg?.storage ?? null, exec: this.exec });
    this.catalogPaths = o.catalogPaths ?? defaultCatalogPaths();
  }

  // ---------- store ----------
  private get file() { return join(this.o.home, "data", "bots.json"); }
  stateDir = (name: string) => join(this.o.home, "data", "bots", name);
  read(): NativeBot[] { try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return []; } }
  private write(list: NativeBot[]) {
    mkdirSync(join(this.o.home, "data"), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(list, null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
  }
  get = (name: string) => this.read().find((b) => b.name === name) ?? null;

  // ---------- tmux: only ever sessions with our prefix ----------
  session = (name: string) => this.prefix + name;
  /** "=" makes tmux match the session name exactly; a plain -t also matches prefixes ("sos-a" → "sos-ab"). */
  target = (name: string) => `=${this.prefix}${name}:`;
  /** Live tmux sessions that carry the prefix. Anything else on the tmux server is not ours and is left out. */
  sessions(): Set<string> {
    const r = this.exec([this.tmux, "list-sessions", "-F", "#{session_name}"]);
    if (r.code !== 0) return new Set();
    return new Set(r.out.split("\n").map((s) => s.trim()).filter((s) => s.length > this.prefix.length && s.startsWith(this.prefix)));
  }
  alive = (name: string) => !!this.get(name) && this.sessions().has(this.session(name));

  private pid(name: string): number | null {
    try { const p = Number(readFileSync(join(this.stateDir(name), "run.pid"), "utf8").trim()); return p > 0 && this.pidAlive(p) ? p : null; } catch { return null; }
  }
  private env(): Record<string, string> { return { ...loadEnv(this.envFile) }; }
  policy = (b: NativeBot) => withDefaults(b.policy);
  configDir = (name: string) => join(this.stateDir(name), "claude");
  teamOf = (b: NativeBot) => b.team ?? this.team;
  /** The Telegram plugin's state folder (TELEGRAM_STATE_DIR): its .env, access.json, bot.pid and inbox. */
  telegramDir = (b: NativeBot) => b.telegram?.stateDir ?? join(this.stateDir(b.name), "telegram");
  private hasEnv(k: string) { return !!(this.env()[k] ?? process.env[k]); }

  /** One row per bot, in the shape the Bots page already reads from Claude OS (plus provider/telegram/effort). */
  list() {
    const live = this.sessions();
    return this.read().map((b) => {
      const running = live.has(this.session(b.name));
      const pid = running ? this.pid(b.name) : null;
      const p = this.policy(b);
      const tgPid = Number((() => { try { return readFileSync(join(this.telegramDir(b), "bot.pid"), "utf8").trim(); } catch { return "0"; } })());
      return {
        channel: b.name, provider: "native" as const, protected: false, restartable: true, scopable: false,
        tokenSet: b.telegram ? this.hasEnv(b.telegram.tokenEnv) : false, tokenKey: b.telegram?.tokenEnv ?? null, telegram: !!b.telegram,
        cwd: b.cwd, model: b.model, activeModel: running ? b.model : null, effort: b.effort, permissionMode: b.permissionMode,
        running, pid, telegramConnected: running && !!b.telegram && tgPid > 0 && this.pidAlive(tgPid),
        uptime: pid ? this.exec(["ps", "-o", "etime=", "-p", String(pid)]).out.trim() || null : null,
        inbox: 0, tmux: this.session(b.name), capabilities: { globalSkills: [], projectSkills: [], mcps: [], plugins: [] },
        preset: p.tools.preset, role: p.role, isolated: p.isolated, sandbox: p.scope.sandbox, network: p.scope.network,
        folders: [b.cwd, ...p.scope.folders.map((f) => f.path)], secrets: p.secrets.length,
        team: this.agmsg.installed() ? this.teamOf(b) : null, adopted: !!b.adopted,
      };
    });
  }

  // ---------- folder trust: otherwise a new bot waits forever on "Do you trust the files in this folder?" ----------
  trust(dir: string, file = this.claudeJson): boolean {
    let j: { projects?: Record<string, Record<string, unknown>> } = {};
    let mode = 0o600;
    if (existsSync(file)) {
      try { j = JSON.parse(readFileSync(file, "utf8")); mode = statSync(file).mode & 0o777; }
      catch { return false; } // never overwrite a file we couldn't read
    }
    const p = ((j.projects ??= {})[dir] ??= {});
    if (p.hasTrustDialogAccepted === true) return true;
    p.hasTrustDialogAccepted = true;
    const tmp = `${file}.sos-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, 2), { mode });
    renameSync(tmp, file);
    return true;
  }

  // ---------- lifecycle ----------
  create(i: { name?: unknown; model?: unknown; effort?: unknown; permissionMode?: unknown; tokenEnv?: unknown } & Record<string, unknown>): Result {
    const name = String(i.name ?? "").trim();
    if (!NAME_RE.test(name)) return fail("Name: 2–31 lowercase letters, digits or hyphens, starting with a letter (e.g. recipe-bot)");
    if (this.get(name) || this.sessions().has(this.session(name))) return fail(`A bot named "${name}" already exists`);
    const model = String(i.model ?? "sonnet");
    if (!MODELS.includes(model)) return fail(`Model must be one of ${MODELS.join(", ")}`);
    const effort = i.effort ? String(i.effort) : null;
    if (effort && !EFFORTS.includes(effort)) return fail(`Effort must be one of ${EFFORTS.join(", ")}`);
    const permissionMode = String(i.permissionMode ?? "dontAsk");
    if (!PERMISSION_MODES.includes(permissionMode)) return fail(`Permission mode must be one of ${PERMISSION_MODES.join(", ")}`);
    const tokenEnv = i.tokenEnv ? String(i.tokenEnv).trim() : "";
    if (tokenEnv && !ENV_RE.test(tokenEnv)) return fail("Telegram token: the NAME of a variable in ~/.env (e.g. TELEGRAM_RECIPES_TOKEN), not the token");
    const policy = this.parsePolicy(i, withDefaults(undefined));
    if (typeof policy === "string") return fail(policy);
    const team = i.team ? String(i.team).trim() : "";
    if (team && !Agmsg.validTeam(team)) return fail("Team: letters, digits, . _ or -");
    // adopt mode: an existing folder (a bot moved in from another manager) is used in place, its files kept
    const adopt = i.dir ? folderPath(String(i.dir)) : null;
    if (i.dir && (!adopt || !existsSync(adopt))) return fail(`Folder: an existing absolute path (${String(i.dir).slice(0, 80)})`);
    if (adopt && tooBroad(adopt)) return fail(`Not allowed as a bot folder: ${adopt}`);
    const stateDir = i.telegramStateDir ? folderPath(String(i.telegramStateDir)) : null;
    if (i.telegramStateDir && (!stateDir || !tokenEnv || !existsSync(stateDir))) return fail("Telegram state folder: an existing absolute path, together with a token variable");
    const dir = adopt ?? join(this.o.home, "bots", name);
    mkdirSync(dir, { recursive: true });
    const md = join(dir, "CLAUDE.md");
    if (!existsSync(md)) writeFileSync(md, `# ${name}\n\nYou are ${name}, a bot run by Server OS. Keep replies short.\n`);
    const cwd = realpathSync(dir); // Claude Code keys trust and transcripts by the real path (/tmp → /private/tmp)
    this.trust(cwd);
    const telegram = tokenEnv ? { tokenEnv, ...(stateDir ? { stateDir: realpathSync(stateDir) } : {}) } : null;
    this.write([...this.read(), { name, cwd, model, effort, permissionMode, telegram, created: Date.now(), policy,
      ...(team && team !== this.team ? { team } : {}), ...(adopt ? { adopted: true } : {}) }]);
    const ws = this.writeWorkspace(name);
    for (const o of this.read()) if (o.name !== name) this.writeIdentity(o); // the others learn about the new bot
    const notes = [tokenEnv && !this.hasEnv(tokenEnv) ? `Add ${tokenEnv}=<token> to ~/.env before starting it.` : "",
      ws.ok ? "" : ws.error, policy.isolated ? "Isolated: log in once in its terminal on first start (/login)." : ""].filter(Boolean);
    return { ok: true, name, cwd, note: ["Created", ...notes].join(". ") };
  }

  // ---------- workspace: scope, tools, skills/MCP, secrets, identity ----------
  /** Validate the policy fields of a create/settings request on top of `base`. A string is the error. */
  parsePolicy(i: Record<string, unknown>, base: BotPolicy): BotPolicy | string {
    const p: BotPolicy = structuredClone(base);
    if (i.preset !== undefined) { if (!PRESETS.includes(i.preset as Preset)) return `Preset must be one of ${PRESETS.join(", ")}`; p.tools.preset = i.preset as Preset; }
    for (const k of ["allow", "deny"] as const) if (i[k] !== undefined) {
      const rules = (Array.isArray(i[k]) ? i[k] as unknown[] : String(i[k]).split("\n")).map((r) => String(r).trim()).filter(Boolean);
      const bad = rules.find((r) => !validRule(r));
      if (bad) return `Not a Claude Code permission rule: ${bad} (e.g. Bash(npm run *), Read(./docs/**), WebFetch(domain:example.com), mcp__github)`;
      p.tools[k] = [...new Set(rules)];
    }
    if (i.folders !== undefined) {
      if (!Array.isArray(i.folders)) return "folders: a list of { path, write }";
      const out = [];
      for (const f of i.folders as { path?: unknown; write?: unknown }[]) {
        const path = folderPath(String(f?.path ?? ""));
        if (!path) return `Folder must be an absolute path: ${String(f?.path ?? "").trim() || "(empty)"}`;
        if (tooBroad(path)) return `Too broad, or secrets/config: ${path}`;
        out.push({ path, write: f?.write === true });
      }
      p.scope.folders = out;
    }
    for (const k of ["network", "sandbox", "readAnywhere"] as const) if (i[k] !== undefined) p.scope[k] = i[k] === true;
    if (i.isolated !== undefined) p.isolated = i.isolated === true;
    if (i.globalInstructions !== undefined) p.globalInstructions = i.globalInstructions === true;
    if (i.role !== undefined) p.role = String(i.role).replace(/[\x00-\x1f]/g, " ").trim().slice(0, 200);
    if (i.secrets !== undefined) {
      const ks = (Array.isArray(i.secrets) ? i.secrets as unknown[] : []).map(String);
      const bad = ks.find((k) => !ENV_RE.test(k));
      if (bad) return `Secrets: variable names from ~/.env, not values (${bad.slice(0, 12)}…)`;
      p.secrets = [...new Set(ks)];
    }
    for (const k of ["skills", "plugins", "mcp"] as const) if (i[k] !== undefined) {
      if (typeof i[k] !== "object" || !i[k]) return `${k}: an object of id → true/false`;
      p[k] = Object.fromEntries(Object.entries(i[k] as object).filter(([id, v]) => /^[A-Za-z0-9:._@-]{1,120}$/.test(id) && typeof v === "boolean"));
    }
    return p;
  }

  catalog() { return readCatalog(this.catalogPaths, Object.keys(this.env())); }

  /** (Re)write the bot's Claude Code config: .claude/settings.json, .mcp.json, skill links, CLAUDE.md identity, agmsg join. */
  writeWorkspace(name: string): Result {
    const b = this.get(name);
    if (!b) return fail(`Unknown bot "${name}"`);
    const p = this.policy(b);
    const cat = this.catalog();
    const ag = this.agmsg.installed() ? this.agmsg : null;
    const { mcpjsonOn, mcpjsonOff } = applyWorkspace(b.cwd, p, cat, this.catalogPaths);
    const on = [...cat.mcp.filter((m) => mcpOn(p, m.id) && m.source === "user").map((m) => m.name), ...mcpjsonOn];
    const s = settingsJson(p, {
      cwd: b.cwd, home: this.o.home, claudeDir: this.catalogPaths.claudeDir, permissionMode: b.permissionMode,
      agmsg: ag ? { scripts: ag.scripts, skillDir: ag.dir, storage: ag.storage } : null,
      globalSkills: cat.skills.filter((x) => x.source === "global").map((x) => ({ id: x.id, name: x.name })),
      userMcp: cat.mcp.filter((m) => m.source === "user").map((m) => m.name), mcpjsonOn, mcpjsonOff, mcpOn: [...new Set(on)],
    });
    mkdirSync(join(b.cwd, ".claude"), { recursive: true });
    const sf = join(b.cwd, ".claude", "settings.json");
    writeFileSync(sf + ".tmp", JSON.stringify(s, null, 2) + "\n");
    renameSync(sf + ".tmp", sf);
    this.writeIdentity(b);
    if (ag) { const j = ag.join(this.teamOf(b), b.name, b.cwd); if (!j.ok) return fail(`agmsg join failed: ${j.error}`); }
    return { ok: true };
  }

  private writeIdentity(b: NativeBot) {
    const md = join(b.cwd, "CLAUDE.md");
    const cur = existsSync(md) ? readFileSync(md, "utf8") : `# ${b.name}\n`;
    const ag = this.agmsg.installed();
    const block = identityBlock({
      name: b.name, role: this.policy(b).role, owner: this.o.ownerName ?? "the owner of this server", tmux: this.session(b.name), cwd: b.cwd,
      team: ag ? this.teamOf(b) : null, scripts: ag ? this.agmsg.scripts : null,
      peers: this.read().filter((x) => x.name !== b.name && this.teamOf(x) === this.teamOf(b)).map((x) => ({ name: x.name, role: this.policy(x).role })),
    });
    const next = withIdentity(cur, block);
    if (next !== cur) writeFileSync(md, next);
  }

  /** The settings panel: the bot's policy, what can be picked, and agmsg's state. */
  settings(name: string): Result {
    const b = this.get(name);
    if (!b) return fail(`Unknown bot "${name}"`);
    const ag = this.agmsg.installed();
    return {
      ok: true, policy: this.policy(b), permissionMode: b.permissionMode, cwd: b.cwd, ownerChatIds: b.telegram?.ownerChatIds ?? [],
      defaultOwnerChatIds: this.o.ownerChatIds ?? [], catalog: this.catalog(), configDir: this.configDir(name),
      agmsg: ag ? { installed: true, team: this.teamOf(b), scripts: this.agmsg.scripts } : { installed: false, repo: AGMSG_REPO, install: AGMSG_INSTALL },
    };
  }

  saveSettings(name: string, i: Record<string, unknown>): Result {
    const list = this.read(), b = list.find((x) => x.name === name);
    if (!b) return fail(`Unknown bot "${name}"`);
    const p = this.parsePolicy(i, this.policy(b));
    if (typeof p === "string") return fail(p);
    if (i.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(String(i.permissionMode))) return fail(`Permission mode must be one of ${PERMISSION_MODES.join(", ")}`);
      b.permissionMode = String(i.permissionMode);
    }
    if (i.ownerChatIds !== undefined) {
      const ids = (Array.isArray(i.ownerChatIds) ? i.ownerChatIds as unknown[] : String(i.ownerChatIds).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
      const bad = ids.find((x) => !validChatId(x));
      if (bad) return fail(`Telegram chat id must be a number: ${bad}`);
      if (b.telegram) b.telegram.ownerChatIds = [...new Set(ids)];
    }
    b.policy = p;
    this.write(list);
    const ws = this.writeWorkspace(name);
    if (!ws.ok) return ws;
    return { ok: true, detail: this.alive(name) ? "Saved — restart the bot to apply" : "Saved" };
  }

  /** The bot's agmsg team, members and last messages (history.sh). */
  messages(name: string, limit = 10): Result {
    const b = this.get(name);
    if (!b) return fail(`Unknown bot "${name}"`);
    if (!this.agmsg.installed()) return { ok: true, installed: false, repo: AGMSG_REPO, install: AGMSG_INSTALL, team: null, members: [], messages: [] };
    const team = this.teamOf(b);
    return { ok: true, installed: true, team, members: this.agmsg.members(team), messages: this.agmsg.history(team, name, limit) };
  }

  /** access.json for the bot's Telegram state dir: owner chats pre-approved, the rest of an existing file kept. */
  writeAccess(tgDir: string, b: NativeBot) {
    const owners = [...new Set([...(this.o.ownerChatIds ?? []), ...(b.telegram?.ownerChatIds ?? [])])].filter(validChatId);
    const f = join(tgDir, "access.json");
    let cur: Record<string, unknown> | null = null;
    if (existsSync(f)) { try { cur = JSON.parse(readFileSync(f, "utf8")); } catch { return; } } // the plugin moves a corrupt file aside itself
    if (!owners.length && cur) return;
    writeFileSync(f + ".tmp", JSON.stringify(accessJson(cur, owners), null, 2) + "\n", { mode: 0o600 });
    renameSync(f + ".tmp", f);
  }

  /** The bot's start script. It re-runs itself under `env -i`, so the session gets only KEEP_ENV, PATH, the chosen
   *  secrets (secrets.env, 0600) and Server OS's own variables: nothing else from the tmux server or ~/.env. */
  launchScript(b: NativeBot, resume: string | null, tgDir: string | null) {
    const p = this.policy(b), sd = this.stateDir(b.name);
    const flags = ["--model", b.model, ...(b.effort ? ["--effort", b.effort] : []), "--permission-mode", b.permissionMode,
      ...(resume === "last" ? ["--continue"] : resume ? ["--resume", resume] : []), ...(tgDir ? ["--channels", TELEGRAM_PLUGIN] : []),
      ...p.scope.folders.flatMap((f) => ["--add-dir", f.path])];
    const exp = { ...this.agmsg.env(), ...(p.isolated ? { CLAUDE_CONFIG_DIR: this.configDir(b.name) } : {}), ...(tgDir ? { TELEGRAM_STATE_DIR: tgDir } : {}) };
    return [
      "#!/bin/sh",
      `# Written by Server OS for bot ${b.name}; rewritten on every start.`,
      `if [ -z "$SOS_CLEAN" ]; then`,
      `  set -- SOS_CLEAN=1`,
      String.raw`  for k in ${KEEP_ENV.join(" ")}; do eval "[ -n \"\${$k+x}\" ]" && eval "set -- \"\$@\" \"$k=\${$k}\""; done`,
      `  exec /usr/bin/env -i "$@" /bin/sh "$0"`,
      `fi`,
      "unset SOS_CLEAN",
      `export PATH=${shq(this.path)}`,
      `cd ${shq(b.cwd)} || exit 1`,
      ...(p.secrets.length ? [`set -a; . ${shq(join(sd, "secrets.env"))}; set +a`] : []),
      ...Object.entries(exp).map(([k, v]) => `export ${k}=${shq(v)}`),
      `echo $$ > ${shq(join(sd, "run.pid"))}`,
      `exec ${[this.claude, ...flags].map(shq).join(" ")}`,
      "",
    ].join("\n");
  }

  /** Start a stopped bot: fresh, "last" (--continue) or a session id from its folder (--resume). */
  async launch(name: string, resume: string | null = null, waitMs = 8000): Promise<Result> {
    const b = this.get(name);
    if (!b) return fail(`Unknown bot "${name}"`);
    if (this.sessions().has(this.session(name))) return fail(`${name} is already running`);
    if (resume && resume !== "last") {
      if (!SESSION_RE.test(resume)) return fail("Bad session id");
      if (!existsSync(join(projectDir(b.cwd), `${resume}.jsonl`))) return fail("No such session in this bot's folder");
    }
    const sd = this.stateDir(name);
    mkdirSync(sd, { recursive: true, mode: 0o700 });
    let tgDir: string | null = null;
    if (b.telegram) {
      const token = this.env()[b.telegram.tokenEnv] ?? process.env[b.telegram.tokenEnv];
      if (!token) return fail(`Set ${b.telegram.tokenEnv} in ~/.env first (the bot's Telegram token)`);
      tgDir = this.telegramDir(b);
      mkdirSync(tgDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(tgDir, ".env"), `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 }); // the plugin reads it from its state dir
      this.writeAccess(tgDir, b);
    }
    if (!existsSync(b.cwd)) mkdirSync(b.cwd, { recursive: true });
    const p = this.policy(b);
    if (p.isolated) {
      mkdirSync(this.configDir(name), { recursive: true, mode: 0o700 });
      this.trust(b.cwd, join(this.configDir(name), ".claude.json"));
    } else this.trust(b.cwd);
    const sec = join(sd, "secrets.env");
    rmSync(sec, { force: true });
    if (p.secrets.length) writeFileSync(sec, secretsFile(this.env(), p.secrets), { mode: 0o600 });
    const ws = this.writeWorkspace(name);
    if (!ws.ok) return ws;
    const script = join(sd, "launch.sh");
    writeFileSync(script, this.launchScript(b, resume, tgDir), { mode: 0o700 });
    rmSync(join(sd, "run.pid"), { force: true });
    const r = this.exec([this.tmux, "new-session", "-d", "-s", this.session(name), "-x", "200", "-y", "50", "-c", b.cwd, script]);
    if (r.code !== 0) return fail(`tmux couldn't start it: ${r.out}`);
    for (let t = 0; t < waitMs; t += 250) { if (this.pid(name)) break; await Bun.sleep(250); }
    const pid = this.pid(name);
    if (pid && waitMs > 0 && this.agmsg.installed()) void this.kickoff(name);
    return { ok: true, channel: name, newPid: pid, detail: `${name} ${resume ? "resumed" : "started"}` };
  }

  /** agmsg's SessionStart hook asks the session to start its inbox Monitor, but a session only acts on that in a turn.
   *  Once the prompt is up, give it that first turn so messages from other bots arrive without waiting for a user. */
  async kickoff(name: string, timeoutMs = 45_000) {
    for (let t = 0; t < timeoutMs; t += 1000) {
      await Bun.sleep(1000);
      const r = this.terminal(name);
      if (!r.ok) return;
      if (/^❯/m.test(String(r.contents))) {
        await this.send(name, "Start your agmsg inbox stream now, as the agmsg session-start message says (Monitor on watch.sh). Then reply only: ready.");
        return;
      }
    }
  }

  async stop(name: string): Promise<Result> {
    if (!this.get(name)) return fail(`Unknown bot "${name}"`);
    const pid = this.pid(name);
    if (this.sessions().has(this.session(name))) {
      const r = this.exec([this.tmux, "kill-session", "-t", `=${this.session(name)}`]);
      if (r.code !== 0) return fail(`tmux couldn't stop it: ${r.out}`);
    }
    for (let t = 0; t < 3000 && pid && this.pidAlive(pid); t += 250) await Bun.sleep(250);
    if (pid && this.pidAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    rmSync(join(this.stateDir(name), "run.pid"), { force: true });
    return { ok: true, channel: name, detail: `${name} stopped` };
  }

  async restart(name: string): Promise<Result> {
    const s = await this.stop(name);
    return s.ok ? this.launch(name, null) : s;
  }

  /** Forget a bot: stop it and drop its state. Its working folder (CLAUDE.md, files, transcripts) is kept. */
  async remove(name: string): Promise<Result> {
    const b = this.get(name);
    if (!b) return fail(`Unknown bot "${name}"`);
    const s = await this.stop(name);
    if (!s.ok) return s;
    if (this.agmsg.installed()) this.agmsg.leave(this.teamOf(b), name);
    this.write(this.read().filter((x) => x.name !== name));
    rmSync(this.stateDir(name), { recursive: true, force: true });
    return { ok: true, channel: name, detail: `${name} deleted (folder ${b.cwd} kept)` };
  }

  setTelegram(name: string, tokenEnv: unknown): Result {
    const list = this.read(), b = list.find((x) => x.name === name);
    if (!b) return fail(`Unknown bot "${name}"`);
    const k = String(tokenEnv ?? "").trim();
    if (k && !ENV_RE.test(k)) return fail("Give the NAME of a variable in ~/.env (e.g. TELEGRAM_RECIPES_TOKEN), not the token");
    b.telegram = k ? { ...(b.telegram?.stateDir ? { stateDir: b.telegram.stateDir } : {}), tokenEnv: k } : null;
    this.write(list);
    return { ok: true, detail: k ? `Telegram token variable set to ${k} — restart the bot to apply` : "Telegram turned off — restart the bot to apply" };
  }

  // ---------- the live session ----------
  terminal(name: string): Result {
    if (!this.alive(name)) return fail(`${name} isn't running`);
    const r = this.exec([this.tmux, "capture-pane", "-p", "-t", this.target(name), "-S", "-2000"]);
    return r.code === 0 ? { ok: true, contents: r.out.replace(/\n+$/, "") || "(waiting for output…)", src: "tmux" } : fail(r.out || "capture failed");
  }

  /** Type a prompt: bracketed paste (so newlines don't each press Enter), then Enter. Text never reaches a shell. */
  async send(name: string, text: string): Promise<Result> {
    if (!this.alive(name)) return fail(`${name} isn't running`);
    const t = cleanPrompt(text);
    if (!t.trim()) return fail("Empty message");
    const buf = `sos-${name}`;
    const load = this.exec([this.tmux, "load-buffer", "-b", buf, "-"], t);
    if (load.code !== 0) return fail("tmux load-buffer failed");
    const paste = this.exec([this.tmux, "paste-buffer", "-p", "-d", "-b", buf, "-t", this.target(name)]);
    if (paste.code !== 0) return fail("tmux paste failed");
    await Bun.sleep(400);
    const enter = this.exec([this.tmux, "send-keys", "-t", this.target(name), "Enter"]);
    return enter.code === 0 ? { ok: true } : fail("tmux send-keys failed");
  }

  key(name: string, key: "Escape"): Result {
    if (!this.alive(name)) return fail(`${name} isn't running`);
    const r = this.exec([this.tmux, "send-keys", "-t", this.target(name), key]);
    return r.code === 0 ? { ok: true } : fail(r.out);
  }

  /** Past conversations in the bot's folder, newest first, with a preview of the last thing asked. */
  conversations(name: string, limit = 12) {
    const b = this.get(name);
    if (!b) return [];
    const d = projectDir(b.cwd);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, t: statSync(join(d, f)).mtimeMs }))
      .sort((a, c) => c.t - a.t).slice(0, limit).map(({ f, t }) => {
        const tr = new Transcript(join(d, f));
        tr.update();
        const users = tr.items.filter((x) => x.kind === "user");
        return { session: f.slice(0, -6), updated: t, count: tr.items.filter((x) => x.kind === "user" || x.kind === "assistant").length,
          preview: (users.at(-1) ?? users[0])?.text?.replace(/\s+/g, " ").slice(0, 120) ?? "" };
      });
  }

  // ---------- the REST shape the Bots page uses (/api/v1/cos/*), served natively ----------
  async handle(action: string, p: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const ch = String(p.channel ?? p.name ?? "");
    const out = (r: Result) => ({ status: r.ok ? 200 : 400, body: r });
    switch (action) {
      case "botSessions": return { status: 200, body: { botSessions: this.list() } };
      case "bot/terminal": return out(this.terminal(ch));
      case "bot/conversations": return { status: 200, body: { ok: true, conversations: this.conversations(ch, Number(p.limit) || 12) } };
      case "bot/create": return out(this.create(p));
      case "bot/launch": return out(await this.launch(ch, p.resume ? String(p.resume) : null));
      case "bot/stop": return out(await this.stop(ch));
      case "bot/restart": return out(await this.restart(ch));
      case "bot/delete": return out(await this.remove(ch));
      case "bot/set-token": return out(this.setTelegram(ch, p.tokenEnv));
      case "bot/send-prompt": return out(await this.send(ch, String(p.text ?? "")));
      case "bot/settings": return out(this.settings(ch));
      case "bot/save-settings": return out(this.saveSettings(ch, p));
      case "bot/catalog": return { status: 200, body: { ok: true, ...this.catalog() } };
      case "bot/agmsg": return out(this.messages(ch, Number(p.limit) || 10));
    }
    return { status: 404, body: { ok: false, error: "not available for native bots" } };
  }
}
