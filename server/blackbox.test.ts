import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucket, parseSamples, readBlackbox } from "./blackbox";

const line = (ts: string, avail: number, swap = 100) => JSON.stringify({ ts, mem: { avail_mb: avail, swap_used_mb: swap, pressure: "normal", compressed_mb: 1, wired_mb: 1 }, load: [1, 1, 1], top: [{ name: "x", pid: 1, mb: 5 }], claude_procs: 2, docker_ok: true, tmux: [] });

test("parse skips torn lines; bucket keeps the worst case per 5 min", () => {
  const s = parseSamples([line("2026-11-03T00:00:10+01:00", 3000), line("2026-11-03T00:01:10+01:00", 900, 2500), '{"ts":"bad'].join("\n"));
  expect(s.length).toBe(2);
  const b = bucket(s);
  expect(b.length).toBe(1);
  expect(b[0].availMb).toBe(900);
  expect(b[0].swapMb).toBe(2500);
});

test("readBlackbox on empty dirs is safe, reads reports newest first", () => {
  const d = mkdtempSync(join(tmpdir(), "bb-")), r = mkdtempSync(join(tmpdir(), "br-"));
  expect(readBlackbox(Date.now(), join(d, "nope"), join(r, "nope")).history).toEqual([]);
  const now = Date.now();
  writeFileSync(join(d, "2026-11-03.jsonl"), line(new Date(now - 60_000).toISOString(), 4000) + "\n");
  writeFileSync(join(r, "20261102-234900.md"), "# a"); writeFileSync(join(r, "20261103-001000.md"), "# b");
  const o = readBlackbox(now, d, r);
  expect(o.last?.availMb).toBe(4000);
  expect(o.reports.map((x) => x.md)).toEqual(["# b", "# a"]);
});
