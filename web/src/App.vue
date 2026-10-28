<script setup lang="ts">
// App shell: left navigation (grouped, like the Sweatpals reference) + page content. Hash routing.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { S, toastMsg, api } from "./store";
import SignIn from "./components/SignIn.vue";
import PairDevice from "./components/PairDevice.vue";

const props = defineProps<{ signedIn: boolean; authOn: boolean; owner: boolean; canClaim: boolean; ownerName: string | null }>();
const pairing = ref(false);
const reloadPage = () => location.reload();
async function signOut() {
  if (!window.confirm("Sign out this browser? You'll need a new code to sign in again.")) return;
  await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
}
import OverviewView from "./views/OverviewView.vue";
import AppsView from "./views/AppsView.vue";
import JobsView from "./views/JobsView.vue";
import AlertsView from "./views/AlertsView.vue";
import BotsView from "./views/BotsView.vue";
import HooksView from "./views/HooksView.vue";
import StorageView from "./views/StorageView.vue";
import DiscoverView from "./views/DiscoverView.vue";
import DashboardsView from "./views/DashboardsView.vue";
import LogsView from "./views/LogsView.vue";
import PortsView from "./views/PortsView.vue";
import VoiceView from "./views/VoiceView.vue";
import Icon from "./components/Icon.vue";
import type { IconName } from "./icons";
import PermissionsView from "./views/PermissionsView.vue";
import ScreenView from "./views/ScreenView.vue";
import SettingsView from "./views/SettingsView.vue";
import { loadPerms, missingRequired } from "./permissions";
import InstallTray from "./components/InstallTray.vue";
import RemoteScreen from "./components/RemoteScreen.vue";
import { sess } from "./screen/session";

const PAGES = ["overview", "dashboards", "apps", "discover", "jobs", "alerts", "logs", "bots", "voice", "webhooks", "storage", "ports", "permissions", "screen", "settings"] as const;
type Page = (typeof PAGES)[number];
// Old links keep working: #voices (the Voices page, merged into Voice 2026-10-28) opens Voice.
const ALIAS: Record<string, Page> = { voices: "voice" };
const page = ref<Page>("overview");
const navOpen = ref(false);
// Tile and card pages use the whole window width; list pages and forms keep a readable width (see Adaptive page widths in style.css).
const WIDE: Page[] = ["overview", "dashboards", "discover", "storage"];
const readHash = () => {
  const h = location.hash.slice(1).split("?")[0];
  if (h in ALIAS) { location.replace("#" + ALIAS[h]); return; }
  page.value = PAGES.includes(h as Page) ? (h as Page) : "overview"; navOpen.value = false;
};
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
// Optional integrations (bot manager, storage service, watched webhooks) only show when the server has them.
const caps = ref<Set<string> | null>(null);
const serverName = ref("home-server");
// Two characters for the logo tile: a short model-like word wins ("Server-M4-Mac-Mini" → M4), else initials ("home-server" → HS).
const initials = computed(() => {
  const words = serverName.value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.find((w) => w.length <= 3 && /\d/.test(w) && /[A-Za-z]/.test(w)) ?? words.slice(0, 2).map((w) => w[0]).join("")).toUpperCase().slice(0, 3) || "SD";
});
const shown = (id: string) => !caps.value || (id === "bots" ? caps.value.has("bots") : id === "voice" ? caps.value.has("voiceSession") || caps.value.has("houseVoice") : id === "storage" ? caps.value.has("storage") : id === "permissions" ? caps.value.has("permissions") : id === "screen" ? caps.value.has("screen") : id === "webhooks" ? (S.hooks?.length ?? 0) > 0 : true);
const screenName = ref("Mac screen");
const screenLive = computed(() => sess.phase === "connected");
onMounted(async () => { try { const i = await api<{ name: string; platform?: string; capabilities: string[] }>("/info"); caps.value = new Set(i.capabilities); screenName.value = i.platform === "darwin" ? "Mac screen" : "Server screen"; serverName.value = i.name; if (caps.value.has("permissions")) void loadPerms(); } catch { /* show everything */ } });
onMounted(() => { readHash(); addEventListener("hashchange", readHash); clock = setInterval(() => (now.value = Date.now()), 30_000); });
onUnmounted(() => { removeEventListener("hashchange", readHash); clearInterval(clock); });

const installing = computed(() => Object.values((S as unknown as { lifecycle?: Record<string, { state: string }> }).lifecycle ?? {}).filter((l) => ["installing", "setting-up", "removing"].includes(l.state)).length);
const portIssues = computed(() => (S as unknown as { ports?: { counts: { issues: number } } }).ports?.counts.issues ?? 0);
const failing = computed(() => (S.jobs ?? []).filter((j) => j.status === "fail").length);
const running = computed(() => Object.values(S.apps).filter((a) => a.state !== "off" && a.kind !== "lock").length);
const botsLive = computed(() => (S.botSessions ?? []).filter((b) => b.running).length);
const diskPct = computed(() => (S.system?.internal ? Math.round(100 - (S.system.internal.freeGB / S.system.internal.totalGB) * 100) : null));
const upDays = computed(() => (S.system?.boot ? Math.floor((now.value / 1000 - S.system.boot) / 86400) : null));
// Sidebar icons: Lucide, by name (web/src/icons.ts), one set with the rest of the panel since 2026-10-28.
const ICON: Record<string, IconName> = {
  overview: "layout-dashboard", apps: "blocks", dashboards: "layout-grid", discover: "compass", jobs: "clock", logs: "scroll-text", alerts: "bell",
  bots: "bot", voice: "audio-lines", webhooks: "webhook", ports: "network", permissions: "shield-check", screen: "monitor", storage: "database", settings: "sliders",
};
const updateBadge = computed(() => S.update?.state === "failed" ? "!" : S.update && !["idle", "checking"].includes(S.update.state) ? "…" : S.update?.updateAvailable ? "new" : "");
const NAV = [
  { title: "", items: [["overview", "Overview"], ["dashboards", "Dashboards"], ["apps", "Apps"], ["discover", "Discover"]] },
  { title: "Automation", items: [["jobs", "Jobs"], ["alerts", "Alerts"], ["logs", "Logs"], ["webhooks", "Webhooks"]] },
  { title: "Agents", items: [["voice", "Voice"], ["bots", "Bots"]] },
] as const;
</script>

<template>
  <SignIn v-if="!props.signedIn" :owner="props.owner" :can-claim="props.canClaim" @done="reloadPage" />
  <div v-else class="shell">
    <aside class="nav" :class="{ open: navOpen }" aria-label="Main navigation">
      <div class="nav-brand">
        <div class="logo" aria-hidden="true">{{ initials }}</div>
        <div><div class="nav-t">Server OS</div><div class="nav-s"><span class="live" :class="{ off: !S.connected }"></span>{{ S.connected ? "live" : "reconnecting" }}<template v-if="upDays != null"> · up {{ upDays }} d</template></div></div>
        <button type="button" class="nav-x" aria-label="Close menu" @click="navOpen = false"><Icon name="x" /></button>
      </div>
      <nav>
        <div v-for="g in NAV.filter((x) => x.items.some(([i]) => shown(i)))" :key="g.title" class="nav-g">
          <div v-if="g.title" class="nav-h">{{ g.title }}</div>
          <a v-for="[id, label] in g.items.filter(([i]) => shown(i))" :key="id" :href="'#' + id" class="nav-i" :aria-current="page === id ? 'page' : undefined">
            <Icon :name="ICON[id]" :size="17" />
            <span>{{ label }}</span>
            <span v-if="id === 'apps'" class="nav-c">{{ running }}</span>
            <span v-else-if="id === 'discover' && installing" class="nav-c busy" :title="`${installing} installing`">{{ installing }}</span>
            <span v-else-if="id === 'jobs' && failing" class="nav-c bad">{{ failing }}</span>
            <span v-else-if="id === 'bots'" class="nav-c">{{ botsLive }}</span>
            <span v-else-if="id === 'alerts' && S.alerts24?.newCause" class="nav-c bad">{{ S.alerts24.newCause }}</span>
          </a>
        </div>
        <div class="nav-g">
          <div class="nav-h">System</div>
          <a href="#ports" class="nav-i" :aria-current="page === 'ports' ? 'page' : undefined">
            <Icon :name="ICON.ports" :size="17" />
            <span>Ports</span><span v-if="portIssues" class="nav-c bad">{{ portIssues }}</span>
          </a>
          <a v-if="shown('permissions')" href="#permissions" class="nav-i" :aria-current="page === 'permissions' ? 'page' : undefined">
            <Icon :name="ICON.permissions" :size="17" />
            <span>Permissions</span><span v-if="missingRequired.length" class="nav-c bad">{{ missingRequired.length }}</span>
          </a>
          <a v-if="shown('screen')" href="#screen" class="nav-i" :aria-current="page === 'screen' ? 'page' : undefined">
            <Icon :name="ICON.screen" :size="17" />
            <span>{{ screenName }}</span><span v-if="screenLive" class="nav-c on" title="Screen session is live">live</span>
          </a>
          <a href="#settings" class="nav-i" :aria-current="page === 'settings' ? 'page' : undefined">
            <Icon :name="ICON.settings" :size="17" />
            <span>Settings</span><span v-if="updateBadge" class="nav-c" :class="updateBadge === '!' ? 'bad' : 'on'" :title="updateBadge === 'new' ? `Server OS ${S.update?.latest?.tag} is available` : undefined">{{ updateBadge }}</span>
          </a>
        </div>
        <div v-if="shown('storage')" class="nav-g">
          <a href="#storage" class="nav-i" :aria-current="page === 'storage' ? 'page' : undefined">
            <Icon :name="ICON.storage" :size="17" />
            <span>Storage</span><span v-if="diskPct != null" class="nav-c" :class="{ bad: diskPct >= 90 }">{{ diskPct }}%</span>
          </a>
        </div>
      </nav>
      <div class="nav-f">
        <span>{{ serverName }}<template v-if="props.ownerName"> · {{ props.ownerName }}</template></span>
        <button v-if="props.authOn" type="button" class="nav-link" @click="pairing = true">Connect a device</button>
        <button v-if="props.authOn" type="button" class="nav-link" @click="signOut">Sign out</button>
      </div>
    </aside>
    <div v-if="navOpen" class="nav-scrim" @click="navOpen = false"></div>

    <div class="content" :class="{ wide: WIDE.includes(page) }" :data-page="page">
      <div class="topbar">
        <button type="button" class="btn nav-btn" aria-label="Open menu" @click="navOpen = true"><Icon name="menu" /></button>
        <div class="logo sm" aria-hidden="true">{{ initials }}</div>
      </div>
      <div v-if="!S.connected" class="err">Reconnecting to the server…</div>
      <Transition name="view" mode="out-in">
        <OverviewView v-if="page === 'overview'" />
        <AppsView v-else-if="page === 'apps'" />
        <DiscoverView v-else-if="page === 'discover'" />
        <DashboardsView v-else-if="page === 'dashboards'" />
        <JobsView v-else-if="page === 'jobs'" />
        <AlertsView v-else-if="page === 'alerts'" />
        <LogsView v-else-if="page === 'logs'" />
        <BotsView v-else-if="page === 'bots'" />
        <VoiceView v-else-if="page === 'voice'" :session="!caps || caps.has('voiceSession')" />
        <HooksView v-else-if="page === 'webhooks'" />
        <StorageView v-else-if="page === 'storage'" />
        <PortsView v-else-if="page === 'ports'" />
        <PermissionsView v-else-if="page === 'permissions'" />
        <ScreenView v-else-if="page === 'screen'" />
        <SettingsView v-else-if="page === 'settings'" />
      </Transition>
    </div>
  </div>
  <Transition name="toast"><div v-if="toastMsg.text" class="toast" role="status">{{ toastMsg.text }}</div></Transition>
  <PairDevice v-if="pairing" @close="pairing = false" />
  <InstallTray />
  <RemoteScreen />
</template>
