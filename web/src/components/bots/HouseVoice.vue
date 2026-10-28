<script setup lang="ts">
// The desk speaker (/api/v1/house-voice): the wake-word listener that talks to Lahmacun's voice session.
// On/off, what it is doing right now, the last thing it heard, the language you speak and its volume. Its voice is
// picked in VoicePicker, below it on the Voice page.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";
import Icon from "../Icon.vue";

type HV = { available: boolean; voice: string; enabled: boolean; running: boolean; state: string; detail: string | null; heard: string | null; reply: string | null; volume: number; followUp: number; language?: string };
const hv = ref<HV | null>(null), busy = ref(false), vol = ref(10);
let poll: ReturnType<typeof setInterval> | null = null;

async function load() {
  try { hv.value = await api<HV>("/house-voice"); if (!busy.value) vol.value = Math.round((hv.value.volume ?? 0.1) * 100); } catch { /* keep the last state */ }
}
async function set(patch: Partial<HV>) {
  busy.value = true;
  try { hv.value = await api<HV>("/house-voice", { method: "PATCH", body: patch }); } catch (e) { toast((e as Error).message); }
  busy.value = false;
}
onMounted(() => { void load(); poll = setInterval(load, 2000); });
onUnmounted(() => { if (poll) clearInterval(poll); });

const LABEL: Record<string, string> = { idle: "Say “Hey Jarvis” to talk", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", starting: "Starting…", offline: "Speaker not connected", off: "Off" };
const line = computed(() => (hv.value ? hv.value.detail && hv.value.state === "offline" ? hv.value.detail : LABEL[hv.value.state] ?? hv.value.state : ""));
const dot = computed(() => (!hv.value?.enabled ? "" : hv.value.state === "offline" ? "warn" : ["listening", "thinking", "speaking"].includes(hv.value.state) ? "work" : "on"));
</script>

<template>
  <section v-if="hv?.available" class="hv card" aria-label="Desk speaker">
    <div class="hv-top">
      <span class="hv-ico"><Icon name="volume" /></span>
      <span class="hv-t"><b>Desk speaker</b><small :class="dot"><i class="dot" :class="dot"></i>{{ line }}</small></span>
      <button type="button" class="sw sm" role="switch" :aria-checked="hv.enabled" :disabled="busy" aria-label="Desk speaker on or off" @click="set({ enabled: !hv.enabled })"></button>
    </div>
    <p v-if="hv.enabled && hv.heard" class="hv-last"><span>Heard</span>{{ hv.heard }}</p>
    <div class="hv-grid">
      <label class="hv-f">
        <span>You speak</span>
        <select :value="hv.language ?? ''" :disabled="busy" aria-label="Language you speak" @change="set({ language: ($event.target as HTMLSelectElement).value })">
          <option value="">Same as the voice</option>
          <option value="en">English</option>
          <option value="tr">Türkçe</option>
          <option value="auto">Auto-detect</option>
        </select>
      </label>
      <label class="hv-f">
        <span>Volume · <b>{{ vol }}%</b></span>
        <input v-model.number="vol" type="range" min="0" max="100" step="5" aria-label="Volume" :disabled="!hv.enabled" @change="set({ volume: vol / 100 })" />
      </label>
    </div>
  </section>
</template>

<style scoped>
.hv{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:16px;margin:0}
.hv-top{display:flex;align-items:center;gap:12px}
.hv-ico{flex:none;width:36px;height:36px;border-radius:10px;background:#151518;border:1px solid var(--line);display:grid;place-items:center;color:#c7c7cc}
.hv-t{flex:1;min-width:0;display:flex;flex-direction:column}
.hv-t b{font:600 14px var(--body)}
.hv-t small{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hv-t small.on{color:var(--on)}
.hv-t small.work{color:#d97757}
.hv-t small.warn{color:var(--warn)}
.hv-last{margin:0;font-size:12.5px;color:#c7c7cc;line-height:1.35;padding:8px 10px;border-radius:10px;background:var(--panel-2);border:1px solid #1a1a1e;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hv-last span{color:var(--muted);margin-right:6px;font-weight:600}
.hv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.hv-f{display:flex;flex-direction:column;gap:5px;min-width:0}
.hv-f>span{font:600 11.5px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.hv-f>span b{color:var(--ink);font:600 12px var(--mono);letter-spacing:0}
.hv-f select{min-width:0;min-height:38px;background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:0 8px;font:500 13px var(--body)}
.hv-f input{width:100%;min-width:0;margin:12px 0 0;accent-color:#d97757}
.hv-f input:disabled{opacity:.4}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:#4a4a52}
.dot.on{background:var(--on)}
.dot.work{background:#d97757;box-shadow:0 0 0 3px rgba(217,119,87,.18)}
.dot.warn{background:var(--warn)}
</style>
