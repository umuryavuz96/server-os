<script setup lang="ts">
// "Needs your OK": permission asks a bot's Claude Code session is waiting on (relayed by its PermissionRequest hook).
// Answering here lets the session carry on; if it was already answered in the terminal the ask just disappears.
import { ref } from "vue";
import { api, toast } from "../../store";
import type { Approval } from "../../bots";

const props = defineProps<{ channel: string; items: Approval[] }>();
const busy = ref("");
const open = ref<string | null>(null);
async function decide(a: Approval, behavior: "allow" | "deny", always = false) {
  busy.value = a.id + behavior + always;
  try { await api(`/bots/${encodeURIComponent(props.channel)}/approvals/${encodeURIComponent(a.id)}/decide`, { body: { behavior, always } }); toast(behavior === "deny" ? "Denied" : always ? "Allowed, and remembered" : "Allowed"); }
  catch (e) { toast((e as Error).message); }
  busy.value = "";
}
const detail = (a: Approval) => Object.entries(a.input).map(([k, v]) => `${k}: ${v}`).join("\n");
</script>

<template>
  <section v-if="items.length" class="apv" aria-live="polite">
    <div v-for="a in items" :key="a.id" class="apv-c">
      <div class="apv-h"><span class="apv-k">NEEDS YOUR OK</span><b>{{ a.tool }}</b></div>
      <code class="apv-s">{{ a.summary || "(no details)" }}</code>
      <button type="button" class="apv-m" :aria-expanded="open === a.id" @click="open = open === a.id ? null : a.id">{{ open === a.id ? "Hide details" : "Full details" }}</button>
      <pre v-if="open === a.id" class="apv-d">{{ detail(a) }}</pre>
      <div class="apv-a">
        <button type="button" class="btn apv-go" :disabled="!!busy" @click="decide(a, 'allow')">Allow</button>
        <button v-if="a.canAlways" type="button" class="btn" :disabled="!!busy" @click="decide(a, 'allow', true)">Always allow</button>
        <button type="button" class="btn danger" :disabled="!!busy" @click="decide(a, 'deny')">Deny</button>
      </div>
    </div>
    <p class="bi-h">The session is waiting. Not answering here leaves the question in its terminal.</p>
  </section>
</template>
