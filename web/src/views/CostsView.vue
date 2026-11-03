<script setup lang="ts">
// Costs: what it takes to run this server per month. Subscriptions and paid services (from the Usage tab), electricity, fixed costs the owner types in,
// and, shown next to it but never added to it, what the server's own Claude Code sessions would cost at API prices.
import { ref, computed } from "vue";
import { S, api, toast, ago } from "../store";
import Icon from "../components/Icon.vue";
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { money, compact } from "../money";

const c = computed(() => S.costs ?? null), cur = computed(() => c.value?.currency ?? "USD");
const m = (n: number | null | undefined, d?: number) => money(n, cur.value, d);
const h = computed(() => c.value?.headline);
const splitPct = computed(() => (h.value && h.value.monthly ? Math.round((h.value.actual / h.value.monthly) * 100) : 0));

// Chart geometry (viewBox units; the SVG scales to the card)
const W = 320, H = 96, PAD = 6;
const line = computed(() => {
  const t = c.value?.trend ?? [];
  if (t.length < 2) return null;
  const lo = 0, hi = Math.max(...t.map((d) => d.cost)), span = hi || 1;
  const pts = t.map((d, i) => [PAD + (i / (t.length - 1)) * (W - 2 * PAD), H - PAD - ((d.cost - lo) / span) * (H - 2 * PAD - 8) - 4] as const);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return { path, area: `${path} L${pts.at(-1)![0]},${H - PAD} L${pts[0][0]},${H - PAD} Z`, last: pts.at(-1)!, lo, hi };
});
const bars = computed(() => {
  const d = c.value?.ai.days ?? [], hi = Math.max(1, ...d.map((x) => x.cost)), bw = (W - 2 * PAD) / (d.length || 1);
  return d.map((x, i) => ({ x: PAD + i * bw + 1, w: Math.max(1, bw - 2), h: Math.max(x.cost ? 2 : 0, (x.cost / hi) * (H - 2 * PAD)), date: x.date, cost: x.cost }));
});
const KIND: Record<string, string> = { bot: "Bot", main: "Main session", project: "Project", system: "System" };
const SRC: Record<string, string> = { manual: "set by you", api: "from the service", estimate: "estimate", free: "free" };

// Fixed costs
const fn = ref(""), fm = ref<string | number>(""), saving = ref(false);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "cost";
async function add() {
  if (!fn.value.trim() || fm.value === "") return;
  saving.value = true;
  try { await api(`/costs/fixed/${slug(fn.value)}`, { method: "PUT", body: { name: fn.value.trim(), monthly: fm.value } }); fn.value = ""; fm.value = ""; } catch (e) { toast((e as Error).message); }
  saving.value = false;
}
async function del(id: string) { try { await api(`/costs/fixed/${id}`, { method: "DELETE" }); } catch (e) { toast((e as Error).message); } }
</script>

<template>
  <main class="page us-page">
    <header class="ph">
      <h1>Costs</h1>
      <span class="muted us-sub">What it takes to run this server</span>
      <a class="btn us-costs-link" href="#usage"><Icon name="gauge" :size="15" />Usage</a>
    </header>

    <p v-if="!c" class="hint us-empty"><Icon name="loader" :size="16" class="us-spin" /> Adding it up…</p>
    <template v-else>
      <section class="card2 us-hero cs-hero" aria-label="Monthly total">
        <div class="us-hero-n">
          <small>To run this server</small>
          <div class="us-big"><span aria-hidden="true">≈ </span><AnimatedNumber :value="h!.monthly" :fmt="(n: number) => m(n)" /><em> / month</em></div>
          <div class="cs-split" role="img" :aria-label="`${m(h!.actual)} counted, ${m(h!.estimate)} estimated`"><i :style="{ width: splitPct + '%' }"></i></div>
          <p class="us-hero-s"><span class="cs-dot"></span><b>{{ m(h!.actual) }}</b> counted <span class="cs-dot est"></span><b>{{ m(h!.estimate) }}</b> estimated</p>
        </div>
        <figure v-if="line" class="cs-trend">
          <figcaption><span>Daily running cost, 30 days</span><b class="num">{{ m(line.hi, 2) }}<small> peak</small></b></figcaption>
          <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" aria-label="Daily running cost for the last 30 days">
            <path :d="line.area" class="cs-area" /><path :d="line.path" class="cs-line" vector-effect="non-scaling-stroke" />
            <circle :cx="line.last[0]" :cy="line.last[1]" r="3.5" class="cs-pt" />
          </svg>
        </figure>
      </section>

      <div class="us-grid cs-grid">
        <section class="card2 us-card" aria-label="Subscriptions and paid services">
          <header class="us-h"><span class="cs-ic"><Icon name="wallet" :size="20" /></span><div class="us-t"><b>Subscriptions &amp; services</b><small>from the Usage tab</small></div><b class="num cs-v">{{ m(c.subscriptions.monthly) }}</b></header>
          <ul class="cs-list">
            <li v-for="i in c.subscriptions.items.slice(0, 6)" :key="i.id"><span>{{ i.name }}</span><small>{{ SRC[i.source] }}</small><b class="num">{{ m(i.monthly) }}</b></li>
            <li v-if="!c.subscriptions.items.length" class="muted">No prices yet.</li>
          </ul>
          <p v-if="c.subscriptions.unknown" class="us-note">{{ c.subscriptions.unknown }} paid service{{ c.subscriptions.unknown > 1 ? "s" : "" }} without a price are not counted.</p>
          <a class="btn" href="#usage">Open Usage</a>
        </section>

        <section class="card2 us-card" aria-label="Electricity">
          <header class="us-h"><span class="cs-ic"><Icon name="zap" :size="20" /></span><div class="us-t"><b>Electricity</b><small>{{ c.electricity.machine }}</small></div><b class="num cs-v">{{ m(c.electricity.monthly) }}</b></header>
          <ul class="cs-list">
            <li><span>Draw now</span><b class="num">{{ c.electricity.watts != null ? c.electricity.watts.toFixed(1) + " W" : "–" }}</b></li>
            <li><span>Average</span><b class="num">{{ c.electricity.avgWatts != null ? c.electricity.avgWatts.toFixed(1) + " W" : "–" }}</b></li>
            <li><span>Per month</span><b class="num">{{ c.electricity.kwhMonth.toFixed(1) }} kWh</b></li>
            <li><span>Price</span><b class="num">{{ m(c.electricity.price, 2) }} / kWh</b></li>
          </ul>
          <p class="us-note"><span class="pill" :class="c.electricity.source === 'measured' ? 'p-on' : 'p-part'">{{ c.electricity.source === "measured" ? "MEASURED" : "ESTIMATE" }}</span> {{ c.electricity.source === "measured" ? "From your power sensor." : "From CPU load between this machine's idle and full-load watts. Set costs.power.haEntity for a real reading." }}</p>
        </section>

        <section class="card2 us-card" aria-label="Fixed costs">
          <header class="us-h"><span class="cs-ic"><Icon name="coins" :size="20" /></span><div class="us-t"><b>Fixed costs</b><small>domains, VPS, hardware</small></div><b class="num cs-v">{{ m(c.fixed.monthly) }}</b></header>
          <ul class="cs-list">
            <li v-for="i in c.fixed.items" :key="i.id"><span>{{ i.name }}</span><b class="num">{{ m(i.monthly) }}</b><button type="button" class="us-ic" :aria-label="`Remove ${i.name}`" @click="del(i.id)"><Icon name="trash" :size="14" /></button></li>
            <li v-if="!c.fixed.items.length" class="muted">Nothing added.</li>
          </ul>
          <form class="cs-add" @submit.prevent="add">
            <input v-model="fn" maxlength="60" placeholder="Name (domain)" aria-label="Name" required />
            <input v-model="fm" type="number" min="0" step="0.01" inputmode="decimal" :placeholder="cur + ' / mo'" aria-label="Monthly cost" required />
            <button type="submit" class="btn primary" :disabled="saving">Add</button>
          </form>
        </section>
      </div>

      <section class="card2 cs-ai" aria-label="AI use at API prices">
        <div class="ch"><h3>AI use of this server</h3><span class="muted">what it would cost at API prices</span></div>
        <p class="us-note">Claude Code sessions here run on a subscription, so this is value, not spend, and it is not in the total above.</p>
        <template v-if="c.ai.available">
          <div class="cs-ai-n">
            <div><small>Today</small><b class="num">{{ m(c.ai.today) }}</b></div>
            <div><small>7 days</small><b class="num">{{ m(c.ai.week) }}</b></div>
            <div><small>30 days</small><b class="num">{{ m(c.ai.month) }}</b></div>
            <div><small>Tokens</small><b class="num">{{ compact(c.ai.tokens) }}</b></div>
          </div>
          <figure class="cs-bars">
            <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" aria-label="Daily AI use at API prices, last 30 days">
              <rect v-for="b in bars" :key="b.date" :x="b.x" :y="H - PAD - b.h" :width="b.w" :height="b.h" rx="1.5" class="cs-bar"><title>{{ b.date }}: {{ m(b.cost) }}</title></rect>
            </svg>
            <figcaption><span>{{ c.ai.days[0]?.date.slice(5) }}</span><span>{{ c.ai.days.at(-1)?.date.slice(5) }}</span></figcaption>
          </figure>
          <h4 class="cs-h4">Top consumers</h4>
          <ol class="cs-top">
            <li v-for="t in c.ai.top" :key="t.label">
              <div class="cs-top-r"><b>{{ t.label }}</b><span class="pill p-off">{{ KIND[t.kind] ?? t.kind }}</span><span class="num cs-top-v">{{ m(t.cost) }}</span></div>
              <div class="bar us-bar"><i :style="{ width: Math.max(2, t.share * 100) + '%', background: 'var(--ink)' }"></i></div>
              <small class="muted">{{ compact(t.tokens) }} tokens · {{ t.models.join(", ") }}</small>
            </li>
          </ol>
        </template>
        <p v-else class="hint">No Claude Code transcripts found on this device yet.</p>
        <small v-if="c.ai.scannedAt" class="us-meta">read {{ ago(c.ai.scannedAt) }} · prices in server/modules/modelPrices.json<template v-if="c.ai.unpriced"> · {{ compact(c.ai.unpriced) }} tokens had no price</template></small>
      </section>
      <p class="foot">Totals are estimates. Subscriptions use the price you set or the service's list price, electricity uses {{ m(c.electricity.price, 2) }} per kWh, and fixed costs are yours. Change the currency, electricity price or machine power in config/server-os.yaml under <code>costs</code>.</p>
    </template>
  </main>
</template>
