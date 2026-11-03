<script setup lang="ts">
// Glass desktop v3 (2026-10-30): the reel's small stat card. A tinted icon square top left, an arrow top right,
// a grey label, the bold value, a small delta pill and a sparkline in the card's own colour.
// The delta compares now with the start of the shown range, so it always matches the line next to it.
// The whole card is a button: it puts this metric in the big chart below.
import { computed, ref, watch, onUnmounted } from "vue";
import Icon from "../components/Icon.vue";
import type { IconName } from "../icons";

const props = defineProps<{
  label: string; value: string; unit: string; level: "g" | "a" | "r"; icon: IconName; tone: "amber" | "green" | "blue" | "violet";
  t: number[]; v: (number | null)[]; metric: string; ranges: string[];
  /** the Overview's range pill: null = live data (what t/v hold); a range this card does not keep falls back to live */
  pick: string | null;
  fmt: (v: number) => string; deltaUnit: string; lowerIsBetter: boolean; liveFrom: string; active: boolean; warn?: string;
}>();
defineEmits<{ select: [] }>();

const RSEC: Record<string, number> = { "24H": 86400, "7D": 604800, "30D": 2592000, "90D": 7776000 };
const range = computed(() => (props.pick && props.ranges.includes(props.pick) && props.pick !== props.ranges[0] ? props.pick : null));
const fetched = ref<{ t: number[]; v: (number | null)[] } | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
async function load() {
  const r = range.value;
  if (!r) { fetched.value = null; return; }
  try { fetched.value = await (await fetch(`/svc-api/history?metric=${props.metric}&range=${r.toLowerCase()}`)).json(); } catch { /* keep the last one */ }
}
watch(range, () => { load(); if (timer) clearInterval(timer); timer = range.value ? setInterval(load, 60_000) : null; }, { immediate: true });
onUnmounted(() => { if (timer) clearInterval(timer); });

const pts = computed(() => {
  const T = fetched.value?.t ?? props.t, V = fetched.value?.v ?? props.v;
  const raw = T.map((t, i) => ({ t, v: V[i] })).filter((p): p is { t: number; v: number } => p.v != null);
  if (raw.length <= 32) return raw;
  const per = raw.length / 32, out: { t: number; v: number }[] = [];
  for (let b = 0; b < 32; b++) { const g = raw.slice(Math.floor(b * per), Math.floor((b + 1) * per)); if (g.length) out.push({ t: g[g.length - 1].t, v: g.reduce((s, x) => s + x.v, 0) / g.length }); }
  return out;
});
const spark = computed(() => {
  const p = pts.value; if (p.length < 2) return null;
  const vs = p.map((x) => x.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const t0 = p[0].t, t1 = p[p.length - 1].t || t0 + 1;
  const line = "M" + p.map((x) => `${(((x.t - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${(34 - ((x.v - lo) / span) * 28).toFixed(2)}`).join("L");
  return { line, area: `${line}L100,40L0,40Z` };
});
// delta: the current value against the first point of the shown range
const delta = computed(() => {
  const now = parseFloat(props.value), first = pts.value[0]?.v;
  if (!Number.isFinite(now) || first == null) return null;
  const d = now - first, step = parseFloat(props.fmt(Math.abs(d)));
  if (!step) return { text: "steady", good: true };
  return { text: `${d > 0 ? "+" : "−"}${props.fmt(Math.abs(d))}${props.deltaUnit}`, good: props.lowerIsBetter ? d < 0 : d > 0 };
});
const VS: Record<string, string> = { "24H": "vs yesterday", "7D": "vs last week", "30D": "vs last month" };
const since = computed(() => {
  // the live data already spans the picked range (speed tests keep 7 days live): say it the same way as the others
  if (!range.value) return props.pick && props.pick === props.ranges[0] && VS[props.pick] ? VS[props.pick] : props.liveFrom;
  const t0 = fetched.value?.t?.[0]; if (!t0) return "no data yet";
  const have = Date.now() / 1000 - t0, want = RSEC[range.value] ?? 0;
  if (have < want * 0.9) return `since ${new Date(t0 * 1000).toLocaleDateString("en-GB", { weekday: "short" })}`;
  return VS[range.value] ?? `vs ${range.value.toLowerCase()} ago`;
});
const gid = "sc" + Math.random().toString(36).slice(2, 8);
</script>

<template>
  <button type="button" class="stat" :class="['t-' + tone, { on: active }]" :aria-pressed="active" :aria-label="`${label} ${value} ${unit}. Show in the chart`" @click="$emit('select')">
    <span class="stat-top">
      <span class="stat-ic" :class="'lv-' + level" :title="warn || undefined"><Icon :name="icon" :size="15" /></span>
      <span class="stat-go" aria-hidden="true"><Icon name="arrow-up-right" :size="14" /></span>
    </span>
    <span class="stat-l">{{ label }}<i v-if="level !== 'g'" class="stat-w" :class="'lv-' + level" :title="warn">{{ warn }}</i></span>
    <span class="stat-row">
      <span class="stat-n"><b>{{ value }}</b><small>{{ unit }}</small></span>
      <svg v-if="spark" class="stat-sp" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient :id="gid" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28" /><stop offset="1" stop-color="currentColor" stop-opacity="0" /></linearGradient></defs>
        <path :d="spark.area" :fill="`url(#${gid})`" />
        <path :d="spark.line" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    </span>
    <span class="stat-d"><i v-if="delta" :class="delta.good ? 'up' : 'dn'">{{ delta.text }}</i><small>{{ since }}</small></span>
  </button>
</template>
