// The 3D view's baked models (tools/house-render, bun run house:render): per storey a GLB of the photo scene, its
// meshes cut into a few atlas chunks ("baked<i>"), each with three WebP maps next to it: albedo (sRGB), the day's
// diffuse light and the light of the rooms' ceiling lights, plus with placed lights (a night light) a map of only those
// (all scene-linear, stored as sqrt(l / (1 + l))). Here: albedo × (day light, or day light dimmed to moonlight at night)
// + albedo × each lamp map × the live colour and brightness of its lamps in the room under the pixel (a small room-id
// map of the plan), then AgX tone mapping, like the photos. With `gloss` (2026-11-01) the albedo's alpha holds
// 1 - gloss / 2 (gloss = (1 - roughness)^2): smooth surfaces (floor, worktop, TV, glass fronts) add a Fresnel reflection
// of the room around, a soft gradient lit by the light at the spot, so they catch light at grazing angles like real ones.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { MAX_ROOMS, roomMap, type Floor, type House } from "./model";

export interface GlbFloor { file: string; base: number; bytes: number; tris: number; maps: { albedo: string; sun: string; lamp: string; place?: string }[]; placed?: string[]; doors?: Record<string, { angle: number; open: boolean; hinge: string; into: string }>; ups?: Record<string, { cut: number }> }
export interface GlbManifest { version: number; gloss?: boolean; generated: string; mirror: boolean; cut: number; storeyHeight: number; camera: { az: number; el: number }; exposure?: number; floors: Record<string, GlbFloor> }

const vert = /* glsl */ `
  uniform mat4 uNode; uniform float uSq, uCutY; varying vec2 vUv; varying vec3 vPos;
  void main() { vUv = uv; vPos = (uNode * vec4(position, 1.0)).xyz; vec3 p = position; p.y = mix(p.y, uCutY, uSq); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`; // uSq folds an outer wall's upper part down to the cut line
const frag = /* glsl */ `
  uniform sampler2D uAlbedo, uSun, uLamp, uPlace, uRooms;
  uniform float uNight, uLampDay, uMirror, uWidth, uExposure, uHi, uGloss;
  uniform vec3 uCam, uMoon, uGlow[${MAX_ROOMS + 1}], uOwn[${MAX_ROOMS + 1}]; uniform vec4 uPlan;
  varying vec2 vUv; varying vec3 vPos;
  vec3 dec(vec3 e) { vec3 s = e * e; return s / max(vec3(1.0) - s, vec3(0.004)); }
  int roomAt(vec2 plan) { return int(texture2D(uRooms, (plan - uPlan.xy) / uPlan.zw).r * 255.0 + 0.5); }
  // a room's live ceiling-light glow at a plan point: its lamps' colour × brightness
  vec3 roomGlow(vec2 plan) { return uGlow[roomAt(plan)]; }
  void main() {
    // the room this pixel belongs to: a step off the surface, towards the side we look at
    vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
    if (dot(n, uCam - vPos) < 0.0) n = -n;
    vec3 p = vPos + n * 0.06;
    vec2 plan = vec2(uMirror > 0.5 ? uWidth - p.x : p.x, -p.z);
    vec3 glow = roomGlow(plan);
    // floors blend in the rooms around (an open kitchen fades into the living room); walls keep their own room
    if (abs(n.y) > 0.7) glow = glow * 0.5 + (roomGlow(plan + vec2(0.3, 0.0)) + roomGlow(plan - vec2(0.3, 0.0)) + roomGlow(plan + vec2(0.0, 0.3)) + roomGlow(plan - vec2(0.0, 0.3))) * 0.125;
    vec4 alb = texture2D(uAlbedo, vUv);
    vec3 albedo = alb.rgb;
    vec3 sun = dec(texture2D(uSun, vUv).rgb);
    // faces the bake never saw (the backs of furniture against a wall, shown when that wall folds down) get a dim sky-bounce fill
    sun += (1.0 - smoothstep(0.003, 0.03, max(sun.r, max(sun.g, sun.b)))) * vec3(0.30, 0.32, 0.36);
    vec3 lamp = dec(texture2D(uLamp, vUv).rgb) * glow + dec(texture2D(uPlace, vUv).rgb) * uOwn[roomAt(plan)];
    vec3 light = mix(sun, sun * uMoon, uNight) + lamp * mix(uLampDay, 1.0, uNight);
    vec3 col = albedo * light;
    if (uGloss > 0.0) {
      float gloss = clamp((1.0 - alb.a) * 2.0, 0.0, 1.0);
      vec3 v = normalize(uCam - vPos);
      float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
      // the room around: brighter up towards the ceiling and windows, darker down; a rough surface sees its average
      float up = mix(0.5, smoothstep(-0.3, 0.8, reflect(-v, n).y), gloss);
      col += light * mix(0.3, 1.3, up) * F * gloss * uGloss;
    }
    gl_FragColor = vec4(col * uExposure * (1.0 + uHi) + vec3(0.9, 0.7, 0.45) * uHi * 0.12, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** One loaded storey: its object (in the GLB's own frame) and the uniforms its materials share. */
export interface BakedFloor { root: THREE.Object3D; glow: THREE.Vector3[]; own: THREE.Vector3[]; uniforms: Record<string, THREE.IUniform>; plain: THREE.MeshBasicMaterial[]; doors: BakedDoor[]; walls: THREE.Mesh[]; ups: BakedUp[] }

/** A door leaf (its own node, origin on the hinge pivot): `angle` turns it from the pose the model draws to the other one.
 *  p is the swing 0 (as drawn) … 1 (turned by angle); hi the hover/press brightening. */
export interface BakedDoor { name: string; mesh: THREE.Mesh; angle: number; p: number; goal: number; from: number; t0: number; hi: number; hiGoal: number; hiUniform: THREE.IUniform }
/** An outer wall's upper part (above the dollhouse cut). The wall stays full height unless it stands between the camera and the
 *  rooms: then it folds down to the cut line (the vertex shader squashes it, so its light lookups stay put), ~200 ms, with
 *  a metre of hysteresis so an orbit never makes it flicker. n: its outward normal in the GLB's frame (x, z). */
export interface BakedUp { name: string; mesh: THREE.Mesh; c: THREE.Vector2; n: THREE.Vector2; p: number; goal: number; from: number; t0: number; set: boolean; sq: THREE.IUniform }
const FOLD_MS = 200, FOLD_HYST = 1;
/** Fold or raise each wall of a storey by where the camera is (camLocal: in the storey's own frame); true while one is moving. */
export function stepUps(b: BakedFloor, cam: THREE.Vector3, now = performance.now()): boolean {
  let more = false;
  for (const u of b.ups) {
    const away = u.n.x * (cam.x - u.c.x) + u.n.y * (cam.z - u.c.y); // metres the camera stands outside this wall
    const want = away > FOLD_HYST ? 1 : away < -FOLD_HYST ? 0 : u.set ? u.goal : away > 0 ? 1 : 0;
    if (!u.set) { u.goal = u.p = want; u.set = true; } // the first look: no fold to watch
    else if (want !== u.goal) { u.from = u.p; u.goal = want; u.t0 = now; }
    if (u.p !== u.goal) {
      const t = reduced() ? 1 : Math.min(1, (now - u.t0) / FOLD_MS);
      u.p = t >= 1 ? u.goal : u.from + (u.goal - u.from) * (1 - Math.pow(1 - t, 3));
      if (u.p !== u.goal) more = true;
    }
    u.sq.value = u.p; u.mesh.visible = u.p < 0.999;
  }
  return more;
}

const SWING_MS = 400;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Swing a door to the other pose (from wherever it is now, so a second tap mid-swing reverses smoothly). */
export function toggleDoor(d: BakedDoor, now = performance.now()) {
  d.from = d.p; d.goal = d.goal ? 0 : 1; d.t0 = now;
}

/** Advance the doors' swings and highlights to `now`; true while anything is still moving (ask for another frame). */
export function stepDoors(b: BakedFloor, now = performance.now()): boolean {
  let more = false;
  for (const d of b.doors) {
    if (d.p !== d.goal) {
      const t = reduced() ? 1 : Math.min(1, (now - d.t0) / SWING_MS);
      d.p = t >= 1 ? d.goal : d.from + (d.goal - d.from) * ease(t);
      d.mesh.rotation.y = d.p * d.angle;
      if (d.p !== d.goal) more = true;
    }
    if (d.hi !== d.hiGoal) {
      d.hi = Math.abs(d.hiGoal - d.hi) < 0.01 ? d.hiGoal : d.hi + (d.hiGoal - d.hi) * 0.25;
      d.hiUniform.value = d.hi;
      if (d.hi !== d.hiGoal) more = true;
    }
  }
  return more;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const tex = new THREE.TextureLoader();
// the place map of a storey without placed lights: no light
const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;

export async function loadBaked(h: House, f: Floor, m: GlbManifest, url: (file: string) => string, aniso: number): Promise<BakedFloor> {
  const g = m.floors[f.id];
  const gltf = await loader.loadAsync(url(g.file));
  const map = (file: string, srgb: boolean) => new Promise<THREE.Texture>((ok, no) => tex.load(url(file), (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.flipY = false; t.anisotropy = aniso; ok(t);
  }, undefined, no));
  const maps = await Promise.all(g.maps.map(async (x) => ({ albedo: await map(x.albedo, true), sun: await map(x.sun, false), lamp: await map(x.lamp, false), place: x.place ? await map(x.place, false) : black })));
  const rm = roomMap(h, f), rooms = new THREE.DataTexture(rm.data, rm.w, rm.h, THREE.RedFormat, THREE.UnsignedByteType);
  rooms.needsUpdate = true; rooms.magFilter = rooms.minFilter = THREE.NearestFilter;
  const vecs = () => Array.from({ length: MAX_ROOMS + 1 }, () => new THREE.Vector3()), glow = vecs(), own = vecs();
  const uniforms: Record<string, THREE.IUniform> = {
    uRooms: { value: rooms }, uPlan: { value: new THREE.Vector4(rm.x0, rm.y0, rm.sx, rm.sy) }, uGlow: { value: glow }, uOwn: { value: own },
    uNight: { value: 0 }, uLampDay: { value: 0.5 }, uMirror: { value: m.mirror ? 1 : 0 }, uWidth: { value: h.width },
    uExposure: { value: Math.pow(2, m.exposure ?? 0) }, uCam: { value: new THREE.Vector3() }, uGloss: { value: m.gloss ? 0.75 : 0 },
    uMoon: { value: new THREE.Vector3(0.035, 0.045, 0.085) },
  };
  const plain: THREE.MeshBasicMaterial[] = [], doors: BakedDoor[] = [], walls: THREE.Mesh[] = [], upMeshes: { mesh: THREE.Mesh; sq: THREE.IUniform }[] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material as THREE.MeshStandardMaterial, i = /^baked(\d+)/.exec(old.name)?.[1];
    if (i != null && maps[+i]) {
      const hi = { value: 0 }, sq = { value: 0 }, dd = g.doors?.[mesh.name];
      mesh.material = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { ...uniforms, uNode: { value: mesh.matrix }, uSq: sq, uCutY: { value: g.ups?.[mesh.name]?.cut ?? 0 }, uHi: hi, uAlbedo: { value: maps[+i].albedo }, uSun: { value: maps[+i].sun }, uLamp: { value: maps[+i].lamp }, uPlace: { value: maps[+i].place } } });
      if (dd) doors.push({ name: mesh.name, mesh, angle: dd.angle, p: 0, goal: 0, from: 0, t0: 0, hi: 0, hiGoal: 0, hiUniform: hi });
      else { walls.push(mesh); if (g.ups?.[mesh.name]) upMeshes.push({ mesh, sq }); }
    } else if (/glass/i.test(old.name)) {
      mesh.material = new THREE.MeshBasicMaterial({ color: 0xcfe3ee, transparent: true, opacity: 0.16, depthWrite: false });
    } else { // leaves: their own texture, unlit, dimmed with the sky
      const b = new THREE.MeshBasicMaterial({ map: old.map, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xb8b8b8 });
      plain.push(b); mesh.material = b;
    }
    old.dispose();
  });
  // each upper wall: its centre and which way it faces, from where it stands around the storey
  const all = new THREE.Box3().setFromObject(gltf.scene), mid = all.getCenter(new THREE.Vector3());
  const ups: BakedUp[] = upMeshes.map(({ mesh, sq }) => {
    mesh.geometry.computeBoundingBox();
    const c = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrix), dx = c.x - mid.x, dz = c.z - mid.z;
    const n = Math.abs(dx) > Math.abs(dz) ? new THREE.Vector2(Math.sign(dx), 0) : new THREE.Vector2(0, Math.sign(dz));
    return { name: mesh.name, mesh, c: new THREE.Vector2(c.x, c.z), n, p: 0, goal: 0, from: 0, t0: 0, set: false, sq };
  });
  return { root: gltf.scene, glow, own, uniforms, plain, doors, walls, ups };
}

/** Day 0 … night 1: the day light fades to moonlight, lamps count fully. */
export function setNight(b: BakedFloor, t: number) {
  b.uniforms.uNight.value = t;
  for (const p of b.plain) p.color.setScalar(0.72 * (1 - t) + 0.05 * t);
}

export function disposeBaked(b: BakedFloor) {
  b.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mat = m.material as THREE.ShaderMaterial | THREE.MeshBasicMaterial;
    if ("uniforms" in mat) for (const k of ["uAlbedo", "uSun", "uLamp", "uPlace"]) { const t = mat.uniforms[k]?.value as THREE.Texture | undefined; if (t !== black) t?.dispose(); }
    mat.dispose();
  });
  (b.uniforms.uRooms.value as THREE.Texture).dispose();
}
