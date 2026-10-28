import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME = mkdtempSync(join(tmpdir(), "sd-sched-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const s = await import("./scheduler");
const { dir } = await import("../core/config"); // test files share one process, so the home folder is whichever file loaded config first
beforeAll(() => useDatabase(new Database(":memory:")));

const waitRun = async (id: number) => { for (let i = 0; i < 100; i++) { const r = s.getRun(id); if (r?.ended) return r; await Bun.sleep(20); } throw new Error("run did not finish"); };

describe("schedule", () => {
  test("validates cron and @every", () => {
    expect(s.validSchedule("*/5 * * * *")).toBe(true);
    expect(s.validSchedule("0 8 * * 1-5")).toBe(true);
    expect(s.validSchedule("@every 10m")).toBe(true);
    expect(s.validSchedule("every day")).toBe(false);
    expect(s.validSchedule("* * * *")).toBe(false);
  });
  test("@every counts from the last start, cron from the clock", () => {
    expect(s.nextDue("@every 10m", 1000, 1100)).toBe(1600);
    expect(s.nextDue("@every 10m", null, 1000)).toBe(1600);
    const n = s.nextDue("*/5 * * * *", null, Date.UTC(2026, 0, 1, 10, 2) / 1000)!;
    expect(new Date(n * 1000).getMinutes() % 5).toBe(0);
    expect(s.describeSchedule("@every 2h")).toBe("every 2 h");
    expect(s.describeSchedule(undefined)).toBe("manual");
  });
});

describe("jobs", () => {
  test("validation messages", () => {
    expect(s.validate({ name: "x", kind: "command" })).toContain("command");
    expect(s.validate({ name: "x", kind: "http", url: "ftp://x" })).toContain("url");
    expect(s.validate({ name: "x", kind: "command", command: "true", schedule: "nope" })).toContain("schedule");
    expect(s.validate({ name: "x", kind: "command", command: "true" })).toBeNull();
  });
  test("save → run → record output, exit code, trace", async () => {
    expect(s.saveSpec("hello", { name: "Hello", kind: "command", command: "echo hi; echo \"$SD_PAYLOAD\"" }).ok).toBe(true);
    const r = s.startRun("hello", "manual", "test", undefined, "payload!");
    if (!r.ok) throw new Error(r.error);
    expect(s.startRun("hello", "manual", "test").ok).toBe(false); // already running
    const done = await waitRun(r.runId);
    expect(done.ok).toBe(true);
    expect(done.output).toBe("hi\npayload!");
    expect(done.traceId).toBe(r.trace.trace_id);
    const j = s.serverJobs().find((x) => x.id === "sd:hello")!;
    expect(j.status).toBe("ok");
    expect(j.when).toBe("manual");
  });
  test("failure and timeout", async () => {
    s.saveSpec("bad", { name: "Bad", kind: "command", command: "echo oops >&2; exit 3" });
    const r = s.startRun("bad", "manual", "test"); if (!r.ok) throw new Error(r.error);
    const done = await waitRun(r.runId);
    expect(done).toMatchObject({ ok: false, exitCode: 3 });
    expect(s.serverJobs().find((x) => x.id === "sd:bad")!.cause).toBe("oops");
    s.saveSpec("slow", { name: "Slow", kind: "command", command: "sleep 5", timeout: 1 });
    const t = s.startRun("slow", "manual", "test"); if (!t.ok) throw new Error(t.error);
    const st = await (async () => { for (let i = 0; i < 100; i++) { const x = s.getRun(t.runId); if (x?.ended) return x; await Bun.sleep(50); } })();
    expect(st?.exitCode).toBe(124);
  });
  test("scheduled jobs run when due; paused ones don't", async () => {
    s.saveSpec("tick", { name: "Tick", kind: "command", command: "true", schedule: "@every 10s" });
    s.saveSpec("paused", { name: "Paused", kind: "command", command: "true", schedule: "@every 10s", enabled: false });
    s.tick(Date.now() / 1000 + 11);
    await Bun.sleep(150);
    expect(s.listRuns("tick").length).toBe(1);
    expect(s.listRuns("paused").length).toBe(0);
  });
  test("job.yaml on disk, webhook secret, delete", () => {
    s.saveSpec("hook", { name: "Hook", kind: "command", command: "true", webhook: true });
    const yaml = readFileSync(join(dir("jobs"), "hook", "job.yaml"), "utf8");
    expect(yaml).toContain("webhook: true");
    expect(s.webhookSecret("hook")).toBe(s.webhookSecret("hook"));
    expect(s.deleteSpec("hook")).toBe(true);
    expect(s.getSpec("hook")).toBeNull();
    expect(s.saveSpec("Bad Id", { name: "x", kind: "command", command: "true" }).ok).toBe(false);
  });
});
