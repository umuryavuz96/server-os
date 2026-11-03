<script setup lang="ts">
// A ```chart block (web/src/chat/blocks.ts): bars or lines for up to four series, drawn as an inline SVG that scales to
// the bubble. Values go in the tooltip and, for bars, on top; nulls are gaps.
import { computed } from "vue";
import type { Chart } from "../../chat/blocks";

const p = defineProps<{ chart: Chart }>();
const W = 320, H = 150, PAD = { l: 34, r: 8, t: 14, b: 26 };
const COLORS = ["var(--vw-ac, #d97757)", "#2fd38a", "#7aa2ff", "#ffb21e"]; // the first follows the accent (the TV has its own)
const all = computed(() => p.chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
const max = computed(() => { const m = Math.max(0, ...all.value); if (!m) return 1; const e = 10 ** Math.floor(Math.log10(m)); return Math.ceil(m / e) * e; });
const min = computed(() => Math.min(0, ...all.value));
const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - min.value) / (max.value - min.value || 1));
const n = computed(() => p.chart.labels.length);
const band = computed(() => (W - PAD.l - PAD.r) / n.value);
const x = (i: number) => PAD.l + band.value * (i + 0.5);
const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));
const ticks = computed(() => [min.value, (min.value + max.value) / 2, max.value]);
const bw = computed(() => Math.min(28, (band.value * 0.7) / p.chart.series.length));
const line = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).reduce<string>((acc, pt, i) => acc + (pt ? `${i && vals[i - 1] !== null ? "L" : "M"}${pt}` : ""), "");
const showLabel = (i: number) => n.value <= 8 || i % Math.ceil(n.value / 8) === 0;
</script>

<template>
  <figure class="vc-chart">
    <figcaption v-if="chart.title || chart.unit || chart.series.length > 1">
      <b v-if="chart.title || chart.unit">{{ chart.title }}<span v-if="chart.unit" class="vc-chart-u">{{ chart.title ? " · " : "" }}{{ chart.unit }}</span></b>
      <span v-if="chart.series.length > 1" class="vc-chart-k"><span v-for="(s, i) in chart.series" :key="i"><i :style="{ background: COLORS[i] }"></i>{{ s.name }}</span></span>
    </figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="chart.title ?? 'Chart'">
      <g class="vc-chart-grid">
        <template v-for="t in ticks" :key="t"><line :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" /><text :x="PAD.l - 5" :y="y(t) + 3" text-anchor="end">{{ fmt(t) }}</text></template>
      </g>
      <template v-if="chart.type === 'bar'">
        <g v-for="(s, si) in chart.series" :key="si">
          <template v-for="(v, i) in s.values" :key="i">
            <rect v-if="v !== null" :x="x(i) - (bw * chart.series.length) / 2 + si * bw" :y="Math.min(y(v), y(0))" :width="bw - 2" :height="Math.max(1, Math.abs(y(0) - y(v)))" rx="3"   :style="{ fill: COLORS[si] }"><title>{{ chart.labels[i] }}: {{ v }}{{ chart.unit ? " " + chart.unit : "" }}</title></rect>
            <text v-if="v !== null && chart.series.length === 1 && n <= 12" class="vc-chart-v" :x="x(i)" :y="y(v) - 4" text-anchor="middle">{{ fmt(v) }}</text>
          </template>
        </g>
      </template>
      <template v-else>
        <g v-for="(s, si) in chart.series" :key="si">
          <path :d="line(s.values)" fill="none" :style="{ stroke: COLORS[si] }" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <template v-for="(v, i) in s.values" :key="i"><circle v-if="v !== null && n <= 24" :cx="x(i)" :cy="y(v)" r="2.6" :fill="COLORS[si]"><title>{{ chart.labels[i] }}: {{ v }}{{ chart.unit ? " " + chart.unit : "" }}</title></circle></template>
        </g>
      </template>
      <g class="vc-chart-x"><template v-for="(l, i) in chart.labels" :key="i"><text v-if="showLabel(i)" :x="x(i)" :y="H - 8" text-anchor="middle">{{ l }}</text></template></g>
    </svg>
  </figure>
</template>

<style scoped>
.vc-chart{position:relative;margin:4px 0;max-width:520px;padding:10px 12px 8px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
figcaption{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-bottom:4px}
figcaption b{font:600 13px var(--body)}
.vc-chart-k{display:flex;gap:10px;font-size:11.5px;color:var(--muted)}
.vc-chart-k span{display:inline-flex;align-items:center;gap:5px}
.vc-chart-k i{width:8px;height:8px;border-radius:2px}
svg{display:block;width:100%;height:auto;overflow:visible}
.vc-chart-grid line{stroke:#232327;stroke-width:1}
.vc-chart-grid text,.vc-chart-x text{fill:#7b7b83;font:500 9.5px var(--mono)}
.vc-chart-v{fill:#c7c7cc;font:600 9.5px var(--mono)}
.vc-chart-u{font:500 11.5px var(--mono);color:#7b7b83}
</style>
