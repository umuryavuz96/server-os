<script setup lang="ts">
// Settings: Server OS's own version and updates — the update card, the channel (stable / beta) and what happens on
// its own (off / tell me / install at night). The server keeps these in <home>/data/update.json.
import { computed, onMounted, ref } from "vue";
import { S, api, toast, type UpdateStatus } from "../store";
import UpdateCard from "../components/UpdateCard.vue";

onMounted(async () => { try { S.update = await api<UpdateStatus>("/update"); } catch { /* the SSE slice fills it */ } });
const u = computed(() => S.update ?? null);
const MODE = { release: "Release install", git: "Git checkout (developer mode)", homebrew: "Homebrew", docker: "Docker", unmanaged: "Manual install" } as const;
const AUTO = [
  ["off", "Off", "Never check by itself. Use Check now."],
  ["notify", "Tell me", "Check once a day and show new versions here and on Overview."],
  ["nightly", "Install at night", "Check daily and install new versions at 03:30 server time. A version that failed once is not retried."],
] as const;
const saving = ref(false);
async function set(patch: Partial<UpdateStatus["settings"]>) {
  saving.value = true;
  try { S.update = await api<UpdateStatus>("/update/settings", { method: "PUT", body: patch }); toast("Saved"); } catch (e) { toast((e as Error).message); }
  saving.value = false;
}
const nightlyOff = computed(() => !!u.value && u.value.mode !== "release");
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
</script>

<template>
  <main class="page">
    <header class="ph"><h1>Settings</h1></header>
    <p v-if="!u" class="hint">Reading the update status…</p>
    <template v-else>
      <UpdateCard always />

      <section class="card2" aria-labelledby="upd-set">
        <div class="ch"><h3 id="upd-set">Updates</h3><span class="muted">{{ MODE[u.mode] }}</span></div>
        <div class="kv2"><span>Running version</span><b>{{ u.current }}</b></div>
        <div class="kv2"><span>Latest on this channel</span><b>{{ u.latest?.tag ?? "–" }}</b></div>
        <div class="kv2"><span>Service</span><b>{{ u.service ?? "not a service" }}</b></div>

        <fieldset class="set">
          <legend>Channel</legend>
          <div class="pills" role="radiogroup" aria-label="Update channel">
            <button v-for="c in (['stable', 'beta'] as const)" :key="c" type="button" role="radio" class="pill2" :aria-checked="u.settings.channel === c" :aria-selected="u.settings.channel === c" :disabled="saving" @click="set({ channel: c })">{{ c === "stable" ? "Stable" : "Beta" }}</button>
          </div>
          <p class="hint">{{ u.settings.channel === "beta" ? "Prereleases too (v1.2.0-beta.1). Newer, less tested." : "Only finished releases." }}</p>
        </fieldset>

        <fieldset class="set">
          <legend>Automatic updates</legend>
          <div class="opts" role="radiogroup" aria-label="Automatic updates">
            <button v-for="[id, label, about] in AUTO" :key="id" type="button" role="radio" class="seg" :aria-checked="u.settings.auto === id" :aria-pressed="u.settings.auto === id" :disabled="saving || (id === 'nightly' && nightlyOff)" @click="set({ auto: id })">
              <b>{{ label }}</b><span>{{ about }}</span>
            </button>
          </div>
          <p v-if="nightlyOff" class="hint">Installing at night needs a release install; this one is {{ MODE[u.mode].toLowerCase() }}.</p>
          <p v-else-if="u.nextAutoAt" class="hint">Next look at night: {{ fmt(u.nextAutoAt) }}.</p>
        </fieldset>
        <p class="hint foot">Every release is signed. The server checks the signature and checksum before it installs anything, keeps the previous version, and switches back by itself if the new one doesn't answer. Your settings, apps and data live outside the version folders.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.set{border:0;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.set legend{font:700 12px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:0;margin-bottom:8px}
.opts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media(max-width:720px){.opts{grid-template-columns:1fr}}
.opts .seg b{font-size:15px}
.opts .seg span{font-size:12.5px;line-height:1.35}
.opts .seg[aria-pressed="true"]{border-color:var(--ink);background:#18181b}
.opts .seg:disabled{opacity:.45;cursor:not-allowed}
.pill2:disabled{opacity:.6}
.foot{margin-top:14px;padding-top:12px;border-top:1px solid #1d1d21}
</style>
