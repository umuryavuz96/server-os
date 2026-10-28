<script setup lang="ts">
import { ref, computed, watch } from "vue";
const props = defineProps<{ name: string; icon: string }>();
const failed = ref(false);
const PAL = ["#2563eb", "#0f8a6a", "#c2410c", "#7c3aed", "#be185d", "#0e7490", "#4d7c0f", "#b45309", "#475569"];
const hue = computed(() => PAL[[...props.name].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length]);
const kind = computed(() => (failed.value || !props.icon ? "letter" : props.icon.startsWith("/icons/brand/") ? "brand" : "own"));

// A dark logo on a transparent background vanishes on the dark UI: sample it once and give those a light tile.
const dark = ref(false);
watch(() => props.icon, (u) => { failed.value = false; dark.value = DARK.get(u) ?? false; });
function measure() {
  const url = props.icon;
  if (DARK.has(url)) { dark.value = DARK.get(url)!; return; }
  // A second, CORS copy for reading pixels, so the shown logo never depends on the host sending CORS headers.
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onerror = () => DARK.set(url, false);
  img.onload = () => read(img, url);
  img.src = url;
}
function read(img: HTMLImageElement, url: string) {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let n = 0, clear = 0, lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) { clear++; continue; }
      n++; lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    }
    // Mostly transparent around the mark (not a full-bleed square) and the mark itself is dark.
    const isDark = n > 0 && clear / (n + clear) > 0.12 && lum / n < 0.3;
    DARK.set(url, isDark);
    if (props.icon === url) dark.value = isDark;
  } catch { DARK.set(url, false); } // cross-origin without CORS: can't read pixels, leave it as it is
}
</script>

<script lang="ts">
const DARK = new Map<string, boolean>();
</script>

<template>
  <div class="ico" :class="[kind === 'letter' ? '' : kind, { lift: dark }]" :style="kind === 'letter' ? { background: hue } : undefined">
    <img v-if="kind !== 'letter'" :src="icon" alt="" @load="measure" @error="failed = true" />
    <template v-else>{{ name[0] }}</template>
  </div>
</template>
