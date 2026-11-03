// Demo mode (SERVER_OS_DEMO=1): a made-up voice-assistant conversation for the Voice page's chat, with web research,
// source cards, a card, a table and a chart, and a tiny fake turn loop so sending (typed or spoken) shows the whole flow.
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "./core/http";

type Item = Record<string, unknown> & { id: string; kind: string; ts: number };
const t0 = Date.now();
const at = (s: number) => t0 - s * 1000;
const LINKS = [
  { title: "Ghent: a guide to the city of flowers and towers", url: "https://visit.gent.be/en" },
  { title: "Bruges in winter: Christmas market, canals and museums", url: "https://www.visitbruges.be/en/winter" },
  { title: "Antwerp weekend: what to see in 48 hours", url: "https://www.visitantwerpen.be/en/48-hours" },
  { title: "Eurostar & NS International: Amsterdam to Belgium timetable", url: "https://www.nsinternational.com/en/trains-to-belgium" },
];
const items: Item[] = [
  { id: "v1", kind: "user", ts: at(900), text: "[Chat] Where can we go for a weekend by train in November, max three hours from Amsterdam?", via: "dash" },
  { id: "v2", kind: "step", ts: at(896), tool: "WebSearch", title: "Searched the web", detail: "weekend city trip by train from Amsterdam November under 3 hours", status: "ok", ms: 4200,
    sources: LINKS.map((l) => ({ ...l, domain: new URL(l.url).hostname.replace(/^www\./, "") })), summary: "Ghent, Bruges and Antwerp are all reachable in under three hours, with direct trains from Amsterdam Centraal." },
  { id: "v3", kind: "step", ts: at(890), tool: "WebFetch", title: "Fetched a page", detail: "https://www.nsinternational.com/en/trains-to-belgium", status: "ok", ms: 1800,
    sources: [{ title: "nsinternational.com", url: "https://www.nsinternational.com/en/trains-to-belgium", domain: "nsinternational.com", snippet: "Direct Eurocity Direct trains run every hour from Amsterdam Centraal to Antwerp and Brussels." }] },
  { id: "v4", kind: "assistant", ts: at(884), via: "terminal", text: [
    "Three good picks, all direct or with one easy change. **Antwerp** is the quickest, **Ghent** the best all-rounder, and **Bruges** is the prettiest in winter.",
    "",
    "| City | Train | From | Best for |",
    "|---|---:|---:|---|",
    "| Antwerp | 1 h 15 | €29 | fashion, food, the station itself |",
    "| Ghent | 2 h 10 | €35 | canals, castle, student buzz |",
    "| Bruges | 2 h 50 | €39 | Christmas market, quiet canals |",
    "",
    "```card",
    JSON.stringify({ title: "Ghent", subtitle: "Belgium · 2 h 10 by train", badge: "Top pick", body: "Medieval centre without the crowds. The Christmas market opens on 4 December.", url: "https://visit.gent.be/en",
      fields: [{ label: "Trains", value: "every hour" }, { label: "Weekend price", value: "from €35" }, { label: "Weather", value: "7 °C, some rain" }] }, null, 1),
    "```",
    "",
    "```chart",
    JSON.stringify({ type: "bar", title: "Train time from Amsterdam", unit: "min", labels: ["Antwerp", "Ghent", "Bruges"], series: [{ name: "Fastest", values: [75, 130, 170] }] }),
    "```",
    "",
    "```sources",
    JSON.stringify([{ title: "Visit Ghent", url: "https://visit.gent.be/en", snippet: "What's on in Ghent this winter." }]),
    "```",
  ].join("\n") },
  { id: "v5", kind: "user", ts: at(300), text: "[Voice] And how cold does it get there in November?", via: "dash" },
  { id: "v6", kind: "assistant", ts: at(292), via: "terminal", text: "Around seven degrees in the day and close to freezing at night. Bring a warm coat and an umbrella, it rains about half the days." },
];
const REPLIES = [
  "Sure. I checked the trains: the next direct one leaves at ten past the hour and takes about two hours.",
  "Here is what I found.\n\n```sources\n" + JSON.stringify(LINKS.slice(0, 2)) + "\n```\n\nBoth are open on Sunday.",
];
// TV fixtures (docs/voice-chat.md "Demo"): a message naming a component ("weather", "timer", …) gets a TV-style answer
// with that block, so every widget can be looked at (and screenshotted) without a real assistant. "slow" thinks 20 s.
const B = (lang: string, o: unknown) => "\n\n```" + lang + "\n" + JSON.stringify(o) + "\n```";
const TV: Record<string, string> = {
  weather: "Mild and grey this afternoon, about thirteen degrees, with rain from six. The weekend looks drier." + B("weather", { place: "Utrecht", unit: "C",
    now: { temp: 13, summary: "Cloudy", icon: "cloud", feels: 11 }, high: 14, low: 8, rain: 40, wind: "SW 18 km/h",
    hours: [{ label: "16:00", temp: 13, icon: "cloud", rain: 10 }, { label: "17:00", temp: 12, icon: "cloud", rain: 20 }, { label: "18:00", temp: 12, icon: "rain", rain: 70 },
      { label: "19:00", temp: 11, icon: "rain", rain: 80 }, { label: "20:00", temp: 10, icon: "drizzle", rain: 40 }, { label: "21:00", temp: 10, icon: "night", rain: 10 }],
    days: [{ label: "Fri", high: 12, low: 7, icon: "rain", rain: 60 }, { label: "Sat", high: 14, low: 8, icon: "partly", rain: 10 }, { label: "Sun", high: 15, low: 9, icon: "sun", rain: 0 }] }),
  timer: "Timer set for ten minutes. I'll show it here." + B("timer", { label: "Pasta", seconds: 600 }),
  home: "The living room lights and the TV plug are on, the heating is at twenty degrees and the front door is locked." + B("home", { title: "Living room",
    items: [{ name: "Ceiling", type: "light", state: "On · 70%" }, { name: "Floor lamp", type: "light", state: "off" }, { name: "TV plug", type: "plug", state: "on" },
      { name: "Heating", type: "climate", state: "heat", area: "20 °C" }, { name: "Front door", type: "lock", state: "Locked", on: false }, { name: "Air purifier", type: "fan", state: "on" }] }),
  media: "On the living room Sonos: Bohemian Rhapsody by Queen, about halfway through." + B("media", { title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera",
    source: "Sonos · Living room", state: "playing", position: 171, duration: 355 }),
  image: "Here is the Dom Tower in Utrecht, about a hundred and twelve metres tall." + B("image", { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Domtoren_Utrecht_-_1.jpg/1280px-Domtoren_Utrecht_-_1.jpg",
    caption: "Dom Tower, Utrecht", credit: "Wikimedia Commons, CC BY-SA" }),
  steps: "Four steps. Boil the water, salt it, cook the pasta for nine minutes, then save a cup of the water before you drain it." + B("steps", { title: "Pasta for four",
    items: [{ title: "Boil four litres of water", done: true }, { title: "Add a big spoon of salt" }, { title: "Cook 400 g of pasta", detail: "9 minutes, stir now and then" }, { title: "Save a cup of the water", detail: "it makes the sauce silky" }] }),
  stat: "Your portfolio is up one point two percent today, at about forty-two thousand euros." + B("stat", [{ label: "Portfolio", value: "€42,180", delta: "+1.2% today", trend: "up" },
    { label: "Cash", value: "€3,400", note: "ready to invest" }, { label: "Best today", value: "ASML", delta: "+3.4%", trend: "up" }]),
  compare: "The XC60 is the better all-rounder: more room and a cheaper tax bill. The CX-60 is quicker." + B("compare", { title: "XC60 or CX-60", items: ["Volvo XC60", "Mazda CX-60"], pick: 0,
    rows: [{ label: "Power", values: ["350 hp", "327 hp"] }, { label: "0–100", values: ["5.9 s", "5.8 s"] }, { label: "Electric range", values: ["~50 km", "~60 km"] },
      { label: "Boot", values: ["483 l", "477 l"] }, { label: "Road tax", values: ["€118 / q", "€141 / q"] }] }),
  agenda: "Two things today: Sam's check-up at the consultatiebureau at half past ten, and dinner with Alex's parents at seven." + B("agenda", { title: "Today",
    items: [{ time: "10:30", title: "Sam: check-up", where: "Consultatiebureau", detail: "bring the groeiboekje" }, { time: "14:00", title: "Call the garage", detail: "winter tyres" },
      { time: "19:00", title: "Dinner with Alex's parents", where: "Utrecht" }, { day: "Tomorrow", time: "09:00", title: "Bin day", detail: "paper" }] }),
  card: "Ghent is the best weekend pick: two hours by train, a castle in the centre and a Christmas market from December." + B("card", { title: "Ghent", subtitle: "Belgium · 2 h 10 by train", badge: "Top pick",
    body: "Medieval centre without the crowds.", fields: [{ label: "Trains", value: "every hour" }, { label: "From", value: "€35" }, { label: "Weather", value: "7 °C" }] }),
  chart: "Electricity use is down this week, about eight kilowatt hours a day." + B("chart", { type: "bar", title: "Electricity this week", unit: "kWh", labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], series: [{ name: "Use", values: [9.1, 8.4, 7.9, 8.2, 7.6, 10.3, 6.8] }] }),
  broken: "This answer has a block that isn't valid JSON, so the TV leaves it out." + "\n\n```weather\n{\"place\": \"Utrecht\", now: oops\n```",
  plain: "It's a quarter to five on Thursday, the twenty-ninth of October. Sunset is at ten past five.",
};
const TV_ASK: [string, RegExp][] = [["broken", /\bbroken\b/i], ["weather", /\b(weather|rain|cold)\b/i], ["timer", /\btimer\b/i], ["home", /\b(home|lights?)\b/i], ["media", /\b(media|playing|music)\b/i],
  ["image", /\b(image|photo|picture)\b/i], ["steps", /\b(steps|how do i|cook)\b/i], ["stat", /\b(stat|portfolio)\b/i], ["compare", /\b(compare|versus|vs)\b/i],
  ["agenda", /\b(agenda|calendar|today)\b/i], ["card", /\bcard\b|\bweekend trip\b/i], ["chart", /\b(chart|electricity)\b/i], ["plain", /\b(plain|time)\b/i]];
const tvReply = (text: string) => { const k = TV_ASK.find(([, re]) => re.test(text)); return k ? TV[k[0]] : null; };
let working: { since: number; step: string | null } | null = null;
const subs = new Set<(kind: "items" | "meta", data: unknown) => void>();
const meta = () => ({ session: { session: "demo-voice", model: "claude-opus-5-5", contextTokens: 52_000, contextLimit: 200_000, permissionMode: "default", working, lastActivity: Date.now() },
  effort: null, launchModel: "opus", jobs: [], schedules: [], requests: [], approvals: [], running: true, protected: true, tmux: true });
const push = (list: Item[]) => { for (const f of subs) f("items", list); };
const pushMeta = () => { for (const f of subs) f("meta", meta()); };
let n = 0;
let timers: ReturnType<typeof setTimeout>[] = [];

export function demoVoiceRoutes(api: Hono<Env>) {
  api.get("/bots/voice/feed", (c) => streamSSE(c, async (stream) => {
    const q: [string, unknown][] = [];
    let wake: (() => void) | null = null;
    const f = (k: string, d: unknown) => { q.push([k, d]); wake?.(); };
    subs.add(f); stream.onAbort(() => { subs.delete(f); wake?.(); });
    await stream.writeSSE({ event: "reset", data: JSON.stringify({ items, meta: meta() }) });
    while (!stream.aborted) {
      if (!q.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (q.length) { const [k, d] = q.shift()!; await stream.writeSSE({ event: k, data: JSON.stringify(d) }); }
      await stream.writeSSE({ event: "ping", data: "" });
    }
    subs.delete(f);
  }));
  api.post("/bots/voice/send", async (c) => {
    const j = await c.req.json().catch(() => ({})) as { text?: string; nonce?: string };
    const text = String(j.text ?? "").trim();
    if (!text) return c.json({ ok: false }, 400);
    const u: Item = { id: `du${++n}`, kind: "user", ts: Date.now(), text, via: "dash", ...(j.nonce ? { nonce: j.nonce } : {}) };
    items.push(u); push([u]);
    working = { since: Date.now(), step: null }; pushMeta();
    const s: Item = { id: `ds${n}`, kind: "step", ts: Date.now() + 600, tool: "WebSearch", title: "Searched the web", detail: text.replace(/^\[[^\]]+\]\s*/, "").slice(0, 80), status: "running" };
    timers.push(setTimeout(() => { items.push(s); push([s]); working = { since: working?.since ?? Date.now(), step: s.title as string }; pushMeta(); }, 600));
    const slow = /\bslow\b/i.test(text), fixture = tvReply(text);
    timers.push(setTimeout(() => {
      const done = { ...s, status: "ok", ms: 1600, sources: fixture ? [] : LINKS.slice(1, 3).map((l) => ({ ...l, domain: new URL(l.url).hostname.replace(/^www\./, "") })) };
      items[items.indexOf(s)] = done;
      const a: Item = { id: `da${n}`, kind: "assistant", ts: Date.now(), via: "terminal", text: fixture ?? REPLIES[n % REPLIES.length] };
      items.push(a); working = null; push([done, a]); pushMeta();
    }, slow ? 20_000 : 2800));
    return c.json({ ok: true, detail: "Sent" });
  });
  api.post("/bots/voice/interrupt", (c) => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    const e: Item = { id: `de${++n}`, kind: "event", ts: Date.now(), text: "Interrupted" };
    items.push(e); working = null; push([e]); pushMeta();
    return c.json({ ok: true, stopped: true, detail: "Stopped" });
  });
  api.get("/bots/voice/sessions", (c) => c.json([]));
}
