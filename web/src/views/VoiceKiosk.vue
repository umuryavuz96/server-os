<script setup lang="ts">
// The voice chat as a TV screen (#voice-chat?kiosk=1), loaded full screen by a TV's WebView: no panel navigation, D-pad
// only (VoiceChat's kiosk mode does the keys). The kiosk is laid out on a true 1920×1080 canvas: the page is zoomed by
// innerWidth / 1920, so a WebView that reports 960×540 CSS px at devicePixelRatio 2 (Salon TV) draws one canvas px per
// screen pixel (sharp text and hairlines), and a 1920 px browser shows it 1:1. Kiosk styles are in those px.
import { ref, onMounted } from "vue";
import { api } from "../store";
import VoiceChat, { type ChatInfo } from "../components/voice/VoiceChat.vue";

const info = ref<ChatInfo | null>(null), err = ref<string | null>(null);
// Zoom the whole document (dialogs are teleported to <body>, so zooming only this view would miss them). Viewport units
// are zoomed too, so kiosk styles use % and insets, never vh/vw.
const fit = () => { document.documentElement.style.setProperty("zoom", String(Math.min(2, Math.max(0.25, innerWidth / 1920)))); };
onMounted(() => { fit(); addEventListener("resize", fit); });
onMounted(async () => { try { info.value = await api<ChatInfo>("/voice/chat"); } catch (e) { err.value = (e as Error).message; } });
</script>

<template>
  <main class="vk">
    <VoiceChat v-if="info" :info="info" kiosk />
    <p v-else class="vk-msg">{{ err ?? "Connecting…" }}</p>
  </main>
</template>

<style scoped>
.vk{position:fixed;inset:0;background:var(--bg)}
.vk-msg{display:grid;place-items:center;height:100%;margin:0;font:500 30px var(--body);color:var(--muted)}
</style>
