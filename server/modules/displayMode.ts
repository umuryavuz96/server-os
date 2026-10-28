// Display resolution for the remote screen (macOS). A headless Mac's Screen Sharing virtual display is 3840x2160 backing
// (HiDPI), and Screen Sharing sends it as ZRLE: ~14 MB per full frame, so the viewer crawls at ~1 fps. While a web screen
// session is open we switch the main display to a smaller non-HiDPI mode (CoreGraphics, server/native/displaymode.swift)
// and put the original mode back when the session ends. A marker file records "switched" so a crash is healed on next start.
// Linux: no-op (x11vnc etc. scale on their own).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Res = "native" | "1080p" | "720p";
export const RESES: Res[] = ["native", "1080p", "720p"];
export const SIZES: Record<Exclude<Res, "native">, [number, number]> = { "1080p": [1920, 1080], "720p": [1280, 720] };
export const parseRes = (v: unknown): Res | null => (RESES.includes(v as Res) ? (v as Res) : null);
/** false: never touch the display. true (default): only Screen Sharing's virtual display. "any": a real monitor too. */
export type ResizePolicy = boolean | "any";

/** Why an apply did nothing (or failed), in words the viewer can show. */
export type Why = "disabled" | "not-virtual" | "no-mode" | "helper" | "failed";
export interface Outcome { result: "switched" | "restored" | "kept" | "skipped"; why?: Why; sizes?: string }
export interface SizeOption { res: Res; width: number; height: number; available: boolean }
export interface Describe {
  supported: boolean; virtual: boolean | null; current: { width: number; height: number; hidpi: boolean } | null;
  /** One entry per Size button. "native" is always available and is the display's current size when nothing was switched. */
  sizes: SizeOption[]; why?: Why;
}
export interface ModeInfo { id: number; width: number; height: number; pixelWidth: number; pixelHeight: number; hidpi: boolean }
export interface DisplayInfo { ok: true; display: number; builtin: boolean; virtual: boolean; current: ModeInfo }
export type Runner = (args: string[]) => Promise<unknown>;

/** May the display be touched? A real monitor (built-in, or any non-virtual one) only with resizeDisplay: any. */
export function allowed(info: Pick<DisplayInfo, "virtual" | "builtin">, policy: ResizePolicy): boolean {
  if (policy === false) return false;
  return info.virtual || policy === "any";
}

/** The mode size wanted for a resolution, or null for "leave it / put it back". */
export function wantedSize(res: Res): [number, number] | null { return res === "native" ? null : SIZES[res]; }

export interface Marker { display: number; originalWidth: number; originalHeight: number; originalHidpi: boolean; at: number }

/** "1920×1080, 1280×800" for the distinct non-HiDPI sizes a display has. */
export function sizesText(modes: ModeInfo[]): string {
  return [...new Set(modes.filter((m) => !m.hidpi).sort((a, b) => b.pixelWidth - a.pixelWidth).map((m) => `${m.pixelWidth}×${m.pixelHeight}`))].join(", ");
}

/** A sentence for a skipped switch. */
export function whyText(o: Outcome): string {
  switch (o.why) {
    case "disabled": return "Resizing is turned off (integrations.screen.resizeDisplay).";
    case "not-virtual": return "This is a real monitor, so the server leaves its resolution alone.";
    case "no-mode": return `This screen has no such size. It only offers ${o.sizes || "its current size"}.`;
    case "helper": return "The display helper could not read the Mac's display.";
    case "failed": return "The Mac refused to switch to that size.";
    default: return "";
  }
}

/** Switches the main display and remembers how to undo it. Calls are queued, so a takeover (restore, then switch) keeps its order. */
export class DisplayController {
  private q: Promise<unknown> = Promise.resolve();
  constructor(private run: Runner, private marker: string, private policy: () => ResizePolicy, private platform: NodeJS.Platform = process.platform) {}
  private queue<T>(f: () => Promise<T>): Promise<T> { const r = this.q.then(f, f); this.q = r.catch(() => {}); return r; }
  get supported() { return this.platform === "darwin" && this.policy() !== false; }
  private readMarker(): Marker | null { try { return JSON.parse(readFileSync(this.marker, "utf8")) as Marker; } catch { return null; } }
  get switched() { return this.readMarker() !== null; }

  /** Make the display match `res`. Returns what was done: "switched", "restored", "kept" (already right) or "skipped". */
  apply(res: Res): Promise<Outcome["result"]> { return this.applyWhy(res).then((o) => o.result); }

  /** Like apply, but says why nothing happened. */
  applyWhy(res: Res): Promise<Outcome> {
    return this.queue(async (): Promise<Outcome> => {
      if (!this.supported) return { result: "skipped", why: "disabled" };
      const size = wantedSize(res);
      if (!size) return { result: (await this.restoreNow()) ? "restored" : "kept" };
      const info = (await this.run(["info"])) as DisplayInfo;
      if (!info?.ok) return { result: "skipped", why: "helper" };
      // After our own switch the virtual display is re-created with another identity: a marker means it is still ours.
      if (!allowed(info, this.policy()) && !(this.readMarker() && this.policy() !== false)) return { result: "skipped", why: "not-virtual" };
      const [w, h] = size, c = info.current;
      if (!c.hidpi && c.pixelWidth === w && c.pixelHeight === h) return { result: "kept" };
      // The display must really offer the size, else the switch fails after the marker was written.
      const have = await this.listModes();
      if (have && !have.some((m) => m.pixelWidth === w && m.pixelHeight === h && !m.hidpi)) return { result: "skipped", why: "no-mode", sizes: sizesText(have) };
      // First switch of this run: keep the ORIGINAL mode (a later switch must not overwrite it with an intermediate one).
      if (!this.readMarker()) {
        mkdirSync(dirname(this.marker), { recursive: true });
        writeFileSync(this.marker, JSON.stringify({ display: info.display, originalWidth: c.pixelWidth, originalHeight: c.pixelHeight, originalHidpi: c.hidpi, at: Date.now() } satisfies Marker));
      }
      const r = (await this.run(["set", String(w), String(h)])) as { ok: boolean };
      if (!r?.ok) { await this.restoreNow(); return { result: "skipped", why: "failed" }; }
      return { result: "switched" };
    });
  }

  private async listModes(): Promise<ModeInfo[] | null> {
    try { const l = (await this.run(["list"])) as { ok: boolean; modes?: ModeInfo[] }; return l?.ok && l.modes ? l.modes : null; } catch { return null; }
  }

  /** What the Size control may offer: the sizes the display really has (read-only; nothing is switched). */
  describe(): Promise<Describe> {
    return this.queue(async (): Promise<Describe> => {
      const none = (why: Why): Describe => ({ supported: false, virtual: null, current: null, sizes: [], why });
      if (!this.supported) return none("disabled");
      let l: { ok: boolean; current?: ModeInfo; modes?: ModeInfo[] }, info: DisplayInfo;
      try { l = (await this.run(["list"])) as typeof l; info = (await this.run(["info"])) as DisplayInfo; } catch { return none("helper"); }
      if (!l?.ok || !l.current || !l.modes) return none("helper");
      const ok = allowed(info?.ok ? info : { virtual: false, builtin: false }, this.policy()) || this.readMarker() !== null;
      const cur = l.current;
      const sizes: SizeOption[] = RESES.map((r) => {
        if (r === "native") return { res: r, width: cur.pixelWidth, height: cur.pixelHeight, available: true };
        const [w, h] = SIZES[r];
        return { res: r, width: w, height: h, available: ok && l.modes!.some((m) => m.pixelWidth === w && m.pixelHeight === h && !m.hidpi) };
      });
      return { supported: true, virtual: info?.virtual ?? null, current: { width: cur.pixelWidth, height: cur.pixelHeight, hidpi: cur.hidpi }, sizes, ...(ok ? {} : { why: "not-virtual" as Why }) };
    });
  }

  /** Put the original mode back (session ended, shutdown, stale marker at start). */
  restore(): Promise<boolean> { return this.queue(() => this.restoreNow()); }
  private async restoreNow(): Promise<boolean> {
    const m = this.readMarker();
    if (!m) return false;
    try {
      const r = (await this.run(["restore", String(m.originalWidth), String(m.originalHeight), m.originalHidpi ? "1" : "0"])) as { ok: boolean };
      if (r?.ok) { rmSync(this.marker, { force: true }); return true; }
    } catch { /* keep the marker: the next start tries again */ }
    return false;
  }
}

/** Compile the Swift helper next to the state (once, or when the source is newer) and return a runner for it. */
export function swiftRunner(source: string, binary: string): Runner {
  let ready: Promise<string> | null = null;
  const build = async () => {
    if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
      mkdirSync(dirname(binary), { recursive: true });
      const p = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "ignore", stderr: "pipe" });
      if ((await p.exited) !== 0) throw new Error("swiftc failed: " + (await new Response(p.stderr).text()).slice(0, 300));
    }
    return binary;
  };
  return async (args) => {
    const bin = await (ready ??= build().catch((e) => { ready = null; throw e; }));
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill(), 10_000);
    const text = await new Response(p.stdout).text();
    clearTimeout(t);
    try { return JSON.parse(text); } catch { return { ok: false, error: "bad helper output" }; }
  };
}

export const markerPath = (stateDir: string) => join(stateDir, "screen-display-switched.json");
