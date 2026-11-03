# Voice chat

The Voice page's **Chat** tab is a chat with your voice assistant: the Claude Code bot that `integrations.houseVoice`
points at (channel `voice` by default). It is the bot's ordinary session, read live from its transcript, so the
desk speaker, the iOS app's voice screen and this chat all share one conversation. The **Voices & speaker** tab keeps
the desk speaker, cloud voices and the voice picker.

## Messages

| Sent as | When | The assistant should |
|---|---|---|
| `[Chat] …` | typed in the chat | answer for a screen: Markdown and component blocks are welcome, first paragraph speakable |
| `[Voice] …` / `[Voice tr] …` | spoken (browser, phone, desk speaker, app) | answer for the ear, in Turkish for `tr`; component blocks may follow the spoken text |
| `[TV] …` / `[TV tr] …` | spoken to the TV kiosk (`?kiosk=1`) | a short spoken answer (one to three sentences), then at most one component when it helps; Turkish for `tr` |

The chat shows the text without the prefix and marks spoken messages.

## Component blocks

An answer can carry fenced blocks whose language is a component name and whose body is JSON. The chat draws them;
speech skips them (`speakable()` in `server/modules/voice.ts`), and so does Copy. A block that isn't valid JSON or
doesn't fit its shape is shown as code. Links and images must be `http(s)`.

````md
```card
{"title": "Ghent", "subtitle": "Belgium · 2 h 10 by train", "badge": "Top pick",
 "body": "Medieval centre without the crowds.", "url": "https://visit.gent.be/en", "image": "https://…/ghent.jpg",
 "fields": [{"label": "Trains", "value": "every hour"}, {"label": "From", "value": "€35"}]}
```

```sources
[{"title": "Visit Ghent", "url": "https://visit.gent.be/en", "snippet": "What's on this winter."}]
```

```chart
{"type": "bar", "title": "Train time", "unit": "min", "labels": ["Antwerp", "Ghent"], "series": [{"name": "Fastest", "values": [75, 130]}]}
```
````

- `card`: `title` (required), `subtitle`, `body`, `image`, `url`, `badge`, `fields` (up to 8 label/value pairs).
- `sources`: a list (or `{"items": [...]}`) of `title`, `url`, `snippet`. They join the turn's source cards.
- `chart`: `type` `bar` or `line`, `labels` (up to 60), `series` (up to 4, `values` line up with `labels`, `null` is a gap), `title`, `unit`.

### Living-room widgets

Display only: none of them controls a device or plays a sound, and the spoken text must be complete without them.
Each is parsed and clamped by `asWidget()` in `web/src/chat/blocks.ts` and drawn by `VcWidget.vue`. A list can be the
block itself or its `items`. Pictures must be https.

| Block | Use it for | Shape |
|---|---|---|
| `weather` | now, the next hours, the next days | `{"place"?, "unit"?: "C"\|"F", "now"?: {"temp", "summary"?, "icon"?, "feels"?}, "high"?, "low"?, "rain"?: %, "wind"?, "hours"?: [{"label","temp","icon"?,"rain"?}] (≤8), "days"?: [{"label","high","low","icon"?,"rain"?}] (≤7)}` |
| `timer` | a countdown you set or were asked about | `{"label"?, "seconds"}` (or `"minutes"`, up to 24 h, counted from the answer) or `{"label"?, "until": ISO time}` |
| `home` | Home Assistant states: lights, plugs, heating, locks | `{"title"?, "items": [{"name", "state", "type"?: light\|switch\|plug\|climate\|sensor\|media\|lock\|cover\|fan\|scene\|door, "on"?, "area"?}]}` (≤12) |
| `media` | now playing | `{"title", "artist"?, "album"?, "source"?, "image"?, "state"?: playing\|paused\|idle, "position"?, "duration"?}` (seconds) |
| `image` | a photo or up to four | `{"url", "caption"?, "credit"?}` or a list of them |
| `steps` | a recipe, a how-to, a checklist | `{"title"?, "ordered"?: true, "items": ["text" \| {"title", "detail"?, "done"?}]}` (≤12) |
| `stat` | one to four key numbers | `{"label", "value", "unit"?, "delta"?, "trend"?: up\|down\|flat, "note"?}` or a list |
| `compare` | two to four options side by side | `{"title"?, "items": ["A","B"], "rows": [{"label", "values": [...]}] (≤10), "pick"?: index}` |
| `agenda` | today's or this week's events | `{"title"?, "items": [{"time"?, "title", "detail"?, "where"?, "day"?}]}` (≤8; a new `day` starts a heading) |

Weather icons: `sun`, `partly`, `cloud`, `rain`, `drizzle`, `storm`, `snow`, `fog`, `wind`, `night`; anything else is
read from the words (`"partly-cloudy"`, `"Light rain"`).

**When a block is wrong.** Invalid JSON, or JSON that leaves nothing to draw (a weather block without any
temperature), is shown as code in the panel and left out on the TV. Nothing is half drawn.

Pages the assistant searched or read in the turn (WebSearch, WebFetch) become source cards on their own; no block
is needed for them. Parsing lives in `web/src/chat/blocks.ts`, tested in `server/modules/voiceChat.test.ts`.

## Voice mode

Press the mic in the composer. Hold the big mic to talk (push to talk), tap it to say one sentence (it stops when you
do), or switch on **Hands-free** to keep listening between answers. The clip goes to `POST /api/v1/voice/transcribe`
(ffmpeg, then whisper.cpp: `integrations.stt`), is sent as `[Voice] …` in the language of the voice in use (Turkish
for `tr-` voices, or what the desk speaker's "You speak" says), and the answer is spoken through `/voice/speak`.
Pressing the mic while it speaks cuts it off.

## Microphones

In this order, shown in the **Microphone & speaker** panel:

1. **This browser.** Browsers allow the microphone only on https or on the server itself (`localhost`). On a plain
   http address (`http://server.home`) the panel says so and links the panel's https address, if it has one
   (Tailscale Serve, a certificate).
2. **My phone.** A QR code opens `<https address>/#mic?s=<session>&code=<pairing code>` on the phone. A phone that
   isn't signed in trades the one-time code for a device token (the same pairing as *Connect a device*), so every mic
   call is authenticated. The phone records and posts each clip to `/voice/mic/{id}/clip`; the chat hears the
   transcript over `/voice/mic/{id}/events`, sends it and speaks the answer on the computer. A phone that sends no
   heartbeat for 45 s shows as disconnected.
3. **Desk speaker** (house voice, when configured): say the wake word; it answers out loud itself and the
   conversation shows in the chat.
4. **Sonos: not possible.** Sonos speakers keep their microphones for their own voice assistants (Sonos Voice Control,
   Alexa); none of Sonos' APIs (the local UPnP/SOAP control, the cloud Control API) gives access to microphone audio.
   Sonos documents playback, volume and audio clips only, and owners have been asking Sonos for a microphone API
   ([request](https://en.community.sonos.com/sonos-voice-control-229154/feature-request-public-microphone-audio-stream-api-6934163),
   [Home Assistant thread](https://en.community.sonos.com/sonos-voice-control-229127/is-there-anyway-to-pipe-sonos-mics-to-home-assistant-6927492),
   [Control API](https://docs.sonos.com/docs/control)). A Sonos can **play** the answers.

## Speakers (output)

```yaml
integrations:
  homeAssistant: { url: "http://192.168.1.10:8123", tokenEnv: HA_TOKEN }
  speakers:
    baseUrl: http://192.168.1.20     # this panel as the speaker can reach it on the LAN
    entities: [media_player.living_room]   # default: Home Assistant players named "Sonos…"
```

The reply is synthesized, kept as a WAV for 10 minutes under an unguessable id (`/api/v1/voice/clips/<id>.wav`, open
because a speaker can't sign in) and played with Home Assistant's `media_player.play_media` (`announce: true`).

## TV screen (kiosk)

`<panel>/#voice-chat?kiosk=1` is the chat alone, for a TV, with its own 10-foot layout in the spirit of the ChatGPT app:
the assistant's name and a settings button at the top, the conversation in one centred column (your question in a
soft bubble, the answer as plain large text with its component), and one dock at the bottom with the mic, the state in
words and a small waveform while it listens. Four states: **Idle** (what to press), **Listening** (amber mic and
waveform), **Thinking** (dots, and under the question what it is doing), **Answer** (the reply; "Speaking" while it
talks). No avatars, work chips, device pickers or dividers: the mic and speaker choices, earlier conversations and
older messages are in the **settings sheet**.

- **A true 1920×1080 canvas.** The page is zoomed by `innerWidth / 1920`. Salon TV's WebView reports 960×540 CSS px at
  devicePixelRatio 2, so the kiosk runs at zoom 0.5 there and every canvas px is one screen pixel: sharp text and
  hairlines without touching the launcher's own WebView settings. Viewport units are zoomed too, so kiosk styles use
  `%` and insets, never `vh`/`vw`.
- **Type for 3-4 m.** Answers 26 px, questions 25 px, the dock 28 px, nothing under 18 px; one accent (amber
  `#f2b26b`); motion is opacity and transform only (no blurs or animated gradients: the TV GPU bands on them).
- **The recent conversation only.** Turns older than 30 minutes (`&recent=<minutes>`) drop off, so the screen goes back
  to "What can I help with?". The latest question is scrolled to the top with its answer under it.
- **Spoken turns are sent as `[TV] …`** (`[TV tr] …` when Turkish was heard), so the assistant answers short and
  TV-sized.

- **D-pad only.** Arrow keys move focus to the nearest control in that direction (`web/src/chat/dpad.ts`); Enter
  activates it. On the mic, Enter starts listening for one sentence and Enter again sends it. The message list is a
  focus stop too: Up/Down scroll it, and move on at its ends. Back (`Escape`, `Backspace`, `GoBack`, `BrowserBack`)
  closes the open sheet, history or dialog. An open dialog keeps the focus inside it. Focus shows as a thick ring;
  nothing depends on hover.
- **Microphone.** If the WebView lists any audio input (some TV voice remotes appear as one), it is used. Without one,
  or when it can't be opened, the screen shows the phone pairing QR large and centred ("Scan with your phone to
  talk"); the code renews itself every 5 minutes, and the QR comes back when the phone disconnects.
- **Sign-in.** With `auth: token` the WebView needs a device cookie: open the URL once and sign in (or pair it with
  *Connect a device*); it lands back on the kiosk.
- Answers can still play on a Home Assistant speaker (Sonos).
- **Embedded** (`&embed=1`, a TV launcher shows the kiosk in a frame): the launcher posts `{sdKiosk: "back"}` for the
  remote's Back key and the chat answers `back-handled` or `exit` (close me). It also tells the launcher its `phase`
  (Salon TV no longer draws a pill for it: the kiosk shows its states) and asks it to `duck` / `unduck` the room speaker while a phone listens.
- **`&mic=tv`** (Salon TV): one press of the remote's mic button (`{sdKiosk: "mic-press"}`) picks the mic: the TV's
  USB mic (the launcher records it natively and posts `{sdKiosk: "tvclip", clip}`; its state comes as `tvmic`), else a
  phone that scanned the code and is still connected (the chat sends it a `listen` event), else the pairing code.
  Half duplex: a spoken answer is stopped before the mic opens, and never recorded over.

## Mic sessions for other devices

A mic session is a generic input for a chat, not only a phone page: any paired device (a voice satellite) can find
one (`GET /voice/mic`, newest first, `label: TV` for the kiosk), post its state as a heartbeat, post clips
(`/voice/mic/{id}/clip`, transcribed and sent by the chat), follow `/voice/mic/{id}/events` for `listen` (record one
sentence now) and `reply` (the chat's answer to what it heard, also in `GET /voice/mic/{id}?after=<seq>`), while the
chat posts its answers back with `/voice/mic/{id}/reply`.

## Demo

`SERVER_OS_DEMO=1` serves a made-up conversation with web research, a card, a table and a chart; sending a message
or a recording plays a short fake turn. A message that names a component gets a TV-style answer with it (weather,
timer, lights/home, playing/media, photo/image, steps/cook, portfolio/stat, compare/versus, agenda/today, weekend
trip/card, electricity/chart, broken, time/plain), and "slow" thinks for 20 s, so every state and widget can be looked
at without a real assistant: `SERVER_OS_DEMO=1 PORT=3195 SERVER_OS_HOME=/tmp/x bun run server/index.ts`, then open
`http://127.0.0.1:3195/#voice-chat?kiosk=1&mic=tv&recent=1` and post to `/api/v1/bots/voice/send`.

## Adaptive UI (research, 2026-10-29)

How agents draw UI elsewhere, and what this chat takes from it:

- **Microsoft Adaptive Cards** (Copilot, Teams): a JSON card schema of layout primitives (`TextBlock`, `ColumnSet`,
  `FactSet`, `Image`, actions) that each host draws natively; a **host config** sets the look per host, and hosts
  support different schema versions (Teams 1.5, Web Chat 1.6), with unsupported elements failing silently.
  ([overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/adaptive-cards-overview),
  [host config](https://learn.microsoft.com/en-us/adaptive-cards/rendering-cards/host-config),
  [FactSet](https://adaptivecards.io/explorer/FactSet.html),
  [cards for agents](https://learn.microsoft.com/en-au/agents/design-guidelines/adaptive-cards-for-agent-design))
- **Google A2UI**: the agent sends declarative JSON that may only name components from the client's **trusted
  catalog** (data, never code); the client renders them with its own widgets, per platform, incrementally.
  ([SD Times](https://sdtimes.com/ai/google-launches-a2ui-project-to-enable-agents-to-build-contextually-relevant-uis/),
  [CrewAI A2UI guide](https://docs.crewai.com/en/learn/a2ui))
- **MCP Apps / MCP-UI and the OpenAI Apps SDK**: a tool points at a `ui://` HTML resource that the host runs in a
  sandboxed iframe, talking JSON-RPC over postMessage; a UI-enabled tool must still return meaningful text.
  ([MCP Apps](https://mastra.ai/docs/mcp/mcp-apps), [ext-apps](https://github.com/modelcontextprotocol/ext-apps),
  [Apps SDK examples](https://github.com/web-mcp/openai-apps-sdk-examples))
- **Vercel AI SDK**: `streamUI` (React Server Components) is paused; today a tool's typed result is matched to a client
  component (`tool-<name>` parts).
  ([AI SDK 3.0](https://vercel.com/blog/ai-sdk-3-generative-ui), [generative UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces))
- **CopilotKit / AG-UI**: an event protocol between agent and app (text, state, tool calls) under three generative-UI
  styles: controlled (AG-UI), declarative (A2UI, Open-JSON-UI) and open-ended (MCP Apps).
  ([AG-UI](https://docs.copilotkit.ai/ag-ui-protocol), [generative-ui](https://github.com/CopilotKit/generative-ui))
- **Screens across the room**: Google's smart displays treat voice as primary and allow one rich response per prompt;
  Alexa's APL adapts one response to Echo Shows and TVs; TV guidance asks for few elements, little text, 24 px type
  and up, and no thin fonts.
  ([Google rich responses](https://developers.google.com/assistant/conversational/prompts-rich),
  [APL](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/add-visuals-and-audio-to-your-skill.html),
  [Fire TV](https://developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html),
  [Smashing: designing for TV](https://www.smashingmagazine.com/2025/09/designing-tv-principles-patterns-practical-guidance/))

**Decision: keep the fenced blocks and grow them as a closed catalog of semantic components (the A2UI model), not
Adaptive Cards JSON or MCP Apps.**

- The assistant is a Claude Code session: its answer is terminal text, with no tool-result channel to carry UI
  resources. A fenced JSON block is the cheapest structured channel that text already has, and it keeps every old
  `card` / `sources` / `chart` answer working.
- *Semantic* blocks (`weather`, `timer`, `compare`) are short for the model to write and leave the look to the
  host, which matters on a 10-foot screen. Adaptive Cards' layout primitives would put layout in the model's hands,
  give long JSON, and still need a TV "host config" to look right.
- From A2UI: only components in the client's catalog are drawn; the JSON is data and is validated and clamped, links
  and images are http(s) / https only, and nothing executes. From MCP Apps: the text answer always stands alone, and
  a bad block falls back (code in the panel, left out on the TV). From smart displays: on the TV, one component per
  answer.
- No iframes per answer (MCP Apps style): too heavy for the TV's GPU and memory, and nothing here needs custom code.
- An `adaptivecard` block (TextBlock / FactSet / Image / ColumnSet mapped onto these renderers) can be added later if
  an outside agent ever needs to post cards here. Until then, YAGNI.
