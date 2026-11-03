// Tool-independent task lists: `agmsg/scripts/tasks.sh <team> <name> add|start|done|list` keeps one JSON file per agent.
// The agent panel shows them next to the tasks parsed from the transcript (TodoWrite / TaskCreate).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./lib";
import type { TaskItem } from "./modules/bots/transcript";

export const TASKS_DIR = () => process.env.AGMSG_TASKS_DIR ?? join(HOME, ".agents/skills/agmsg/run/tasks");
export const taskFile = (key: string) => { const [team, name] = key.split("/"); return team && name ? `${team}__${name}.json` : null; };

/** The agent's file tasks (ids prefixed "f:"), [] when there is no file or it is unreadable. */
export function readAgentTasks(key: string, dir = TASKS_DIR()): TaskItem[] {
  const f = taskFile(key);
  if (!f) return [];
  try {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { tasks?: { id: number; text: string; status: string }[] };
    return (raw.tasks ?? []).filter((t) => t && typeof t.text === "string" && t.text)
      .map((t) => ({ id: `f:${t.id}`, text: t.text, status: t.status === "done" ? "done" : t.status === "in_progress" ? "in_progress" : "pending" }));
  } catch { return []; }
}

/** Transcript tasks first, then file tasks; a file task whose text a transcript task already has is dropped. */
export function mergeTasks(fromTranscript: TaskItem[], fromFile: TaskItem[]): TaskItem[] {
  const seen = new Set(fromTranscript.map((t) => t.text.trim().toLowerCase()));
  return [...fromTranscript, ...fromFile.filter((t) => !seen.has(t.text.trim().toLowerCase()))];
}
