<script setup lang="ts">
// Agent network: ONE live, read-only org chart of the agents that run this server. The director (the main assistant)
// sits at the root; under it each job team is a soft cluster labelled with its job, plus a "Standing staff" cluster for
// the long-running bots. agmsg teams are only how the clusters are found; they are never shown as a picker. Hover or
// select an agent and only its real connections light up (manager, direct reports, team peers). Data arrives over SSE
// (/agmsg/stream); the server only reads agmsg's own JSON script and Claude Code's session files, and this page never
// sends or changes anything.
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, watch, TransitionGroup } from "vue";
import Icon from "../components/Icon.vue";
import AgentFeed from "../components/bots/AgentFeed.vue";
import AgentHooks from "./AgentHooks.vue";
import AgentRouting from "./AgentRouting.vue";
import AgentArsenal from "./AgentArsenal.vue";
import { S, api, usageWindows } from "../store";
import { modelLabel, dur, type FeedItem, type Meta } from "../bots";

type Kind = "stop" | "bug" | "question" | "report" | "status";
interface Msg { id: number; team: string; from: string; to: string; body: string; at: number; kind?: Kind | null }
interface Member { name: string; team: string; types: string[]; project: string | null }
interface TeamH { job?: string; staff?: boolean; root?: string; flat?: boolean; parent?: Record<string, string>; role?: Record<string, string>; archived?: boolean | string[] }
interface AgentInfo { team: string; name: string; agent?: string; template: string | null; project: string | null; job: string | null; model: string | null; startedAt: number | null; status: string; session: string | null; pid: number | null; via: string | null; doing: string | null }
interface TempAgent { key: string; id: string; parent: string; description: string; agentType: string; model: string | null; startedAt: number; lastAt: number; running: boolean; ended: "finished" | "stopped" | null }
interface Snap { at: number; teams: string[]; members: Member[]; messages: Msg[]; hierarchy?: Record<string, TeamH>; director?: AgentInfo | null; agents?: Record<string, AgentInfo>; temps?: TempAgent[] }
/** A card on the chart: the director, or one agent inside its cluster. */
interface GNode { id: string; kind: "director" | "agent"; temp?: TempAgent; cluster: string; team: string; info: AgentInfo | null; archived: boolean; external: boolean; role: string; x: number; y: number; w: number; h: number; sent: number; recv: number; last: number }
/** A job team (or the standing staff) drawn as a soft box. */
interface Cluster { via?: number; id: string; team: string; label: string; staff: boolean; temp?: boolean; archived: boolean; ids: string[]; parent: Map<string, string>; x: number; y: number; w: number; h: number }
interface Link { a: string; b: string; d: string }

const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const DIR = "@director";
const teams = ref<string[]>([]), members = ref<Member[]>([]), messages = ref<Msg[]>([]);
const hier = ref<Record<string, TeamH>>({}), director = ref<AgentInfo | null>(null), agents = ref<Record<string, AgentInfo>>({}), temps = ref<TempAgent[]>([]);
const live = ref(false), loaded = ref(false), now = ref(Date.now());
const q = ref("");
const history = ref(false);
const tab = ref<"net" | "hooks" | "routing" | "arsenal">("net");
const selNode = ref<string | null>(null), selPair = ref<string | null>(null), selMsg = ref<Msg | null>(null), selCluster = ref<string | null>(null);
const hoverNode = ref<string | null>(null);
const dirTab = ref<"all" | "in" | "out">("all");
const panelTab = ref<"chat" | "messages">("chat");
const fresh = ref(new Set<number>());

// ---------- who is who ----------
const dirAgent = computed(() => director.value?.agent ?? null);
/** The id a name has on the chart: the director's agmsg name becomes the director. */
const nid = (name: string) => (name === dirAgent.value ? DIR : name);
const dn = (id: string) => (id === DIR ? director.value?.name ?? "Director" : id.startsWith("@temp/") ? temps.value.find((t) => t.key === id)?.description ?? "Temp agent" : id);
const teamArchived = (t: string) => hier.value[t]?.archived === true;
const agentArchived = (t: string, n: string) => teamArchived(t) || (Array.isArray(hier.value[t]?.archived) && (hier.value[t].archived as string[]).includes(n));
const projName = (p: string | null | undefined) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : null);
const status = (n: GNode | null | undefined) => (!n ? "offline" : n.kind === "director" ? director.value?.status ?? "offline" : n.info?.status ?? "offline");

// ---------- the chart model ----------
const model = computed(() => {
  const nodes = new Map<string, GNode>();
  const mk = (id: string, kind: GNode["kind"], cluster: string, team: string, info: AgentInfo | null, archived: boolean, external: boolean) => {
    const n: GNode = { id, kind, cluster, team, info, archived, external, role: "", x: 0, y: 0, w: 0, h: 0, sent: 0, recv: 0, last: 0 };
    nodes.set(id, n); return n;
  };
  if (director.value) mk(DIR, "director", "", "", director.value, false, false);
  // clusters: standing staff first, then job teams in name order
  const order = [...teams.value].sort((a, b) => Number(!!hier.value[b]?.staff) - Number(!!hier.value[a]?.staff) || a.localeCompare(b));
  const clusters: Cluster[] = [];
  for (const t of order) {
    const arch = teamArchived(t);
    if (arch && !history.value) continue;
    const cfg = hier.value[t] ?? {};
    const c: Cluster = { id: "c:" + t, team: t, label: cfg.job ?? t, staff: !!cfg.staff, archived: arch, ids: [], parent: new Map(), x: 0, y: 0, w: 0, h: 0 };
    const add = (name: string, external: boolean) => {
      const id = nid(name);
      if (id === DIR || nodes.has(id)) return;
      const a = agentArchived(t, name);
      if (a && !history.value) return;
      mk(id, "agent", c.id, t, agents.value[`${t}/${name}`] ?? null, a, external);
      c.ids.push(id);
    };
    for (const m of members.value) if (m.team === t) add(m.name, false);
    for (const m of messages.value) if (m.team === t) { add(m.from, true); add(m.to, true); }
    if (!c.ids.length) continue;
    // reporting lines only when the team says so; otherwise everybody reports to the director (flat)
    if (!cfg.flat) for (const id of c.ids) { const p = cfg.parent?.[id] ?? (cfg.root && id !== cfg.root ? cfg.root : undefined); if (p && p !== id && c.ids.includes(p)) c.parent.set(id, p); }
    for (const id of c.ids) nodes.get(id)!.role = cfg.role?.[id] ?? ([...c.parent.values()].includes(id) ? "lead" : "");
    clusters.push(c);
  }
  // temp agents: background subagents of any session, one dashed cluster under the director (finished ones = history)
  const tv = temps.value.filter((t) => t.running || history.value);
  if (tv.length) {
    const c: Cluster = { id: "c:@temp", team: "@temp", label: "Temp agents", staff: false, temp: true, archived: !tv.some((t) => t.running), ids: [], parent: new Map(), x: 0, y: 0, w: 0, h: 0 };
    for (const t of tv) {
      const info: AgentInfo = { team: "@temp", name: t.id, template: t.agentType, project: null, job: t.description, model: t.model, startedAt: t.startedAt, status: t.running ? "working" : t.ended ?? "offline", session: null, pid: null, via: "subagent", doing: null };
      const n = mk(t.key, "agent", c.id, "@temp", info, !t.running, false); n.temp = t; c.ids.push(t.key);
    }
    clusters.push(c);
  }
  // message counts, on the chart's ids
  for (const m of messages.value) {
    const a = nodes.get(nid(m.from)), b = nodes.get(nid(m.to));
    if (a) { a.sent++; a.last = Math.max(a.last, m.at); }
    if (b) { b.recv++; b.last = Math.max(b.last, m.at); }
  }
  return { nodes, clusters };
});

/** Who an agent may talk to: its manager, its direct reports and its team peers. The director manages the top of each team. */
function managerOf(id: string): string | null {
  const n = model.value.nodes.get(id); if (!n || n.kind === "director") return null;
  const c = model.value.clusters.find((x) => x.id === n.cluster);
  return c?.parent.get(id) ?? (director.value ? DIR : null);
}
function connected(a: string, b: string) {
  if (a === b) return false;
  const na = model.value.nodes.get(a), nb = model.value.nodes.get(b);
  if (!na || !nb) return false;
  if (managerOf(a) === b || managerOf(b) === a) return true;
  return na.kind === "agent" && nb.kind === "agent" && na.cluster === nb.cluster;
}
const visMsgs = computed(() => messages.value.filter((m) => model.value.nodes.has(nid(m.from)) && model.value.nodes.has(nid(m.to))));
const onChart = (m: Msg) => connected(nid(m.from), nid(m.to));

// ---------- layout: director on top, clusters under it (side by side; stacked on a phone) ----------
const W = ref(800), H = ref(520);
const view = ref({ x: 0, y: 0, k: 1 });
const simNodes = shallowRef<GNode[]>([]);
// Hooks connected to the director: one small node per hook script, drawn in a lane beside / above the director.
interface HookNode { id: string; script: string; name: string; events: string[]; enabled: boolean; live: boolean; x: number; y: number; w: number; h: number; d: string }
const hookList = ref<{ script: string; name: string; events: string[]; enabled: boolean; live: boolean }[]>([]);
const hookNodes = shallowRef<HookNode[]>([]);
const hookFire = ref(new Set<string>());
// Weekly usage: the badge in the corner (live Claude windows + routing mode) and each agent's share of this week.
interface UsageView { at: number; weekStart: number; resetsAt: number; total: number; scanning: boolean; agents: Record<string, { share: number; cost: number; tokens: number }>; mode: { mode: "normal" | "careful" | "eco" | "reserve"; usagePct: number; pace: string | null; override: boolean } | null }
const usageV = ref<UsageView | null>(null);
const wins = computed(() => usageWindows(S.claudeUsage).filter((w) => w.key === "five_hour" || w.key === "seven_day"));
const winLabel = (k: string) => (k === "five_hour" ? "5 h" : "Week");
const shareKey = (n: GNode) => (n.kind === "director" ? "@/director" : n.temp ? null : `${n.team}/${n.info?.name ?? n.id}`);
const shareOf = (n: GNode) => { const k = shareKey(n); const v = k ? usageV.value?.agents[k] : null; return v ? v.share : null; };
const fmtShare = (v: number) => (v >= 10 ? `${Math.round(v)}%` : v > 0 && v < 0.1 ? "<0.1%" : `${v.toFixed(1)}%`);
const badgeTip = computed(() => { const u = usageV.value; if (!u) return "Claude usage"; const left = u.resetsAt ? Math.max(0, u.resetsAt * 1000 - now.value) : 0; return `Claude usage. Mode ${u.mode?.mode ?? "?"}${u.mode?.pace ? ` (${u.mode.pace})` : ""}.${u.resetsAt ? ` The week resets in ${dur(left)}; agent shares count from the start of this week.` : ""}${u.mode?.override ? " Reserve override is on." : ""}`; });
async function loadUsage() { try { usageV.value = await api<UsageView>("/agmsg/usage"); } catch { /* badge stays on the live windows */ } }
watch(() => S.claudeUsage?.fetchedAt, () => void loadUsage());
const boxes = shallowRef<Cluster[]>([]);
const links = shallowRef<Link[]>([]);
const tick = ref(0);
const isPortrait = () => W.value < H.value * 0.95;
const KMIN = 0.92;
const CH = 56, ROW = 74, HEAD = 60, PAD = 20, IND = 26, GAP = 56;
const cardW = (id: string) => {
  if (id.startsWith("@temp/")) return 280;
  const n = model.value.nodes.get(id), s = n ? sub(n).length : 0;
  return Math.max(212, dn(id).length * 8 + 118, s * 6.9 + 116);
};

function layout() {
  const { nodes, clusters } = model.value;
  const portrait = isPortrait();
  const lk: Link[] = [];
  // each cluster: an indented tree (leads on top, their reports under them)
  for (const c of clusters) {
    const kids = (p: string | null) => c.ids.filter((id) => (c.parent.get(id) ?? null) === p);
    const rows: { id: string; depth: number }[] = [];
    const walk = (id: string, d: number) => { rows.push({ id, depth: d }); for (const k of kids(id)) walk(k, d + 1); };
    for (const r of kids(null)) walk(r, 0);
    const w0 = Math.max(...c.ids.map(cardW)), depth = Math.max(0, ...rows.map((r) => r.depth));
    c.w = Math.max(PAD * 2 + depth * IND + w0, c.label.length * 7 + 60);
    c.h = HEAD + rows.length * ROW - (ROW - CH) + PAD;
    rows.forEach((r, i) => { const n = nodes.get(r.id)!; n.w = c.w - PAD * 2 - r.depth * IND; n.h = CH; n.x = PAD + r.depth * IND + n.w / 2; n.y = HEAD + i * ROW + CH / 2; });
  }
  const d = nodes.get(DIR);
  if (d) { d.w = Math.max(212, dn(DIR).length * 8 + 70); d.h = 58; }
  const top = (d?.h ?? 0) + 64;
  if (!portrait) {
    // wrap the teams into rows that fit the canvas at a readable zoom (text stays >= 12 px), each row centred
    const maxW = Math.max(520, (W.value - 40) / KMIN);
    const rows: Cluster[][] = [[]]; let rw = 0;
    const ordered = [...clusters].sort((p, q) => Number(p.staff) - Number(q.staff)); // standing staff last: it is the tall one, the job teams stay on top
    for (const c of ordered) {
      if (rows[rows.length - 1].length && rw + GAP + c.w > maxW) { rows.push([]); rw = 0; }
      rows[rows.length - 1].push(c); rw += (rows[rows.length - 1].length > 1 ? GAP : 0) + c.w;
    }
    const widths = rows.map((r0) => r0.reduce((a, c) => a + c.w, 0) + (r0.length - 1) * GAP);
    const outer = Math.max(...widths) / 2 + 30;
    let y = top;
    rows.forEach((r0, ri) => {
      let x = -widths[ri] / 2;
      for (const c of r0) { c.x = x; c.y = y; c.via = ri ? (c.x + c.w / 2 < 0 ? -outer : outer) : undefined; x += c.w + GAP; }
      y += Math.max(...r0.map((c) => c.h)) + 52;
    });
    if (d) {
      d.x = 0; d.y = d.h / 2; const bus = d.h + 22;
      for (const c of clusters) lk.push({ a: DIR, b: c.id, d: c.via === undefined ? `M0,${d.h} V${bus} H${c.x + c.w / 2} V${c.y}` : `M0,${d.h} V${bus} H${c.via} V${c.y - 26} H${c.x + c.w / 2} V${c.y}` });
    }
  } else {
    const trunk = 20;
    let y = top;
    for (const c of clusters) { c.x = trunk + 22; c.y = y; y += c.h + 22; }
    if (d) { d.x = d.w / 2; d.y = d.h / 2; for (const c of clusters) lk.push({ a: DIR, b: c.id, d: `M${trunk},${d.h} V${c.y + 26} H${c.x}` }); }
  }
  // hooks: a lane of small nodes around the director (left and right of it; two columns above it on a phone)
  const hn: HookNode[] = [];
  const hl = hookList.value;
  if (d && hl.length) {
    const HW = portrait ? 164 : 200, HH = 28, P = 34;
    const mk = (h: (typeof hl)[number]) => ({ id: "@hook/" + h.script, ...h, x: 0, y: 0, w: HW, h: HH, d: "" });
    if (!portrait) {
      const left = hl.slice(0, Math.ceil(hl.length / 2)).map(mk), right = hl.slice(left.length).map(mk), cy = d.y - 14 - ((left.length - 1) / 2) * P - HH / 2;
      for (const [col, side] of [[left, -1], [right, 1]] as const) col.forEach((n, i) => {
        n.x = side * (d.w / 2 + 110 + HW / 2); n.y = cy + (i - (col.length - 1) / 2) * P;
        const ay = d.y + (i - (col.length - 1) / 2) * 7, ax = d.x + side * d.w / 2, px = n.x - side * HW / 2;
        n.d = `M${px},${n.y} C${px - side * 70},${n.y} ${ax + side * 70},${ay} ${ax},${ay}`; hn.push(n);
      });
    } else {
      const GUT = 24, gx = HW + GUT / 2, all = hl.map(mk), rows = Math.ceil(all.length / 2);
      all.forEach((n, i) => {
        const col = i % 2, r = Math.floor(i / 2);
        n.x = col ? HW + GUT + HW / 2 : HW / 2; n.y = -30 - (rows - r) * P + HH / 2 + 6;
        n.d = `M${col ? HW + GUT : HW},${n.y} H${gx} V0`; hn.push(n);
      });
    }
  }
  hookNodes.value = hn;
  // cards to world coordinates, then the reporting elbows inside each cluster
  for (const c of clusters) for (const id of c.ids) { const n = nodes.get(id)!; n.x += c.x; n.y += c.y; }
  for (const c of clusters) for (const [k, p] of c.parent) {
    const a = nodes.get(p)!, b = nodes.get(k)!;
    lk.push({ a: p, b: k, d: `M${a.x - a.w / 2 + 14},${a.y + a.h / 2} V${b.y} H${b.x - b.w / 2}` });
  }
  boxes.value = [...clusters]; links.value = lk; simNodes.value = [...nodes.values()];
  tick.value++;
}
const structKey = computed(() => [...model.value.nodes.keys()].join(",") + "|" + model.value.clusters.map((c) => c.id + c.label + [...c.parent].join()).join(";"));
watch(model, () => layout());
watch(hookList, () => { layout(); nextTick(fit); });
watch(structKey, () => { layout(); nextTick(fit); });

function fit() {
  const l = simNodes.value;
  if (!l.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of l) { x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2); y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2); }
  for (const b of boxes.value) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h); }
  for (const n of hookNodes.value) { x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2); y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2); }
  const pad = 40, foot = 40;
  if (isPortrait()) { // a phone: fit the width, start at the top, pan down
    const k = Math.min(1.3, (W.value - pad) / (x1 - x0));
    view.value = { k, x: W.value / 2 - ((x0 + x1) / 2) * k, y: 56 - y0 * k }; // below the usage badge
    return;
  }
  const top = 48; // room for the usage badge
  const k = Math.min(1.7, Math.max(KMIN, Math.min((W.value - pad) / (x1 - x0), (H.value - foot - top - pad) / (y1 - y0))));
  const fits = (y1 - y0) * k <= H.value - foot - top - pad;
  view.value = { k, x: W.value / 2 - ((x0 + x1) / 2) * k, y: fits ? top + (H.value - foot - top) / 2 - ((y0 + y1) / 2) * k : top + 12 - y0 * k }; // taller than the canvas: start at the top, pan down
}

const N = (id: string) => { void tick.value; return model.value.nodes.get(id)!; };
/** Where a line towards (tx, ty) leaves a card. */
function edgePoint(n: GNode, tx: number, ty: number, gap = 3) {
  const dx = tx - n.x, dy = ty - n.y;
  const t = Math.min((n.w / 2 + gap) / (Math.abs(dx) || 1e-6), (n.h / 2 + gap) / (Math.abs(dy) || 1e-6));
  return { x: n.x + dx * Math.min(t, 1), y: n.y + dy * Math.min(t, 1) };
}
/** The path a message travels, sender to receiver, bowed to the sender's right so a reply takes the other side. */
function flightPath(from: string, to: string) {
  const a = N(from), b = N(to);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const cx = mx - (dy / len) * Math.min(60, len * 0.22), cy = my + (dx / len) * Math.min(60, len * 0.22);
  const s = edgePoint(a, cx, cy, 2), t = edgePoint(b, cx, cy, 2);
  return `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${t.x.toFixed(1)},${t.y.toFixed(1)}`;
}
/** The route a message takes on the chart, sender to receiver, along its connectors only: down the director's bus and
 *  a cluster's left gutter, along a manager's elbow, or between peers through their cluster's gutter. */
function route(from: string, to: string): string | null {
  void tick.value;
  const nodes = model.value.nodes, boxOf = (n: GNode) => boxes.value.find((c) => c.id === n.cluster);
  const a = nodes.get(from), b = nodes.get(to);
  if (!a || !b) return null;
  const left = (n: GNode) => [n.x - n.w / 2, n.y] as const;
  const down = (n: GNode): (readonly [number, number])[] | null => { // director to agent n
    const d = nodes.get(DIR), c = boxOf(n); if (!d || !c) return null;
    const gx = c.x + 8, db = d.y + d.h / 2;
    const head: (readonly [number, number])[] = isPortrait() ? [[20, db], [20, c.y + 26], [gx, c.y + 26]] : c.via !== undefined ? [[d.x, db], [d.x, db + 22], [c.via, db + 22], [c.via, c.y - 26], [gx, c.y - 26]] : [[d.x, db], [d.x, db + 22], [gx, db + 22]];
    return [...head, [gx, n.y], left(n)];
  };
  let pts: (readonly [number, number])[] | null = null;
  if (a.kind === "director" && managerOf(to) === DIR) pts = down(b);
  else if (b.kind === "director" && managerOf(from) === DIR) pts = down(a)?.reverse() ?? null;
  else if (managerOf(to) === from) pts = [[a.x - a.w / 2 + 14, a.y + a.h / 2], [a.x - a.w / 2 + 14, b.y], left(b)];
  else if (managerOf(from) === to) pts = [left(a), [b.x - b.w / 2 + 14, a.y], [b.x - b.w / 2 + 14, b.y + b.h / 2]];
  else if (a.kind === "agent" && b.kind === "agent" && a.cluster === b.cluster) { const c = boxOf(a); if (c) { const gx = c.x + 8; pts = [left(a), [gx, a.y], [gx, b.y], left(b)]; } }
  return pts ? "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L") : null;
}
const focus = computed(() => hoverNode.value ?? selNode.value);
/** A connector lights up when it leads to the focused agent: its manager line, or its reports' lines. */
const linkLive = (l: Link) => { const c = boxes.value.find((x) => x.id === l.b); if (c) return clusterWorking(c); return status(model.value.nodes.get(l.b)) === "working"; };
const linkOn = (l: Link) => {
  const f = focus.value; if (!f) return false;
  if (l.a === f || l.b === f) return true;
  const n = model.value.nodes.get(f);
  return l.a === DIR && !!n && l.b === n.cluster && managerOf(f) === DIR;
};
/** Peer lines inside the focused agent's team (only between agents that actually exchanged messages). */
const peerLines = computed(() => {
  const f = focus.value; if (!f || f === DIR) return [];
  const n = model.value.nodes.get(f); if (!n) return [];
  const seen = new Set<string>();
  for (const m of visMsgs.value) {
    const a = nid(m.from), b = nid(m.to);
    if ((a !== f && b !== f) || a === b) continue;
    const o = a === f ? b : a, on = model.value.nodes.get(o);
    if (on?.kind === "agent" && on.cluster === n.cluster && managerOf(o) !== f && managerOf(f) !== o) seen.add(o);
  }
  return [...seen].map((o) => ({ o, d: route(f, o) ?? flightPath(f, o) }));
});
const nodeDim = (id: string) => { const f = focus.value; return !!f && id !== f && !connected(f, id); };
const boxDim = (c: Cluster) => { const f = focus.value; if (!f) return false; const n = model.value.nodes.get(f); return !!n && n.kind === "agent" && n.cluster !== c.id; };

// ---------- pan / zoom ----------
const svgEl = ref<SVGSVGElement | null>(null);
const pointers = new Map<number, { x: number; y: number }>();
let gesture: { kind: "pan" | "pick" | "pinch"; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean; dist?: number; k0?: number } | null = null;
const local = (ev: { clientX: number; clientY: number }) => { const r = svgEl.value!.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
function zoomAt(p: { x: number; y: number }, f: number) {
  const v = view.value, k = Math.min(3, Math.max(0.3, v.k * f)), r = k / v.k;
  view.value = { k, x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r };
}
function onDown(ev: PointerEvent, pick?: string) {
  (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
  pointers.set(ev.pointerId, local(ev));
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { kind: "pinch", sx: 0, sy: 0, vx: 0, vy: 0, moved: true, dist: Math.hypot(a.x - b.x, a.y - b.y), k0: view.value.k };
    return;
  }
  const p = local(ev);
  gesture = { kind: pick ? "pick" : "pan", id: pick, sx: p.x, sy: p.y, vx: view.value.x, vy: view.value.y, moved: false };
}
function onMove(ev: PointerEvent) {
  if (!pointers.has(ev.pointerId) || !gesture) return;
  const p = local(ev);
  pointers.set(ev.pointerId, p);
  if (gesture.kind === "pinch" && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, (gesture.k0! * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist! / view.value.k);
    return;
  }
  if (Math.hypot(p.x - gesture.sx, p.y - gesture.sy) > 4) gesture.moved = true;
  if (gesture.moved) view.value = { ...view.value, x: gesture.vx + (p.x - gesture.sx), y: gesture.vy + (p.y - gesture.sy) };
}
function onUp(ev: PointerEvent) {
  pointers.delete(ev.pointerId);
  const g = gesture;
  if (pointers.size < 2 && g?.kind === "pinch") { gesture = null; return; }
  if (!g) return;
  gesture = null;
  if (g.moved) return;
  if (g.kind === "pick") { if (g.id!.startsWith("c:")) pickCluster(g.id!); else pickNode(g.id!); }
  else clearSel();
}
function onWheel(ev: WheelEvent) { zoomAt(local(ev), Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016))); }
const zoomBtn = (f: number) => zoomAt({ x: W.value / 2, y: H.value / 2 }, f);

// ---------- selection ----------
function pickNode(id: string) { if (selNode.value !== id) panelTab.value = "chat"; selNode.value = selNode.value === id && !selPair.value && !selMsg.value ? null : id; selPair.value = null; selMsg.value = null; selCluster.value = null; dirTab.value = "all"; }
function pickPair(pair: string) { selPair.value = selPair.value === pair ? null : pair; selMsg.value = null; if (selPair.value) { selNode.value = null; selCluster.value = null; } }
function pickCluster(id: string) { selCluster.value = selCluster.value === id ? null : id; selNode.value = null; selPair.value = null; selMsg.value = null; }
function clearSel() { selNode.value = null; selPair.value = null; selMsg.value = null; selCluster.value = null; }
const nodeInfo = computed(() => (selNode.value ? model.value.nodes.get(selNode.value) ?? null : null));
const clusterInfo = computed(() => model.value.clusters.find((c) => c.id === selCluster.value) ?? null);
const pairNames = computed(() => (selPair.value ? selPair.value.split("|") : null));
const nodeMsgs = computed(() => visMsgs.value.filter((m) => nid(m.from) === selNode.value || nid(m.to) === selNode.value));
const nodeShown = computed(() => nodeMsgs.value.filter((m) => dirTab.value === "all" || (dirTab.value === "in" ? nid(m.to) === selNode.value : nid(m.from) === selNode.value)).slice(-80).reverse());
const offChart = computed(() => nodeMsgs.value.filter((m) => !onChart(m)).length);
const thread = computed(() => {
  const [a, b] = pairNames.value ?? [];
  return visMsgs.value.filter((m) => (nid(m.from) === a && nid(m.to) === b) || (nid(m.from) === b && nid(m.to) === a)).slice(-120);
});
// ---------- the feed: one thread per pair of agents, newest first ----------
const KINDS: [Kind, string][] = [["question", "Questions"], ["report", "Reports"], ["bug", "Bugs"], ["stop", "Stops"], ["status", "Status"]];
const KIND_HUE: Record<Kind, number> = { question: 210, report: 152, bug: 0, stop: 28, status: 240 };
const kindF = ref<Kind | "all">("all");
const unread = ref(new Set<string>());
interface Thread { key: string; a: string; b: string; last: Msg; n: number; kinds: Set<Kind>; off: boolean }
const threads = computed(() => {
  const s = q.value.trim().toLowerCase();
  const map = new Map<string, Thread>();
  for (const m of visMsgs.value) {
    const a = nid(m.from), b = nid(m.to);
    if (s && !`${dn(a)} ${dn(b)} ${m.body}`.toLowerCase().includes(s)) continue;
    if (kindF.value !== "all" && m.kind !== kindF.value) continue;
    const key = pairKey(a, b);
    const t = map.get(key) ?? { key, a, b, last: m, n: 0, kinds: new Set<Kind>(), off: !connected(a, b) };
    t.n++; if (m.kind) t.kinds.add(m.kind);
    if (m.at >= t.last.at) { t.last = m; t.a = a; t.b = b; } // the newest sender first
    map.set(key, t);
  }
  return [...map.values()].sort((x, y) => y.last.at - x.last.at).slice(0, 60);
});
const kindCount = computed(() => { const c: Record<string, number> = {}; for (const m of visMsgs.value) if (m.kind) c[m.kind] = (c[m.kind] ?? 0) + 1; return c; });
function openThread(key: string) { const u = new Set(unread.value); u.delete(key); unread.value = u; pickPair(key); }
const pairKey = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);

// ---------- one agent's chat: its Claude Code session, streamed live (read-only) ----------
const chatItems = ref<FeedItem[]>([]);
const chatSession = ref<Meta["session"]>(null);
const chatState = ref<"idle" | "loading" | "live" | "none">("idle");
interface TaskRow { id: string; text: string; active?: string; status: "pending" | "in_progress" | "done" }
const chatTasks = ref<TaskRow[]>([]), tasksOpen = ref(true);
const taskDone = computed(() => chatTasks.value.filter((t) => t.status === "done").length);
let ces: EventSource | null = null;
/** agmsg's key for the selected card: "<team>/<name>", or "@/director". */
const chatKey = computed(() => { const n = nodeInfo.value; if (!n) return null; return n.kind === "director" ? "@/director" : `${n.team}/${n.info?.name ?? n.id}`; });
function closeChat() { ces?.close(); ces = null; }
function openChat(key: string) {
  closeChat();
  chatItems.value = []; chatSession.value = null; chatTasks.value = []; chatState.value = "loading";
  const [t, ...rest] = key.split("/");
  ces = new EventSource(`/api/v1/agmsg/agents/${encodeURIComponent(t)}/${encodeURIComponent(rest.join("/"))}/chat`);
  ces.addEventListener("reset", (e) => { const d = JSON.parse((e as MessageEvent).data); chatItems.value = d.items; chatSession.value = d.session; chatTasks.value = d.tasks ?? []; chatState.value = d.path ? "live" : "none"; });
  ces.addEventListener("items", (e) => {
    const list = JSON.parse((e as MessageEvent).data) as FeedItem[];
    const next = [...chatItems.value], at = new Map(next.map((x, i) => [x.id, i]));
    for (const it of list) { const i = at.get(it.id); if (i === undefined) { at.set(it.id, next.length); next.push(it); } else next[i] = it; }
    chatItems.value = next.slice(-400);
  });
  ces.addEventListener("meta", (e) => { const d = JSON.parse((e as MessageEvent).data); chatSession.value = d.session; chatTasks.value = d.tasks ?? []; chatState.value = d.path ? "live" : "none"; });
}
// the stream stays open on the Messages tab too: the task list above the tabs follows the same session
watch(chatKey, (k) => { if (k) openChat(k); else { closeChat(); chatTasks.value = []; } });
/** A subagent's log never writes a turn end: once it is finished or stopped, it is not working. */
const ended = computed(() => !!nodeInfo.value?.temp && !nodeInfo.value.temp.running);
const chatMeta = computed(() => ({ session: chatSession.value && ended.value ? { ...chatSession.value, working: null } : chatSession.value }) as unknown as Meta);
/** What the agent is doing now: its running step, from the session it writes. */
const doingNow = computed(() => { const n = nodeInfo.value; if (!n || ended.value) return null; const w = chatSession.value?.working; return w ? w.step ?? "thinking" : n.info?.doing ?? null; });
const instanceOf = (n: GNode) => { const m = (n.info?.name ?? n.id).match(/^(.+)-(\d+)$/); return m ? `${m[1]} #${m[2]}` : n.info?.template && n.info.template !== n.id ? n.info.template : null; };
/** A stable colour per template (or name), for avatars. */
const HUES = [152, 205, 262, 28, 330, 48, 182, 0];
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const avatar = (n: GNode) => { const key = n.kind === "director" ? "director" : n.info?.template ?? n.id.replace(/-\d+$/, ""); const name = dn(n.id); const parts = name.split(/[-\s_]+/).filter(Boolean); return { hue: hue(key), text: (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase() }; };
const avatarOf = (id: string) => { const n = model.value.nodes.get(id); if (n) return avatar(n); const p = id.split(/[-\s_]+/).filter(Boolean); return { hue: hue(id.replace(/-\d+$/, "")), text: (p.length > 1 ? p[0][0] + p[1][0] : id.slice(0, 2)).toUpperCase() }; };
const ago = (t: number) => { const s = Math.max(0, Math.round((now.value - t) / 1000)); return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const preview = (b: string) => b.replace(/\s+/g, " ").trim();
const since = (t: number | null | undefined) => (t ? dur(Math.max(0, now.value - t)) : null);
const isPhone = ref(false);
/** The panel slides over the map: the feed (opened with the Messages button) or whatever is selected. */
const feedOpen = ref(false);
const hasSel = computed(() => !!(nodeInfo.value || clusterInfo.value || selMsg.value || selPair.value));
const panelOpen = computed(() => feedOpen.value || hasSel.value);
const sheetOpen = computed(() => isPhone.value && panelOpen.value);
const unreadCount = computed(() => unread.value.size);
/** Close: a selection first falls back to the feed when the feed was open, else the panel closes. */
function closePanel() { if (hasSel.value) clearSel(); else feedOpen.value = false; }
const sideEl = ref<HTMLElement | null>(null);
watch(panelOpen, (o) => { if (o && isPhone.value) nextTick(() => sideEl.value?.querySelector<HTMLElement>(".an-ic")?.focus()); document.documentElement.style.overflow = o && isPhone.value ? "hidden" : ""; });
/** Keep the picked card visible: if the open panel would cover it, slide the map left. */
watch(selNode, (id) => nextTick(() => {
  if (!id || isPhone.value) return;
  const n = model.value.nodes.get(id); if (!n) return;
  const sx = n.x * view.value.k + view.value.x, free = W.value - 430;
  if (sx + (n.w / 2) * view.value.k > free) view.value = { ...view.value, x: view.value.x - (sx - free / 2) };
}));
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && panelOpen.value) { e.preventDefault(); closePanel(); } };

// ---------- live messages: each one travels from sender to receiver, one after another (connected pairs only) ----------
const flightsEl = ref<SVGGElement | null>(null);
const hot = ref(new Set<string>()), pulse = ref(new Set<string>());
const toasts = ref<{ id: number; node: string; from: string; text: string }[]>([]);
interface Flight { path: SVGPathElement; dot: SVGCircleElement; len: number; t0: number; dur: number; to: string; m?: Msg; speed: number; arrived: boolean; done?: () => void }
const flying: Flight[] = [];
let raf = 0, qBusy = false;
const queue: { m: Msg; speed: number }[] = [];
const NS = "http://www.w3.org/2000/svg";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function addTimed(set: { value: Set<string> }, key: string, ms: number) {
  set.value = new Set(set.value).add(key);
  setTimeout(() => { const s = new Set(set.value); s.delete(key); set.value = s; }, ms);
}
function arrive(f: { to: string; m: Msg; speed: number }) {
  addTimed(pulse, f.to, 1000 / Math.min(f.speed, 1.5));
  const id = f.m.id + Math.random();
  toasts.value = [...(isPortrait() ? [] : toasts.value.slice(-1)), { id, node: f.to, from: dn(nid(f.m.from)), text: f.m.body.replace(/\s+/g, " ").slice(0, 70) }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 3000 / Math.min(f.speed, 1.5));
}
function start(m: Msg, speed: number) {
  const from = nid(m.from), to = nid(m.to);
  if (!model.value.nodes.has(from) || !model.value.nodes.has(to) || !connected(from, to)) return;
  if (reduce || !flightsEl.value) { addTimed(hot, from, 1400); arrive({ to, m, speed }); return; }
  const path = document.createElementNS(NS, "path"), dot = document.createElementNS(NS, "circle");
  path.setAttribute("d", route(from, to) ?? flightPath(from, to));
  const len = path.getTotalLength() || 1;
  Object.assign(path.style, { fill: "none", stroke: "var(--on)", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none", strokeDasharray: String(len), strokeDashoffset: String(len), opacity: "0.9" });
  dot.setAttribute("r", "4.5");
  Object.assign(dot.style, { fill: "var(--on)", pointerEvents: "none", filter: "drop-shadow(0 0 6px var(--on))", opacity: "0" });
  flightsEl.value.append(path, dot);
  flying.push({ path, dot, len, t0: performance.now(), dur: 1200 / speed, to, m, speed, arrived: false });
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame(t: number) {
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i], p = (t - f.t0) / f.dur;
    if (p < 0) continue;
    const e = Math.min(1, p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    f.path.style.strokeDashoffset = String(f.len * (1 - e));
    const pt = f.path.getPointAtLength(f.len * e);
    f.dot.setAttribute("cx", String(pt.x)); f.dot.setAttribute("cy", String(pt.y));
    f.dot.style.opacity = String(p >= 1 ? 0 : Math.min(1, p * 8));
    if (p >= 1 && !f.arrived) { f.arrived = true; if (f.done) f.done(); else if (f.m) arrive({ to: f.to, m: f.m, speed: f.speed }); }
    const fade = (p - 1.25) / 0.6;
    if (fade > 0) f.path.style.opacity = String(Math.max(0, 0.9 * (1 - fade)));
    if (fade >= 1) { f.path.remove(); f.dot.remove(); flying.splice(i, 1); }
  }
  raf = flying.length ? requestAnimationFrame(frame) : 0;
}
/** A hook fired: its node glows, a dot runs along its edge to the director, and the director glows on arrival. */
const HOOK_COL = "var(--hook)";
const hookSkip = ref(new Map<string, string>());
function hookFired(script: string, skipped = false, reason = "") {
  const n = hookNodes.value.find((x) => x.script === script);
  if (!n) return;
  if (skipped) { // ran but chose to do nothing: a quiet dim, no glow, no dot, reason on hover
    hookSkip.value = new Map(hookSkip.value).set(n.id, reason || "skipped");
    setTimeout(() => { const m = new Map(hookSkip.value); m.delete(n.id); hookSkip.value = m; }, 2500);
    return;
  }
  addTimed(hookFire, n.id, 1400);
  const arrived = () => addTimed(pulse, DIR, 900);
  if (reduce || !flightsEl.value) { arrived(); return; }
  const path = document.createElementNS(NS, "path"), dot = document.createElementNS(NS, "circle");
  path.setAttribute("d", n.d);
  const len = path.getTotalLength() || 1;
  Object.assign(path.style, { fill: "none", stroke: HOOK_COL, strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none", strokeDasharray: String(len), strokeDashoffset: String(len), opacity: "0.9" });
  dot.setAttribute("r", "4");
  Object.assign(dot.style, { fill: HOOK_COL, pointerEvents: "none", opacity: "0" });
  flightsEl.value.append(path, dot);
  flying.push({ path, dot, len, t0: performance.now(), dur: 900, to: DIR, speed: 1, arrived: false, done: arrived });
  if (!raf) raf = requestAnimationFrame(frame);
}
async function drain() {
  if (qBusy) return;
  qBusy = true;
  while (queue.length) { const it = queue.shift()!; start(it.m, it.speed); await sleep(520 / it.speed); }
  qBusy = false;
}
function enqueue(list: Msg[], speed = 1) { for (const m of list) queue.push({ m, speed }); void drain(); }
/** Replay the last 20 connected messages at double speed (only the picture moves; nothing is sent). */
function replay() { queue.length = 0; nextTick(() => enqueue(visMsgs.value.filter(onChart).slice(-20), 2)); }
const toastStyle = (n: string) => { void tick.value; const nd = model.value.nodes.get(n); if (!nd) return { display: "none" }; const above = nd.y * view.value.k + view.value.y - (nd.h / 2) * view.value.k - 10; const hw = isPortrait() ? 90 : 120; return { left: `${Math.min(W.value - hw - 6, Math.max(hw + 6, nd.x * view.value.k + view.value.x))}px`, ...(above < 90 ? { top: `${nd.y * view.value.k + view.value.y + (nd.h / 2) * view.value.k + 10}px`, transform: "translate(-50%,0)" } : { top: `${above}px` }), maxWidth: `${hw * 2}px` }; };

// ---------- SSE ----------
let hes: EventSource | null = null;
async function loadHooks() { try { hookList.value = (await api<{ nodes: typeof hookList.value }>("/agent-hooks/nodes")).nodes; } catch { /* no hooks lane */ } }
function connectHooks() {
  void loadHooks();
  hes = new EventSource("/api/v1/agent-hooks/stream");
  hes.addEventListener("fire", (e) => { const f = JSON.parse((e as MessageEvent).data) as { script: string; skipped?: boolean; reason?: string }; hookFired(f.script, f.skipped, f.reason); });
}
let es: EventSource | null = null, timerNow: ReturnType<typeof setInterval>;
function apply(s: Snap) {
  teams.value = s.teams; members.value = s.members; hier.value = s.hierarchy ?? hier.value;
  if (s.director !== undefined) director.value = s.director;
  if (s.agents) agents.value = s.agents;
  if (s.temps) temps.value = s.temps;
}
function connect() {
  es = new EventSource("/api/v1/agmsg/stream");
  es.addEventListener("snapshot", (e) => { const s = JSON.parse((e as MessageEvent).data) as Snap; apply(s); messages.value = s.messages; loaded.value = true; live.value = true; });
  es.addEventListener("usage", (e) => { usageV.value = JSON.parse((e as MessageEvent).data) as UsageView; });
  es.addEventListener("net", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as Snap;
    apply(d); live.value = true;
    if (!d.messages.length) return;
    messages.value = [...messages.value, ...d.messages].slice(-4000);
    nextTick(() => enqueue(d.messages));
    const u = new Set(unread.value); for (const m of d.messages) { const k = pairKey(nid(m.from), nid(m.to)); if (k !== selPair.value) u.add(k); } unread.value = u;
    const ids = new Set(fresh.value); for (const m of d.messages) ids.add(m.id);
    fresh.value = ids;
    setTimeout(() => { const s = new Set(fresh.value); for (const m of d.messages) s.delete(m.id); fresh.value = s; }, 3500);
  });
  es.onerror = () => { live.value = false; };
  es.onopen = () => { live.value = true; };
}
let ro: ResizeObserver | null = null;
const box = ref<HTMLElement | null>(null);
function measure() {
  if (!box.value || !box.value.clientWidth) return; // hidden behind the Hooks tab
  const was = isPortrait();
  W.value = box.value.clientWidth; H.value = box.value.clientHeight;
  if (was !== isPortrait()) layout();
}
onMounted(() => {
  connect(); connectHooks(); void loadUsage();
  timerNow = setInterval(() => (now.value = Date.now()), 5000);
  ro = new ResizeObserver(() => { if (!box.value?.clientWidth) return; measure(); fit(); });
  if (box.value) ro.observe(box.value);
});
let mq: MediaQueryList | null = null;
const onMq = () => { isPhone.value = !!mq?.matches; };
onMounted(() => { mq = matchMedia("(max-width: 900px)"); onMq(); mq.addEventListener("change", onMq); window.addEventListener("keydown", onKey); });
onUnmounted(() => { es?.close(); hes?.close(); closeChat(); clearInterval(timerNow); ro?.disconnect(); cancelAnimationFrame(raf); mq?.removeEventListener("change", onMq); window.removeEventListener("keydown", onKey); document.documentElement.style.overflow = ""; });
watch(loaded, (l) => { if (l) nextTick(() => { measure(); layout(); fit(); }); });

// ---------- formatting ----------
const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const expanded = ref(new Set<number>());
const toggle = (id: number) => { const s = new Set(expanded.value); s.has(id) ? s.delete(id) : s.add(id); expanded.value = s; };
/** Second line of a card: "Director · working", or "<project> · <job>" (the status when no job is known). */
const parentName = (key: string) => (key === "@/director" ? dn(DIR) : dn(nid(key.split("/").slice(1).join("/"))));
const sub = (n: GNode) => n.temp ? [n.temp.model ? modelLabel(n.temp.model) : n.temp.agentType, `from ${parentName(n.temp.parent)}`].join(" · ") : n.kind === "director" ? `${director.value?.template ?? "Director"} · ${status(n)}` : [n.role || null, projName(n.info?.project) === n.id ? null : projName(n.info?.project), n.info?.job ?? (n.external && !n.info ? "no session" : n.info?.model ? modelLabel(n.info.model) : null)].filter(Boolean).join(" · ") || "no job yet";
/** Cut a line to fit a card (SVG text does not wrap or ellipsize). */
const fitText = (t: string, px: number, size = 11) => { const max = Math.floor(px / (size * 0.56)); return t.length > max ? t.slice(0, Math.max(1, max - 1)) + "…" : t; };
const tip = (n: GNode) => `${dn(n.id)}\n${sub(n)}${n.info?.doing ? `\nnow: ${n.info.doing}` : ""}\n${n.sent} sent, ${n.recv} received`;
const clusterOf = (n: GNode) => model.value.clusters.find((c) => c.id === n.cluster)?.label ?? null;
const clusterWorking = (c: Cluster) => c.ids.some((id) => status(model.value.nodes.get(id)) === "working");
const clusterStat = (c: Cluster) => { const ns = c.ids.map((id) => model.value.nodes.get(id)!); const w = ns.filter((n) => status(n) === "working").length; return `${ns.length} ${ns.length === 1 ? "agent" : "agents"}${w ? ` · ${w} working` : ""}`; };
const counts = computed(() => { const ns = [...model.value.nodes.values()]; return { all: ns.length, working: ns.filter((n) => status(n) === "working").length, online: ns.filter((n) => status(n) !== "offline").length }; });
</script>

<template>
  <main class="page an">
    <header class="an-head">
      <div class="an-title">
        <h1>Agent network</h1>
        <span class="an-live" :class="{ off: !live }" role="status"><i></i>{{ live ? "live" : "reconnecting" }}</span>
        <span class="an-sum num">{{ counts.all }} agents · {{ counts.working }} working · {{ counts.online }} online</span>
      </div>
      <div class="an-views" role="tablist" aria-label="Agent network sections">
        <button type="button" role="tab" :aria-selected="tab === 'net'" :class="{ on: tab === 'net' }" @click="tab = 'net'">Network</button>
        <button type="button" role="tab" :aria-selected="tab === 'hooks'" :class="{ on: tab === 'hooks' }" @click="tab = 'hooks'">Hooks</button>
        <button type="button" role="tab" :aria-selected="tab === 'routing'" :class="{ on: tab === 'routing' }" @click="tab = 'routing'">Routing</button>
        <button type="button" role="tab" :aria-selected="tab === 'arsenal'" :class="{ on: tab === 'arsenal' }" @click="tab = 'arsenal'">Arsenal</button>
      </div>
    </header>

    <AgentHooks v-if="tab === 'hooks'" />
    <AgentRouting v-else-if="tab === 'routing'" />
    <AgentArsenal v-else-if="tab === 'arsenal'" />
    <div v-show="tab === 'net'" class="an-wrap">
      <section ref="box" class="an-main" aria-label="Agent network">
        <svg ref="svgEl" class="an-svg" :viewBox="`0 0 ${W} ${H}`" role="group" :aria-label="`Org chart of ${counts.all} agents`"
             @pointerdown="onDown($event)" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel">
          <g :transform="`translate(${view.x} ${view.y}) scale(${view.k})`">
            <g v-for="c in boxes" :key="c.id" class="an-cl" :class="{ dim: boxDim(c), sel: selCluster === c.id, arch: c.archived && !clusterWorking(c), staff: c.staff, temp: c.temp, live: clusterWorking(c) }"
               tabindex="0" role="button" :aria-label="`Team: ${c.label}, ${clusterStat(c)}`" @pointerdown.stop="onDown($event, c.id)" @keydown.enter="pickCluster(c.id)" @keydown.space.prevent="pickCluster(c.id)">
              <rect :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="14" />
              <text class="an-cl-t" :x="c.x + 20" :y="c.y + 24">{{ c.label }}</text>
              <text class="an-cl-s" :x="c.x + 20" :y="c.y + 41">{{ clusterStat(c) }}{{ c.archived ? " · history" : "" }}</text>
            </g>
            <path v-for="l in links" :key="l.a + '>' + l.b" :d="l.d" class="an-tl" :class="{ on: linkOn(l), live: linkLive(l) }" />
            <g><path v-for="p in peerLines" :key="p.o" :d="p.d" class="an-pl" /></g>
            <g class="an-hooks-l"><path v-for="h in hookNodes" :key="h.id" :d="h.d" class="an-hl" :class="{ off: !h.enabled, fire: hookFire.has(h.id) }" /></g>
            <g ref="flightsEl"></g>
            <g v-for="h in hookNodes" :key="h.id" class="an-hook" :class="{ off: !h.enabled, fire: hookFire.has(h.id), skip: hookSkip.has(h.id), live: h.live }" :transform="`translate(${h.x} ${h.y})`"
               tabindex="0" role="button" :aria-label="`Hook ${h.name}${h.enabled ? '' : ', off'}`" @pointerdown.stop @click="tab = 'hooks'" @keydown.enter="tab = 'hooks'" @keydown.space.prevent="tab = 'hooks'">
              <title>{{ hookSkip.has(h.id) ? `Skipped: ${hookSkip.get(h.id)} · ` : "" }}{{ h.name }} · {{ h.events.join(", ") }}{{ h.enabled ? "" : " (off)" }}{{ h.live ? "" : " · keeps no log, so it cannot light up live" }}</title>
              <rect class="an-hp" :x="-h.w / 2" :y="-h.h / 2" :width="h.w" :height="h.h" :rx="h.h / 2" />
              <path class="an-hg" :transform="`translate(${-h.w / 2 + 11} -6)`" d="M5 0v7.5a3 3 0 1 1-3-3" />
              <text class="an-hn" :x="-h.w / 2 + 24" y="4">{{ fitText(h.name, h.w - 44, 12.5) }}</text>
              <circle class="an-hd" :cx="h.w / 2 - 13" cy="0" r="3" />
            </g>
            <g v-for="n in simNodes" :key="n.id" class="an-node" :class="[status(n), n.kind, { temp: !!n.temp, sel: selNode === n.id, dim: nodeDim(n.id), pulse: pulse.has(n.id), sent: hot.has(n.id), arch: n.archived && status(n) !== 'working' }]"
               :transform="`translate(${n.x} ${n.y})`" tabindex="0" role="button" :aria-label="`${dn(n.id)}, ${sub(n)}`"
               @pointerdown.stop="onDown($event, n.id)" @pointerenter="hoverNode = n.id" @pointerleave="hoverNode = null" @keydown.enter="pickNode(n.id)" @keydown.space.prevent="pickNode(n.id)">
              <title>{{ tip(n) }}</title>
              <rect class="an-halo" :x="-n.w / 2 - 6" :y="-n.h / 2 - 6" :width="n.w + 12" :height="n.h + 12" :rx="n.kind === 'director' ? 18 : 15" />
              <rect class="an-ring" :x="-n.w / 2 - 3" :y="-n.h / 2 - 3" :width="n.w + 6" :height="n.h + 6" :rx="n.kind === 'director' ? 15 : 13" />
              <rect class="an-card" :x="-n.w / 2" :y="-n.h / 2" :width="n.w" :height="n.h" :rx="n.kind === 'director' ? 12 : 10" />
              <circle v-if="status(n) !== 'working'" class="an-sdot" :cx="-n.w / 2 + 15" :cy="n.kind === 'director' ? -7 : -6" r="4" />
              <g v-else class="an-act" :transform="`translate(${-n.w / 2 + 9} ${n.kind === 'director' ? -6 : -5})`" aria-hidden="true"><rect x="0" y="-5" width="3" height="10" rx="1.5" /><rect x="5" y="-5" width="3" height="10" rx="1.5" /><rect x="10" y="-5" width="3" height="10" rx="1.5" /></g>
              <text class="an-cn" :x="-n.w / 2 + 27" :y="n.kind === 'director' ? -2 : -2">{{ n.temp ? fitText(dn(n.id), n.w - 110, 13) : dn(n.id) }}</text>
              <text class="an-cr" :x="-n.w / 2 + 27" :y="n.kind === 'director' ? 18 : 17">{{ fitText(sub(n), n.w - 40 - (shareOf(n) !== null ? 56 : 0), 13) }}</text>
              <text v-if="shareOf(n) !== null" class="an-share" :x="n.w / 2 - 14" :y="n.kind === 'director' ? 18 : 17" text-anchor="end">{{ fmtShare(shareOf(n)!) }}</text>
              <text v-if="n.kind === 'agent'" class="an-tag" :class="status(n)" :x="n.w / 2 - 14" y="-3" text-anchor="end">{{ n.temp ? (n.temp.running ? "running" : n.temp.ended) : n.external && !n.info ? "" : status(n) }}</text>
            </g>
          </g>
        </svg>
        <div v-if="wins.length || usageV?.mode" class="an-usage" :class="usageV?.mode?.mode" role="status" :title="badgeTip" :aria-label="badgeTip">
          <span class="an-um"><i></i>{{ usageV?.mode?.mode ?? "usage" }}</span>
          <span v-for="w in wins" :key="w.key" class="an-uw num"><span class="an-ul">{{ winLabel(w.key) }}</span><b>{{ Math.round(w.pct) }}%</b><span class="an-ub" aria-hidden="true"><i :style="{ width: Math.min(100, w.pct) + '%' }"></i></span></span>
        </div>
        <div class="an-toasts" aria-hidden="true">
          <div v-for="t in toasts" :key="t.id" class="an-toast" :style="toastStyle(t.node)"><b>{{ t.from }}</b> {{ t.text }}</div>
        </div>
        <p v-if="loaded && !counts.all" class="an-empty">No agents yet.</p>
        <button type="button" class="an-msgs" :class="{ on: feedOpen, hid: panelOpen && !isPhone }" :aria-pressed="feedOpen" @click="feedOpen = !feedOpen">
          <Icon name="message" :size="14" /> Messages<span v-if="unreadCount" class="an-badge num" :aria-label="`${unreadCount} unread`">{{ unreadCount }}</span>
        </button>
        <div class="an-tools" :class="{ hid: panelOpen && !isPhone }">
          <button type="button" class="an-ic" aria-label="Zoom in" @click="zoomBtn(1.3)"><Icon name="plus" :size="15" /></button>
          <button type="button" class="an-ic" aria-label="Zoom out" @click="zoomBtn(1 / 1.3)"><Icon name="minus" :size="15" /></button>
          <button type="button" class="an-ic" aria-label="Fit" @click="fit()"><Icon name="maximize" :size="15" /></button>
        </div>
        <div class="an-foot">
          <button type="button" class="an-text" title="Replay the last 20 messages at double speed" @click="replay"><Icon name="play" :size="12" /> Replay last 20</button>
          <button type="button" class="an-text" :aria-pressed="history" title="Show finished teams and archived agents" @click="history = !history"><Icon name="history" :size="12" /> {{ history ? "Hide history" : "History" }}</button>
        </div>
      </section>

      <div v-if="sheetOpen" class="an-scrim" aria-hidden="true" @click="closePanel"></div>
      <aside ref="sideEl" class="an-side" :class="{ 'is-open': panelOpen && !isPhone, sheet: sheetOpen }" :inert="!panelOpen || undefined"
             :role="sheetOpen ? 'dialog' : undefined" :aria-modal="sheetOpen || undefined" aria-label="Details">
        <span v-if="sheetOpen" class="an-grab" aria-hidden="true"></span>
        <!-- one message in full -->
        <template v-if="selMsg">
          <div class="an-sh"><div class="an-st-t"><button type="button" class="an-lnk" @click="pickNode(nid(selMsg.from))">{{ dn(nid(selMsg.from)) }}</button><span class="an-arrow">→</span><button type="button" class="an-lnk" @click="pickNode(nid(selMsg.to))">{{ dn(nid(selMsg.to)) }}</button></div>
            <button type="button" class="an-ic" aria-label="Close" @click="closePanel"><Icon name="x" :size="15" /></button></div>
          <p class="an-meta num">{{ day(selMsg.at) }} {{ clock(selMsg.at) }}</p>
          <p class="an-full">{{ selMsg.body }}</p>
          <button type="button" class="an-text" @click="pickPair(pairKey(nid(selMsg.from), nid(selMsg.to)))">Show the whole conversation</button>
        </template>

        <!-- two agents: the thread between them, like a chat -->
        <template v-else-if="pairNames">
          <div class="an-sh">
            <div class="th-pair">
              <span class="th-avs"><span class="ag-av sm" :style="{ '--h': avatarOf(pairNames[0]).hue }">{{ avatarOf(pairNames[0]).text }}</span><span class="ag-av sm" :style="{ '--h': avatarOf(pairNames[1]).hue }">{{ avatarOf(pairNames[1]).text }}</span></span>
              <div><div class="an-st-t"><button type="button" class="an-lnk" @click="pickNode(pairNames[0])">{{ dn(pairNames[0]) }}</button><span class="an-arrow">⇄</span><button type="button" class="an-lnk" @click="pickNode(pairNames[1])">{{ dn(pairNames[1]) }}</button></div>
                <p class="an-meta num">{{ thread.length }} messages<template v-if="!connected(pairNames[0], pairNames[1])"> · off-chart</template></p></div>
            </div>
            <button type="button" class="an-ic" aria-label="Close" @click="closePanel"><Icon name="x" :size="15" /></button></div>
          <ol class="an-list th-msgs">
            <li v-for="m in thread" :key="m.id" class="tm" :class="{ new: fresh.has(m.id) }">
              <span class="ag-av sm" :style="{ '--h': avatarOf(nid(m.from)).hue }" aria-hidden="true">{{ avatarOf(nid(m.from)).text }}</span>
              <div class="tm-c">
                <div class="tm-h"><b>{{ dn(nid(m.from)) }}</b><span v-if="m.kind" class="chip" :style="{ '--h': KIND_HUE[m.kind] }">{{ m.kind }}</span><time class="num">{{ day(m.at) }} {{ clock(m.at) }}</time></div>
                <p class="tm-b">{{ m.body }}</p>
              </div>
            </li>
          </ol>
        </template>

        <!-- one team -->
        <template v-else-if="clusterInfo">
          <div class="an-sh"><div><div class="an-st-t">{{ clusterInfo.label }}</div><p class="an-meta">{{ clusterStat(clusterInfo) }}{{ clusterInfo.archived ? " · history" : "" }}</p></div>
            <button type="button" class="an-ic" aria-label="Close" @click="closePanel"><Icon name="x" :size="15" /></button></div>
          <div class="an-peers"><button v-for="id in clusterInfo.ids" :key="id" type="button" @click="pickNode(id)"><span><i class="an-sd" :class="status(N(id))"></i>{{ dn(id) }}</span><em>{{ sub(N(id)) }}</em></button></div>
        </template>

        <!-- one agent: who it is, then its live chat or its agmsg messages -->
        <template v-else-if="nodeInfo">
          <div class="ag-head">
            <span class="ag-av" :style="{ '--h': avatar(nodeInfo).hue }" aria-hidden="true">{{ avatar(nodeInfo).text }}<i class="ag-st" :class="status(nodeInfo)"></i></span>
            <div class="ag-id">
              <div class="ag-name">{{ dn(nodeInfo.id) }}<span v-if="instanceOf(nodeInfo)" class="ag-inst">{{ instanceOf(nodeInfo) }}</span></div>
              <p class="ag-sub">
                <span class="ag-state" :class="status(nodeInfo)">{{ status(nodeInfo) }}</span>
                <template v-if="nodeInfo.info?.project"> · <span class="mono">{{ projName(nodeInfo.info.project) }}</span></template>
                <template v-if="nodeInfo.info?.model"> · {{ modelLabel(nodeInfo.info.model) }}</template>
                <template v-if="since(nodeInfo.info?.startedAt) && !ended"> · up {{ since(nodeInfo.info?.startedAt) }}</template>
                <template v-if="nodeInfo.temp"> · started by {{ parentName(nodeInfo.temp.parent) }}</template>
              </p>
            </div>
            <button type="button" class="an-ic" aria-label="Close" @click="closePanel"><Icon name="x" :size="15" /></button>
          </div>
          <p v-if="!nodeInfo.temp && (nodeInfo.info?.job || (nodeInfo.kind !== 'director' && clusterOf(nodeInfo)))" class="ag-job">{{ nodeInfo.info?.job ?? clusterOf(nodeInfo) }}</p>
          <p v-if="doingNow && panelTab !== 'chat'" class="ag-now"><span class="ag-spin" aria-hidden="true"></span><span class="ag-now-t">{{ doingNow }}</span></p>
          <section v-if="chatTasks.length" class="ag-tasks" aria-label="Tasks">
            <button type="button" class="ag-th" :aria-expanded="tasksOpen" @click="tasksOpen = !tasksOpen">
              <span class="ag-tt">Tasks</span><span class="num ag-tc">{{ taskDone }}/{{ chatTasks.length }}</span>
              <span class="ag-bar" aria-hidden="true"><i :style="{ width: (taskDone / chatTasks.length) * 100 + '%' }"></i></span>
              <Icon name="chevron-down" :size="14" class="ag-chev" :class="{ shut: !tasksOpen }" />
            </button>
            <ul v-show="tasksOpen" class="ag-tl">
              <li v-for="t in chatTasks" :key="t.id" :class="t.status">
                <span v-if="t.status === 'in_progress'" class="ag-spin" role="img" aria-label="in progress"></span>
                <span v-else class="ag-ck" role="img" :aria-label="t.status === 'done' ? 'done' : 'to do'"><svg v-if="t.status === 'done'" viewBox="0 0 16 16" width="10" height="10"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
                <span class="ag-tx">{{ t.status === "in_progress" && t.active ? t.active : t.text }}</span>
              </li>
            </ul>
          </section>
          <div class="an-tabs ag-tabs" role="tablist" aria-label="Agent">
            <button type="button" role="tab" :aria-selected="panelTab === 'chat'" @click="panelTab = 'chat'" @keydown.right="panelTab = 'messages'">Chat</button>
            <button type="button" role="tab" :aria-selected="panelTab === 'messages'" @click="panelTab = 'messages'" @keydown.left="panelTab = 'chat'">Messages <span class="num ag-c">{{ nodeMsgs.length }}</span></button>
          </div>
          <div v-if="panelTab === 'chat'" class="ag-chat">
            <p v-if="chatState === 'loading'" class="an-meta ag-pad">Opening the session…</p>
            <p v-else-if="chatState === 'none'" class="an-meta ag-pad">No live session found for this agent.</p>
            <AgentFeed v-else :items="chatItems" :meta="chatMeta" :name="chatKey ?? ''" @messages="panelTab = 'messages'" />
          </div>
          <template v-else>
            <div class="an-tabs an-dir" role="group" aria-label="Direction">
              <button type="button" :aria-pressed="dirTab === 'all'" @click="dirTab = 'all'">all</button>
              <button type="button" :aria-pressed="dirTab === 'in'" @click="dirTab = 'in'">inbox</button>
              <button type="button" :aria-pressed="dirTab === 'out'" @click="dirTab = 'out'">outbox</button>
            </div>
            <p v-if="offChart" class="an-note2">{{ offChart }} off-chart {{ offChart === 1 ? "message" : "messages" }} (with agents outside its line)</p>
            <ol class="an-list">
              <li v-for="m in nodeShown" :key="m.id" class="tm" :class="{ new: fresh.has(m.id), off: !onChart(m) }">
                <span class="ag-av sm" :style="{ '--h': avatarOf(nid(m.from)).hue }" aria-hidden="true">{{ avatarOf(nid(m.from)).text }}</span>
                <div class="tm-c">
                  <div class="tm-h"><b>{{ dn(nid(m.from)) }}</b><span class="an-arrow">→</span><span>{{ dn(nid(m.to)) }}</span><span v-if="m.kind" class="chip" :style="{ '--h': KIND_HUE[m.kind] }">{{ m.kind }}</span><time class="num">{{ day(m.at) }} {{ clock(m.at) }}</time></div>
                  <p class="tm-b" :class="{ clamp: !expanded.has(m.id) }" @click="toggle(m.id)">{{ m.body }}</p>
                </div>
              </li>
              <li v-if="!nodeShown.length" class="an-meta">No messages.</li>
            </ol>
          </template>
        </template>

        <!-- default: the feed, one thread per pair, newest first -->
        <template v-else>
          <div class="fd-top">
            <div class="an-sh fd-h"><div class="an-st-t">Messages</div><button type="button" class="an-ic" aria-label="Close" @click="closePanel"><Icon name="x" :size="15" /></button></div>
            <label class="an-q"><Icon name="search" :size="14" /><input v-model="q" type="search" placeholder="Search messages" aria-label="Search messages" /></label>
            <div class="fd-f" role="group" aria-label="Filter by type">
              <button type="button" class="fchip" :aria-pressed="kindF === 'all'" @click="kindF = 'all'">All</button>
              <button v-for="[k, label] in KINDS" :key="k" type="button" class="fchip" :aria-pressed="kindF === k" :disabled="!kindCount[k]" :style="{ '--h': KIND_HUE[k] }" @click="kindF = kindF === k ? 'all' : k"><i></i>{{ label }}<span class="num">{{ kindCount[k] ?? 0 }}</span></button>
            </div>
          </div>
          <TransitionGroup tag="ol" name="th" class="an-list fd">
            <li v-for="t in threads" :key="t.key">
              <button type="button" class="th" :class="{ unread: unread.has(t.key), off: t.off }" @click="openThread(t.key)">
                <span class="th-avs"><span class="ag-av sm" :style="{ '--h': avatarOf(t.a).hue }">{{ avatarOf(t.a).text }}</span><span class="ag-av sm" :style="{ '--h': avatarOf(t.b).hue }">{{ avatarOf(t.b).text }}</span></span>
                <span class="th-c">
                  <span class="th-h"><b>{{ dn(t.a) }}</b><span class="an-arrow">→</span><span class="th-to">{{ dn(t.b) }}</span><time class="num">{{ ago(t.last.at) }}</time></span>
                  <span class="th-p">{{ preview(t.last.body) }}</span>
                  <span class="th-m"><span v-if="t.last.kind" class="chip" :style="{ '--h': KIND_HUE[t.last.kind] }">{{ t.last.kind }}</span><span class="num">{{ t.n }} {{ t.n === 1 ? "message" : "messages" }}</span><span v-if="t.off">· off-chart</span></span>
                </span>
                <i v-if="unread.has(t.key)" class="th-dot" aria-hidden="true"></i><span v-if="unread.has(t.key)" class="sr">unread</span>
              </button>
            </li>
            <li v-if="loaded && !threads.length" key="empty" class="an-meta fd-empty">{{ q || kindF !== "all" ? "Nothing matches." : "No messages yet." }}</li>
          </TransitionGroup>
        </template>
      </aside>
    </div>
  </main>
</template>

<style scoped>
/* One quiet palette: greys, hairlines, and a single accent (--on) for anything live. */
.an{--ac:var(--on);--hook:#f2b04a;--hair:rgba(255,255,255,.09);--soft:rgba(255,255,255,.05);gap:14px;min-height:0}
.an-head{display:flex;flex-direction:column;gap:10px}
.an-views{display:flex;gap:4px;padding:3px;border-radius:11px;background:var(--soft);align-self:flex-start}
.an-views button{min-height:32px;padding:0 14px;border-radius:8px;border:0;background:none;color:var(--muted);font:600 13px var(--body);cursor:pointer;transition:background .18s,color .18s}
.an-views button.on{background:rgba(255,255,255,.12);color:var(--ink)}
.an-views button:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
.an-title{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.an-title h1{font-size:22px;margin:0}
.an-live{display:inline-flex;align-items:center;gap:6px;font:500 12px var(--body);color:var(--muted)}
.an-live i{width:6px;height:6px;border-radius:50%;background:var(--ac)}
.an-live.off i{background:var(--warn)}
.an-sum{color:var(--muted);font:400 12.5px var(--body);margin-left:auto}
.num{font-variant-numeric:tabular-nums}
.an-tabs{display:flex;gap:2px;flex-wrap:wrap}
.an-tabs button{background:none;border:0;border-radius:6px;padding:5px 10px;color:var(--muted);font:500 13px var(--body);cursor:pointer;transition:color .15s var(--ease),background .15s var(--ease)}
.an-tabs button:hover{color:var(--ink)}
.an-tabs button[aria-pressed="true"],.an-tabs button[aria-selected="true"]{color:var(--ink);background:var(--soft)}
/* the map takes the whole area; the panel slides over it from the right */
.an-wrap{position:relative;flex:1 1 auto;height:calc(100dvh - 118px);min-height:480px}
.an-main{position:absolute;inset:0;min-width:0;border:1px solid var(--hair);border-radius:12px;overflow:hidden;background:var(--panel)}
.an-empty{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:var(--muted);font:400 13px var(--body);pointer-events:none}
.an-text{background:none;border:0;padding:4px 0;color:var(--muted);font:500 12px var(--body);cursor:pointer;text-align:left}.an-text:hover,.an-text[aria-pressed="true"]{color:var(--ink)}
.an-ic{display:inline-grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;background:none;color:var(--muted);cursor:pointer;padding:0}.an-ic:hover{color:var(--ink);background:var(--soft)}

/* chart */
.an-svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.an-svg:active{cursor:grabbing}
.an-tools{position:absolute;top:52px;right:10px;display:flex;flex-direction:column;gap:2px;opacity:.55;transition:opacity .2s}.an-tools:hover{opacity:1}
.an-msgs{position:absolute;top:10px;right:10px;z-index:2;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(23,24,27,.9);color:rgba(255,255,255,.82);font:500 12.5px var(--body);cursor:pointer;transition:background .15s var(--ease),border-color .15s var(--ease),opacity .2s}
.an-msgs:hover,.an-msgs.on{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2);color:var(--ink)}
.an-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--ac);color:#06130d;font:600 10.5px/18px var(--body);text-align:center}
.an-msgs.hid,.an-tools.hid{opacity:0;pointer-events:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:where(.an-ic,.an-text,.fchip,.th,.an-peers button,.an-msgs,.an-tabs button):focus-visible,.an-q:focus-within{outline:2px solid rgba(255,255,255,.7);outline-offset:2px}
.an-node:focus-visible .an-card,.an-cl:focus-visible rect{stroke:#fff;stroke-width:2}
.an-foot{position:absolute;left:0;right:0;bottom:0;padding:22px 14px 10px;display:flex;gap:18px;align-items:center;flex-wrap:wrap;background:linear-gradient(to bottom,transparent,var(--panel) 55%);pointer-events:none}.an-foot>*{pointer-events:auto}
.an-foot .an-text{display:inline-flex;align-items:center;gap:6px}
.an-cl{cursor:pointer;transition:opacity .2s var(--ease)}
.an-cl rect{fill:rgba(255,255,255,.03);stroke:rgba(255,255,255,.16);transition:stroke .2s var(--ease)}
.an-cl:hover rect,.an-cl.sel rect{stroke:rgba(255,255,255,.28)}
.an-cl.staff rect{stroke-dasharray:5 6}
.an-cl.live rect{stroke:rgba(47,211,138,.4);fill:rgba(47,211,138,.035)}
.an-cl.temp rect{stroke-dasharray:2 4;fill:transparent}
.an-node.temp .an-card{stroke-dasharray:3 4;fill:#141417}
.an-cl.arch{opacity:.72}
.an-cl.dim{opacity:.35}
.an-cl-t{fill:rgba(255,255,255,.95);font:600 14px var(--body);pointer-events:none}
.an-cl-s{fill:rgba(255,255,255,.7);font:400 13px var(--body);pointer-events:none;font-variant-numeric:tabular-nums}
.an-tl{fill:none;stroke:rgba(255,255,255,.4);stroke-width:1.6;stroke-linejoin:round;transition:stroke .2s var(--ease)}.an-tl.live{stroke:rgba(47,211,138,.7)}.an-tl.on{stroke:rgba(255,255,255,.9);stroke-width:2.2}
.an-pl{fill:none;stroke:rgba(255,255,255,.6);stroke-width:1.5;stroke-dasharray:3 4;pointer-events:none}
.an-node{cursor:pointer;outline:none;transition:opacity .2s var(--ease)}
.an-node.offline .an-card{fill:#131316;stroke:rgba(255,255,255,.2);stroke-dasharray:5 4}.an-node.offline .an-cn{fill:rgba(255,255,255,.74)}.an-node.offline .an-cr,.an-node.offline .an-tag{fill:rgba(255,255,255,.62)}
.an-node.dim{opacity:.25}
.an-node.arch{opacity:.75}
.an-card{fill:#1a1b1f;stroke:rgba(255,255,255,.24);stroke-width:1.25;transition:stroke .25s var(--ease)}
.an-node:hover .an-card,.an-node.sel .an-card,.an-node:focus-visible .an-card{stroke:rgba(255,255,255,.65)}
.an-node.pulse .an-card{stroke:var(--ac);animation:an-glow 1s var(--ease)}
.an-node.sent .an-card{stroke:rgba(47,211,138,.6)}
.an-ring,.an-halo{fill:none;stroke:transparent;stroke-width:1.5;pointer-events:none}
.an-halo{stroke-width:7}
/* working: a soft pulsing halo + ring in the accent colour and three moving bars where the status dot sits (opacity / transform only) */
.an-node.working .an-ring{stroke:var(--ac);opacity:.9}
.an-node.working .an-halo{stroke:var(--ac);opacity:.18;animation:an-halo 1.8s ease-in-out infinite}
.an-act rect{fill:var(--ac);transform-box:fill-box;transform-origin:center;animation:an-bar 0.9s ease-in-out infinite}
.an-act rect:nth-child(2){animation-delay:.15s}.an-act rect:nth-child(3){animation-delay:.3s}
@keyframes an-halo{0%,100%{opacity:.08}50%{opacity:.32}}
@keyframes an-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}
.an-hl{fill:none;stroke:rgba(242,176,74,.55);stroke-width:1.5;stroke-linecap:round;transition:stroke .3s,stroke-width .3s}
.an-hl.off{stroke:rgba(255,255,255,.2);stroke-dasharray:3 5}.an-hl.fire{stroke:var(--hook);stroke-width:2.8;stroke-dasharray:10 8;animation:an-flow .6s linear infinite}
@keyframes an-flow{to{stroke-dashoffset:-18}}
.an-hook{cursor:pointer;outline:none;transition:opacity .2s var(--ease)}
.an-hook.off{opacity:.8}.an-hook.off .an-hn{fill:rgba(255,255,255,.7)}
.an-hp{fill:#1d1a14;stroke:rgba(242,176,74,.7);stroke-width:1.3;transition:stroke .25s}
.an-hook:hover .an-hp,.an-hook:focus-visible .an-hp{stroke:var(--hook);stroke-dasharray:none}
.an-hook.fire .an-hp{stroke:var(--hook);stroke-dasharray:none;animation:an-glow 1.2s var(--ease)}
.an-hg{fill:none;stroke:var(--hook);stroke-width:1.8;stroke-linecap:round;pointer-events:none}
.an-hn{fill:rgba(255,255,255,.94);font:500 12.5px var(--mono);pointer-events:none}
.an-hd{fill:none;stroke:rgba(242,176,74,.85);stroke-width:1.4;pointer-events:none}.an-hook.live .an-hd{fill:var(--hook);stroke:none}.an-hook.skip{opacity:.75;transition:opacity .3s}.an-hook.fire .an-hd{filter:none;fill:#fff}
.an-node.director .an-card{stroke:rgba(255,255,255,.45);stroke-width:1.5}
.an-sdot{fill:none;stroke:rgba(255,255,255,.6);stroke-width:1.5}
.an-node.idle .an-sdot{fill:rgba(255,255,255,.75);stroke:none}
.an-node.working .an-sdot{fill:var(--ac);stroke:none}
.an-cn{fill:rgba(255,255,255,.96);font:600 14px var(--body);pointer-events:none}
.an-node.director .an-cn{font-size:16px}
.an-cr{fill:rgba(255,255,255,.7);font:400 13px var(--body);pointer-events:none}
.an-share{fill:rgba(255,255,255,.72);font:500 12px var(--mono);pointer-events:none;font-variant-numeric:tabular-nums}
.an-usage{position:absolute;left:12px;top:12px;z-index:3;display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:calc(100% - 150px);padding:6px 11px;border-radius:10px;background:rgba(20,20,23,.88);border:1px solid var(--hair);font:500 12px var(--body);color:var(--ink);pointer-events:auto}
.an-um{display:inline-flex;align-items:center;gap:6px;text-transform:capitalize;font-weight:600}
.an-um i{width:7px;height:7px;border-radius:50%;background:var(--ac)}
.an-usage.careful .an-um i{background:#e8c547}.an-usage.eco .an-um i{background:#f08a3c}.an-usage.reserve .an-um i{background:#ef5b5b}
.an-uw{display:inline-flex;align-items:center;gap:6px}.an-ul{color:var(--muted)}
.an-ub{width:34px;height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden}.an-ub i{display:block;height:100%;background:var(--ink);opacity:.75}
.an-tag{fill:rgba(255,255,255,.68);font:600 12px var(--body);pointer-events:none}.an-tag.working{fill:var(--ac)}
.an-toasts{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.an-toast{position:absolute;transform:translate(-50%,-100%);padding:5px 9px;border-radius:8px;background:rgba(14,14,17,.96);border:1px solid rgba(47,211,138,.45);color:rgba(255,255,255,.85);font:400 11.5px/1.35 var(--body);animation:an-toast 3s var(--ease) forwards}
.an-toast b{color:var(--ac);font-weight:500;margin-right:4px}

/* side panel */
.an-side{position:absolute;top:10px;right:10px;bottom:10px;z-index:5;width:min(400px,calc(100% - 20px));display:flex;flex-direction:column;gap:10px;min-height:0;overflow:hidden;padding:14px 16px;border-radius:14px;background:rgba(17,17,19,.97);border:1px solid rgba(255,255,255,.1);box-shadow:-24px 0 60px rgba(0,0,0,.45);transform:translateX(calc(100% + 24px));visibility:hidden;transition:transform .34s cubic-bezier(.2,.8,.2,1),visibility 0s .34s}
.an-side.is-open{transform:none;visibility:visible;transition:transform .34s cubic-bezier(.2,.8,.2,1)}
.fd-h{align-items:center}
.an-sh{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.an-st-t{font:600 15px var(--body);display:flex;align-items:center;gap:6px;flex-wrap:wrap;word-break:break-all}
.an-arrow{color:var(--muted)}
.an-meta{margin:0;color:var(--muted);font:400 12.5px var(--body);display:flex;align-items:center;gap:6px}
.an-note2{margin:0;color:var(--muted);font:400 12px var(--body)}
.an-sd{width:7px;height:7px;border-radius:50%;border:1.2px solid rgba(255,255,255,.35);flex:none;display:inline-block;box-sizing:border-box}.an-sd.idle{background:rgba(255,255,255,.75);border:0}.an-sd.working{background:var(--ac);border:0}
.an-full{margin:0;white-space:pre-wrap;word-break:break-word;font:400 13.5px/1.55 var(--body);overflow:auto;min-height:0;flex:0 1 auto}
.an-q{display:flex;align-items:center;gap:8px;color:var(--muted);border-bottom:1px solid var(--hair);padding:2px 0 8px;flex:none}
.an-q input{background:none;border:0;outline:none;color:var(--ink);font:400 13px var(--body);flex:1;min-width:0}
.an-kv{display:grid;gap:6px;margin:0}
.an-kv>div{display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:baseline}
.an-kv dt{color:var(--muted);font:400 12px var(--body)}.an-kv dd{margin:0;font:400 13px var(--body);word-break:break-word}
.mono{font-family:var(--mono)!important;font-size:12px!important}
.an-peers{display:flex;flex-direction:column;border-top:1px solid var(--hair)}
.an-peers button{display:flex;justify-content:space-between;gap:10px;background:none;border:0;border-bottom:1px solid var(--hair);padding:9px 0;color:var(--ink);font:500 13px var(--body);cursor:pointer;text-align:left}
.an-peers button span{display:inline-flex;align-items:center;gap:8px}
.an-peers em{font:400 12px var(--body);color:var(--muted);font-style:normal}.an-peers button:hover span{text-decoration:underline}
.an-dir{flex:none}
.an-list{list-style:none;margin:0;padding:0 4px 8px 0;overflow:auto;flex:1 1 0;min-height:100px;overscroll-behavior:contain}
.an-m{padding:10px 0;border-bottom:1px solid var(--hair)}
.an-m.off{opacity:.55}
.an-m.new .an-mh time{color:var(--ac)}
.an-mh{display:flex;align-items:center;gap:6px;font:400 12px var(--body);color:var(--muted);min-width:0}
.an-mh b{color:var(--ink);font-weight:500}.an-mh time{margin-left:auto;font:400 11px var(--mono);white-space:nowrap;color:rgba(255,255,255,.34)}
.an-lnk{background:none;border:0;padding:0;color:var(--ink);font:500 12.5px var(--body);cursor:pointer;text-align:left;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-st-t .an-lnk{font-size:15px;font-weight:600;white-space:normal}
.an-lnk.mute{color:var(--muted)}.an-lnk:hover{text-decoration:underline}
.an-mb{margin:4px 0 0;font:400 13px/1.45 var(--body);color:rgba(255,255,255,.82);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;word-break:break-word;white-space:pre-wrap}
.an-mb.open{-webkit-line-clamp:unset;display:block}

/* feed */
.fd-top{display:flex;flex-direction:column;gap:10px;flex:none}
.fd-f{display:flex;gap:6px;flex-wrap:wrap}
.fchip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--hair);background:none;color:var(--muted);font:500 12px var(--body);cursor:pointer;transition:color .15s var(--ease),border-color .15s var(--ease),background .15s var(--ease)}
.fchip i{width:6px;height:6px;border-radius:50%;background:hsl(var(--h) 65% 60%)}
.fchip span{font-size:11px;opacity:.7}
.fchip:hover:not(:disabled){color:var(--ink);border-color:rgba(255,255,255,.2)}
.fchip[aria-pressed="true"]{color:var(--ink);background:var(--soft);border-color:rgba(255,255,255,.22)}
.fchip:disabled{opacity:.35;cursor:default}
.fd{padding-top:2px}
.fd li{list-style:none}
.th{position:relative;display:flex;gap:12px;width:100%;padding:12px 8px 12px 6px;margin:0 -6px;border:0;border-radius:10px;background:none;text-align:left;cursor:pointer;color:inherit;transition:background .15s var(--ease)}
.th:hover{background:rgba(255,255,255,.035)}
.th.off{opacity:.6}
/* sender avatar, with the receiver as a small badge on its corner */
.th-avs{position:relative;flex:none;width:36px;height:36px}
.th-avs .ag-av:first-child{position:absolute;left:0;top:0;width:32px;height:32px;border-radius:10px;font-size:11.5px}
.th-avs .ag-av:last-child{position:absolute;right:-2px;bottom:-2px;width:18px;height:18px;border-radius:6px;font-size:7.5px;letter-spacing:0;box-shadow:0 0 0 2px #0e0e10}
.th-c{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.th-h{display:flex;align-items:baseline;gap:6px;min-width:0;font:400 13px var(--body);color:var(--muted)}
.th-h b{color:var(--ink);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.th-to{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.th-h time{margin-left:auto;flex:none;font:400 11px var(--mono);color:rgba(255,255,255,.55)}
.th-p{font:400 13px/1.45 var(--body);color:rgba(255,255,255,.7);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.th.unread .th-p{color:rgba(255,255,255,.92)}
.th-m{display:flex;align-items:center;gap:8px;font:400 11.5px var(--body);color:rgba(255,255,255,.55);margin-top:2px}
.th-dot{position:absolute;right:8px;top:36px;width:7px;height:7px;border-radius:50%;background:var(--ac);box-shadow:0 0 0 3px rgba(47,211,138,.15)}
.chip{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font:500 10.5px var(--body);letter-spacing:.02em;text-transform:capitalize;color:hsl(var(--h) 70% 72%);background:hsl(var(--h) 45% 50% / .13)}
.th-enter-active{transition:transform .35s cubic-bezier(.2,.8,.2,1),opacity .35s var(--ease)}
.th-enter-from{transform:translateX(18px);opacity:0}
.th-move{transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.th-leave-active{display:none}
.fd-empty{padding:16px 0}
.th-pair{display:flex;gap:12px;align-items:center;min-width:0}
.th-msgs{padding-top:4px}
.tm{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.tm.new{animation:an-in .35s var(--ease)}
.tm-c{flex:1;min-width:0}
.tm-h{display:flex;align-items:center;gap:8px;font:400 12px var(--body);color:var(--muted)}
.tm-h b{color:var(--ink);font:500 13px var(--body)}
.tm-h time{margin-left:auto;font:400 11px var(--mono);color:rgba(255,255,255,.55)}
.tm-b{margin:4px 0 0;font:400 13.5px/1.5 var(--body);color:rgba(255,255,255,.86);white-space:pre-wrap;word-break:break-word}
.tm.off{opacity:.55}
.tm-b.clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.ag-av.sm{width:26px;height:26px;border-radius:8px;font-size:10.5px}
@keyframes an-in{from{opacity:0;transform:translateY(6px)}}
/* agent panel */
.ag-head{display:flex;align-items:flex-start;gap:12px}
.ag-av{position:relative;flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font:600 14px var(--body);letter-spacing:.02em;color:hsl(var(--h) 70% 82%);background:hsl(var(--h) 40% 18%);border:1px solid hsl(var(--h) 40% 28%)}
.ag-st{position:absolute;right:-3px;bottom:-3px;width:11px;height:11px;border-radius:50%;background:var(--panel);border:2px solid var(--bg,#0b0b0d);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.35)}
.ag-st.idle{background:rgba(255,255,255,.8);box-shadow:none}.ag-st.working{background:var(--ac);box-shadow:none}
.ag-id{flex:1;min-width:0}
.ag-name{font:600 15.5px/1.3 var(--body);color:var(--ink);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;word-break:break-all}
.ag-inst{font:500 11px var(--mono);color:var(--muted);letter-spacing:.02em}
.ag-sub{margin:3px 0 0;color:var(--muted);font:400 12.5px/1.45 var(--body)}
.ag-state{color:rgba(255,255,255,.75)}.ag-state.working{color:var(--ac)}.ag-state.offline{color:var(--muted)}
.ag-job{margin:0;font:400 13px/1.45 var(--body);color:rgba(255,255,255,.78)}
.ag-tasks{border:1px solid var(--hair);border-radius:10px;background:var(--soft);overflow:hidden;flex:none}
.ag-th{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:0 12px;background:none;border:0;color:var(--ink);cursor:pointer;text-align:left}
.ag-tt{font:600 12.5px var(--body)}.ag-tc{font:500 12px var(--body);color:var(--muted)}
.ag-bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden;min-width:30px}
.ag-bar i{display:block;height:100%;background:var(--ac);transform-origin:left;transition:width .35s cubic-bezier(.2,.8,.2,1)}
.ag-chev{color:var(--muted);transition:transform .2s}.ag-chev.shut{transform:rotate(-90deg)}
.ag-tl{list-style:none;margin:0;padding:2px 12px 10px;display:flex;flex-direction:column;gap:7px;max-height:200px;overflow:auto}
.ag-tl li{display:flex;align-items:flex-start;gap:9px;font:400 12.5px/1.4 var(--body);color:var(--muted);min-width:0}
.ag-tl li.in_progress{color:var(--ink);font-weight:600}
.ag-tl li.done .ag-tx{text-decoration:line-through;text-decoration-color:rgba(255,255,255,.3)}
.ag-tl .ag-spin{margin-top:3px}
.ag-ck{flex:none;width:14px;height:14px;margin-top:1px;border-radius:50%;border:1.5px solid rgba(255,255,255,.28);display:inline-flex;align-items:center;justify-content:center;color:#06140d;transition:background .2s,border-color .2s}
.ag-tl li.done .ag-ck{background:var(--ac);border-color:var(--ac)}
.ag-tx{min-width:0;overflow-wrap:anywhere}
.ag-now{margin:0;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:rgba(47,211,138,.07);border:1px solid rgba(47,211,138,.18);font:400 12.5px var(--body);color:rgba(255,255,255,.85);min-width:0}
.ag-now-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ag-spin{flex:none;width:10px;height:10px;border-radius:50%;border:1.5px solid rgba(47,211,138,.35);border-top-color:var(--ac);animation:ag-spin .9s linear infinite}
.ag-tabs{flex:none;border-bottom:1px solid var(--hair);padding-bottom:8px}
.ag-c{color:var(--muted);font-size:11px;margin-left:2px}
.ag-chat{flex:1 1 0;min-height:0;display:flex;flex-direction:column;margin:0 -6px}
.ag-chat :deep(.bf-in){padding:10px 6px 16px;gap:12px;max-width:none}
.ag-chat :deep(.bb){font-size:13.5px;padding:9px 12px}
.ag-chat :deep(.bm){max-width:94%}.ag-chat :deep(.bm.me){max-width:88%}
.ag-pad{padding:14px 6px}
/* phone: the details become a bottom sheet over the chart */
.an-scrim{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);animation:an-fade .2s var(--ease)}
.an-side.sheet{position:fixed;left:0;right:0;bottom:0;z-index:61;height:82dvh;padding:10px 16px calc(12px + env(safe-area-inset-bottom));background:#121214;border-top:1px solid rgba(255,255,255,.1);border-radius:18px 18px 0 0;box-shadow:0 -20px 50px rgba(0,0,0,.5);animation:an-up .32s cubic-bezier(.2,.8,.2,1)}
.an-side.sheet .an-list{max-height:none;flex:1 1 0}
.an-grab{align-self:center;width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);flex:none;margin-bottom:4px}
@keyframes ag-spin{to{transform:rotate(360deg)}}
@keyframes an-up{from{transform:translateY(100%)}}
@keyframes an-fade{from{opacity:0}}
@keyframes an-glow{from{stroke-width:3.5}to{stroke-width:1}}
@keyframes an-breathe{0%,100%{opacity:.25}50%{opacity:.75}}
@keyframes an-toast{0%{opacity:0;margin-top:6px}10%{opacity:1;margin-top:0}85%{opacity:1}100%{opacity:0}}
@media(max-width:900px){
  .an-wrap{height:calc(100dvh - 190px);min-height:420px}
  .an-side:not(.sheet){display:none}
  .an-side.sheet{visibility:visible;transform:none;width:auto;top:auto;right:0;transition:none}
  .an-sum{margin-left:0;width:100%}
}
@media(prefers-reduced-motion:reduce){.an-side,.an-cl{transition:none!important}.th-enter-active,.th-move,.tm.new{transition:none;animation:none}.an-side.sheet,.an-scrim,.ag-spin{animation:none}.an-toast{animation:none}.an-node.pulse .an-card,.an-hook.fire .an-hp{animation:none}.an-node.working .an-halo{animation:none;opacity:.2}.an-act rect{animation:none}.an-act rect:nth-child(1){transform:scaleY(.5)}.an-act rect:nth-child(3){transform:scaleY(.75)}.an-tl,.an-node,.an-tabs button{transition:none}.an-hl.fire{animation:none}}
</style>
