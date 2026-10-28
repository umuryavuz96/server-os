<script setup lang="ts">
// Right-side drawer for one app: Details (switch, RAM, uptime) · Logs (Docker / launchd) · Events (lifecycle history).
import { ref, watch, onUnmounted, computed } from "vue";
import DetailPanel from "./DetailPanel.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import AppLogins from "./AppLogins.vue";
import { S, ago, api, toast, type AppState } from "../store";

const props = defineProps<{ app: AppState | null }>();
const emit = defineEmits<{ close: [] }>();
const tab = ref<"details" | "logs" | "events">("details");
interface LogResp { ok: boolean; sections?: { source: string; text: string }[]; events?: { t: number; kind: string; from: string; to: string; detail?: string }[]; error?: string }
const data = ref<LogResp | null>(null);
const loading = ref(false);
async function load() {
  if (!props.app) return;
  loading.value = true;
  try { data.value = await (await fetch(`/svc-api/logs?app=${encodeURIComponent(props.app.name)}`)).json(); } catch (e) { data.value = { ok: false, error: String(e) }; }
  loading.value = false;
}
watch(() => props.app?.name, (n) => { tab.value = "details"; data.value = null; if (n) addEventListener("keydown", onKey); else removeEventListener("keydown", onKey); });
watch(tab, (t) => { if (t !== "details" && !data.value) load(); });
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") emit("close"); };
onUnmounted(() => removeEventListener("keydown", onKey));
const life = computed(() => (props.app ? S.life?.[props.app.name] : null));
// Delete: the server says what will happen (and whether it can), the dialog shows it, the operation runs on the server.
interface DeletePlan { deletable: boolean; reason?: string; installed: boolean; canPurge: boolean; steps: string[] }
const plan = ref<DeletePlan | null>(null), asking = ref(false), purge = ref(false), deleting = ref(false);
async function askDelete() {
  if (!props.app) return;
  purge.value = false;
  try { plan.value = await api<DeletePlan>(`/apps/delete-plan?name=${encodeURIComponent(props.app.name)}`); asking.value = true; } catch (e) { toast((e as Error).message); }
}
async function doDelete() {
  if (!props.app) return;
  const name = props.app.name;
  asking.value = false; deleting.value = true;
  try { await api("/apps/delete", { body: { name, purge: purge.value } }); toast(`Deleting ${name}…`); emit("close"); }
  catch (e) { toast((e as Error).message); }
  deleting.value = false;
}
const evLabel = (e: { kind: string; from: string; to: string }) => (e.kind === "state" ? `${e.from} → ${e.to}` : e.to === "up" ? "health check OK again" : "health check failed");
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="app" class="dr-wrap">
        <div class="dr-bg" @click="emit('close')"></div>
        <aside class="dr" role="dialog" aria-modal="true" :aria-label="`${app.name} details`">
          <div class="dr-h">
            <div class="dr-tabs" role="tablist">
              <button v-for="t in (['details', 'logs', 'events'] as const)" :key="t" type="button" role="tab" :aria-selected="tab === t" @click="tab = t">{{ t[0].toUpperCase() + t.slice(1) }}</button>
            </div>
            <button type="button" class="btn" aria-label="Close" @click="emit('close')">✕</button>
          </div>
          <div class="dr-b">
            <template v-if="tab === 'details'">
              <DetailPanel :app="app" />
              <div v-if="life" class="dbox lifebox">
                <div class="kv2"><span>Checked via</span><b>{{ life.checkedVia === "http" ? `HTTP${life.code ? " " + life.code : ""}` : "process" }}</b></div>
                <div class="kv2"><span>Uptime 24 h / 7 d</span><b>{{ life.uptime24 ?? "–" }}% / {{ life.uptime7d ?? "–" }}%</b></div>
                <div class="kv2"><span>{{ app.state === "off" ? "Off since" : "Up since" }}</span><b>{{ life.since ? ago(life.since) : "—" }}</b></div>
                <div class="kv2"><span>Restarts / recoveries 7 d</span><b>{{ life.restarts7d }}</b></div>
              </div>
              <AppLogins :app="app.name" />
              <button v-if="app.kind !== 'lock'" type="button" class="btn big danger-ghost" :disabled="deleting" @click="askDelete">{{ deleting ? "Deleting…" : "Delete app…" }}</button>
            </template>
            <template v-else-if="tab === 'logs'">
              <div class="dr-tools"><button type="button" class="btn" :disabled="loading" @click="load">{{ loading ? "Loading…" : "↻ Refresh" }}</button></div>
              <p v-if="!data" class="hint">Loading logs…</p>
              <p v-else-if="!data.ok" class="hint">⚠ {{ data.error }}</p>
              <div v-for="s in data?.sections ?? []" :key="s.source" class="logsec"><div class="logsrc">{{ s.source }}</div><pre class="log">{{ s.text }}</pre></div>
            </template>
            <template v-else>
              <p v-if="!data" class="hint">Loading events…</p>
              <p v-else-if="!(data.events ?? []).length" class="hint">No lifecycle events recorded yet.</p>
              <ol class="evs">
                <li v-for="(e, i) in data?.events ?? []" :key="i" :class="e.to === 'down' || e.to === 'off' ? 'bad' : 'ok'">
                  <span class="et">{{ new Date(e.t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }}</span>
                  <span class="ed">{{ evLabel(e) }}<small v-if="e.detail"> · {{ e.detail }}</small></span>
                </li>
              </ol>
            </template>
          </div>
        </aside>
      </div>
    </Transition>
    <ConfirmDialog :open="asking" :title="plan?.deletable ? `Delete ${app?.name}?` : `Can't delete ${app?.name}`" :subtitle="app?.group"
      :confirm-label="plan?.deletable ? (purge ? 'Delete app and data' : 'Delete app') : 'OK'" :danger="!!plan?.deletable"
      @confirm="plan?.deletable ? doDelete() : (asking = false)" @cancel="asking = false">
      <p v-if="!plan?.deletable" style="margin: 0">{{ plan?.reason }}</p>
      <ul v-else><li v-for="s in plan.steps" :key="s">{{ s }}</li></ul>
      <label v-if="plan?.canPurge" class="chk" style="margin-top: 10px"><input v-model="purge" type="checkbox" /> Also delete its data — can't be undone</label>
    </ConfirmDialog>
  </Teleport>
</template>
