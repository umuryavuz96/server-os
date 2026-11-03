import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentTasks, mergeTasks, taskFile } from "./agentTasks";

test("reads tasks.sh files, tolerates missing and broken ones", () => {
  const d = mkdtempSync(join(tmpdir(), "tk-"));
  expect(taskFile("error-logging/backend-1")).toBe("error-logging__backend-1.json");
  expect(readAgentTasks("a/b", d)).toEqual([]);
  writeFileSync(join(d, "a__b.json"), "{ torn");
  expect(readAgentTasks("a/b", d)).toEqual([]);
  writeFileSync(join(d, "a__b.json"), JSON.stringify({ tasks: [{ id: 1, text: "one", status: "done" }, { id: 2, text: "two", status: "in_progress" }, { id: 3, text: "", status: "pending" }] }));
  expect(readAgentTasks("a/b", d).map((t) => [t.id, t.status])).toEqual([["f:1", "done"], ["f:2", "in_progress"]]);
});

test("merge keeps transcript tasks first and drops duplicate texts", () => {
  const tr = [{ id: "1", text: "Build it", status: "pending" as const }];
  const fl = [{ id: "f:1", text: "build IT", status: "done" as const }, { id: "f:2", text: "Ship", status: "pending" as const }];
  expect(mergeTasks(tr, fl).map((t) => t.id)).toEqual(["1", "f:2"]);
  expect(mergeTasks([], fl).length).toBe(2);
});

test("tasks.sh add/start/done/list round trip", async () => {
  const d = mkdtempSync(join(tmpdir(), "tk-"));
  const sh = (...a: string[]) => Bun.spawnSync([join(process.env.HOME!, ".agents/skills/agmsg/scripts/tasks.sh"), "t", "n", ...a], { env: { ...process.env, AGMSG_TASKS_DIR: d } }).stdout.toString().trim();
  expect(sh("add", "first")).toBe("1");
  expect(sh("add", "second")).toBe("2");
  expect(sh("start", "--id", "1")).toBe("1 in_progress");
  expect(sh("done", "second")).toBe("2 done");
  expect(readAgentTasks("t/n", d).map((t) => t.status)).toEqual(["in_progress", "done"]);
});
