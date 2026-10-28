<script setup lang="ts">
// A number that rolls from its old value to the new one (≈250 ms, ease-out) instead of jumping or fading.
// A new target mid-roll continues from where the roll is, so scrubbing follows the pointer smoothly.
import { ref, watch, onUnmounted } from "vue";

const props = withDefaults(defineProps<{ value: number | null | undefined; fmt?: (v: number) => string; duration?: number }>(), { duration: 250 });
const shown = ref<number | null>(props.value ?? null);
const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
let raf = 0;
watch(() => props.value, (to) => {
  cancelAnimationFrame(raf);
  if (to == null || shown.value == null || reduce || !Number.isFinite(to)) { shown.value = to ?? null; return; }
  const from = shown.value, start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / props.duration), e = 1 - Math.pow(1 - k, 3);
    shown.value = from + (to - from) * e;
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
});
onUnmounted(() => cancelAnimationFrame(raf));
</script>

<template><span class="anum">{{ shown == null ? "–" : (fmt ?? ((v: number) => String(Math.round(v))))(shown) }}</span></template>
