<script setup lang="ts">
// "Connect a device": a one-time code, as a QR code the iPhone/iPad app scans (serverdash://pair?url=…&code=…)
// and as six digits to type into another browser or the app. Works once, for 5 minutes.
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import QRCode from "qrcode";
import { api } from "../store";

const emit = defineEmits<{ close: [] }>();
const code = ref(""), expires = ref(0), err = ref(""), now = ref(Date.now()), qr = ref("");
let t: ReturnType<typeof setInterval>;
async function fresh() {
  err.value = "";
  try { const r = await api<{ code: string; expires: number }>("/pair/start", { method: "POST", body: {} }); code.value = r.code; expires.value = r.expires; }
  catch (e) { err.value = (e as Error).message; }
}
// The app pairs with the address this page is open at.
const link = computed(() => (code.value ? `serverdash://pair?url=${encodeURIComponent(location.origin)}&code=${code.value}` : ""));
watch(link, async (l) => { qr.value = l ? await QRCode.toString(l, { type: "svg", margin: 1, color: { dark: "#f2f2f2", light: "#00000000" } }) : ""; });
// Where the panel answers (Caddy names, the tailnet name, the LAN address) — for opening it on another device.
const addresses = ref<string[]>([]);
onMounted(() => {
  void fresh(); t = setInterval(() => (now.value = Date.now()), 1000);
  api<{ addresses?: string[] }>("/info").then((i) => (addresses.value = i.addresses ?? [])).catch(() => {});
});
onUnmounted(() => clearInterval(t));
const left = computed(() => Math.max(0, Math.round((expires.value - now.value) / 1000)));
const shown = computed(() => (code.value ? `${code.value.slice(0, 3)} ${code.value.slice(3)}` : "··· ···"));
</script>

<template>
  <Teleport to="body">
    <div class="dlg-wrap">
      <div class="dlg-bg" @click="emit('close')"></div>
      <div class="dlg" role="dialog" aria-modal="true" aria-label="Connect a device">
        <h2>Connect a device</h2>
        <p class="muted" style="margin: 0">Scan with the Server OS app on your iPhone or iPad — or type the code on the new device.</p>
        <!-- eslint-disable-next-line vue/no-v-html — SVG generated locally from our own link -->
        <div class="pair-qr" :class="{ dead: left === 0 }" v-html="qr" aria-label="QR code for the Server OS app"></div>
        <div class="pair-code num" :class="{ dead: left === 0 }">{{ shown }}</div>
        <p v-if="err" class="form-err">{{ err }}</p>
        <p v-else class="hint" style="text-align: center">{{ left > 0 ? `Works once · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "Expired — make a new one" }}</p>
        <div v-if="addresses.length" class="addr">
          <div class="logsrc">Open the panel on another device</div>
          <a v-for="a in addresses" :key="a" :href="a" target="_blank" rel="noopener" class="addr-a">{{ a.replace(/^https?:\/\//, "") }} ↗</a>
          <p class="hint">On your home Wi-Fi any of these works; the .ts.net one works anywhere on your tailnet.</p>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end">
          <button type="button" class="btn" @click="fresh">New code</button>
          <button type="button" class="btn primary" @click="emit('close')">Done</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
