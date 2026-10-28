<script setup lang="ts">
// Right-hand session panel: model + effort (switched live with /model and /effort), context and permissions,
// background jobs (stop for real, start by asking the bot), the bot's own schedules, requests sent from here,
// connections, and the per-bot settings that used to hide behind a gear.
import { ref, computed, onUnmounted, watch } from "vue";
import { api, toast, post, type BotSession } from "../../store";
import { family, modelLabel, dur, clock, type Meta, type BgJob } from "../../bots";

const props = defineProps<{ bot: BotSession; meta: Meta | null }>();
const emit = defineEmits<{ newJob: []; restart: []; stop: []; instructions: []; remove: []; workspace: [] }>();
const ch = computed(() => props.bot.channel);
const enc = encodeURIComponent;
const now = ref(Date.now());
const t = setInterval(() => (now.value = Date.now()), 15_000);
onUnmounted(() => clearInterval(t));

const MODELS = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]] as const;
const EFFORTS = [["low", "low"], ["medium", "med"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]] as const;
const busy = ref("");
const curModel = computed(() => family(props.meta?.session?.model ?? props.bot.activeModel ?? props.bot.model));
const curEffort = computed(() => props.meta?.effort ?? null);
async function act(key: string, path: string, body: unknown = {}) {
  busy.value = key;
  try { const r = await api<{ detail?: string }>(`/bots/${enc(ch.value)}${path}`, { method: "POST", body }); toast(r?.detail ?? "Done"); }
  catch (e) { toast((e as Error).message); }
  busy.value = "";
}
const setModel = (m: string) => m !== curModel.value && act("model", "/model", { model: m });
const setEffort = (e: string) => e !== curEffort.value && act("effort", "/effort", { effort: e });

const ctx = computed(() => { const s = props.meta?.session; return s ? { used: s.contextTokens, limit: s.contextLimit, pct: Math.min(100, Math.round((s.contextTokens / s.contextLimit) * 100)) } : null; });
const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const PERM: Record<string, string> = { bypassPermissions: "Bypass", acceptEdits: "Accept edits", auto: "Auto", plan: "Plan", default: "Ask" };

// ---- background jobs ----
const reqs = computed(() => props.meta?.requests ?? []);
const reqFor = (j: BgJob) => (j.request ? reqs.value.find((r) => r.id === j.request) : undefined);
const open = computed(() => reqs.value.filter((r) => r.status !== "running"));
const jobs = computed(() => props.meta?.jobs ?? []);
const liveCount = computed(() => jobs.value.filter((j) => !j.ended).length);
const KIND: Record<string, string> = { monitor: "MONITOR", shell: "SHELL", agent: "AGENT", watch: "WATCH", schedule: "SCHEDULE", task: "TASK" };
function jobMeta(j: BgJob) {
  if (j.ended) return `${j.endReason === "timed out" ? "Timed out" : j.endReason === "stopped" ? "Stopped" : j.endReason === "replaced" ? "Replaced" : "Ended"} ${clock(j.ended)}${j.events ? ` · ${j.events} events` : ""}`;
  const parts = [`${j.events} ${j.events === 1 ? "event" : "events"}`];
  if (j.timeoutMs) { const left = j.started + j.timeoutMs - now.value; parts.push(left > 0 ? `ends in ${dur(left)}` : "ending"); }
  else parts.push(`running ${dur(now.value - j.started)}`);
  return parts.join(" · ");
}
const toggleJob = (j: BgJob) => act("job:" + j.id, `/jobs/${enc(j.id)}/${j.ended ? "start" : "stop"}`);
async function dismiss(id: string) {
  try { await api(`/bots/${enc(ch.value)}/requests/${enc(id)}`, { method: "DELETE" }); } catch (e) { toast((e as Error).message); }
}

// ---- settings (was the gear) ----
const showSettings = ref(false), token = ref(""), isolate = ref("");
const native = computed(() => props.bot.provider === "native");
async function saveToken() {
  if (!token.value.trim()) return;
  const j = await post<{ ok?: boolean; error?: string; detail?: string }>("/svc-api/cos/bot/set-token", native.value ? { channel: ch.value, tokenEnv: token.value.trim() } : { channel: ch.value, token: token.value.trim() });
  token.value = ""; toast(j.ok === false ? j.error ?? "failed" : j.detail ?? "Token saved — restart the bot to apply");
}
async function scopeSkill(skill: string, target: "isolate" | "share") { if (!skill) return; const j = await post<{ ok?: boolean; error?: string }>("/svc-api/cos/bot/skill-scope", { channel: ch.value, skill, target }); toast(j.ok === false ? j.error ?? "failed" : `${skill} ${target === "isolate" ? "isolated" : "shared"} — restart to apply`); isolate.value = ""; }
async function scopeMcp(mcp: string, enable: boolean) { const j = await post<{ ok?: boolean; error?: string }>("/svc-api/cos/bot/mcp-scope", { channel: ch.value, mcp, enable }); toast(j.ok === false ? j.error ?? "failed" : `${mcp} ${enable ? "enabled" : "disabled"} — restart to apply`); }
async function reconnect() { busy.value = "tg"; const j = await post<{ ok?: boolean; error?: string }>("/svc-api/cos/bot/reconnect-mcp", { channel: ch.value }).catch((e) => ({ ok: false, error: String(e) })); toast(j.ok === false ? j.error ?? "failed" : "Telegram reconnect sent"); busy.value = ""; }
const mcps = computed(() => props.bot.capabilities?.mcps ?? []);

// ---- team (agmsg): members and the last messages from/to this bot, native bots only ----
interface Team { installed: boolean; team: string | null; members: string[]; messages: { unread: boolean; at: string; from: string; to: string; body: string }[]; install?: string; repo?: string }
const team = ref<Team | null>(null);
async function loadTeam() {
  if (!native.value) { team.value = null; return; }
  try { const j = await (await fetch(`/svc-api/cos/bot/agmsg?channel=${enc(ch.value)}&limit=6`)).json(); team.value = j.ok ? j : null; } catch { /* keep the last one */ }
}
watch(ch, loadTeam, { immediate: true });
const tt = setInterval(loadTeam, 10_000);
onUnmounted(() => clearInterval(tt));
const PRESET: Record<string, string> = { safe: "Safe", dev: "Dev", full: "Full" };
</script>

<template>
  <aside class="bi" aria-label="Session">
    <section class="bi-s">
      <h3>Session</h3>
      <div class="bi-f">
        <span>Model</span>
        <div class="seg2" role="radiogroup" aria-label="Model">
          <button v-for="[id, label] in MODELS" :key="id" type="button" role="radio" :aria-checked="curModel === id" :disabled="!bot.running || busy === 'model'" @click="setModel(id)">{{ label }}</button>
        </div>
      </div>
      <div class="bi-f">
        <span>Effort</span>
        <div class="seg2" role="radiogroup" aria-label="Effort">
          <button v-for="[id, label] in EFFORTS" :key="id" type="button" role="radio" :aria-checked="curEffort === id" :disabled="!bot.running || busy === 'effort'" @click="setEffort(id)">{{ label }}</button>
        </div>
      </div>
      <p class="bi-h">{{ bot.running ? `Now ${modelLabel(meta?.session?.model ?? bot.model)}${curEffort ? ` · ${curEffort} effort` : ""}. Switches live with /model and /effort — no restart.` : "Start the bot to switch model or effort." }}</p>
      <div class="bi-g">
        <div class="bi-c"><span>Context</span><b class="num">{{ ctx ? k(ctx.used) : "—" }}<small v-if="ctx"> / {{ k(ctx.limit) }}</small></b><i class="bar"><i :style="{ width: (ctx?.pct ?? 0) + '%' }" :class="{ hot: (ctx?.pct ?? 0) > 80 }"></i></i></div>
        <div class="bi-c"><span>Permissions</span><b>{{ PERM[meta?.session?.permissionMode ?? ""] ?? meta?.session?.permissionMode ?? "—" }}</b><small>set at launch</small></div>
      </div>
    </section>

    <section class="bi-s">
      <div class="bi-t"><h3>Running in the background</h3><span class="num">{{ liveCount }} running</span><button type="button" class="btn sm" :disabled="!bot.running" @click="emit('newJob')">+ New</button></div>
      <div v-for="r in open" :key="r.id" class="bj" :class="r.status">
        <div class="bj-h"><span class="kd" :class="r.kind">{{ KIND[r.kind] }}</span><b>{{ r.name }}</b><span class="st" :class="r.status">{{ r.status === "failed" ? "FAILED" : "PENDING" }}</span></div>
        <p class="bj-w">{{ r.what }}</p>
        <p class="bj-m">{{ r.status === "failed" ? `Failed: ${r.reason}` : `Sent ${clock(r.created)} · ${r.id} · waiting for the bot to set it up…` }}</p>
        <div class="bj-a"><button type="button" class="btn sm ghost" @click="dismiss(r.id)">{{ r.status === "failed" ? "Dismiss" : "Forget it" }}</button></div>
      </div>
      <div v-for="j in jobs" :key="j.id" class="bj" :class="{ off: !!j.ended }">
        <div class="bj-h">
          <span class="kd" :class="j.kind">{{ KIND[j.kind] }}</span><b>{{ reqFor(j)?.name ?? j.name }}</b>
          <button type="button" class="sw sm" role="switch" :aria-checked="!j.ended" :aria-label="`${j.ended ? 'Start' : 'Stop'} ${j.name}`" :class="{ busy: busy === 'job:' + j.id }" :disabled="!bot.running || !!busy" @click="toggleJob(j)"></button>
        </div>
        <p v-if="reqFor(j)" class="bj-w">{{ reqFor(j)!.what }}</p>
        <code class="bj-c">{{ j.command }}</code>
        <p class="bj-m">{{ jobMeta(j) }}<template v-if="j.lastEvent && !j.ended"> · last: {{ j.lastEvent }}</template></p>
        <p v-if="j.rearms >= 5 && !j.ended" class="bj-warn">Re-armed {{ j.rearms }}× in 24 h{{ j.events ? "" : " with nothing to report" }}</p>
      </div>
      <p v-if="!jobs.length && !open.length" class="bi-h">Nothing running in the background.</p>
      <p class="bi-h">Off stops the process now. On asks the bot to start it again. New ones go to the bot as instructions; it marks them running or failed.</p>
    </section>

    <section v-if="meta?.schedules.length" class="bi-s">
      <h3>Scheduled by the bot</h3>
      <div v-for="s in meta.schedules" :key="s.id" class="bj">
        <div class="bj-h"><span class="kd schedule">CRON</span><b class="num">{{ s.cron }}</b>
          <button type="button" class="sw sm" role="switch" aria-checked="true" :aria-label="`Cancel ${s.cron}`" :disabled="!bot.running || !!busy" @click="act('sch:' + s.id, `/schedules/${enc(s.id)}/stop`)"></button></div>
        <p class="bj-w">{{ s.prompt.length > 160 ? s.prompt.slice(0, 160) + "…" : s.prompt }}</p>
        <p class="bj-m">{{ s.recurring ? "Repeats" : "Once" }} · set {{ clock(s.created) }} · ends when the session does</p>
      </div>
    </section>

    <section class="bi-s">
      <h3>Connections</h3>
      <div class="bi-tg"><span class="dot" :class="{ on: bot.running && bot.telegramConnected }"></span>Telegram<span class="muted">{{ native && !bot.telegram ? "off" : !bot.running ? "bot stopped" : bot.telegramConnected ? "connected" : "not connected" }}</span><span class="sp"></span>
        <button v-if="bot.running && !native" type="button" class="btn sm" :disabled="busy === 'tg'" @click="reconnect">{{ busy === "tg" ? "Reconnecting…" : "Reconnect" }}</button></div>
      <div v-if="!native" class="bi-mcp">
        <span v-for="m in mcps.filter((x) => x.scope !== 'global')" :key="m.name" class="mc">{{ m.name }}</span>
        <span class="mc dim">{{ mcps.filter((x) => x.scope === "global").length }} shared</span>
      </div>
    </section>

    <section v-if="native" class="bi-s">
      <div class="bi-t"><h3>Workspace</h3><span class="sp"></span><button type="button" class="btn sm" @click="emit('workspace')">Edit</button></div>
      <div class="bi-mcp">
        <span class="mc">{{ PRESET[bot.preset ?? "safe"] }} rules</span>
        <span class="mc">{{ (bot.folders ?? []).length }} {{ (bot.folders ?? []).length === 1 ? "folder" : "folders" }}</span>
        <span class="mc" :class="{ dim: !bot.network }">network {{ bot.network ? "on" : "off" }}</span>
        <span v-if="bot.sandbox" class="mc">sandbox</span>
        <span class="mc" :class="{ dim: !bot.secrets }">{{ bot.secrets ?? 0 }} secrets</span>
        <span v-if="bot.isolated" class="mc">isolated</span>
      </div>
      <p v-if="bot.role" class="bi-h">{{ bot.role }}</p>
    </section>

    <section v-if="native && team" class="bi-s">
      <div class="bi-t"><h3>Team</h3><span class="num">{{ team.installed ? team.team : "agmsg missing" }}</span></div>
      <template v-if="team.installed">
        <div class="bi-mcp"><span v-for="m in team.members" :key="m" class="mc" :class="{ dim: m === bot.channel }">{{ m }}</span></div>
        <div v-for="(m, i) in team.messages" :key="i" class="bi-msg" :class="{ unread: m.unread }">
          <small>{{ m.from }} → {{ m.to }} · {{ m.at.slice(11, 16) }}</small><span>{{ m.body.length > 140 ? m.body.slice(0, 140) + "…" : m.body }}</span>
        </div>
        <p v-if="!team.messages.length" class="bi-h">No messages yet.</p>
      </template>
      <p v-else class="bi-h">Bots can't message each other: install agmsg ({{ team.repo }}) — <code>{{ team.install }}</code></p>
    </section>

    <section v-if="!bot.protected" class="bi-s">
      <button type="button" class="bi-more" :aria-expanded="showSettings" @click="showSettings = !showSettings">Settings <span>{{ showSettings ? "−" : "+" }}</span></button>
      <template v-if="showSettings">
        <form v-if="native" class="bi-row" @submit.prevent="saveToken">
          <label class="bi-l">Telegram token variable <span class="pill" :class="bot.tokenSet ? 'p-on' : 'p-off'">{{ bot.tokenKey ? (bot.tokenSet ? "SET" : "MISSING") : "OFF" }}</span><input v-model="token" :placeholder="bot.tokenKey ?? 'TELEGRAM_MYBOT_TOKEN'" autocomplete="off" spellcheck="false" /></label>
          <button class="btn sm" type="submit" :disabled="!token.trim()">Save</button>
        </form>
        <form v-else class="bi-row" @submit.prevent="saveToken">
          <label class="bi-l">Telegram token <span class="pill" :class="bot.tokenSet ? 'p-on' : 'p-off'">{{ bot.tokenSet ? "SET" : "NONE" }}</span><input v-model="token" type="password" placeholder="123456:ABC…" autocomplete="off" /></label>
          <button class="btn sm" type="submit" :disabled="!token.trim()">Save</button>
        </form>
        <p v-if="native" class="bi-h">The name of a variable in ~/.env that holds the BotFather token. The token itself never goes into Server OS's config.</p>
        <div v-if="!native" class="bi-l">Skills only this bot has
          <div class="bi-mcp"><span v-for="sk in bot.capabilities?.projectSkills ?? []" :key="sk" class="mc">{{ sk }}<button type="button" :aria-label="`Share ${sk} with every bot`" @click="scopeSkill(sk, 'share')">⤴</button></span><span v-if="!(bot.capabilities?.projectSkills ?? []).length" class="muted">none</span></div>
        </div>
        <form v-if="bot.scopable && !native" class="bi-row" @submit.prevent="scopeSkill(isolate, 'isolate')">
          <select v-model="isolate" aria-label="Global skill to isolate"><option value="">Isolate a global skill…</option><option v-for="g in bot.capabilities?.globalSkills ?? []" :key="g">{{ g }}</option></select>
          <button class="btn sm" type="submit" :disabled="!isolate">Isolate</button>
        </form>
        <div v-for="m in native ? [] : mcps.filter((x) => x.toggleable)" :key="m.name" class="bi-tg">{{ m.name }}<span class="muted">{{ m.scope }}</span><span class="sp"></span>
          <button type="button" class="sw sm" role="switch" :aria-checked="m.enabled" :aria-label="`${m.name} for this bot`" @click="scopeMcp(m.name, !m.enabled)"></button></div>
        <p class="bi-h">Restart the bot to apply token and scope changes.</p>
        <button v-if="native" type="button" class="btn danger sm" @click="emit('remove')">Delete bot…</button>
      </template>
    </section>

    <section class="bi-s bi-foot">
      <button type="button" class="bi-link" @click="emit('instructions')">Instructions (CLAUDE.md) <span>{{ bot.protected ? "View" : "Edit" }}</span></button>
      <div v-if="!bot.protected && bot.running" class="bi-row">
        <button type="button" class="btn" @click="emit('restart')">Restart</button>
        <button type="button" class="btn danger" @click="emit('stop')">Stop</button>
      </div>
      <p v-else-if="bot.protected" class="bi-h">The main bot is managed on the Mac; it can't be restarted or stopped here.</p>
    </section>
  </aside>
</template>
