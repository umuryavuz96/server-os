import { test, expect } from "bun:test";
import { botPane, oldestPane } from "./tmuxPane";

test("oldestPane: lowest pane id, numerically, ignoring noise", () => {
  expect(oldestPane("%75\n%4\n%77\n")).toBe("%4");
  expect(oldestPane("%10\n%9\n")).toBe("%9");
  expect(oldestPane("")).toBeNull();
  expect(oldestPane("can't find session\n")).toBeNull();
});

test("botPane: exact-match session list, the bot's own pane; falls back to the session when unreadable", () => {
  const seen: string[][] = [];
  const ok = (out: string, code = 0) => (cmd: string[]) => { seen.push(cmd); return { code, out }; };
  expect(botPane("tmux", "bot-main", ok("%4\n%75\n%77\n"))).toBe("%4");
  expect(seen[0]).toEqual(["tmux", "list-panes", "-s", "-t", "=bot-main", "-F", "#{pane_id}"]);
  expect(botPane("tmux", "bot-main", ok("can't find session", 1))).toBe("=bot-main:");
  expect(botPane("tmux", "bot-main", ok(""))).toBe("=bot-main:");
});
