# House (3D)

The House page shows the house and pins Home Assistant devices in their rooms, live. It has two views:

- **Photo** (the default once renders exist): Cycles renders of each storey, the HA community's "3D floorplan" look.
  A day and a night picture per storey (the night one fades in after sunset, from HA's `sun.sun` or the sun's height
  over Utrecht; the sun/moon button forces Day or Night). Every light that is on adds its own light pass over the
  picture (`mix-blend-mode: screen`, opacity = brightness, fades with the live state). Pins sit on the picture through
  the render camera's projection; tap a pin for its card, tap a room (read from a colour mask) for its devices.
- **3D** (the default once baked models exist): the same Cycles scene as the photos, as a model you can turn. One
  finger turns, a pinch zooms, two fingers pan; it starts at the photo's angle and can't go under the floor. Each
  storey is a GLB with its light baked in (below); lights that are on light their room live, and night dims the day
  light to moonlight. Pins, the card popup, dragging and tap-to-place work as before. Without baked models it is the
  plain procedural dollhouse below. Edit mode (moving pins, placing devices) always uses the 3D view.

## Photo renders and baked models

```
bun run house:render                    # all storeys: the photos, then the 3D view's baked models
bun run house:render --floors ground    # one storey (the others are kept)
bun run house:render --glb              # only the baked models (--no-glb: only the photos)
bun run house:render --quick            # small and noisy, to check a model change in a minute
bun run house:render --glb --quick --check  # also list faces that share a plane and overlap (they z-fight in 3D)
```

`tools/house-render/render.ts` reads the house model (`config/house.json` or the shipped default), asks the running
server for the pins (`/api/v1/house/layout`; without a server only hand-placed pins count), downloads the CC0 assets
(`tools/house-render/ASSETS.md`, pinned by sha256) and runs `tools/house-render/build.py` in Blender: the official
`bpy` wheel in `tools/house-render/.venv` (made with `uv` on first run), `HOUSE_RENDER_PYTHON`, or the Blender app
(`BLENDER=…`). Output goes to `<home>/data/house-render/` (served at `/api/v1/house/render/<file>`): per storey
`<floor>-day.webp`, `<floor>-night.webp`, `<floor>-room-<room>.webp` (each room's ceiling light alone),
`<floor>-light-<entity>.webp` (lamps and night lights with a pin), `<floor>-mask.png`, and `manifest.json` with the
camera's projection per storey.

- **What is built:** walls with thickness from the room rectangles (as below), outer walls brick outside and plaster
  inside, windows with frames, mullions, glass and sills, interior doors, the front door and glazed garden doors,
  oak floors in living rooms and bedrooms, tiles in the kitchen, hall and wet rooms, quarter-turn stairs with oak
  treads, stairwells (`voids`), and the attic under its roof (the slopes and gables cut at the view height).
- **Interior doors:** a lined frame with a casing on both faces and a leaf on one jamb. The leaf stands open (90°, flat
  against the wall that meets the door's wall beside the hinge, at most 40 cm away) when that wall is solid along the
  leaf and the leaf and its swing are clear of furniture, other leaves and the stairs; otherwise it is drawn closed.
  An opening can choose: `hinge` (`-x`/`+x`/`-y`/`+y`, the end it hangs on), `into` (the side it opens to), `closed`.
  Garden doors (outer, wider than 1.2 m) are glazed leaves in black frames; `fixed` adds a fixed pane at one end.
- **Stairs** stop at the storey's cut height like the walls; the storey above shows the top of the flight in its
  stairwell (a 1 m well under the `void`). Keep stairs clear of every wall (a closet under the stairs is a room with
  `openTo` to the stair room, so no wall crosses the flight); `bun test` checks it.
- **No shared planes:** faces that lie in one plane and overlap flicker in the 3D view (z-fighting), so the build never
  makes them: room floors are the slab under them (no slab face under a floor), the front and back walls own the
  corners (brick right through) and the side walls stop at them, inside walls stop at the face of the wall they meet,
  sills stand proud of the wall under them, gables stop under the roof, frame rails sit between their jambs.
  `--check` lists what is left (faces hidden inside walls and in the Poly Haven models are harmless).
- **Furniture** is data: each storey's `furniture` list in the house model (`type`, centre `x`/`y`, optional `w`/`d`/`h`,
  `rot` in degrees; rot 0 = back against the front-side wall, facing the garden). Poly Haven models for loose
  furniture, beveled procedural meshes for fittings.
- **Finishes:** a room's `floor` picks its floor (`laminate_grey`, `tiles_grey`, …) over the kind's usual one; `paint`
  and `wall-tiles` are thin panels a few mm off a wall face (several go round a window), `color` (sRGB hex) colours
  paint, rugs, the duvet, blinds and frames, and `z` is a wall piece's bottom edge.
- **Camera:** orthographic, 3/4 from the back garden, the same scale for every storey; the long party wall on the
  camera's side is cut low like a dollhouse. `mirror: true` mirrors the whole build.
- **Baked models (the 3D view):** a second Blender run on the same scene (`export_glbs` in build.py). Per storey the
  shown meshes are copied with their modifiers applied (Poly Haven models decimated to ~2,500 faces, leaves to ~15,000),
  joined, and cut into chunks of about the same area; each chunk is unwrapped (smart project, then packed) onto its own
  atlas and baked with Cycles: the albedo (2048 px, about 120 px a metre), the day's light (sun and sky with GI,
  ~48 px a metre, 256 samples) and the light of all the storey's lamps at once (black world). Since 2026-11-01 the
  albedo also carries an ambient-occlusion bake at its own resolution (25 cm reach, 60 % strength: the contact shadows
  the coarser light maps can't hold) and, in its alpha, `1 - gloss / 2` with `gloss = (1 - roughness)^2` from a
  roughness bake (manifest `glb.gloss: true`); the page adds a Fresnel reflection of a soft room gradient, lit by the
  light at the spot, so the floor, worktop, TV and glass fronts catch light at grazing angles.
  The light maps are scene-linear, stored as `sqrt(l / (1 + l))` in 8-bit WebP. Output: `<floor>.glb` (geometry and
  lightmap UVs, EXT_meshopt_compression; glass and alpha-cut leaves as plain meshes) plus `<floor>-albedo<i>.webp`,
  `-sun<i>.webp` and `-lamp<i>.webp`, listed under `glb` in manifest.json. The page (`web/src/house/baked.ts`) draws
  albedo × light, adds the lamp light of every room whose lights are on (a 10 cm room-number map of the plan picks
  the room under each pixel, a step off the surface), and tone maps with AgX like the photos. It draws on demand:
  nothing renders while the view is still. The meshopt decoder is three's own (`three/examples/jsm/libs`), no CDN.
- **Eye-level stills (`--views cams.json`):** the same scene with full-height walls and a ceiling, rendered with a
  perspective camera per entry (`{name, floor, pos [x, y, z], look [x, y, z], lens}`, plan metres) in the evening
  (every lamp of the storey on, ceiling lights dimmed, 3000 K, AgX Punchy) and in daylight, into `<home>/data/house-views/`.
  For comparing with real photos; the page doesn't use them. About 40 s a picture at 1600×1200, 160 samples.
- **Materials:** Poly Haven CC0 scans (ASSETS.md) with their AO maps multiplied in: 2k oak laminate, curly teddy for
  bouclé and the shag rug, cotton jersey for the sofa, rough linen for curtains and bedding, crepe for sheers, painted
  plaster for walls; a procedural dark stone worktop; brushed (anisotropic) steel; transmissive smoked glass. Walls that
  stand on the floor get a 7 cm skirting board (not in bathrooms) and long walls in living rooms and bedrooms a double
  socket; curtains hang in real 11 cm pleats.
- **When to re-render:** after changing rooms, openings or furniture. Moving a pin needs no re-render (pins are
  projected live); only a lamp with its own light pass (`light.*` lamps, night-light switches) looks better re-rendered
  at its new spot, and until then its room's light pass is used.
- **Cost:** about 5.5 min for all storeys on the M4 (Metal GPU, OpenImageDenoise, 128/96/64 samples for day, night
  and light passes, 1600 px), one Blender process peaking around 5 GB (unified memory, GPU included); the output is
  ~13 MB with the GLBs (2026-11-01: ground 6.7, first 4.7, attic 1.8). The first run compiles Cycles' Metal kernels (about 3 min, cached afterwards). Mind the RAM on a
  16 GB machine running VMs: `--quick` (900 px, few samples) needs far less.
- **Known gaps:** no exterior/street view yet (the 3D view shows the outside); the furniture is a fixed, opinionated
  set (Poly Haven has no modern Dutch sofas or beds, those are procedural); the attic's real window positions aren't
  in the plans; a light without an area or pin has no overlay until it is placed and the house re-rendered (or it
  uses its room's pass once placed).

- **Model:** `config/house.json` in the Server OS home (until the first save, the shipped `server/modules/house.default.json`). Schema: `spec/house.schema.json`. Coordinates are interior metres: `x` across the width (0 = the left wall seen from the street), `y` depth from the front wall. Each storey has rectangular rooms (`rects`, several for an L shape), room pairs with no wall between them (`openTo`), `openings` (door, window, opening; they cut any wall within 25 cm of `at`), `fixtures` (counter, stairs, bed, …), flat roofs and an optional gable roof. `mirror: true` draws the plan flipped (the plans may be of a mirrored neighbour house) without touching the coordinates.
- **Walls** are not stored: every room edge becomes a wall, except edges inside one room, between an `openTo` pair, or on the shell (which gets the thicker outer wall).
- **Devices:** `room.haArea` lists the HA areas (id or name) that belong in the room. Relevant entities (lights, real switches, climate, media, cameras, covers, fans, vacuums, temperature/humidity/air/power sensors, motion and door sensors; minus `ignore` globs, diagnostic/config entities and unavailable ones) of a mapped area are spread inside the room. In a room with a `tv-unit`, the TV's things (media players, remotes, ids with `tv`, ambilight, sonos, soundbar, shield) stand in rows in front of the TV and the rest spread beside them. A pin placed by hand (`pins`: `{ floor, x, y, z? }`) wins; `z` is its height above the storey's floor in metres (0 to `storeyHeight`; without it the pin stands 0.5 m up), and `{ "hidden": true }` takes an entity off the house. In edit mode a tapped pin gets a three-arrow gizmo (red across, blue depth, green height; mouse or touch) and X / Y / Z fields; dragging the pin itself still moves it across the floor and keeps its height. Everything else waits in the edit tray.
- **Live:** pins and glow follow the panel's live stream; the server adds every pinned entity to the HA bridge's watch list.
- **Device list:** `GET /api/v1/house/devices` prints the HA areas, their devices and where each landed .

## TV kiosk (`#house?kiosk=1`)
The House page as a TV screen (views/HouseKiosk.vue + HouseView's `kiosk` prop). A TV launcher can open
`http://<server>/#house?kiosk=1&tv=1&embed=1` in a full-screen frame. Only the lamps are pinned; the floor name and the focused lamp show top left, key hints at the bottom
(they fade after 7 s).

| Key | 3D view | Photo view | Lamp mode |
|---|---|---|---|
| ◀ ▶ | turn the house 30° | storey down / up | previous / next lamp |
| ▲ ▼ | storey up / down (below the ground floor: whole house) | storey up / down | storey up / down (ring moves to that storey's lamps) |
| OK | lamp mode: ring on the first lamp of the storey | same | switch the ringed lamp (HA toggle) |
| CH+ / CH− · 2 / 8 · + / − | zoom in / out (in drifts towards the ringed lamp) | zoom the picture | zoom towards the ringed lamp |
| Back | close the kiosk | close the kiosk | leave lamp mode |

Zoom keys: a launcher shell may take CH+ / CH− (KEYCODE_CHANNEL_UP / DOWN) and posts `{sdKiosk: "zoom", dir: 1 | -1}` into the
frame; a WebView that receives them itself sees `ChannelUp` / `ChannelDown`. The number keys 2 and 8 reach any WebView, so they
work without launcher changes. In a browser: + / − and the mouse wheel.

Back in a frame: the launcher posts `{sdKiosk: "back"}`, the page answers `back-handled` or `exit` (the voice kiosk's
protocol); opened directly, Back goes back in history. Lamps glow live from the SSE stream.

Resolution: the page is laid out on a 960×540 canvas (zoom innerWidth / 960: 1 in the TV WebView, 2 in a 1920 px
frame), so labels and pins keep their size, but the 3D canvas draws at the screen's real pixels: device pixels per canvas
CSS px, at least 1920 wide with `&tv=1` (a 1080p panel, whatever the WebView reports inside the zoomed frame), never more
than 1920×1080. Multisampling is on (nearly free on a TV's tiled GPU; `&aa=0` turns it off); no shadows. The page posts
`{sdKiosk: "px", ratio, w, h, dpr, zoom}` to the frame's parent (the launcher can log it). `&px=<ratio>` pins it.
It opens with a slow 6 s turn that doubles as a frame-rate test: frames drawn back to back are timed, and under 20 fps
over 3 s it steps the resolution down (2× → 1.5× → 1× on the TV, posting `{sdKiosk: "perf", fallback: "resolution"}`,
and turns 3.5 s more to measure the step); below the last step it switches to the photo view (or, without renders, halves
the pixels) and posts `{sdKiosk: "perf", fps}`. `&minfps=<n>` overrides the threshold (`0` never falls back, `1000` always
does, for tests).

Group pins: a pin whose spot has `entities` (2 to 16 HA ids) and a `name` is one pin for all of them. Its key is a name of
our own; e.g. a four-socket strip that powers the lights around a TV sits on the TV unit. It is on when any member is on; switching it turns every reachable member the same way; it
glows its room like any lamp (no bake of its own), shows in the kiosk's lamp cycle, and its members get no pins or tray
entries of their own. Moving it in edit mode keeps its members. Note: a saved `config/house.json` keeps its own pins, so a
house saved before this needs the pin added there (or removed from the file's pins to pick up the shipped one).

## What we took from the HA community

**floor3d-card (adizanni)** — a three.js Lovelace card over an OBJ exported from Sweet Home 3D.
- Bind entities to places in the model and change them by state (colour, hide, text), rather than drawing a separate UI.
- Light entities drive real three.js lights in the scene, so a lit room actually looks lit.
- Per-entity "zoom areas" and a click that opens the entity's more-info: we use floor views and a pin popup with our own card.
- What we skipped: a heavy OBJ/MTL authoring step in Sweet Home 3D; our model is a small JSON of rectangles anyone can correct.

**ha-floorplan (ExperienceLovelace)** — an SVG floor plan whose elements get CSS classes per entity state.
- State → class rules (on, off, unavailable) styled in one place; our pins do the same with `.lit`, `.on`, `.na`.
- The plan is data (an SVG file plus a rules list), editable without touching code: our `house.json` + `haArea` mapping.
- Tap actions per element (toggle or open more-info).

**Sweet Home 3D + Blender "3D floorplan" with lighting overlays** (picture-elements cards).
- Render one base image plus one image per light, and blend the light images over the base with their opacity tied to brightness. We do the live equivalent: each room's floor gets a warm emissive glow plus a point light, scaled by the brightest light that's on.
- A slightly top-down isometric "dollhouse" angle reads best; walls cut low so you see into the rooms.
- Keep a day/night-neutral base so the glow carries the information.

**three.js HA viewers (generic WebGL dashboards)**
- HTML labels projected over the canvas each frame are crisper and easier to make tappable than sprites, and reuse the panel's icons and styles.
- Raycast against floor meshes to turn a tap into a room and a position: we use it for placing and dragging pins.
- Damped OrbitControls with a limited polar angle keep touch navigation from flipping under the floor.

## Known gaps
- Rooms are rectangles; diagonal walls and the stair's quarter turn are approximated.
- The gable roof is only drawn in the attic-only view, faintly; the garden and shed are not modelled.
- The panel itself is dark-only today; the scene reads its colours from the theme tokens, so it follows a light theme when one exists.
