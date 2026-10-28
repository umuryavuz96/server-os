<script setup lang="ts">
// Permissions: what Server OS needs from the OS (macOS privacy grants, or on Linux groups / paths / systemd / firewall), why each
// is needed, whether it is granted, and a fix: open the Settings pane on a Mac, copy-able commands on Linux.
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { P, loadPerms, recheck, startFix, watchPage, type Perm } from "../permissions";
import PermSteps from "../components/PermSteps.vue";
import { guideFor } from "../permGuide";
import { api } from "../store";

onMounted(() => { void loadPerms().then(() => watchPage(true)); api<{ capabilities: string[] }>("/info").then((i) => (remote.value = i.capabilities.includes("screen"))).catch(() => {}); });
onUnmounted(() => watchPage(false));
// Fix: trigger macOS's own Allow popup where there is one, else open the Settings pane; then show the Mac's screen with the
// steps so the switch can be clicked from here. The status is re-checked every 2 s (permissions.ts); no manual re-check.
// Without the remote screen, Fix still does the first part (for someone at the Mac) and the steps open under the row.
const remote = ref(false);
const open = reactive<Record<string, boolean>>({});
const shown = (p: Perm) => !!guideFor(p) && (open[p.id] || P.fixing?.id === p.id);
function fixIt(p: Perm) { open[p.id] = true; void startFix(p, remote.value); }
const LABEL = { granted: "Granted", missing: "Missing", unknown: "Not checked", "not-needed": "Not needed" } as const;
const linux = computed(() => P.platform === "linux");
const copied = ref("");
async function copy(t: string) { try { await navigator.clipboard.writeText(t); copied.value = t; setTimeout(() => (copied.value = ""), 1500); } catch { /* no clipboard on plain http: the text is selectable */ } }
const fix = (p: Perm) => p.status === "missing" || p.status === "unknown";
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Permissions</h1>
      <button type="button" class="btn" :disabled="!!P.busy" @click="loadPerms">Refresh</button>
    </header>
    <p v-if="linux" class="hint">Linux has no privacy popups. What Server OS needs from the system is a handful of access rights: the Docker group, readable folders and disks, lingering so services survive logout, and a firewall opening if the panel is on the network. Each check only reads; to fix one, copy the command and run it on the server (nothing runs sudo for you).</p>
    <p v-else class="hint">macOS asks you to approve each program that reaches protected things. Approve once here and nothing pops up later when nobody is at the screen. A grant belongs to the program file: after a Bun upgrade its path changes and macOS may ask again.</p>

    <p v-if="!P.loaded" class="hint">Reading the permissions…</p>
    <ul v-else class="perm-list">
      <li v-for="p in P.list" :key="p.id" class="card2 perm" :class="'s-' + p.status">
        <div class="perm-h">
          <h2>{{ p.title }}</h2>
          <span class="pill" :class="'st-' + p.status">{{ LABEL[p.status] }}</span>
          <span class="tag" :class="{ ghost: !p.required }">{{ p.required ? "Required" : "Optional" }}</span>
        </div>
        <p class="perm-why">{{ p.why }}</p>
        <p class="perm-detail">{{ p.detail }}</p>
        <div v-if="p.needed || p.status !== 'not-needed'" class="perm-meta">
          <span>Used by: {{ p.features.join(", ") }}</span>
          <span v-for="x in p.processes" :key="x.path" class="perm-proc"><b>{{ x.role }}</b> <code>{{ x.path }}</code></span>
        </div>
        <div v-if="linux && p.fix.length && p.status !== 'granted'" class="perm-fix">
          <div v-for="c in p.fix" :key="c" class="perm-cmd"><code>{{ c }}</code><button v-if="!c.startsWith('#')" type="button" class="btn" @click="copy(c)">{{ copied === c ? "Copied" : "Copy" }}</button></div>
        </div>
        <div class="perm-act">
          <button v-if="!linux" type="button" class="btn" :class="{ primary: fix(p) }" @click="fixIt(p)">{{ remote ? "Fix on the Mac screen" : p.how === "dialog" ? "Ask on the Mac" : "Open settings" }}</button>
          <button v-if="!linux && guideFor(p)" type="button" class="btn ghost" :aria-expanded="shown(p)" :aria-controls="'how-' + p.id" @click="open[p.id] = !shown(p)">{{ shown(p) ? "Hide steps" : "How?" }}</button>
          <button type="button" class="btn" :disabled="!!P.busy" @click="recheck(p.id)">{{ P.busy === p.id ? "Checking…" : "Re-check" }}</button>
        </div>
        <PermSteps v-if="!linux && shown(p)" :id="'how-' + p.id" :perm="p" />
      </li>
    </ul>
    <p v-if="P.loaded && !P.list.length" class="hint">This system has no permissions to set.</p>
  </main>
</template>

<style scoped>
.perm-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.perm{gap:8px}
.perm-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.perm-h h2{margin:0 auto 0 0;font:700 16px var(--body);text-transform:none;letter-spacing:0}
.perm-why{margin:0;font-size:14px;line-height:1.45}
.perm-detail{margin:0;font-size:12.5px;color:var(--muted)}
.perm-meta{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted);min-width:0}
.perm-proc{overflow-wrap:anywhere}
.perm-proc code{font:11.5px var(--mono);color:var(--ink)}
.perm-fix{display:flex;flex-direction:column;gap:5px}
.perm-cmd{display:flex;gap:6px;align-items:center}
.perm-cmd code{flex:1;min-width:0;overflow-wrap:anywhere;font:11.5px var(--mono);background:var(--panel-2);padding:5px 7px;border-radius:6px}
.perm-act{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.st-granted{color:var(--on);background:var(--on-bg)}
.st-missing{color:var(--bad);background:var(--bad-bg)}
.st-unknown{color:var(--warn);background:var(--warn-bg)}
.st-not-needed{color:var(--off);background:var(--panel-2)}
.s-not-needed{opacity:.65}
.btn.ghost{background:transparent}
.s-granted{transition:border-color .4s,background .4s}
.s-missing{border-color:rgba(255,59,69,.4)}
</style>
