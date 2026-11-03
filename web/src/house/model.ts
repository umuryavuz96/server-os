// The house model as the server sends it (server/modules/house.ts) and the plan maths the 3D view needs.
// Model coordinates: x across the width (0 = left wall seen from the street), y = depth from the front wall, metres.
export interface Rect { x: number; y: number; w: number; d: number }
export interface Room { id: string; name: string; kind?: string; floor?: string; rects: Rect[]; haArea?: string[] }
export interface Opening { at: [number, number]; along: "x" | "y"; w: number; kind: "door" | "window" | "opening"; sill?: number; head?: number; hinge?: "-x" | "+x" | "-y" | "+y"; into?: "-x" | "+x" | "-y" | "+y"; closed?: boolean; fixed?: "-x" | "+x" | "-y" | "+y" }
export interface Furniture { type: string; x: number; y: number; w?: number; d?: number; h?: number; rot?: number; label?: string; z?: number; color?: string }
export interface Fixture { kind: string; x: number; y: number; w: number; d: number; h?: number; up?: "+x" | "-x" | "+y" | "-y" }
export interface Floor {
  id: string; name: string; level: number; depth: number; shell?: Rect; rooms: Room[]; openTo?: [string, string][]; openings?: Opening[]; fixtures?: Fixture[]; furniture?: Furniture[]; voids?: Rect[]
  flatRoofs?: Rect[]; roof?: { kind: "gable"; ridge: number; eave?: number; from?: number; to?: number; skylights?: { x: number; y: number; w: number; h: number }[] }
}
/** z: height above the storey's floor in metres; without it a pin stands at PIN_Z. */
export type PinSpot = { floor: string; x: number; y: number; z?: number; entities?: string[]; name?: string } | { hidden: true };
export const PIN_Z = 0.5;
export interface House { name: string; mirror?: boolean; facing?: number; site?: { front?: number; back?: number; neighbours?: number; shed?: Rect }; width: number; storeyHeight?: number; wall?: { outer?: number; inner?: number; height?: number }; floors: Floor[]; ignore?: string[]; pins?: Record<string, PinSpot> }
export interface RegEntity { id: string; name: string; domain: string; area: string | null; deviceClass: string | null; device: string | null; state?: string; unit?: string }
/** entities: a group pin (server/modules/house.ts PinSpot): its key is ours, the members are HA entities switched together. */
export interface Pin { id: string; floor: string; room: string | null; x: number; y: number; z?: number; auto: boolean; entities?: string[]; name?: string }

interface MemberState { state: string }
/** A group pin as one entity: on when any member is on, unavailable when every member is (or isn't known yet); attrs
 *  say how many are on. The domain is the pin key's (light.tv_unit_lights reads as a lamp). */
export function groupEntity(id: string, name: string, members: (MemberState | null)[]) {
  const live = members.filter((m): m is MemberState => !!m && m.state !== "unavailable" && m.state !== "unknown");
  const on = live.filter((m) => m.state === "on").length;
  return { id, name, domain: id.split(".")[0], state: !live.length ? "unavailable" : on ? "on" : "off", attrs: { members: members.length, on, live: live.length } };
}
export interface HouseView { house: House; custom: boolean; online: boolean; pins: Pin[]; unplaced: RegEntity[]; hidden: string[]; areas: { id: string; name: string; room: string | null; floorId: string | null; entities: number }[] }

export const shellOf = (h: House, f: Floor): Rect => f.shell ?? { x: 0, y: 0, w: h.width, d: f.depth };
export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d;
export const roomAt = (f: Floor, x: number, y: number) => f.rooms.find((r) => r.rects.some((q) => inRect(q, x, y))) ?? null;
export const biggest = (r: Room) => [...r.rects].sort((a, b) => b.w * b.d - a.w * a.d)[0];

type Span = [number, number];
const EPS = 0.02;
function union(spans: Span[]): Span[] {
  const s = spans.filter(([a, b]) => b - a > EPS).sort((p, q) => p[0] - q[0]), out: Span[] = [];
  for (const [a, b] of s) { const last = out[out.length - 1]; if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
function subtract(spans: Span[], cuts: Span[]): Span[] {
  let cur = union(spans);
  for (const [ca, cb] of union(cuts)) cur = cur.flatMap(([a, b]): Span[] => (cb <= a || ca >= b ? [[a, b]] : ([[a, ca], [cb, b]] as Span[]).filter(([p, q]) => q - p > EPS)));
  return cur;
}

/** One straight wall piece: along x (a horizontal line at y = at, from a to b) or along y. `kind` window pieces get a sill and glass. */
export interface WallPiece { along: "x" | "y"; at: number; a: number; b: number; outer: boolean; kind: "wall" | "window" }

/** The walls of a storey: the shell's four sides plus every room edge, minus edges inside one room, open room pairs, and openings. */
export function wallsOf(h: House, f: Floor): WallPiece[] {
  const S = shellOf(h, f), key = (along: string, at: number) => `${along}:${at.toFixed(2)}`;
  const lines = new Map<string, { along: "x" | "y"; at: number; outer: boolean; spans: Span[]; cuts: Span[] }>();
  const line = (along: "x" | "y", at: number, outer = false) => {
    const k = key(along, at);
    if (!lines.has(k)) lines.set(k, { along, at, outer, spans: [], cuts: [] });
    return lines.get(k)!;
  };
  line("x", S.y, true).spans.push([S.x, S.x + S.w]); line("x", S.y + S.d, true).spans.push([S.x, S.x + S.w]);
  line("y", S.x, true).spans.push([S.y, S.y + S.d]); line("y", S.x + S.w, true).spans.push([S.y, S.y + S.d]);
  const onShell = (along: "x" | "y", at: number) => (along === "x" ? Math.abs(at - S.y) < EPS || Math.abs(at - S.y - S.d) < EPS : Math.abs(at - S.x) < EPS || Math.abs(at - S.x - S.w) < EPS);
  const open = (a: string, b: string) => a === b || (f.openTo ?? []).some(([p, q]) => (p === a && q === b) || (p === b && q === a));
  // every edge, tagged with its room and which side the room is on
  const edges: { along: "x" | "y"; at: number; a: number; b: number; room: string; side: 1 | -1 }[] = [];
  for (const r of f.rooms) for (const q of r.rects) {
    edges.push({ along: "x", at: q.y, a: q.x, b: q.x + q.w, room: r.id, side: 1 }, { along: "x", at: q.y + q.d, a: q.x, b: q.x + q.w, room: r.id, side: -1 });
    edges.push({ along: "y", at: q.x, a: q.y, b: q.y + q.d, room: r.id, side: 1 }, { along: "y", at: q.x + q.w, a: q.y, b: q.y + q.d, room: r.id, side: -1 });
  }
  for (const e of edges) {
    if (onShell(e.along, e.at)) continue;
    const L = line(e.along, e.at);
    L.spans.push([e.a, e.b]);
    for (const o of edges) if (o !== e && o.along === e.along && Math.abs(o.at - e.at) < EPS && o.side !== e.side && open(e.room, o.room)) L.cuts.push([Math.max(e.a, o.a), Math.min(e.b, o.b)]);
  }
  const out: WallPiece[] = [];
  for (const L of lines.values()) {
    const ops = (f.openings ?? []).filter((o) => o.along === L.along && Math.abs((L.along === "x" ? o.at[1] : o.at[0]) - L.at) < 0.25);
    const centre = (o: Opening) => (L.along === "x" ? o.at[0] : o.at[1]);
    const solid = subtract(L.spans, [...L.cuts, ...ops.map((o): Span => [centre(o) - o.w / 2, centre(o) + o.w / 2])]);
    for (const [a, b] of solid) out.push({ along: L.along, at: L.at, a, b, outer: L.outer, kind: "wall" });
    const live = union(subtract(L.spans, L.cuts));
    for (const o of ops) if (o.kind === "window") {
      const [a, b] = [centre(o) - o.w / 2, centre(o) + o.w / 2];
      if (live.some(([p, q]) => a >= p - EPS && b <= q + EPS)) out.push({ along: L.along, at: L.at, a, b, outer: L.outer, kind: "window" });
    }
  }
  return out;
}

/** Rooms of a storey, as indices into the level uniform (room i → i + 1; 0 = no room). */
export const MAX_ROOMS = 32;
const CELL = 0.1;

/** A storey's plan as a texture of room numbers, 10 cm a cell, covering the shell and its outer walls. */
export function roomMap(h: House, f: Floor): { data: Uint8Array<ArrayBuffer>; w: number; h: number; x0: number; y0: number; sx: number; sy: number } {
  const S = shellOf(h, f), wo = (h.wall?.outer ?? 0.3) + 0.2, x0 = S.x - wo, y0 = S.y - wo;
  const w = Math.ceil((S.w + 2 * wo) / CELL), hh = Math.ceil((S.d + 2 * wo) / CELL), data = new Uint8Array(w * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) {
    const r = roomAt(f, x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL);
    data[j * w + i] = r ? Math.min(MAX_ROOMS, f.rooms.indexOf(r) + 1) : 0;
  }
  return { data, w, h: hh, x0, y0, sx: w * CELL, sy: hh * CELL };
}
