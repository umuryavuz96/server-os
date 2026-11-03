#!/usr/bin/env bun
// bun run house:render [--floors ground,first] [--quick] [--width 1600] [--no-fetch] [--glb | --no-glb] [--density 120] [--check] [--views cams.json]
//
// Renders the House page's photo views with Blender (Cycles): per storey a day and a night picture, one overlay per room
// light and per placed Home Assistant light, and a room mask; then the 3D view's models: per storey a GLB with its day
// light and its lamps baked into atlases (--glb makes only those, --no-glb only the photos). Output: <SERVER_OS_HOME>/data/house-render/, which the
// server serves at /api/v1/house/render/*. Python: tools/house-render/.venv (the official `bpy` wheel, made with uv on
// first run), or HOUSE_RENDER_PYTHON, or the Blender app (BLENDER=/path/to/Blender).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dir } from "../../server/core/config";
import { getHouse } from "../../server/modules/house";

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const quick = flag("quick");
const cache = process.env.HOUSE_RENDER_CACHE ?? join(HERE, ".cache");
const outDir = join(dir("data"), "house-render");
const tmpOut = `${outDir}.tmp`;

function run(cmd: string[], env: Record<string, string> = {}): number {
  const p = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  return p.exitCode ?? 1;
}

// 1. assets (Poly Haven, CC0; pinned by sha256 in assets.lock.json)
if (!flag("no-fetch") && run(["python3", join(HERE, "fetch_assets.py"), cache]) !== 0) process.exit(1);

// 2. which lights get their own overlay: the house's pins, from the running server when it answers
const house = getHouse() as ReturnType<typeof getHouse> & { pins?: Record<string, unknown> };
type Pin = { id: string; floor: string; room: string | null; x: number; y: number; auto: boolean };
let pins: Pin[] = [];
try {
  const { adminKey } = await import("../../server/core/devices");
  const base = process.env.SERVER_OS_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3094}`;
  const r = await fetch(`${base}/api/v1/house/layout`, { headers: { Authorization: `Bearer ${adminKey()}` }, signal: AbortSignal.timeout(8000) });
  if (r.ok) pins = ((await r.json()) as { pins: Pin[] }).pins;
} catch { /* the server isn't running: fall back to the pins saved in the house */ }
if (!pins.length) for (const [id, p] of Object.entries(house.pins ?? {})) if (p && typeof p === "object" && "floor" in p) pins.push({ id, ...(p as { floor: string; x: number; y: number }), room: null, auto: false });
/** A light (or a switch that is one, like a night light) and what kind of lamp it is, from its name. */
const isLight = (id: string) => id.startsWith("light.") || (id.startsWith("switch.") && /light|lamp/.test(id));
// the TV unit's own lights take their place from the furniture (build.py lamp_light): its LED strip and the Ambilight
const kindOf = (id: string) => (/ambilight/.test(id) ? "ambilight" : /tv_unit|led_strip|_strip/.test(id) ? "strip" : /night/.test(id) ? "night" : /lamp|desk|bed/.test(id) ? "lamp" : "ceiling");
// a ceiling light spread into its room by area has no real spot: the room's own overlay shows it
const lights = pins.filter((p) => isLight(p.id) && !(p.auto && kindOf(p.id) === "ceiling")).map((p) => ({ id: p.id, floor: p.floor, x: p.x, y: p.y, kind: kindOf(p.id) }));
console.log(`house-render: ${pins.length} pins, ${lights.length} lights with their own overlay: ${lights.map((l) => l.id).join(", ") || "none"}`);

// 3. the job
const spec = JSON.parse(await Bun.file(join(HERE, "assets.json")).text());
const job = {
  house, cache, out: tmpOut,
  floors: opt("floors")?.split(","),
  width: Number(opt("width") ?? (quick ? 900 : 1600)),
  samples_day: quick ? 24 : 128, samples_night: quick ? 16 : 96, samples_light: quick ? 12 : 64,
  textures: Object.fromEntries(Object.entries(spec.textures).map(([k, v]) => [k, (v as { id: string }).id])),
  models: spec.models, hdri: spec.hdri.day.id,
  lights, pins: pins.map((p) => ({ id: p.id, floor: p.floor, x: p.x, y: p.y })),
};
rmSync(tmpOut, { recursive: true, force: true });
mkdirSync(tmpOut, { recursive: true });
const jobFile = join(tmpOut, "job.json");

// 4. Blender: the photos, then the 3D view's baked models (a second process, so the first one's memory is back)
async function python(): Promise<string[]> {
  if (process.env.HOUSE_RENDER_PYTHON) return [process.env.HOUSE_RENDER_PYTHON, join(HERE, "build.py"), jobFile];
  const venv = join(HERE, ".venv", "bin", "python");
  if (!existsSync(venv) && !process.env.BLENDER && Bun.which("uv")) {
    console.log("house-render: setting up the bpy wheel (one time, about 400 MB)");
    if (run(["uv", "venv", "-q", "-p", "3.13", join(HERE, ".venv")]) || run(["uv", "pip", "install", "-q", "-p", venv, "bpy==5.2.3"])) process.exit(1);
  }
  if (existsSync(venv)) return [venv, join(HERE, "build.py"), jobFile];
  const app = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
  return [app, "--background", "--factory-startup", "--python", join(HERE, "build.py"), "--", jobFile];
}
const t0 = Date.now();
// --views <file.json>: eye-level Cycles stills (evening and day) from the cameras in the file, with full-height walls and
// a ceiling, into <home>/data/house-views/ (the House page's Rooms view lists them: GET /house/views)
if (opt("views")) {
  const vdir = join(dir("data"), "house-views");
  mkdirSync(vdir, { recursive: true });
  writeFileSync(jobFile, JSON.stringify({ ...job, out: vdir, views: JSON.parse(readFileSync(opt("views")!, "utf8")), near_cut: 2.55, ceiling: true, samples_view: quick ? 48 : 160,
    // an evening look: the lamps and the TV's lights carry the room, ceiling lights dimmed; the Ambilight
    // even when it has no pin of its own
    lamp_gain: 0.45, evening_exposure: -0.4, day_exposure: 4.6, sky: 1.0, ambilight_gain: 0.7, strip_gain: 0.3, room_kelvin: 3000, look: "AgX - Punchy",
    lights: job.lights.some((l) => l.kind === "ambilight") ? job.lights : [...job.lights, { id: "light.tv_ambilight", floor: "ground", x: 0, y: 0, kind: "ambilight" }] }));
  const cmd = await python();
  const libs = [...new Bun.Glob("lib/python3*/site-packages/bpy/lib").scanSync({ cwd: join(dirname(cmd[0]), ".."), onlyFiles: false, absolute: true })];
  const code = run(cmd, libs.length ? { DYLD_FALLBACK_LIBRARY_PATH: libs[0] } : {});
  rmSync(tmpOut, { recursive: true, force: true });
  console.log(`house-render: views ${code ? "failed" : "done"} in ${Math.round((Date.now() - t0) / 1000)} s → ${vdir}`);
  process.exit(code);
}
const photos = !flag("glb"), glb = !flag("no-glb");
const glbJob = {
  ...job, glb: true, glb_density: Number(opt("density") ?? (quick ? 40 : 120)), glb_light_density: quick ? 20 : 48,
  check: flag("check"), glb_samples: quick ? 24 : 256, glb_samples_lamp: quick ? 24 : 256, glb_samples_albedo: quick ? 1 : 4,
};
// the wheel's glTF exporter loads its meshopt bridge, which looks for libmeshoptimizer on a path that only exists on
// Blender's build machine: point dyld at the wheel's own copy
const cmd = await python();
const libs = [...new Bun.Glob("lib/python3*/site-packages/bpy/lib").scanSync({ cwd: join(dirname(cmd[0]), ".."), onlyFiles: false, absolute: true })];
for (const [on, j] of [[photos, job], [glb, glbJob]] as const) {
  if (!on) continue;
  writeFileSync(jobFile, JSON.stringify(j));
  if (run(cmd, libs.length ? { DYLD_FALLBACK_LIBRARY_PATH: libs[0] } : {}) !== 0) { console.error("house-render: Blender failed"); process.exit(1); }
}
rmSync(jobFile);
// swap in the new set at once, keeping what we didn't make this time (other floors, the photos or the models)
const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const old = read(join(outDir, "manifest.json"));
if ((job.floors || !photos || !glb) && existsSync(outDir))
  for (const f of await Array.fromAsync(new Bun.Glob("*").scan(outDir))) if (!existsSync(join(tmpOut, f))) renameSync(join(outDir, f), join(tmpOut, f));
const merged = read(join(tmpOut, "manifest.json")) ?? { version: 1, floors: {} };
if (photos && job.floors && old) { merged.floors = { ...old.floors, ...merged.floors }; merged.pins = { ...old.pins, ...merged.pins }; }
const models = read(join(tmpOut, "glb.json"));
if (models) {
  if (old?.glb && (job.floors || !photos)) models.floors = { ...old.glb.floors, ...models.floors };
  merged.glb = models;
  rmSync(join(tmpOut, "glb.json"));
} else if (old?.glb && !glb) merged.glb = old.glb;
writeFileSync(join(tmpOut, "manifest.json"), JSON.stringify(merged, null, 1));
rmSync(outDir, { recursive: true, force: true });
renameSync(tmpOut, outDir);
console.log(`house-render: done in ${Math.round((Date.now() - t0) / 1000)} s → ${outDir}`);
