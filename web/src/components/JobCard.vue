<script setup lang="ts">
// A job's ID card as a visual summary: risk badge, what it does, then tiles for apps, disk, data, tools, APIs, secrets, model and reports.
import { computed } from "vue";
import Icon from "./Icon.vue";
import JobGlyph from "./JobGlyph.vue";
import { appList, type Job } from "../store";
import { parsePath, resolveGlyph, splitLabel } from "../jobIcons";
import type { IconName } from "../icons";

const props = defineProps<{ job: Job; statusClass: string; statusText: string }>();

const RISK: Record<string, { icon: IconName; label: string; cls: string; hint: string }> = {
  "read-only": { icon: "shield-check", label: "Read-only", cls: "jc-r-ok", hint: "Looks, never changes anything" },
  writes: { icon: "pencil", label: "Writes", cls: "jc-r-warn", hint: "Creates or changes files and data" },
  destructive: { icon: "triangle-alert", label: "Destructive", cls: "jc-r-bad", hint: "Deletes, overwrites or restarts things" },
};
const risk = computed(() => (props.job.risk ? RISK[props.job.risk] : null));
const hint = (l: string) => props.job.icons?.[l];
const entries = (list?: string[]) => (list ?? []).map((label) => ({ label, ...splitLabel(label), glyph: resolveGlyph(label, appList.value, hint(label)) }));
const apps = computed(() => entries(props.job.touches?.apps));
const tools = computed(() => entries(props.job.uses?.tools));
const apis = computed(() => entries(props.job.uses?.apis));
// Free text (model, reports): a logo when one matches, else the section's own icon.
const orIcon = (label: string, icon: IconName) => { const g = resolveGlyph(label, appList.value); return g.kind === "letter" ? ({ kind: "lucide", icon, key: icon } as const) : g; };
const modelG = computed(() => orIcon(props.job.uses?.model ?? "", "sparkles"));
const reportG = computed(() => orIcon(props.job.reports ?? "", "bell"));
const paths = computed(() => (props.job.touches?.paths ?? []).map(parsePath));
const EFFECT: Record<string, { icon: IconName; cls: string }> = { deleted: { icon: "trash", cls: "jc-e-bad" }, truncated: { icon: "scissors", cls: "jc-e-warn" }, written: { icon: "pencil", cls: "jc-e-info" } };
</script>

<template>
  <section class="jc" aria-label="ID card">
    <header class="jc-hero">
      <span v-if="risk" class="jc-risk" :class="risk.cls" :title="risk.hint"><Icon :name="risk.icon" :size="26" /><b>{{ risk.label }}</b></span>
      <div class="jc-hero-t">
        <h2>{{ job.name }}</h2>
        <div class="jc-meta"><span class="pill" :class="statusClass">{{ statusText }}</span><span class="jc-sched"><Icon name="clock" :size="14" />{{ job.when }}</span><span v-if="job.category" class="jc-cat">{{ job.category }}</span></div>
      </div>
    </header>
    <p v-if="job.about" class="jc-about">{{ job.about }}</p>
    <p v-else class="jc-warn">No description yet. Add an ID card for this job in jobs.json (about, touches, uses, risk).</p>
    <p v-if="job.about && job.gaps?.length" class="jc-warn">Card incomplete, missing: {{ job.gaps.join(", ") }}.</p>

    <div class="jc-grid">
      <section v-if="apps.length" class="jc-tile jc-wide">
        <h4><Icon name="boxes" :size="15" />Apps<i>{{ apps.length }}</i></h4>
        <ul class="jc-apps">
          <li v-for="a in apps" :key="a.label" :title="a.label"><JobGlyph :glyph="a.glyph" :label="a.name" :size="34" /><span><b>{{ a.name }}</b><small v-if="a.note">{{ a.note }}</small></span></li>
        </ul>
      </section>

      <section v-if="paths.length" class="jc-tile jc-wide">
        <h4><Icon name="hard-drive" :size="15" />Disk<i>{{ paths.length }}</i></h4>
        <ul class="jc-paths">
          <li v-for="p in paths" :key="p.path + p.effect" :title="p.path">
            <span class="jc-pi"><Icon :name="p.icon" :size="15" /></span>
            <code>{{ p.path }}</code>
            <span v-if="p.effect" class="jc-eff" :class="EFFECT[p.effect].cls"><Icon :name="EFFECT[p.effect].icon" :size="12" />{{ p.effect }}</span>
          </li>
        </ul>
      </section>

      <section v-if="job.touches?.data" class="jc-tile">
        <h4><Icon name="database" :size="15" />Data</h4>
        <p>{{ job.touches.data }}</p>
      </section>

      <section v-if="tools.length" class="jc-tile">
        <h4><Icon name="wrench" :size="15" />Tools<i>{{ tools.length }}</i></h4>
        <ul class="jc-chips"><li v-for="t in tools" :key="t.label" :title="t.label"><JobGlyph :glyph="t.glyph" :label="t.name" :size="18" fallback="terminal" />{{ t.name }}</li></ul>
      </section>

      <section v-if="apis.length" class="jc-tile">
        <h4><Icon name="globe" :size="15" />APIs<i>{{ apis.length }}</i></h4>
        <ul class="jc-chips"><li v-for="t in apis" :key="t.label" :title="t.label"><JobGlyph :glyph="t.glyph" :label="t.name" :size="18" fallback="plug" />{{ t.name }}</li></ul>
      </section>

      <section v-if="job.uses?.secrets?.length" class="jc-tile">
        <h4><Icon name="key-round" :size="15" />Secrets<i>{{ job.uses.secrets.length }}</i></h4>
        <ul class="jc-chips jc-keys"><li v-for="s in job.uses.secrets" :key="s"><Icon name="key-round" :size="13" /><code>{{ s }}</code></li></ul>
      </section>

      <section v-if="job.uses?.model" class="jc-tile">
        <h4><Icon name="sparkles" :size="15" />Model</h4>
        <p class="jc-model"><JobGlyph :glyph="modelG" :size="22" />{{ job.uses.model }}</p>
      </section>

      <section v-if="job.reports" class="jc-tile">
        <h4><Icon name="send" :size="15" />Reports</h4>
        <p class="jc-model"><JobGlyph :glyph="reportG" :size="22" />{{ job.reports }}</p>
      </section>

      <section v-if="job.project" class="jc-tile">
        <h4><Icon name="folder" :size="15" />Project</h4>
        <p><code>{{ job.project }}</code></p>
      </section>
    </div>
  </section>
</template>
