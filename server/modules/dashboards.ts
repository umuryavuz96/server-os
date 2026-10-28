// JSON dashboards: one file per dashboard in <home>/dashboards/<id>.json,
// validated against spec/dashboard.schema.json. The server ships a pre-made "home" dashboard.
import Ajv2020 from "ajv/dist/2020";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";

export interface Card { id: string; type: string; title?: string; x: number; y: number; w: number; h: number; design?: string; query?: Record<string, unknown>; text?: string }
export interface Dashboard { id?: string; title: string; description?: string; refresh?: number; cards: Card[] }

export const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "../../spec/dashboard.schema.json"), "utf8"));
const check = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const file = (id: string) => join(dir("dashboards"), `${id}.json`);

export function validate(d: unknown): string | null {
  if (!check(d)) return (check.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "dashboard"} ${e.message}`).join("; ");
  const cards = (d as Dashboard).cards;
  const ids = new Set<string>();
  for (const c of cards) {
    if (ids.has(c.id)) return `card id ${c.id} is used twice`;
    ids.add(c.id);
    if (c.x + c.w > 12) return `card ${c.id} runs past column 12 (x ${c.x} + w ${c.w})`;
  }
  return null;
}

export const DEFAULT: Dashboard = {
  title: "Home", description: "The pre-made dashboard — rearrange it, or build your own.", refresh: 60,
  cards: [
    { id: "ram", type: "metric", title: "Memory in use", x: 0, y: 0, w: 6, h: 4, design: "hero", query: { metric: "ram", range: "6h", unit: "GB" } },
    { id: "cpu", type: "metric", title: "CPU temperature", x: 6, y: 0, w: 3, h: 2, design: "line", query: { metric: "cpu", range: "6h", unit: "°C" } },
    { id: "disk", type: "gauge", title: "Disk used", x: 9, y: 0, w: 3, h: 2, design: "ring", query: { metric: "disk", unit: "%", max: 100, warn: 80, bad: 90 } },
    { id: "swap", type: "stat", title: "Swap", x: 6, y: 2, w: 3, h: 2, design: "tile", query: { value: "system.swapGB", unit: "GB", warn: 4, bad: 8 } },
    { id: "load", type: "stat", title: "Load", x: 9, y: 2, w: 3, h: 2, design: "tile", query: { value: "system.load1", warn: 6, bad: 10 } },
    { id: "apps", type: "apps", title: "Top apps by RAM", x: 0, y: 4, w: 4, h: 5, design: "list", query: { filter: "on", sort: "mem", limit: 6 } },
    { id: "jobs", type: "jobs", title: "Up next", x: 4, y: 4, w: 4, h: 5, design: "list", query: { filter: "next", limit: 6 } },
    { id: "claude", type: "claude", title: "Claude", x: 8, y: 4, w: 4, h: 5, design: "usage" },
    { id: "ram7d", type: "bar", title: "Memory, last 7 days", x: 0, y: 9, w: 8, h: 4, query: { metric: "ram", range: "7d", points: 28, unit: "GB" } },
    { id: "logs", type: "logs", title: "Warnings", x: 8, y: 9, w: 4, h: 4, design: "stream", query: { filter: "warn", limit: 20 } },
  ],
};

export function listDashboards(): { id: string; title: string; description?: string; cards: number }[] {
  if (!existsSync(dir("dashboards"))) return [];
  return readdirSync(dir("dashboards")).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    const id = f.slice(0, -5);
    try { const d = JSON.parse(readFileSync(file(id), "utf8")) as Dashboard; return [{ id, title: d.title, description: d.description, cards: d.cards?.length ?? 0 }]; } catch { return []; }
  });
}
export function getDashboard(id: string): Dashboard | null {
  if (!ID.test(id) || !existsSync(file(id))) return null;
  try { return { ...JSON.parse(readFileSync(file(id), "utf8")), id }; } catch { return null; }
}
export function saveDashboard(id: string, d: Dashboard): string | null {
  if (!ID.test(id)) return "id: lowercase letters, digits and dashes";
  const { id: _drop, ...body } = d;
  const err = validate(body);
  if (err) return err;
  mkdirSync(dir("dashboards"), { recursive: true });
  writeFileSync(file(id), JSON.stringify(body, null, 2) + "\n");
  return null;
}
export function deleteDashboard(id: string): boolean {
  if (!ID.test(id) || !existsSync(file(id))) return false;
  rmSync(file(id));
  return true;
}
export function ensureDefault() {
  if (!listDashboards().length) saveDashboard("home", DEFAULT);
}
