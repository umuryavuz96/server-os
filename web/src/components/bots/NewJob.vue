<script setup lang="ts">
// "New background job": the owner describes it in plain words; it goes to the bot as instructions with a request id.
// The request shows as pending until the bot starts a job carrying that id (running) or answers SD-FAILED (failed).
import { ref, computed, watch } from "vue";
import { api, toast } from "../../store";

const props = defineProps<{ channel: string }>();
const emit = defineEmits<{ close: [] }>();
const kind = ref<"watch" | "schedule" | "task">("watch");
const what = ref(""), name = ref("");
const source = ref("Log file"), every = ref("Live"), repeat = ref("Weekdays"), at = ref("09:00"), model = ref("sonnet"), until = ref("Until I stop it");
const telegram = ref(true), quiet = ref(true);
const busy = ref(false), sentId = ref<string | null>(null);

const KINDS = [
  { id: "watch", label: "Watch something", sub: "A log, mailbox, page or command — report changes" },
  { id: "schedule", label: "Run on a schedule", sub: "Do a task at set times" },
  { id: "task", label: "Long task", sub: "A sub-agent works on it and reports back" },
] as const;
const options = computed(() => ({
  ...(kind.value === "watch" ? { source: source.value, every: every.value } : kind.value === "schedule" ? { repeat: repeat.value, at: at.value } : { model: model.value }),
  until: kind.value === "schedule" ? undefined : until.value, telegram: telegram.value, quiet: quiet.value,
}));
const ok = computed(() => what.value.trim().length > 3 && name.value.trim().length > 1);

const preview = ref("");
let t: ReturnType<typeof setTimeout>;
watch([kind, what, name, options], () => {
  clearTimeout(t);
  t = setTimeout(async () => {
    const q = new URLSearchParams({ kind: kind.value, name: name.value, what: what.value, ...Object.fromEntries(Object.entries(options.value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)])) });
    try { preview.value = (await api<{ prompt: string }>(`/bots/${encodeURIComponent(props.channel)}/requests/preview?${q}`)).prompt; } catch { /* keep the last one */ }
  }, 250);
}, { immediate: true, deep: true });

async function send() {
  if (!ok.value || busy.value) return;
  busy.value = true;
  try { sentId.value = (await api<{ id: string }>(`/bots/${encodeURIComponent(props.channel)}/requests`, { body: { kind: kind.value, name: name.value.trim(), what: what.value.trim(), options: options.value } })).id; }
  catch (e) { toast((e as Error).message); }
  busy.value = false;
}
</script>

<template>
  <Teleport to="body">
    <div class="dr-wrap">
      <div class="dr-bg" @click="emit('close')"></div>
      <aside class="dr nj" role="dialog" aria-modal="true" aria-label="New background job">
        <div class="dr-h"><span class="dr-title">New background job<small>for {{ channel === "telegram" ? "main" : channel }} · the bot sets it up</small></span><button type="button" class="btn" aria-label="Close" @click="emit('close')">✕</button></div>

        <form v-if="!sentId" class="dr-b" @submit.prevent="send">
          <div class="nj-f"><span>What kind</span>
            <div class="nj-k">
              <button v-for="k in KINDS" :key="k.id" type="button" :aria-pressed="kind === k.id" @click="kind = k.id"><b>{{ k.label }}</b><small>{{ k.sub }}</small></button>
            </div>
          </div>
          <label class="nj-f">What should it do?
            <textarea v-model="what" rows="3" placeholder="e.g. Watch ~/backup.log and tell me when a line says ERROR."></textarea>
            <small>Plain words. The bot picks the command or tool.</small>
          </label>
          <label class="nj-f">Name<input v-model="name" maxlength="80" placeholder="Backup errors" /></label>

          <template v-if="kind === 'watch'">
            <div class="nj-f"><span>Watching</span><div class="seg2"><button v-for="o in ['Log file', 'Mailbox', 'Web page', 'Command']" :key="o" type="button" role="radio" :aria-checked="source === o" @click="source = o">{{ o }}</button></div></div>
            <div class="nj-f"><span>Check</span><div class="seg2"><button v-for="o in ['Live', '1 min', '10 min', '1 h']" :key="o" type="button" role="radio" :aria-checked="every === o" @click="every = o">{{ o }}</button></div></div>
          </template>
          <div v-else-if="kind === 'schedule'" class="nj-2">
            <label class="nj-f">Repeat<select v-model="repeat"><option>Every day</option><option>Weekdays</option><option>Every week</option><option>Once</option></select></label>
            <label class="nj-f">At<input v-model="at" type="time" /></label>
          </div>
          <div v-else class="nj-f"><span>Run it on</span><div class="seg2"><button v-for="o in ['opus', 'sonnet', 'haiku']" :key="o" type="button" role="radio" :aria-checked="model === o" @click="model = o">{{ o[0].toUpperCase() + o.slice(1) }}</button></div></div>

          <div v-if="kind !== 'schedule'" class="nj-f"><span>Stop after</span><div class="seg2"><button v-for="o in ['30 min', '1 day', 'Until I stop it']" :key="o" type="button" role="radio" :aria-checked="until === o" @click="until = o">{{ o }}</button></div></div>

          <div class="nj-sw">
            <div><span><b>Tell me on Telegram</b><small>When it finds something</small></span><button type="button" class="sw sm" role="switch" :aria-checked="telegram" aria-label="Tell me on Telegram" @click="telegram = !telegram"></button></div>
            <div><span><b>Keep it quiet</b><small>Don't report when a watch ends with nothing found</small></span><button type="button" class="sw sm" role="switch" :aria-checked="quiet" aria-label="Keep it quiet" @click="quiet = !quiet"></button></div>
          </div>

          <details class="nj-p"><summary>What the bot will receive</summary><pre>{{ preview }}</pre></details>
          <div class="nj-foot"><span class="muted">The bot reads it next, even mid-task.</span><button type="button" class="btn" @click="emit('close')">Cancel</button><button type="submit" class="btn primary" :disabled="!ok || busy">{{ busy ? "Sending…" : "Send to bot" }}</button></div>
        </form>

        <div v-else class="dr-b">
          <b style="font-size: 17px">Sent to the bot</b>
          <p class="muted" style="margin: 0">It's in the list as pending ({{ sentId }}). When the bot has set it up it turns into a running job — or failed, with the bot's reason.</p>
          <button type="button" class="btn primary" style="align-self: flex-start" @click="emit('close')">Back to the bot</button>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
