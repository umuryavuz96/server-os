<script setup lang="ts">
// Details of one background job or sub-agent, opened by tapping its card in the bot inspector.
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { api } from "../../store";
import { type BgJob, dur, clock } from "../../bots";

const props = defineProps<{ channel: string; job: BgJob; name: string; what?: string }>();
const emit = defineEmits<{ close: [] }>();
const TYPE: Record<string, string> = { monitor: "Monitor", shell: "Shell command", agent: "Sub-agent" };
const END: Record<string, string> = { "timed out": "Timed out", stopped: "Stopped", replaced: "Replaced" };
const day = (t: number) => `${new Date(t).toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(t)}`;
const rows = computed(() => {
  const j = props.job;
  const r: [string, string][] = [
    ["Type", TYPE[j.kind] ?? j.kind],
    ["Status", j.ended ? END[j.endReason ?? ""] ?? "Ended" : "Running"],
    ["Started", day(j.started)],
  ];
  if (j.ended) r.push(["Ended", day(j.ended)]);
  r.push(["Duration", dur((j.ended ?? Date.now()) - j.started)]);
  if (j.timeoutMs && !j.ended) r.push(["Stops after", dur(j.timeoutMs)]);
  r.push(["Events", String(j.events)]);
  if (j.lastEvent) r.push(["Last activity", `${j.lastEvent}${j.lastEventAt ? ` · ${day(j.lastEventAt)}` : ""}`]);
  if (j.rearms) r.push(["Re-armed", `${j.rearms}× in 24 h`]);
  return r;
});

// The sub-agent's own conversation: read-only tail from the server, refreshed every few seconds while it runs.
interface Entry { ts: number; role: "prompt" | "assistant" | "tool"; text: string }
const log = ref<Entry[]>([]), loaded = ref(false), box = ref<HTMLElement | null>(null);
async function load() {
  if (props.job.kind !== "agent") return;
  try {
    const stick = !box.value || box.value.scrollHeight - box.value.scrollTop - box.value.clientHeight < 40;
    log.value = await api<Entry[]>(`/bots/${encodeURIComponent(props.channel)}/jobs/${encodeURIComponent(props.job.id)}/log`);
    if (stick) { await nextTick(); box.value?.scrollTo({ top: box.value.scrollHeight }); }
  } catch { /* keep the last one */ }
  loaded.value = true;
}
let t: ReturnType<typeof setInterval>;
const esc = (e: KeyboardEvent) => e.key === "Escape" && emit("close");
onMounted(() => { addEventListener("keydown", esc); load(); t = setInterval(() => { if (!props.job.ended) load(); }, 4000); });
onUnmounted(() => { clearInterval(t); removeEventListener("keydown", esc); });
watch(() => props.job.ended, load);
</script>

<template>
  <Teleport to="body">
    <div class="dr-wrap top">
      <div class="dr-bg" @click="emit('close')"></div>
      <aside class="dr nj" role="dialog" aria-modal="true" :aria-label="name">
        <div class="dr-h"><span class="dr-title">{{ name }}<small>{{ TYPE[job.kind] ?? job.kind }} · {{ job.ended ? "finished" : "running" }}</small></span><button type="button" class="btn" aria-label="Close" @click="emit('close')">✕</button></div>
        <div class="dr-b">
          <p v-if="what" class="bj-w">{{ what }}</p>
          <dl class="jd">
            <template v-for="[k, v] in rows" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
          </dl>
          <div class="nj-f"><span>{{ job.kind === "agent" ? "Sub-agent type" : "Command" }}</span><code class="jd-c">{{ job.command }}</code></div>
          <div v-if="job.kind === 'agent'" class="nj-f"><span>Conversation</span>
            <div ref="box" class="jd-log">
              <p v-if="!log.length" class="bi-h">{{ loaded ? "No conversation found for this sub-agent." : "Loading…" }}</p>
              <div v-for="(e, i) in log" :key="i" class="jl" :class="e.role"><small>{{ e.role === "prompt" ? "Prompt" : e.role === "tool" ? "Tool" : "Agent" }} · {{ clock(e.ts) }}</small><span>{{ e.text }}</span></div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
