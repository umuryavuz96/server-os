<script setup lang="ts">
// Logins in the app drawer: where each username + password lives (names only), Reveal for 30 s, Copy, and
// "Link a login" for apps nothing matched. Values come from the server only on Reveal/Copy, which it audits.
import { ref, computed, watch, onUnmounted } from "vue";
import { api, toast } from "../store";

interface Login { id: string; label: string; source: string; kind: "login" | "database"; from: string; user: string | null; hasUser: boolean }
const props = defineProps<{ app: string }>();
const list = ref<Login[] | null>(null), canReveal = ref(false), authOff = ref(false);
const shown = ref<Record<string, { user: string | null; password: string | null }>>({});
const busy = ref("");
const enc = encodeURIComponent;
let hide: ReturnType<typeof setTimeout> | undefined;

async function load() {
  list.value = null; shown.value = {};
  try { const r = await api<{ logins: Login[]; canReveal: boolean; authOff: boolean }>(`/apps/${enc(props.app)}/logins`); list.value = r.logins; canReveal.value = r.canReveal; authOff.value = r.authOff; }
  catch { list.value = []; }
}
watch(() => props.app, load, { immediate: true });
onUnmounted(() => { clearTimeout(hide); shown.value = {}; });

async function reveal(l: Login) {
  busy.value = l.id;
  try { return await api<{ user: string | null; password: string | null }>(`/apps/${enc(props.app)}/logins/reveal`, { body: { id: l.id } }); }
  catch (e) { toast((e as Error).message); return null; }
  finally { busy.value = ""; }
}
async function toggle(l: Login) {
  if (shown.value[l.id]) { const { [l.id]: _, ...rest } = shown.value; shown.value = rest; return; }
  const v = await reveal(l); if (!v) return;
  shown.value = { ...shown.value, [l.id]: v };
  clearTimeout(hide); hide = setTimeout(() => (shown.value = {}), 30_000); // hide again after 30 s
}
async function copy(l: Login, what: "user" | "password") {
  const v = shown.value[l.id] ?? (await reveal(l)); if (!v) return;
  const text = what === "user" ? v.user ?? l.user : v.password;
  if (!text) { toast("Nothing to copy"); return; }
  try { await navigator.clipboard.writeText(text); toast(what === "user" ? "Username copied" : "Password copied"); } catch { toast("Copy blocked by the browser"); }
}
const logins = computed(() => (list.value ?? []).filter((l) => l.kind === "login"));
const dbs = computed(() => (list.value ?? []).filter((l) => l.kind === "database"));

// ---- link a login ----
const linking = ref(false), keys = ref<string[]>([]), pw = ref(""), userEnv = ref(""), user = ref("");
async function openLink() { linking.value = true; try { keys.value = await api<string[]>("/logins/env-keys"); } catch (e) { toast((e as Error).message); } }
const pwKeys = computed(() => keys.value.filter((k) => /(PASSWORD|PASSWD|PASS|PW)$/.test(k)));
const userKeys = computed(() => keys.value.filter((k) => !/(PASSWORD|PASSWD|PASS|PW)$/.test(k)));
async function saveLink(unlink = false) {
  try {
    await api(`/apps/${enc(props.app)}/logins/link`, { body: unlink ? { unlink: true } : { passwordEnv: pw.value, userEnv: userEnv.value || undefined, user: user.value.trim() || undefined } });
    toast(unlink ? "Unlinked" : "Linked"); linking.value = false; pw.value = userEnv.value = user.value = ""; load();
  } catch (e) { toast((e as Error).message); }
}
</script>

<template>
  <div class="dbox lg">
    <div class="lg-h"><b>Logins</b><button v-if="!linking" type="button" class="btn sm" @click="openLink">Link a login</button></div>
    <p v-if="list === null" class="hint">Looking…</p>
    <p v-else-if="!list.length && !linking" class="hint">Nothing found for this app. Link the ~/.env variables that hold its login.</p>
    <p v-if="authOff && list?.length" class="hint">Turn on sign-in to show passwords here.</p>
    <template v-for="group in [{ name: '', items: logins }, { name: 'Databases', items: dbs }]" :key="group.name">
      <div v-if="group.items.length && group.name" class="lg-g">{{ group.name }}</div>
      <div v-for="l in group.items" :key="l.id" class="lg-r">
        <div class="lg-t"><b>{{ l.label }}</b><small>{{ l.from }}</small></div>
        <div v-if="l.hasUser || l.user" class="lg-v">
          <span>User</span><code>{{ shown[l.id]?.user ?? l.user ?? "••••••" }}</code>
          <button type="button" class="btn sm ghost" :disabled="!canReveal" :aria-label="`Copy the ${l.label} username`" @click="copy(l, 'user')">Copy</button>
        </div>
        <div class="lg-v">
          <span>Password</span><code>{{ shown[l.id]?.password ?? "••••••••••" }}</code>
          <button type="button" class="btn sm ghost" :disabled="!canReveal || busy === l.id" :aria-pressed="!!shown[l.id]" @click="toggle(l)">{{ shown[l.id] ? "Hide" : "Reveal" }}</button>
          <button type="button" class="btn sm ghost" :disabled="!canReveal || busy === l.id" :aria-label="`Copy the ${l.label} password`" @click="copy(l, 'password')">Copy</button>
        </div>
        <button v-if="l.source === 'linked'" type="button" class="btn sm ghost lg-un" @click="saveLink(true)">Unlink</button>
      </div>
    </template>
    <form v-if="linking" class="lg-f" @submit.prevent="saveLink()">
      <label>Password variable<select v-model="pw" required><option value="">Pick one from ~/.env…</option><option v-for="k in pwKeys" :key="k">{{ k }}</option></select></label>
      <label>Username variable <small>(optional)</small><select v-model="userEnv"><option value="">—</option><option v-for="k in userKeys" :key="k">{{ k }}</option></select></label>
      <label>…or type the username<input v-model="user" autocomplete="off" placeholder="admin" /></label>
      <div class="lg-fa"><button type="button" class="btn sm" @click="linking = false">Cancel</button><button type="submit" class="btn sm primary" :disabled="!pw">Link</button></div>
    </form>
    <p class="hint">Shown for 30 s. Every reveal and copy is written to the audit log.</p>
  </div>
</template>
