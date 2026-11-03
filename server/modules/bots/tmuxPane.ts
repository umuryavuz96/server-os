// Which tmux pane is the bot? A plain `-t bot-main` means "the session's active pane", and Claude Code agent teams
// (teammateMode tmux) split the bot's window and leave a teammate's pane active. Typing then landed in a teammate
// (or a dead teammate pane), and Escape interrupted the teammate instead of the bot. The bot is the pane the session
// started with, which is the oldest pane: the lowest pane id.

/** The lowest pane id ("%4") in `tmux list-panes -s -F '#{pane_id}'` output, or null when there is none. */
export function oldestPane(listOut: string): string | null {
  const ids = listOut.split("\n").map((l) => l.trim().match(/^%(\d+)$/)?.[1]).filter((x): x is string => !!x).map(Number);
  return ids.length ? `%${Math.min(...ids)}` : null;
}

type Exec = (cmd: string[]) => { code: number; out: string };
const spawn: Exec = (cmd) => {
  try { const r = Bun.spawnSync(cmd); return { code: r.exitCode ?? 1, out: r.stdout.toString() }; } catch { return { code: 1, out: "" }; }
};

/** A -t target for the bot in tmux session `session`: its own (oldest) pane, matched exactly ("=" stops tmux from
 *  matching name prefixes). Falls back to the session's active pane when the panes can't be listed. */
export function botPane(tmux: string, session: string, exec: Exec = spawn): string {
  const r = exec([tmux, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"]);
  return (r.code === 0 && oldestPane(r.out)) || `=${session}:`;
}
