<script setup lang="ts">
// Usage: every paid or metered service found on this device, one card each (plan, usage bars with reset, monthly cost, status, billing link).
// Discovery runs on the server (server/modules/usage.ts); the owner's own price / plan / renewal day / hide sit on top and always win.
import { ref, computed } from "vue";
import { S, ago, api, toast, type UsageService } from "../store";
import Icon from "../components/Icon.vue";
import JobGlyph from "../components/JobGlyph.vue";
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { money, leftLabel } from "../money";
import type { IconName } from "../icons";

type Seg = "all" | "near" | "paid" | "free" | "hidden";
const seg = ref<Seg>("all"), busy = ref(false), editId = ref<string | null>(null), saving = ref(false);
const u = computed(() => S.usage ?? null), cur = computed(() => u.value?.currency ?? "USD");
const all = computed(() => u.value?.services ?? []);
const visible = computed(() => all.value.filter((s) => !s.hidden));
const counts = computed(() => ({ all: visible.value.length, near: visible.value.filter((s) => s.status === "near" || s.status === "error").length, paid: visible.value.filter((s) => s.kind === "paid").length,
  free: visible.value.filter((s) => s.kind !== "paid").length, hidden: all.value.length - visible.value.length }));
const SEGS = computed(() => [["all", "All", counts.value.all], ["near", "Needs a look", counts.value.near], ["paid", "Paid", counts.value.paid], ["free", "Free & local", counts.value.free], ["hidden", "Hidden", counts.value.hidden]] as [Seg, string, number][]);
const rows = computed(() => all.value.filter((s) => seg.value === "hidden" ? s.hidden : !s.hidden && (seg.value === "all" || (seg.value === "near" ? s.status === "near" || s.status === "error" : seg.value === "paid" ? s.kind === "paid" : s.kind !== "paid"))));
const t = computed(() => u.value?.totals);

const ST: Record<string, [string, string]> = { ok: ["p-on", "OK"], near: ["p-part", "NEAR LIMIT"], error: ["p-bad", "ERROR"], unknown: ["p-off", "NO DATA"] };
const SRC: Record<string, string> = { manual: "set by you", api: "from the service", estimate: "list price, estimate", free: "free" };
const KIND_ICON: Record<string, IconName> = { paid: "wallet", free: "circle-check", local: "cpu" };
const barCls = (p: number | null) => ((p ?? 0) >= 90 ? "b" : (p ?? 0) >= 80 ? "w" : "");
const num = (n: number) => n.toLocaleString("en", { maximumFractionDigits: 1 });
const meterText = (m: UsageService["meters"][number]) => (m.unit === "%" ? `${num(m.used)}%` : `${num(m.used)}${m.limit ? " / " + num(m.limit) : ""} ${m.unit}`);

async function refresh() {
  busy.value = true;
  try { await api("/usage/refresh", { method: "POST", body: {} }); toast("Usage checked"); } catch (e) { toast((e as Error).message); }
  busy.value = false;
}

// Manual overrides drawer
const f = ref({ monthly: "" as string | number, plan: "", renewalDay: "" as string | number, hidden: false });
const editing = computed(() => all.value.find((s) => s.id === editId.value) ?? null);
function open(s: UsageService) {
  f.value = { monthly: s.costSource === "manual" ? s.monthly ?? "" : "", plan: s.planManual ? s.plan ?? "" : "", renewalDay: s.renewalDay ?? "", hidden: s.hidden };
  editId.value = s.id;
}
async function save(reset = false) {
  if (!editing.value) return;
  saving.value = true;
  const b = reset ? {} : { monthly: f.value.monthly === "" ? undefined : f.value.monthly, plan: f.value.plan || undefined, renewalDay: f.value.renewalDay === "" ? undefined : f.value.renewalDay, hidden: f.value.hidden || undefined };
  try { await api(`/usage/overrides/${editing.value.id}`, { method: "PUT", body: b }); toast(reset ? "Back to automatic" : "Saved"); editId.value = null; } catch (e) { toast((e as Error).message); }
  saving.value = false;
}
async function hide(s: UsageService, hidden: boolean) {
  try { await api(`/usage/overrides/${s.id}`, { method: "PUT", body: { monthly: s.costSource === "manual" ? s.monthly : undefined, plan: s.planManual ? s.plan : undefined, renewalDay: s.renewalDay ?? undefined, hidden: hidden || undefined } }); toast(hidden ? `${s.name} hidden` : `${s.name} shown`); } catch (e) { toast((e as Error).message); }
}
</script>

<template>
  <main class="page us-page">
    <header class="ph">
      <h1>Usage</h1>
      <span class="muted us-sub">Paid and metered services found on this device</span>
      <a class="btn us-costs-link" href="#costs"><Icon name="coins" :size="15" />Costs</a>
      <button type="button" class="btn" :disabled="busy || u?.scanning" aria-label="Check all services now" @click="refresh"><Icon name="refresh-cw" :size="15" :class="{ 'us-spin': busy || u?.scanning }" />{{ u?.checkedAt ? ago(u.checkedAt) : "Check now" }}</button>
    </header>

    <section v-if="u && t" class="card2 us-hero" aria-label="Monthly total">
      <div class="us-hero-n">
        <small>Paid services</small>
        <div class="us-big"><span aria-hidden="true">≈ </span><AnimatedNumber :value="t.monthly" :fmt="(n: number) => money(n, cur)" /><em> / month</em></div>
        <p class="us-hero-s">
          <template v-if="t.actual"><b>{{ money(t.actual, cur) }}</b> from prices you set or the service reported</template>
          <template v-if="t.actual && t.estimated"> · </template>
          <template v-if="t.estimated"><b>{{ money(t.estimated, cur) }}</b> estimated from list prices</template>
          <template v-if="!t.actual && !t.estimated">No prices yet</template>
        </p>
      </div>
      <div v-if="t.unknown" class="us-hero-w"><Icon name="triangle-alert" :size="16" /><span><b>{{ t.unknown }}</b> paid service{{ t.unknown > 1 ? "s have" : " has" }} no price. Tap one and set what you pay.</span></div>
    </section>

    <div class="us-segs" role="group" aria-label="Filter">
      <button v-for="[k, label, n] in SEGS" :key="k" type="button" class="chip" :aria-pressed="seg === k" :disabled="k === 'hidden' && !n" @click="seg = k">{{ label }} <b class="num">{{ n }}</b></button>
    </div>

    <p v-if="!u || (u.scanning && !all.length)" class="hint us-empty"><Icon name="loader" :size="16" class="us-spin" /> Looking for services on this device…</p>
    <p v-else-if="!rows.length" class="hint us-empty">{{ all.length ? "Nothing in this filter." : "No paid or metered services found. Add API keys to your env file or sign in to a CLI and they appear here by themselves." }}</p>

    <TransitionGroup tag="div" name="tl" class="us-grid">
      <article v-for="s in rows" :key="s.id" class="card2 us-card" :data-st="s.status" :class="{ 'us-dim': s.hidden }">
        <header class="us-h">
          <JobGlyph :label="s.name" :hint="s.icon" :fallback="(s.fallback as IconName)" :size="40" />
          <div class="us-t"><b>{{ s.name }}</b><small>{{ s.plan ?? s.group }}<template v-if="s.plan"> · {{ s.group }}</template></small></div>
          <span class="pill" :class="ST[s.status][0]">{{ ST[s.status][1] }}</span>
        </header>

        <div v-for="m in s.meters" :key="m.label" class="us-m">
          <div class="us-mr"><span>{{ m.label }}</span><b class="num">{{ meterText(m) }}</b></div>
          <div class="bar us-bar" role="img" :aria-label="`${m.label} ${m.pct ?? 0} percent used`"><i :class="barCls(m.pct)" :style="{ width: (m.pct ?? 0) + '%' }"></i></div>
          <small v-if="m.resetsAt" class="muted">resets in <b class="num">{{ leftLabel(m.resetsAt) }}</b></small>
        </div>
        <div v-if="s.spend" class="us-mr us-spend"><span>{{ s.spend.label }}</span><b class="num">{{ money(s.spend.amount, cur) }}</b></div>

        <p v-if="s.error" class="us-err"><Icon name="triangle-alert" :size="14" />{{ s.error }}</p>
        <p v-else-if="s.note" class="us-note">{{ s.note }}</p>

        <footer class="us-f">
          <button type="button" class="us-cost" :class="{ 'us-set': s.monthly == null }" :aria-label="`Edit price of ${s.name}`" @click="open(s)">
            <template v-if="s.monthly != null"><b class="num">{{ s.kind !== 'paid' && !s.monthly ? "Free" : money(s.monthly, cur) }}</b><small v-if="s.monthly || s.kind === 'paid'">/ month · {{ SRC[s.costSource ?? 'estimate'] }}</small><small v-else>{{ s.kind === "local" ? "runs on this device" : "no charge" }}</small></template>
            <template v-else><Icon name="pencil" :size="14" />Set price</template>
          </button>
          <span class="us-acts">
            <Icon :name="KIND_ICON[s.kind]" :size="14" class="us-kind" :title="s.kind" />
            <button type="button" class="us-ic" :aria-label="s.hidden ? `Show ${s.name}` : `Hide ${s.name}`" :title="s.hidden ? 'Show' : 'Hide'" @click="hide(s, !s.hidden)"><Icon :name="s.hidden ? 'eye' : 'eye-off'" :size="15" /></button>
            <a class="us-ic" :href="s.billing" target="_blank" rel="noopener noreferrer" :aria-label="`${s.name} billing page`" title="Billing page"><Icon name="external-link" :size="15" /></a>
          </span>
        </footer>
        <small class="us-meta">
          <template v-if="s.renewsAt">renews in {{ leftLabel(s.renewsAt) }} · </template>{{ s.via.join(" · ") }}<template v-if="s.checkedAt"> · checked {{ ago(s.checkedAt) }}</template>
        </small>
      </article>
    </TransitionGroup>

    <p class="foot">Found by looking at variable names in the env file, signed-in command line tools, installed apps and profiles. Secret values are only used inside the server to ask a service for its own usage and are never shown or logged. Prices you set always win; list prices are estimates.</p>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="editing" class="dr-wrap">
          <div class="dr-bg" @click="editId = null"></div>
          <aside class="dr us-dr" role="dialog" aria-modal="true" :aria-label="`Edit ${editing.name}`">
            <div class="dr-h"><span class="dr-title">{{ editing.name }}</span><button type="button" class="btn" aria-label="Close" @click="editId = null"><Icon name="x" :size="15" /></button></div>
            <form class="dr-b" @submit.prevent="save()">
              <p class="hint">Your numbers win over anything found automatically. Leave a field empty to keep the automatic value.</p>
              <label class="fld">What you pay per month ({{ cur }})<input v-model="f.monthly" type="number" min="0" step="0.01" inputmode="decimal" :placeholder="editing.monthly != null && editing.costSource !== 'manual' ? String(editing.monthly) + ' (automatic)' : 'e.g. 22'" /></label>
              <label class="fld">Plan name<input v-model="f.plan" maxlength="60" :placeholder="editing.plan && !editing.planManual ? editing.plan + ' (automatic)' : 'e.g. Creator'" /></label>
              <label class="fld">Renews on day of month<input v-model="f.renewalDay" type="number" min="1" max="31" inputmode="numeric" placeholder="1 to 31" /></label>
              <label class="us-chk"><input v-model="f.hidden" type="checkbox" /> Hide this service and leave it out of the total</label>
              <div class="us-dr-a">
                <button type="submit" class="btn primary" :disabled="saving">Save</button>
                <button type="button" class="btn" :disabled="saving" @click="save(true)">Back to automatic</button>
              </div>
            </form>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>
