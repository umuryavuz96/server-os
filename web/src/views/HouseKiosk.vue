<script setup lang="ts">
// The House page as a TV screen (#house?kiosk=1), loaded full screen by a TV's WebView (Salon TV opens it in a frame):
// no panel navigation, D-pad only (HouseView's kiosk mode does the keys, the lamp ring and the frame-rate fallback).
// Laid out on a 960×540 canvas: the document is zoomed by innerWidth / 960. Salon TV's WebView is 960×540 CSS px (zoom 1),
// but its frame is 1920 px wide inside a page zoomed to half (zoom 2). Either way the 3D canvas keeps 960 CSS px, so the
// overlay text stays the same size; HouseView draws it at the panel's real pixels (1920×1080 on the TV, stepping down when
// the GPU can't keep up). Not embedded, Back goes back.
import { onMounted, onUnmounted } from "vue";
import HouseView from "./HouseView.vue";

const fit = () => { document.documentElement.style.setProperty("zoom", String(Math.min(4, Math.max(0.25, innerWidth / 960)))); };
fit();
onMounted(() => addEventListener("resize", fit));
onUnmounted(() => removeEventListener("resize", fit));
function exit() { if (history.length > 1) history.back(); else { history.replaceState(null, "", "/#house"); location.reload(); } }
</script>

<template>
  <HouseView kiosk @exit="exit" />
</template>
