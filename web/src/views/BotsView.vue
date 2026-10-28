<script setup lang="ts">
// Bots: each bot is a Claude Code session. Left: the bots. Middle: the session's chat, read live from its transcript
// (messages as Markdown, tool steps folded, background notices folded), past sessions, or the raw terminal. Right:
// the session panel (model, effort, background jobs, schedules, connections). The bot manager — Claude OS (:3090) or
// Server OS's own native one (tmux) — starts, stops and types into the sessions; the feed and controls come from /api/v1/bots.
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import { S, api, post, toast, type BotSession } from "../store";
import { useFeed, modelLabel, newNonce, type FeedItem, blocks as toBlocks } from "../bots";
import BotFeed from "../components/bots/BotFeed.vue";
import BotInspector from "../components/bots/BotInspector.vue";
import NewJob from "../components/bots/NewJob.vue";
import BotWorkspace from "../components/bots/BotWorkspace.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const bots = computed<BotSession[]>(() => [...(S.botSessions ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || Number(b.protected) - Number(a.protected) || a.channel.localeCompare(b.channel)));
const sel = ref<string | null>(null);
const bot = computed(() => bots.value.find((b) => b.channel === sel.value) ?? bots.value.find((b) => b.running) ?? bots.value[0] ?? null);
// ps etime ("[[dd-]hh:]mm:ss") → "1 d 1 h" / "3 h 12 min" / "8 min"
const upFor = (e: string) => { const m = e.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):\d+$/); if (!m) return e; const [d, h, mi] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3])]; return d ? `${d} d ${h} h` : h ? `${h} h ${mi} min` : `${mi} min`; };
const label = (ch: string) => (ch === "telegram" ? "main" : ch);
const mobile = ref<"list" | "chat">("list");
const info = ref(false); // inspector sheet (phone and tablet)
let autoOpened = false;
// A single bot: skip the list and open it directly.
watch(() => bots.value.length, (n) => { if (n === 1 && !autoOpened && !creating.value) { mobile.value = "chat"; } if (n) autoOpened = true; }, { immediate: true });
const creating = ref(false);
function pick(ch: string) { sel.value = ch; creating.value = false; mobile.value = "chat"; tab.value = "chat"; }

const channel = computed(() => (creating.value ? null : bot.value?.channel ?? null));
const { grouped, meta, state, echo, echoState, dismiss } = useFeed(channel);
const working = (b: BotSession) => (b.channel === bot.value?.channel ? !!meta.value?.session?.working : false);
/** New bots are native ones whenever Server OS runs bots itself (alone, or next to Claude OS with provider "both"). */
const native = computed(() => S.botsProvider?.provider === "native" || S.botsProvider?.provider === "both");
const line = (b: BotSession) => !b.running ? "Stopped" : working(b) ? `Working · ${meta.value?.session?.working?.step ?? "thinking"}` : `${b.telegramConnected || (b.provider === "native" && !b.telegram) ? "Idle" : "Telegram off"} · ${modelLabel(b.activeModel ?? b.model)}`;

// ---- tabs: chat · history · terminal (+ workspace for native bots, also while stopped) ----
const tab = ref<"chat" | "history" | "terminal" | "workspace">("chat");
const tabs = computed(() => [...(bot.value?.running ? (["chat", "history", "terminal"] as const) : bot.value?.provider === "native" ? (["chat"] as const) : []),
  ...(bot.value?.provider === "native" ? (["workspace"] as const) : [])]);
const sessions = ref<{ session: string; updated: number; messages: number; preview: string }[] | null>(null);
const past = ref<{ session: string; items: FeedItem[] } | null>(null);
const pastBlocks = computed(() => (past.value ? toBlocks(past.value.items) : []));
async function loadSessions() { sessions.value = null; past.value = null; try { sessions.value = await api(`/bots/${encodeURIComponent(bot.value!.channel)}/sessions`); } catch { sessions.value = []; } }
async function openPast(id: string) { try { past.value = { session: id, items: await api(`/bots/${encodeURIComponent(bot.value!.channel)}/sessions/${id}`) }; } catch (e) { toast((e as Error).message); } }
const raw = ref(""), rawBox = ref<HTMLElement | null>(null);
let rawPoll: ReturnType<typeof setInterval> | null = null;
function stopRaw() { if (rawPoll) clearInterval(rawPoll); rawPoll = null; }
async function loadRaw() {
  const ch = bot.value?.channel; if (!ch) return;
  try {
    const j = await (await fetch(`/svc-api/cos/bot/terminal?channel=${encodeURIComponent(ch)}`)).json();
    const el = rawBox.value, near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    raw.value = j.ok ? j.contents ?? "" : "⚠ " + j.error;
    await nextTick(); if (near && rawBox.value) rawBox.value.scrollTop = rawBox.value.scrollHeight;
  } catch (e) { raw.value = "⚠ " + e; }
}
watch([() => bot.value?.channel, tab, () => bot.value?.running], () => {
  stopRaw();
  if (!bot.value) return;
  if (tab.value === "history" || !bot.value.running) loadSessions();
  if (tab.value === "terminal" && bot.value.running) { loadRaw(); rawPoll = setInterval(loadRaw, 2000); }
}, { immediate: true });
onUnmounted(stopRaw);

// ---- composer ----
// A prompt shows in the chat the moment it is sent (an optimistic bubble tagged with a nonce); the server hands the
// nonce back on the transcript line it becomes, and that line replaces the bubble. Nothing is typed twice.
const prompt = ref("");
async function deliver(ch: string, text: string, nonce: string) {
  try {
    const j = await api<{ ok: boolean }>(`/bots/${encodeURIComponent(ch)}/send`, { body: { text, nonce } });
    if (j?.ok === false) throw new Error("The bot didn't take it");
    echoState(nonce, "queued");
  } catch (e) { echoState(nonce, "failed", (e as Error).message || "Couldn't send"); }
}
function send() {
  const b = bot.value, text = prompt.value.trim(); if (!b || !text) return;
  prompt.value = "";
  void deliver(b.channel, text, echo(text));
}
function retry(nonce: string, text: string) { const b = bot.value; if (!b) return; echoState(nonce, "sending"); void deliver(b.channel, text, nonce); }
const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };

// Interrupt: pending the moment it is tapped, then "Stopped" or the reason it didn't. The server presses Escape,
// then checks the session actually went idle before it answers.
const stop = ref<{ state: "idle" | "stopping" | "stopped" | "still" | "error"; msg: string }>({ state: "idle", msg: "" });
let stopTimer: ReturnType<typeof setTimeout> | null = null;
function stopSay(state: "stopped" | "still" | "error", msg: string) {
  stop.value = { state, msg };
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => { if (stop.value.state === state) stop.value = { state: "idle", msg: "" }; }, state === "stopped" ? 4000 : 9000);
}
async function interrupt() {
  const b = bot.value; if (!b || stop.value.state === "stopping") return;
  if (stopTimer) clearTimeout(stopTimer);
  stop.value = { state: "stopping", msg: "Stopping…" };
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12_000);
    const r = await fetch(`/api/v1/bots/${encodeURIComponent(b.channel)}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: ctl.signal }).finally(() => clearTimeout(to));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail ?? j.title ?? `HTTP ${r.status}`);
    j.stopped ? stopSay("stopped", "Stopped") : stopSay("still", j.detail ?? "Escape sent, but the bot is still working");
  } catch (e) {
    const err = e as Error;
    stopSay("error", err.name === "AbortError" ? "No answer from the server. Check the Terminal tab to see whether it stopped." : err.message || "Couldn't interrupt");
  }
}
watch(() => bot.value?.channel, () => { stop.value = { state: "idle", msg: "" }; });

// Staleness guard: if "Working" has shown for a while with nothing new in the session, ask the server to look at the
// pane once; an idle pane means the turn is long over. Only runs while the page shows Working.
let verifying = false;
const verifyTick = setInterval(async () => {
  const w = meta.value?.session?.working, b = bot.value;
  if (!w || !b || !meta.value?.tmux || verifying || document.hidden) return;
  if (Date.now() - Math.max(w.since, meta.value?.session?.lastActivity ?? 0) < 120_000) return;
  verifying = true;
  try { await api(`/bots/${encodeURIComponent(b.channel)}/verify`, { method: "POST", body: {} }); } catch { /* the next tick asks again */ }
  verifying = false;
}, 30_000);
onUnmounted(() => { clearInterval(verifyTick); if (stopTimer) clearTimeout(stopTimer); });

// ---- lifecycle (Claude OS or native) ----
const ask = ref<null | "restart" | "stop" | "delete">(null), working2 = ref("");
async function act(kind: "restart" | "stop" | "delete") {
  const b = bot.value; if (!b) return;
  ask.value = null; working2.value = kind;
  try { const j = await post<{ ok?: boolean; error?: string }>(`/svc-api/cos/bot/${kind}`, { channel: b.channel }); toast(j.ok === false ? j.error ?? "failed" : `${label(b.channel)} ${kind === "stop" ? "stopped" : kind === "delete" ? "deleted" : "restarted"}`); if (j.ok !== false && kind === "delete") sel.value = null; }
  catch (e) { toast(String(e)); }
  working2.value = "";
}
const launching = ref<string | null>(null);
async function launch(resume: string | null) {
  const b = bot.value; if (!b) return;
  launching.value = resume ?? "fresh";
  try { const j = await post<{ ok?: boolean; error?: string }>("/svc-api/cos/bot/launch", { channel: b.channel, resume }); toast(j.ok === false ? j.error ?? "launch failed" : `${label(b.channel)} ${resume ? "resumed" : "launched"}`); }
  catch (e) { toast(String(e)); }
  launching.value = null;
}

// ---- instructions (CLAUDE.md) ----
const instr = ref<{ text: string; editable: boolean; path: string } | null>(null), instrBusy = ref(false);
async function openInstr() { try { const j = await api<{ text: string; editable: boolean; path: string }>(`/bot-instructions?channel=${encodeURIComponent(bot.value!.channel)}`); instr.value = j; } catch (e) { toast((e as Error).message); } }
async function saveInstr() {
  if (!instr.value) return; instrBusy.value = true;
  const j = await post<{ ok?: boolean; error?: string; detail?: string }>("/svc-api/bot-instructions", { channel: bot.value!.channel, text: instr.value.text });
  instrBusy.value = false; toast(j.ok === false ? j.error ?? "failed" : j.detail ?? "Saved"); if (j.ok !== false) instr.value = null;
}

// ---- new bot ----
const NB = () => ({ name: "", token: "", model: "sonnet", workdir: "", effort: "", permissionMode: "dontAsk", tokenEnv: "", preset: "safe", role: "" });
const nb = ref(NB()), nbBusy = ref(false);
async function createBot() {
  const v = nb.value;
  if (!v.name.trim() || (!native.value && !v.token.trim())) { toast(native.value ? "A name is required" : "Name and token are required"); return; }
  nbBusy.value = true;
  const body = native.value
    ? { name: v.name.trim(), model: v.model, effort: v.effort || undefined, permissionMode: v.permissionMode, tokenEnv: v.tokenEnv.trim() || undefined, preset: v.preset, role: v.role.trim(), dir: v.workdir.trim() || undefined }
    : { name: v.name.trim(), token: v.token.trim(), model: v.model, workdir: v.workdir.trim() || undefined };
  const j = await post<{ ok?: boolean; error?: string; note?: string }>("/svc-api/cos/bot/create", body);
  nbBusy.value = false;
  if (j.ok === false) { toast(j.error ?? "create failed"); return; }
  toast(native.value ? j.note ?? "Bot created" : "Bot created — DM it /start on Telegram to pair"); sel.value = v.name.trim(); creating.value = false; nb.value = NB();
}
const newJob = ref(false);
</script>

<template>
  <main class="bws" :class="['m-' + mobile, { info, one: bots.length === 1 }]" @keydown.esc="info = false">
    <div v-if="S.botsProvider && !S.botsProvider.provider" class="empty bsetup">
      <b>Bots need tmux and Claude Code</b>
      <p>Each bot is a Claude Code session that Server OS runs in a tmux session. Missing on this server: <code>{{ S.botsProvider.missing.join(", ") }}</code>.</p>
      <p>Install them (macOS: <code>brew install tmux</code>, then Claude Code from claude.com/claude-code), sign in once with <code>claude</code>, and restart Server OS.</p>
    </div>
    <p v-else-if="!S.botSessions" class="empty">{{ native ? "Loading bots…" : "Connecting to Claude OS…" }}</p>
    <template v-else>
      <!-- bots -->
      <nav class="bws-l" aria-label="Bots">
        <div class="bws-lh"><h1>Bots</h1><button type="button" class="btn sm" @click="creating = true; mobile = 'chat'">+ New bot</button></div>
        <button v-for="b in bots" :key="b.channel" type="button" class="bws-b" :aria-current="!creating && bot?.channel === b.channel ? 'true' : undefined" @click="pick(b.channel)">
          <span class="dot" :class="!b.running ? '' : working(b) ? 'work' : 'on'"></span>
          <span class="bws-bt"><b>{{ label(b.channel) }}</b><small>{{ line(b) }}</small></span>
        </button>
        <p class="bws-lf">{{ bots.filter((b) => b.running).length }} of {{ bots.length }} running</p>
      </nav>

      <!-- new bot -->
      <section v-if="creating" class="bws-c">
        <header class="bws-h"><button type="button" class="btn sm bws-back" @click="creating = false; mobile = 'list'">‹ Bots</button><h2>New bot</h2><span class="sp"></span><button type="button" class="btn" @click="creating = false">Cancel</button></header>
        <form class="bform bws-pad" @submit.prevent="createBot">
          <label>Bot name<input v-model="nb.name" placeholder="recipe-bot" autocomplete="off" /></label>
          <template v-if="native">
            <div class="frow">
              <label>Model<select v-model="nb.model"><option>sonnet</option><option>opus</option><option>haiku</option><option>fable</option></select></label>
              <label>Effort<select v-model="nb.effort"><option value="">default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label>
              <label>Permissions<select v-model="nb.permissionMode"><option value="dontAsk">Deny unlisted</option><option value="default">Ask</option><option value="acceptEdits">Accept edits</option><option value="auto">Auto</option><option value="plan">Plan</option><option value="bypassPermissions">Bypass</option></select></label>
              <label>Tool rules<select v-model="nb.preset"><option value="safe">Safe</option><option value="dev">Dev</option><option value="full">Full</option></select></label>
            </div>
            <label>Role <small>(optional — goes into its identity)</small><input v-model="nb.role" placeholder="researcher — finds and summarises sources" maxlength="200" /></label>
            <label>Telegram token variable <small>(optional)</small><input v-model="nb.tokenEnv" placeholder="TELEGRAM_RECIPE_BOT_TOKEN" autocomplete="off" spellcheck="false" /></label>
            <label>Existing folder <small>(optional — use a bot folder you already have, in place)</small><input v-model="nb.workdir" placeholder="~/bots/recipe-bot" autocomplete="off" spellcheck="false" /></label>
            <button type="submit" class="btn primary big" :disabled="nbBusy">{{ nbBusy ? "Creating…" : "Create bot" }}</button>
            <p class="hint">Works in <code>{{ nb.workdir.trim() || "<home>/bots/" + (nb.name.trim() || "name") }}</code> (its only folder until you add more under Workspace) and runs in the tmux session <code>{{ (S.botsProvider?.prefix ?? "sos-") + (nb.name.trim() || "name") }}</code>. It joins the agmsg team so it can message the other bots. For Telegram, put the BotFather token in <code>~/.env</code> under the variable named here; it is read when the bot starts.</p>
          </template>
          <template v-else>
            <label>BotFather token<input v-model="nb.token" type="password" placeholder="123456:ABC…" autocomplete="off" /></label>
            <div class="frow">
              <label>Model<select v-model="nb.model"><option>sonnet</option><option>opus</option><option>haiku</option><option>fable</option></select></label>
              <label style="flex: 1.6">Working folder <small>(optional)</small><input v-model="nb.workdir" placeholder="~/bots/recipe-bot" /></label>
            </div>
            <button type="submit" class="btn primary big" :disabled="nbBusy">{{ nbBusy ? "Creating…" : "Create bot" }}</button>
            <p class="hint">After creating, DM the bot <kbd>/start</kbd> on Telegram to pair.</p>
          </template>
        </form>
      </section>

      <!-- conversation -->
      <section v-else-if="bot" class="bws-c">
        <header class="bws-h">
          <button type="button" class="btn sm bws-back" @click="creating = false; mobile = 'list'">‹ Bots</button>
          <div class="bws-ht">
            <h2>{{ label(bot.channel) }}
              <span v-if="!bot.running" class="pill p-off">STOPPED</span>
              <span v-else-if="meta?.session?.working" class="pill p-work"><i class="pulse"></i>WORKING</span>
              <span v-else class="pill p-on">IDLE</span>
            </h2>
            <small>{{ bot.cwd.replace(/^\/Users\/[^/]+/, "~") }}<template v-if="bot.uptime"> · up {{ upFor(bot.uptime) }}</template><template v-if="state === 'error'"> · reconnecting…</template></small>
          </div>
          <span class="sp"></span>
          <div v-if="tabs.length > 1" class="seg2 bws-tabs" role="tablist" aria-label="View">
            <button v-for="t in tabs" :key="t" type="button" role="tab" :aria-selected="tab === t" @click="tab = t; past = null">{{ t[0].toUpperCase() + t.slice(1) }}</button>
          </div>
          <button type="button" class="btn sm bws-panel" aria-haspopup="dialog" @click="info = true">Info</button>
        </header>

        <BotWorkspace v-if="tab === 'workspace' && bot.provider === 'native'" :bot="bot" />
        <template v-else-if="bot.running">
          <template v-if="tab === 'chat'">
            <BotFeed :blocks="grouped" :meta="meta" :name="bot.channel" :can-interrupt="!!meta?.tmux" :stop="stop" @interrupt="interrupt" @retry="retry" @dismiss="dismiss" />
            <form class="bws-send" @submit.prevent="send">
              <div class="bws-box">
                <textarea v-model="prompt" rows="2" :placeholder="`Message ${label(bot.channel)}…`" :aria-label="`Message ${label(bot.channel)}`" @keydown="onKey"></textarea>
                <div class="bws-bar">
                  <span class="mc">{{ modelLabel(meta?.session?.model ?? bot.model) }}<template v-if="meta?.effort"> · {{ meta.effort }} effort</template></span>
                  <span class="muted">Goes straight into the session · Enter sends · Shift+Enter new line</span>
                  <span class="sp"></span>
                  <button type="submit" class="btn primary" :disabled="!prompt.trim()">Send</button>
                </div>
              </div>
            </form>
          </template>
          <div v-else-if="tab === 'history'" class="bws-hist">
            <template v-if="past">
              <button type="button" class="btn sm" style="align-self: flex-start; margin: 12px 22px 0" @click="past = null">← All sessions</button>
              <BotFeed :blocks="pastBlocks" :meta="null" :name="past.session" :can-interrupt="false" />
            </template>
            <div v-else class="bws-pad bws-list">
              <p v-if="sessions === null" class="hint">Loading…</p>
              <p v-else-if="!sessions.length" class="hint">No past sessions.</p>
              <button v-for="s in sessions ?? []" :key="s.session" type="button" class="conv" @click="openPast(s.session)"><span class="cp">{{ s.preview || "(no messages)" }}</span><span class="cm">{{ new Date(s.updated).toLocaleString() }} · {{ s.messages }} messages</span></button>
            </div>
          </div>
          <pre v-else ref="rawBox" class="bterm bws-term">{{ raw || "connecting…" }}</pre>
        </template>

        <div v-else class="bws-pad bstopped">
          <div class="bst"><b>{{ label(bot.channel) }} is stopped</b><span>Start it fresh, or pick up a past session.</span></div>
          <div class="bst-a">
            <button type="button" class="btn primary big" :disabled="!!launching" @click="launch(null)">{{ launching === "fresh" ? "Launching…" : "▶ Launch fresh" }}</button>
            <button v-if="sessions?.length" type="button" class="btn big" :disabled="!!launching" @click="launch('last')">{{ launching === "last" ? "Resuming…" : "↻ Resume last" }}</button>
            <button v-if="bot.provider === 'native'" type="button" class="btn danger big" :disabled="!!launching" @click="ask = 'delete'">Delete</button>
          </div>
          <p v-if="sessions === null" class="hint">Loading…</p>
          <div v-for="s in sessions ?? []" :key="s.session" class="conv static">
            <span class="cp">{{ s.preview || "(no messages)" }}</span><span class="cm">{{ new Date(s.updated).toLocaleString() }} · {{ s.messages }} messages</span>
            <button type="button" class="btn" :disabled="!!launching" @click="launch(s.session)">{{ launching === s.session ? "Resuming…" : "▶ Resume" }}</button>
          </div>
        </div>
      </section>

      <!-- session panel -->
      <div v-if="bot && !creating && info" class="bws-bd" @click="info = false"></div>
      <div v-if="bot && !creating" class="bws-r" :role="info ? 'dialog' : undefined" :aria-label="info ? 'Bot info' : undefined">
        <div class="bws-rh"><b>Info</b><button type="button" class="btn sm" aria-label="Close info" @click="info = false">Close</button></div>
        <BotInspector :bot="bot" :meta="meta" @workspace="tab = 'workspace'; mobile = 'chat'; info = false" @new-job="newJob = true; info = false" @restart="ask = 'restart'" @stop="ask = 'stop'" @instructions="openInstr" @remove="ask = 'delete'" />
      </div>

      <NewJob v-if="newJob && bot" :channel="bot.channel" @close="newJob = false" />

      <Teleport to="body">
        <div v-if="instr" class="dlg-wrap">
          <div class="dlg-bg" @click="instr = null"></div>
          <div class="dlg wide" role="dialog" aria-modal="true" aria-label="Bot instructions">
            <h2>Instructions</h2>
            <p class="muted" style="margin: 0"><code>{{ instr.path.replace(/^\/Users\/[^/]+/, "~") }}</code>{{ instr.editable ? " · restart the bot to apply" : " · read-only here" }}</p>
            <textarea v-model="instr.text" class="instr-ta" :readonly="!instr.editable" rows="18" aria-label="CLAUDE.md"></textarea>
            <div style="display: flex; gap: 8px; justify-content: flex-end">
              <button type="button" class="btn" @click="instr = null">{{ instr.editable ? "Cancel" : "Close" }}</button>
              <button v-if="instr.editable" type="button" class="btn primary" :disabled="instrBusy" @click="saveInstr">{{ instrBusy ? "Saving…" : "Save" }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <ConfirmDialog :open="ask === 'stop'" :title="`Stop ${label(bot?.channel ?? '')}?`" :subtitle="bot?.provider === 'native' ? 'Claude Code session' : 'Telegram bot session'" confirm-label="Stop" danger @confirm="act('stop')" @cancel="ask = null">
        <ul><li>Ends the bot's Claude session{{ bot?.provider === "native" && !bot.telegram ? "" : " and its Telegram poller" }}.</li><li>Messages sent to the bot wait until it is launched again.</li><li>Its sessions stay on disk; you can resume them later.</li></ul>
      </ConfirmDialog>
      <ConfirmDialog :open="ask === 'delete'" :title="`Delete ${label(bot?.channel ?? '')}?`" subtitle="Native bot" confirm-label="Delete" danger @confirm="act('delete')" @cancel="ask = null">
        <ul><li>Stops the session if it is running and removes the bot from Server OS.</li><li>Its folder <code>{{ bot?.cwd }}</code> (CLAUDE.md, files, past sessions) is kept.</li></ul>
      </ConfirmDialog>
      <ConfirmDialog :open="ask === 'restart'" :title="`Restart ${label(bot?.channel ?? '')}?`" :subtitle="bot?.provider === 'native' ? 'Claude Code session' : 'Telegram bot session'" confirm-label="Restart" @confirm="act('restart')" @cancel="ask = null">
        <ul><li>Stops and relaunches the session, applying token and scope changes.</li><li>Background jobs end; the bot re-arms what its instructions say.</li></ul>
      </ConfirmDialog>
    </template>
  </main>
</template>
