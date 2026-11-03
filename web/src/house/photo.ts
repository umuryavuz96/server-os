// The House page's photo view: Cycles renders made by tools/house-render (bun run house:render). Per storey a day
// and a night picture, one overlay per room light and per placed light (only that light on, black elsewhere: blended
// over the base with `screen`), and a flat-colour room mask for taps. The manifest carries the camera's projection,
// so pins land on the picture without a re-render.

export interface RenderFloor {
  base: number;
  /** pixel (u, v) = project · (x, y, z, 1), model metres with z absolute */
  project: [number[], number[]];
  images: { day: string; night: string };
  lights: Record<string, string>;
  mask: string;
  rooms: Record<string, { colour?: string; centre?: [number, number] }>;
}
export interface RenderManifest { version: number; generated: string; width: number; height: number; floors: Record<string, RenderFloor>; pins?: Record<string, { floor: string; u: number; v: number }> }

export const renderUrl = (m: RenderManifest, file: string) => `/api/v1/house/render/${file}?v=${encodeURIComponent(m.generated)}`;

/** Where a model point lands on a storey's picture, in the picture's own pixels. */
export function projectTo(f: RenderFloor, x: number, y: number, up = 0.5): { u: number; v: number } {
  const p = [x, y, f.base + up, 1], [a, b] = f.project;
  return { u: a[0] * p[0] + a[1] * p[1] + a[2] * p[2] + a[3], v: b[0] * p[0] + b[1] * p[1] + b[2] * p[2] + b[3] };
}

/** Which overlay shows a light: its own render when it has one, else its room's ceiling light. */
export function overlayFor(f: RenderFloor, entity: string, room: string | null): string | null {
  return f.lights[`light:${entity}`] ?? (room ? f.lights[`room:${room}`] ?? null : null);
}

/** Lights and switches that are lamps (a night light is a switch). */
export const isLamp = (id: string) => id.startsWith("light.") || (id.startsWith("switch.") && /light|lamp/.test(id));

/** What kind of lamp a light is, from its name (tools/house-render/render.ts sizes its baked light the same way). */
export const lampKind = (id: string) => (/ambilight/.test(id) ? "ambilight" : /tv_unit|led_strip|_strip/.test(id) ? "strip" : /night/.test(id) ? "night" : /lamp|desk|bed/.test(id) ? "lamp" : "ceiling");

interface LampState { state: string; attrs?: Record<string, any> }
/** A lit lamp's brightness share (1 when it doesn't report one: some lamps say 0 while on), never below `min`. */
export const lampLevel = (e: LampState, min: number) => (Number(e.attrs?.brightness) > 0 ? Math.max(min, Number(e.attrs!.brightness) / 255) : 1);

const BAKED = [1, 0.68, 0.4]; // the renders' lamp colour, 2700 K (KELVIN in build.py), linear
/** A lamp's colour as a multiplier on the renders' warm light, brightness kept: white for lamps without a colour. Half
 *  strength, so a 2000 K glow reads warmer and a cold white cooler without turning the room orange or blue. */
export function lampTint(attrs?: Record<string, any>): [number, number, number] {
  const c = attrs?.rgb_color;
  if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isFinite(Number(v)))) return [1, 1, 1];
  const r = c.map((v, i) => Math.pow(Math.min(255, Math.max(0, Number(v))) / 255, 2.2) / BAKED[i]);
  const y = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
  if (!(y > 0)) return [1, 1, 1];
  return r.map((v) => Math.min(2, Math.max(0.2, 1 + 0.6 * (v / y - 1)))) as [number, number, number];
}

const NIGHT = 0.04; // a night light (4 W in build.py) next to a room's ceiling light (100 W and up)
type Rgb = [number, number, number];
/** A room's live lamp light: `lamp` lights the baked ceiling-light map, `own` the map of lamps baked on their own (a
 *  night light at its pin), both as colour × brightness; `level` 0 … 1 is the whole room's, for labels and the plain
 *  model. */
export interface RoomGlow { level: number; lamp: Rgb; own: Rgb }

/** Lamp light per room from its lit lamps. A lamp with its own bake (`own`) lights only that bake; any other lamp lights
 *  the room's ceiling-light map, a night light only a little of it. */
export function roomGlow(pins: { id: string; room: string | null }[], state: (id: string) => LampState | null, own: (id: string) => boolean = () => false): Record<string, RoomGlow> {
  type Acc = { level: number; tint: Rgb; w: number };
  const add = (a: Acc | undefined, b: number, t: Rgb): Acc => {
    if (!a) return { level: b, tint: t, w: b };
    return { level: Math.min(1, Math.max(a.level, b) + 0.1), tint: a.tint.map((v, i) => (v * a.w + t[i] * b) / (a.w + b)) as Rgb, w: a.w + b };
  };
  const acc: Record<string, { lamp?: Acc; own?: Acc; level: number }> = {};
  for (const p of pins) {
    if (!p.room || !isLamp(p.id)) continue;
    const e = state(p.id);
    if (!e || e.state !== "on") continue;
    const b = lampLevel(e, 0.15), t = lampTint(e.attrs), dim = lampKind(p.id) === "night" ? NIGHT : 1, r = (acc[p.room] ??= { level: 0 });
    if (own(p.id)) r.own = add(r.own, b, t); else r.lamp = add(r.lamp, b * dim, t);
    r.level = Math.min(1, Math.max(r.level, b * dim) + (r.level ? 0.1 : 0));
  }
  const rgb = (a?: Acc): Rgb => (a ? (a.tint.map((v) => v * a.level) as Rgb) : [0, 0, 0]);
  return Object.fromEntries(Object.entries(acc).map(([k, r]) => [k, { level: r.level, lamp: rgb(r.lamp), own: rgb(r.own) }]));
}

/** The room under a picture pixel, from the mask's colours. */
export function roomAtPixel(f: RenderFloor, data: ImageData, u: number, v: number): string | null {
  const x = Math.round(u), y = Math.round(v);
  if (x < 0 || y < 0 || x >= data.width || y >= data.height) return null;
  const i = (y * data.width + x) * 4;
  if (data.data[i + 3] < 128) return null;
  const [r, g, b] = [data.data[i], data.data[i + 1], data.data[i + 2]];
  let best: string | null = null, dist = 30;
  for (const [id, room] of Object.entries(f.rooms)) {
    if (!room.colour) continue;
    const c = parseInt(room.colour.slice(1), 16), d = Math.abs((c >> 16) - r) + Math.abs(((c >> 8) & 255) - g) + Math.abs((c & 255) - b);
    if (d < dist) { dist = d; best = id; }
  }
  return best;
}

/** Sun elevation in degrees (NOAA's simple formulas, good to a degree): day/night when HA's sun.sun isn't at hand. */
export function sunElevation(date: Date, lat = 52.1, lon = 5.1): number {
  const rad = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = gmst * 15 * rad + lon * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
