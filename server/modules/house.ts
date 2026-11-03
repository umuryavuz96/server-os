// The House page's model: storeys of rectangular rooms in metres, Home Assistant areas mapped to rooms, and device pins.
// Kept in <home>/config/house.json once saved; until then the shipped house.default.json. Validated by spec/house.schema.json.
// Pins: an explicit pin (floor, x, y) wins; otherwise an entity whose HA area is mapped to a room (room.haArea) is spread
// inside that room; the rest of the relevant entities are "unplaced" and wait in the page's tray.
import Ajv2020 from "ajv/dist/2020";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";

export interface Rect { x: number; y: number; w: number; d: number }
export interface Room { id: string; name: string; kind?: string; floor?: string; rects: Rect[]; haArea?: string[] }
export interface Furniture { type: string; x: number; y: number; w?: number; d?: number; h?: number; rot?: number; label?: string; z?: number; color?: string }
export interface Floor { id: string; name: string; level: number; depth: number; shell?: Rect; rooms: Room[]; openTo?: [string, string][]; openings?: unknown[]; fixtures?: unknown[]; furniture?: Furniture[]; voids?: Rect[]; flatRoofs?: Rect[]; roof?: unknown }
/** z: height above the storey's floor in metres (0 … storeyHeight); without it the page shows the pin at 0.5 m.
 *  entities: a group pin (its key is a name of our own, e.g. light.tv_unit_lights): one pin for several HA entities that
 *  switch together (a power strip's sockets), on when any is on; the members get no pins of their own. name: its label. */
export type PinSpot = { floor: string; x: number; y: number; z?: number; entities?: string[]; name?: string } | { hidden: true };
export interface House { version?: 1; name: string; mirror?: boolean; width: number; storeyHeight?: number; wall?: Record<string, number>; floors: Floor[]; ignore?: string[]; pins?: Record<string, PinSpot> }

/** An entity as the HA registries describe it (server/modules/ha.ts registry()). */
export interface RegEntity { id: string; name: string; domain: string; area: string | null; deviceClass: string | null; device: string | null; state?: string; unit?: string }
export interface Area { id: string; name: string; floor: string | null }
export interface Pin { id: string; floor: string; room: string | null; x: number; y: number; z?: number; auto: boolean; entities?: string[]; name?: string }

export const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "../../spec/house.schema.json"), "utf8"));
const DEFAULT_FILE = join(import.meta.dir, "house.default.json");
const check = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);
const file = () => join(dir("config"), "house.json");

export const shellOf = (h: House, f: Floor): Rect => f.shell ?? { x: 0, y: 0, w: h.width, d: f.depth };
const inRect = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.d + pad;

/** Why the model can't be saved, or null. The schema first, then what a schema can't say (ids, rooms inside the house). */
export function validateHouse(h: unknown): string | null {
  if (!check(h)) return (check.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "house"} ${e.message}`).join("; ");
  const house = h as House, floors = new Set<string>(), rooms = new Set<string>();
  for (const f of house.floors) {
    if (floors.has(f.id)) return `floor id ${f.id} is used twice`;
    floors.add(f.id);
    const shell = shellOf(house, f);
    for (const r of f.rooms) {
      if (rooms.has(r.id)) return `room id ${r.id} is used twice`;
      rooms.add(r.id);
      for (const q of r.rects) if (!inRect(shell, q.x, q.y, 0.05) || !inRect(shell, q.x + q.w, q.y + q.d, 0.05)) return `room ${r.id} reaches outside ${f.name}`;
    }
    for (const [a, b] of f.openTo ?? []) if (!f.rooms.some((r) => r.id === a) || !f.rooms.some((r) => r.id === b)) return `openTo ${a}/${b}: no such room on ${f.name}`;
  }
  return validatePins(house, house.pins ?? {});
}
function validatePins(h: House, pins: Record<string, PinSpot>): string | null {
  for (const [id, p] of Object.entries(pins)) {
    if ("hidden" in p) continue;
    const f = h.floors.find((x) => x.id === p.floor);
    if (!f) return `pin ${id}: no floor ${p.floor}`;
    if (!inRect(shellOf(h, f), p.x, p.y, 0.05)) return `pin ${id} is outside ${f.name}`;
    if (p.z != null && p.z > (h.storeyHeight ?? 2.8) + 0.01) return `pin ${id} is above the ceiling of ${f.name}`;
    for (const m of p.entities ?? []) {
      if (m === id) return `pin ${id}: a group can't hold itself`;
      const own = pins[m];
      if (own && !("hidden" in own)) return `pin ${id}: ${m} is in the group and has a pin of its own`;
    }
  }
  return null;
}

export function getHouse(): House {
  for (const p of [file(), DEFAULT_FILE]) {
    if (!existsSync(p)) continue;
    try { const h = JSON.parse(readFileSync(p, "utf8")) as House; if (!validateHouse(h)) return p === DEFAULT_FILE ? h : withDefaults(h); } catch { /* fall through to the shipped model */ }
  }
  return JSON.parse(readFileSync(DEFAULT_FILE, "utf8"));
}
export const isCustom = () => existsSync(file());

/** A house saved before furniture, voids and the site existed borrows them from the shipped model (same floor ids). */
export function withDefaults(h: House): House {
  const def = JSON.parse(readFileSync(DEFAULT_FILE, "utf8")) as House & { site?: unknown; facing?: number };
  const out = { ...h } as House & { site?: unknown; facing?: number };
  out.site ??= def.site; out.facing ??= def.facing;
  out.floors = h.floors.map((f) => {
    const d = def.floors.find((x) => x.id === f.id);
    return d ? { ...f, furniture: f.furniture ?? d.furniture, voids: f.voids ?? d.voids } : f;
  });
  return out;
}

/** Write next to the target and rename over it, so a crash never leaves half a file. */
function writeAtomic(path: string, body: string) {
  mkdirSync(dir("config"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
export function saveHouse(h: House): string | null {
  const err = validateHouse(h);
  if (err) return err;
  writeAtomic(file(), JSON.stringify(h, null, 2) + "\n");
  return null;
}
/** Replace only the pins (what edit mode saves). null removes a pin, so the area mapping places the entity again. */
export function savePins(changes: Record<string, PinSpot | null>): string | null {
  const h = getHouse(), pins = { ...(h.pins ?? {}) };
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return "pins: an object of entity id → { floor, x, y, z? } | { hidden: true } | null";
  if (Object.keys(changes).length > 500) return "pins: at most 500 changes at once";
  for (const [id, p] of Object.entries(changes)) {
    if (p === null) { delete pins[id]; continue; }
    // moving a group pin (edit mode sends only floor, x, y, z) keeps its members and name
    const was = pins[id], group = was && !("hidden" in was) && was.entities && !("hidden" in p) && !p.entities ? was : null;
    pins[id] = group ? { ...p, entities: group.entities, ...(group.name ? { name: group.name } : {}) } : p;
  }
  return saveHouse({ ...h, pins });
}

// ---------- which entities deserve a pin ----------
const PRIMARY = ["light", "climate", "media_player", "camera", "fan", "vacuum", "cover", "water_heater", "humidifier"];
const SENSOR_CLASSES = ["temperature", "humidity", "pm25", "co2", "power", "illuminance"];
const BINARY_CLASSES = ["motion", "occupancy", "presence", "door", "window", "opening", "garage_door"];
/** Switch names that are settings of another device (a camera's watermark, a purifier's child lock), not things in a room. */
const SETTING = /(alarm|lock|alert|privacy|watermark|wdr|enable|auto_|customized|self_clean|suction|silence|extra_dry|half_load|vario|glimmer|mode|recording|screen_state)/;

/** Sensors without a device class (some Xiaomi/Tuya integrations) still say what they measure through their unit. */
const sensorByUnit = (e: RegEntity) => ["°C", "°F", "µg/m³", "ppm"].includes(e.unit ?? "") || (e.unit === "%" && /humidity/.test(e.id)) || (e.unit === "W" && /power/.test(e.id));
export const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** Lights, switches, climate, media, cameras, covers, fans and the sensors worth a glance (temperature, humidity, air,
 *  power, motion/doors). Registry noise (diagnostic/config entities) is already gone; `ignore` globs drop the rest. */
export function relevant(e: RegEntity, ignore: RegExp[] = []): boolean {
  if (ignore.some((r) => r.test(e.id))) return false;
  if (PRIMARY.includes(e.domain)) return true;
  if (e.domain === "switch") return !SETTING.test(e.id.split(".")[1]);
  if (e.domain === "sensor") return SENSOR_CLASSES.includes(e.deviceClass ?? "") || sensorByUnit(e);
  if (e.domain === "binary_sensor") return BINARY_CLASSES.includes(e.deviceClass ?? "");
  return false;
}

export function roomAt(f: Floor, x: number, y: number): Room | null {
  return f.rooms.find((r) => r.rects.some((q) => inRect(q, x, y))) ?? null;
}
/** The room an HA area belongs to (by area id or name, any case). */
export function roomForArea(h: House, area: Area | undefined): { floor: Floor; room: Room } | null {
  if (!area) return null;
  const keys = [area.id.toLowerCase(), area.name.toLowerCase()];
  for (const floor of h.floors) for (const room of floor.rooms) if ((room.haArea ?? []).some((a) => keys.includes(a.toLowerCase()))) return { floor, room };
  return null;
}

const ORDER = ["light", "switch", "climate", "fan", "media_player", "camera", "cover", "vacuum", "sensor", "binary_sensor"];
const rank = (e: RegEntity) => { const i = ORDER.indexOf(e.domain); return i < 0 ? ORDER.length : i; };
/** n evenly spaced spots inside the room's biggest rectangle, row by row, kept clear of the walls and of the room's
 *  name, which the House page writes along the rectangle's front edge. */
export function spread(room: Room, n: number): { x: number; y: number }[] {
  const r = [...room.rects].sort((a, b) => b.w * b.d - a.w * a.d)[0];
  const pad = Math.min(0.4, r.w / 4, r.d / 4), label = r.d > 1.6 ? 0.45 : 0, y0 = r.y + pad + label, d = r.d - 2 * pad - label;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * r.w) / d)) || 1)), rows = Math.ceil(n / cols);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, row = Math.floor(i / cols);
    out.push({ x: +(r.x + pad + ((c + 0.5) * (r.w - 2 * pad)) / cols).toFixed(2), y: +(y0 + ((row + 0.5) * d) / rows).toFixed(2) });
  }
  return out;
}

/** What belongs with the TV (the players, the soundbar, the TV's own light and its power strip): pinned at the TV. */
const TVISH = /^(media_player|remote)\.|(^|_|\.)tv(_|$)|ambilight|sonos|soundbar|shield/;
/** n spots in rows in front of a TV unit (its facing side, rot as in the furniture list), or null without one. */
export function atTv(f: Floor, room: Room, n: number): { x: number; y: number }[] | null {
  const tv = (f.furniture ?? []).find((it) => it.type === "tv-unit" && room.rects.some((q) => inRect(q, it.x, it.y)));
  if (!tv || !n) return null;
  const r = ((tv.rot ?? 0) * Math.PI) / 180, w = tv.w ?? 1.8, d = tv.d ?? 0.42;
  const ax = Math.cos(r), ay = Math.sin(r), fx = -Math.sin(r), fy = Math.cos(r); // along the unit, and where it faces
  const cols = Math.max(1, Math.min(n, Math.floor(w / 0.4))), out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, row = Math.floor(i / cols), u = ((c + 0.5) / cols - 0.5) * w * 0.9, v = d / 2 + 0.3 + row * 0.42;
    out.push({ x: +(tv.x + ax * u + fx * v).toFixed(2), y: +(tv.y + ay * u + fy * v).toFixed(2) });
  }
  return out;
}

/** The room with its biggest rectangle cut back to where the TV pins don't stand, so the others spread around them. */
function besideTv(room: Room, spots: { x: number; y: number }[]): Room {
  const r = [...room.rects].sort((a, b) => b.w * b.d - a.w * a.d)[0], pad = 0.3;
  const x0 = Math.min(...spots.map((p) => p.x)) - pad, x1 = Math.max(...spots.map((p) => p.x)) + pad;
  const y0 = Math.min(...spots.map((p) => p.y)) - pad, y1 = Math.max(...spots.map((p) => p.y)) + pad;
  // the biggest part of the rectangle beside the TV's block of pins
  const parts: Rect[] = [{ x: r.x, y: r.y, w: x0 - r.x, d: r.d }, { x: x1, y: r.y, w: r.x + r.w - x1, d: r.d }, { x: r.x, y: r.y, w: r.w, d: y0 - r.y }, { x: r.x, y: y1, w: r.w, d: r.y + r.d - y1 }];
  const best = parts.filter((q) => q.w > 0.8 && q.d > 0.8).sort((a, b) => b.w * b.d - a.w * a.d)[0];
  return best ? { ...room, rects: [best] } : room;
}

/** An explicit pin as the page gets it; z only when one is stored. */
const pinAt = (id: string, f: Floor, s: { x: number; y: number; z?: number; entities?: string[]; name?: string }): Pin =>
  ({ id, floor: f.id, room: roomAt(f, s.x, s.y)?.id ?? null, x: s.x, y: s.y, ...(s.z != null ? { z: s.z } : {}), auto: false, ...(s.entities?.length ? { entities: s.entities } : {}), ...(s.name ? { name: s.name } : {}) });
/** Entity id → the group pin it belongs to (members are switched and shown through the group, never on their own). */
export function groupOf(h: House): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, s] of Object.entries(h.pins ?? {})) if (!("hidden" in s)) for (const m of s.entities ?? []) out.set(m, id);
  return out;
}
export interface Layout { pins: Pin[]; unplaced: RegEntity[]; hidden: string[]; areas: (Area & { room: string | null; floorId: string | null; entities: number })[] }
/** Where every relevant entity goes: explicit pins, then area-mapped rooms, then the tray. */
export function layout(h: House, entities: RegEntity[], areas: Area[]): Layout {
  const ignore = (h.ignore ?? []).map(globToRe), pins: Pin[] = [], unplaced: RegEntity[] = [], hidden: string[] = [];
  const byArea = new Map(areas.map((a) => [a.id, a])), perRoom = new Map<string, { floor: Floor; room: Room; list: RegEntity[] }>();
  const known = new Set(entities.map((e) => e.id)), member = groupOf(h);
  for (const e of entities) {
    if (member.has(e.id)) continue; // shown through its group pin
    const spot = h.pins?.[e.id];
    if (spot && "hidden" in spot) { hidden.push(e.id); continue; }
    if (spot) {
      const f = h.floors.find((x) => x.id === spot.floor);
      if (f) { pins.push(pinAt(e.id, f, spot)); continue; }
    }
    if (!relevant(e, ignore)) continue;
    // an unavailable entity isn't spread into a room (HA keeps many dead media players around); it waits in the tray
    const home = e.state === "unavailable" ? null : roomForArea(h, e.area ? byArea.get(e.area) : undefined);
    if (!home) { unplaced.push(e); continue; }
    const k = home.room.id;
    if (!perRoom.has(k)) perRoom.set(k, { ...home, list: [] });
    perRoom.get(k)!.list.push(e);
  }
  // A pin for an entity HA doesn't list (yet) still shows, so a renamed entity doesn't silently vanish from the house.
  for (const [id, spot] of Object.entries(h.pins ?? {})) {
    if (known.has(id) || "hidden" in spot) continue;
    const f = h.floors.find((x) => x.id === spot.floor);
    if (f) pins.push(pinAt(id, f, spot));
  }
  for (const { floor, room, list } of perRoom.values()) {
    list.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const tvList = list.filter((e) => TVISH.test(e.id)), tv = atTv(floor, room, tvList.length);
    const rest = tv ? list.filter((e) => !TVISH.test(e.id)) : list;
    if (tv) tv.forEach((p, i) => pins.push({ id: tvList[i].id, floor: floor.id, room: room.id, ...p, auto: true }));
    spread(tv ? besideTv(room, tv) : room, rest.length).forEach((p, i) => pins.push({ id: rest[i].id, floor: floor.id, room: room.id, ...p, auto: true }));
  }
  unplaced.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const count = new Map<string, number>();
  for (const e of entities) if (e.area && relevant(e, ignore)) count.set(e.area, (count.get(e.area) ?? 0) + 1);
  return {
    pins, unplaced, hidden,
    areas: areas.map((a) => { const r = roomForArea(h, a); return { ...a, room: r?.room.id ?? null, floorId: r?.floor.id ?? null, entities: count.get(a.id) ?? 0 }; }),
  };
}

/** A plain list of HA areas and their entities, to send for confirmation ("is this right?"). */
export function devicesMarkdown(h: House, entities: RegEntity[], areas: Area[], at = new Date()): string {
  const L = layout(h, entities, areas), ignore = (h.ignore ?? []).map(globToRe), member = groupOf(h);
  const roomName = (id: string | null) => h.floors.flatMap((f) => f.rooms.map((r) => ({ ...r, floor: f.name }))).find((r) => r.id === id);
  const placed = new Map(L.pins.map((p) => [p.id, p]));
  const out = [`# House devices`, ``, `Generated ${at.toISOString().slice(0, 16).replace("T", " ")} UTC from Home Assistant. Pins: ${L.pins.length} placed (${L.pins.filter((p) => !p.auto).length} by hand), ${L.unplaced.length} unplaced.`, ``];
  const line = (e: RegEntity) => {
    const p = placed.get(e.id), r = p ? roomName(p.room) : undefined;
    const g = member.get(e.id);
    const where = g ? ` → in the group pin \`${g}\`` : p ? ` → ${r ? `${r.name}, ${r.floor}` : p.floor}${p.auto ? "" : " (placed by hand)"}` : e.state === "unavailable" ? " (unavailable: waits in the tray)" : "";
    return `- \`${e.id}\` ${e.name.replace(/\s+/g, " ")}${e.deviceClass ? ` (${e.deviceClass})` : ""}${where}`;
  };
  for (const a of [...L.areas].sort((x, y) => x.name.localeCompare(y.name))) {
    const list = entities.filter((e) => e.area === a.id && relevant(e, ignore)).sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
    const r = roomName(a.room);
    out.push(`## ${a.name} (\`${a.id}\`) → ${r ? `${r.name}, ${r.floor}` : "no room yet"}`, "");
    out.push(...(list.length ? list.map(line) : ["- (no devices)"]), "");
  }
  const loose = L.unplaced.filter((e) => !e.area), dead = loose.filter((e) => e.state === "unavailable");
  out.push(`## No area in Home Assistant`, "", ...loose.filter((e) => e.state !== "unavailable").map(line));
  if (dead.length) out.push(`- …and ${dead.length} unavailable entities (old cast/AirPlay targets and the like), left out`);
  out.push("");
  return out.join("\n");
}

// ---------- which entities the House page shows, for the live stream ----------
let shown = new Set<string>();
export const houseEntities = (): Iterable<string> => shown;
/** The pins' entities, a group pin's members included (the page works the group's state out from them). */
export function noteShown(l: Layout) { shown = new Set(l.pins.flatMap((p) => [p.id, ...(p.entities ?? [])])); }
