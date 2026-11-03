<script setup lang="ts">
// App shell: left navigation (grouped, like the Sweatpals reference) + page content. Hash routing.
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from "vue";
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
import RamView from "./views/RamView.vue";
import JobsView from "./views/JobsView.vue";
import UsageView from "./views/UsageView.vue";
import CostsView from "./views/CostsView.vue";
import AlertsView from "./views/AlertsView.vue";
import BotsView from "./views/BotsView.vue";
import AgmsgView from "./views/AgmsgView.vue";
import HooksView from "./views/HooksView.vue";
import StorageView from "./views/StorageView.vue";
import DiscoverView from "./views/DiscoverView.vue";
import DashboardsView from "./views/DashboardsView.vue";
// three.js is big: the House page loads in its own chunk, when opened.
const HouseView = defineAsyncComponent(() => import("./views/HouseView.vue"));
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
import DesktopChrome, { type DockItem } from "./desktop/DesktopChrome.vue";
import { look } from "./desktop/prefs";
import { onEnter as deskEnter, onLeave as deskLeave } from "./desktop/viewTransition";

const PAGES = ["overview", "dashboards", "house", "apps", "ram", "discover", "usage", "costs", "jobs", "alerts", "logs", "bots", "agmsg", "voice", "webhooks", "storage", "ports", "permissions", "screen", "settings"] as const;
type Page = (typeof PAGES)[number];
// Old links keep working: #voices (the Voices page, merged into Voice 2026-10-28) opens Voice.
const ALIAS: Record<string, Page> = { voices: "voice", "voice-chat": "voice" };
const page = ref<Page>("overview");
const navOpen = ref(false);
// Tile and card pages use the whole window width; list pages and forms keep a readable width (see Adaptive page widths in style.css).
const WIDE: Page[] = ["overview", "ram", "dashboards", "house", "discover", "storage", "usage", "costs", "agmsg"];
// Glass desktop: list pages and full-height pages fill the window and scroll only their list (or chat, or 3D stage);
// the others sit in the page frame and scroll there only when they are taller than the window (style.css, layout).
const FIT: Page[] = ["agmsg", "apps", "jobs", "logs", "permissions", "bots", "voice", "house"];
// Glass desktop: the page frame switches to the next page's layout only once the old page has faded out, so the
// leaving page keeps its own width and height (it used to stretch to the next page's layout mid-fade).
const framePage = ref<Page>("overview");
const frame = computed<Page>(() => (desk.value ? framePage.value : page.value));
const deskHooks = { beforeEnter: () => { framePage.value = page.value; }, enter: deskEnter, leave: deskLeave };
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
const shown = (id: string) => !caps.value || (id === "bots" ? caps.value.has("bots") : id === "agmsg" ? caps.value.has("agmsg") : id === "voice" ? caps.value.has("voiceSession") || caps.value.has("houseVoice") : id === "house" ? caps.value.has("house") : id === "storage" ? caps.value.has("storage") : id === "permissions" ? caps.value.has("permissions") : id === "screen" ? caps.value.has("screen") : id === "webhooks" ? (S.hooks?.length ?? 0) > 0 : true);
const screenName = ref("Mac screen");
const screenLive = computed(() => sess.phase === "connected");
onMounted(async () => { try { const i = await api<{ name: string; platform?: string; capabilities: string[] }>("/info"); caps.value = new Set(i.capabilities); if (!caps.value.has("house") && page.value === "house") location.replace("#overview"); screenName.value = i.platform === "darwin" ? "Mac screen" : "Server screen"; serverName.value = i.name; if (caps.value.has("permissions")) void loadPerms(); } catch { /* show everything */ } });
onMounted(() => { readHash(); addEventListener("hashchange", readHash); clock = setInterval(() => (now.value = Date.now()), 30_000); });
onUnmounted(() => { removeEventListener("hashchange", readHash); clearInterval(clock); });

const installing = computed(() => Object.values((S as unknown as { lifecycle?: Record<string, { state: string }> }).lifecycle ?? {}).filter((l) => ["installing", "setting-up", "removing"].includes(l.state)).length);
const portIssues = computed(() => (S as unknown as { ports?: { counts: { issues: number } } }).ports?.counts.issues ?? 0);
const usageNear = computed(() => (S.usage?.services ?? []).filter((x) => !x.hidden && (x.status === 'near' || x.status === 'error')).length);
const failing = computed(() => (S.jobs ?? []).filter((j) => j.status === "fail").length);
const running = computed(() => Object.values(S.apps).filter((a) => a.state !== "off" && a.kind !== "lock").length);
const botsLive = computed(() => (S.botSessions ?? []).filter((b) => b.running).length);
const diskPct = computed(() => (S.system?.internal ? Math.round(100 - (S.system.internal.freeGB / S.system.internal.totalGB) * 100) : null));
const upDays = computed(() => (S.system?.boot ? Math.floor((now.value / 1000 - S.system.boot) / 86400) : null));
// Sidebar icons: Lucide, by name (web/src/icons.ts), one set with the rest of the panel since 2026-10-28.
const ICON: Record<string, IconName> = {
  overview: "layout-dashboard", apps: "blocks", ram: "memory-stick", dashboards: "layout-grid", house: "house", discover: "compass", usage: "gauge", costs: "coins", jobs: "clock", logs: "scroll-text", alerts: "bell",
  bots: "bot", agmsg: "waypoints", voice: "audio-lines", webhooks: "webhook", ports: "network", permissions: "shield-check", screen: "monitor", storage: "database", settings: "sliders",
};
const updateBadge = computed(() => S.update?.state === "failed" ? "!" : S.update && !["idle", "checking"].includes(S.update.state) ? "…" : S.update?.updateAvailable ? "new" : "");
// Glass desktop (opt-in, Settings → Appearance): the dock holds the everyday pages, the launcher every page.
const desk = computed(() => look.layout === "desktop");
watch(desk, () => { framePage.value = page.value; }); // switching to the desktop mid-session: the frame takes the open page
const LABEL: Record<Page, string> = { overview: "Overview", dashboards: "Dashboards", house: "House", apps: "Apps", ram: "Ram", discover: "Discover", usage: "Usage", costs: "Costs", jobs: "Jobs", alerts: "Alerts", logs: "Logs", bots: "Bots", agmsg: "Agent network", voice: "Voice", webhooks: "Webhooks", storage: "Storage", ports: "Ports", permissions: "Permissions", screen: "Mac screen", settings: "Settings" };
const DOCK: Page[] = ["overview", "dashboards", "house", "apps", "ram", "discover", "jobs", "alerts", "logs", "bots", "agmsg", "voice", "webhooks", "storage", "settings"];
const deskItem = (id: Page): DockItem => {
  const badge = id === "jobs" && failing.value ? { badge: failing.value, bad: true } : id === "alerts" && S.alerts24?.newCause ? { badge: S.alerts24.newCause, bad: true }
    : id === "discover" && installing.value ? { badge: installing.value } : id === "usage" && usageNear.value ? { badge: usageNear.value, bad: true }
    : id === "ports" && portIssues.value ? { badge: portIssues.value, bad: true } : id === "permissions" && missingRequired.value.length ? { badge: missingRequired.value.length, bad: true }
    : id === "settings" && updateBadge.value ? { badge: updateBadge.value === "new" ? "•" : updateBadge.value, bad: updateBadge.value === "!" } : {};
  return { id, label: id === "screen" ? screenName.value : LABEL[id], icon: DESK_ICON[id] ?? ICON[id], ...badge };
};
// In the slim dock Overview, Dashboards and Apps were three look-alike grids: give two of them their own shape there
// (a pulse line for the live overview, stacked boxes for the apps). The classic sidebar keeps its icons.
const DESK_ICON: Partial<Record<Page, IconName>> = { overview: "activity", apps: "boxes" };
const dockItems = computed(() => DOCK.filter((id) => shown(id)).map(deskItem));
const allItems = computed(() => PAGES.filter((id) => shown(id)).map(deskItem));
const NAV = [
  { title: "", items: [["overview", "Overview"], ["dashboards", "Dashboards"], ["house", "House"], ["apps", "Apps"], ["ram", "Ram"], ["discover", "Discover"]] },
  { title: "Spend", items: [["usage", "Usage"], ["costs", "Costs"]] },
  { title: "Automation", items: [["jobs", "Jobs"], ["alerts", "Alerts"], ["logs", "Logs"], ["webhooks", "Webhooks"]] },
  { title: "Agents", items: [["voice", "Voice"], ["bots", "Bots"], ["agmsg", "Agent network"]] },
] as const;
</script>

<template>
  <SignIn v-if="!props.signedIn" :owner="props.owner" :can-claim="props.canClaim" @done="reloadPage" />
  <div v-else class="shell" :class="{ desk }">
    <DesktopChrome v-if="desk" :page="page" :dock="dockItems" :all="allItems" :server-name="serverName" :initials="initials" :connected="S.connected"
      :alerts="S.alerts24?.newCause ?? 0" :failing="failing" :bots-live="botsLive" :now="now" />
    <aside v-if="!desk" class="nav" :class="{ open: navOpen }" aria-label="Main navigation">
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
            <span v-else-if="id === 'usage' && usageNear" class="nav-c bad" title="Services near a limit or failing">{{ usageNear }}</span>
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
        <button type="button" class="nav-link" @click="look.layout = 'desktop'">Glass desktop</button>
      </div>
    </aside>
    <div v-if="navOpen && !desk" class="nav-scrim" @click="navOpen = false"></div>

    <div class="content" :class="{ wide: WIDE.includes(frame), fit: desk && FIT.includes(frame) }" :data-page="frame">
      <div class="topbar">
        <button type="button" class="btn nav-btn" aria-label="Open menu" @click="navOpen = true"><Icon name="menu" /></button>
        <div class="logo sm" aria-hidden="true">{{ initials }}</div>
      </div>
      <div v-if="!S.connected" class="err">Reconnecting to the server…</div>
      <!-- desktop: panels dissolve, the room shows for a beat, the new panels blur in (desktop/viewTransition.ts) -->
      <Transition name="view" mode="out-in" :css="!desk" :appear="desk" v-on="desk ? deskHooks : {}">
        <OverviewView v-if="page === 'overview'" :owner-name="props.ownerName" />
        <AppsView v-else-if="page === 'apps'" />
        <RamView v-else-if="page === 'ram'" />
        <DiscoverView v-else-if="page === 'discover'" />
        <DashboardsView v-else-if="page === 'dashboards'" />
        <HouseView v-else-if="page === 'house'" />
        <JobsView v-else-if="page === 'jobs'" />
        <UsageView v-else-if="page === 'usage'" />
        <CostsView v-else-if="page === 'costs'" />
        <AlertsView v-else-if="page === 'alerts'" />
        <LogsView v-else-if="page === 'logs'" />
        <BotsView v-else-if="page === 'bots'" />
        <AgmsgView v-else-if="page === 'agmsg'" />
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
