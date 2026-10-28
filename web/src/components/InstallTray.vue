<script setup lang="ts">
// Installs, everywhere: a pill on every page while something installs (or just finished), opening a panel with each
// app's state, progress and checklist; a banner when one becomes ready or fails while you are elsewhere.
// Driven by the server's "lifecycle" slice, so it matches the Discover drawer and the apps exactly.
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { S } from "../store";
import AppIcon from "./AppIcon.vue";
import Checklist from "./discover/Checklist.vue";
import { BUSY, LIFE_LABEL, type Life } from "./discover/types";

const RECENT = 10 * 60_000; // finished installs stay in the tray this long (or until dismissed)
const lifeMap = computed(() => (S as unknown as { lifecycle?: Record<string, Life> }).lifecycle ?? {});
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval>;
onMounted(() => { tick = setInterval(() => (now.value = Date.now()), 1000); });
onUnmounted(() => clearInterval(tick));

const dismissed = ref(new Set<string>());
const busy = (l: Life) => BUSY.includes(l.state);
const entries = computed(() => Object.entries(lifeMap.value)
  .filter(([id, l]) => busy(l) || (l.checklist.length && now.value - l.since < RECENT && !dismissed.value.has(`${id}:${l.since}`)))
  .map(([id, l]) => ({ id, ...l }))
  .sort((a, b) => Number(busy(b)) - Number(busy(a)) || b.since - a.since));
const busyCount = computed(() => entries.value.filter(busy).length);
const progress = (l: Life) => { const d = l.checklist.filter((c) => c.state === "done" || c.state === "skipped").length; return { d, n: l.checklist.length }; };
const open = ref(false), expanded = ref<string | null>(null);
const pillText = computed(() => {
  const b = entries.value.filter(busy);
  if (b.length === 1) { const p = progress(b[0]); return `${LIFE_LABEL[b[0].state]} ${b[0].name}${p.n ? ` · ${p.d}/${p.n}` : ""}`; }
  if (b.length > 1) return `${b.length} installs running`;
  const f = entries.value.filter((e) => e.state === "failed" || e.state === "setup-failed").length;
  return f ? `${f} install${f > 1 ? "s" : ""} need${f > 1 ? "" : "s"} a look` : `${entries.value.length} install${entries.value.length > 1 ? "s" : ""} done`;
});
const elapsed = (since: number) => { const s = Math.max(0, Math.round((now.value - since) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const detail = (e: Life) => { const t = e.state === "failed" || e.state === "setup-failed" ? e.error ?? e.step : e.step; return t && t !== LIFE_LABEL[e.state] && t !== "Ready to use" ? t : ""; };
const view = (id: string) => { open.value = false; location.hash = `#discover?app=${encodeURIComponent(id)}`; };
const dismiss = (e: { id: string; since: number }) => { const s = new Set(dismissed.value); s.add(`${e.id}:${e.since}`); dismissed.value = s; };

// Banner when an app finishes (ready or failed) — not for ones already finished when the page loaded.
const banner = ref<{ id: string; name: string; ok: boolean; href: string | null } | null>(null);
let seen: Record<string, string> | null = null, hide: ReturnType<typeof setTimeout>;
// The slice is patched in place, so watch a key of every app's state, not the object.
watch(() => Object.entries(lifeMap.value).map(([id, l]) => `${id}:${l.state}`).join(), () => {
  const m = lifeMap.value;
  const cur = Object.fromEntries(Object.entries(m).map(([id, l]) => [id, l.state]));
  if (seen) for (const [id, st] of Object.entries(cur)) {
    const was = seen[id];
    if (was && BUSY.includes(was as never) && (st === "ready" || st === "installed" || st === "failed" || st === "setup-failed")) {
      banner.value = { id, name: m[id].name, ok: st === "ready" || st === "installed", href: m[id].href };
      clearTimeout(hide); hide = setTimeout(() => (banner.value = null), 12_000);
    }
  }
  seen = cur;
}, { immediate: true });
</script>

<template>
  <div class="itray">
    <Transition name="ban">
      <div v-if="banner" class="itray-ban" :class="banner.ok ? 'ok' : 'bad'" role="status">
        <span class="b-dot" aria-hidden="true"></span>
        <span class="b-t"><b>{{ banner.name }}</b> {{ banner.ok ? "is ready" : "didn't install" }}</span>
        <a v-if="banner.ok && banner.href" class="b-a" :href="banner.href" target="_blank" rel="noopener">Open</a>
        <button type="button" class="b-a" @click="view(banner.id); banner = null">{{ banner.ok ? "Details" : "See why" }}</button>
        <button type="button" class="b-x" aria-label="Dismiss" @click="banner = null">✕</button>
      </div>
    </Transition>

    <section v-if="open && entries.length" class="itray-panel" aria-label="Installs">
      <header><b>Installs</b><button type="button" class="b-x" aria-label="Close installs" @click="open = false">✕</button></header>
      <div v-for="e in entries" :key="e.id" class="itray-row">
        <div class="it-h">
          <AppIcon :name="e.name" :icon="e.logo ?? ''" class="xs" />
          <div class="it-n">
            <b>{{ e.name }}</b>
            <small :class="`st-${e.state}`"><span v-if="busy(e)" class="spin" aria-hidden="true"></span>{{ LIFE_LABEL[e.state] }}<template v-if="busy(e)"> · {{ elapsed(e.since) }}</template><template v-if="detail(e)"> · {{ detail(e) }}</template></small>
          </div>
          <span v-if="progress(e).n" class="mono muted">{{ progress(e).d }}/{{ progress(e).n }}</span>
        </div>
        <div v-if="progress(e).n" class="itray-bar"><i :style="{ width: `${(progress(e).d / progress(e).n) * 100}%` }" :class="{ bad: e.state === 'failed' || e.state === 'setup-failed' }"></i></div>
        <Checklist v-if="expanded === e.id" :items="e.checklist" compact />
        <div class="it-a">
          <button v-if="e.checklist.length" type="button" class="lnk" :aria-expanded="expanded === e.id" @click="expanded = expanded === e.id ? null : e.id">{{ expanded === e.id ? "Hide steps" : "Show steps" }}</button>
          <button type="button" class="lnk" @click="view(e.id)">View</button>
          <a v-if="!busy(e) && e.href && e.state !== 'failed'" class="lnk" :href="e.href" target="_blank" rel="noopener">Open ↗</a>
          <button v-if="!busy(e)" type="button" class="lnk dim" @click="dismiss(e)">Dismiss</button>
        </div>
      </div>
    </section>

    <button v-if="entries.length" type="button" class="itray-pill" :class="{ idle: !busyCount }" :aria-expanded="open" @click="open = !open">
      <span v-if="busyCount" class="spin" aria-hidden="true"></span><span v-else class="b-dot ok" aria-hidden="true"></span>
      {{ pillText }}
    </button>
  </div>
</template>

<style scoped>
.itray { position: fixed; right: 20px; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); z-index: 30; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; pointer-events: none; max-width: calc(100vw - 32px) }
.itray > * { pointer-events: auto }
.itray, .itray * { text-decoration: none }
.itray .lnk { text-decoration: underline }
.itray-pill { display: inline-flex; align-items: center; gap: 10px; height: 44px; padding: 0 18px; border-radius: 999px; border: 1px solid #2c2c31; background: #151517; color: var(--ink); font: 700 14px var(--body); cursor: pointer; box-shadow: 0 12px 30px rgba(0,0,0,.45); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.itray-pill:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }
.itray-panel { width: min(380px, calc(100vw - 32px)); max-height: min(70vh, 560px); overflow: auto; background: #111113; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,.55); padding: 12px 14px; display: flex; flex-direction: column; gap: 12px }
.itray-panel header { display: flex; align-items: center; justify-content: space-between }
.itray-row { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid #1d1d22 }
.itray-row:first-of-type { border-top: 0; padding-top: 0 }
.it-h { display: flex; align-items: center; gap: 10px; min-width: 0 }
.it-n { display: flex; flex-direction: column; min-width: 0; flex: 1 }
.it-n small { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.st-ready, .st-installed { color: #6fe0ab !important }
.st-failed, .st-setup-failed { color: #ffb3b3 !important }
.itray-bar { height: 4px; border-radius: 2px; background: #232327; overflow: hidden }
.itray-bar i { display: block; height: 100%; background: #3ecf8e; transition: width .4s }
.itray-bar i.bad { background: #ff7a7a }
.it-a { display: flex; gap: 14px; flex-wrap: wrap }
.lnk { background: none; border: 0; padding: 0; color: var(--ink); font: 600 13px var(--body); cursor: pointer; text-decoration: underline; text-underline-offset: 3px }
.lnk.dim { color: var(--muted) }
.mono { font-family: var(--mono); font-size: 12px }
.itray-ban { display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-radius: 14px; background: #151517; border: 1px solid #2c2c31; box-shadow: 0 12px 30px rgba(0,0,0,.45); max-width: 100% }
.itray-ban.ok { border-color: rgba(62,207,142,.45) }
.itray-ban.bad { border-color: rgba(255,122,122,.45) }
.b-t { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.b-a { background: var(--ink); color: var(--bg); border: 0; border-radius: 999px; height: 30px; padding: 0 12px; font: 700 12.5px var(--body); cursor: pointer; text-decoration: none; display: inline-grid; place-items: center }
.b-x { background: none; border: 0; color: var(--muted); font-size: 14px; cursor: pointer; width: 28px; height: 28px }
.b-dot { width: 8px; height: 8px; border-radius: 50%; background: #3ecf8e; flex: 0 0 auto }
.itray-ban.bad .b-dot { background: #ff7a7a }
.spin { display: inline-block; width: 12px; height: 12px; margin-right: 4px; vertical-align: -1px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite; flex: 0 0 auto }
@keyframes sp { to { transform: rotate(360deg) } }
.ban-enter-active, .ban-leave-active { transition: opacity .25s, transform .25s }
.ban-enter-from, .ban-leave-to { opacity: 0; transform: translateY(8px) }
@media (max-width: 760px) { .itray { right: 16px; left: 16px; align-items: stretch } .itray-pill { justify-content: center } .itray-panel { width: auto } }
</style>
