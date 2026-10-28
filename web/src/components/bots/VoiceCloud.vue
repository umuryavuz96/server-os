<script setup lang="ts">
// Cloud voices (/api/v1/voice/cloud): one switch, and the account's live usage (credits used / limit, reset, minutes left).
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";

type Usage = { state: "ok"; used: number; limit: number; percent: number; resetsAt: number | null; tier: string; status: string | null; minutesLeft: number }
  | { state: "no-key" | "needs-permission" | "error"; message: string };
const d = ref<{ enabled: boolean; usage: Usage } | null>(null), busy = ref(false);
let poll: ReturnType<typeof setInterval> | null = null;

async function load() { try { d.value = await api("/voice/cloud"); } catch { /* keep the last numbers */ } }
async function toggle() {
  if (!d.value) return;
  busy.value = true;
  try { d.value = await api("/voice/cloud", { method: "PATCH", body: { enabled: !d.value.enabled } }); } catch (e) { toast((e as Error).message); }
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
      <span class="vc-t"><b>Cloud voices</b><small>{{ d.enabled ? "ElevenLabs voices speak from the cloud" : "Off: cloud voices are spoken by a local voice" }}</small></span>
      <button type="button" class="sw sm" role="switch" :aria-checked="d.enabled" :disabled="busy" aria-label="Use cloud voices" @click="toggle"></button>
    </div>
    <template v-if="ok">
      <div class="vc-n"><b>{{ n(ok.used) }}</b><span>of {{ n(ok.limit) }} credits used</span><em>{{ ok.percent }}%</em></div>
      <div class="bar" role="progressbar" :aria-valuenow="ok.percent" aria-valuemin="0" aria-valuemax="100"><i :class="level" :style="{ width: ok.percent + '%' }"></i></div>
      <p class="vc-m">About <b>{{ n(ok.minutesLeft) }} minutes</b> of speech left.</p>
      <div class="kv"><span>Resets</span><b>{{ resets }}</b></div>
      <div class="kv"><span>Plan</span><b>{{ ok.tier || "–" }}{{ ok.status && ok.status !== "active" ? " · " + ok.status : "" }}</b></div>
    </template>
    <p v-else-if="bad" class="vc-w" :class="bad.state">{{ bad.state === "needs-permission" ? "Usage is hidden: the ElevenLabs key needs the “User: read” permission." : bad.message }}</p>
  </section>
</template>

<style scoped>
.vc{display:flex;flex-direction:column;gap:6px;margin:10px 0 0;box-sizing:border-box}
.vc-top{display:flex;align-items:center;gap:10px}
.vc-t{flex:1;min-width:0;display:flex;flex-direction:column}
.vc-t b{font:600 13.5px var(--body)}
.vc-t small{font-size:12px;color:var(--muted)}
.vc-n{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-top:4px}
.vc-n b{font:600 22px var(--mono);font-variant-numeric:tabular-nums}
.vc-n span{font-size:12.5px;color:var(--muted)}
.vc-n em{margin-left:auto;font:600 13px var(--mono);font-style:normal;color:var(--ink)}
.vc .bar{margin-top:0}
.vc-m{margin:4px 0 2px;font-size:13px;color:var(--muted)}
.vc-m b{color:var(--ink)}
.vc-w{margin:0;font-size:12.5px;color:var(--warn);background:var(--warn-bg);border-radius:8px;padding:8px 10px}
.vc-w.error,.vc-w.no-key{color:var(--muted);background:var(--panel-2)}
</style>
