<script setup lang="ts">
// Insights-style bar chart: one bar per time bucket, bars over the threshold in the accent colour, hover/tap a bar to read it.
import { computed, ref } from "vue";

const props = defineProps<{ bars: { t: number; v: number | null; label?: string }[]; max: number; threshold?: number; fmt: (v: number) => string; label: string; xfmt?: (t: number) => string; ticks?: number[] }>();
const hover = ref<number | null>(null);
const H = 220;
const yTicks = computed(() => props.ticks ?? [0, props.max / 2, props.max]);
const xLabel = (t: number) => (props.xfmt ?? ((x: number) => new Date(x * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })))(t);
const every = computed(() => Math.max(1, Math.ceil(props.bars.length / 8)));
const hb = computed(() => (hover.value != null ? props.bars[hover.value] : null));
</script>

<template>
  <div class="bchart" role="img" :aria-label="label" @pointerleave="hover = null">
    <div class="by">
      <span v-for="t in [...yTicks].reverse()" :key="t">{{ fmt(t) }}</span>
    </div>
    <div class="bplot" :style="{ height: H + 'px' }">
      <div v-for="t in yTicks" :key="'g' + t" class="bgrid" :style="{ bottom: (t / max) * 100 + '%' }"></div>
      <div v-if="threshold != null" class="bthr" :style="{ bottom: (threshold / max) * 100 + '%' }"><span>limit {{ fmt(threshold) }}</span></div>
      <div class="bbars">
        <div v-for="(b, i) in bars" :key="b.t" class="bcol" @pointerenter="hover = i" @pointerdown="hover = i">
          <div class="bbg"></div>
          <div v-if="b.v != null" class="bbar" :class="{ hot: threshold != null && b.v >= threshold, on: hover === i }" :style="{ height: Math.max(1.5, Math.min(100, (b.v / max) * 100)) + '%' }"></div>
        </div>
      </div>
      <Transition name="view">
        <div v-if="hb" class="ttip btip" :style="{ left: ((hover! + 0.5) / bars.length) * 100 + '%' }">
          <div class="tw">{{ hb.label ?? xLabel(hb.t) }}</div>
          <b>{{ hb.v == null ? "no data" : fmt(hb.v) }}</b>
        </div>
      </Transition>
    </div>
    <div class="bx"><span v-for="(b, i) in bars" :key="'x' + b.t" :style="{ visibility: i % every === 0 ? 'visible' : 'hidden' }">{{ xLabel(b.t) }}</span></div>
  </div>
</template>
