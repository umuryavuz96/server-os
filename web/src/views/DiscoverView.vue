<script setup lang="ts">
// Discover: an app store over every self-hostable app (awesome-selfhosted, CasaOS, LinuxServer, Homebrew, our recipes).
// Layers, as in the Claude Design canvas "Server OS Discover": Today (editor's picks, "Instead of …", starter packs,
// genres, charts and shelves) → a genre or list (sub-shelves, filters with counts) → an app (drawer: facts, what an
// install does, screenshots, works-well-with, similar, live install, ready card). The view lives in the hash
// (#discover?tab=…&genre=…&q=…), so links and the back button work.
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { S, api, toast } from "../store";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import ReadyCard, { type Ready } from "../components/ReadyCard.vue";
import AppTile from "../components/discover/AppTile.vue";
import AppRow from "../components/discover/AppRow.vue";
import LifeAction from "../components/discover/LifeAction.vue";
import Checklist from "../components/discover/Checklist.vue";
import { BUSY, HEALTH, ICON, LIFE_LABEL, TIER, TINT, ago, auto, stars, tierOf, type Detail, type Genre, type Home, type Item, type Life, type Opt, type Pack, type Tier } from "../components/discover/types";

interface Source { id: string; label: string; attribution: string; fetched: number | null; count: number; error: string | null }
type Tab = "today" | "genres" | "packs" | "replace" | "charts" | "all";
type Sort = "stars" | "updated" | "name";
const TABS: [Tab, string][] = [["today", "Today"], ["genres", "Genres"], ["packs", "Starter packs"], ["replace", "Instead of…"], ["charts", "Top charts"], ["all", "All apps"]];

// ---------- where we are (mirrored in the hash) ----------
const tab = ref<Tab>("today"), q = ref(""), genre = ref(""), category = ref(""), tier = ref<"" | Tier>(""), sort = ref<Sort>("stars"), fresh = ref(true);
const scope = ref<"selfhosted" | "all">("selfhosted");
/** What the middle of the page shows. A genre, a search or "All apps" is a grid with filters. */
const mode = computed(() => (q.value.trim() || genre.value || tab.value === "all" ? "grid" : tab.value));
function readState() {
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
  tab.value = (TABS.some(([t]) => t === p.get("tab")) ? p.get("tab") : "today") as Tab;
  q.value = p.get("q") ?? ""; genre.value = p.get("genre") ?? ""; category.value = p.get("sub") ?? "";
  tier.value = (p.get("tier") as Tier) || ""; sort.value = (p.get("sort") as Sort) || "stars"; fresh.value = p.get("stale") !== "1";
  // #discover?app=<id> opens that app's page (the installs tray links here).
  const app = p.get("app");
  if (app && opened.value?.id !== app) void openById(app);
  else if (!app && opened.value) opened.value = null;
}
function writeState(push: boolean) {
  const p = new URLSearchParams();
  if (tab.value !== "today") p.set("tab", tab.value);
  if (q.value.trim()) p.set("q", q.value.trim());
  if (genre.value) p.set("genre", genre.value);
  if (category.value) p.set("sub", category.value);
  if (tier.value) p.set("tier", tier.value);
  if (sort.value !== "stars") p.set("sort", sort.value);
  if (!fresh.value) p.set("stale", "1");
  if (opened.value) p.set("app", opened.value.id);
  const h = `#discover${p.size ? `?${p}` : ""}`;
  if (h !== location.hash) history[push ? "pushState" : "replaceState"](null, "", h);
}
let quiet = false; // set while several refs change at once, so the watchers don't each reload
function go(to: { tab?: Tab; genre?: string; sub?: string; tier?: "" | Tier; sort?: Sort; q?: string } = {}) {
  quiet = true;
  tab.value = to.tab ?? (to.genre ? "genres" : "today"); genre.value = to.genre ?? ""; category.value = to.sub ?? "";
  tier.value = to.tier ?? ""; sort.value = to.sort ?? "stars"; q.value = to.q ?? "";
  writeState(true); window.scrollTo({ top: 0 }); void load();
  setTimeout(() => { quiet = false; });
}

// ---------- data ----------
interface Facets { tiers: Record<Tier, number>; categories: { category: string; count: number }[]; hidden: number }
const home = ref<Home | null>(null), genres = ref<Genre[]>([]), running = ref<Record<string, string>>({});
const items = ref<Item[]>([]), total = ref(0), facets = ref<Facets | null>(null), loading = ref(false), page = ref(0);
const sources = ref<Source[]>([]), hub = ref<Item[]>([]);
const curGenre = computed(() => genres.value.find((g) => g.id === genre.value) ?? null);
const allCount = computed(() => genres.value.reduce((a, g) => a + g.count, 0));
const charts = computed(() => home.value?.shelves.find((s) => s.id === "top")?.items ?? []);
const shelves = computed(() => home.value?.shelves.filter((s) => s.id !== "top") ?? []);
const PAGE = 36;

async function load(reset = true) {
  if (mode.value !== "grid") return;
  if (reset) page.value = 0;
  loading.value = true;
  const p = new URLSearchParams({ q: q.value, genre: genre.value, category: category.value, tier: tier.value, fresh: String(fresh.value), scope: scope.value, limit: String(PAGE), offset: String(page.value * PAGE) });
  if (!q.value.trim()) p.set("sort", sort.value);
  try {
    const r = await api<{ total: number; items: Item[]; facets: Facets }>(`/catalog?${p}`);
    items.value = reset ? r.items : [...items.value, ...r.items];
    total.value = r.total; facets.value = r.facets;
    hub.value = [];
    if (reset && q.value.trim().length > 2 && r.total < 5) hub.value = (await api<{ items: Item[] }>(`/catalog/dockerhub?q=${encodeURIComponent(q.value.trim())}`)).items.slice(0, 6);
  } catch (e) { toast((e as Error).message); }
  loading.value = false;
}
let t: ReturnType<typeof setTimeout>;
watch(q, () => { if (quiet) return; clearTimeout(t); t = setTimeout(() => { writeState(false); void load(); }, 220); });
watch([category, tier, sort, scope, fresh], () => { if (quiet) return; writeState(false); void load(); });
const more = () => { page.value++; void load(false); };
const onPop = () => { if (location.hash.startsWith("#discover")) { quiet = true; readState(); void load(); setTimeout(() => { quiet = false; }); } };

const installed = ref<Map<string, { href: string; ready?: Ready; ref: string }>>(new Map());
const hasAgent = ref(false), agentSetup = ref(true);
async function refreshInstalled() {
  try { installed.value = new Map((await api<{ apps: { id: string; href: string; ready?: Ready; ref: string }[] }>("/apps/installed")).apps.map((a) => [a.id, a])); } catch { /* keep */ }
  try { running.value = (await api<{ apps: Record<string, string> }>("/catalog/running")).apps; } catch { /* keep */ }
}
onMounted(async () => {
  quiet = true; readState(); setTimeout(() => { quiet = false; });
  void load();
  void refreshInstalled();
  addEventListener("popstate", onPop);
  try { home.value = await api<Home>("/catalog/home"); } catch (e) { toast((e as Error).message); }
  try { genres.value = (await api<{ genres: Genre[] }>("/catalog/genres")).genres; } catch { /* optional */ }
  try { sources.value = (await api<{ sources: Source[] }>("/catalog/sources")).sources; } catch { /* optional */ }
  try { hasAgent.value = (await api<{ capabilities: string[] }>("/info")).capabilities.includes("agent"); } catch { /* optional */ }
});
onUnmounted(() => removeEventListener("popstate", onPop));
// ---------- lifecycle (server slice "lifecycle"): one state per app, the same on every screen ----------
const lifeMap = computed(() => (S as unknown as { lifecycle?: Record<string, Life> }).lifecycle ?? {});
const lifeOf = (it: Item | null): Life | null => (it ? lifeMap.value[it.id] ?? null : null);
/** Installs asked for but not yet seen in the lifecycle: the button changes the moment it is tapped. */
const pending = ref(new Set<string>());
const isPending = (it: Item) => pending.value.has(it.id) && !lifeOf(it);
watch(lifeMap, (m) => { for (const id of pending.value) if (m[id]) pending.value.delete(id); });
const mark = (id: string, on: boolean) => { const s = new Set(pending.value); on ? s.add(id) : s.delete(id); pending.value = s; };
const isBusy = (it: Item) => isPending(it) || (!!lifeOf(it) && BUSY.includes(lifeOf(it)!.state));
const elapsed = (since: number) => { const s = Math.max(0, Math.round((now.value - since) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval>;
onMounted(() => { tick = setInterval(() => (now.value = Date.now()), 1000); });
onUnmounted(() => clearInterval(tick));
/** In the drawer: the CTA starts the right kind of install (confirm sheet, or the agent). */
function getApp(it: Item) { if (auto(it)[0]) confirm.value = auto(it)[0]; else void askAgent(it); }

/** href when the app runs on this server ("" when it runs but has no web page), undefined when it doesn't. */
const runningOf = (it: Item): string | undefined => (it.id in running.value ? running.value[it.id] : installed.value.get(it.id)?.href);

// ---------- the app drawer ----------
const opened = ref<Detail | null>(null), shot = ref(0);
// Screenshots: a scroll-snap strip (swipe, trackpad, arrows, dots); the dot follows the scroll position.
const strip = ref<HTMLElement | null>(null);
const onStrip = () => { const el = strip.value; if (el) shot.value = Math.round(el.scrollLeft / el.clientWidth); };
const toShot = (i: number) => { const el = strip.value; if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" }); };
const confirm = ref<Opt | null>(null);
async function openById(id: string) {
  try { const d = await api<Detail>(`/catalog/${encodeURIComponent(id)}`); opened.value = d; shot.value = 0; } catch { /* unknown id: stay on the list */ }
}
// The open app lives in the hash too, so the back button closes it and the tray can link to it.
watch(() => opened.value?.id ?? null, () => { if (!quiet) writeState(false); });
async function openItem(it: Item) {
  opened.value = { ...it, similar: [], pairs: [], packs: [], runningHref: null, installPreview: { address: null, agentSetup: false, owner: "" } };
  shot.value = 0; strip.value?.scrollTo({ left: 0 });
  try { opened.value = await api<Detail>(`/catalog/${it.id}`); } catch { /* keep the list copy */ }
}
const isInstalled = (it: Item) => installed.value.has(it.id) || !!it.installed;
const installedOf = (it: Item) => installed.value.get(it.id) ?? null;
const openedGenre = computed(() => genres.value.find((g) => g.id === opened.value?.genre)?.label ?? opened.value?.category ?? "");
const freeRam = computed(() => {
  const s = (S as unknown as { system?: { ramUsedGB: number | null; ramTotalGB: number } }).system;
  return s?.ramUsedGB != null ? Math.max(0, s.ramTotalGB - s.ramUsedGB) : null;
});
const steps = computed(() => {
  const d = opened.value; if (!d) return [];
  const o = auto(d)[0];
  const out: string[] = [];
  if (!o) out.push(`The agent finds the official install, writes a recipe and starts ${d.name}.`);
  else if (o.method === "brew") out.push(`Installs ${d.name} with Homebrew and runs it as a background service.`);
  else if (o.method === "cask") out.push(`Installs the Mac app ${d.name} with Homebrew.`);
  else out.push(`Starts ${d.name} with Docker; its data stays in its own folder.`);
  if (d.installPreview.address && o?.method !== "cask") out.push(`Gives it an address: ${d.installPreview.address.replace(/^https?:\/\//, "")}.`);
  if (d.installPreview.agentSetup && o?.method !== "cask") {
    out.push(`The agent creates your admin account${d.installPreview.owner ? ` (${d.installPreview.owner})` : ""} and finishes the first-run setup.`);
    out.push("You get a ready card: the link, your login, and anything left to do.");
  }
  out.push("It shows up on the Apps tab with an on/off switch.");
  return out;
});

// ---------- installs ----------
interface Op { id: string; app: string; name: string; action: string; status: string; step: string; log: string; started: number; agent?: boolean }
const ops = computed(() => ((S as unknown as { operations?: Op[] }).operations ?? []).filter((o) => Date.now() - o.started < 30 * 60_000));
const opFor = (it: Item | null) => (it ? ops.value.find((o) => o.app === it.id) ?? null : null);
watch(() => ops.value.map((o) => o.status).join(), () => void refreshInstalled());
const opTitle = (o: Op) => (o.action === "uninstall" ? "Removing" : o.action === "setup" ? "Setting up" : o.agent ? "The agent is installing" : "Installing");

async function install(o: Opt) {
  confirm.value = null;
  const it = opened.value!;
  if (isBusy(it)) return;
  mark(it.id, true);
  try { await api("/apps", { body: { catalogId: it.id, method: o.method, agentSetup: hasAgent.value && agentSetup.value } }); }
  catch (e) { mark(it.id, false); toast((e as Error).message); }
}
async function uninstall(it: Item) {
  if (!window.confirm(`Remove ${it.name}? Its data folder is kept.`)) return;
  try { await api(`/apps/${it.id}`, { method: "DELETE" }); toast(`Removing ${it.name}…`); } catch (e) { toast((e as Error).message); }
}
async function askAgent(it: Item) {
  const note = window.prompt(`The server's agent installs ${it.name} in the background and sets it up. Anything it should know?`, "");
  if (note === null) return;
  if (isBusy(it)) return;
  mark(it.id, true);
  try {
    const r = await api<{ file?: string }>("/apps/agent-install", { body: { catalogId: it.id, note } });
    if (r.file) { mark(it.id, false); toast("Sent to the agent's inbox"); }
  } catch (e) { mark(it.id, false); toast((e as Error).message); }
}
/** Starter pack: install every app that isn't on the server yet, each with its best method (the agent sets each up). */
const packTodo = (p: Pack) => p.items.filter((i) => runningOf(i) === undefined && !isInstalled(i) && !isBusy(i));
const packBusy = (p: Pack) => p.items.filter(isBusy).length;
async function installPack(p: Pack) {
  const todo = packTodo(p);
  if (!todo.length) return toast("Everything in this pack is already on the server");
  if (!window.confirm(`Install ${todo.map((i) => i.name).join(", ")}? Each one is set up for you; progress shows at the top.`)) return;
  for (const it of todo) {
    mark(it.id, true);
    try {
      if (auto(it).length) await api("/apps", { body: { catalogId: it.id, agentSetup: hasAgent.value } });
      else await api("/apps/agent-install", { body: { catalogId: it.id, note: `Part of the "${p.name}" starter pack.` } });
    } catch (e) { mark(it.id, false); toast(`${it.name}: ${(e as Error).message}`); }
  }
}

const METHOD: Record<string, string> = { recipe: "Recipe", casaos: "Docker", linuxserver: "Docker", brew: "Homebrew", cask: "Mac app", dockerhub: "Docker Hub" };
const confirmLines = computed(() => {
  const o = confirm.value; if (!o) return [];
  if (o.method === "brew") return ["Runs brew install and starts it as a background service", "Shows up on the Apps tab with an on/off switch"];
  if (o.method === "cask") return ["Installs the Mac app with brew install --cask"];
  return ["Writes a compose file in the app's folder and starts it with Docker", "Picks free ports and keeps the app's data in its own data folder", "Shows up on the Apps tab with an on/off switch"];
});
const gridTitle = computed(() => (q.value.trim() ? `Results for “${q.value.trim()}”` : curGenre.value?.label ?? "All apps"));
const appliedFilters = computed(() => [
  ...(category.value ? [{ label: category.value, clear: () => (category.value = "") }] : []),
  ...(tier.value ? [{ label: TIER[tier.value].label, clear: () => (tier.value = "") }] : []),
  ...(fresh.value ? [{ label: "Active only", clear: () => (fresh.value = false) }] : []),
]);
function clearFilters() { category.value = ""; tier.value = ""; fresh.value = false; }
const tierTotal = computed(() => (facets.value ? facets.value.tiers.ready + facets.value.tiers.oneclick + facets.value.tiers.agent : 0));
// ---------- rotating editor's picks: the hero and each side card step through their own list on a timer ----------
// Server (featured) guarantees the lists share no app, so no app is ever on screen twice. Slots are staggered
// by 2.3 s so they never change together. Paused on hover/keyboard focus, in a hidden tab, behind a modal and
// under prefers-reduced-motion (then only the dots move things).
const ROTATE_MS = 7000, STAGGER = [0, -2300, -4600];
const heroList = computed(() => home.value?.featured?.hero.length ? home.value.featured.hero : (home.value?.picks.slice(0, 1) ?? []));
const sideLists = computed(() => home.value?.featured?.side.length ? home.value.featured.side : (home.value?.picks.slice(1).map((p) => [p]) ?? []));
const slots = computed(() => [heroList.value, ...sideLists.value.slice(0, 2)]);
const slotI = ref([0, 0, 0]), slotAt = ref([...STAGGER]), slotHold = ref([false, false, false]);
const hidden = ref(typeof document !== "undefined" && document.hidden), reduced = ref(false);
const slotPick = (n: number) => { const l = slots.value[n] ?? []; return l.length ? l[slotI.value[n] % l.length] : null; };
const heroPick = computed(() => slotPick(0));
const sidePicks = computed(() => [1, 2].map(slotPick).filter((x): x is NonNullable<typeof x> => !!x));
function showPick(n: number, i: number) { const a = [...slotI.value]; a[n] = i; slotI.value = a; const t = [...slotAt.value]; t[n] = 0; slotAt.value = t; }
function holdSlot(n: number, on: boolean) { const a = [...slotHold.value]; a[n] = on; slotHold.value = a; }
const onFocusIn = (n: number, e: FocusEvent) => { if ((e.target as HTMLElement).matches?.(":focus-visible")) holdSlot(n, true); };
const onEnter = (n: number, e: PointerEvent) => { if (e.pointerType === "mouse") holdSlot(n, true); };
const modalOpen = computed(() => !!opened.value || !!confirm.value);
const paused = (n: number) => reduced.value || hidden.value || modalOpen.value || slotHold.value[n] || (slots.value[n]?.length ?? 0) < 2;
let rot: ReturnType<typeof setInterval> | undefined;
function rotateTick() {
  const at = [...slotAt.value]; let moved = false;
  for (let n = 0; n < slots.value.length; n++) {
    if (paused(n)) continue;
    at[n] += 100;
    if (at[n] >= ROTATE_MS) { at[n] = 0; const i = [...slotI.value]; i[n] = (i[n] + 1) % slots.value[n].length; slotI.value = i; }
    moved = true;
  }
  if (moved) slotAt.value = at;
}
const heroProgress = computed(() => (paused(0) && !slotHold.value[0] ? 0 : Math.min(1, Math.max(0, slotAt.value[0] / ROTATE_MS))));
/** Warm the next screenshot so the crossfade never shows a blank frame. */
watch([slotI, slots], () => { slots.value.forEach((l, n) => { const nx = l[(slotI.value[n] + 1) % (l.length || 1)]; const src = nx?.item.screenshots?.[0]; if (src) new Image().src = src; }); }, { immediate: true });
const onVis = () => { hidden.value = document.hidden; };
let mq: MediaQueryList | undefined;
const onMq = () => { reduced.value = !!mq?.matches; };
onMounted(() => {
  mq = matchMedia("(prefers-reduced-motion: reduce)"); onMq(); mq.addEventListener("change", onMq);
  document.addEventListener("visibilitychange", onVis);
  rot = setInterval(rotateTick, 100);
});
onUnmounted(() => { clearInterval(rot); mq?.removeEventListener("change", onMq); document.removeEventListener("visibilitychange", onVis); });
const readyCount = computed(() => home.value?.shelves.find((s) => s.id === "ready")?.items.length ?? 0);
const TIERS: Tier[] = ["ready", "oneclick", "agent"];
</script>

<template>
  <main class="page disc">
    <header class="d-head">
      <div class="d-title">
        <h1>Discover</h1>
        <span class="muted">{{ allCount ? allCount.toLocaleString() : "1,600+" }} self-hosted apps · {{ readyCount }} ready to use · {{ Object.keys(running).length }} on this server</span>
      </div>
      <label class="d-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="q" type="search" placeholder="Search apps, or “google photos”" aria-label="Search apps" />
      </label>
    </header>
    <nav class="d-tabs" aria-label="Discover sections">
      <button v-for="[id, label] in TABS" :key="id" type="button" :aria-current="!q.trim() && !genre && tab === id ? 'page' : undefined" @click="go({ tab: id })">{{ label }}</button>
    </nav>


    <!-- ========== TODAY ========== -->
    <template v-if="mode === 'today' && home">
      <section v-if="heroPick" class="picks" aria-label="Editor's picks">
        <article class="hero" @click="openItem(heroPick.item)" @pointerenter="onEnter(0, $event)" @pointerleave="holdSlot(0, false)" @focusin="onFocusIn(0, $event)" @focusout="holdSlot(0, false)">
          <Transition name="rot">
            <div :key="heroPick.id" class="hero-slide">
              <div class="hero-art" aria-hidden="true">
                <img v-if="heroPick.item.screenshots?.[0]" :src="heroPick.item.screenshots[0]" alt="" />
                <div v-else class="hero-grid"><i v-for="n in 12" :key="n"></i></div>
              </div>
              <div class="hero-c">
                <span class="kick">EDITOR'S PICK · {{ heroPick.kicker.toUpperCase() }}</span>
                <div class="hero-n">
                  <AppIcon :name="heroPick.item.name" :icon="heroPick.item.logo ?? ''" class="big" />
                  <div><h2>{{ heroPick.item.name }}</h2><span>{{ heroPick.item.replaces?.length ? `Instead of ${heroPick.item.replaces.join(", ")}` : heroPick.item.sub || heroPick.item.category }}</span></div>
                </div>
                <p>{{ heroPick.why }}</p>
                <div class="hero-a">
                  <LifeAction :item="heroPick.item" :life="lifeOf(heroPick.item)" :running="runningOf(heroPick.item)" :pending="isPending(heroPick.item)" size="l" @get="openItem" @open="openItem" />
                  <span class="hl on-dark"><i :class="`h-${heroPick.item.health}`"></i>{{ HEALTH[heroPick.item.health ?? "unknown"] }}<template v-if="heroPick.item.updated"> · updated {{ ago(heroPick.item.updated) }}</template></span>
                  <span v-if="heroPick.item.stars" class="mono hero-s">★ {{ stars(heroPick.item.stars) }}<template v-if="heroPick.item.license"> · {{ heroPick.item.license }}</template></span>
                </div>
              </div>
            </div>
          </Transition>
          <div v-if="heroList.length > 1" class="rot-dots hero-dots" @click.stop>
            <button v-for="(p, i) in heroList" :key="p.id" type="button" :class="{ on: i === slotI[0] % heroList.length }" :aria-label="`Show ${p.item.name}`" :aria-current="i === slotI[0] % heroList.length ? 'true' : undefined" @click="showPick(0, i)"><i></i></button>
          </div>
          <div v-if="heroList.length > 1 && !reduced" class="hero-bar" aria-hidden="true"><i :style="{ transform: `scaleX(${heroProgress})` }"></i></div>
        </article>
        <div class="picks-side">
          <article v-for="(p, n) in sidePicks" :key="n" class="pick" @click="openItem(p.item)" @pointerenter="onEnter(n + 1, $event)" @pointerleave="holdSlot(n + 1, false)" @focusin="onFocusIn(n + 1, $event)" @focusout="holdSlot(n + 1, false)">
            <Transition name="rot">
              <div :key="p.id" class="pick-slide">
                <span class="kick muted">{{ p.kicker.toUpperCase() }}</span>
                <div class="pick-n">
                  <AppIcon :name="p.item.name" :icon="p.item.logo ?? ''" />
                  <div><b>{{ p.item.name }}</b><small class="muted">{{ p.item.sub || p.item.category }}</small></div>
                  <LifeAction :item="p.item" :life="lifeOf(p.item)" :running="runningOf(p.item)" :pending="isPending(p.item)" @get="openItem" @open="openItem" />
                </div>
                <p>{{ p.why }}</p>
              </div>
            </Transition>
            <div v-if="(slots[n + 1]?.length ?? 0) > 1" class="rot-dots side-dots" @click.stop>
              <button v-for="(d, i) in slots[n + 1]" :key="d.id" type="button" :class="{ on: i === slotI[n + 1] % slots[n + 1].length }" :aria-label="`Show ${d.item.name}`" :aria-current="i === slotI[n + 1] % slots[n + 1].length ? 'true' : undefined" @click="showPick(n + 1, i)"><i></i></button>
            </div>
          </article>
        </div>
      </section>

      <section class="d-sec" aria-label="Instead of">
        <div class="sec-h"><div><h3>Instead of…</h3><span class="muted">Pick the service you want to leave. See what runs on your own server instead.</span></div><button type="button" class="see" @click="go({ tab: 'replace' })">See all {{ home.replaces.length }} →</button></div>
        <div class="rep-grid">
          <button v-for="r in home.replaces.slice(0, 8)" :key="r.service" type="button" class="rep-t" @click="go({ q: r.service })">
            <small class="muted">Instead of</small>
            <b>{{ r.service }}</b>
            <span class="rep-apps"><AppIcon v-for="a in r.items.slice(0, 3)" :key="a.id" :name="a.name" :icon="a.logo ?? ''" class="xs" /><span>{{ r.items.slice(0, 3).map((a) => a.name).join(", ") }}</span></span>
          </button>
        </div>
      </section>

      <section class="d-sec" aria-label="Starter packs">
        <div class="sec-h"><div><h3>Starter packs</h3><span class="muted">Apps that work well together. Install the set in one go; each one gets set up for you.</span></div><button type="button" class="see" @click="go({ tab: 'packs' })">All {{ home.packs.length }} packs →</button></div>
        <div class="pack-grid">
          <article v-for="p in home.packs.slice(0, 3)" :key="p.id" class="pack">
            <div class="pack-art" :style="{ background: `linear-gradient(135deg, ${p.tint}, #0b0b0d)` }"><AppIcon v-for="a in p.items" :key="a.id" :name="a.name" :icon="a.logo ?? ''" /></div>
            <div class="pack-b">
              <b>{{ p.name }}</b>
              <p class="muted">{{ p.blurb }}</p>
              <div class="pack-apps"><button v-for="a in p.items" :key="a.id" type="button" class="lnk" @click="openItem(a)">{{ a.name }}<template v-if="isBusy(a)"> · {{ lifeOf(a) ? LIFE_LABEL[lifeOf(a)!.state].toLowerCase() : "starting" }}…</template><template v-else-if="runningOf(a) !== undefined || lifeOf(a)?.state === 'ready'"> ✓</template></button></div>
              <button type="button" class="get-m" :disabled="!packTodo(p).length" :aria-busy="packBusy(p) > 0" @click="installPack(p)"><span v-if="packBusy(p)" class="spin-s" aria-hidden="true"></span>{{ packTodo(p).length ? `Install ${packTodo(p).length === p.items.length ? "all " : ""}${packTodo(p).length}` : packBusy(p) ? `Installing ${packBusy(p)}…` : "All installed" }}</button>
            </div>
          </article>
        </div>
      </section>

      <section class="d-sec" aria-label="Genres">
        <div class="sec-h"><div><h3>Browse by genre</h3></div><button type="button" class="see" @click="go({ tab: 'genres' })">{{ genres.length }} genres →</button></div>
        <div class="genre-grid">
          <button v-for="g in genres.slice(0, 10)" :key="g.id" type="button" class="genre" @click="go({ genre: g.id })">
            <span class="g-top"><span class="g-ic" :style="{ background: TINT[g.id] }"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f2f2f2" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="ICON[g.icon]" /></svg></span><span class="mono muted">{{ g.count }}</span></span>
            <b>{{ g.label }}</b>
            <small class="muted">{{ g.logos.slice(0, 3).map((l) => l.name).join(" · ") }}</small>
          </button>
        </div>
      </section>

      <section class="d-sec" aria-label="Top charts">
        <div class="sec-h"><div><h3>Top charts</h3><span class="muted">The most-starred apps you can install in one click.</span></div><button type="button" class="see" @click="go({ tab: 'charts' })">See all →</button></div>
        <div class="rows3"><AppRow v-for="(it, i) in charts.slice(0, 9)" :key="it.id" :item="it" :rank="i + 1" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      </section>

      <section v-for="s in shelves.slice(0, 7)" :key="s.id" class="d-sec">
        <div class="sec-h"><div><h3>{{ s.title }}</h3><span class="muted">{{ s.subtitle }}</span></div>
          <button v-if="s.genre" type="button" class="see" @click="go({ genre: s.genre })">See all →</button>
          <button v-else-if="s.id === 'ready'" type="button" class="see" @click="go({ tab: 'all', tier: 'ready' })">See all →</button>
          <button v-else-if="s.id === 'updated'" type="button" class="see" @click="go({ tab: 'all', sort: 'updated' })">See all →</button>
        </div>
        <div class="shelf"><AppTile v-for="it in s.items" :key="it.id" :item="it" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      </section>
    </template>

    <!-- ========== GENRES ========== -->
    <section v-else-if="mode === 'genres'" class="genre-big" aria-label="Genres">
      <button v-for="g in genres" :key="g.id" type="button" class="genre lg" @click="go({ genre: g.id })">
        <span class="g-top"><span class="g-ic lg" :style="{ background: TINT[g.id] }"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#f2f2f2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="ICON[g.icon]" /></svg></span>
          <span class="g-logos"><AppIcon v-for="l in g.logos.slice(0, 4)" :key="l.name" :name="l.name" :icon="l.logo" class="xs" /></span></span>
        <b>{{ g.label }}</b>
        <span class="muted">{{ g.blurb }}</span>
        <small class="mono muted">{{ g.count }} apps · {{ g.installable }} one-click · {{ g.categories.length }} shelves</small>
      </button>
    </section>

    <!-- ========== STARTER PACKS ========== -->
    <section v-else-if="mode === 'packs' && home" class="pack-grid" aria-label="Starter packs">
      <article v-for="p in home.packs" :key="p.id" class="pack">
        <div class="pack-art" :style="{ background: `linear-gradient(135deg, ${p.tint}, #0b0b0d)` }"><AppIcon v-for="a in p.items" :key="a.id" :name="a.name" :icon="a.logo ?? ''" /></div>
        <div class="pack-b">
          <b>{{ p.name }}</b>
          <p class="muted">{{ p.blurb }}</p>
          <div class="pack-apps"><button v-for="a in p.items" :key="a.id" type="button" class="lnk" @click="openItem(a)">{{ a.name }}<template v-if="isBusy(a)"> · {{ lifeOf(a) ? LIFE_LABEL[lifeOf(a)!.state].toLowerCase() : "starting" }}…</template><template v-else-if="runningOf(a) !== undefined || lifeOf(a)?.state === 'ready'"> ✓</template></button></div>
          <button type="button" class="get-m" :disabled="!packTodo(p).length" :aria-busy="packBusy(p) > 0" @click="installPack(p)"><span v-if="packBusy(p)" class="spin-s" aria-hidden="true"></span>{{ packTodo(p).length ? `Install ${packTodo(p).length === p.items.length ? "all " : ""}${packTodo(p).length}` : packBusy(p) ? `Installing ${packBusy(p)}…` : "All installed" }}</button>
        </div>
      </article>
    </section>

    <!-- ========== INSTEAD OF ========== -->
    <section v-else-if="mode === 'replace' && home" class="rep-list" aria-label="Instead of">
      <div v-for="r in home.replaces" :key="r.service" class="rep-row">
        <div class="rep-svc"><small class="muted">Instead of</small><b>{{ r.service }}</b></div>
        <div class="rep-apps-l"><AppTile v-for="it in r.items.slice(0, 3)" :key="it.id" :item="it" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      </div>
    </section>

    <!-- ========== TOP CHARTS ========== -->
    <section v-else-if="mode === 'charts' && home" class="d-sec" aria-label="Top charts">
      <div class="rows3"><AppRow v-for="(it, i) in charts" :key="it.id" :item="it" :rank="i + 1" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      <div v-for="s in home.shelves.filter((x) => x.genre)" :key="s.id" class="d-sec">
        <div class="sec-h"><div><h3>{{ s.title }}</h3></div><button type="button" class="see" @click="go({ genre: s.genre })">See all →</button></div>
        <div class="rows3"><AppRow v-for="(it, i) in s.items.slice(0, 6)" :key="it.id" :item="it" :rank="i + 1" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      </div>
    </section>

    <!-- ========== GRID: genre, search, all ========== -->
    <template v-else-if="mode === 'grid'">
      <nav v-if="curGenre && !q.trim()" class="crumbs" aria-label="Breadcrumb"><button type="button" class="lnk" @click="go()">Discover</button><span aria-hidden="true">/</span><button type="button" class="lnk" @click="go({ tab: 'genres' })">Genres</button><span aria-hidden="true">/</span><b>{{ curGenre.label }}</b></nav>
      <header v-if="curGenre && !q.trim()" class="g-head" :style="{ background: `linear-gradient(120deg, ${TINT[curGenre.id]} 0%, #0a0a0c 75%)` }">
        <span class="g-ic xl"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#f2f2f2" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="ICON[curGenre.icon]" /></svg></span>
        <div><h2>{{ curGenre.label }}</h2><p>{{ curGenre.blurb }}</p><small class="mono">{{ curGenre.count }} apps · {{ curGenre.installable }} one-click</small></div>
      </header>
      <h2 v-else class="g-title">{{ gridTitle }}</h2>

      <div class="filters">
        <div v-if="facets?.categories.length && (curGenre || q.trim())" class="chips-row" role="group" aria-label="Sub-shelf">
          <button type="button" class="fchip" :aria-pressed="!category" @click="category = ''">All</button>
          <button v-for="c in facets.categories.slice(0, 14)" :key="c.category" type="button" class="fchip" :aria-pressed="category === c.category" @click="category = category === c.category ? '' : c.category">{{ c.category }} <span>{{ c.count }}</span></button>
        </div>
        <div class="f-bar">
          <div class="seg3" role="group" aria-label="Install type">
            <button type="button" :aria-pressed="!tier" @click="tier = ''">All <span>{{ tierTotal }}</span></button>
            <button v-for="k in TIERS" :key="k" type="button" :aria-pressed="tier === k" :title="TIER[k].hint" @click="tier = tier === k ? '' : k">{{ TIER[k].label }} <span>{{ facets?.tiers[k] ?? 0 }}</span></button>
          </div>
          <label class="chk"><input v-model="fresh" type="checkbox" /> Hide stale &amp; archived<template v-if="facets?.hidden"> ({{ facets.hidden }})</template></label>
          <label class="chk"><input type="checkbox" :checked="scope === 'all'" @change="scope = ($event.target as HTMLInputElement).checked ? 'all' : 'selfhosted'" /> Mac apps &amp; Homebrew</label>
          <label v-if="!q.trim()" class="sortl">Sort
            <select v-model="sort"><option value="stars">Most popular</option><option value="updated">Recently updated</option><option value="name">Name</option></select>
          </label>
        </div>
        <div class="applied">
          <span class="muted">Showing {{ items.length.toLocaleString() }} of {{ total.toLocaleString() }}</span>
          <span v-for="f in appliedFilters" :key="f.label" class="achip">{{ f.label }}<button type="button" :aria-label="`Remove filter ${f.label}`" @click="f.clear()">✕</button></span>
          <button v-if="appliedFilters.length" type="button" class="lnk" @click="clearFilters">Clear all</button>
        </div>
      </div>

      <div class="grid3"><AppTile v-for="it in items" :key="it.id" :item="it" :running="runningOf(it)" :life="lifeOf(it)" :pending="isPending(it)" @open="openItem" /></div>
      <p v-if="!loading && !items.length" class="hint">Nothing found. Try another word, or clear the filters.</p>
      <button v-if="items.length < total" type="button" class="btn big" :disabled="loading" @click="more">{{ loading ? "Loading…" : `Show more (${(total - items.length).toLocaleString()} left)` }}</button>

      <section v-if="hub.length" class="card2">
        <div class="ch"><h3>From Docker Hub</h3><span class="muted">any image — the agent can turn one into a recipe</span></div>
        <div v-for="h in hub" :key="h.id" style="display: flex; gap: 10px; align-items: center; padding: 6px 0">
          <b class="num">{{ h.name }}</b><span class="muted" style="flex: 1">{{ h.description }}</span><span class="muted">★ {{ stars(h.stars) }}</span>
          <button type="button" class="btn" @click="askAgent(h)">Ask the agent</button>
        </div>
      </section>
    </template>

    <p class="foot">
      Catalog from <template v-for="(s, i) in sources" :key="s.id">{{ i ? " · " : "" }}<span :title="s.attribution">{{ s.label }} ({{ s.count.toLocaleString() }}){{ s.error ? " — not refreshed" : "" }}</span></template>.
      Data from awesome-selfhosted is CC BY-SA 3.0. Logos from dashboard-icons (Apache-2.0) and selfh.st/icons (CC BY 4.0). Picks, packs and “Instead of” are hand-made (curation/curated.yaml).
    </p>

    <!-- ========== APP DRAWER ========== -->
    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="opened" class="dr-wrap">
          <div class="dr-bg" @click="opened = null"></div>
          <aside class="dr dr-app" role="dialog" aria-modal="true" :aria-label="opened.name">
            <div class="dr-h"><span class="dr-title">{{ openedGenre }}</span><button type="button" class="btn" aria-label="Close" @click="opened = null">✕</button></div>
            <div class="dr-b">
              <div class="ad-h">
                <AppIcon :name="opened.name" :icon="opened.logo ?? ''" class="xl" />
                <div class="ad-n">
                  <h2>{{ opened.name }}</h2>
                  <span class="muted">{{ opened.sub || opened.category }}</span>
                  <span v-if="opened.replaces?.length" class="ad-rep">Instead of <b>{{ opened.replaces.join(", ") }}</b></span>
                </div>
              </div>

              <div class="facts">
                <div><small>Health</small><b :class="`hc-${opened.health}`">{{ HEALTH[opened.health ?? "unknown"] }}</b><small>{{ opened.updated ? ago(opened.updated) : "—" }}</small></div>
                <div><small>Stars</small><b>{{ opened.stars ? stars(opened.stars) : "—" }}</b><small>GitHub</small></div>
                <div><small>Install</small><b>{{ tierOf(opened) === "agent" ? "Agent" : tierOf(opened) === "ready" ? "Ready" : "1-click" }}</b><small>{{ auto(opened)[0] ? METHOD[auto(opened)[0].method] : "recipe by agent" }}</small></div>
                <div><small>License</small><b>{{ (opened.license ?? "—").split(/[ ,]/)[0] }}</b><small>{{ opened.license ? "open source" : "unknown" }}</small></div>
              </div>
              <div v-if="opened.archived" class="warnbox">This project is archived — it no longer gets updates.</div>
              <div v-else-if="opened.health === 'stale'" class="warnbox">No update in over 18 months. It may still work, but check the project first.</div>

              <!-- lifecycle: busy → live checklist; failed → why + retry; installed → ready card; else the install CTA -->
              <section v-if="isBusy(opened)" class="dbox prog" aria-live="polite">
                <div class="prog-h"><span class="spin-s" aria-hidden="true"></span><b>{{ lifeOf(opened) ? `${lifeOf(opened)!.agent && lifeOf(opened)!.state === "installing" ? "The agent is installing" : LIFE_LABEL[lifeOf(opened)!.state]} ${opened.name}` : `Starting ${opened.name}…` }}</b><span v-if="lifeOf(opened)" class="mono muted">{{ elapsed(lifeOf(opened)!.since) }}</span></div>
                <span v-if="lifeOf(opened)" class="muted prog-now">Now: {{ lifeOf(opened)!.step }}</span>
                <Checklist v-if="lifeOf(opened)?.checklist.length" :items="lifeOf(opened)!.checklist" />
                <p class="hint">You can close this; it keeps going on the server and shows on every screen.</p>
                <details v-if="opFor(opened)" class="other"><summary>Show the live log</summary><pre class="log" style="max-height: 260px">{{ opFor(opened)!.log.slice(-4000) || "Starting…" }}</pre></details>
              </section>
              <section v-else-if="lifeOf(opened)?.state === 'failed'" class="dbox prog bad">
                <b>The install didn't finish</b>
                <span class="muted">{{ lifeOf(opened)!.error }}</span>
                <Checklist v-if="lifeOf(opened)!.checklist.length" :items="lifeOf(opened)!.checklist" />
                <LifeAction :item="opened" :life="lifeOf(opened)" size="xl" @get="getApp" />
                <details v-if="opFor(opened)" class="other"><summary>Show the log</summary><pre class="log" style="max-height: 260px">{{ opFor(opened)!.log.slice(-4000) }}</pre></details>
              </section>
              <template v-else-if="isInstalled(opened)">
                <ReadyCard :app-id="opened.id" :href="installedOf(opened)?.href" :ready="installedOf(opened)?.ready" :can-setup="hasAgent" />
                <details v-if="lifeOf(opened)?.checklist.length" class="other"><summary>How it was set up</summary><Checklist :items="lifeOf(opened)!.checklist" /></details>
                <div class="dbox" style="font-size: 13.5px">Installed — find it on the <a href="#apps">Apps</a> tab.</div>
                <button type="button" class="btn big" style="color: var(--bad)" @click="uninstall(opened)">Remove</button>
              </template>
              <div v-else-if="runningOf(opened) !== undefined" class="dbox" style="font-size: 13.5px">
                Already runs on this server.<template v-if="runningOf(opened)">&nbsp;<a :href="runningOf(opened)" target="_blank" rel="noopener">Open it ↗</a></template>
              </div>
              <template v-else>
                <LifeAction :item="opened" :life="lifeOf(opened)" :pending="isPending(opened)" size="xl" :label="auto(opened)[0] ? `Install ${opened.name}` : 'Ask the agent to install it'" @get="getApp" />
                <div class="dbox how">
                  <b>What happens when you install</b>
                  <ol><li v-for="s in steps" :key="s">{{ s }}</li></ol>
                  <small v-if="freeRam != null" class="muted">This server has {{ freeRam.toFixed(1) }} GB of RAM free right now.</small>
                </div>
                <details v-if="auto(opened).length" class="other">
                  <summary>Other ways to install</summary>
                  <button v-for="o in auto(opened).slice(1)" :key="o.method" type="button" class="btn big" @click="confirm = o">{{ o.label }}</button>
                  <button type="button" class="btn big" @click="askAgent(opened)">Ask the agent instead</button>
                </details>
              </template>

              <div v-if="opened.screenshots?.length" class="shots">
                <div ref="strip" class="strip" @scroll.passive="onStrip">
                  <img v-for="(src, i) in opened.screenshots" :key="src" :src="src" :alt="`${opened.name} screenshot ${i + 1}`" loading="lazy" />
                </div>
                <template v-if="opened.screenshots.length > 1">
                  <button type="button" class="nav prev" aria-label="Previous screenshot" :disabled="shot === 0" @click="toShot(shot - 1)">‹</button>
                  <button type="button" class="nav next" aria-label="Next screenshot" :disabled="shot === opened.screenshots.length - 1" @click="toShot(shot + 1)">›</button>
                  <div class="dots"><button v-for="(s, i) in opened.screenshots" :key="s" type="button" :aria-label="`Screenshot ${i + 1}`" :aria-pressed="shot === i" @click="toShot(i)"></button></div>
                </template>
              </div>
              <p class="ad-desc">{{ opened.description }}</p>
              <div class="ad-chips">
                <span v-if="opened.arch?.length">{{ opened.arch.join(" · ") }}</span>
                <span v-for="s in opened.sources" :key="s">{{ s }}</span>
              </div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <a v-if="opened.website" class="btn" :href="opened.website" target="_blank" rel="noopener">Website ↗</a>
                <a v-if="opened.repo" class="btn" :href="opened.repo" target="_blank" rel="noopener">Source ↗</a>
              </div>

              <section v-if="opened.pairs.length" class="ad-sec">
                <h4>Works well with</h4>
                <AppRow v-for="p in opened.pairs" :key="p.id" :item="p" :running="runningOf(p)" :life="lifeOf(p)" :pending="isPending(p)" @open="openItem" />
              </section>
              <section v-if="opened.similar.length" class="ad-sec">
                <h4>Similar apps</h4>
                <div class="sim"><button v-for="s in opened.similar" :key="s.id" type="button" class="sim-t" @click="openItem(s)"><AppIcon :name="s.name" :icon="s.logo ?? ''" /><b>{{ s.name }}</b><small class="muted">{{ s.replaces?.[0] ? `Instead of ${s.replaces[0]}` : s.sub || s.category }}</small></button></div>
              </section>
              <p v-if="opened.packs.length" class="hint">In starter packs: <template v-for="(p, i) in opened.packs" :key="p.id">{{ i ? ", " : "" }}<button type="button" class="lnk" @click="opened = null; go({ tab: 'packs' })">{{ p.name }}</button></template></p>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog :open="!!confirm" :title="`Install ${opened?.name ?? ''}?`" :subtitle="confirm?.label" confirm-label="Install" @confirm="install(confirm!)" @cancel="confirm = null">
      <ul><li v-for="l in confirmLines" :key="l">{{ l }}</li></ul>
      <label v-if="hasAgent" class="chk" style="margin-top: 8px"><input v-model="agentSetup" type="checkbox" /> Let the agent finish setup: admin account, first-run wizard, address</label>
    </ConfirmDialog>
  </main>
</template>

<style scoped>
.disc { display: flex; flex-direction: column; gap: 28px }
.d-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap }
.d-title { display: flex; flex-direction: column; gap: 4px }
.d-title h1 { margin: 0; font: 700 44px/1 var(--display); text-transform: uppercase; letter-spacing: .5px }
.d-search { display: flex; align-items: center; gap: 10px; background: #151517; border: 1px solid #2c2c31; border-radius: 12px; padding: 0 16px; height: 48px; flex: 0 1 520px; min-width: 240px; color: var(--muted) }
.d-search:focus-within { border-color: #55555c }
.d-search input { background: none; border: 0; outline: none; color: var(--ink); font: 500 15px var(--body); flex: 1; min-width: 0 }
.d-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; margin-top: -14px }
.d-tabs button { background: none; border: 0; color: var(--muted); font: 600 14.5px var(--body); padding: 10px 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; white-space: nowrap }
.d-tabs button[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); font-weight: 700 }
.kick { font: 600 11.5px var(--mono); letter-spacing: 1.1px }
.mono { font-family: var(--mono) }
.lnk { background: none; border: 0; padding: 0; color: var(--ink); font: 600 13.5px var(--body); cursor: pointer; text-decoration: underline; text-underline-offset: 3px }

/* picks */
.picks { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px }
.hero { position: relative; border-radius: 20px; overflow: hidden; border: 1px solid #23302a; background: linear-gradient(120deg, #0f2a1f, #0b0f0d 60%); height: 384px; cursor: pointer }
.hero-slide { position: absolute; inset: 0; display: flex }
.hero-art { position: absolute; right: -40px; top: 36px; width: 56%; height: 78%; border-radius: 14px; overflow: hidden; transform: rotate(-3deg); border: 1px solid #263a30; opacity: .85 }
.hero-art img { width: 100%; height: 100%; object-fit: cover; object-position: top left }
.hero-grid { width: 100%; height: 100%; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 10px; background: #16201b; box-sizing: border-box }
.hero-grid i { border-radius: 6px; background: #24463a }
.hero-grid i:nth-child(3n) { background: #3d6b52 }
.hero-grid i:nth-child(4n) { background: #1f3b30 }
.hero-slide::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(8,14,11,.96) 0%, rgba(8,14,11,.8) 45%, rgba(8,14,11,0) 80%) }
.hero-c { position: relative; z-index: 1; padding: 30px 30px 44px; display: flex; flex-direction: column; justify-content: flex-end; gap: 12px; max-width: 480px }
.hero-c .kick { color: #7fd3a8 }
.hero-n { display: flex; align-items: center; gap: 14px }
.hero-n h2 { margin: 0; font: 700 38px/1 var(--display); color: var(--ink); text-transform: none; letter-spacing: 0 }
.hero-n span { color: #b8c7bf }
.hero-c p { margin: 0; font-size: 17px; color: #dfe7e2; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden }
.hero-a { display: flex; gap: 12px; align-items: center; flex-wrap: wrap }
.hero-s { color: #a9bdb2; font-size: 13px }
.picks-side { display: flex; flex-direction: column; gap: 16px }
.pick { flex: 1; position: relative; overflow: hidden; min-height: 184px; border-radius: 20px; border: 1px solid var(--line); background: var(--panel); cursor: pointer }
.pick-slide { position: absolute; inset: 0; padding: 18px 18px 26px; display: flex; flex-direction: column; gap: 10px }
.pick:hover, .hero:hover { border-color: #4a4a50 }
.pick-n { display: flex; align-items: center; gap: 12px }
.pick-n > div { display: flex; flex-direction: column; min-width: 0; flex: 1 }
.pick p { margin: 0; color: #c9c9ce; font-size: 14px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden }
/* rotation: crossfade + a slight slide; both slides are absolute, so the card height never moves */
.rot-enter-active, .rot-leave-active { transition: opacity .45s var(--ease), transform .45s var(--spring) }
.rot-enter-from { opacity: 0; transform: translateY(12px) }
.rot-leave-to { opacity: 0; transform: translateY(-8px) }
.rot-leave-active { pointer-events: none }
.rot-dots { position: absolute; z-index: 2; display: flex; align-items: center }
.rot-dots button { background: none; border: 0; padding: 9px 4px; cursor: pointer; display: grid; place-items: center }
.rot-dots i { display: block; width: 7px; height: 7px; border-radius: 99px; background: rgba(255,255,255,.28); transition: width .3s var(--ease), background .3s var(--ease) }
.rot-dots button.on i { width: 20px; background: #fff }
.rot-dots button:focus-visible { outline: 2px solid #7fd3a8; outline-offset: -2px; border-radius: 6px }
.hero-dots { right: 22px; bottom: 6px }
.side-dots { right: 10px; bottom: 0 }
.side-dots button { padding: 8px 2.5px }
.side-dots i { width: 5px; height: 5px; background: rgba(255,255,255,.22) }
.side-dots button.on i { width: 14px; background: var(--ink) }
.hero-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.08); z-index: 2 }
.hero-bar i { display: block; height: 100%; background: #7fd3a8; transform-origin: left; transition: transform .1s linear }
@media (prefers-reduced-motion: reduce) { .rot-enter-active, .rot-leave-active { transition: none } }
.get-l { height: 44px; padding: 0 24px; border-radius: 999px; border: 0; background: var(--ink); color: var(--bg); font: 700 15px var(--body); cursor: pointer }
.get-s { height: 34px; padding: 0 16px; border-radius: 999px; border: 0; background: #232327; color: var(--ink); font: 700 13px var(--body); cursor: pointer }
.get-m { height: 40px; padding: 0 16px; border-radius: 10px; border: 0; background: var(--ink); color: var(--bg); font: 700 14px var(--body); cursor: pointer; align-self: flex-start }
.get-m:disabled { background: #232327; color: var(--muted); cursor: default }
.get-xl { height: 52px; border-radius: 14px; border: 0; background: var(--ink); color: var(--bg); font: 700 16px var(--body); cursor: pointer }
.get-xl:disabled { opacity: .5 }
.prog { display: flex; flex-direction: column; gap: 10px }
.prog.bad { border-color: rgba(255,122,122,.35) }
.prog-h { display: flex; align-items: center; gap: 10px }
.prog-h b { flex: 1; font-size: 15px }
.prog-now { font-size: 13px }
.spin-s { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite }
@keyframes sp { to { transform: rotate(360deg) } }

/* sections */
.d-sec { display: flex; flex-direction: column; gap: 14px }
.sec-h { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px }
.sec-h > div { display: flex; flex-direction: column; gap: 2px; min-width: 0 }
.sec-h h3 { margin: 0; font: 700 26px var(--display); text-transform: uppercase; letter-spacing: .3px }
.see { background: none; border: 0; color: var(--ink); font: 600 14px var(--body); cursor: pointer; white-space: nowrap; padding: 6px 0 }
.rep-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px }
.rep-t { text-align: left; border: 1px solid var(--line); background: var(--panel); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 10px; color: var(--ink); cursor: pointer; font: inherit; min-width: 0 }
.rep-t:hover { border-color: #4a4a50 }
.rep-t b { font: 700 22px/1.05 var(--display) }
.rep-apps { display: flex; align-items: center; gap: 4px; min-width: 0 }
.rep-apps span { margin-left: 6px; font-size: 13px; color: #c9c9ce; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.pack-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px }
.pack { border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: var(--panel); display: flex; flex-direction: column }
.pack-art { height: 104px; display: flex; align-items: flex-end; gap: 8px; padding: 16px }
.pack-b { padding: 16px; display: flex; flex-direction: column; gap: 8px; flex: 1 }
.pack-b b { font-size: 18px }
.pack-b p { margin: 0; font-size: 14px; flex: 1 }
.pack-apps { display: flex; gap: 6px 12px; flex-wrap: wrap }
.pack-apps .lnk { font-size: 13px; color: #c9c9ce }
.genre-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 12px }
.genre { text-align: left; border: 1px solid var(--line); background: var(--panel); border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 8px; color: var(--ink); cursor: pointer; font: inherit; min-width: 0 }
.genre:hover { border-color: #4a4a50 }
.genre b { font-size: 15px }
.genre small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.g-top { display: flex; align-items: center; justify-content: space-between }
.g-ic { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: 0 0 auto }
.g-ic.lg { width: 48px; height: 48px; border-radius: 13px }
.g-ic.xl { width: 72px; height: 72px; border-radius: 18px; background: rgba(255,255,255,.08) }
.genre-big { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 14px }
.genre.lg { padding: 18px; gap: 10px }
.genre.lg b { font-size: 18px }
.g-logos { display: flex; gap: 4px }
.rows3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 0 24px }
/* overflow-x clips vertically too: room around the cards so the hover lift and focus ring aren't cut */
.shelf { display: grid; grid-auto-flow: column; grid-auto-columns: clamp(280px, 24%, 380px); gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 6px 4px 10px; margin: -6px -4px -4px; scroll-padding-inline: 4px }
.shelf > * { scroll-snap-align: start }
.rep-list { display: flex; flex-direction: column; gap: 14px }
.rep-row { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: center; border-bottom: 1px solid #1a1a1e; padding-bottom: 14px }
.rep-svc { display: flex; flex-direction: column }
.rep-svc b { font: 700 24px/1.05 var(--display) }
.rep-apps-l { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px }

/* grid view */
.crumbs { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 14px; margin-bottom: -12px }
.crumbs .lnk { color: var(--muted); text-decoration: none; font-weight: 500 }
.g-head { border-radius: 20px; border: 1px solid var(--line); padding: 26px; display: flex; gap: 22px; align-items: center; flex-wrap: wrap }
.g-head h2, .g-title { margin: 0; font: 700 42px/1 var(--display); text-transform: uppercase; letter-spacing: .4px; color: var(--ink) }
.g-head p { margin: 4px 0; color: #d4d4d8; font-size: 16px }
.g-head small { color: #b4b4bb }
.filters { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 8px 0 }
.chips-row { display: flex; gap: 8px; overflow-x: auto; padding: 4px 4px 4px; margin: -4px -4px 0 }
.fchip { flex: 0 0 auto; height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font: 600 13.5px var(--body); cursor: pointer; display: inline-flex; gap: 8px; align-items: center }
.fchip span, .seg3 span { font: 600 11.5px var(--mono); opacity: .65 }
.fchip[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
.f-bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap }
.seg3 { display: inline-flex; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 3px; flex-wrap: wrap }
.seg3 button { height: 34px; padding: 0 12px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); font: 600 13px var(--body); cursor: pointer }
.seg3 button[aria-pressed="true"] { background: #2c2c31; color: var(--ink) }
.sortl { display: inline-flex; gap: 8px; align-items: center; margin-left: auto; color: var(--muted); font-size: 13.5px }
.sortl select { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; height: 36px; padding: 0 10px; font: 600 13px var(--body) }
.applied { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px }
.achip { display: inline-flex; gap: 6px; align-items: center; background: #1a1a1e; border-radius: 999px; padding: 4px 4px 4px 10px }
.achip button { width: 22px; height: 22px; border-radius: 50%; border: 0; background: #2c2c31; color: var(--ink); font-size: 11px; cursor: pointer }
.grid3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px }

/* drawer */
.ad-h { display: flex; gap: 16px; align-items: center }
.ad-n { display: flex; flex-direction: column; gap: 3px; min-width: 0 }
.ad-n h2 { margin: 0; font: 700 34px/1 var(--display); color: var(--ink); text-transform: none; letter-spacing: 0 }
.dr-app .dr-b > * { flex-shrink: 0 }
.ad-rep { font-size: 14px; color: #c9c9ce }
.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 14px; overflow: hidden }
.facts > div { padding: 10px 12px; display: flex; flex-direction: column; gap: 1px; border-right: 1px solid #1a1a1e; min-width: 0 }
.facts > div:last-child { border-right: 0 }
.facts small { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.facts b { font: 600 15px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.hc-active { color: #3ecf8e }
.hc-slowing { color: #f5b544 }
.hc-stale, .hc-archived { color: #ff7a7a }
.how { display: flex; flex-direction: column; gap: 8px; font-size: 14px }
.how b { font: 700 14.5px var(--body); color: var(--ink) }
.how ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; color: #c9c9ce }
.other summary { cursor: pointer; color: var(--muted); font-size: 13.5px; font-weight: 600 }
.other[open] { display: flex; flex-direction: column; gap: 8px }
.shots { position: relative; display: flex; flex-direction: column; gap: 8px }
.strip { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; border-radius: 12px; border: 1px solid var(--line); scrollbar-width: none }
.strip::-webkit-scrollbar { display: none }
.strip img { flex: 0 0 100%; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; scroll-snap-align: start; background: var(--panel) }
.nav { position: absolute; top: calc(50% - 30px); width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15); background: rgba(10,10,12,.7); color: var(--ink); font: 700 22px/1 var(--body); cursor: pointer; display: grid; place-items: center; backdrop-filter: blur(4px) }
.nav:disabled { opacity: 0; pointer-events: none }
.nav.prev { left: 8px } .nav.next { right: 8px }
.dots { display: flex; gap: 6px; justify-content: center }
.dots button { width: 8px; height: 8px; padding: 0; border-radius: 50%; border: 0; background: #3a3a40; cursor: pointer }
.dots button[aria-pressed="true"] { background: var(--ink) }
.ad-desc { margin: 0; color: #c9c9ce }
.ad-chips { display: flex; gap: 6px; flex-wrap: wrap }
.ad-chips span { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: #1a1a1e; color: #c9c9ce }
.ad-sec { display: flex; flex-direction: column; gap: 6px }
.ad-sec h4 { margin: 4px 0 0; font: 700 20px var(--display); text-transform: uppercase; letter-spacing: .3px }
.sim { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px }
.sim-t { text-align: left; border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 6px; color: var(--ink); cursor: pointer; font: inherit; min-width: 0 }
.sim-t small { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }

@media (max-width: 1100px) {
  .picks { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) }
}
@media (max-width: 1000px) {
  .picks { grid-template-columns: 1fr }
  .picks-side { flex-direction: row }
  .picks-side > * { flex: 1 1 0; min-width: 0 }
}
@media (max-width: 760px) {
  .disc { gap: 22px }
  .d-title h1 { font-size: 36px }
  .d-search { flex: 1 1 100%; min-width: 0 }
  .picks { grid-template-columns: 1fr }
  .picks-side { flex-direction: column }
  .hero { height: 400px }
  .hero-dots { right: 12px }
  .hero-art { display: none }
  .hero-n h2 { font-size: 32px }
  .rep-row { grid-template-columns: 1fr }
  .rep-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) }
  .sortl { margin-left: 0 }
  .shelf { grid-auto-columns: 82% }
  .sim { grid-template-columns: repeat(2, minmax(0, 1fr)) }
}
</style>
