<script setup lang="ts">
// Draws a server range query as is (fixed-step buckets, null = gap): line + soft fill, min–max band for
// aggregated steps. Hover to read a bucket. No client-side re-bucketing.
import { computed, ref } from "vue";

export interface Series { step: number; t: number[]; avg: (number | null)[]; min: (number | null)[]; max: (number | null)[] }
const props = defineProps<{ series: Series | null; fmt: (v: number) => string; color?: string; band?: boolean; minSpan?: number; axis?: boolean }>();
const W = 600, H = 200;
const hover = ref<number | null>(null);

const dom = computed(() => {
  const s = props.series; if (!s) return null;
  const vals = (props.band ? [...s.min, ...s.max] : s.avg).filter((v): v is number => v != null);
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, props.minSpan ?? 1), mid = (hi + lo) / 2;
  lo = mid - span * 0.6; hi = mid + span * 0.6;
  return { lo, hi, t0: s.t[0], t1: s.t[s.t.length - 1] + s.step };
});
const X = (t: number) => (dom.value ? ((t - dom.value.t0) / (dom.value.t1 - dom.value.t0)) * W : 0);
const Y = (v: number) => (dom.value ? H - ((v - dom.value.lo) / (dom.value.hi - dom.value.lo)) * H : 0);
/** One path per run of non-null buckets, so gaps stay gaps. */
const segs = computed(() => {
  const s = props.series; if (!s || !dom.value) return [];
  const out: number[][] = []; let cur: number[] = [];
  s.avg.forEach((v, i) => { if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push(i); });
  if (cur.length) out.push(cur);
  return out;
});
const mid = (i: number) => props.series!.t[i] + props.series!.step / 2;
const line = (idx: number[]) => idx.map((i, k) => `${k ? "L" : "M"}${X(mid(i)).toFixed(1)},${Y(props.series!.avg[i]!).toFixed(1)}`).join("");
const fill = (idx: number[]) => `${line(idx)}L${X(mid(idx[idx.length - 1])).toFixed(1)},${H}L${X(mid(idx[0])).toFixed(1)},${H}Z`;
const bandPath = (idx: number[]) => {
  const s = props.series!;
  const top = idx.map((i, k) => `${k ? "L" : "M"}${X(mid(i)).toFixed(1)},${Y(s.max[i] ?? s.avg[i]!).toFixed(1)}`).join("");
  const bot = [...idx].reverse().map((i) => `L${X(mid(i)).toFixed(1)},${Y(s.min[i] ?? s.avg[i]!).toFixed(1)}`).join("");
  return top + bot + "Z";
};
function move(e: PointerEvent) {
  const s = props.series; if (!s) return;
  const r = (e.currentTarget as SVGElement).getBoundingClientRect();
  const t = dom.value!.t0 + ((e.clientX - r.left) / r.width) * (dom.value!.t1 - dom.value!.t0);
  let best = -1, bd = Infinity;
  s.avg.forEach((v, i) => { if (v != null && Math.abs(mid(i) - t) < bd) { bd = Math.abs(mid(i) - t); best = i; } });
  hover.value = best >= 0 ? best : null;
}
const hv = computed(() => (hover.value != null && props.series ? { t: props.series.t[hover.value], v: props.series.avg[hover.value]!, lo: props.series.min[hover.value], hi: props.series.max[hover.value] } : null));
defineExpose({ hv });
const c = computed(() => props.color ?? "var(--ink)");
const ticks = computed(() => (dom.value ? [dom.value.hi - (dom.value.hi - dom.value.lo) * 0.15, (dom.value.hi + dom.value.lo) / 2, dom.value.lo + (dom.value.hi - dom.value.lo) * 0.15] : []));
</script>

<template>
  <div class="lc">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" @pointermove="move" @pointerleave="hover = null">
      <defs><linearGradient :id="`g${$.uid}`" x1="0" x2="0" y1="0" y2="1"><stop offset="0" :stop-color="c" stop-opacity=".22" /><stop offset="1" :stop-color="c" stop-opacity="0" /></linearGradient></defs>
      <template v-for="(idx, k) in segs" :key="k">
        <path v-if="props.band" :d="bandPath(idx)" :fill="c" fill-opacity=".14" />
        <path v-else :d="fill(idx)" :fill="`url(#g${$.uid})`" />
        <path :d="line(idx)" fill="none" :stroke="c" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </template>
      <line v-if="hv" :x1="X(hv.t + series!.step / 2)" :x2="X(hv.t + series!.step / 2)" y1="0" :y2="H" stroke="#fff" stroke-opacity=".3" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-if="axis && ticks.length" class="lc-y"><span v-for="t in ticks" :key="t">{{ fmt(t) }}</span></div>
    <div v-if="hv" class="lc-tip">{{ fmt(hv.v) }}<small>{{ new Date(hv.t * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) }}<template v-if="props.band && hv.lo != null"> · {{ fmt(hv.lo) }}–{{ fmt(hv.hi!) }}</template></small></div>
    <div v-if="!series" class="lc-load">Loading…</div>
    <div v-else-if="!segs.length" class="lc-load">No data yet</div>
  </div>
</template>
