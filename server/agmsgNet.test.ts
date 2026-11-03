import { test, expect } from "bun:test";
import { matchAll, matchSession, matchDirector, msgKind, buildClusters, tempState, type LiveSession } from "./agmsgNet";

const s = (pid: number, name: string, cwd: string): LiveSession => ({ pid, sessionId: `sid-${pid}`, cwd, name, status: "idle", startedAt: 1, tmux: null });
const live = [s(1, "team-a-app-tidecall", "/p/duo-fleet"), s(2, "botx-5e", "/b/botx"), s(3, "user-14", "/home/user"), s(4, "other", "/p/solo")];

test("agmsg spawn name wins", () => { expect(matchSession("team-a", "app-tidecall", "/elsewhere", live)?.via).toBe("spawn name"); });
test("bot-manager short-id name", () => { expect(matchSession("boss", "botx", "/x", live)?.s.pid).toBe(2); });
test("tmux window named after the agent", () => {
  expect(matchSession("t", "nobody", null, live, new Map([["nobody", [4]]]))?.via).toBe("tmux window");
});
test("unique project folder as last resort, no match otherwise", () => {
  expect(matchSession("t", "solo-agent", "/p/solo", live)?.s.pid).toBe(4);
  expect(matchSession("t", "ghost", "/nowhere", live)).toBeNull();
});
test("name prefix does not match a longer name", () => { expect(matchSession("t", "app", null, live)).toBeNull(); });
test("director by folder, bot-manager name first", () => {
  expect(matchDirector({ name: "D", cwd: "/home/user" }, [s(9, "x", "/home/user"), ...live])?.pid).toBe(3);
  expect(matchDirector({ name: "D" }, live)).toBeNull();
});

test("message kinds", () => {
  expect(msgKind("SHELVED by the owner. STOP now: no more commits")).toBe("stop");
  expect(msgKind("Build failed: error in Model.swift")).toBe("bug");
  expect(msgKind("Please confirm: does hierarchy get a director key?")).toBe("question");
  expect(msgKind("Done. Shipped items 1-7, committed.")).toBe("report");
  expect(msgKind("FYI item 8 live")).toBe("status");
  expect(msgKind("Questions: (1) are you adding status? Field names? (2) chat path")).toBe("question");
  expect(msgKind("LIVE now: kind = 'stop'|'bug'")).not.toBe("stop");
  expect(msgKind("see https://x.dev/a?b=1 for the update")).toBe("status");
  expect(msgKind("news-sweep 2026-10-30T21:30:00Z")).toBeNull();
});

test("clusters: staff first, director never a member, flat reports to director, archive marked", () => {
  const mem = [{ name: "root", team: "apps", types: [], project: null }, { name: "a", team: "apps", types: [], project: null }, { name: "b", team: "apps", types: [], project: null },
    { name: "bot", team: "staff", types: [], project: null }, { name: "old", team: "staff", types: [], project: null }, { name: "x", team: "gone", types: [], project: null }];
  const msgs = [{ id: 1, team: "staff", from: "cron", to: "bot", body: "", at: 0, kind: null }];
  const c = buildClusters(["apps", "gone", "staff"], mem, msgs, { apps: { job: "Apps", root: "a" }, staff: { job: "Standing staff", staff: true, archived: ["old"] }, gone: { archived: true } }, "root");
  expect(c.map((x) => x.id)).toEqual(["c:staff", "c:apps", "c:gone"]);
  expect(c[0].members.map((m) => [m.name, m.archived, m.external])).toEqual([["bot", false, false], ["old", true, false], ["cron", false, true]]);
  expect(c[1].members.map((m) => [m.name, m.manager])).toEqual([["a", "@director"], ["b", "a"]]);
  expect(c[1].lead).toBe("a");
  expect(c[2].done).toBe(true);
});

test("temp agent state", () => {
  const now = 1_000_000_000;
  expect(tempState({ finished: true }, now, "", now)).toEqual({ running: false, ended: "finished" });
  expect(tempState({}, now - 60_000, "...", now)).toEqual({ running: true, ended: null });
  expect(tempState({}, now - 11 * 60_000, "", now)).toEqual({ running: false, ended: "stopped" });
  expect(tempState({}, now, '{"text":"[Request interrupted by user for tool use]"}', now).ended).toBe("stopped");
});

test("an exact-name session is not stolen by an earlier member's folder guess; a session appearing later is matched", () => {
  const mk = (pid: number, name: string): LiveSession => ({ pid, sessionId: "s" + pid, cwd: "/p/dash", name, status: "busy", startedAt: 0, tmux: null });
  const mem = [{ team: "a", name: "builder", project: "/p/dash" }, { team: "team-a", name: "sos", project: "/p/dash" }, { team: "ram", name: "qa-1", project: "/p/dash" }];
  const wins = new Map<string, number[]>();
  const one = matchAll(mem, [mk(1, "a-builder"), mk(2, "ram-qa-1")], new Set(), wins);
  expect(one.get("ram/qa-1")?.s.pid).toBe(2);
  expect(one.get("team-a/sos")).toBeUndefined();
  // a new session file shows up on the next read: matched on the next pass
  const two = matchAll(mem, [mk(1, "a-builder"), mk(2, "ram-qa-1"), mk(3, "team-a-sos")], new Set(), wins);
  expect(two.get("team-a/sos")?.s.pid).toBe(3);
  expect(two.get("ram/qa-1")?.s.pid).toBe(2);
});
