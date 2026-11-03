<script setup lang="ts">
// House "Rooms" view: eye-level Cycles stills (bun run house:render --views cams.json → data/house-views, GET /house/views),
// a horizontal gallery with the page's Day/Night choice; tap a still to fly it to full screen (FLIP), swipe between them.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../store";
import Icon from "../components/Icon.vue";

const props = defineProps<{ night: boolean }>();
interface RoomView { name: string; label: string; v: number }
const views = ref<RoomView[]>([]), loaded = ref(false);
const src = (r: RoomView, evening: boolean) => `/api/v1/house/views/${r.name}-${evening ? "evening" : "day"}.webp?v=${r.v}`;
onMounted(async () => { try { views.value = (await api<{ views: RoomView[] }>("/house/views")).views; } catch { /* none yet */ } loaded.value = true; });

const cards = ref<HTMLElement[]>([]);
const openAt = ref<number | null>(null), pager = ref<HTMLElement | null>(null), shade = ref(false), flying = ref<HTMLElement | null>(null);
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.8,.2,1)";

/** The card's picture and the full-screen slot share one image: fly it from one rect to the other (transform only). */
function fly(el: HTMLElement, from: DOMRect, to: DOMRect, done?: () => void) {
  const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width, sy = from.height / to.height;
  if (reduced()) { done?.(); return; }
  el.animate([{ transformOrigin: "0 0", transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, borderRadius: "14px" }, { transformOrigin: "0 0", transform: "none", borderRadius: "0px" }], { duration: 340, easing: EASE }).finished.then(() => done?.(), () => done?.());
}
async function open(i: number) {
  const card = cards.value[i]; if (!card) return;
  const from = card.getBoundingClientRect();
  openAt.value = i; shade.value = false;
  await nextTick();
  const p = pager.value; if (!p) return;
  p.scrollLeft = i * p.clientWidth;
  requestAnimationFrame(() => {
    shade.value = true;
    const el = p.children[i]?.querySelector(".hr-fly") as HTMLElement | null;
    if (el) { card.style.visibility = "hidden"; fly(el, from, el.getBoundingClientRect(), () => { card.style.visibility = ""; }); }
  });
}
async function close() {
  const i = openAt.value, p = pager.value; if (i == null || !p) return;
  const cur = Math.round(p.scrollLeft / p.clientWidth), card = cards.value[cur], el = p.children[cur]?.querySelector(".hr-fly") as HTMLElement | null;
  shade.value = false;
  if (!card || !el || reduced()) { openAt.value = null; return; }
  card.scrollIntoView({ block: "nearest", inline: "nearest" });
  const to = card.getBoundingClientRect(), from = el.getBoundingClientRect();
  card.style.visibility = "hidden";
  const dx = to.left - from.left, dy = to.top - from.top;
  await el.animate([{ transformOrigin: "0 0", transform: "none" }, { transformOrigin: "0 0", transform: `translate(${dx}px,${dy}px) scale(${to.width / from.width},${to.height / from.height})`, borderRadius: "14px" }], { duration: 300, easing: EASE, fill: "forwards" }).finished.catch(() => {});
  card.style.visibility = ""; openAt.value = null;
}
const idx = ref(0);
function onScroll() { const p = pager.value; if (p) idx.value = Math.round(p.scrollLeft / p.clientWidth); }
function go(d: number) { const p = pager.value; if (p) p.scrollTo({ left: (Math.round(p.scrollLeft / p.clientWidth) + d) * p.clientWidth, behavior: "smooth" }); }
function onKey(ev: KeyboardEvent) {
  if (openAt.value == null) return;
  if (ev.key === "Escape") close(); else if (ev.key === "ArrowRight") go(1); else if (ev.key === "ArrowLeft") go(-1);
}
watch(openAt, (v) => { document.documentElement.style.overflow = v == null ? "" : "hidden"; if (v != null) idx.value = v; });
onMounted(() => addEventListener("keydown", onKey));
onUnmounted(() => { removeEventListener("keydown", onKey); document.documentElement.style.overflow = ""; });
const empty = computed(() => loaded.value && !views.value.length);
</script>

<template>
  <section class="hr" aria-label="Rooms">
    <p v-if="empty" class="hint">No eye-level renders yet: run <code>bun run house:render --views cams.json</code>.</p>
    <div class="hr-row" role="list">
      <button v-for="(r, i) in views" :key="r.name" :ref="(el) => { if (el) cards[i] = el as HTMLElement }" type="button" class="hr-card" role="listitem" :aria-label="`${r.label}, open full screen`" @click="open(i)">
        <span class="hr-img">
          <img :src="src(r, false)" alt="" loading="lazy" decoding="async" draggable="false" />
          <img class="hr-eve" :class="{ on: night }" :src="src(r, true)" alt="" loading="lazy" decoding="async" draggable="false" />
        </span>
        <span class="hr-cap">{{ r.label }}</span>
      </button>
    </div>
    <Teleport to="body">
      <div v-if="openAt != null" class="hr-full" :class="{ on: shade }" role="dialog" aria-modal="true" aria-label="Room view" @click.self="close">
        <div ref="pager" class="hr-pager" @scroll.passive="onScroll">
          <figure v-for="r in views" :key="r.name" class="hr-slide" @click.self="close">
            <span class="hr-fly">
              <img :src="src(r, false)" alt="" draggable="false" />
              <img class="hr-eve" :class="{ on: night }" :src="src(r, true)" alt="" draggable="false" />
            </span>
            <figcaption>{{ r.label }}</figcaption>
          </figure>
        </div>
        <button type="button" class="btn icon-btn hr-x" aria-label="Close" @click="close"><Icon name="x" :size="18" /></button>
        <span class="hr-count num">{{ idx + 1 }} / {{ views.length }}</span>
      </div>
    </Teleport>
  </section>
</template>
