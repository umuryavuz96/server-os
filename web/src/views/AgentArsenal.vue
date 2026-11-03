<script setup lang="ts">
// Arsenal tab of the Agent network page: the vendored persona catalog (~/.agents/arsenal), the role defaults that
// ~/scripts/lib/pick-soul.sh reads (editable, writes roles.json) and the recent soul-routing decisions.
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { api, ago, toast } from "../store";
import Icon from "../components/Icon.vue";

interface Entry { id: string; name: string; repo: string; path: string; source_url?: string; stars: number; licence: string; category: string; description: string; tools: string[]; model_hint: string | null; tags: string[]; review?: { status: string; note?: string } }
interface RoleDef { default: string; alternates?: string[]; categories?: string[] }
interface Dec { ts: string; agent: string; role: string; job: string; ask: string; soul: string; score: number; kw: number; reason: string }
interface Src { repo: string; stars: number; licence: string; sha: string; date: string; url: string; kept?: number }
interface Res { generated: string | null; agents: Entry[]; roles: Record<string, RoleDef>; decisions: Dec[]; sources: Src[] | null }

const data = ref<Res | null>(null), err = ref(""), loading = ref(true);
const view = ref<"catalog" | "roles" | "log">("catalog");
const q = ref(""), cat = ref(""), repo = ref(""), sort = ref<"stars" | "name">("stars"), limit = ref(60);
const sel = ref<Entry | null>(null), body = ref(""), bodyErr = ref(""), copied = ref(false);
const draft = ref<Record<string, RoleDef> | null>(null), saving = ref(false);
const picker = ref<string | null>(null), pq = ref("");

const agents = computed(() => data.value?.agents ?? []);
const byId = computed(() => new Map(agents.value.map((a) => [a.id, a])));
const roles = computed(() => draft.value ?? data.value?.roles ?? {});
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(data.value?.roles));
const defaultOf = computed(() => { const m = new Map<string, string[]>(); for (const [r, d] of Object.entries(data.value?.roles ?? {})) (m.get(d.default) ?? m.set(d.default, []).get(d.default)!).push(r); return m; });

const cats = computed(() => { const m = new Map<string, number>(); for (const a of agents.value) m.set(a.category, (m.get(a.category) ?? 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1]); });
const repos = computed(() => { const m = new Map<string, number>(); for (const a of agents.value) m.set(a.repo, (m.get(a.repo) ?? 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1]); });
const match = (a: Entry, words: string[]) => words.every((w) => (a.name + " " + a.id + " " + a.tags.join(" ") + " " + a.category + " " + a.description).toLowerCase().includes(w));
const shown = computed(() => {
  const w = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const l = agents.value.filter((a) => (!cat.value || a.category === cat.value) && (!repo.value || a.repo === repo.value) && match(a, w));
  return l.sort((x, y) => (sort.value === "stars" ? y.stars - x.stars || x.name.localeCompare(y.name) : x.name.localeCompare(y.name)));
});
watch([q, cat, repo, sort], () => { limit.value = 60; });
const stars = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

async function load() {
  try { data.value = await api<Res>("/arsenal"); err.value = ""; } catch (e) { err.value = (e as Error).message; } finally { loading.value = false; }
}
onMounted(load);

async function open(a: Entry) {
  sel.value = a; body.value = ""; bodyErr.value = ""; copied.value = false;
  try { const r = await api<{ body: string }>("/arsenal/agent?id=" + encodeURIComponent(a.id)); if (sel.value?.id === a.id) body.value = r.body; }
  catch (e) { bodyErr.value = (e as Error).message; }
  await nextTick(); (document.querySelector(".ax-drawer .ax-close") as HTMLElement | null)?.focus();
}
const close = () => { sel.value = null; };
async function copy() { try { await navigator.clipboard.writeText(body.value); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { toast("Copy failed"); } }

function edit(): Record<string, RoleDef> { if (!draft.value) draft.value = JSON.parse(JSON.stringify(data.value?.roles ?? {})); return draft.value!; }
function pick(role: string, id: string) { const d = edit(); d[role] = { ...d[role], default: id }; picker.value = null; pq.value = ""; }
function setDefaultFromDrawer(role: string) { if (sel.value) { pick(role, sel.value.id); toast(`${role} default is now ${sel.value.name}. Save on the Roles tab.`); } }
async function saveRoles() {
  if (!draft.value || saving.value) return; saving.value = true;
  try { const r = await api<{ roles: Record<string, RoleDef> }>("/arsenal/roles", { method: "PUT", body: { roles: draft.value } }); data.value = { ...data.value!, roles: r.roles }; draft.value = null; toast("Role defaults saved"); }
  catch (e) { err.value = (e as Error).message; } finally { saving.value = false; }
}
const pickList = computed(() => {
  if (!picker.value) return [];
  const r = roles.value[picker.value], w = pq.value.toLowerCase().split(/\s+/).filter(Boolean), cs = new Set(r?.categories ?? []);
  return agents.value.filter((a) => match(a, w)).sort((x, y) => Number(cs.has(y.category)) - Number(cs.has(x.category)) || y.stars - x.stars).slice(0, 40);
});
const when = (ts: string) => ago(Date.parse(ts) / 1000);
const CAT_HUE: Record<string, number> = { frontend: 200, backend: 150, mobile: 280, design: 330, qa: 50, devops: 20, research: 240, data: 175, writing: 100, security: 0, architecture: 260, review: 70, general: 210 };
const hue = (c: string) => CAT_HUE[c] ?? 210;
</script>

<template>
  <section class="ax" aria-label="Agent arsenal">
    <p v-if="err" class="ax-err" role="alert">{{ err }}</p>
    <div class="ax-top">
      <div class="ax-seg" role="tablist" aria-label="Arsenal sections">
        <button v-for="v in (['catalog', 'roles', 'log'] as const)" :key="v" type="button" role="tab" :aria-selected="view === v" :class="{ on: view === v }" @click="view = v">{{ v === "catalog" ? "Catalog" : v === "roles" ? "Role defaults" : "Routing log" }}</button>
      </div>
      <span class="ax-sum num">{{ agents.length }} personas · {{ repos.length }} repos</span>
    </div>

    <!-- CATALOG -->
    <template v-if="view === 'catalog'">
      <div class="ax-filters">
        <label class="ax-search"><Icon name="search" :size="16" /><input v-model="q" type="search" placeholder="Search name, tag or description" aria-label="Search the catalog" /></label>
        <div class="ax-chips" role="group" aria-label="Category">
          <button type="button" class="ax-chip" :aria-pressed="!cat" @click="cat = ''">All <em>{{ agents.length }}</em></button>
          <button v-for="[c, n] in cats" :key="c" type="button" class="ax-chip" :style="{ '--h': hue(c) }" :aria-pressed="cat === c" @click="cat = cat === c ? '' : c">{{ c }} <em>{{ n }}</em></button>
        </div>
        <div class="ax-chips" role="group" aria-label="Source repository">
          <button v-for="[r, n] in repos" :key="r" type="button" class="ax-chip repo" :aria-pressed="repo === r" @click="repo = repo === r ? '' : r">{{ r }} <em>{{ n }}</em></button>
          <div class="ax-sort" role="group" aria-label="Sort"><button type="button" :aria-pressed="sort === 'stars'" @click="sort = 'stars'">Stars</button><button type="button" :aria-pressed="sort === 'name'" @click="sort = 'name'">A–Z</button></div>
        </div>
      </div>
      <p class="ax-count num" role="status">{{ shown.length }} of {{ agents.length }} shown</p>
      <p v-if="!loading && !agents.length" class="ax-empty">The catalog is empty. Run the inventory first (~/.agents/arsenal/catalog.json).</p>
      <p v-else-if="!shown.length" class="ax-empty">Nothing matches. <button type="button" class="ax-link" @click="q = ''; cat = ''; repo = ''">Clear filters</button></p>
      <div class="ax-grid">
        <button v-for="a in shown.slice(0, limit)" :key="a.id" type="button" class="ax-card" :style="{ '--h': hue(a.category) }" @click="open(a)">
          <span class="ax-ch"><b class="ax-name">{{ a.name }}</b><span v-if="defaultOf.get(a.id)" class="ax-def" :title="'Default for ' + defaultOf.get(a.id)!.join(', ')">default</span></span>
          <span class="ax-meta"><span class="ax-pill cat">{{ a.category }}</span><span class="ax-star num">★ {{ stars(a.stars) }}</span><span class="ax-pill">{{ a.licence }}</span><span v-if="a.model_hint" class="ax-pill">{{ a.model_hint }}</span></span>
          <span class="ax-desc">{{ a.description }}</span>
          <span class="ax-repo">{{ a.repo }}</span>
        </button>
      </div>
      <button v-if="shown.length > limit" type="button" class="ax-more" @click="limit += 60">Show {{ Math.min(60, shown.length - limit) }} more</button>
    </template>

    <!-- ROLE DEFAULTS -->
    <template v-else-if="view === 'roles'">
      <p class="ax-note">When a new agent starts, <code>pick-soul.sh</code> begins from its role's default persona and switches to a better match only if the job's own words point at one. Saved to <code>roles.json</code>.</p>
      <ul class="ax-roles">
        <li v-for="(d, r) in roles" :key="r" class="ax-role" :class="{ changed: data?.roles[r]?.default !== d.default }">
          <div class="ax-rn"><b>{{ r }}</b><span class="ax-cats"><span v-for="c in d.categories ?? []" :key="c" class="ax-pill cat" :style="{ '--h': hue(c) }">{{ c }}</span></span></div>
          <button type="button" class="ax-rd" @click="picker = r; pq = ''">
            <template v-if="byId.get(d.default)"><b>{{ byId.get(d.default)!.name }}</b><small>{{ byId.get(d.default)!.repo }} · ★ {{ stars(byId.get(d.default)!.stars) }}</small></template>
            <template v-else><b class="bad">{{ d.default }}</b><small>not in the catalog</small></template>
            <span class="ax-edit">Change</span>
          </button>
        </li>
      </ul>
      <Transition name="ax-bar">
        <div v-if="dirty" class="ax-save" role="region" aria-label="Unsaved role defaults">
          <span class="ax-sm">Role defaults changed</span>
          <button type="button" class="ax-b" @click="draft = null">Discard</button>
          <button type="button" class="ax-b go" :disabled="saving" @click="saveRoles">{{ saving ? "Saving…" : "Save" }}</button>
        </div>
      </Transition>
    </template>

    <!-- LOG -->
    <template v-else>
      <p v-if="!data?.decisions.length" class="ax-empty">No persona has been picked yet. Each spawn with a soul adds a line here.</p>
      <ul class="ax-log">
        <li v-for="(d, i) in data?.decisions ?? []" :key="i" class="ax-ld">
          <span class="ax-lt num">{{ when(d.ts) }}</span>
          <span class="ax-la"><b>{{ d.agent || d.role }}</b><small>{{ d.job || d.ask }}</small></span>
          <span class="ax-lm"><button type="button" class="ax-link" @click="byId.get(d.soul) && open(byId.get(d.soul)!)">{{ byId.get(d.soul)?.name ?? d.soul }}</button><span class="ax-pill dim num">score {{ d.score }}</span></span>
          <span class="ax-lr">{{ d.reason }}</span>
        </li>
      </ul>
    </template>

    <!-- DRAWER -->
    <Transition name="ax-fade"><div v-if="sel || picker" class="ax-scrim" @click="close(); picker = null"></div></Transition>
    <Transition name="ax-slide">
      <aside v-if="sel" class="ax-drawer" role="dialog" aria-modal="true" :aria-label="sel.name" @keydown.esc="close">
        <header class="ax-dh"><div><h2>{{ sel.name }}</h2><p class="ax-meta"><span class="ax-pill cat" :style="{ '--h': hue(sel.category) }">{{ sel.category }}</span><span class="ax-star num">★ {{ stars(sel.stars) }}</span><span class="ax-pill">{{ sel.licence }}</span><span v-if="sel.model_hint" class="ax-pill">{{ sel.model_hint }}</span></p></div><button type="button" class="ax-close" aria-label="Close" @click="close"><Icon name="x" :size="18" /></button></header>
        <div class="ax-db">
          <p class="ax-dd">{{ sel.description }}</p>
          <div class="ax-sec"><Icon name="shield-check" :size="16" /><span><b>Security review: {{ sel.review?.status ?? "not recorded" }}</b><br />{{ sel.review?.note || "No concerns noted." }}</span></div>
          <dl class="ax-kv">
            <dt>Source</dt><dd><a v-if="sel.source_url" :href="sel.source_url" target="_blank" rel="noopener noreferrer">{{ sel.repo }} <Icon name="external-link" :size="12" /></a><template v-else>{{ sel.repo }}</template></dd>
            <dt>File</dt><dd class="mono">{{ sel.path }}</dd>
            <dt>Tools</dt><dd>{{ sel.tools.join(", ") || "inherits all" }}</dd>
            <dt>Tags</dt><dd>{{ sel.tags.join(", ") || "none" }}</dd>
            <dt>Spawn</dt><dd class="mono">spawn.sh claude-code NAME --soul {{ sel.id }}</dd>
          </dl>
          <div v-if="Object.keys(roles).length" class="ax-use"><span>Make default for</span><div class="ax-chips"><button v-for="(d, r) in roles" :key="r" type="button" class="ax-chip" :aria-pressed="d.default === sel.id" @click="setDefaultFromDrawer(r as string)">{{ r }}</button></div></div>
          <div class="ax-ph"><b>Persona text</b><button type="button" class="ax-b" :disabled="!body" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
          <p v-if="bodyErr" class="ax-err">{{ bodyErr }}</p>
          <pre v-else class="ax-pre">{{ body || "Loading…" }}</pre>
        </div>
      </aside>
    </Transition>
    <Transition name="ax-slide">
      <aside v-if="picker" class="ax-drawer" role="dialog" aria-modal="true" :aria-label="'Choose default for ' + picker" @keydown.esc="picker = null">
        <header class="ax-dh"><div><h2>Default for {{ picker }}</h2><p class="ax-dd">Role categories are listed first.</p></div><button type="button" class="ax-close" aria-label="Close" @click="picker = null"><Icon name="x" :size="18" /></button></header>
        <div class="ax-db">
          <label class="ax-search"><Icon name="search" :size="16" /><input v-model="pq" type="search" placeholder="Search personas" aria-label="Search personas" autofocus /></label>
          <ul class="ax-pick"><li v-for="a in pickList" :key="a.id"><button type="button" :class="{ on: roles[picker!]?.default === a.id }" @click="pick(picker!, a.id)"><b>{{ a.name }}</b><small>{{ a.category }} · {{ a.repo }} · ★ {{ stars(a.stars) }}</small></button></li></ul>
        </div>
      </aside>
    </Transition>
  </section>
</template>

<style scoped>
.ax{display:flex;flex-direction:column;gap:12px;padding-bottom:24px;min-width:0}
.ax-err,.bad{color:var(--warn)}
.ax-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ax-sum{color:var(--muted);font:400 12.5px var(--body)}
.ax-seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:rgba(255,255,255,.06)}
.ax-seg button{min-height:34px;padding:0 14px;border:0;border-radius:8px;background:none;color:var(--muted);font:600 13px var(--body);cursor:pointer;transition:background .15s,color .15s}
.ax-seg button.on{background:rgba(255,255,255,.16);color:var(--ink)}
.ax-filters{display:flex;flex-direction:column;gap:10px}
.ax-search{display:flex;align-items:center;gap:8px;height:42px;padding:0 12px;border-radius:12px;border:1px solid var(--hair);background:var(--soft);color:var(--muted)}
.ax-search input{flex:1;min-width:0;height:100%;border:0;background:none;color:var(--ink);font:400 14px var(--body);outline:none}
.ax-search:focus-within{border-color:rgba(255,255,255,.4)}
.ax-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ax-chip{--h:210;min-height:32px;padding:0 11px;border-radius:999px;border:1px solid var(--hair);background:none;color:var(--ink);font:500 12.5px var(--body);cursor:pointer;text-transform:capitalize;transition:background .15s,border-color .15s}
.ax-chip em{font-style:normal;color:var(--muted);margin-left:3px}
.ax-chip.repo{text-transform:none}
.ax-chip[aria-pressed="true"]{background:hsl(var(--h) 55% 45% / .3);border-color:hsl(var(--h) 60% 60% / .8)}
.ax-sort{margin-left:auto;display:inline-flex;padding:2px;border-radius:9px;background:rgba(255,255,255,.06)}
.ax-sort button{min-height:28px;padding:0 10px;border:0;border-radius:7px;background:none;color:var(--muted);font:600 12px var(--body);cursor:pointer}
.ax-sort button[aria-pressed="true"]{background:rgba(255,255,255,.16);color:var(--ink)}
.ax-count{margin:0;color:var(--muted);font:400 12px var(--body)}
.ax-empty,.ax-note{margin:0;color:var(--muted);font:400 13px/1.5 var(--body)}
.ax-note code{font:500 12px var(--mono);color:var(--ink)}
.ax-link{border:0;background:none;color:var(--ink);text-decoration:underline;cursor:pointer;font:inherit;padding:0}
.ax-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.ax-card{--h:210;display:flex;flex-direction:column;gap:8px;height:190px;padding:14px;border-radius:14px;border:1px solid var(--hair);border-top:3px solid hsl(var(--h) 60% 55% / .8);background:var(--soft);color:var(--ink);text-align:left;cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s,background .18s}
.ax-card:hover{transform:translateY(-2px);background:rgba(255,255,255,.07)}
.ax-ch{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ax-name{font:600 14px var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ax-def{flex:none;font:600 10.5px var(--mono);padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.14)}
.ax-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0}
.ax-pill{--h:210;font:600 11px var(--mono);padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--ink)}
.ax-pill.cat{background:hsl(var(--h) 55% 45% / .28)}.ax-pill.dim{color:var(--muted);background:rgba(255,255,255,.05)}
.ax-star{font:600 12px var(--body);color:var(--muted)}
.ax-desc{flex:1;min-height:0;max-height:5.5em;color:rgba(255,255,255,.78);font:400 12.5px/1.45 var(--body);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ax-repo{color:var(--muted);font:400 11.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ax-more{align-self:center;min-height:40px;padding:0 18px;border-radius:10px;border:1px solid var(--hair);background:none;color:var(--ink);font:600 13px var(--body);cursor:pointer}
.ax-roles,.ax-log,.ax-pick{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ax-roles{gap:8px}
.ax-role{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border-radius:14px;border:1px solid var(--hair);background:var(--soft)}
.ax-role.changed{border-color:rgba(255,255,255,.4)}
.ax-rn{display:flex;flex-direction:column;gap:6px;min-width:0}.ax-rn b{font:600 14px var(--body)}.ax-cats{display:flex;flex-wrap:wrap;gap:4px}
.ax-rd{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;max-width:60%;min-height:44px;padding:6px 62px 6px 12px;border-radius:10px;border:1px solid var(--hair);background:rgba(255,255,255,.04);color:var(--ink);text-align:left;cursor:pointer;position:relative}
.ax-rd b{font:600 13px var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.ax-rd small{color:var(--muted);font:400 11.5px var(--body)}
.ax-edit{position:absolute;right:10px;top:8px;color:var(--muted);font:500 11px var(--body)}
.ax-ld{display:grid;grid-template-columns:78px minmax(120px,1.2fr) auto minmax(0,2fr);gap:12px;align-items:start;padding:9px 0;border-top:1px solid var(--hair);font:400 12.5px var(--body)}
.ax-lt{color:var(--muted);white-space:nowrap}.ax-la{display:flex;flex-direction:column;min-width:0}.ax-la small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ax-lm{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ax-lr{color:var(--muted);overflow-wrap:anywhere}
.ax-save{position:sticky;bottom:0;margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(20,20,23,.97);border:1px solid rgba(255,255,255,.18);box-shadow:0 -10px 30px rgba(0,0,0,.4);z-index:2}
.ax-sm{flex:1;font:500 13px var(--body)}
.ax-b{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border-radius:9px;border:1px solid var(--hair);background:none;color:var(--ink);font:600 13px var(--body);cursor:pointer}
.ax-b.go{background:var(--ink);color:var(--bg);border-color:var(--ink)}.ax-b:disabled{opacity:.5;cursor:default}
.ax-scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:40}
.ax-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);z-index:41;display:flex;flex-direction:column;background:rgba(18,18,21,.98);border-left:1px solid rgba(255,255,255,.14);box-shadow:-20px 0 50px rgba(0,0,0,.45)}
.ax-dh{display:flex;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--hair)}
.ax-dh h2{margin:0 0 8px;font:700 18px var(--body);overflow-wrap:anywhere}
.ax-close{flex:none;width:44px;height:44px;border-radius:10px;border:0;background:rgba(255,255,255,.06);color:var(--ink);cursor:pointer;display:grid;place-items:center}
.ax-db{flex:1;min-height:0;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.ax-dd{margin:0;color:rgba(255,255,255,.82);font:400 13.5px/1.5 var(--body)}
.ax-sec{display:flex;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(80,200,120,.1);border:1px solid rgba(80,200,120,.3);font:400 12.5px/1.45 var(--body)}
.ax-kv{display:grid;grid-template-columns:70px 1fr;gap:6px 12px;margin:0;font:400 12.5px/1.4 var(--body)}
.ax-kv dt{color:var(--muted)}.ax-kv dd{margin:0;overflow-wrap:anywhere}.ax-kv a{color:var(--ink);display:inline-flex;gap:4px;align-items:center}
.mono{font-family:var(--mono);font-size:11.5px}
.ax-use{display:flex;flex-direction:column;gap:8px;font:500 12.5px var(--body);color:var(--muted)}
.ax-ph{display:flex;align-items:center;justify-content:space-between}
.ax-pre{margin:0;padding:12px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid var(--hair);white-space:pre-wrap;overflow-wrap:anywhere;font:400 12px/1.55 var(--mono);color:rgba(255,255,255,.85);max-height:none}
.ax-pick{gap:4px}.ax-pick button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-height:48px;padding:8px 12px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.04);color:var(--ink);text-align:left;cursor:pointer}
.ax-pick button.on,.ax-pick button:hover{border-color:rgba(255,255,255,.35)}.ax-pick small{color:var(--muted);font:400 11.5px var(--body)}
.ax-slide-enter-active,.ax-slide-leave-active{transition:transform .3s cubic-bezier(.2,.8,.2,1)}.ax-slide-enter-from,.ax-slide-leave-to{transform:translateX(100%)}
.ax-fade-enter-active,.ax-fade-leave-active,.ax-bar-enter-active,.ax-bar-leave-active{transition:opacity .2s,transform .25s cubic-bezier(.2,.8,.2,1)}
.ax-fade-enter-from,.ax-fade-leave-to,.ax-bar-enter-from,.ax-bar-leave-to{opacity:0}.ax-bar-enter-from,.ax-bar-leave-to{transform:translateY(16px)}
@media (max-width:700px){
  .ax-grid{grid-template-columns:1fr}.ax-card{height:auto;min-height:150px}
  .ax-drawer{width:100vw;top:8vh;border-radius:18px 18px 0 0;border-left:0;border-top:1px solid rgba(255,255,255,.14)}
  .ax-slide-enter-from,.ax-slide-leave-to{transform:translateY(100%)}
  .ax-ld{grid-template-columns:52px 1fr}.ax-lm,.ax-lr{grid-column:1/-1}
  .ax-role{flex-direction:column;align-items:stretch}.ax-rd{max-width:100%}
}
@media (prefers-reduced-motion:reduce){.ax-card,.ax-slide-enter-active,.ax-slide-leave-active,.ax-fade-enter-active,.ax-fade-leave-active,.ax-bar-enter-active,.ax-bar-leave-active{transition:none}}
</style>
