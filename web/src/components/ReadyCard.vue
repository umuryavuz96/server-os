<script setup lang="ts">
// "Ready to use" card of an installed app: the address, the login the agent made (password revealed on tap),
// what is left for a person to do, and the live agent run while setup is going.
import { ref, computed, watch } from "vue";
import { S, api, toast } from "../store";
import Checklist from "./discover/Checklist.vue";
import type { Check } from "./discover/types";

export interface Ready { url: string; username?: string; secret?: string; summary: string; steps: string[]; at: number }
interface Op { id: string; app: string; action: string; status: string; step: string; log: string; started: number; agent?: boolean; checklist?: Check[] }

const props = defineProps<{ appId: string; href?: string; ready?: Ready | null; canSetup?: boolean }>();
const password = ref<string | null>(null);
watch(() => props.appId, () => { password.value = null; });

// The running agent run wins over finished ones (operations are newest first).
const op = computed(() => { const all = ((S as unknown as { operations?: Op[] }).operations ?? []).filter((o) => o.app === props.appId && o.agent); return all.find((o) => o.status === "running") ?? all[0] ?? null; });
const running = computed(() => op.value?.status === "running");
// The agent's tool calls ("→ …") read as its steps; keep the last few.
const steps = computed(() => (op.value?.log ?? "").split("\n").filter((l) => l.startsWith("→ ")).slice(-6).map((l) => l.slice(2)));

async function reveal() {
  if (password.value) { password.value = null; return; }
  try { password.value = (await api<{ secrets: Record<string, string> }>(`/apps/${props.appId}/secrets`)).secrets[props.ready!.secret!] ?? null; }
  catch (e) { toast((e as Error).message); }
}
async function copy(text: string) { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Can't copy here"); } }
async function setup() {
  try { await api(`/apps/${props.appId}/setup`, { body: {} }); toast("The agent is setting it up…"); } catch (e) { toast((e as Error).message); }
}
</script>

<template>
  <div v-if="running" class="dbox rc">
    <div class="rc-h"><span class="led on pulse"></span><span class="rc-t">The agent is setting it up</span></div>
    <div class="muted" style="font-size: 13px">{{ op!.step }}</div>
    <Checklist v-if="op!.checklist?.length" :items="op!.checklist" />
    <ul v-else-if="steps.length" class="rc-steps mono"><li v-for="(s, i) in steps" :key="i">{{ s }}</li></ul>
  </div>
  <div v-else-if="ready" class="dbox rc">
    <div class="rc-h"><span class="led on"></span><span class="rc-t">Ready to use</span></div>
    <p style="margin: 0">{{ ready.summary }}</p>
    <a class="btn big primary" :href="ready.url" target="_blank" rel="noopener">Open {{ ready.url.replace(/^https?:\/\//, "") }} ↗</a>
    <div v-if="ready.username" class="rc-login">
      <small>User</small><span class="mono">{{ ready.username }}</span><button type="button" class="btn" @click="copy(ready.username)">Copy</button>
      <template v-if="ready.secret">
        <small>Password</small><span class="mono">{{ password ?? "••••••••••••" }}</span>
        <span style="display: flex; gap: 6px">
          <button type="button" class="btn" @click="reveal">{{ password ? "Hide" : "Show" }}</button>
          <button v-if="password" type="button" class="btn" @click="copy(password)">Copy</button>
        </span>
      </template>
    </div>
    <template v-if="ready.steps.length">
      <small class="muted">Left for you</small>
      <ol class="rc-todo"><li v-for="(s, i) in ready.steps" :key="i">{{ s }}</li></ol>
    </template>
  </div>
  <div v-else-if="op?.status === 'failed'" class="dbox rc">
    <div class="rc-h"><span class="led"></span><span class="rc-t">Setup didn&apos;t finish</span></div>
    <div class="muted" style="font-size: 13px">{{ op.step }}</div>
    <button v-if="canSetup" type="button" class="btn big" @click="setup">Try again</button>
  </div>
  <div v-else-if="canSetup" class="dbox rc">
    <div class="muted" style="font-size: 13px">Installed. It may still show a first-run wizard{{ href ? "" : " and has no address yet" }}.</div>
    <button type="button" class="btn big" @click="setup">Let the agent set it up</button>
  </div>
</template>

<style scoped>
.rc { display: flex; flex-direction: column; gap: 8px; font-size: 13.5px }
.rc-h { display: flex; align-items: center; gap: 8px }
.rc-t { font-weight: 700; font-size: 14.5px }
.rc-login { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; align-items: center }
.rc-login small { color: var(--muted) }
.rc-login .mono { overflow-wrap: anywhere }
.rc-steps { margin: 0; padding-left: 16px; font-size: 12px; color: var(--muted) }
.rc-todo { margin: 0; padding-left: 20px }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
.pulse { animation: rcp 1.2s ease-in-out infinite }
@keyframes rcp { 50% { opacity: .35 } }
</style>
