// three.js dollhouse of the house model: per storey a slab, tinted room floors, cutaway walls with doors and windows,
// a few fixtures, and a warm glow per room driven by its lights (the "lighting overlay" idea from the HA floor plans).
// World axes: X across the width (mirrored for the viewer's left/right), Y up, Z = depth from the street.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { biggest, shellOf, wallsOf, type Floor, type House, type Rect } from "./model";
import { disposeBaked, loadBaked, setNight, stepDoors, stepUps, toggleDoor, type BakedDoor, type BakedFloor, type GlbManifest } from "./baked";
import type { RoomGlow } from "./photo";

export interface Palette { dark: boolean; slab: string; floor: string; wall: string; wallTop: string; outer: string; fixture: string; glass: string; glow: string; roof: string; ground: string }

/** Scene colours from the panel's tokens: the house follows the theme instead of carrying its own. */
export function paletteFrom(el: Element = document.documentElement): Palette {
  const css = getComputedStyle(el), v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  const bg = new THREE.Color(v("--bg", "#050506")), dark = bg.r * 0.3 + bg.g * 0.59 + bg.b * 0.11 < 0.5;
  const panel = new THREE.Color(v("--panel", dark ? "#101012" : "#ffffff")), ink = new THREE.Color(v("--ink", dark ? "#f2f2f2" : "#111"));
  const mix = (a: THREE.Color, b: THREE.Color, t: number) => "#" + a.clone().lerp(b, t).getHexString();
  return dark
    ? { dark, slab: mix(panel, ink, 0.1), floor: mix(panel, ink, 0.16), wall: mix(panel, ink, 0.52), wallTop: mix(panel, ink, 0.8), outer: mix(panel, ink, 0.5), fixture: mix(panel, ink, 0.32), glass: "#7fb4ff", glow: "#ffb35c", roof: mix(panel, ink, 0.4), ground: mix(bg, ink, 0.05) }
    : { dark, slab: mix(panel, ink, 0.12), floor: mix(panel, ink, 0.05), wall: mix(panel, ink, 0.2), wallTop: mix(panel, ink, 0.02), outer: mix(panel, ink, 0.3), fixture: mix(panel, ink, 0.18), glass: "#5b9cff", glow: "#ff9d2e", roof: mix(panel, ink, 0.35), ground: mix(bg, ink, 0.06) };
}

/** Light tint per room kind, so rooms read apart even with every light off. */
const KIND_TINT: Record<string, string> = { living: "#d9b98c", kitchen: "#a9c4a0", bedroom: "#a7b5d6", bath: "#8fc7cf", toilet: "#8fc7cf", hall: "#c9c2b6", stairs: "#bdb7ae", storage: "#b6aea3", utility: "#c2b59b", office: "#b7a6cf" };

export interface RoomHandle { floor: string; room: string; mats: THREE.MeshStandardMaterial[]; base: THREE.Color; light: THREE.PointLight; centre: THREE.Vector3; label: THREE.Vector3 }
export interface FloorHandle { id: string; group: THREE.Group; base: number; roof: THREE.Object3D | null; label: THREE.Vector3; level: number }

export class HouseScene {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera: THREE.PerspectiveCamera; controls: OrbitControls;
  floors: FloorHandle[] = []; rooms = new Map<string, RoomHandle>(); pickables: THREE.Mesh[] = [];
  private house: House | null = null; private raf = 0; private goal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private ro: ResizeObserver; private ray = new THREE.Raycaster();
  onFrame: (() => void) | null = null;
  /** Edit mode's move gizmo: three arrows on the selected pin (across, depth, height), in its storey's group. */
  gizmo: TransformControls; private gizmoObj = new THREE.Object3D(); private gizmoFloor: string | null = null;
  /** The gizmo moved its pin: model x, y and the height above the storey's floor, clamped to the storey. */
  onGizmo: ((p: { x: number; y: number; z: number }) => void) | null = null;
  /** A press landed on a gizmo arrow (so the page doesn't read it as a tap on the house); the page clears it. */
  gizmoHit = false;
  /** Hidden behind the photo view: skip rendering (an idle iPhone shouldn't draw an unseen WebGL scene). */
  private _paused = false;
  get paused() { return this._paused; }
  set paused(v: boolean) { this._paused = v; if (!v) this.invalidate(); }
  pal: Palette;
  private ground: THREE.Mesh | null = null;
  // the baked models (tools/house-render): loaded per storey when shown, kept across rebuilds
  private glb: { m: GlbManifest; url: (file: string) => string } | null = null;
  private baked = new Map<string, BakedFloor>();
  private loadingGlb = new Set<string>();
  private night = 0; private nightGoal = 0;
  private glowOf = new Map<string, RoomGlow>(); private touched = false;
  /** A storey's baked model failed to load or has none: that storey shows the plain model. */
  onBaked: ((floor: string, ok: boolean) => void) | null = null;

  /** lowPower (the TV kiosk): no shadows, one pixel per CSS px until the page sets its resolution (setResolution);
   *  antialias: multisampling (on by default; nearly free on the tiled GPUs of TVs and phones, the kiosk can turn it off). */
  constructor(private host: HTMLElement, private opts: { lowPower?: boolean; antialias?: boolean } = {}) {
    const low = !!opts.lowPower;
    this.renderer = new THREE.WebGLRenderer({ antialias: opts.antialias ?? true, alpha: true, powerPreference: low ? "low-power" : "default" });
    this.renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = !low; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.camera.position.set(-9, 16, -16);
    // a touch has no hover: point the gizmo at the touched arrow (and turn its drag plane to it) before the gizmo reads
    // the press, or the first move measures from the wrong plane and the pin jumps
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !this.gizmo.object) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      // pointerHover takes the normalised pointer at runtime (the typings say PointerEvent)
      this.gizmo.pointerHover({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1, button: 0 } as unknown as PointerEvent);
      this.gizmo.getHelper().updateMatrixWorld(true);
    }, { capture: true });
    // the gizmo listens before the orbit controls: a press on an arrow turns orbiting off before it can start
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(matchMedia("(pointer: coarse)").matches ? 1.3 : 0.95);
    this.gizmo.addEventListener("dragging-changed", (e) => { this.controls.enabled = !e.value; });
    this.gizmo.addEventListener("mouseDown", () => { this.gizmoHit = true; });
    this.gizmo.addEventListener("mouseUp", () => setTimeout(() => { this.gizmoHit = false; })); // a drag let go off the stage
    this.gizmo.addEventListener("change", () => this.invalidate());
    this.gizmo.addEventListener("objectChange", () => this.gizmoMoved());
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.09, maxPolarAngle: Math.PI * 0.47, minDistance: 4, maxDistance: 140, screenSpacePanning: true });
    this.controls.addEventListener("start", () => { this.goal = null; this.touched = true; });
    this.controls.addEventListener("change", () => this.invalidate());
    this.pal = paletteFrom();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
  }

  /** Draw one frame soon. The scene renders on demand: while the camera moves, glides or the night fades, each frame
   *  asks for the next; an idle view draws nothing. */
  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; if (!this._paused) this.tick(); });
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.ro.disconnect(); this.gizmo.detach(); this.gizmo.dispose(); this.controls.dispose();
    for (const b of this.baked.values()) disposeBaked(b);
    this.baked.clear();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose()); });
    this.renderer.dispose(); this.renderer.domElement.remove();
  }

  /** Drawing-buffer pixels per CSS px of the canvas (the TV kiosk: 2 on a 1080p panel, less when the GPU can't keep up). */
  setResolution(ratio: number) { this.renderer.setPixelRatio(ratio); this.invalidate(); }
  /** The drawing buffer's size in pixels. */
  bufferSize() { const v = this.renderer.getDrawingBufferSize(new THREE.Vector2()); return { w: v.x, h: v.y }; }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const changed = Math.abs(this.camera.aspect - w / h) > 0.01;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (changed) this.frame(); // the tray opened, the phone turned: take the house in again
    this.invalidate();
  }

  private tick() {
    let more = false;
    if (this.goal) {
      this.camera.position.lerp(this.goal.pos, 0.12); this.controls.target.lerp(this.goal.target, 0.12);
      if (this.camera.position.distanceTo(this.goal.pos) < 0.02) this.goal = null;
      more = true;
    }
    this.controls.update(); // with damping it keeps reporting "change" (and so asking for frames) until it settles
    // never below the ground floor's slab, never far off the house
    const t = this.controls.target;
    if (t.y < 0 || t.y > 3) { t.y = THREE.MathUtils.clamp(t.y, 0, 3); this.camera.position.y = Math.max(this.camera.position.y, t.y + 0.5); }
    if (this.night !== this.nightGoal) {
      this.night = Math.abs(this.nightGoal - this.night) < 0.03 ? this.nightGoal : this.night + (this.nightGoal - this.night) * 0.12;
      for (const b of this.baked.values()) setNight(b, this.night);
      more = true;
    }
    for (const b of this.baked.values()) if (stepDoors(b)) more = true;
    for (const b of this.baked.values()) if (b.root.parent) {
      const cam = (b.uniforms.uCam.value as THREE.Vector3).copy(b.root.worldToLocal(this.camera.position.clone()));
      if (stepUps(b, cam)) more = true;
    }
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
    if (more) this.invalidate();
  }

  // ---------- model → world ----------
  private D = 0;
  /** World X/Z of a model point; the house is centred on the origin. Not mirrored, x = 0 is on the viewer's left. */
  toWorld(x: number, y: number, base = 0): THREE.Vector3 {
    const h = this.house!, X = h.mirror ? x - h.width / 2 : h.width / 2 - x;
    return new THREE.Vector3(X, base, y - this.D / 2);
  }
  toModel(p: THREE.Vector3): { x: number; y: number } {
    const h = this.house!;
    return { x: h.mirror ? p.x + h.width / 2 : h.width / 2 - p.x, y: p.z + this.D / 2 };
  }

  build(h: House, pal = this.pal) {
    this.pal = pal; this.house = h; this.D = Math.max(...h.floors.map((f) => f.depth));
    for (const c of [...this.scene.children]) this.scene.remove(c);
    this.floors = []; this.rooms.clear(); this.pickables = [];
    for (const b of this.baked.values()) b.root.removeFromParent();
    const hemi = new THREE.HemisphereLight(0xffffff, pal.dark ? 0x202024 : 0xb9b4aa, pal.dark ? 1.2 : 1.6);
    const sun = new THREE.DirectionalLight(0xffffff, pal.dark ? 1.4 : 2.0);
    sun.position.set(-8, 18, -10); sun.castShadow = !this.opts.lowPower; sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 }); sun.shadow.bias = -0.0005;
    this.scene.add(hemi, sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(Math.max(this.D, h.width * h.floors.length * 1.5) * 1.1, 64), new THREE.MeshStandardMaterial({ color: pal.ground, roughness: 1, transparent: true, opacity: pal.dark ? 0.6 : 0.8 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.2; ground.receiveShadow = true;
    this.scene.add(ground); this.ground = ground;
    for (const f of h.floors) this.buildFloor(h, f);
    this.scene.add(this.gizmo.getHelper());
    if (this.gizmoFloor) { const g = this.floors.find((f) => f.id === this.gizmoFloor)?.group; if (g) g.add(this.gizmoObj); else this.setGizmo(null); }
    this.layoutFloors();
    this.invalidate();
  }

  // ---------- baked models ----------
  /** Use the baked models of the render manifest (null: the plain model everywhere). */
  setBaked(m: GlbManifest | null, url: (file: string) => string) {
    const same = this.glb?.m.generated === m?.generated;
    this.glb = m ? { m, url } : null;
    if (!same) { for (const b of this.baked.values()) { b.root.removeFromParent(); disposeBaked(b); } this.baked.clear(); }
    this.renderer.toneMapping = m ? THREE.AgXToneMapping : THREE.NoToneMapping;
    this.layoutFloors();
    this.invalidate();
  }
  hasBaked(floor: string) { return !!this.glb?.m.floors[floor]; }
  /** Night (true) or day: the baked light fades between them. */
  setNight(on: boolean) { this.nightGoal = on ? 1 : 0; this.invalidate(); }

  /** Show the baked model of each shown storey that has one (loading it the first time), the plain one otherwise. */
  private attachBaked() {
    const h = this.house, glb = this.glb;
    if (!h) return;
    const D = this.D;
    let any = false;
    for (const f of this.floors) {
      const fl = h.floors.find((x) => x.id === f.id)!, b = this.baked.get(f.id), want = !!glb?.m.floors[f.id] && f.group.visible;
      if (want && !b && !this.loadingGlb.has(f.id)) {
        this.loadingGlb.add(f.id);
        loadBaked(h, fl, glb!.m, glb!.url, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()))
          .then((nb) => {
            if (this.glb?.m !== glb!.m) { disposeBaked(nb); return; }
            setNight(nb, this.night);
            fl.rooms.forEach((r, i) => { const g = this.glowOf.get(r.id); if (i + 1 < nb.glow.length) { nb.glow[i + 1].fromArray(g?.lamp ?? [0, 0, 0]); nb.own[i + 1].fromArray(g?.own ?? [0, 0, 0]); } });
            this.baked.set(f.id, nb);
            this.layoutFloors();
            if (this.show === f.id && !this.touched) this.frame(false); // now from the photo's angle
            this.onBaked?.(f.id, true);
          })
          .catch((e) => { console.warn("house: baked model", f.id, e); this.onBaked?.(f.id, false); })
          .finally(() => { this.loadingGlb.delete(f.id); this.invalidate(); });
      }
      const on = !!b && !!glb?.m.floors[f.id];
      if (on && b!.root.parent !== f.group) {
        // the GLB is in Blender's frame turned Y-up: x across (mirrored with the house), -z = depth, y = height
        b!.root.rotation.set(0, Math.PI, 0);
        b!.root.position.set((h.width) / 2, -glb!.m.floors[f.id].base, -D / 2);
        f.group.add(b!.root);
      }
      // the plain model stays for picking (its room floors), hidden
      for (const c of f.group.children) if (c !== b?.root && !(c as THREE.Light).isLight) c.visible = !on;
      if (f.roof) f.roof.visible = !on && this.show === f.id;
      any ||= on;
    }
    if (this.ground) this.ground.visible = !any;
    this.invalidate();
  }

  private mat(color: string | THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra }); }
  private box(g: THREE.Group, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, m: THREE.Material, shadow = true) {
    const a = this.toWorld(x0, y0), b = this.toWorld(x1, y1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(b.x - a.x) || 0.01, z1 - z0, Math.abs(b.z - a.z) || 0.01), m);
    mesh.position.set((a.x + b.x) / 2, (z0 + z1) / 2, (a.z + b.z) / 2);
    mesh.castShadow = shadow; mesh.receiveShadow = true; g.add(mesh);
    return mesh;
  }

  private buildFloor(h: House, f: Floor) {
    const pal = this.pal, g = new THREE.Group(), S = shellOf(h, f), wo = h.wall?.outer ?? 0.3, wi = h.wall?.inner ?? 0.1, wh = h.wall?.height ?? 1.1;
    g.name = f.id;
    this.box(g, S.x - wo, S.y - wo, S.x + S.w + wo, S.y + S.d + wo, -0.16, -0.01, this.mat(pal.slab), false);
    // room floors: one material per room so its glow can be set at once
    for (const r of f.rooms) {
      const tint = new THREE.Color(pal.floor).lerp(new THREE.Color(KIND_TINT[r.kind ?? ""] ?? pal.floor), pal.dark ? 0.16 : 0.35);
      const m = this.mat(tint, { emissive: new THREE.Color(pal.glow), emissiveIntensity: 0 });
      for (const q of r.rects) {
        const mesh = this.box(g, q.x, q.y, q.x + q.w, q.y + q.d, -0.01, 0.0, m, false);
        mesh.userData = { floor: f.id, room: r.id }; this.pickables.push(mesh);
      }
      const big = biggest(r), c = this.toWorld(big.x + big.w / 2, big.y + big.d / 2), lab = this.toWorld(big.x + big.w / 2, big.y + (big.d > 1.6 ? 0.42 : big.d / 2));
      const light = new THREE.PointLight(pal.glow, 0, 7, 1.6); light.position.set(c.x, 1.7, c.z); g.add(light);
      this.rooms.set(r.id, { floor: f.id, room: r.id, mats: [m], base: tint.clone(), light, centre: new THREE.Vector3(c.x, 0, c.z), label: new THREE.Vector3(lab.x, 0.02, lab.z) });
    }
    // walls
    const inner = this.mat(pal.wall), outer = this.mat(pal.outer), top = this.mat(pal.wallTop);
    const glass = new THREE.MeshStandardMaterial({ color: pal.glass, transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.2, depthWrite: false });
    for (const w of wallsOf(h, f)) {
      const t = w.outer ? wo : wi;
      // outer walls sit outside the shell, inner walls centre on their line
      const off0 = w.outer ? (w.along === "x" ? (Math.abs(w.at - S.y) < 0.02 ? -t : 0) : Math.abs(w.at - S.x) < 0.02 ? -t : 0) : -t / 2;
      const ext = w.outer ? t : 0; // outer runs reach the corners
      const [a, b] = [w.a - (w.outer && w.a <= (w.along === "x" ? S.x : S.y) + 0.02 ? ext : 0), w.b + (w.outer && w.b >= (w.along === "x" ? S.x + S.w : S.y + S.d) - 0.02 ? ext : 0)];
      const rect = (z0: number, z1: number, m: THREE.Material) => (w.along === "x" ? this.box(g, a, w.at + off0, b, w.at + off0 + t, z0, z1, m) : this.box(g, w.at + off0, a, w.at + off0 + t, b, z0, z1, m));
      if (w.kind === "window") { rect(0, 0.55, w.outer ? outer : inner); rect(0.55, wh, glass).castShadow = false; continue; }
      rect(0, wh, w.outer ? outer : inner);
      rect(wh, wh + 0.02, top).castShadow = false;
    }
    for (const fx of f.fixtures ?? []) this.fixture(g, fx);
    for (const r of f.flatRoofs ?? []) this.flatRoof(g, r);
    let roof: THREE.Object3D | null = null;
    if (f.roof) { roof = this.gable(h, f); g.add(roof); }
    const lab = this.toWorld(S.x + S.w / 2, S.y - wo - 0.7, 0);
    this.floors.push({ id: f.id, group: g, base: 0, roof, label: new THREE.Vector3(lab.x, 0, lab.z), level: f.level });
    g.userData.level = f.level;
    this.scene.add(g);
  }

  private fixture(g: THREE.Group, fx: { kind: string; x: number; y: number; w: number; d: number; h?: number; up?: string }) {
    const pal = this.pal, m = this.mat(pal.fixture), white = this.mat(pal.dark ? "#d8d8dc" : "#ffffff", { roughness: 0.4 });
    const H: Record<string, number> = { counter: 0.9, shower: 0.06, toilet: 0.42, sink: 0.85, bath: 0.55, washer: 0.85, boiler: 0.8, bed: 0.45, sofa: 0.42, table: 0.75, box: 0.5 };
    if (fx.kind === "stairs") {
      const wh = this.house?.wall?.height ?? 1.1, along = fx.up === "+x" || fx.up === "-x" ? "x" : "y", len = along === "x" ? fx.w : fx.d, n = Math.max(4, Math.round(len / 0.24));
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, rise = ((i + 1) / n) * wh * 1.05;
        const fwd = fx.up === "+y" || fx.up === "+x";
        const [s0, s1] = fwd ? [t0, t1] : [1 - t1, 1 - t0];
        if (along === "y") this.box(g, fx.x, fx.y + s0 * fx.d, fx.x + fx.w, fx.y + s1 * fx.d, 0, rise, m);
        else this.box(g, fx.x + s0 * fx.w, fx.y, fx.x + s1 * fx.w, fx.y + fx.d, 0, rise, m);
      }
      return;
    }
    if (fx.kind === "sofa") { this.box(g, fx.x, fx.y, fx.x + fx.w, fx.y + fx.d, 0, 0.42, m); this.box(g, fx.x, fx.y, fx.x + 0.2, fx.y + fx.d, 0.42, 0.75, m); return; }
    if (fx.kind === "table") { this.box(g, fx.x, fx.y, fx.x + fx.w, fx.y + fx.d, (fx.h ?? 0.75) - 0.05, fx.h ?? 0.75, m); return; }
    if (fx.kind === "bed") { this.box(g, fx.x, fx.y, fx.x + fx.w, fx.y + fx.d, 0, 0.42, white); this.box(g, fx.x, fx.y, fx.x + fx.w, fx.y + 0.08, 0, 0.8, m); return; }
    const top = fx.kind === "counter" ? this.mat(pal.wallTop) : ["toilet", "sink", "bath", "shower", "washer", "boiler"].includes(fx.kind) ? white : m;
    this.box(g, fx.x, fx.y, fx.x + fx.w, fx.y + fx.d, 0, fx.h ?? H[fx.kind] ?? 0.5, top);
  }

  private flatRoof(g: THREE.Group, r: Rect) {
    const pal = this.pal, wo = this.house?.wall?.outer ?? 0.3;
    // the extension's roof sits one storey down from this floor: draw it at this floor's level with a low edge
    this.box(g, r.x - wo, r.y, r.x + r.w + wo, r.y + r.d + wo, -0.16, -0.02, this.mat(pal.roof, { roughness: 1 }), false);
    const edge = this.mat(pal.outer);
    this.box(g, r.x - wo, r.y + r.d, r.x + r.w + wo, r.y + r.d + wo, -0.02, 0.18, edge);
    this.box(g, r.x - wo, r.y, r.x, r.y + r.d + wo, -0.02, 0.18, edge);
    this.box(g, r.x + r.w, r.y, r.x + r.w + wo, r.y + r.d + wo, -0.02, 0.18, edge);
  }

  /** A see-through gable roof, ridge across the width, eaves at `from`/`to`. */
  private gable(h: House, f: Floor): THREE.Object3D {
    const r = f.roof!, wo = h.wall?.outer ?? 0.3, y0 = (r.from ?? 0) - wo, y1 = (r.to ?? f.depth) + wo, mid = (y0 + y1) / 2;
    const xa = -wo, xb = h.width + wo, P = (x: number, y: number, z: number) => { const p = this.toWorld(x, y); return [p.x, z, p.z]; };
    const pos = [
      ...P(xa, y0, 0), ...P(xb, y0, 0), ...P(xb, mid, r.ridge), ...P(xa, y0, 0), ...P(xb, mid, r.ridge), ...P(xa, mid, r.ridge),
      ...P(xa, y1, 0), ...P(xa, mid, r.ridge), ...P(xb, mid, r.ridge), ...P(xa, y1, 0), ...P(xb, mid, r.ridge), ...P(xb, y1, 0),
      ...P(xa, y0, 0), ...P(xa, mid, r.ridge), ...P(xa, y1, 0), ...P(xb, y0, 0), ...P(xb, y1, 0), ...P(xb, mid, r.ridge),
    ];
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.pal.roof, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: this.pal.outer, transparent: true, opacity: 0.55 }));
    const grp = new THREE.Group(); grp.add(mesh, lines); grp.name = "roof";
    return grp;
  }

  // ---------- views ----------
  private show: string = "all";
  /** "all" sets the storeys side by side, ground floor on the left, each a step higher (stacked they hide each other);
   *  a floor id shows only that storey. */
  setView(view: string, animate = true) {
    this.show = view; this.touched = false;
    this.layoutFloors();
    this.frame(animate);
  }
  private layoutFloors() {
    const h = this.house; if (!h) return;
    const levels = this.floors.map((f) => f.group.userData.level as number), lo = Math.min(...levels), hi = Math.max(...levels);
    const gap = h.width + 2 * (h.wall?.outer ?? 0.3) + 1.6;
    for (const f of this.floors) {
      const lv = f.group.userData.level as number, all = this.show === "all";
      f.base = all ? (lv - lo) * 0.7 : 0;
      f.group.position.set(all ? ((lo + hi) / 2 - lv) * gap * (h.mirror ? -1 : 1) : 0, f.base, 0);
      f.group.visible = all || this.show === f.id;
      if (f.roof) f.roof.visible = this.show === f.id;
    }
    this.attachBaked();
  }
  visible(floor: string) { return this.show === "all" || this.show === floor; }
  /** World position of a model point on a storey, `up` metres above its floor. */
  at(floor: string, x: number, y: number, up = 0): THREE.Vector3 {
    const g = this.floors.find((f) => f.id === floor)?.group;
    const p = this.toWorld(x, y, up);
    return g ? p.add(g.position) : p;
  }
  /** A point given in a storey's own (group) space, in world space. */
  local(floor: string, p: THREE.Vector3): THREE.Vector3 {
    const g = this.floors.find((f) => f.id === floor)?.group;
    return g ? p.clone().add(g.position) : p.clone();
  }

  // ---------- the move gizmo ----------
  private storey() { return this.house?.storeyHeight ?? 2.8; }
  /** Put the gizmo on a pin (model x, y, height above its floor), or take it away (null). Ignored mid-drag. */
  setGizmo(p: { floor: string; x: number; y: number; z: number } | null) {
    if (this.gizmo.dragging) return;
    const g = p && this.house ? this.floors.find((f) => f.id === p.floor)?.group : undefined;
    if (!p || !g) { this.gizmoFloor = null; this.gizmo.detach(); this.gizmoObj.removeFromParent(); this.invalidate(); return; }
    this.gizmoFloor = p.floor;
    if (this.gizmoObj.parent !== g) g.add(this.gizmoObj);
    this.gizmoObj.position.copy(this.toWorld(p.x, p.y, p.z));
    if (this.gizmo.object !== this.gizmoObj) this.gizmo.attach(this.gizmoObj);
    this.invalidate();
  }
  private gizmoMoved() {
    const h = this.house, f = h?.floors.find((x) => x.id === this.gizmoFloor);
    if (!h || !f) return;
    const S = shellOf(h, f), m = this.toModel(this.gizmoObj.position), c = THREE.MathUtils.clamp;
    const x = +c(m.x, S.x, S.x + S.w).toFixed(2), y = +c(m.y, S.y, S.y + S.d).toFixed(2), z = +c(this.gizmoObj.position.y, 0, this.storey()).toFixed(2);
    this.gizmoObj.position.copy(this.toWorld(x, y, z)); // the arrows stop at the walls, the floor and the ceiling
    this.onGizmo?.({ x, y, z });
  }

  /** Move the camera to take in what's shown: from the street side, a little to the right, looking down. */
  frame(animate = true) {
    if (!this.house) return;
    this.scene.updateMatrixWorld(); // storeys may have just moved
    const box = new THREE.Box3();
    for (const f of this.floors) if (f.group.visible) for (const m of this.pickables) if (m.parent === f.group) box.expandByObject(m);
    if (box.isEmpty()) return;
    box.expandByScalar(0.4); box.max.y += 1.1;
    for (const f of this.floors) { const b = this.baked.get(f.id); if (f.group.visible && b?.root.parent === f.group) box.union(new THREE.Box3().setFromObject(b.root)); } // full-height walls, the roof
    const target = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    // fit the box's footprint: fov is vertical; the horizontal one depends on the aspect
    const v = THREE.MathUtils.degToRad(this.camera.fov) / 2, hz = Math.atan(Math.tan(v) * this.camera.aspect);
    // a long, narrow storey on a wide screen is seen from its side (the street on the right) to use the width
    const side = this.show !== "all" && this.camera.aspect > 1.1 && size.z > size.x * 1.6, m = this.house.mirror ? -1 : 1;
    const photo = this.photoDir();
    const dir = photo ?? (side ? new THREE.Vector3(m, 1.45, -0.3) : new THREE.Vector3(-0.28 * m, 1.35, -1)).normalize();
    const [across, deep] = side && !photo ? [size.z, size.x] : [size.x, size.z];
    let dist = Math.max((across / 2) / Math.tan(hz), (deep * 0.55) / Math.tan(v), 6) * (this.camera.aspect < 0.8 ? 1.3 : 1.12);
    if (photo) { // fit the box as the camera sees it, like the photo's framing
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right);
      dist = 0;
      for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
        const d = new THREE.Vector3(cx, cy, cz).sub(target);
        dist = Math.max(dist, (Math.abs(d.dot(right)) * 1.03) / Math.tan(hz) + d.dot(dir), (Math.abs(d.dot(up)) * 1.03) / Math.tan(v) + d.dot(dir));
      }
    }
    const pos = target.clone().addScaledVector(dir, dist);
    this.framed = { dist, target: target.clone() };
    if (animate) this.goal = { pos, target }; else { this.camera.position.copy(pos); this.controls.target.copy(target); }
    this.invalidate();
  }

  /** Turn the camera around the house by `deg` (a D-pad press), gliding there. */
  orbit(deg: number) {
    const t = (this.goal?.target ?? this.controls.target).clone(), from = (this.goal?.pos ?? this.camera.position).clone().sub(t);
    from.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    this.goal = { pos: t.clone().add(from), target: t }; this.touched = true;
    this.invalidate();
  }
  /** What frame() took in: zoom() keeps between a third of that distance and one and a half times it and zooms back out towards its centre. */
  private framed: { dist: number; target: THREE.Vector3 } | null = null;
  /** Zoom by `f` (< 1 in, > 1 out), gliding there; zooming in drifts towards `focus` (the ringed lamp). False at a limit. */
  zoom(f: number, focus?: THREE.Vector3 | null): boolean {
    const t = (this.goal?.target ?? this.controls.target).clone(), off = (this.goal?.pos ?? this.camera.position).clone().sub(t), d = off.length();
    const base = this.framed?.dist ?? d, c = THREE.MathUtils.clamp;
    const nd = c(d * f, Math.max(this.controls.minDistance, base * 0.33), Math.min(this.controls.maxDistance, base * 1.5));
    if (Math.abs(nd - d) < 0.01) return false;
    const to = f < 1 ? focus : this.framed?.target;
    const nt = to ? t.clone().lerp(to, f < 1 ? 0.45 : 0.35) : t;
    this.goal = { pos: nt.clone().add(off.setLength(nd)), target: nt }; this.touched = true;
    this.invalidate();
    return true;
  }
  /** A slow turn that draws every frame (the TV kiosk's intro, which also measures the frame rate). */
  spin(on: boolean) { Object.assign(this.controls, { autoRotate: on, autoRotateSpeed: 1.2 }); this.invalidate(); }

  /** A single baked storey starts where the photo's camera stands (from the garden, 3/4, looking down). */
  private photoDir(): THREE.Vector3 | null {
    if (this.show === "all" || !this.baked.has(this.show) || !this.glb) return null;
    const a = THREE.MathUtils.degToRad(this.glb.m.camera.az), el = THREE.MathUtils.degToRad(this.glb.m.camera.el);
    // Blender's view direction (x across, y towards the garden, z up), mirrored with the house, turned into this scene
    const bx = -Math.sin(a) * Math.cos(el) * (this.glb.m.mirror ? -1 : 1), by = Math.cos(a) * Math.cos(el), bz = Math.sin(el);
    return new THREE.Vector3(-bx, bz, by).normalize();
  }

  /** A room's lamp light (0 dark … 1 a light at full brightness, and the baked maps' colour × brightness). */
  setGlow(room: string, g: RoomGlow = { level: 0, lamp: [0, 0, 0], own: [0, 0, 0] }) {
    const r = this.rooms.get(room); if (!r) return;
    const level = g.level;
    this.glowOf.set(room, g);
    for (const m of r.mats) m.emissiveIntensity = level ? 0.08 + level * (this.pal.dark ? 0.3 : 0.2) : 0;
    r.light.intensity = level ? 2.5 + level * 6 : 0;
    const b = this.baked.get(r.floor), i = this.house?.floors.find((f) => f.id === r.floor)?.rooms.findIndex((x) => x.id === room) ?? -1;
    if (b && i >= 0 && i + 1 < b.glow.length) { b.glow[i + 1].fromArray(g.lamp); b.own[i + 1].fromArray(g.own); }
    this.invalidate();
  }

  /** Screen position of a world point (null when behind the camera). */
  project(p: THREE.Vector3): { x: number; y: number; depth: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight, depth: this.camera.position.distanceTo(p) };
  }

  // ---------- doors: tap to swing ----------
  private hoverDoor: BakedDoor | null = null; private pressDoor: BakedDoor | null = null; private hoverAt = 0;
  /** The door leaf under a screen point (nothing solid in front of it), or null. With `slop` (a finger's reach, in px) a
   *  tap that just misses a leaf, or lands on a sliver of it, takes the nearest leaf that is really visible within reach. */
  doorAt(clientX: number, clientY: number, occlude = true, slop = 0): BakedDoor | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const shown = [...this.baked.values()].filter((b) => { for (let o: THREE.Object3D | null = b.root; o; o = o.parent) if (!o.visible) return false; return !!b.root.parent; });
    const leaves = shown.flatMap((b) => b.doors);
    if (!leaves.length) return null;
    const meshes = leaves.map((d) => d.mesh), solid = shown.flatMap((b) => b.walls).filter((m) => m.visible); // a folded wall doesn't block
    const cast = (x: number, y: number) => {
      this.ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
      this.ray.far = Infinity;
    };
    const visible = (x: number, y: number): BakedDoor | null => {
      cast(x, y);
      const hit = this.ray.intersectObjects(meshes, false)[0];
      if (!hit) return null;
      if (occlude) { // a wall or furniture in front of the leaf takes the tap
        this.ray.far = hit.distance - 0.03;
        const blocked = this.ray.intersectObjects(solid, false).length > 0;
        this.ray.far = Infinity;
        if (blocked) return null;
      }
      return leaves.find((d) => d.mesh === hit.object) ?? null;
    };
    const exact = visible(clientX, clientY);
    if (exact || slop <= 0) return exact;
    // around the tap: nearest first, doors only (cheap), then the occlusion test on the few that are candidates
    const cand: { x: number; y: number; d: number }[] = [];
    for (const k of [0.35, 0.7, 1]) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, x = clientX + Math.cos(a) * slop * k, y = clientY + Math.sin(a) * slop * k;
      cast(x, y);
      if (this.ray.intersectObjects(meshes, false).length) cand.push({ x, y, d: slop * k });
    }
    for (const c of cand.sort((p, q) => p.d - q.d)) { const d = visible(c.x, c.y); if (d) return d; }
    return null;
  }
  /** Test aid: each shown door's centre in client pixels and whether a tap there reaches it. */
  doorPoints(): { name: string; open: boolean; x: number; y: number; hit: string | null }[] {
    const r = this.renderer.domElement.getBoundingClientRect(), out: { name: string; open: boolean; x: number; y: number; hit: string | null }[] = [];
    for (const b of this.baked.values()) {
      let vis = !!b.root.parent;
      for (let o: THREE.Object3D | null = b.root; o; o = o.parent) if (!o.visible) vis = false;
      if (!vis) continue;
      for (const d of b.doors) {
        const c = new THREE.Box3().setFromObject(d.mesh).getCenter(new THREE.Vector3()).project(this.camera);
        const x = r.left + ((c.x + 1) / 2) * r.width, y = r.top + ((1 - c.y) / 2) * r.height;
        out.push({ name: d.name, open: d.goal > 0.5, x, y, hit: this.doorAt(x, y)?.name ?? null });
      }
    }
    return out;
  }
  /** A tap at a screen point: swing the door there. True when it hit one. */
  toggleDoorAt(clientX: number, clientY: number, slop = 0): boolean {
    const d = this.doorAt(clientX, clientY, true, slop);
    if (!d) return false;
    toggleDoor(d); this.setPress(null); this.invalidate();
    return true;
  }
  private setHi(d: BakedDoor | null, kind: "hover" | "press") {
    const prev = kind === "hover" ? this.hoverDoor : this.pressDoor;
    if (prev === d) return;
    if (kind === "hover") this.hoverDoor = d; else this.pressDoor = d;
    for (const x of [prev, d]) if (x) x.hiGoal = x === this.pressDoor ? 0.5 : x === this.hoverDoor ? 0.22 : 0;
    this.invalidate();
  }
  /** Mouse hover: a pointer cursor and a soft brightening on a door (throttled: the occlusion test walks the walls). */
  hoverAtPoint(clientX: number, clientY: number) {
    const now = performance.now();
    if (now - this.hoverAt < 70) return;
    this.hoverAt = now;
    const d = this.doorAt(clientX, clientY);
    this.setHi(d, "hover");
    this.renderer.domElement.style.cursor = d ? "pointer" : "";
  }
  clearHover() { this.setHi(null, "hover"); this.renderer.domElement.style.cursor = ""; }
  /** A press on a door (before it is known to be a tap): a stronger cue; null releases it. */
  setPress(d: BakedDoor | null | "at", x = 0, y = 0, slop = 0) {
    this.setHi(d === "at" ? this.doorAt(x, y, true, slop) : d, "press");
  }

  /** The room under a screen point: floor id, room id and the model position. */
  pick(clientX: number, clientY: number): { floor: string; room: string; x: number; y: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects(this.pickables.filter((m) => m.parent?.visible), false)[0];
    if (!hit) return null;
    const { floor, room } = hit.object.userData as { floor: string; room: string };
    const m = this.toModel(hit.point.clone().sub(hit.object.parent!.position));
    return { floor, room, x: +m.x.toFixed(2), y: +m.y.toFixed(2) };
  }
}
