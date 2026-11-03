# House render assets

Every asset comes from **Poly Haven** (https://polyhaven.com), licensed **CC0 1.0** (public domain, no attribution
required; credited here anyway). Nothing is committed: `fetch_assets.py` downloads them into `.cache/` (gitignored,
about 37 MB) from Poly Haven's own download host `dl.polyhaven.org`, and checks every file against the sha256 pinned in
`assets.lock.json`. `assets.json` names what is used; `python3 fetch_assets.py .cache --lock` re-pins after a change.

Software: Blender's official `bpy` wheel (`bpy==5.2.3` from PyPI, published by the Blender Foundation, GPL), or the
Blender app (`brew install --cask blender`).

## Models (glTF, 1k textures)

| Use | Poly Haven asset | Page |
|---|---|---|
| Coffee table | `modern_coffee_table_01` | https://polyhaven.com/a/modern_coffee_table_01 |
| TV sideboard | `modern_wooden_cabinet` | https://polyhaven.com/a/modern_wooden_cabinet |
| Plants | `potted_plant_01`, `potted_plant_02`, `potted_plant_04` | https://polyhaven.com/a/potted_plant_02 |
| Pendant over the dining table | `modern_ceiling_lamp_01` | https://polyhaven.com/a/modern_ceiling_lamp_01 |
| Desk lamp | `desk_lamp_arm_01` | https://polyhaven.com/a/desk_lamp_arm_01 |
| Shelves | `wooden_display_shelves_01` | https://polyhaven.com/a/wooden_display_shelves_01 |
| Sofa cushions | `throw_pillows_01` | https://polyhaven.com/a/throw_pillows_01 |
| Nightstands | `side_table_01` | https://polyhaven.com/a/side_table_01 |
| Dining chairs | `dining_chair_02` | https://polyhaven.com/a/dining_chair_02 |
| Armchair | `mid_century_lounge_chair` | https://polyhaven.com/a/mid_century_lounge_chair |
| Picture frame, vase | `hanging_picture_frame_01`, `ceramic_vase_01` | https://polyhaven.com/a/ceramic_vase_01 |

Kitchen units, hob, sink, fridge, beds, cot, wardrobes, sofas, bath, shower, WC, vanity, washer/dryer, boiler, desk,
office chair, stairs and railings, and the living room's shelf wall, TV unit, cabinet, wingback, footstool, round
tables, shag rug, curtains, drum and box floor lamps and capiz pendant, the buffet, robot dock, display tower, oven
column, wall cabinets, cooker hood, track spots, shell chairs, smoked glass pendants, gallery wall, painting and plant
stand, and upstairs the box-spring bed, day bed, bedside crib, baby camera stand, cart, sliding and panel wardrobes, dressing table, changing chest, radiator covers and radiators, roller blinds, pendants, picture frames, desks, architect lamp, mesh chair, guitar, tiled bath, wall-hung WC, black shower, white vanity, hamper and paint/tile panels are built in `build.py` (beveled meshes with the materials below): Poly Haven has
no modern Dutch fittings, and boxy fittings are boxy in real life too.

## Textures (1k JPG: colour, roughness, normal)

| Use | Poly Haven asset |
|---|---|
| Oak floors, furniture wood, loft boards (2k since 2026-11-01) | `laminate_floor_02` |
| Tiles: kitchen, hall, bathroom, toilet | `floor_tiles_06` |
| Brick facade | `brown_brick_02` |
| Sofa fabric | `poly_wool_herringbone` |
| Rug | `fabric_pattern_07` (colour map `col_1`) |
| Garden (not used in the floor views yet) | `leafy_grass`, `patio_tiles`, `tiled_floor_001` |
| Bouclé armchair and pouf, shag rug | `curly_teddy_natural` (https://polyhaven.com/a/curly_teddy_natural) |
| Sofa | `cotton_jersey` (https://polyhaven.com/a/cotton_jersey) |
| Curtains, linen bedding | `rough_linen` (https://polyhaven.com/a/rough_linen) |
| Sheer curtains | `crepe_georgette` (https://polyhaven.com/a/crepe_georgette) |
| Painted plaster walls | `plastered_wall_04` (https://polyhaven.com/a/plastered_wall_04) |

Since 2026-11-01 each texture also brings its ambient-occlusion map (`AO`), multiplied into the colour so washed-out
fabrics keep their weave. The dark stone worktop is procedural (fine grains, uneven polish), brushed steel is anisotropic,
glass and smoked glass are Principled transmission: no texture needed.

## Light

| Use | Poly Haven asset |
|---|---|
| Daylight sky (image-based light) | `kloofendal_48d_partly_cloudy_puresky` (1k HDR) |
