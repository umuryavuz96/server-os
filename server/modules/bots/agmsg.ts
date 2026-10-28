// agmsg (https://github.com/fujibee/agmsg, MIT): cross-agent messaging through a shared SQLite file. Native bots join a
// Server OS team with their bot name so they can message each other and the owner's sessions. Only agmsg's own scripts
// are called (join.sh, delivery.sh, send.sh, history.sh, team.sh, leave.sh); its database and team files are never opened.
// AGMSG_STORAGE_PATH (agmsg's supported override) moves the message store; teams/ and run/ stay in the skill folder,
// so a fully separate agmsg (tests) is a separate skill folder (bots.agmsg.dir).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../lib";
import type { Exec } from "./native";

export const AGMSG_REPO = "https://github.com/fujibee/agmsg";
export const AGMSG_INSTALL = "npx agmsg   (or: git clone https://github.com/fujibee/agmsg && ./agmsg/setup.sh) — MIT licensed; needs bash + sqlite3";
export const AGMSG_TYPE = "claude-code";
/** Claude Code's recommended delivery: a SessionStart hook starts a Monitor on watch.sh (real-time push). */
export const AGMSG_DELIVERY = "monitor";
const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AgmsgOptions { dir?: string; storage?: string | null; exec: Exec }
export interface AgmsgMessage { unread: boolean; at: string; from: string; to: string; body: string }

export class Agmsg {
  readonly dir: string;
  readonly scripts: string;
  readonly storage: string | null;
  constructor(private readonly o: AgmsgOptions) {
    this.dir = (o.dir ?? join(HOME, ".agents", "skills", "agmsg")).replace(/\/+$/, "");
    this.scripts = join(this.dir, "scripts");
    this.storage = o.storage ?? null;
  }
  static validTeam = (t: string) => TEAM_RE.test(t);
  installed = () => existsSync(join(this.scripts, "join.sh")) && existsSync(join(this.scripts, "send.sh")) && !!Bun.which("sqlite3");
  /** Environment every agmsg call (and the bot itself) gets, so hooks and scripts use the same store. */
  env = (): Record<string, string> => (this.storage ? { AGMSG_STORAGE_PATH: this.storage } : {});

  /** The argv for one agmsg script. Run through `env` so AGMSG_STORAGE_PATH reaches it. */
  argv(script: string, args: string[]): string[] {
    return ["/usr/bin/env", ...Object.entries(this.env()).map(([k, v]) => `${k}=${v}`), "bash", join(this.scripts, script), ...args];
  }
  private run(script: string, args: string[]) { return this.o.exec(this.argv(script, args)); }

  /** Join <team> as <agent> for the bot folder, then turn on monitor delivery there (writes <cwd>/.claude/settings.local.json hooks). */
  join(team: string, agent: string, cwd: string) {
    const j = this.run("join.sh", [team, agent, AGMSG_TYPE, cwd]);
    if (j.code !== 0) return { ok: false as const, error: j.out };
    const d = this.run("delivery.sh", ["set", AGMSG_DELIVERY, AGMSG_TYPE, cwd]);
    return d.code === 0 ? { ok: true as const, out: j.out } : { ok: false as const, error: d.out };
  }
  leave(team: string, agent: string) { return this.run("leave.sh", [team, agent]); }
  send(team: string, from: string, to: string, body: string) { return this.run("send.sh", [team, from, to, body]); }
  members(team: string): string[] {
    const r = this.run("team.sh", [team]);
    if (r.code !== 0) return [];
    return [...r.out.matchAll(/^\s+(\S+) \(/gm)].map((m) => m[1]);
  }
  /** Newest-last messages from or to <agent>, parsed from history.sh's "● [ts] from → to: body" lines. */
  history(team: string, agent: string, limit = 10): AgmsgMessage[] {
    const r = this.run("history.sh", [team, agent, String(limit)]);
    if (r.code !== 0) return [];
    return r.out.split("\n").map((l) => l.match(/^\s*([●○]) \[([^\]]+)\] (\S+) → (\S+): (.*)$/)).filter((m) => !!m)
      .map((m) => ({ unread: m[1] === "●", at: m[2], from: m[3], to: m[4], body: m[5].replace(/\\n/g, "\n").replace(/\\t/g, "\t") }));
  }
}
