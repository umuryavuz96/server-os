<script setup lang="ts">
// The agent chat in the Agents side panel: every tool call is its own compact row (icon, verb, target, result),
// runs of the same kind fold into one expandable row ("Read 6 files"), the agent's words are bubbles, and the step
// it is on right now stays pinned at the bottom with a running clock. Read-only; the Bots tab keeps BotFeed.
import { reactive, ref, watch, nextTick, onMounted, onUnmounted, computed } from "vue";
import Icon from "../Icon.vue";
import { md, dur, clock, type FeedItem, type Meta } from "../../bots";
import type { IconName } from "../../icons";

/** Fields the agent chat endpoint adds to a step (all optional: older servers send only title/detail). */
type Step = FeedItem & { verb?: string; target?: string; add?: number; del?: number; res?: string; agmsg?: { dir: "out" | "in"; team?: string; peer?: string }; thinking?: boolean };

const props = defineProps<{ items: FeedItem[]; meta: Meta | null; name: string }>();
const emit = defineEmits<{ messages: [peer: string] }>();
const open = reactive(new Set<string>());
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));

const box = ref<HTMLElement | null>(null);
const stuck = ref(true);
const onScroll = () => { const el = box.value; if (el) stuck.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100; };
async function follow(force = false) { await nextTick(); if ((force || stuck.value) && box.value) box.value.scrollTop = box.value.scrollHeight; }
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(tick));
onMounted(() => follow(true));
watch(() => props.name, () => { stuck.value = true; open.clear(); follow(true); });

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const SENSITIVE = /^(Shell|Monitor)$/;
const kindOf = (s: Step): string => {
  const t = (s.tool ?? "").split(" · ")[0];
  if (s.agmsg) return "agmsg";
  return t;
};
const ICON_OF: Record<string, IconName> = { agmsg: "message", Shell: "square-terminal", Monitor: "activity", Read: "file-text", Write: "pencil", Edit: "pencil", Grep: "search", Glob: "search", ToolSearch: "search", WebSearch: "globe", WebFetch: "globe", Chrome: "globe", Agent: "bot", Task: "bot", Skill: "sparkles", Telegram: "send" };
const iconOf = (s: Step): IconName => ICON_OF[kindOf(s)] ?? "plug";
// the server's verb is a real verb ("Read", "Ran"); for tools without one it repeats the tool name, so use the title then
const verbOf = (s: Step) => (s.verb && s.verb !== (s.tool ?? "").split(" · ")[0] ? s.verb : s.title?.split(" ")[0] ?? s.verb ?? "Step");
const tail = (t: string) => { if (!t.includes("/") || t.length < 36) return t; const p = t.split("/").filter(Boolean); return "…/" + p.slice(-2).join("/"); };
/** The text after the verb: the server's target, else what the title says, else a path for file tools. Never a shell command line. */
const targetOf = (s: Step) => {
  if (s.agmsg) return s.agmsg.peer ? (s.agmsg.dir === "out" ? `to ${s.agmsg.peer}` : `from ${s.agmsg.peer}`) : "";
  if (s.target) return tail(s.target);
  const t = s.title ?? "";
  const rest = s.verb && t.startsWith(s.verb) ? t.slice(s.verb.length).trim() : t.includes(" ") ? t.slice(t.indexOf(" ") + 1) : "";
  if (SENSITIVE.test(kindOf(s))) return clip(s.verb ? rest : t, 90);
  return rest || (s.detail ? base(s.detail) : "");
};
const labelOf = (s: Step) => (s.agmsg ? `${s.agmsg.dir === "out" ? "Sent" : "Got"} agmsg` : verbOf(s));
const NOUN: Record<string, [string, string]> = { Read: ["file", "files"], Edited: ["file", "files"], Wrote: ["file", "files"], Ran: ["command", "commands"], Searched: ["search", "searches"], Listed: ["listing", "listings"], Fetched: ["page", "pages"], Loaded: ["tool set", "tool sets"] };
const groupLabel = (verb: string, n: number) => { const w = NOUN[verb]; return w ? `${verb} ${n} ${w[1]}` : `${verb} ×${n}`; };

type Row =
  | { key: string; type: "msg"; item: FeedItem }
  | { key: string; type: "think"; item: FeedItem }
  | { key: string; type: "step"; step: Step }
  | { key: string; type: "group"; steps: Step[]; verb: string; icon: IconName; failed: boolean; ts: number }
  | { key: string; type: "note"; item: FeedItem };

const GROUP_MIN = 3;
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  let run: Step[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) out.push({ key: "g" + run[0].id, type: "group", steps: run, verb: verbOf(run[0]), icon: iconOf(run[0]), failed: run.some((s) => s.status === "error"), ts: run[0].ts });
    else for (const s of run) out.push({ key: s.id, type: "step", step: s });
    run = [];
  };
  for (const it of props.items) {
    if (it.kind === "step") {
      const s = it as Step;
      // a step still running stays on its own row; a finished one joins the run of the same verb and kind
      if (s.status !== "running" && run.length && verbOf(run[0]) === verbOf(s) && kindOf(run[0]) === kindOf(s) && !s.agmsg) { run.push(s); continue; }
      flush();
      if (s.status !== "running" && !s.agmsg) run = [s]; else out.push({ key: s.id, type: "step", step: s });
      continue;
    }
    flush();
    if (it.kind === "event") out.push({ key: it.id, type: "note", item: it });
    else if ((it as Step).thinking) out.push({ key: it.id, type: "think", item: it });
    else out.push({ key: it.id, type: "msg", item: it });
  }
  flush();
  return out;
});

const working = computed(() => props.meta?.session?.working ?? null);
const runningStep = computed(() => { for (let i = props.items.length - 1; i >= 0; i--) { const it = props.items[i]; if (it.kind === "step") return it.status === "running" ? (it as Step) : null; } return null; });
watch(() => [rows.value.length, props.items.at(-1)?.id, props.items.at(-1)?.status, working.value?.step], () => follow());

const VIA: Record<string, string> = { telegram: "to Telegram", dash: "from Server OS", terminal: "" };
</script>

<template>
  <div class="af-wrap">
    <div ref="box" class="af" @scroll.passive="onScroll">
      <div class="af-in">
        <p v-if="!rows.length" class="af-empty">Nothing in this session yet.</p>
        <template v-for="r in rows" :key="r.key">
          <div v-if="r.type === 'msg'" class="bm" :class="r.item.kind === 'user' ? 'me' : 'bot'">
            <div v-if="r.item.kind === 'user'" class="bb me">{{ r.item.text }}</div>
            <!-- eslint-disable-next-line vue/no-v-html — sanitized with DOMPurify in md() -->
            <article v-else class="bb bot md" v-html="md(r.item.id, r.item.text ?? '')"></article>
            <span class="bmeta">{{ r.item.kind === "user" ? (r.item.via === "telegram" ? "On Telegram" : r.item.via === "dash" ? "From Server OS" : "Prompt") : VIA[r.item.via ?? ""] || "Said" }} · {{ clock(r.item.ts) }}</span>
          </div>

          <p v-else-if="r.type === 'think'" class="af-think"><Icon name="sparkles" :size="12" /><span>{{ clip(r.item.text ?? "", 400) }}</span></p>

          <div v-else-if="r.type === 'step'" class="af-r" :class="{ run: r.step.status === 'running', err: r.step.status === 'error' }">
            <span class="af-i" :class="kindOf(r.step) === 'agmsg' ? 'ag' : ''"><Icon :name="iconOf(r.step)" :size="14" /></span>
            <span class="af-c">
              <span class="af-l"><b>{{ labelOf(r.step) }}</b><span v-if="targetOf(r.step)" class="af-t">{{ targetOf(r.step) }}</span>
                <span v-if="r.step.add || r.step.del" class="af-diff"><i v-if="r.step.add" class="p">+{{ r.step.add }}</i><i v-if="r.step.del" class="m">−{{ r.step.del }}</i></span></span>
              <span v-if="r.step.res || r.step.status === 'error'" class="af-res" :class="{ bad: r.step.status === 'error' }">{{ r.step.res || "failed" }}</span>
            </span>
            <button v-if="r.step.agmsg?.peer" type="button" class="af-link" @click="emit('messages', r.step.agmsg!.peer!)">Messages</button>
            <span class="af-ms num">{{ r.step.status === "running" ? dur(Math.max(0, now - r.step.ts)) : r.step.ms ? dur(r.step.ms) : "" }}</span>
          </div>

          <div v-else-if="r.type === 'group'" class="af-g">
            <button type="button" class="af-r af-gh" :class="{ err: r.failed }" :aria-expanded="open.has(r.key)" @click="toggle(r.key)">
              <span class="af-i"><Icon :name="r.icon" :size="14" /></span>
              <span class="af-c"><span class="af-l"><b>{{ groupLabel(r.verb, r.steps.length) }}</b></span></span>
              <Icon name="chevron-down" :size="14" class="af-chev" :class="{ on: open.has(r.key) }" />
            </button>
            <div v-if="open.has(r.key)" class="af-gl">
              <div v-for="s in r.steps" :key="s.id" class="af-r sub" :class="{ err: s.status === 'error' }">
                <span class="af-i"><Icon :name="iconOf(s)" :size="13" /></span>
                <span class="af-c"><span class="af-l"><span class="af-t">{{ targetOf(s) || labelOf(s) }}</span>
                  <span v-if="s.add || s.del" class="af-diff"><i v-if="s.add" class="p">+{{ s.add }}</i><i v-if="s.del" class="m">−{{ s.del }}</i></span></span>
                  <span v-if="s.res || s.status === 'error'" class="af-res" :class="{ bad: s.status === 'error' }">{{ s.res || "failed" }}</span></span>
                <span class="af-ms num">{{ s.ms ? dur(s.ms) : "" }}</span>
              </div>
            </div>
          </div>

          <p v-else class="af-note" :class="{ ag: (r.item as Step).agmsg }"><Icon name="message" :size="12" />
            <span v-if="(r.item as Step).agmsg"><b>Got agmsg</b> {{ (r.item as Step).agmsg?.peer ? `from ${(r.item as Step).agmsg?.peer}` : "" }}</span>
            <span v-else>{{ clip(r.item.text ?? "", 140) }}</span>
            <button v-if="(r.item as Step).agmsg?.peer" type="button" class="af-link" @click="emit('messages', (r.item as Step).agmsg!.peer!)">Messages</button></p>
        </template>
      </div>
    </div>
    <button v-if="!stuck" type="button" class="af-jump" @click="stuck = true; follow(true)"><Icon name="arrow-down" :size="13" /> Latest</button>
    <div v-if="working" class="af-now" role="status">
      <span class="af-spin" aria-hidden="true"></span>
      <span class="af-nc"><b>{{ runningStep ? labelOf(runningStep) : "Working" }}</b><span>{{ runningStep ? targetOf(runningStep) || working.step : working.step ?? "thinking" }}</span></span>
      <span class="num af-nt">{{ dur(Math.max(0, now - working.since)) }}</span>
    </div>
  </div>
</template>

<style scoped>
.af-wrap{position:relative;flex:1 1 0;min-height:0;display:flex;flex-direction:column}
.af{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.af-in{padding:10px 6px 14px;display:flex;flex-direction:column;gap:4px}
.af-empty{color:var(--muted);text-align:center;margin:30px 0;font-size:13px}
.af-in :deep(.bm){margin:8px 0}
.af-r{display:grid;grid-template-columns:24px minmax(0,1fr) auto auto;gap:8px;align-items:start;padding:5px 8px;border-radius:8px;width:100%;box-sizing:border-box;background:none;border:0;color:inherit;text-align:left;font:inherit}
.af-r.run{background:rgba(255,178,30,.07)}
.af-r.err .af-l b{color:var(--bad)}
.af-r.sub{padding:3px 8px 3px 4px}
.af-i{width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:#1b1b1f;color:#b4b4bb;flex:none}
.af-i.ag{background:rgba(47,211,138,.14);color:var(--on)}
.af-r.run .af-i{background:rgba(255,178,30,.16);color:var(--warn)}
.af-c{display:flex;flex-direction:column;min-width:0;gap:1px;padding-top:2px}
.af-l{display:flex;gap:6px;align-items:baseline;min-width:0;font:500 12.5px var(--body);color:#c9c9ce}
.af-l b{flex:none;font-weight:600;color:#e2e2e6;white-space:nowrap}
.af-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px;color:#a8a8b0}
.af-diff{display:inline-flex;gap:5px;font:600 11px var(--mono);flex:none}.af-diff .p{color:var(--on);font-style:normal}.af-diff .m{color:var(--bad);font-style:normal}
.af-res{font:500 11.5px var(--body);color:#8a8a92;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.af-res.bad{color:var(--bad)}
.af-ms{font:500 11px var(--mono);color:#7a7a82;padding-top:4px;min-width:0}
.af-link{background:none;border:0;color:var(--muted);font:600 11px var(--body);text-decoration:underline;cursor:pointer;padding:3px 0 0;min-height:24px}
.af-gh{cursor:pointer;grid-template-columns:24px minmax(0,1fr) auto;min-height:32px;align-items:center}
.af-gh:hover{background:#121215}
.af-chev{color:#7a7a82;transition:transform .2s var(--ease)}.af-chev.on{transform:rotate(180deg)}
.af-gl{margin:0 0 4px 12px;padding-left:6px;border-left:1px solid #232327}
.af-gl .af-r{grid-template-columns:24px minmax(0,1fr) auto}
.af-think{display:flex;gap:7px;margin:4px 8px;font:italic 500 12px/1.45 var(--body);color:#8a8a92}.af-think svg{flex:none;margin-top:2px}.af-think span{overflow-wrap:anywhere}
.af-note{display:flex;gap:7px;align-items:center;margin:2px 8px;font:500 11.5px var(--body);color:#7a7a82}.af-note svg{flex:none}.af-note.ag{color:#a8a8b0}.af-note.ag svg{color:var(--on)}.af-note b{color:#e2e2e6;font-weight:600}.af-note .af-link{margin-left:auto;padding:0}.af-note span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.af-now{display:flex;align-items:center;gap:10px;margin:0 6px 6px;padding:9px 12px;border-radius:12px;border:1px solid rgba(255,178,30,.35);background:rgba(20,16,8,.96);flex:none}
.af-nc{display:flex;flex-direction:column;min-width:0;flex:1;font:500 11.5px var(--mono);color:#c9c9ce}.af-nc b{font:600 13px var(--body);color:#e2e2e6}
.af-nc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.af-nt{font-size:12px;color:var(--warn)}
.af-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,178,30,.3);border-top-color:var(--warn);animation:af-s .9s linear infinite;box-sizing:border-box;flex:none}
@keyframes af-s{to{transform:rotate(360deg)}}
.af-jump{position:absolute;right:12px;bottom:64px;display:inline-flex;gap:5px;align-items:center;min-height:32px;padding:0 12px;border-radius:999px;border:1px solid #2a2a30;background:#17171b;color:var(--ink);font:600 12px var(--body);cursor:pointer}
@media(prefers-reduced-motion:reduce){.af-spin{animation:none}.af-chev{transition:none}}
</style>
