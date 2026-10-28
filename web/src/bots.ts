// Live feed of one bot's Claude Code session (/api/v1/bots/:ch/feed). Items are patched in place by id, so the chat
// never re-renders wholesale; groups (tool steps between messages, runs of background notices) are derived here.
import { ref, shallowRef, triggerRef, computed, onUnmounted, watch, type Ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";

export type Via = "telegram" | "dash" | "terminal";
export interface FeedItem {
  id: string; kind: "user" | "assistant" | "step" | "event"; ts: number;
  text?: string; via?: Via; from?: string; nonce?: string;
  local?: "sending" | "queued" | "failed"; error?: string; // set only on the page's own optimistic bubbles
  tool?: string; title?: string; detail?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string;
}
export interface BgJob {
  id: string; taskId: string | null; kind: "monitor" | "shell" | "agent"; name: string; command: string;
  started: number; ended: number | null; endReason: string | null; events: number; lastEvent: string | null; lastEventAt: number | null;
  timeoutMs: number | null; rearms: number; request: string | null;
}
export interface Schedule { id: string; cronId: string | null; cron: string; prompt: string; recurring: boolean; created: number; request: string | null }
export interface BotRequest {
  id: string; channel: string; kind: "watch" | "schedule" | "task"; name: string; what: string; created: number;
  options: Record<string, string | boolean | undefined>; status: "pending" | "running" | "failed"; reason: string | null; job: string | null;
}
export interface Meta {
  session: { session: string; model: string | null; contextTokens: number; contextLimit: number; permissionMode: string | null; working: { since: number; step: string | null } | null; lastActivity: number } | null;
  effort: string | null; launchModel: string | null; jobs: BgJob[]; schedules: Schedule[]; requests: BotRequest[];
  running: boolean; protected: boolean; tmux: boolean;
}

export type Block =
  | { key: string; type: "msg"; item: FeedItem }
  | { key: string; type: "work"; steps: FeedItem[]; start: number; end: number; running: boolean }
  | { key: string; type: "events"; items: FeedItem[]; handled: FeedItem[] };

/** Messages stand alone; consecutive tool steps become one "work" block; consecutive notices one "events" block.
 *  A turn the bot takes on its own because of a notice (re-arming a monitor, "no reply needed") folds into that
 *  notice block too — unless it sends something to Telegram, which stays in the chat. */
export function blocks(items: FeedItem[]): Block[] {
  const out: Block[] = [];
  let background = false;
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "user") background = false;
    else if (it.kind === "event") background = true;
    if (background && (it.kind === "step" || (it.kind === "assistant" && it.via !== "telegram"))) {
      const ev = [...out].reverse().find((b) => b.type === "events") as Extract<Block, { type: "events" }> | undefined;
      if (ev) { ev.handled.push(it); continue; }
    }
    if (it.kind === "step") {
      if (last?.type === "work") { last.steps.push(it); last.end = Math.max(last.end, it.ts + (it.ms ?? 0)); last.running ||= it.status === "running"; }
      else out.push({ key: "w" + it.id, type: "work", steps: [it], start: it.ts, end: it.ts + (it.ms ?? 0), running: it.status === "running" });
    } else if (it.kind === "event") {
      if (last?.type === "events") last.items.push(it);
      else out.push({ key: "e" + it.id, type: "events", items: [it], handled: [] });
    } else out.push({ key: it.id, type: "msg", item: it });
  }
  return out;
}

const mdCache = new Map<string, string>();
/** Markdown → sanitized HTML (bot output; Telegram text from people stays plain). */
export function md(id: string, text: string) {
  const k = id + ":" + text.length;
  let h = mdCache.get(k);
  if (h === undefined) {
    h = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false }) as string, { FORBID_TAGS: ["style", "img", "iframe", "form", "input"] });
    if (mdCache.size > 2000) mdCache.clear();
    mdCache.set(k, h);
  }
  return h;
}

export const family = (m: string | null | undefined) => (m?.toLowerCase().match(/fable|opus|sonnet|haiku/)?.[0] ?? null) as "fable" | "opus" | "sonnet" | "haiku" | null;
export const modelLabel = (m: string | null | undefined) => {
  if (!m) return "—";
  const f = family(m); const v = m.match(/(\d+)[-.](\d+)/);
  return f ? `${f[0].toUpperCase()}${f.slice(1)}${v ? ` ${v[1]}.${v[2]}` : ""}` : m;
};
export const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 && s < 600 ? ` ${s % 60} s` : ""}` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`; };
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const ECHO_TTL = 15 * 60_000; // an unclaimed bubble (prompt queued behind a very long turn) is dropped after this
let nonceN = 0;
export const newNonce = () => `${Date.now().toString(36)}${(++nonceN).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function useFeed(channel: Ref<string | null>) {
  const items = shallowRef<FeedItem[]>([]);
  /** What was typed here and isn't in the transcript yet: shown at once, replaced by the real line (same nonce) when it lands. */
  const echoes = ref<FeedItem[]>([]);
  const prune = () => {
    if (!echoes.value.length) return;
    const have = new Set(items.value.map((i) => i.nonce).filter(Boolean));
    const now = Date.now();
    const keep = echoes.value.filter((e) => !have.has(e.nonce) && now - e.ts < ECHO_TTL);
    if (keep.length !== echoes.value.length) echoes.value = keep;
  };
  function echo(text: string, nonce = newNonce()): string {
    echoes.value = [...echoes.value.filter((e) => e.nonce !== nonce), { id: "local:" + nonce, kind: "user", ts: Date.now(), text, via: "dash", nonce, local: "sending" }];
    return nonce;
  }
  function echoState(nonce: string, local: FeedItem["local"], error?: string) {
    echoes.value = echoes.value.map((e) => (e.nonce === nonce ? { ...e, local, error } : e));
  }
  const dismiss = (nonce: string) => { echoes.value = echoes.value.filter((e) => e.nonce !== nonce); };
  const meta = ref<Meta | null>(null);
  const state = ref<"connecting" | "live" | "error">("connecting");
  let es: EventSource | null = null;
  const index = new Map<string, number>();
  function reset(list: FeedItem[]) { index.clear(); list.forEach((it, i) => index.set(it.id, i)); items.value = list; prune(); }
  function upsert(list: FeedItem[]) {
    const arr = items.value;
    for (const it of list) { const i = index.get(it.id); if (i === undefined) { index.set(it.id, arr.length); arr.push(it); } else arr[i] = it; }
    triggerRef(items);
    prune();
  }
  function close() { es?.close(); es = null; }
  function open(ch: string) {
    close(); reset([]); echoes.value = []; meta.value = null; state.value = "connecting";
    es = new EventSource(`/api/v1/bots/${encodeURIComponent(ch)}/feed`);
    es.addEventListener("reset", (e) => { const d = JSON.parse((e as MessageEvent).data); reset(d.items); meta.value = d.meta; state.value = "live"; });
    es.addEventListener("items", (e) => upsert(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("meta", (e) => { meta.value = JSON.parse((e as MessageEvent).data); });
    es.onerror = () => { state.value = "error"; }; // EventSource reconnects by itself; the server re-sends a reset
  }
  watch(channel, (ch) => (ch ? open(ch) : close()), { immediate: true });
  onUnmounted(close);
  const grouped = computed(() => blocks(echoes.value.length ? [...items.value, ...echoes.value] : items.value));
  return { items, grouped, meta, state, echo, echoState, dismiss, echoes };
}
