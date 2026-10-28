<script setup lang="ts">
// System → Mac screen / Server screen: open this machine's screen in the browser (Screen Sharing on a Mac, a VNC server on Linux).
import { onMounted, ref } from "vue";
import { api } from "../store";
import { openScreen, sess } from "../screen/session";

interface Status { enabled: boolean; listening: boolean; platform?: string; noun?: string; port?: number; idleMinutes?: number; maxMinutes?: number; active: { since: number } | null }
const st = ref<Status | null>(null);  // the window itself lives in App.vue (RemoteScreen.vue)
const load = async () => { try { st.value = await api<Status>("/screen"); } catch { st.value = null; } };
onMounted(load);
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>{{ st?.noun ?? "Mac screen" }}</h1>
      <button type="button" class="btn" @click="load">Refresh</button>
    </header>
    <p v-if="st && st.platform !== 'darwin'" class="hint">See and control this server's desktop from the browser, through a VNC server running on it (x11vnc, wayvnc, TigerVNC, krfb). Server OS connects to it on 127.0.0.1 only and passes the stream along; you sign in with that VNC server's password.</p>
    <p v-else class="hint">See and control this Mac's screen from the browser, through macOS Screen Sharing. Use it for the clicks macOS only accepts from a person at the Mac, such as a privacy switch in System Settings. You sign in with a user account of the Mac; Server OS only passes the encrypted stream along.</p>
    <div class="card2 scr">
      <div class="scr-h">
        <h2>{{ st && st.platform !== "darwin" ? "VNC server" : "Screen Sharing" }}</h2>
        <span v-if="st" class="pill" :class="st.enabled && st.listening ? 'st-ok' : 'st-warn'">{{ !st.enabled ? "Off in config" : st.listening ? (st.active ? "In use" : "Ready") : (st.platform === "darwin" ? "Not running on the Mac" : "No VNC server running") }}</span>
      </div>
      <p v-if="st?.enabled" class="muted">One viewer at a time. A session closes after {{ st.idleMinutes }} minutes without input and after {{ st.maxMinutes }} minutes in any case. Every open and close is in the audit log.</p>
      <div><button type="button" class="btn primary" @click="openScreen({ onClose: load })">{{ sess.started ? "Bring back" : "Open" }} {{ (st?.noun ?? "Mac screen").toLowerCase() }}</button></div>
    </div>
  </main>
</template>

<style scoped>
.scr{gap:10px}
.scr-h{display:flex;align-items:center;gap:8px}
.scr-h h2{margin:0 auto 0 0;font:700 16px var(--body);text-transform:none;letter-spacing:0}
.scr p{margin:0}
.st-ok{color:var(--on);background:var(--on-bg)}
.st-warn{color:var(--warn);background:var(--warn-bg)}
</style>
