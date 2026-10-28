<script setup lang="ts">
// Ports (design: "Server OS — Ports overview" in Claude Design): every listening port, who owns it, who can
// reach it and which name points at it. Summary cards, a stretched port map, filters, a table, an inspector drawer.
import { ref, computed } from "vue";
import { S, appList } from "../store";
import AppIcon from "../components/AppIcon.vue";
import AnimatedNumber from "../components/AnimatedNumber.vue";

interface Row { port: number; proto: "tcp" | "udp"; scope: "local" | "tailnet" | "network"; addresses: string[]; process: string; pid: number | null; app: string | null; service: string | null; docker: { container: string; containerPort: number } | null; names: string[]; issue: "unknown" | null }
interface Report { at: number; rows: Row[]; deadNames: { name: string; port: number }[]; routes?: number; counts: { total: number; network: number; local: number; tailnet: number; docker: number; issues: number } }
const rep = computed(() => (S as unknown as { ports?: Report }).ports ?? null);

type F = "all" | "network" | "local" | "docker" | "issues";
const filter = ref<F>("all"), q = ref(""), openKey = ref<string | null>(null);
const key = (r: Row) => `${r.port}/${r.proto}/${r.process}`;
const rows = computed(() => {
  const ql = q.value.trim().toLowerCase();
  return (rep.value?.rows ?? []).filter((r) =>
    (filter.value === "all" || (filter.value === "network" ? r.scope === "network" : filter.value === "local" ? r.scope !== "network" : filter.value === "docker" ? !!r.docker : !!r.issue))
    && (!ql || [r.port, r.app, r.service, r.process, ...r.names, r.docker?.container].join(" ").toLowerCase().includes(ql)));
});
const FILTERS = computed(() => { const c = rep.value?.counts; return [["all", "All", c?.total], ["network", "Open to the network", c?.network], ["local", "This machine only", (c?.local ?? 0) + (c?.tailnet ?? 0)], ["docker", "Docker", c?.docker], ["issues", "Needs a look", c?.issues]] as [F, string, number | undefined][]; });

// Stretched scale: most services live between 3000 and 12000.
const STOPS: [number, number][] = [[0, 0], [1024, 8], [3000, 16], [12000, 82], [65535, 100]];
function pos(p: number) {
  for (let i = 1; i < STOPS.length; i++) {
    const [a, pa] = STOPS[i - 1], [b, pb] = STOPS[i];
    if (p <= b) return pa + ((p - a) / (b - a)) * (pb - pa);
  }
  return 100;
}
const TICKS = [0, 1024, 3000, 5000, 8000, 12000, 65535];
const COLOR = (r: Row) => (r.issue ? "issue" : r.docker ? "docker" : r.scope === "network" ? "net" : "local");
const marks = computed(() => (rep.value?.rows ?? []).filter((r, i, a) => a.findIndex((x) => x.port === r.port) === i));
const hover = ref<Row | null>(null);
// Marks outside the current filter or search fade to grey and shrink, so the matching ones stand out on the map.
const matching = computed(() => new Set(rows.value.map((r) => r.port)));
const filtered = computed(() => filter.value !== "all" || !!q.value.trim());

const app = (name: string | null) => (name ? appList.value.find((a) => a.name === name) ?? null : null);
const appLink = (name: string) => `#apps?open=${encodeURIComponent(name)}`;
const owner = (r: Row) => r.app ?? r.service ?? (r.docker ? r.docker.container : "Unknown listener");
const scopeLabel = { network: "Whole network", local: "This machine only", tailnet: "Tailnet only" } as const;
const opened = computed(() => (rep.value?.rows ?? []).find((r) => key(r) === openKey.value) ?? null);
const siblings = computed(() => (opened.value?.app ? (rep.value?.rows ?? []).filter((r) => r.app === opened.value!.app && key(r) !== openKey.value) : []));
const addr = (a: string) => (a.includes(":") ? `[${a}]` : a);
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Ports</h1>
      <label class="search2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="q" type="search" placeholder="Search 8096, Jellyfin, files.home…" aria-label="Search ports, apps or names" />
      </label>
    </header>

    <p v-if="!rep" class="hint">Reading the ports…</p>
    <template v-else>
      <section class="segs" aria-label="Summary">
        <button type="button" class="seg" :aria-pressed="filter === 'all'" @click="filter = 'all'"><span>Listening</span><b><AnimatedNumber :value="rep.counts.total" /></b></button>
        <button type="button" class="seg" :aria-pressed="filter === 'network'" @click="filter = 'network'"><span>Open to the network</span><b style="color: var(--warn)"><AnimatedNumber :value="rep.counts.network" /></b></button>
        <button type="button" class="seg" :aria-pressed="filter === 'local'" @click="filter = 'local'"><span>This machine only</span><b style="color: var(--on)"><AnimatedNumber :value="rep.counts.local + rep.counts.tailnet" /></b></button>
        <button type="button" class="seg" :class="{ bad: rep.counts.issues > 0 }" :aria-pressed="filter === 'issues'" @click="filter = 'issues'"><span>Needs a look</span><b :style="{ color: rep.counts.issues ? 'var(--bad)' : undefined }"><AnimatedNumber :value="rep.counts.issues" /></b></button>
      </section>

      <section class="card2 pmap" aria-label="Port map">
        <div class="ch"><h3>Port map</h3>
          <div class="legend">
            <span><i class="lsw net"></i>Open to the network</span><span><i class="lsw local"></i>This machine only</span><span><i class="lsw docker"></i>Docker</span><span><i class="lsw issue"></i>Needs a look</span>
          </div>
        </div>
        <div class="pm" role="img" :aria-label="`${marks.length} ports placed on a scale from 0 to 65535`">
          <div class="pm-band"><i style="flex: 8"></i><i style="flex: 8"></i><i style="flex: 66"></i><i style="flex: 18"></i></div>
          <button v-for="r in marks" :key="key(r)" type="button" class="pm-mark" :class="[COLOR(r), { on: openKey === key(r), dim: filtered && !matching.has(r.port) }]" :style="{ left: pos(r.port) + '%' }"
            :aria-label="`Port ${r.port}, ${owner(r)}`" @mouseenter="hover = r" @mouseleave="hover = null" @focus="hover = r" @blur="hover = null" @click="openKey = key(r)"></button>
          <div v-if="hover" class="pm-tip" :style="{ left: pos(hover.port) + '%' }">{{ hover.port }} · {{ owner(hover) }}</div>
          <div class="pm-ticks"><span v-for="t in TICKS" :key="t" :style="{ left: pos(t) + '%' }">{{ t }}</span></div>
        </div>
        <p class="hint">The scale is stretched where services cluster (3000–12000). Point at a mark for its owner; click to inspect.</p>
      </section>

      <div class="chips" role="group" aria-label="Filter">
        <button v-for="[k, l, n] in FILTERS" :key="k" type="button" class="chip" :aria-pressed="filter === k" @click="filter = k">{{ l }} {{ n ?? "" }}</button>
      </div>

      <section class="card2 ptbl" aria-label="Ports">
        <div class="ptbl-in">
          <div class="pr ph2"><span>Port</span><span>Owner</span><span>Name</span><span>Who can reach it</span><span>Process</span></div>
          <button v-for="r in rows" :key="key(r)" type="button" class="pr" :class="{ sel: openKey === key(r) }" @click="openKey = key(r)">
            <span class="pp"><b>{{ r.port }}</b><small v-if="r.proto === 'udp'">udp</small><small v-if="r.docker">→ {{ r.docker.containerPort }} in container</small></span>
            <span class="po">
              <AppIcon v-if="app(r.app)" :name="r.app!" :icon="app(r.app)!.icon" />
              <span v-else class="po-ic" :class="{ unk: r.issue }">{{ r.issue ? "?" : owner(r)[0] }}</span>
              <span class="po-t"><b :class="{ bad: r.issue }">{{ owner(r) }}</b><small>{{ r.app ? app(r.app)?.group ?? "App" : r.service ? "Service" : r.docker ? "Docker container" : "not one of your apps" }}</small></span>
            </span>
            <span class="pn"><template v-if="r.names.length">{{ r.names[0] }}<small v-if="r.names.length > 1"> +{{ r.names.length - 1 }}</small></template><template v-else-if="r.process === 'caddy' && rep?.routes && (r.port === 80 || r.port === 443)">routes {{ rep.routes }} names</template><template v-else>—</template></span>
            <span class="ps" :class="r.scope"><i></i>{{ scopeLabel[r.scope] }}</span>
            <span class="pc">{{ r.process || "—" }}<small v-if="r.pid"> · {{ r.pid }}</small></span>
          </button>
          <p v-if="!rows.length" class="hint" style="padding: 16px">Nothing matches.</p>
        </div>
      </section>

      <section v-if="rep.deadNames.length" class="card2">
        <div class="ch"><h3>Names with nothing behind them</h3><span class="muted">usually an app that's switched off</span></div>
        <div class="chips"><span v-for="d in rep.deadNames" :key="d.name" class="tag">{{ d.name }} → :{{ d.port }}</span></div>
      </section>
      <p class="foot">Read from the system every 30 s — listening sockets, Docker port maps and Caddy routes. Nothing here opens or closes a port.</p>
    </template>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="opened" class="dr-wrap">
          <div class="dr-bg" @click="openKey = null"></div>
          <aside class="dr" role="dialog" aria-modal="true" :aria-label="`Port ${opened.port}`">
            <div class="dr-h"><span class="dr-title">Port {{ opened.port }}</span><button type="button" class="btn" aria-label="Close" @click="openKey = null">✕</button></div>
            <div class="dr-b">
              <div class="dh">
                <AppIcon v-if="app(opened.app)" :name="opened.app!" :icon="app(opened.app)!.icon" />
                <div><div style="font-weight: 700; font-size: 17px">{{ owner(opened) }}</div><div class="muted">{{ opened.docker ? `Docker container ${opened.docker.container}` : opened.process || "unknown process" }}</div></div>
              </div>
              <component :is="opened.app ? 'a' : 'div'" class="dbox path" :class="{ go: opened.app }" :href="opened.app ? appLink(opened.app) : undefined"
                :aria-label="opened.app ? `Open ${opened.app} in Apps` : 'How this port is reached'">
                <small>How it's reached<span v-if="opened.app" class="go-hint">Open in Apps →</span></small>
                <div class="path-row">
                  <template v-if="opened.names.length"><span class="pill2">{{ opened.names[0] }}</span><i aria-hidden="true">→</i><span class="pill2">Caddy</span><i aria-hidden="true">→</i></template>
                  <span class="pill2 hi">:{{ opened.port }}</span>
                  <template v-if="opened.docker"><i aria-hidden="true">→</i><span class="pill2 dk">container :{{ opened.docker.containerPort }}</span></template>
                </div>
              </component>
              <div class="dbox lifebox">
                <div class="kv2"><span>Listens on</span><b>{{ opened.addresses.map(addr).join(", ") }}</b></div>
                <div class="kv2"><span>Protocol</span><b>{{ opened.proto.toUpperCase() }}</b></div>
                <div class="kv2"><span>Process</span><b>{{ opened.process || "—" }}{{ opened.pid ? ` · pid ${opened.pid}` : "" }}</b></div>
                <div class="kv2"><span>Who can reach it</span><b>{{ scopeLabel[opened.scope] }}</b></div>
              </div>
              <div v-if="opened.scope === 'network'" class="warnbox amber">
                <b>Open to the whole network.</b> Any device on your Wi-Fi can connect to port {{ opened.port }} directly{{ opened.names.length ? `, skipping ${opened.names[0]}` : "" }}.
                <template v-if="opened.issue"> Nothing on this server explains it — check what {{ opened.process || "this process" }} is.</template>
              </div>
              <template v-if="siblings.length">
                <div class="logsrc">Other ports of {{ opened.app }}</div>
                <div class="chips"><button v-for="s in siblings" :key="key(s)" type="button" class="chip" @click="openKey = key(s)">{{ s.port }}{{ s.proto === "udp" ? " udp" : "" }}</button></div>
              </template>
              <a v-if="opened.names.length" class="btn primary big" :href="`http://${opened.names[0]}`" target="_blank" rel="noopener">Open {{ opened.names[0] }} ↗</a>
              <a v-if="opened.app" class="btn big" :href="appLink(opened.app)">Go to the app</a>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>
