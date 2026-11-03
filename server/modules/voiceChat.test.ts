import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript, webSources } from "./bots/transcript";
import { speakable } from "./voice";
import { ClipStore, MicHub, assistantName, cleanTranscript, pickSpeakers, playPayload, voiceLanguage, wav } from "./voiceChat";
import { pickNext } from "../../web/src/chat/dpad";
import { activity, asChart, asWidget, plainText, segments, stripPrefix, turnSources, turns, voicePrefix, wxIcon, type FeedLike } from "../../web/src/chat/blocks";

const T = (s: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, s)).toISOString();
const L = (o: object) => JSON.stringify(o) + "\n";
const SEARCH = 'Web search results for query: "trains"\n\nLinks: [{"title":"Ghent guide","url":"https://www.visit.gent.be/en"},{"title":"","url":"https://example.org/x"},{"title":"dupe","url":"https://www.visit.gent.be/en"},{"title":"bad","url":"javascript:alert(1)"}]\n\nGhent is **two hours** away.\n\nREMINDER: You MUST include the sources';

test("web search results become source cards with the summary", () => {
  const r = webSources("WebSearch", "trains", SEARCH)!;
  expect(r.sources).toEqual([
    { title: "Ghent guide", url: "https://www.visit.gent.be/en", domain: "visit.gent.be" },
    { title: "example.org", url: "https://example.org/x", domain: "example.org" },
  ]);
  expect(r.summary).toBe("Ghent is **two hours** away.");
  expect(webSources("WebFetch", "https://a.com/p", "**Answer**\nThe page says hi.")!.sources[0]).toEqual({ title: "a.com", url: "https://a.com/p", domain: "a.com", snippet: "Answer" });
  expect(webSources("WebFetch", "https://a.com/p", "The server returned HTTP 403 Forbidden.\n\nThe response body…")!.sources[0].error).toBe("The server returned HTTP 403 Forbidden.");
  expect(webSources("Bash", "", "x")).toBeNull();
});

test("transcript → chat turns: prefixes, work, sources, several replies", () => {
  const d = mkdtempSync(join(tmpdir(), "sd-vc-")); const p = join(d, "s.jsonl");
  writeFileSync(p,
    L({ type: "user", uuid: "u1", timestamp: T(0), message: { role: "user", content: "[Voice tr] hava nasıl?" } }) +
    L({ type: "assistant", uuid: "a1", timestamp: T(1), message: { role: "assistant", content: [{ type: "text", text: "Bakıyorum." }, { type: "tool_use", id: "w1", name: "WebSearch", input: { query: "hava" } }] } }) +
    L({ type: "user", uuid: "r1", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: SEARCH }] } }) +
    L({ type: "assistant", uuid: "a2", timestamp: T(4), message: { role: "assistant", content: [{ type: "text", text: "Güneşli.\n\n```sources\n[{\"title\":\"Extra\",\"url\":\"https://extra.com\"}]\n```" }] } }) +
    L({ type: "user", uuid: "u2", timestamp: T(9), message: { role: "user", content: "[Chat] thanks" } }) +
    L({ type: "user", uuid: "i1", timestamp: T(10), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
  const t = new Transcript(p); t.update();
  const tv = turns(t.items as FeedLike[]);
  expect(tv.map((x) => x.type)).toEqual(["user", "assistant", "user", "event"]);
  expect(tv[0]).toMatchObject({ text: "hava nasıl?", mode: "voice", lang: "tr" });
  const a = tv[1] as Extract<ReturnType<typeof turns>[number], { type: "assistant" }>;
  expect(a.replies.map((r) => r.text?.slice(0, 9))).toEqual(["Bakıyorum", "Güneşli.\n"]);
  expect(a.steps[0]).toMatchObject({ tool: "WebSearch", status: "ok" });
  expect(a.sources.map((s) => s.domain)).toEqual(["visit.gent.be", "example.org", "extra.com"]);
  expect(a.after).toBe("u1");
  expect(tv[2]).toMatchObject({ mode: "chat", text: "thanks" });
});

test("prefixes and the activity line", () => {
  expect(stripPrefix("plain")).toEqual({ text: "plain", mode: null, lang: null });
  expect(voicePrefix("tr")).toBe("[Voice tr] ");
  expect(voicePrefix("en")).toBe("[Voice] ");
  expect(activity({ id: "s", kind: "step", ts: 0, tool: "WebSearch", detail: "weekend trains", status: "running" }, { step: "Searched the web" })).toBe("Searching the web for “weekend trains”…");
  expect(activity({ id: "s", kind: "step", ts: 0, tool: "WebFetch", detail: "https://www.ns.nl/x", status: "running" }, { step: "x" })).toBe("Reading ns.nl…");
  expect(activity(null, { step: null })).toBe("Thinking…");
  expect(activity(null, null)).toBeNull();
});

test("component blocks parse, and bad ones fall back to code", () => {
  const s = segments("Intro **bold**\n\n```card\n{\"title\":\"Ghent\",\"url\":\"javascript:x\",\"fields\":[{\"label\":\"Train\",\"value\":130}]}\n```\nmid\n```chart\n{\"labels\":[\"a\",\"b\"],\"series\":[{\"name\":\"n\",\"values\":[1,\"x\"]}]}\n```\n```card\nnot json\n```\n```ts\nconst a = 1\n```\n```sources\n[{\"url\":\"https://x.com\"}]");
  expect(s.map((x) => x.type)).toEqual(["md", "card", "md", "chart", "code", "code", "sources"]);
  expect(s[1]).toMatchObject({ card: { title: "Ghent", url: undefined, fields: [{ label: "Train", value: "130" }] } });
  expect(s[3]).toMatchObject({ chart: { type: "bar", series: [{ values: [1, null] }] } });
  expect(s[4]).toMatchObject({ lang: "card", code: "not json" });
  expect(s[6]).toMatchObject({ sources: [{ url: "https://x.com/", domain: "x.com", title: "x.com" }] }); // an unclosed block at the end still counts
  expect(asChart({ labels: [], series: [] })).toBeNull();
  expect(plainText("Hi\n```card\n{\"title\":\"x\"}\n```\nBye")).toBe("Hi\n\nBye");
  expect(turnSources([{ id: "s", kind: "step", ts: 0, sources: [{ title: "a", url: "https://a.com/", domain: "a.com" }, { title: "b", url: "https://b.com", domain: "b.com", error: "HTTP 403" }] }],
    [{ id: "r", kind: "assistant", ts: 0, text: "```sources\n[{\"url\":\"https://a.com\"}]\n```" }]).map((x) => x.domain)).toEqual(["a.com"]);
});

test("speech skips component blocks, code, tags and table rules", () => {
  const text = "Three picks.\n\n| City | Train |\n|---|---:|\n| Ghent | 2 h |\n\n```card\n{\"title\":\"Ghent\"}\n```\n<details><summary>more</summary>x</details>Bye.\n```chart\n{\"labels\":[";
  expect(speakable(text)).toBe("Three picks.\n\nCity, Train.\nGhent, 2 h.\n\nBye.");
  expect(speakable("3 < 5 and 6 > 2")).toBe("3 < 5 and 6 2");
});

test("whisper output is cleaned", () => {
  expect(cleanTranscript("  [BLANK_AUDIO]\n Hello   there (music) ")).toBe("Hello there");
  expect(cleanTranscript("[ Silence ]")).toBe("");
});

test("language follows the voice unless set", () => {
  expect(voiceLanguage("tr-hasan", "")).toBe("tr");
  expect(voiceLanguage("af_heart", null)).toBe("en");
  expect(voiceLanguage("af_heart", "auto")).toBe("auto");
});

test("assistant name comes from config, then the instructions heading", () => {
  const d = mkdtempSync(join(tmpdir(), "sd-vn-"));
  writeFileSync(join(d, "CLAUDE.md"), "intro\n# Ada — voice session\n");
  expect(assistantName(d, undefined)).toBe("Ada");
  expect(assistantName(d, "Nova")).toBe("Nova");
  expect(assistantName(null, undefined)).toBe("Assistant");
});

test("mic sessions: phone states reach the chat, silent phones are gone", () => {
  const h = new MicHub(1000);
  const id = h.create(0);
  const seen: string[] = [];
  const off = h.listen(id, (e) => seen.push(e.type === "phone" ? e.state : e.type));
  expect(h.phone(id, "connected", "iPhone", 10)).toBe(true);
  h.emit(id, { type: "transcript", id: "x", text: "hi", language: "en", at: 1 });
  h.sweep(60_000);
  expect(seen).toEqual(["connected", "transcript", "gone"]);
  expect(h.get(id, 60_000)).not.toBeNull(); // still listened to
  off(); h.sweep(120_000);
  expect(h.get(id, 120_000)).toBeNull();
  expect(h.phone("nope", "connected")).toBe(false);
});

test("mic sessions: an app finds the TV's session, answers come back to the phone", () => {
  const h = new MicHub(1000);
  const a = h.create(0, "TV"), b = h.create(5, "Browser");
  expect(h.list(10)).toEqual([]); // nobody shows them yet
  const offA = h.listen(a, () => {}); h.listen(b, () => {});
  expect(h.list(10).map((s) => [s.id, s.label])).toEqual([[b, "Browser"], [a, "TV"]]);
  const seen: string[] = []; h.listen(a, (e) => { if (e.type === "reply") seen.push(e.text); });
  expect(h.heard(a, "hello", "en", 20)).toBe(true);
  expect(h.view(a)?.busy).toBe(true);
  h.reply(a, { text: "Hi there", language: "en" }, 30);
  h.reply(a, { text: "  ", done: true }, 40);
  expect(seen).toEqual(["Hi there"]);
  expect(h.view(a)).toMatchObject({ busy: false, seq: 1, replies: [{ seq: 1, text: "Hi there", language: "en" }] });
  expect(h.view(a, 1)?.replies).toEqual([]);
  offA();
  expect(h.reply("nope", { text: "x" })).toBe(false);
});

test("speaker clips: WAV header, expiry, Sonos pick, play payload", () => {
  const w = wav(new Uint8Array(480), 24000);
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
  expect(new DataView(w.buffer).getUint32(24, true)).toBe(24000);
  expect(w.length).toBe(524);
  const c = new ClipStore(); const id = c.put(w, 0);
  expect(c.get(id, 1000)).toBe(w); expect(c.get(id, 11 * 60_000)).toBeNull();
  const st = [
    { entity_id: "media_player.sonos_arc", state: "playing", attributes: { friendly_name: "Sonos Arc" } },
    { entity_id: "media_player.default_room", state: "idle", attributes: { friendly_name: "Sonos Arc" } },
    { entity_id: "media_player.tv", state: "on", attributes: { friendly_name: "TV" } },
  ];
  expect(pickSpeakers(st).map((s) => s.id)).toEqual(["media_player.sonos_arc"]);
  expect(pickSpeakers(st, ["media_player.tv"]).map((s) => s.name)).toEqual(["TV"]);
  expect(playPayload("media_player.x", "http://h/c.wav")).toEqual({ entity_id: "media_player.x", media_content_id: "http://h/c.wav", media_content_type: "music", announce: true });
});

test("D-pad: arrows pick the nearest control in that direction", () => {
  const box = (x: number, y: number, w = 40, h = 40) => ({ x, y, w, h });
  const orb = box(100, 100, 80, 80);
  const list = [box(100, 20, 200, 30) /* above, wide */, box(250, 110) /* right */, box(20, 120) /* left */, box(110, 260) /* below */, box(400, 300) /* far down-right */];
  expect(pickNext(orb, list, "up")).toBe(0);
  expect(pickNext(orb, list, "right")).toBe(1);
  expect(pickNext(orb, list, "left")).toBe(2);
  expect(pickNext(orb, list, "down")).toBe(3);
  expect(pickNext(box(400, 300), list, "down")).toBe(-1);
});

test("TV turns: [TV] / [TV tr] prefixes", () => {
  expect(voicePrefix("tr", true)).toBe("[TV tr] ");
  expect(voicePrefix("en", true)).toBe("[TV] ");
  expect(voicePrefix("en")).toBe("[Voice] ");
  expect(stripPrefix("[TV tr] Hava nasıl?")).toEqual({ text: "Hava nasıl?", mode: "voice", lang: "tr", tv: true });
  expect(stripPrefix("[Voice] hi")).toEqual({ text: "hi", mode: "voice", lang: null });
  expect(stripPrefix("[Chat tr] x").mode).toBeNull();
});

test("widgets parse, clamp and degrade", () => {
  const seg = (lang: string, body: string) => segments("Said.\n\n```" + lang + "\n" + body + "\n```");
  const w = seg("weather", JSON.stringify({ place: "Utrecht", now: { temp: "13", summary: "Light rain" }, hours: [{ label: "18:00", temp: 12, rain: 0.7 }, { temp: 3 }], days: [{ label: "Sat", high: 14, low: 8, icon: "partly-cloudy" }] }));
  expect(w[1]).toMatchObject({ type: "widget", w: { kind: "weather", unit: "C", now: { temp: 13, icon: "rain" }, hours: [{ label: "18:00", rain: 70, icon: "cloud" }], days: [{ icon: "partly" }] } });
  expect(wxIcon("clear-night")).toBe("night");
  expect(seg("weather", "{\"place\": \"x\", now: oops")[1]).toMatchObject({ type: "code", broken: true });
  expect(seg("weather", "{\"place\":\"x\"}")[1]).toMatchObject({ type: "code", broken: true }); // nothing to show
  expect(asWidget("timer", { seconds: 600, label: "Pasta" })).toEqual({ kind: "timer", label: "Pasta", seconds: 600 });
  expect(asWidget("timer", { minutes: 2 })).toMatchObject({ seconds: 120 });
  expect(asWidget("timer", { seconds: 0 })).toBeNull();
  expect(asWidget("home", [{ name: "Lamp", state: "on", type: "light" }, { name: "Door", state: "locked", type: "garage" }, { name: "x" }])).toMatchObject({ items: [{ on: true, type: "light" }, { on: false, type: "other" }] });
  expect(asWidget("media", { title: "Song", state: "paused", position: 400, duration: 300, image: "http://x/a.jpg" })).toMatchObject({ state: "paused", position: 300, image: undefined });
  expect(asWidget("image", { url: "javascript:alert(1)" })).toBeNull();
  expect(asWidget("image", [{ url: "https://a.org/1.jpg" }, { src: "https://a.org/2.jpg", caption: "two" }])).toMatchObject({ items: [{ url: "https://a.org/1.jpg" }, { caption: "two" }] });
  expect(asWidget("steps", ["Boil", { title: "Salt", done: true }])).toMatchObject({ ordered: true, items: [{ title: "Boil" }, { title: "Salt", done: true }] });
  expect(asWidget("stat", { label: "Cash", value: 3400, trend: "sideways" })).toMatchObject({ items: [{ value: "3400", trend: undefined }] });
  expect(asWidget("compare", { items: ["A", "B"], rows: [{ label: "Power", values: [1] }], pick: 5 })).toEqual({ kind: "compare", title: undefined, items: ["A", "B"], rows: [{ label: "Power", values: ["1", "–"] }] });
  expect(asWidget("compare", { items: ["A"], rows: [{ label: "x", values: [1] }] })).toBeNull();
  expect(asWidget("agenda", { items: [{ time: "10:30", title: "Check-up" }, { time: "x" }] })).toMatchObject({ items: [{ time: "10:30", title: "Check-up" }] });
  expect(plainText("Hi\n```timer\n{\"seconds\":5}\n```")).toBe("Hi");
  expect(speakable("It's set.\n```timer\n{\"seconds\":600}\n```")).toBe("It's set.");
});
