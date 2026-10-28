<script setup lang="ts">
// Selected app: details + rocker switch. Every on/off goes through ConfirmDialog (red for stopping core services).
import { ref, computed, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ReadyCard, { type Ready } from "./ReadyCard.vue";
import { S, api, totalMem, uptimeFor, mb, post, toast, type AppState } from "../store";

const props = defineProps<{ app: AppState }>();
// Apps Server OS installed carry a ready card (login + what's left); matched by name.
const installed = ref<{ id: string; name: string; href: string; ready?: Ready }[]>([]);
const loadInstalled = async () => { try { installed.value = (await api<{ apps: typeof installed.value }>("/apps/installed")).apps; } catch { /* optional */ } };
const opsKey = () => ((S as unknown as { operations?: { status: string }[] }).operations ?? []).map((o) => o.status).join();
watch(() => [props.app.name, opsKey()], loadInstalled, { immediate: true });
const mine = computed(() => installed.value.find((a) => a.name === props.app.name) ?? null);
const confirming = ref(false);
const busy = ref(false);
watch(() => props.app.name, () => { confirming.value = false; });

const lock = computed(() => props.app.kind === "lock");
const isOn = computed(() => lock.value || props.app.state !== "off");
const pill = computed<[string, string]>(() => {
  if (lock.value) return ["p-lock", "CORE · LOCKED"];
  if (props.app.kind === "gate" && props.app.state === "on") return ["p-on", "ONLINE"];
  return ({ on: ["p-on", "RUNNING"], off: ["p-off", "STOPPED"], part: ["p-part", "PARTLY ON"] } as Record<string, [string, string]>)[props.app.state];
});
const share = computed(() => (props.app.mem > 0 && totalMem.value ? Math.round((props.app.mem / totalMem.value) * 100) : 0));
const up = computed(() => uptimeFor(props.app.name));
const upTxt = computed(() => (up.value && up.value.pct != null ? (up.value.up ? (up.value.pct >= 99.95 ? "100" : up.value.pct.toFixed(1)) + "%" : "down") : "–"));

// What the switch will actually do, in plain words, for the dialog.
const steps = computed(() => {
  const a = props.app, off = isOn.value, out: string[] = [];
  const parts = Object.keys(a.parts);
  const ctr = parts.filter((p) => p.startsWith("docker:")).map((p) => p.slice(7));
  const ld = parts.filter((p) => p.startsWith("launchd:")).map((p) => p.slice(8));
  if (ctr.length) out.push(`${off ? "Stops" : "Starts"} ${ctr.length === 1 ? "container" : ctr.length + " containers"}: ${ctr.join(", ")}`);
  if (ld.length) out.push(`${off ? "Unloads" : "Loads"} background service${ld.length > 1 ? "s" : ""}: ${ld.join(", ")}`);
  if (parts.some((p) => p.startsWith("vm:"))) out.push(off ? "Shuts down the virtual machine" : "Boots the virtual machine (takes a minute)");
  if (a.kind === "gate") out.push(off ? "Visitors see a “switched off” page instead of the site" : "The site is served again");
  if (off && a.mem > 0) out.push(`Frees about ${mb(a.mem)} of RAM`);
  out.push(off ? "Stays off after a reboot — nothing is deleted" : "Starts again automatically after a reboot");
  return out;
});

async function apply() {
  const name = props.app.name, on = !isOn.value;
  confirming.value = false; busy.value = true;
  try {
    const r = await post<{ ok: boolean; detail: string | string[] }>("/svc-api/toggle", { name, on });
    toast(r.ok ? `${name} ${on ? "started" : "stopped"}` : `Couldn't change ${name}: ${r.detail}`);
  } catch { toast(`Couldn't reach the server to change ${name}`); }
  busy.value = false; // the new state arrives over the live stream
}
</script>

<template>
  <div class="dpanel" aria-label="Selected app">
    <Transition name="pane" mode="out-in">
      <div :key="app.name" style="display: flex; flex-direction: column; gap: 12px">
        <div class="dh">
          <AppIcon :name="app.name" :icon="app.icon" />
          <div style="min-width: 0">
            <div class="dn">{{ app.name }}</div>
            <div class="dg">{{ app.group }} · <span class="pill" :class="pill[0]">{{ pill[1] }}</span></div>
          </div>
        </div>
        <p style="margin: 0; color: var(--muted)">{{ app.about }}</p>
        <ReadyCard v-if="mine" :app-id="mine.id" :href="mine.href" :ready="mine.ready" :can-setup="true" />
        <div v-if="lock" class="dbox" style="font-size: 13.5px; color: var(--muted)">Locked: turning this off would cut every device (and this page) off DNS or the VPN.</div>
        <div v-else class="dstate">
          <div>
            <div style="font-weight: 700">{{ isOn ? (app.state === "part" ? "Partly running" : "Running") : "Switched off" }}</div>
            <div style="color: var(--muted); font-size: 12.5px">{{ isOn ? "Stays on after a reboot" : "Stays off after a reboot · nothing deleted" }}</div>
          </div>
          <button type="button" class="rk" :class="{ busy }" role="switch" :aria-checked="isOn" :aria-label="`${isOn ? 'Stop' : 'Start'} ${app.name}`"
            :disabled="busy" @click="confirming = true"><i></i></button>
        </div>
        <div class="dgrid">
          <div class="dbox"><small>RAM</small><b>{{ app.mem > 0 ? mb(app.mem) : app.kind === "gate" ? "static" : "0 MB" }}</b></div>
          <div class="dbox"><small>Uptime 24 h</small><b>{{ upTxt }}</b></div>
        </div>
        <div v-if="share">
          <div style="display: flex; justify-content: space-between; color: var(--muted); font-size: 12.5px"><span>Share of app RAM</span><span>{{ share }}%</span></div>
          <div class="bar"><i :style="{ width: Math.max(share, 2) + '%', background: 'var(--ink)' }"></i></div>
        </div>
        <div v-if="Object.keys(app.parts).length" class="parts">
          <span v-for="(v, k) in app.parts" :key="k"><span class="led" :class="{ on: v }"></span>{{ k }}</span>
        </div>
        <a v-if="app.href" class="dopen" :href="app.href" target="_blank" rel="noopener">Open {{ app.name }} ↗</a>
      </div>
    </Transition>

    <ConfirmDialog :open="confirming" :title="`${isOn ? 'Stop' : 'Start'} ${app.name}?`" :subtitle="app.group"
      :confirm-label="isOn ? 'Stop' : 'Start'" :danger="isOn" @confirm="apply" @cancel="confirming = false">
      <template #icon><AppIcon :name="app.name" :icon="app.icon" /></template>
      <div v-if="isOn && app.warn" class="warnbox">Core service. {{ app.about }}</div>
      <ul>
        <li v-for="s in steps" :key="s">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>{{ s }}
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
