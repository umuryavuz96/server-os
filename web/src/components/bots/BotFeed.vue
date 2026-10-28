<script setup lang="ts">
// The chat: messages (bot output as Markdown), the tool steps between them folded into one "Worked for …" row,
// runs of background notices folded into one line, and a live row while the bot is working.
import { reactive, ref, watch, nextTick, onMounted, onUnmounted, computed } from "vue";
import { md, dur, clock, type Block, type Meta } from "../../bots";

const props = defineProps<{ blocks: Block[]; meta: Meta | null; name: string; canInterrupt: boolean; stop?: { state: "idle" | "stopping" | "stopped" | "still" | "error"; msg: string } }>();
const emit = defineEmits<{ interrupt: []; retry: [nonce: string, text: string]; dismiss: [nonce: string] }>();
const stopping = computed(() => props.stop?.state === "stopping");
const open = reactive(new Set<string>());
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));

const box = ref<HTMLElement | null>(null);
let stick = true;
const onScroll = () => { const el = box.value; if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
async function follow() { await nextTick(); if (stick && box.value) box.value.scrollTop = box.value.scrollHeight; }
watch(() => [props.blocks.length, props.blocks.at(-1)?.key, props.meta?.session?.working?.step], follow);
watch(() => props.name, () => { stick = true; open.clear(); follow(); });
onMounted(follow);

const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(tick));
const working = computed(() => props.meta?.session?.working ?? null);

const VIA: Record<string, string> = { telegram: "on Telegram", dash: "from Server OS", terminal: "in the session" };
const tools = (b: Extract<Block, { type: "work" }>) => [...new Set(b.steps.map((s) => (s.tool ?? "").split(" · ")[0]))].slice(0, 4).join(", ");
const short = (s: string | undefined, n = 160) => (!s ? "" : s.length > n ? s.slice(0, n) + "…" : s);
const ICON: Record<string, string> = { Shell: "$", Read: "R", Edit: "E", Write: "W", Grep: "?", Glob: "*", Telegram: "TG", Chrome: "CH", Monitor: "M", Skill: "SK", WebFetch: "WB", WebSearch: "WB", Agent: "AG", ToolSearch: "TS", CronCreate: "CR" };
const icon = (tool = "") => ICON[tool.split(" · ")[0]] ?? tool.slice(0, 2).toUpperCase();
const fam = (tool = "") => { const t = tool.split(" · ")[0]; return t === "Telegram" ? "tg" : t === "Chrome" ? "ch" : t === "Shell" ? "sh" : tool.includes(" · ") ? "mcp" : "core"; };
</script>

<template>
  <div ref="box" class="bf" @scroll.passive="onScroll">
    <div class="bf-in">
      <p v-if="!blocks.length" class="bf-empty">No messages in this session yet.</p>
      <template v-for="b in blocks" :key="b.key">
        <!-- message -->
        <div v-if="b.type === 'msg'" class="bm" :class="b.item.kind === 'user' ? 'me' : 'bot'">
          <div v-if="b.item.kind === 'user'" class="bb me" :class="{ pending: b.item.local === 'sending' || b.item.local === 'queued', failed: b.item.local === 'failed' }">{{ b.item.text }}</div>
          <!-- eslint-disable-next-line vue/no-v-html — sanitized with DOMPurify in md() -->
          <article v-else class="bb bot md" :class="{ quiet: b.item.via === 'terminal' }" v-html="md(b.item.id, b.item.text ?? '')"></article>
          <span class="bmeta">
            <template v-if="b.item.local === 'sending'">Sending…</template>
            <template v-else-if="b.item.local === 'queued'">Sent · waiting for the bot to pick it up</template>
            <template v-else-if="b.item.local === 'failed'"><span class="bfail">Not sent: {{ b.item.error }}</span> · <button type="button" class="blink" @click="emit('retry', b.item.nonce!, b.item.text!)">Retry</button> · <button type="button" class="blink" @click="emit('dismiss', b.item.nonce!)">Dismiss</button></template>
            <template v-else-if="b.item.kind === 'user'">{{ b.item.via === "telegram" ? (b.item.from ? `${b.item.from} on Telegram` : "On Telegram") : b.item.via === "dash" ? "You, from Server OS" : "Typed in the session" }}</template>
            <template v-else>{{ b.item.via === "telegram" ? "Sent to Telegram" : "Said in the session" }}</template>
            <template v-if="!b.item.local"> · {{ clock(b.item.ts) }}</template>
          </span>
        </div>

        <!-- tool steps -->
        <div v-else-if="b.type === 'work'" class="bw">
          <button type="button" class="bw-h" :aria-expanded="open.has(b.key)" @click="toggle(b.key)">
            <span class="bw-i" :class="b.running ? 'run' : b.steps.some((s) => s.status === 'error') ? 'fail' : 'ok'" aria-hidden="true">
              <svg v-if="!b.running" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path v-if="b.steps.some((s) => s.status === 'error')" d="M12 7v6M12 17h.01" /><path v-else d="M5 12l5 5 9-10" /></svg>
            </span>
            <b>{{ b.running ? "Working" : `Worked for ${dur(Math.max(1000, b.end - b.start))}` }}</b>
            <span class="bw-s">{{ b.steps.length }} {{ b.steps.length === 1 ? "step" : "steps" }} · {{ tools(b) }}</span>
            <span class="bw-t">{{ open.has(b.key) ? "Hide" : "Show" }}</span>
          </button>
          <ol v-if="open.has(b.key)" class="bw-l">
            <li v-for="s in b.steps" :key="s.id" class="bw-r">
              <span class="bw-k" :class="fam(s.tool)">{{ icon(s.tool) }}</span>
              <span class="bw-c">
                <span class="bw-ti">{{ s.title }}<em v-if="s.status === 'error'"> · failed</em></span>
                <code v-if="s.detail" class="bw-d">{{ short(s.detail) }}</code>
                <details v-if="s.out" class="bw-o"><summary>Output</summary><pre>{{ s.out }}</pre></details>
              </span>
              <span class="bw-ms">{{ s.status === "running" ? "…" : dur(s.ms ?? 0) }}</span>
            </li>
          </ol>
        </div>

        <!-- background notices -->
        <div v-else class="be">
          <button type="button" class="be-h" :aria-expanded="open.has(b.key)" @click="toggle(b.key)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>
            {{ b.items.length === 1 ? short(b.items[0].text, 80) : `${b.items.length} background notices` }}<template v-if="b.handled.length"> · handled by the bot</template>
          </button>
          <ul v-if="open.has(b.key)" class="be-l">
            <li v-for="e in [...b.items, ...b.handled].sort((x, y) => x.ts - y.ts)" :key="e.id" :class="{ h: e.kind !== 'event' }"><span class="num">{{ clock(e.ts) }}</span>{{ e.kind === "step" ? `↳ ${e.title}` : e.kind === "assistant" ? `↳ ${short(e.text, 200)}` : e.text }}</li>
          </ul>
        </div>
      </template>

      <div v-if="working" class="blive" role="status">
        <span class="spin" aria-hidden="true"></span>
        <span class="blive-c"><b>Working</b><code>{{ working.step ?? "thinking" }}</code></span>
        <span class="num blive-t">{{ dur(Math.max(0, now - working.since)) }}</span>
        <button v-if="canInterrupt" type="button" class="btn" :disabled="stopping" :aria-busy="stopping" @click="emit('interrupt')">{{ stopping ? "Stopping…" : "Interrupt" }}</button>
      </div>
      <p v-if="stop && (stop.state === 'stopped' || stop.state === 'still' || stop.state === 'error')" class="bstop" :class="stop.state" role="status">{{ stop.msg }}</p>
    </div>
  </div>
</template>
