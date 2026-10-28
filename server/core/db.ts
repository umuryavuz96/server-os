// One SQLite database for the server's own records: data/server-os.db. Each module registers its tables.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./config";

const SCHEMA: string[] = [];
let handle: Database | null = null;

/** Register CREATE TABLE / INDEX statements; they run (idempotently) when the database opens. */
export function schema(...sql: string[]) {
  SCHEMA.push(...sql);
  if (handle) for (const s of sql) handle.run(s);
}

export function db(): Database {
  if (handle) return handle;
  if (!existsSync(dir("data"))) mkdirSync(dir("data"), { recursive: true });
  const old = join(dir("data"), "server-dash.db"); // pre-rename name: keep using it when it is the one that exists
  const file = existsSync(old) && !existsSync(join(dir("data"), "server-os.db")) ? old : join(dir("data"), "server-os.db");
  return useDatabase(new Database(file, { create: true }));
}

/** Point the store at another database (tests use ":memory:"). */
export function useDatabase(d: Database): Database {
  handle = d;
  d.run("PRAGMA journal_mode = WAL");
  for (const s of SCHEMA) d.run(s);
  return d;
}
