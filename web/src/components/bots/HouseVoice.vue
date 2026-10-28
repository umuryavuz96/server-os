<script setup lang="ts">
// The desk speaker (/api/v1/house-voice): the wake-word listener that talks to Lahmacun's voice session.
// On/off, what it is doing right now, the last exchange, and its volume.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";

type HV = { available: boolean; voice: string; enabled: boolean; running: boolean; state: string; detail: string | null; heard: string | null; reply: string | null; volume: number; followUp: number; language?: string };
const hv = ref<HV | null>(null), busy = ref(false), vol = ref(10);
type Vs = { voices: string[]; cloud: string[]; labels: Record<string, string>; cloudEnabled: boolean };
const vs = ref<Vs | null>(null);
// A readable name: the service's label (cloud voices), "Turkish · name" for tr-*, otherwise the id's name part.
const name = (id: string) => vs.value?.labels?.[id] ?? (id.startsWith("tr-") ? "Turkish · " + id.slice(3) : id.startsWith("chatterbox") ? "Chatterbox · natural" : id.replace(/^[a-z]{2}_/, "").replace(/^\w/, (c) => c.toUpperCase()) + (id.startsWith("b") ? " · British" : " · American"));
const cloud = computed(() => (vs.value?.voices ?? []).filter((v) => vs.value?.cloud.includes(v)));
const local = computed(() => (vs.value?.voices ?? []).filter((v) => !vs.value?.cloud.includes(v)));
let poll: ReturnType<typeof setInterval> | null = null;

async function load() {
  try { hv.value = await api<HV>("/house-voice"); if (!busy.value) vol.value = Math.round((hv.value.volume ?? 0.1) * 100); } catch { /* keep the last state */ }
}
async function set(patch: Partial<HV>) {
  busy.value = true;
  try { hv.value = await api<HV>("/house-voice", { method: "PATCH", body: patch }); } catch (e) { toast((e as Error).message); }
  busy.value = false;
}
onMounted(() => { void load(); void api<Vs>("/voice/voices").then((v) => (vs.value = v)).catch(() => {}); poll = setInterval(load, 2000); });
onUnmounted(() => { if (poll) clearInterval(poll); });

const LABEL: Record<string, string> = { idle: "Say “Hey Jarvis” to talk", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", starting: "Starting…", offline: "Speaker not connected", off: "Off" };
const line = computed(() => (hv.value ? hv.value.detail && hv.value.state === "offline" ? hv.value.detail : LABEL[hv.value.state] ?? hv.value.state : ""));
const dot = computed(() => (!hv.value?.enabled ? "" : hv.value.state === "offline" ? "warn" : ["listening", "thinking", "speaking"].includes(hv.value.state) ? "work" : "on"));
</script>

<template>
  <section v-if="hv?.available" class="hv" aria-label="House voice">
    <div class="hv-top">
      <span class="dot" :class="dot"></span>
      <span class="hv-t"><b>Desk speaker</b><small>{{ line }}</small></span>
      <button type="button" class="sw sm" role="switch" :aria-checked="hv.enabled" :disabled="busy" aria-label="House voice on or off" @click="set({ enabled: !hv.enabled })"></button>
    </div>
    <p v-if="hv.enabled && hv.heard" class="hv-last"><span>You</span>{{ hv.heard }}</p>
    <label v-if="vs" class="hv-vol hv-pick">
      <span>Voice</span>
      <select :value="hv.voice" :disabled="busy" aria-label="Voice" @change="set({ voice: ($event.target as HTMLSelectElement).value } as Partial<HV>)">
        <optgroup v-if="cloud.length" label="Cloud (ElevenLabs)">
          <option v-for="v in cloud" :key="v" :value="v" :disabled="!vs.cloudEnabled">{{ name(v) }}{{ vs.cloudEnabled ? "" : " (off)" }}</option>
        </optgroup>
        <optgroup label="Local (on this server)"><option v-for="v in local" :key="v" :value="v">{{ name(v) }}</option></optgroup>
      </select>
    </label>
    <label class="hv-vol hv-pick">
      <span>You speak</span>
      <select :value="hv.language ?? ''" :disabled="busy" aria-label="Language you speak" @change="set({ language: ($event.target as HTMLSelectElement).value })">
        <option value="">Same as the voice</option>
        <option value="en">English</option>
        <option value="tr">Türkçe</option>
        <option value="auto">Auto-detect</option>
      </select>
    </label>
    <label v-if="hv.enabled" class="hv-vol">
      <span>Volume</span>
      <input v-model.number="vol" type="range" min="0" max="100" step="5" aria-label="Volume" @change="set({ volume: vol / 100 })" />
      <b>{{ vol }}%</b>
    </label>
  </section>
</template>

<style scoped>
.hv{box-sizing:border-box;min-width:0;margin:10px 0 0;padding:10px;border:1px solid #1f1f23;border-radius:12px;background:#0d0d10;display:flex;flex-direction:column;gap:8px}
.hv-top{display:flex;align-items:center;gap:10px}
.hv-t{flex:1;min-width:0;display:flex;flex-direction:column}
.hv-t b{font:600 13.5px var(--body)}
.hv-t small{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hv-last{margin:0;font-size:12px;color:#c7c7cc;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hv-last span{color:var(--muted);margin-right:6px;font-weight:600}
.hv-vol{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.hv-pick select{flex:1 1 0;min-width:0;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:500 13px var(--body)}
.hv-vol input{flex:1 1 0;width:0;min-width:0;margin:0;accent-color:#d97757}
.hv-vol b{min-width:34px;text-align:right;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.dot{flex:none;width:9px;height:9px;border-radius:50%;background:#4a4a52}
.dot.on{background:var(--on)}
.dot.work{background:#d97757;box-shadow:0 0 0 4px rgba(217,119,87,.18)}
.dot.warn{background:#ffb340}
</style>
