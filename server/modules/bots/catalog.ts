// What a bot can be given: skills, plugins and MCP servers already installed for this user. Global files
// (~/.claude/skills, ~/.agents/skills, ~/.claude/plugins/installed_plugins.json, ~/.claude/settings.json, ~/.claude.json,
// ~/.mcp.json) are only ever read. The per-bot result is written inside the bot's folder: .mcp.json and .claude/skills links.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME } from "../../lib";
import type { BotPolicy } from "./policy";

export interface SkillEntry { id: string; name: string; source: "global" | "agents"; path: string; description: string }
export interface Catalog {
  skills: SkillEntry[];
  plugins: { id: string; enabled: boolean }[];
  mcp: { id: string; name: string; source: "user" | "mcpjson" }[];
  /** ~/.env variable NAMES (never values). */
  envKeys: string[];
}
export interface CatalogPaths { claudeDir: string; agentsSkills: string; claudeJson: string; mcpJson: string }
export const defaultCatalogPaths = (): CatalogPaths => ({
  claudeDir: join(HOME, ".claude"), agentsSkills: join(HOME, ".agents", "skills"), claudeJson: join(HOME, ".claude.json"), mcpJson: join(HOME, ".mcp.json"),
});

const readJson = (f: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,100}$/;

function skillsIn(dir: string, source: SkillEntry["source"], skip: string[]): SkillEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => SAFE.test(d) && !skip.includes(d) && existsSync(join(dir, d, "SKILL.md"))).map((d) => {
    const md = readFileSync(join(dir, d, "SKILL.md"), "utf8").slice(0, 4000);
    const name = md.match(/^name:\s*["']?([^"'\n]+)/m)?.[1]?.trim() || d;
    const description = md.match(/^description:\s*["']?([^\n]+)/m)?.[1]?.replace(/["']$/, "").trim().slice(0, 160) ?? "";
    return { id: `${source}:${d}`, name, source, path: join(dir, d), description };
  });
}

export function readCatalog(p: CatalogPaths, envKeys: string[]): Catalog {
  const installed = (readJson(join(p.claudeDir, "plugins", "installed_plugins.json"))?.plugins ?? {}) as Record<string, unknown>;
  const enabled = (readJson(join(p.claudeDir, "settings.json"))?.enabledPlugins ?? {}) as Record<string, boolean>;
  const user = Object.keys((readJson(p.claudeJson)?.mcpServers ?? {}) as object);
  const proj = Object.keys((readJson(p.mcpJson)?.mcpServers ?? {}) as object);
  return {
    skills: [...skillsIn(join(p.claudeDir, "skills"), "global", ["synced"]), ...skillsIn(p.agentsSkills, "agents", ["agmsg"])],
    plugins: Object.keys(installed).filter((id) => SAFE.test(id)).map((id) => ({ id, enabled: enabled[id] !== false })),
    mcp: [...user.filter((n) => SAFE.test(n)).map((name) => ({ id: `user:${name}`, name, source: "user" as const })),
      ...proj.filter((n) => SAFE.test(n)).map((name) => ({ id: `mcpjson:${name}`, name, source: "mcpjson" as const }))],
    envKeys,
  };
}

/** Is a skill on for this bot? Global skills (and plugins) load by default unless the bot is isolated; others are opt-in. */
export const skillOn = (p: BotPolicy, s: SkillEntry) => p.skills[s.id] ?? (s.source === "global" && !p.isolated);
export const mcpOn = (p: BotPolicy, id: string) => p.mcp[id] ?? (id.startsWith("user:") && !p.isolated);

/** Write the bot's .mcp.json and .claude/skills links. Touches nothing outside <cwd>. Returns the .mcp.json servers on/off
 *  ("on" includes servers the bot's .mcp.json already had of its own). */
export function applyWorkspace(cwd: string, p: BotPolicy, cat: Catalog, paths: CatalogPaths) {
  const root = resolve(cwd);
  const inside = (f: string) => { const r = resolve(f); if (r !== root && !r.startsWith(root + "/")) throw new Error(`refusing to write outside ${root}: ${r}`); return r; };

  // skills: a symlink per opted-in skill that doesn't load on its own (agents skills, or global ones when isolated)
  const sd = inside(join(cwd, ".claude", "skills"));
  const want = new Map(cat.skills.filter((s) => skillOn(p, s) && (s.source === "agents" || p.isolated)).map((s) => [s.path.split("/").pop()!, s.path]));
  const sources = new Set(cat.skills.map((s) => s.path));
  if (existsSync(sd)) for (const f of readdirSync(sd)) {
    const l = join(sd, f);
    const st = lstatSync(l);
    // only links we made (pointing at a catalog skill) are removed; real folders the bot or owner made stay
    if (st.isSymbolicLink() && sources.has(readlinkSync(l)) && want.get(f) !== readlinkSync(l)) unlinkSync(inside(l));
  }
  for (const [name, target] of want) {
    const l = inside(join(sd, name));
    if (existsSync(l) || (() => { try { lstatSync(l); return true; } catch { return false; } })()) continue;
    mkdirSync(sd, { recursive: true });
    symlinkSync(target, l);
  }

  // .mcp.json: copy chosen ~/.mcp.json servers (and, when isolated, chosen user servers); keep the bot's own entries
  const mf = inside(join(cwd, ".mcp.json"));
  const cur = (readJson(mf)?.mcpServers ?? {}) as Record<string, unknown>;
  const src = { mcpjson: (readJson(paths.mcpJson)?.mcpServers ?? {}) as Record<string, unknown>, user: (readJson(paths.claudeJson)?.mcpServers ?? {}) as Record<string, unknown> };
  const on: string[] = [], off: string[] = [];
  for (const m of cat.mcp) {
    const copy = m.source === "mcpjson" || p.isolated;
    if (!copy) continue;
    if (mcpOn(p, m.id) && src[m.source][m.name]) { cur[m.name] = src[m.source][m.name]; on.push(m.name); }
    else if (m.name in cur) { delete cur[m.name]; }
    if (!mcpOn(p, m.id) && m.source === "mcpjson") off.push(m.name);
  }
  // the bot's own servers (in its .mcp.json, not from the catalog) stay on: an adopted folder keeps its tools
  const known = new Set(cat.mcp.filter((m) => m.source === "mcpjson" || p.isolated).map((m) => m.name));
  for (const n of Object.keys(cur)) if (!known.has(n) && !on.includes(n)) on.push(n);
  if (Object.keys(cur).length || existsSync(mf)) {
    writeFileSync(mf + ".tmp", JSON.stringify({ mcpServers: cur }, null, 2) + "\n", { mode: 0o600 }); // entries may carry the owner's env values
    renameSync(mf + ".tmp", mf);
  }
  return { mcpjsonOn: on, mcpjsonOff: off.filter((n) => !on.includes(n)) };
}
