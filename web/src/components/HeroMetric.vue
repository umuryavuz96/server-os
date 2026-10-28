<script setup lang="ts">
// Option 3 "hero card": a big number sitting on a full-bleed trend. Hover / touch the card to read any point.
import AnimatedNumber from "./AnimatedNumber.vue";
import { computed, ref, watch, onUnmounted } from "vue";

export type Lvl = "g" | "a" | "r";
const props = defineProps<{ label: string; value: string; unit: string; badge: string; level: Lvl; t: number[]; v: (number | null)[]; fmt: (v: number) => string; from: string; size?: "xl" | "md"; href?: string; minSpan?: number; metric?: string; ranges?: string[] }>();

// ---- range button: one tap cycles through ranges; the first entry is the live data passed in ----
const RSEC: Record<string, number> = { "1H": 3600, "2H": 7200, "6H": 21600, "24H": 86400, "7D": 604800, "30D": 2592000, "90D": 7776000 };
const ri = ref(0);
const range = computed(() => props.ranges?.[ri.value] ?? null);
const fetched = ref<{ t: number[]; v: (number | null)[] } | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
async function load() {
  if (!props.metric || ri.value === 0 || !range.value) { fetched.value = null; return; }
  try { fetched.value = await (await fetch(`/svc-api/history?metric=${props.metric}&range=${range.value.toLowerCase()}`)).json(); } catch {}
}
watch(ri, () => { load(); if (timer) clearInterval(timer); timer = ri.value ? setInterval(load, 60_000) : null; });
onUnmounted(() => { if (timer) clearInterval(timer); });
// what one plotted point covers: the chart averages into at most 60 points, so resolution = window / 60 (raw data permitting)
const resLabel = computed(() => {
  const r = range.value; if (!r) return "";
  const raw = props.metric === "net" ? 3600 : 15, sec = Math.max(raw, (RSEC[r] ?? 7200) / 60);
  return sec < 60 ? `${Math.round(sec)}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`;
});
const cycle = () => { ri.value = (ri.value + 1) % (props.ranges?.length ?? 1); hi.value = null; };
const T = computed(() => (fetched.value ? fetched.value.t : props.t));
const V = computed(() => (fetched.value ? fetched.value.v : props.v));

// Average into at most 60 buckets: raw 15-s samples make a noisy line at this size.
const pts = computed(() => {
  const raw = T.value.map((t, i) => ({ t, v: V.value[i] })).filter((p): p is { t: number; v: number } => p.v != null);
  if (raw.length <= 60) return raw;
  const per = raw.length / 60, out: { t: number; v: number }[] = [];
  for (let b = 0; b < 60; b++) { const g = raw.slice(Math.floor(b * per), Math.floor((b + 1) * per)); if (g.length) out.push({ t: g[g.length - 1].t, v: g.reduce((s, x) => s + x.v, 0) / g.length }); }
  return out;
});
const scale = computed(() => {
  const p = pts.value; if (p.length < 2) return null;
  const vs = p.map((x) => x.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const span = Math.max(hi - lo, props.minSpan ?? 0, 1e-6), mid = (hi + lo) / 2; // never zoom in so far that noise looks like drama
  // a picked range always spans its full window, so a short history shows up as a short line on the right
  const now = Date.now() / 1000, win = fetched.value && range.value ? RSEC[range.value] ?? 0 : 0;
  return { t0: win ? now - win : p[0].t, t1: win ? now : p[p.length - 1].t, lo: mid - span * 0.6, hi: mid + span * 0.6 };
});
// the chart lives in the lower part of the card so the number and badge stay readable above it
const band = computed(() => (props.size === "xl" ? 52 : 40));
const X = (t: number) => { const s = scale.value!; return ((t - s.t0) / (s.t1 - s.t0 || 1)) * 100; };
const Y = (v: number) => { const s = scale.value!; return 97 - ((v - s.lo) / (s.hi - s.lo)) * band.value; };
const line = computed(() => (scale.value ? "M" + pts.value.map((p) => `${X(p.t).toFixed(2)},${Y(p.v).toFixed(2)}`).join("L") : ""));
const area = computed(() => (line.value ? `${line.value}L100,100L${X(pts.value[0].t).toFixed(2)},100Z` : "")); // close under the first point, not at x=0
const stroke = computed(() => (props.level === "r" ? "#ff2b3d" : props.level === "a" ? "#ffb21e" : "#f2f2f3"));
const stats = computed(() => {
  const vs = T.value.map((_, i) => V.value[i]).filter((x): x is number => x != null);
  if (vs.length < 2) return null;
  return { min: Math.min(...vs), max: Math.max(...vs), avg: vs.reduce((a, b) => a + b, 0) / vs.length };
});
const fromLabel = computed(() => {
  if (!fetched.value || !range.value) return props.from;
  const t0 = fetched.value.t[0]; if (!t0) return "no data yet";
  const want = RSEC[range.value] ?? 0;
  const have = Date.now() / 1000 - t0;
  return have < want * 0.9 ? `since ${new Date(t0 * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : `${range.value.toLowerCase()} ago`;
});
const gap = computed(() => { const sc = scale.value, p = pts.value; if (!sc || !p.length) return 0; const g = X(p[0].t); return g > 3 ? g : 0; });
const reset = () => { ri.value = 0; hi.value = null; };
const gid = "h" + Math.random().toString(36).slice(2, 8);

const box = ref<HTMLElement | null>(null), hi = ref<number | null>(null);
function track(e: PointerEvent) {
  const el = box.value; if (!el || !scale.value) return;
  const r = el.getBoundingClientRect(), fx = ((e.clientX - r.left) / r.width) * 100;
  let best = 0, bd = Infinity;
  pts.value.forEach((p, i) => { const d = Math.abs(X(p.t) - fx); if (d < bd) { bd = d; best = i; } });
  hi.value = best;
}
const hp = computed(() => (hi.value != null ? pts.value[hi.value] : null));
const when = (t: number) => new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <div ref="box" class="hero" :class="[size ?? 'md', 'l-' + level]" @pointermove="track" @pointerdown="track" @pointerleave="hi = null">
    <div v-if="gap" class="hero-gap" :style="{ width: gap + '%' }"><span>no data yet</span></div>
    <Transition name="rt" mode="out-in">
    <svg v-if="line" :key="range ?? 'live'" class="hero-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" :aria-label="`${label} trend since ${from}`">
      <defs><linearGradient :id="gid" x1="0" x2="0" y1="0" y2="1"><stop offset="0" :stop-color="stroke" stop-opacity=".3" /><stop offset="1" :stop-color="stroke" stop-opacity="0" /></linearGradient></defs>
      <path :d="area" :fill="`url(#${gid})`" />
      <path :d="line" fill="none" :stroke="stroke" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <line v-if="hp" :x1="X(hp.t)" :x2="X(hp.t)" :y1="100 - band - 4" y2="100" stroke="rgba(242,242,243,.45)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    </Transition>
    <span v-if="hp" class="hero-dot" :style="{ left: X(hp.t) + '%', top: Y(hp.v) + '%', background: stroke }"></span>
    <div class="hero-top">
      <div class="hero-l"><span>{{ label }}</span><a v-if="href" :href="href" class="hero-a">Open →</a></div>
      <div class="hero-v">
        <AnimatedNumber v-if="Number.isFinite(parseFloat(value)) || hp" :value="hp ? hp.v : parseFloat(value)" :fmt="fmt" :duration="hp ? 140 : 300" /><span v-else>{{ value }}</span><!-- rolls, never fades: follows the pointer -->
        <small>{{ hp ? when(hp.t) : unit }}</small>
      </div>
      <div class="hero-b" :class="'b-' + level" :title="badge">{{ badge }}</div>
    </div>
    <div class="hero-x"><span>{{ fromLabel }}</span><span v-if="stats" class="hero-st">min {{ fmt(stats.min) }} · avg {{ fmt(stats.avg) }} · max {{ fmt(stats.max) }}</span><span>now</span></div>
    <button v-if="ranges && ranges.length > 1" type="button" class="hero-rng" :aria-label="`Time range ${range}, one point per ${resLabel}; tap for the next range`" @click.stop="cycle" @pointermove.stop @pointerdown.stop>{{ range }}<small> · {{ resLabel }}</small></button>
    <Transition name="rt"><button v-if="ri > 0" type="button" class="hero-rst" :aria-label="`Back to ${ranges?.[0]}`" @click.stop="reset" @pointermove.stop @pointerdown.stop>↺</button></Transition>
    <slot />
  </div>
</template>
