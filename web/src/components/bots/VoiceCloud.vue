<script setup lang="ts">
// Cloud voices (/api/v1/voice/cloud): one switch, and the account's live usage as minutes of speech left, the credit
// bar, the reset date and the plan. Tells the page when the switch moves, so the picker can grey out the cloud voices.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";
import Icon from "../Icon.vue";

type Usage = { state: "ok"; used: number; limit: number; percent: number; resetsAt: number | null; tier: string; status: string | null; minutesLeft: number }
  | { state: "no-key" | "needs-permission" | "error"; message: string };
const emit = defineEmits<{ change: [enabled: boolean] }>();
const d = ref<{ enabled: boolean; usage: Usage } | null>(null), busy = ref(false);
let poll: ReturnType<typeof setInterval> | null = null;

async function load() { try { d.value = await api("/voice/cloud"); emit("change", d.value!.enabled); } catch { /* keep the last numbers */ } }
async function toggle() {
  if (!d.value) return;
  busy.value = true;
  try { d.value = await api("/voice/cloud", { method: "PATCH", body: { enabled: !d.value.enabled } }); emit("change", d.value!.enabled); } catch (e) { toast((e as Error).message); }
  busy.value = false;
}
onMounted(() => { void load(); poll = setInterval(load, 30000); });
onUnmounted(() => { if (poll) clearInterval(poll); });

const n = (v: number) => Math.round(v).toLocaleString();
const ok = computed(() => (d.value?.usage.state === "ok" ? (d.value.usage as Extract<Usage, { state: "ok" }>) : null));
const bad = computed(() => (d.value && d.value.usage.state !== "ok" ? (d.value.usage as Extract<Usage, { message: string }>) : null));
const resets = computed(() => (ok.value?.resetsAt ? new Date(ok.value.resetsAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–"));
const level = computed(() => ((ok.value?.percent ?? 0) >= 90 ? "b" : (ok.value?.percent ?? 0) >= 70 ? "w" : ""));
</script>

<template>
  <section v-if="d" class="vc card" aria-label="Cloud voices">
    <div class="vc-top">
      <span class="vc-ico"><Icon name="cloud" /></span>
      <span class="vc-t"><b>Cloud voices</b><small>{{ d.enabled ? "ElevenLabs voices speak from the cloud" : "Off: cloud voices are spoken by a local voice" }}</small></span>
      <button type="button" class="sw sm" role="switch" :aria-checked="d.enabled" :disabled="busy" aria-label="Use cloud voices" @click="toggle"></button>
    </div>
    <template v-if="ok">
      <div class="vc-n"><b>{{ n(ok.minutesLeft) }} min</b><span>of speech left · {{ n(ok.used) }} of {{ n(ok.limit) }} credits used</span></div>
      <div class="bar" role="progressbar" :aria-valuenow="ok.percent" aria-valuemin="0" aria-valuemax="100" aria-label="Credits used"><i :class="level" :style="{ width: ok.percent + '%' }"></i></div>
      <div class="vc-foot"><span>Resets {{ resets }}</span><span>Plan: {{ ok.tier || "–" }}{{ ok.status && ok.status !== "active" ? " · " + ok.status : "" }}</span></div>
    </template>
    <p v-else-if="bad" class="vc-w" :class="bad.state">{{ bad.state === "needs-permission" ? "Usage is hidden: the ElevenLabs key needs the “User: read” permission." : bad.message }}</p>
  </section>
</template>

<style scoped>
.vc{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:16px;margin:0}
.vc-top{display:flex;align-items:center;gap:12px}
.vc-ico{flex:none;width:36px;height:36px;border-radius:10px;background:#151518;border:1px solid var(--line);display:grid;place-items:center;color:#c7c7cc}
.vc-t{flex:1;min-width:0;display:flex;flex-direction:column}
.vc-t b{font:600 14px var(--body)}
.vc-t small{font-size:12px;color:var(--muted)}
.vc-n{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.vc-n b{font:600 24px var(--mono);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.vc-n span{font-size:12.5px;color:var(--muted)}
.vc .bar{margin-top:0}
.vc-foot{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
.vc-w{margin:0;font-size:12.5px;color:var(--warn);background:var(--warn-bg);border-radius:8px;padding:8px 10px}
.vc-w.error,.vc-w.no-key{color:var(--muted);background:var(--panel-2)}
</style>
