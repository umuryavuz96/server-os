<script setup lang="ts">
// Create or edit a built-in job (server scheduler). Same drawer language as the job details.
import { ref, reactive, computed, watch } from "vue";
import { api, toast } from "../store";

interface Spec {
  id?: string; name: string; kind: "command" | "claude" | "http"; schedule: string; command: string; prompt: string;
  url: string; expect: number; timeout: number | null; enabled: boolean; webhook: boolean; about: string; category: string;
}
const props = defineProps<{ jobId: string | null }>(); // null = new job
const emit = defineEmits<{ close: []; saved: [id: string] }>();

const blank = (): Spec => ({ name: "", kind: "command", schedule: "", command: "", prompt: "", url: "", expect: 200, timeout: null, enabled: true, webhook: false, about: "", category: "" });
const f = reactive<Spec>(blank());
const err = ref(""), busy = ref(false), loaded = ref(false);
const hook = ref<{ url: string; secret: string; header: string } | null>(null);

const PRESETS: [string, string][] = [["Manual only", ""], ["Every 5 min", "*/5 * * * *"], ["Every hour", "@every 1h"], ["Daily 08:00", "0 8 * * *"], ["Weekdays 09:00", "0 9 * * 1-5"], ["Sundays 03:00", "0 3 * * 0"]];
const kindHelp = computed(() => ({
  command: "Runs with /bin/sh in your home folder. Exit code 0 = OK.",
  claude: "Runs `claude -p` with your Claude subscription, in the agent folder. The answer is the run output.",
  http: "Requests the URL and expects the status code below.",
})[f.kind]);

watch(() => props.jobId, async (id) => {
  Object.assign(f, blank()); err.value = ""; hook.value = null; loaded.value = !id;
  if (!id) return;
  try {
    const j = await api<Partial<Spec> & { webhook?: boolean }>(`/jobs/${id}`);
    Object.assign(f, blank(), Object.fromEntries(Object.entries(j).filter(([, v]) => v != null)));
    if (j.webhook) hook.value = await api(`/jobs/${id}/webhook`);
    loaded.value = true;
  } catch (e) { err.value = String((e as Error).message); }
}, { immediate: true });

async function save() {
  busy.value = true; err.value = "";
  const body: Record<string, unknown> = { name: f.name.trim(), kind: f.kind, schedule: f.schedule.trim() || undefined, enabled: f.enabled, webhook: f.webhook,
    about: f.about.trim() || undefined, category: f.category.trim() || undefined, timeout: f.timeout || undefined };
  if (f.kind === "command") body.command = f.command;
  if (f.kind === "claude") body.prompt = f.prompt;
  if (f.kind === "http") { body.url = f.url.trim(); body.expect = Number(f.expect) || 200; }
  try {
    const r = props.jobId ? await api<{ id: string }>(`/jobs/${props.jobId}`, { method: "PUT", body }) : await api<{ id: string }>("/jobs", { body });
    toast(props.jobId ? "Job saved" : `Job “${f.name}” created`);
    emit("saved", r.id);
  } catch (e) { err.value = (e as Error).message; }
  busy.value = false;
}
async function remove() {
  if (!props.jobId || !confirm(`Delete “${f.name}”? Its run history goes too.`)) return;
  try { await api(`/jobs/${props.jobId}`, { method: "DELETE" }); toast("Job deleted"); emit("close"); } catch (e) { err.value = (e as Error).message; }
}
const origin = window.location.origin;
const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast("Copied"));
</script>

<template>
  <form class="form" @submit.prevent="save">
    <label class="fld">Name<input v-model="f.name" required maxlength="80" placeholder="Nightly backup" /></label>
    <div class="fld">Kind
      <div class="kinds" role="group" aria-label="Job kind">
        <button v-for="k in (['command', 'claude', 'http'] as const)" :key="k" type="button" :aria-pressed="f.kind === k" @click="f.kind = k">{{ { command: "Command", claude: "Claude prompt", http: "HTTP check" }[k] }}</button>
      </div>
      <small>{{ kindHelp }}</small>
    </div>
    <label v-if="f.kind === 'command'" class="fld">Command<textarea v-model="f.command" required spellcheck="false" placeholder="~/backup.sh"></textarea></label>
    <label v-if="f.kind === 'claude'" class="fld">Prompt<textarea v-model="f.prompt" required placeholder="Check disk usage and summarise anything over 80%."></textarea></label>
    <div v-if="f.kind === 'http'" class="fld-row">
      <label class="fld">URL<input v-model="f.url" required type="url" placeholder="https://example.com/health" /></label>
      <label class="fld">Expected status<input v-model.number="f.expect" type="number" min="100" max="599" /></label>
    </div>
    <label class="fld">Schedule
      <input v-model="f.schedule" spellcheck="false" placeholder="manual — or */5 * * * * or @every 10m" />
      <div class="chips" style="margin-top: 4px">
        <button v-for="[l, v] in PRESETS" :key="l" type="button" class="chip" :aria-pressed="f.schedule === v" @click="f.schedule = v">{{ l }}</button>
      </div>
    </label>
    <div class="fld-row">
      <label class="fld">Category<input v-model="f.category" placeholder="Backups" /></label>
      <label class="fld">Timeout (s)<input v-model.number="f.timeout" type="number" min="1" max="86400" placeholder="3600" /></label>
    </div>
    <label class="fld">What it does<input v-model="f.about" placeholder="One line for the job's ID card" /></label>
    <label class="chk"><input v-model="f.enabled" type="checkbox" /> Enabled (runs on its schedule)</label>
    <label class="chk"><input v-model="f.webhook" type="checkbox" /> Webhook — start it with an HTTP POST</label>
    <div v-if="hook" class="dbox" style="display: flex; flex-direction: column; gap: 6px">
      <small class="muted">POST to this URL with the header {{ hook.header }}. The request body reaches the job as stdin and $SD_PAYLOAD.</small>
      <div class="secret" @click="copy(origin + hook.url)">{{ hook.url }}</div>
      <div class="secret" @click="copy(hook.secret)">{{ hook.header }}: {{ hook.secret }}</div>
    </div>
    <p v-if="err" class="form-err" role="alert">{{ err }}</p>
    <button type="submit" class="btn primary big" :disabled="busy || !loaded">{{ jobId ? "Save" : "Create job" }}</button>
    <button v-if="jobId" type="button" class="btn big" style="color: var(--bad)" @click="remove">Delete job</button>
  </form>
</template>
