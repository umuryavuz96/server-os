"""Photoreal floor renders of the house for the House page (the HA "3D floorplan + lights overlay" look).

Run through tools/house-render/render.ts (bun run house:render), which writes the job file:
    python build.py <job.json>                          # with the bpy wheel
    Blender --background --python build.py -- <job.json> # or with the Blender app

Builds the house from the house model (walls with thickness, door/window openings with frames and glass, floors in oak
and tiles, quarter-turn stairs, the extension), furnishes it from the model's furniture list (Poly Haven CC0 models for
loose furniture, beveled procedural fittings for kitchens, baths, beds and appliances), then renders per storey with
Cycles: a day base, a night base, one overlay per room light and per placed HA light (only that light on, black
elsewhere: the page blends it over the night base), and a flat-colour room mask for taps. Writes manifest.json with
the camera's projection, so the page can put pins on the picture.
"""
import bpy, bmesh, json, math, os, sys, time
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
JOB = json.load(open(ARGS[0]))
H = JOB["house"]
CACHE = JOB["cache"]
OUT = JOB["out"]
os.makedirs(OUT, exist_ok=True)
W = H["width"]
SH = H.get("storeyHeight", 2.8)
WO = (H.get("wall") or {}).get("outer", 0.3)
WI = (H.get("wall") or {}).get("inner", 0.1)
SLAB = 0.25
CEIL = SH - SLAB           # room height
CUT = JOB.get("cut", CEIL)  # wall height in the renders
MIRROR = bool(H.get("mirror"))
EPS = 0.02
T0 = time.time()
CAM_SIDE = (-1 if JOB.get("cam_az", -32) > 0 else 1) * (-1 if MIRROR else 1) # which long side the camera looks over (in Blender X)
NEAR_CUT = JOB.get("near_cut", 0.9)                  # that party wall is cut low, like a dollhouse


def log(*a):
    print(f"[house-render {time.time() - T0:6.1f}s]", *a, flush=True)


# ---------------------------------------------------------------- model -> Blender coordinates
# Blender X across the width (x = 0 on the left seen from the street, flipped when mirrored), Y = depth from the
# front wall (the garden is +Y), Z up. Everything is built in world coordinates on objects at the origin.
def X(x):
    return W - x if MIRROR else x


def P(x, y, z):
    return Vector((X(x), y, z))


# ---------------------------------------------------------------- materials
MATS = {}


def tex_dims(tid):
    try:
        d = json.load(open(os.path.join(CACHE, "textures", tid, "info.json")))["dimensions"]
        return d[0] / 1000.0, d[1] / 1000.0
    except Exception:
        return 1.0, 1.0


def principled(name, color, rough=0.6, metal=0.0, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    for k, v in kw.items():
        try:
            b.inputs[k].default_value = v
        except Exception:
            pass
    MATS[name] = m
    return m


def textured(name, tid, tint=(1, 1, 1), rough_mul=1.0, scale=1.0, bump=0.4, wash=None, ao=1.0, **kw):
    """Image textures mapped by world position (box projection), so no UVs are needed and the scale is real. wash =
    (colour, amount): mix the texture towards a flat colour (a paler wood, a cream fabric that keeps its weave). ao: how
    much of the texture's own ambient occlusion (plank joints, the loops of a bouclé) darkens its colour. kw: more
    Principled inputs (sheen, transmission)."""
    m = principled(name, (1, 1, 1), **kw)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tw, th = tex_dims(tid)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / (tw * scale), 1 / (th * scale), 1 / (tw * scale))
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])

    def img(kind, colour):
        p = os.path.join(CACHE, "textures", tid, kind + ".jpg")
        if not os.path.exists(p):
            return None
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(p, check_existing=True)
        n.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        n.projection = "BOX"
        n.projection_blend = 0.25
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    d = img("Diffuse", True)
    if not d:
        b.inputs["Base Color"].default_value = (*tint, 1)
    if d:
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(d.outputs["Color"], mix.inputs[6])
        mix.inputs[7].default_value = (*tint, 1)
        out = mix.outputs[2]
        if wash:
            wm = nt.nodes.new("ShaderNodeMix")
            wm.data_type = "RGBA"
            wm.inputs["Factor"].default_value = wash[1]
            nt.links.new(out, wm.inputs[6])
            wm.inputs[7].default_value = (*wash[0], 1)
            out = wm.outputs[2]
        a = img("AO", False) if ao > 0 else None
        if a:  # cavities stay dark after the wash: that is what keeps a pale fabric's weave readable
            am = nt.nodes.new("ShaderNodeMix")
            am.data_type = "RGBA"
            am.blend_type = "MULTIPLY"
            am.inputs["Factor"].default_value = ao
            nt.links.new(out, am.inputs[6])
            nt.links.new(a.outputs["Color"], am.inputs[7])
            out = am.outputs[2]
        nt.links.new(out, b.inputs["Base Color"])
    r = img("Rough", False)
    if r:
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = rough_mul
        nt.links.new(r.outputs["Color"], mul.inputs[0])
        nt.links.new(mul.outputs[0], b.inputs["Roughness"])
    n = img("nor_gl", False)
    if n:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = bump
        nt.links.new(n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return m


def glass(name, tint=(0.9, 0.95, 0.97), rough=0.0):
    m = principled(name, tint, rough=rough)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["IOR"].default_value = 1.45
    return m


def speckled(name, color, rough=0.3, **kw):
    """A dark composite stone: fine light and dark grains in the colour, a slightly uneven polish."""
    m = principled(name, color, rough=rough, **kw)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 260.0
    n.inputs["Detail"].default_value = 2.0
    nt.links.new(geo.outputs["Position"], n.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    e = ramp.color_ramp.elements
    e[0].position, e[1].position = 0.45, 0.8
    e[0].color = (color[0] * 0.7, color[1] * 0.7, color[2] * 0.7, 1)
    e[1].color = (color[0] * 1.9, color[1] * 1.85, color[2] * 1.8, 1)
    nt.links.new(n.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    r = nt.nodes.new("ShaderNodeMapRange")
    r.inputs["To Min"].default_value, r.inputs["To Max"].default_value = rough * 0.8, rough * 1.25
    n2 = nt.nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 6.0
    nt.links.new(geo.outputs["Position"], n2.inputs["Vector"])
    nt.links.new(n2.outputs["Fac"], r.inputs["Value"])
    nt.links.new(r.outputs["Result"], b.inputs["Roughness"])
    return m


def make_materials():
    T = JOB.get("textures", {})
    textured("oak", T.get("oak", "laminate_floor_02"), tint=(1.0, 0.93, 0.85), rough_mul=0.9)
    textured("tiles", T.get("wet", "floor_tiles_06"), tint=(1.35, 1.33, 1.3), rough_mul=0.6, scale=1.6, bump=0.3)
    textured("wet", T.get("wet", "floor_tiles_06"), tint=(0.92, 0.93, 0.95), rough_mul=0.6, bump=0.3)
    textured("brick", T.get("brick", "brown_brick_02"), tint=(0.95, 0.78, 0.7), bump=0.8)
    textured("fabric", T.get("fabric", "poly_wool_herringbone"), tint=(0.55, 0.57, 0.6), scale=0.6, bump=0.5)
    textured("rug", T.get("rug", "fabric_pattern_07"), tint=(0.42, 0.4, 0.37), scale=1.2, bump=0.6)
    # the living room as it is: a cream sofa, bouclé armchair and footstool, a cream shag rug, the sage shelf wall
    # (2026-11-01, photoreal pass) real fabric scans instead of one herringbone washed flat: a fine cotton weave for the
    # sofa, curly teddy for the bouclé chair, pouf and shag rug, rough linen for curtains and bedding, crepe for sheers
    textured("sofa_fabric", T.get("jersey", "cotton_jersey"), scale=0.8, bump=0.6, wash=((0.62, 0.585, 0.53), 0.62), **{"Sheen Weight": 0.35})
    textured("boucle", T.get("teddy", "curly_teddy_natural"), tint=(1.05, 1.03, 1.0), bump=1.0, wash=((0.74, 0.71, 0.65), 0.3), ao=0.8, **{"Sheen Weight": 0.5})
    textured("shag", T.get("teddy", "curly_teddy_natural"), scale=1.5, bump=1.4, wash=((0.66, 0.63, 0.58), 0.4), ao=0.9, **{"Sheen Weight": 0.6})
    textured("oak_light", T.get("oak", "laminate_floor_02"), tint=(1.08, 1.04, 1.0), rough_mul=0.85, wash=((0.58, 0.52, 0.44), 0.3))
    textured("oak_furn", T.get("oak", "laminate_floor_02"), tint=(1.0, 0.9, 0.78), rough_mul=0.7, scale=0.7, bump=0.1)
    # upstairs as it is: pale grey laminate, large grey tiles in the bathroom (floor and walls)
    textured("laminate_grey", T.get("oak", "laminate_floor_02"), tint=(1.0, 1.0, 1.0), rough_mul=0.85, wash=((0.6, 0.59, 0.57), 0.72))
    textured("tiles_grey", T.get("wet", "floor_tiles_06"), rough_mul=0.7, scale=3.0, bump=0.3, wash=((0.2, 0.2, 0.2), 0.62))
    textured("wall_tile", T.get("wet", "floor_tiles_06"), rough_mul=0.5, scale=3.0, bump=0.2, wash=((0.34, 0.34, 0.33), 0.66))
    textured("headboard", T.get("fabric", "poly_wool_herringbone"), scale=0.4, bump=0.5, wash=((0.07, 0.065, 0.085), 0.88))
    textured("patio", T.get("patio", "patio_tiles"), tint=(0.85, 0.85, 0.83), bump=0.5)
    textured("grass", T.get("grass", "leafy_grass"), tint=(0.8, 0.9, 0.75), bump=0.6)
    # painted plaster: a real wall scan washed to the paint colour, so walls keep a faint trowel texture in the light
    textured("plaster", T.get("plaster", "plastered_wall_04"), scale=1.5, bump=0.12, wash=((0.9, 0.885, 0.86), 0.86), ao=0.3, rough_mul=1.1)
    principled("cap", (0.11, 0.11, 0.115), rough=0.9)
    principled("slab", (0.32, 0.31, 0.3), rough=0.95)
    principled("white", (0.86, 0.86, 0.84), rough=0.3, **{"Coat Weight": 0.2})
    principled("white_matte", (0.84, 0.84, 0.82), rough=0.6)
    principled("frame", (0.88, 0.88, 0.87), rough=0.4)
    principled("anthracite", (0.045, 0.047, 0.052), rough=0.45)
    speckled("worktop", (0.035, 0.035, 0.037), rough=0.25, **{"Coat Weight": 0.3})
    principled("steel", (0.75, 0.75, 0.74), rough=0.28, metal=1.0, **{"Anisotropic": 0.7})  # brushed
    principled("chrome", (0.9, 0.9, 0.9), rough=0.08, metal=1.0)
    principled("black_glass", (0.01, 0.01, 0.012), rough=0.06, **{"Coat Weight": 1.0})
    principled("screen", (0.005, 0.006, 0.008), rough=0.05, **{"Coat Weight": 1.0})
    principled("ceramic", (0.92, 0.92, 0.91), rough=0.12, **{"Coat Weight": 0.6})
    textured("linen", T.get("linen", "rough_linen"), bump=0.5, wash=((0.86, 0.83, 0.78), 0.55), ao=0.6, **{"Sheen Weight": 0.5})
    principled("duvet", (0.78, 0.8, 0.82), rough=0.95, **{"Sheen Weight": 0.5})
    principled("duvet_sage", (0.6, 0.66, 0.58), rough=0.95, **{"Sheen Weight": 0.5})
    principled("duvet_rust", (0.62, 0.36, 0.25), rough=0.95, **{"Sheen Weight": 0.5})
    principled("mattress", (0.93, 0.93, 0.92), rough=0.9)
    principled("upholstery", (0.32, 0.33, 0.35), rough=0.95, **{"Sheen Weight": 0.4})
    principled("walnut", (0.2, 0.12, 0.07), rough=0.45)
    principled("black_metal", (0.03, 0.03, 0.03), rough=0.4, metal=0.6)
    principled("lampshade", (0.92, 0.88, 0.8), rough=0.9, **{"Transmission Weight": 0.25})
    principled("coat_blue", (0.12, 0.17, 0.27), rough=0.9)
    principled("coat_camel", (0.55, 0.38, 0.22), rough=0.9)
    principled("coat_green", (0.2, 0.26, 0.2), rough=0.9)
    principled("mirror", (0.95, 0.95, 0.95), rough=0.02, metal=1.0)
    principled("sage", (0.24, 0.33, 0.29), rough=0.7)
    principled("sofa_base", (0.5, 0.48, 0.45), rough=0.95, **{"Sheen Weight": 0.4})
    principled("capiz", (0.78, 0.7, 0.58), rough=0.3, **{"Transmission Weight": 0.35, "Coat Weight": 0.5})
    textured("sheer", T.get("sheer", "crepe_georgette"), bump=0.3, wash=((0.95, 0.95, 0.94), 0.8), ao=0.4, **{"Transmission Weight": 0.55, "Sheen Weight": 0.3})
    principled("frame_dark", (0.03, 0.032, 0.035), rough=0.35)
    principled("vase_pink", (0.75, 0.38, 0.42), rough=0.25, **{"Coat Weight": 0.6})
    principled("figure", (0.9, 0.9, 0.88), rough=0.35)
    principled("door", (0.9, 0.9, 0.88), rough=0.45)
    principled("front_door", (0.06, 0.065, 0.07), rough=0.4)
    principled("roof_bitumen", (0.16, 0.16, 0.17), rough=0.9)
    principled("roof_tiles", (0.07, 0.07, 0.075), rough=0.7)
    principled("well", (0.05, 0.045, 0.04), rough=1.0)
    principled("greige", (0.72, 0.68, 0.62), rough=0.5)
    principled("cherry", (0.36, 0.13, 0.05), rough=0.35, **{"Coat Weight": 0.2})
    principled("bassinet", (0.4, 0.38, 0.44), rough=0.95, **{"Sheen Weight": 0.4})
    principled("frame_grey", (0.5, 0.51, 0.52), rough=0.4, metal=0.3)
    principled("cream_metal", (0.74, 0.69, 0.6), rough=0.45, metal=0.2)
    principled("bamboo", (0.55, 0.36, 0.16), rough=0.5)
    principled("mesh_grey", (0.42, 0.43, 0.44), rough=0.9, **{"Sheen Weight": 0.3})
    principled("desk_mat", (0.55, 0.48, 0.35), rough=0.8)
    principled("brass", (0.6, 0.45, 0.2), rough=0.3, metal=1.0)
    principled("pine_knob", (0.6, 0.33, 0.14), rough=0.5)
    principled("globe", (0.95, 0.94, 0.92), rough=0.2, **{"Transmission Weight": 0.3, "Coat Weight": 0.5})
    principled("paper", (0.93, 0.92, 0.88), rough=0.9)
    principled("ink", (0.06, 0.06, 0.06), rough=0.8)
    principled("screen_lit", (0.55, 0.45, 0.42), rough=0.08, **{"Coat Weight": 1.0})
    # the ground floor as it is (from reference photos): a dark stone worktop, grey shell chairs, smoked glass
    # pendants, a yellow lamp shade, a lilac-grey curtain, the white buffet and media unit's soft white panels
    speckled("stone_dark", (0.055, 0.055, 0.058), rough=0.32, **{"Coat Weight": 0.4})
    principled("chair_grey", (0.2, 0.21, 0.225), rough=0.95, **{"Sheen Weight": 0.4})
    # not named "glass": the 3D view bakes it as a solid smoky globe instead of leaving a near-invisible clear shell
    principled("smoke_globe", (0.26, 0.24, 0.21), rough=0.05, **{"Transmission Weight": 0.8, "Coat Weight": 1.0})
    principled("shade_yellow", (0.9, 0.68, 0.06), rough=0.9, **{"Transmission Weight": 0.3})
    principled("curtain_grey", (0.42, 0.4, 0.44), rough=0.95, **{"Sheen Weight": 0.5})
    principled("panel_white", (0.8, 0.8, 0.77), rough=0.55)
    principled("leaf", (0.06, 0.2, 0.05), rough=0.6)
    principled("bloom_red", (0.55, 0.02, 0.03), rough=0.5)
    principled("canvas_gold", (0.42, 0.3, 0.12), rough=0.7)
    principled("canvas_dark", (0.06, 0.07, 0.09), rough=0.7)
    glass("shelf_glass", tint=(0.85, 0.92, 0.9), rough=0.02)
    textured("boards", T.get("oak", "laminate_floor_02"), tint=(0.75, 0.68, 0.58), rough_mul=1.0, scale=1.3, bump=0.2)
    glass("glass")
    glass("shower_glass", tint=(0.92, 0.97, 0.97), rough=0.02)
    # the room mask: flat emission colours, no lighting
    return MATS


# ---------------------------------------------------------------- mesh building
class Kit:
    """Collects boxes, prisms and cylinders into one bmesh with per-face material slots, then one object."""

    def __init__(self, mats=None):
        self.bm = bmesh.new()
        self.slots = []

    def slot(self, m):
        if m not in self.slots:
            self.slots.append(m)
        return self.slots.index(m)

    def box(self, x0, x1, y0, y1, z0, z1, mat, top=None, sides=None):
        """Axis-aligned box in the kit's own frame. top/sides: other materials for the top face / the four sides."""
        if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
            return
        bm = self.bm
        v = [bm.verts.new((x, y, z)) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
        F = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
        for i, f in enumerate(F):
            face = bm.faces.new([v[j] for j in f])
            m = mat
            if i == 1 and top:
                m = top
            elif i >= 2 and sides:
                m = sides
            face.material_index = self.slot(m)

    def prism(self, poly, z0, z1, mat, top=None):
        """A vertical prism over a 2D polygon (counter-clockwise or not)."""
        bm = self.bm
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
        if area < 0:
            poly = poly[::-1]
        lo = [bm.verts.new((x, y, z0)) for x, y in poly]
        hi = [bm.verts.new((x, y, z1)) for x, y in poly]
        bm.faces.new(lo[::-1]).material_index = self.slot(mat)
        bm.faces.new(hi).material_index = self.slot(top or mat)
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([lo[i], lo[j], hi[j], hi[i]]).material_index = self.slot(mat)

    def cyl(self, cx, cy, z0, z1, r, mat, seg=24, ry=None, top=None):
        ry = ry or r
        poly = [(cx + r * math.cos(2 * math.pi * i / seg), cy + ry * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        self.prism(poly, z0, z1, mat, top=top)

    def rbox(self, x0, x1, y0, y1, z0, z1, r, mat, top=None, seg=6):
        """A box with rounded vertical corners; r is one radius or four (+x+y, -x+y, -x-y, +x-y)."""
        rs = r if isinstance(r, (tuple, list)) else (r,) * 4
        lim = min(x1 - x0, y1 - y0) / 2 - 1e-3
        rs = [max(0.0, min(q, lim)) for q in rs]
        poly = []
        for (cx, cy, a0), q in zip(((x1, y1, 0), (x0, y1, 90), (x0, y0, 180), (x1, y0, 270)), rs):
            sx, sy = (-1 if cx == x1 else 1), (-1 if cy == y1 else 1)
            if q < 1e-3:
                poly.append((cx, cy))
                continue
            for i in range(seg + 1):
                a = math.radians(a0 + 90 * i / seg)
                poly.append((cx + sx * q + q * math.cos(a), cy + sy * q + q * math.sin(a)))
        self.prism(poly, z0, z1, mat, top=top)

    def prism_xz(self, poly, y0, y1, mat):
        """A prism over a polygon in the x-z plane, from y0 to y1 (a chair's shaped back)."""
        bm = self.bm
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
        if area < 0:
            poly = poly[::-1]
        a = [bm.verts.new((x, y0, z)) for x, z in poly]
        c = [bm.verts.new((x, y1, z)) for x, z in poly]
        s = self.slot(mat)
        bm.faces.new(a).material_index = s
        bm.faces.new(c[::-1]).material_index = s
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], c[i], c[j], a[j]]).material_index = s

    def obox(self, cx, cy, length, width, ang, z0, z1, mat):
        """A box turned by ang (radians) about its centre: a bar of a cross, a stretcher."""
        ca, sa = math.cos(ang), math.sin(ang)
        pts = [(u * length / 2, v * width / 2) for u, v in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        self.prism([(cx + u * ca - v * sa, cy + u * sa + v * ca) for u, v in pts], z0, z1, mat)

    def lathe(self, cx, cy, prof, mat, seg=32, caps=True, loop=False, scallops=12):
        """A surface of revolution about the vertical through (cx, cy); prof = [(r, z), ...] bottom to top. With caps,
        ends with r > 0 are closed; loop joins the last ring back to the first (a shell with a thickness, closed). A third
        value (r, z, a) scallops that ring: its radius swells by up to a, `scallops` times round."""
        bm = self.bm

        def ring(p):
            r, z, amp = (*p, 0.0)[:3]
            out = []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                q = r + amp * abs(math.cos(scallops * t / 2))
                out.append(bm.verts.new((cx + q * math.cos(t), cy + q * math.sin(t), z)))
            return out

        rings = [ring(p) for p in prof]
        s = self.slot(mat)
        for a, b in zip(rings, rings[1:] + (rings[:1] if loop else [])):
            for i in range(seg):
                j = (i + 1) % seg
                bm.faces.new([a[i], a[j], b[j], b[i]]).material_index = s
        if caps and not loop and prof[0][0] > 1e-4:
            bm.faces.new(rings[0][::-1]).material_index = s
        if caps and not loop and prof[-1][0] > 1e-4:
            bm.faces.new(rings[-1]).material_index = s

    def cyl_y(self, cx, cy0, cy1, cz, r, mat, seg=24):
        """A cylinder lying along y (a washer door, a rail)."""
        bm = self.bm
        a = [bm.verts.new((cx + r * math.cos(2 * math.pi * i / seg), cy0, cz + r * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
        b = [bm.verts.new((cx + r * math.cos(2 * math.pi * i / seg), cy1, cz + r * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
        bm.faces.new(a).material_index = self.slot(mat)
        bm.faces.new(b[::-1]).material_index = self.slot(mat)
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new([a[i], b[i], b[j], a[j]]).material_index = self.slot(mat)

    def tub(self, x0, x1, y0, y1, z0, z1, rim, depth, mat, inner=None):
        """A box with a hollow top (bath, basin, sink)."""
        bm = self.bm
        before = set(bm.faces)
        self.box(x0, x1, y0, y1, z0, z1, mat)
        new = [f for f in bm.faces if f not in before]
        topf = max(new, key=lambda f: f.calc_center_median().z)
        bm.normal_update()  # inset needs face normals; without them it silently makes no rim
        bmesh.ops.inset_region(bm, faces=[topf], thickness=rim, depth=0)
        bmesh.ops.inset_region(bm, faces=[topf], thickness=0.0, depth=0)  # a ring for the inner walls to stand on
        bmesh.ops.translate(bm, verts=list(topf.verts), vec=(0, 0, -depth))
        if inner:
            topf.material_index = self.slot(inner)
        # already wound outwards; recalc_face_normals gets a hollow box wrong (turns it inside out), so it skips these
        for f in bm.faces:
            if f not in before:
                f.tag = True

    def to_object(self, name, matrix=None, bevel=0.0, collection=None, smooth=False, segments=2):
        me = bpy.data.meshes.new(name)
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f in self.bm.faces if not f.tag])
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.slots:
            me.materials.append(MATS[m] if isinstance(m, str) else m)
        ob = bpy.data.objects.new(name, me)
        if matrix is not None:
            ob.matrix_world = matrix
        (collection or bpy.context.scene.collection).objects.link(ob)
        if bevel > 0:
            md = ob.modifiers.new("bevel", "BEVEL")
            md.width = bevel
            md.segments = segments
            md.limit_method = "ANGLE"
            md.harden_normals = False
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        return ob


# ---------------------------------------------------------------- walls (a port of web/src/house/model.ts wallsOf)
def shell_of(f):
    return f.get("shell") or {"x": 0, "y": 0, "w": W, "d": f["depth"]}


def union(spans):
    s = sorted([list(p) for p in spans if p[1] - p[0] > EPS])
    out = []
    for a, b in s:
        if out and a <= out[-1][1] + EPS:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def subtract(spans, cuts):
    cur = union(spans)
    for ca, cb in union(cuts):
        nxt = []
        for a, b in cur:
            if cb <= a or ca >= b:
                nxt.append([a, b])
            else:
                for p, q in ((a, ca), (cb, b)):
                    if q - p > EPS:
                        nxt.append([p, q])
        cur = nxt
    return cur


def walls_of(f):
    S = shell_of(f)
    lines = {}

    def line(along, at, outer=False):
        k = f"{along}:{at:.2f}"
        if k not in lines:
            lines[k] = {"along": along, "at": at, "outer": outer, "spans": [], "cuts": []}
        return lines[k]

    line("x", S["y"], True)["spans"].append([S["x"], S["x"] + S["w"]])
    line("x", S["y"] + S["d"], True)["spans"].append([S["x"], S["x"] + S["w"]])
    line("y", S["x"], True)["spans"].append([S["y"], S["y"] + S["d"]])
    line("y", S["x"] + S["w"], True)["spans"].append([S["y"], S["y"] + S["d"]])

    def on_shell(along, at):
        if along == "x":
            return abs(at - S["y"]) < EPS or abs(at - S["y"] - S["d"]) < EPS
        return abs(at - S["x"]) < EPS or abs(at - S["x"] - S["w"]) < EPS

    pairs = f.get("openTo", [])

    def is_open(a, b):
        return a == b or any((p == a and q == b) or (p == b and q == a) for p, q in pairs)

    edges = []
    for r in f["rooms"]:
        for q in r["rects"]:
            edges += [("x", q["y"], q["x"], q["x"] + q["w"], r["id"], 1), ("x", q["y"] + q["d"], q["x"], q["x"] + q["w"], r["id"], -1),
                      ("y", q["x"], q["y"], q["y"] + q["d"], r["id"], 1), ("y", q["x"] + q["w"], q["y"], q["y"] + q["d"], r["id"], -1)]
    for e in edges:
        if on_shell(e[0], e[1]):
            continue
        L = line(e[0], e[1])
        L["spans"].append([e[2], e[3]])
        for o in edges:
            if o is not e and o[0] == e[0] and abs(o[1] - e[1]) < EPS and o[5] != e[5] and is_open(e[4], o[4]):
                L["cuts"].append([max(e[2], o[2]), min(e[3], o[3])])
    out = []
    for L in lines.values():
        ops = [o for o in f.get("openings", []) if o["along"] == L["along"] and abs((o["at"][1] if L["along"] == "x" else o["at"][0]) - L["at"]) < 0.25]
        centre = (lambda o: o["at"][0]) if L["along"] == "x" else (lambda o: o["at"][1])
        live = subtract(L["spans"], L["cuts"])
        for a, b in subtract(L["spans"], L["cuts"] + [[centre(o) - o["w"] / 2, centre(o) + o["w"] / 2] for o in ops]):
            out.append({"along": L["along"], "at": L["at"], "a": a, "b": b, "outer": L["outer"], "kind": "wall"})
        for o in ops:
            a, b = centre(o) - o["w"] / 2, centre(o) + o["w"] / 2
            if any(a >= p - EPS and b <= q + EPS for p, q in live):
                out.append({"along": L["along"], "at": L["at"], "a": a, "b": b, "outer": L["outer"], "kind": o["kind"], "o": o})
    return out


# ---------------------------------------------------------------- storeys
def rect_minus(r, holes):
    """A rectangle minus holes, as rectangles (x0, x1, y0, y1)."""
    parts = [(r[0], r[1], r[2], r[3])]
    for h in holes:
        nxt = []
        for x0, x1, y0, y1 in parts:
            hx0, hx1, hy0, hy1 = max(x0, h[0]), min(x1, h[1]), max(y0, h[2]), min(y1, h[3])
            if hx0 >= hx1 or hy0 >= hy1:
                nxt.append((x0, x1, y0, y1))
                continue
            for p in ((x0, x1, y0, hy0), (x0, x1, hy1, y1), (x0, hx0, hy0, hy1), (hx1, x1, hy0, hy1)):
                if p[1] - p[0] > 1e-3 and p[3] - p[2] > 1e-3:
                    nxt.append(p)
        parts = nxt
    return parts


FLOOR_MAT = {"living": "oak_light", "bedroom": "oak", "office": "oak", "stairs": "oak", "hall": "tiles", "kitchen": "tiles", "bath": "wet", "toilet": "wet", "utility": "oak", "storage": "oak"}


def wbox(kit, x0, x1, y0, y1, z0, z1, mat, top=None, sides=None):
    """A box given in model coordinates, into a kit that is in world coordinates."""
    a, b = X(x0), X(x1)
    kit.box(min(a, b), max(a, b), y0, y1, z0, z1, mat, top=top, sides=sides)


def wall_geom(w, f):
    """Thickness and placement of a wall piece: (t, off0, knee), off0 = where the wall starts across its line. None:
    the piece is drawn elsewhere (the attic's side walls are the gables)."""
    S = shell_of(f)
    roof = f.get("roof")
    outer = w["outer"]
    if roof and outer and w["along"] == "y":
        return None
    knee = bool(roof and outer and w["along"] == "x")  # attic: the knee walls under the roof are inside walls
    t = WO if outer and not knee else WI
    if outer and not knee:
        off0 = -t if (abs(w["at"] - S["y"]) < 0.02 if w["along"] == "x" else abs(w["at"] - S["x"]) < 0.02) else 0
    else:
        off0 = -t / 2
    return t, off0, knee


def wall_rect(w, f, a=None, b=None):
    """A wall piece's footprint on the plan (x0, x1, y0, y1)."""
    g = wall_geom(w, f)
    if not g:
        return None
    t, off0, _ = g
    a, b = (w["a"] if a is None else a), (w["b"] if b is None else b)
    if w["along"] == "x":
        return (a, b, w["at"] + off0, w["at"] + off0 + t)
    return (w["at"] + off0, w["at"] + off0 + t, a, b)


def trim_junctions(ws, f):
    """Inside walls meet without overlapping, so no two caps or faces share a plane: at a T the stem stops at the face
    of the wall it runs into; at an L the piece along x runs over the corner and the piece along y stops at its face."""
    inner = [w for w in ws if not w["outer"] and wall_geom(w, f)]
    knees = [w for w in ws if w["outer"] and (wall_geom(w, f) or (0, 0, False))[2]]  # the attic's knee walls are inside walls too
    span = {id(w): (w["a"], w["b"]) for w in inner + knees}  # as drawn on the plan, before any trimming
    for w in inner:
        if w["kind"] != "wall":
            continue
        for end in ("a", "b"):
            p = span[id(w)][0 if end == "a" else 1]
            for o in inner + knees:
                oa, ob = span[id(o)]
                if o is w or o["along"] == w["along"] or abs(o["at"] - p) > EPS or not (oa - EPS <= w["at"] <= ob + EPS):
                    continue
                sign = 1 if end == "a" else -1  # +: towards the inside of w
                through = oa + EPS < w["at"] < ob - EPS
                if through or w["along"] == "y":
                    w[end] = o["at"] + sign * WI / 2
                else:
                    w[end] = o["at"] - sign * WI / 2
                break
    return ws


# ---------------------------------------------------------------- doors: where each leaf stands
JAMB = 0.025    # the frame's lining inside the opening
LEAF_T = 0.04   # leaf thickness
PROUD = 0.015   # how far the frame and its casing stand off the wall


def rot_box(it):
    """A furniture piece's footprint on the plan (x0, x1, y0, y1), its rotation taken into account."""
    dw, dd = DEFAULTS.get(it["type"], (0.5, 0.5))
    w, d = it.get("w", dw), it.get("d", dd)
    r = math.radians(it.get("rot", 0))
    hx = abs(math.cos(r)) * w / 2 + abs(math.sin(r)) * d / 2
    hy = abs(math.sin(r)) * w / 2 + abs(math.cos(r)) * d / 2
    return (it["x"] - hx, it["x"] + hx, it["y"] - hy, it["y"] + hy)


def overlaps(p, q, m=0.0):
    return p[0] < q[1] - m and q[0] < p[1] - m and p[2] < q[3] - m and q[2] < p[3] - m


def plan_doors(f, ws):
    """Per inside door (keyed by id of its opening): (hinge 'a'|'b', side +1|-1, open) — where the hinge is along the
    opening, which room the leaf opens into, and whether it stands open. Open means swung 90 degrees flat against a
    wall that meets the door's wall right next to the hinge; when no such wall is free (furniture, another door, the
    stairs), the door is drawn closed in its frame. An opening can set it: hinge (-x, +x, -y, +y: the end it hangs
    on), into (the side it opens to) and closed."""
    items = [it for it in f.get("furniture", []) or [] if it["type"] not in ("rug",)]
    blocks = [rot_box(it) for it in items]
    stairs = [rot_box(it) for it in items if it["type"] == "stairs"] + [(v["x"], v["x"] + v["w"], v["y"], v["y"] + v["d"]) for v in f.get("voids", [])]
    solid = [w for w in ws if w["kind"] == "wall" and wall_geom(w, f)]
    placed, out = [], {}
    for w in ws:
        if w["kind"] != "door" or w["outer"]:
            continue
        o = w["o"]
        t = WI
        a, b, at = w["a"], w["b"], w["at"]
        L = (b - a) - 2 * JAMB - 0.005
        ax = w["along"]
        perp = "y" if ax == "x" else "x"

        def plan_rect(u0, u1, v0, v1):
            u0, u1, v0, v1 = min(u0, u1), max(u0, u1), min(v0, v1), max(v0, v1)
            return (u0, u1, v0, v1) if ax == "x" else (v0, v1, u0, u1)

        cands = []
        for hinge in ("a", "b"):
            if o.get("hinge") and o["hinge"] != ("-" if hinge == "a" else "+") + ax:
                continue
            for side in (1, -1):
                if o.get("into") and o["into"] != ("+" if side > 0 else "-") + perp:
                    continue
                pt = ((a + b) / 2, at + side * 0.3) if ax == "x" else (at + side * 0.3, (a + b) / 2)
                room = roomAt(f, *pt)
                if not room:
                    continue
                uh = a + JAMB if hinge == "a" else b - JAMB
                du = 1 if hinge == "a" else -1
                face = at + side * (t / 2 + PROUD)
                leaf = plan_rect(uh, uh + du * LEAF_T, face, face + side * L)
                # the wall the open leaf rests against: across the door's wall, just beyond the hinge, solid along the leaf
                best = None
                for s in solid:
                    if s["along"] != perp:
                        continue
                    g = wall_geom(s, f)
                    sr = wall_rect(s, f)
                    near_face = (sr[1] if ax == "x" else sr[3]) if hinge == "a" else (sr[0] if ax == "x" else sr[2])
                    dist = (uh - near_face) * du
                    if not (-0.005 <= dist <= 0.4):
                        continue
                    lo, hi = sorted((face, face + side * L))
                    cover = max(0.0, min(hi, s["b"]) - max(lo, s["a"]))
                    if cover < 0.9 * L:
                        continue
                    if best is None or dist < best:
                        best = dist
                if best is None:
                    if not o.get("open"):
                        continue
                    best = 0.5  # `open`: it stands at 90 degrees in the room, nothing behind it
                # the swing (a quarter circle) clear of the stairs, the leaf clear of furniture, walls and other leaves
                swing = []
                for i in range(7):
                    for j in range(7):
                        r_, th = L * (i + 0.5) / 7, (math.pi / 2) * (j + 0.5) / 7
                        pu, pv = uh + du * r_ * math.cos(th), face + side * r_ * math.sin(th)
                        swing.append((pu, pv) if ax == "x" else (pv, pu))
                if any(q[0] <= x <= q[1] and q[2] <= y <= q[3] for q in stairs for x, y in swing):
                    continue
                if any(overlaps(leaf, q, 0.005) for q in blocks + placed):
                    continue
                if any(overlaps(leaf, wall_rect(s, f), 0.005) for s in solid if s is not w):
                    continue
                kind = room.get("kind", "")
                cands.append((best + (0.15 if kind in ("hall", "stairs") else 0), hinge, side, leaf))
        if o.get("closed") or not cands:
            hg = o.get("hinge", "-" + ax) == "+" + ax and "b" or "a"
            out[id(o)] = (hg, closed_side(o, f, w, hg, ax, perp, blocks, stairs, plan_rect), False)
            continue
        cands.sort(key=lambda c: c[0])
        _, hinge, side, leaf = cands[0]
        placed.append(leaf)
        out[id(o)] = (hinge, side, True)
    return out


def closed_side(o, f, w, hinge, ax, perp, blocks, stairs, plan_rect):
    """Which way a door drawn closed swings when tapped open in the 3D view: `into` if the opening says, else the side
    with a room and the least furniture in the quarter circle of the leaf."""
    a, b, at = w["a"], w["b"], w["at"]
    L = (b - a) - 2 * JAMB - 0.005
    uh = a + JAMB if hinge == "a" else b - JAMB
    du = 1 if hinge == "a" else -1
    best = (1e9, 1)
    for side in (1, -1):
        if o.get("into") and o["into"] != ("+" if side > 0 else "-") + perp:
            continue
        face = at + side * (WI / 2 + PROUD)
        pt = ((a + b) / 2, at + side * 0.3) if ax == "x" else (at + side * 0.3, (a + b) / 2)
        score = 0.0 if roomAt(f, *pt) else 50.0
        swing = plan_rect(uh, uh + du * LEAF_T, face, face + side * L)
        score += sum(1 for q in blocks + stairs if overlaps(swing, q, 0.0)) * 10
        # the leaf's far end sweeps the quarter circle: a few probe points
        for i in range(1, 6):
            r_ = L * i / 5
            for j in range(1, 4):
                th = (math.pi / 2) * j / 4
                pu, pv = uh + du * r_ * math.cos(th), face + side * r_ * math.sin(th)
                x_, y_ = (pu, pv) if ax == "x" else (pv, pu)
                score += sum(1 for q in blocks if q[0] <= x_ <= q[1] and q[2] <= y_ <= q[3])
        if score < best[0]:
            best = (score, side)
    return best[1]


def roomAt(f, x, y):
    for r in f["rooms"]:
        for q in r["rects"]:
            if q["x"] <= x <= q["x"] + q["w"] and q["y"] <= y <= q["y"] + q["d"]:
                return r
    return None


def build_storey(f, coll):
    base = f["level"] * SH
    S = shell_of(f)
    roof = f.get("roof")
    voids = [(v["x"], v["x"] + v["w"], v["y"], v["y"] + v["d"]) for v in f.get("voids", [])]
    rects = [(q["x"], q["x"] + q["w"], q["y"], q["y"] + q["d"]) for r in f["rooms"] for q in r["rects"]]
    # the floor plate: the slab where no room is (under the walls, round the edge); a room's floor is the slab under
    # it too, so no slab face hides under a floor face (they'd fight in the 3D view)
    k = Kit()
    for x0, x1, y0, y1 in rect_minus((-WO, W + WO, -WO, f["depth"] + WO), voids + rects):
        # under the attic's slopes the plate is the boarded loft floor
        wbox(k, x0, x1, y0, y1, base - SLAB, base - 0.002, "slab", top="boards" if roof else None)
    k.to_object(f"{f['id']}_slab", collection=coll)
    # room floors, one object per room (the mask colours them)
    rooms = {}
    for r in f["rooms"]:
        k = Kit()
        for q in r["rects"]:
            for x0, x1, y0, y1 in rect_minus((q["x"], q["x"] + q["w"], q["y"], q["y"] + q["d"]), voids):
                wbox(k, x0, x1, y0, y1, base - SLAB, base + 0.012, "slab", top=r.get("floor") or FLOOR_MAT.get(r.get("kind", ""), "oak"))
        rooms[r["id"]] = k.to_object(f"{f['id']}_floor_{r['id']}", collection=coll)
    # walls
    cut = CUT if not roof else min(CUT, 1.6)
    walls = Kit()
    ups = {}
    caps = Kit()
    trim = Kit()
    ws = trim_junctions(walls_of(f), f)
    doors = plan_doors(f, ws)
    ndoor = 0
    for w in ws:
        g = wall_geom(w, f)
        if not g:
            continue
        t, off0, knee = g
        outer = w["outer"]
        # the front and back walls run over the corners; the side walls stop at them
        lo_edge = S["x"] if w["along"] == "x" else S["y"]
        hi_edge = S["x"] + S["w"] if w["along"] == "x" else S["y"] + S["d"]
        wraps = outer and not knee and w["along"] == "x"
        a = w["a"] - (t if wraps and w["a"] <= lo_edge + 0.02 else 0)
        b = w["b"] + (t if wraps and w["b"] >= hi_edge - 0.02 else 0)
        # outside faces in brick, inside in plaster; tops dark like a section cut
        out_side = None
        if outer and not knee:
            out_side = ("lo" if off0 < 0 else "hi")

        def skirt(x0, x1, y0, y1, sides):
            """(2026-11-01) A 7 cm white skirting board on the room faces of a wall piece that stands on the floor, and
            a double socket low on longer stretches of living rooms and bedrooms. sides: which faces ('lo'/'hi')."""
            for side in sides:
                if w["along"] == "x":
                    yy = (y0 - 0.012, y0) if side == "lo" else (y1, y1 + 0.012)
                    r = roomAt(f, (x0 + x1) / 2, yy[0] - 0.05 if side == "lo" else yy[1] + 0.05)
                    if not r or r.get("kind") == "bath":
                        continue
                    wbox(trim, x0, x1, yy[0], yy[1], base, base + 0.07, "white")
                    if x1 - x0 > 1.4 and r.get("kind") in ("living", "bedroom", "office"):
                        sx = x0 + 0.45
                        py = (yy[0] - 0.006, yy[0]) if side == "lo" else (yy[1], yy[1] + 0.006)
                        wbox(trim, sx, sx + 0.155, py[0], py[1], base + 0.26, base + 0.34, "white_matte")
                        for c in (sx + 0.04, sx + 0.115):
                            hy = (py[0] - 0.0015, py[0]) if side == "lo" else (py[1], py[1] + 0.0015)
                            wbox(trim, c - 0.02, c + 0.02, hy[0], hy[1], base + 0.28, base + 0.32, "panel_white")
                else:
                    xx = (x0 - 0.012, x0) if side == "lo" else (x1, x1 + 0.012)
                    r = roomAt(f, xx[0] - 0.05 if side == "lo" else xx[1] + 0.05, (y0 + y1) / 2)
                    if not r or r.get("kind") == "bath":
                        continue
                    wbox(trim, xx[0], xx[1], y0, y1, base, base + 0.07, "white")
                    if y1 - y0 > 1.4 and r.get("kind") in ("living", "bedroom", "office"):
                        sy = y0 + 0.45
                        px = (xx[0] - 0.006, xx[0]) if side == "lo" else (xx[1], xx[1] + 0.006)
                        wbox(trim, px[0], px[1], sy, sy + 0.155, base + 0.26, base + 0.34, "white_matte")
                        for c in (sy + 0.04, sy + 0.115):
                            hx = (px[0] - 0.0015, px[0]) if side == "lo" else (px[1], px[1] + 0.0015)
                            wbox(trim, hx[0], hx[1], c - 0.02, c + 0.02, base + 0.28, base + 0.32, "panel_white")

        split = bool(JOB.get("glb")) and outer and not knee and not roof  # (glb) an outer wall's upper part is its own mesh per side: the page cuts it by the camera
        side_key = ("x" if w["along"] == "y" else "y") + ("l" if w["at"] < ((S["x"] + S["w"] / 2) if w["along"] == "y" else (S["y"] + S["d"] / 2)) else "h")

        def piece(z0, z1, aa=a, bb=b):
            if split and z1 > NEAR_CUT + 0.005:
                # the low part's top is hidden under the upper part (its bake would be black): a thin unbaked cap lies on it instead
                _piece(z0, min(z1, NEAR_CUT), aa, bb, walls, caps if z0 < NEAR_CUT - 0.005 else None)
                _piece(max(z0, NEAR_CUT), z1, aa, bb, ups.setdefault(side_key, Kit()))
            else:
                _piece(z0, z1, aa, bb, walls)

        def _piece(z0, z1, aa, bb, walls, cap_k=None):
            if z1 - z0 < 0.005:
                return
            tp = None if cap_k is not None else "cap"
            if z0 < 0.01 and JOB.get("skirting", True):
                if w["along"] == "x":
                    sx0, sx1, sy0, sy1 = aa, bb, w["at"] + off0, w["at"] + off0 + t
                    if out_side:
                        sx0, sx1 = max(sx0, lo_edge), min(sx1, hi_edge)
                else:
                    sx0, sx1, sy0, sy1 = w["at"] + off0, w["at"] + off0 + t, aa, bb
                if (sx1 - sx0 if w["along"] == "x" else sy1 - sy0) > 0.05:
                    skirt(sx0, sx1, sy0, sy1, ["hi" if out_side == "lo" else "lo"] if out_side else ["lo", "hi"])
            if w["along"] == "x":
                x0, x1, y0, y1 = aa, bb, w["at"] + off0, w["at"] + off0 + t
            else:
                x0, x1, y0, y1 = w["at"] + off0, w["at"] + off0 + t, aa, bb
            if cap_k is not None:
                wbox(cap_k, x0, x1, y0, y1, base + z1, base + z1 + 0.003, "cap")  # just above the wall top, whose own face is black (baked under the upper part)
            # split an outer wall into a thin brick skin and the plaster rest, so each face gets its own material;
            # the corner blocks (beyond the side walls) are brick right through
            if out_side:
                skin = 0.1
                if w["along"] == "x":
                    for c0, c1 in ((x0, min(x1, lo_edge)), (max(x0, hi_edge), x1)):
                        if c1 - c0 > 0.005:
                            wbox(walls, c0, c1, y0, y1, base + z0, base + z1, "brick", top=tp)
                    x0, x1 = max(x0, lo_edge), min(x1, hi_edge)
                    if x1 - x0 < 0.005:
                        return
                    sy = (y0, y0 + skin) if out_side == "lo" else (y1 - skin, y1)
                    ry = (y0 + skin, y1) if out_side == "lo" else (y0, y1 - skin)
                    wbox(walls, x0, x1, sy[0], sy[1], base + z0, base + z1, "brick", top=tp)
                    wbox(walls, x0, x1, ry[0], ry[1], base + z0, base + z1, "plaster", top=tp)
                else:
                    sx = (x0, x0 + skin) if out_side == "lo" else (x1 - skin, x1)
                    rx = (x0 + skin, x1) if out_side == "lo" else (x0, x1 - skin)
                    wbox(walls, sx[0], sx[1], y0, y1, base + z0, base + z1, "brick", top=tp)
                    wbox(walls, rx[0], rx[1], y0, y1, base + z0, base + z1, "plaster", top=tp)
            else:
                wbox(walls, x0, x1, y0, y1, base + z0, base + z1, "plaster", top=tp)

        near = outer and w["along"] == "y" and ((X(w["at"]) - W / 2) * CAM_SIDE > 0)
        # the attic's garden-side knee wall faces the camera too
        near = near or (knee and abs(w["at"] - S["y"] - S["d"]) < 0.02)
        if w["kind"] == "wall":
            piece(-0.002, min(cut, NEAR_CUT) if near and not split else cut)
            continue
        o = w["o"]
        if w["kind"] == "window":
            sill = o.get("sill", 0.8)
            head = o.get("head", 2.3)
            piece(-0.002, sill)
            if head < cut:
                piece(head, cut)
            window(trim, w, off0, t, base, sill, min(head, cut), head <= cut)
        else:
            head = o.get("head", 2.25 if outer else 2.1)
            if head < cut:
                piece(head, cut)
            if w["kind"] == "door":
                leaf_to = None if outer else {"name": f"{f['id']}_door_{ndoor}", "coll": coll}
                ndoor += 1
                door(trim, w, off0, t, base, head, cut, outer, doors.get(id(o)), leaf_to)
    if JOB.get("ceiling"):  # (views) a white ceiling over every room, seen from below
        for r in f["rooms"]:
            for q in r["rects"]:
                wbox(walls, q["x"], q["x"] + q["w"], q["y"], q["y"] + q["d"], base + CEIL, base + CEIL + 0.02, "white_matte")
    walls.to_object(f"{f['id']}_walls", collection=coll)
    for key, kit in ups.items():
        UPS[kit.to_object(f"{f['id']}_up_{key}", collection=coll).name] = key
    if ups:
        CUTCAPS.add(caps.to_object(f"{f['id']}_cutcap", collection=coll).name)
    trim.to_object(f"{f['id']}_trim", collection=coll, bevel=0.004)
    if roof:
        attic_roof(f, roof, base, coll)
    stairs_coll = bpy.data.collections.new(f["id"] + "_stairs")
    bpy.context.scene.collection.children.link(stairs_coll)
    STAIRS[f["id"]] = stairs_coll
    shaft = Kit()
    well = 1.0  # how far the stairwell reaches down: the top of the flight below shows in it
    for vx0, vx1, vy0, vy1 in voids:
        for a0, a1, b0, b1 in ((vx0 - 0.05, vx1 + 0.05, vy0 - 0.05, vy0), (vx0 - 0.05, vx1 + 0.05, vy1, vy1 + 0.05), (vx0 - 0.05, vx0, vy0, vy1), (vx1, vx1 + 0.05, vy0, vy1)):
            wbox(shaft, a0, a1, b0, b1, base - well, base - SLAB, "plaster")
        wbox(shaft, vx0, vx1, vy0, vy1, base - well - 0.05, base - well, "well")
    if voids:
        shaft.to_object(f"{f['id']}_shaft", collection=coll)
        # the flight that arrives through the hole: the top steps of the storey below's stairs, down to the well's floor
        below = next((x for x in H["floors"] if x["level"] == f["level"] - 1), None)
        for i, it in enumerate((below or {}).get("furniture", []) or []):
            if it["type"] == "stairs" and any(overlaps(rot_box(it), v) for v in voids):
                furnish(it, base - SH, coll, f"{f['id']}_below_{i}_stairs", zmin=SH - well)
    else:
        shaft.bm.free()
    for i, it in enumerate(f.get("furniture", []) or []):
        try:
            furnish(it, base, stairs_coll if it["type"] == "stairs" else coll, f"{f['id']}_{i}_{it['type']}", zmax=cut)
        except Exception as e:  # one broken piece shouldn't stop the render
            log("furniture failed", it, e)
    return rooms


def window(k, w, off0, t, base, z0, z1, top_frame):
    """Frame (white, 7 cm) with a mullion on wide windows, glass set back, and a stone sill outside."""
    fr = 0.065
    a, b = w["a"], w["b"]
    depth0, depth1 = w["at"] + off0 + t * 0.35, w["at"] + off0 + t * 0.35 + 0.07

    def B(p0, p1, q0, q1, z_0, z_1, m):
        if w["along"] == "x":
            wbox(k, p0, p1, q0, q1, base + z_0, base + z_1, m)
        else:
            wbox(k, q0, q1, p0, p1, base + z_0, base + z_1, m)

    # jambs full height, rails and mullions between them: frame pieces only touch
    B(a, a + fr, depth0, depth1, z0, z1, "frame")
    B(b - fr, b, depth0, depth1, z0, z1, "frame")
    B(a + fr, b - fr, depth0, depth1, z0, z0 + fr, "frame")
    if top_frame:
        B(a + fr, b - fr, depth0, depth1, z1 - fr, z1, "frame")
    n = max(1, round((b - a) / 0.9))
    for i in range(1, n):
        c = a + (b - a) * i / n
        B(c - 0.03, c + 0.03, depth0, depth1, z0 + fr, z1 - (fr if top_frame else 0), "frame")
    B(a + fr, b - fr, depth0 + 0.03, depth0 + 0.036, z0 + fr, z1 - (fr if top_frame else 0), "glass")
    if w["outer"] and z0 > 0.05:
        out = w["at"] + off0
        B(a - 0.04, b + 0.04, out - 0.05, out + t * 0.35, z0 - 0.04, z0 + 0.01, "slab")  # stands proud of the wall's cap


CUTCAPS = set()  # (glb) the thin caps on the low outer walls: exported unbaked
UPS = {}    # object name -> key of the outer wall side whose upper part it holds (read by export_glbs into glb.json)
DOORS = {}  # object name -> how its leaf swings (read by export_glbs into glb.json)


def door(k, w, off0, t, base, head, cut, outer, plan, leaf_to=None):
    """Inside: a lined frame with a casing on both faces, and a white leaf on two hinges at one jamb, either swung flat
    against the wall beside it or closed in the frame (plan_doors decides). Outer: the front door (anthracite, closed)
    or glazed garden doors."""
    a, b = w["a"], w["b"]
    width = b - a
    top = min(head, cut)

    def B(p0, p1, q0, q1, z_0, z_1, m):
        if z_1 - z_0 < 0.003:
            return
        if w["along"] == "x":
            wbox(k, p0, p1, q0, q1, base + z_0, base + z_1, m)
        else:
            wbox(k, q0, q1, p0, p1, base + z_0, base + z_1, m)

    q0, q1 = w["at"] + off0, w["at"] + off0 + t
    if outer:
        o = w["o"]
        mid0, mid1 = q0 + t * 0.35, q0 + t * 0.35 + 0.07
        if width > 1.2:  # garden doors: two glazed leaves in black frames, and a fixed pane beside them (o["fixed"])
            fm = "frame_dark"
            B(a - 0.02, a + 0.02, q0 - 0.01, q1 + 0.01, 0, top, fm)
            B(b - 0.02, b + 0.02, q0 - 0.01, q1 + 0.01, 0, top, fm)
            fr = 0.07
            fx = o.get("fixed")
            panes = 3 if fx else 2
            edges = [a + 0.02 + (width - 0.04) * i / panes for i in range(panes + 1)]
            fixed_i = None if not fx else (0 if fx.startswith("-") else panes - 1)
            leaves = [i for i in range(panes) if i != fixed_i]
            for i, (s0, s1) in enumerate(zip(edges, edges[1:])):
                s0, s1 = s0 + (0.0015 if i else 0), s1 - (0.0015 if i < panes - 1 else 0)
                rail = 0.06 if i == fixed_i else 0.12
                B(s0, s0 + fr, mid0, mid1, 0, top - 0.003, fm)
                B(s1 - fr, s1, mid0, mid1, 0, top - 0.003, fm)
                B(s0 + fr, s1 - fr, mid0, mid1, 0, rail, fm)
                if head < cut:
                    B(s0 + fr, s1 - fr, mid0, mid1, head - fr, head, fm)
                B(s0 + fr, s1 - fr, mid0 + 0.03, mid0 + 0.036, rail, top - fr, "glass")
                if i == leaves[-1]:  # the handle: on the meeting stile of the leaf that opens, inside and out
                    hu = s0 + fr * 0.45 if len(leaves) > 1 else s1 - fr * 0.45
                    for v0, v1 in ((mid0 - 0.012, mid0), (mid1, mid1 + 0.012)):
                        B(hu - 0.014, hu + 0.014, v0, v1, 0.98, 1.2, "chrome")
                    for v0, v1 in ((mid0 - 0.05, mid0 - 0.012), (mid1 + 0.012, mid1 + 0.05)):
                        B(hu - 0.01, hu + 0.01, v0, v1, 1.1, 1.12, "chrome")
                    for v0, v1 in ((mid0 - 0.05, mid0 - 0.03), (mid1 + 0.03, mid1 + 0.05)):
                        B(hu + 0.01, hu + 0.12, v0, v1, 1.1, 1.12, "chrome")
        else:
            B(a - 0.02, a + 0.02, q0 - 0.01, q1 + 0.01, 0, top, "frame")
            B(b - 0.02, b + 0.02, q0 - 0.01, q1 + 0.01, 0, top, "frame")
            B(a + 0.02, b - 0.02, mid0, mid0 + 0.06, 0, min(top, 2.15), "front_door")
            B(a + 0.15, a + 0.3, mid0 - 0.005, mid0, 0.3, min(top, 2.0), "glass")
        return
    # frame: a jamb on each side (lining plus a 6 cm casing on both faces, one block), the head lined and cased too;
    # everything stops just under a cut wall's top so no face lies in its cap
    zc = min(head, cut - 0.005)
    cas = 0.06
    B(a - cas, a + JAMB, q0 - PROUD, q1 + PROUD, 0, zc, "frame")
    B(b - JAMB, b + cas, q0 - PROUD, q1 + PROUD, 0, zc, "frame")
    if head < cut - 0.01:
        B(a + JAMB, b - JAMB, q0 - PROUD * 0.5, q1 + PROUD * 0.5, head - 0.02, head, "frame")
        for v0, v1 in ((q0 - PROUD, q0), (q1, q1 + PROUD)):
            B(a - cas, b + cas, v0, v1, head, min(head + cas, cut - 0.005), "frame")
    hinge, side, is_open = plan or ("a", 1, False)
    z0, z1 = 0.015, min(2.05, head - 0.025, cut - 0.005)
    L = width - 2 * JAMB - 0.005
    uh = a + JAMB if hinge == "a" else b - JAMB
    du = 1 if hinge == "a" else -1
    face = w["at"] + side * (t / 2 + PROUD)
    c = w["at"] + off0 + t / 2
    lk = Kit() if leaf_to else k  # the leaf and its handle: an object of their own, so the 3D view can swing it

    def BL(p0, p1, q0, q1, z_0, z_1, m):
        if z_1 - z_0 < 0.003:
            return
        if w["along"] == "x":
            wbox(lk, p0, p1, q0, q1, base + z_0, base + z_1, m)
        else:
            wbox(lk, q0, q1, p0, p1, base + z_0, base + z_1, m)

    if is_open:
        u0, u1 = sorted((uh, uh + du * LEAF_T))
        v0, v1 = sorted((face, face + side * L))
        BL(u0, u1, v0, v1, z0, z1, "door")
        # the handle, on the far edge, both faces
        hv0, hv1 = sorted((face + side * (L - 0.07), face + side * (L - 0.05)))
        for p0, p1 in ((u0 - 0.05, u0), (u1, u1 + 0.05)):
            BL(p0, p1, hv0, hv1, 1.0, 1.02, "chrome")
    else:
        BL(a + JAMB, b - JAMB, c - LEAF_T / 2, c + LEAF_T / 2, z0, z1, "door")
        hu0, hu1 = sorted((b - JAMB - 0.07, b - JAMB - 0.05)) if hinge == "a" else sorted((a + JAMB + 0.05, a + JAMB + 0.07))
        for p0, p1 in ((c - LEAF_T / 2 - 0.05, c - LEAF_T / 2), (c + LEAF_T / 2, c + LEAF_T / 2 + 0.05)):
            BL(hu0, hu1, p0, p1, 1.0, 1.02, "chrome")
    if not leaf_to:
        return
    # the two poses of the leaf, as (hinge-end centre, direction) in plan x/y: closed in the frame, open flat against a wall
    xy = (lambda u, v: (u, v)) if w["along"] == "x" else (lambda u, v: (v, u))
    closed = (xy(uh, c), xy(du, 0))
    opened = (xy(uh + du * LEAF_T / 2, face), xy(0, side))
    (ea, da), (eb, db) = (opened, closed) if is_open else (closed, opened)
    th = math.atan2(da[0] * db[1] - da[1] * db[0], da[0] * db[0] + da[1] * db[1])  # the turn from the drawn pose to the other
    ct, st = math.cos(th), math.sin(th)
    # pivot P: P + R(ea - P) = eb  ->  (I - R) P = eb - R ea
    rx, ry = ct * ea[0] - st * ea[1], st * ea[0] + ct * ea[1]
    m00, m01, m10, m11 = 1 - ct, st, -st, 1 - ct
    det = m00 * m11 - m01 * m10
    rhs = (eb[0] - rx, eb[1] - ry)
    px, py = ((m11 * rhs[0] - m01 * rhs[1]) / det, (-m10 * rhs[0] + m00 * rhs[1]) / det)
    ob = lk.to_object(leaf_to["name"], collection=leaf_to["coll"], bevel=0.004)
    DOORS[ob.name] = {"x": X(px), "y": py, "angle": round(-th if MIRROR else th, 5), "open": bool(is_open),
                      "hinge": ("-" if hinge == "a" else "+") + w["along"], "into": ("+" if side > 0 else "-") + ("y" if w["along"] == "x" else "x")}


def attic_roof(f, roof, base, coll):
    """The roof's slopes and the gable walls, cut at the attic's view height, so it reads like the plan's section."""
    eave = roof.get("eave", 0.4)
    ridge = roof["ridge"]
    y0, y1 = roof.get("from", 0) - WO, roof.get("to", f["depth"]) + WO
    mid = (y0 + y1) / 2
    s = (ridge - eave) / (mid - y0)
    cut = min(CUT, 1.6)
    th = 0.24
    x0, x1 = sorted((X(-WO - 0.05), X(W + WO + 0.05)))
    k = Kit()
    bm = k.bm
    for sgn, ye in ((1, y0), (-1, y1)):
        c = cut if sgn > 0 else min(cut, JOB.get("near_roof_cut", 0.75))  # the garden-side slope faces the camera
        yc = ye + sgn * max(0.0, (c - eave) / s)  # where the slope reaches the cut height
        yo = ye - sgn * 0.35                          # the overhang
        z = lambda y: base + eave + s * (y - ye) * sgn
        pts = [(yo, z(yo)), (yc, z(yc))]
        top = [bm.verts.new((x, y, zz)) for (y, zz) in pts for x in (x0, x1)]
        bot = [bm.verts.new((x, y, zz - th)) for (y, zz) in pts for x in (x0, x1)]
        faces = [((top[0], top[1], top[3], top[2]), "roof_tiles"), ((bot[0], bot[2], bot[3], bot[1]), "plaster"),
                 ((top[0], bot[0], bot[1], top[1]), "frame"), ((top[2], top[3], bot[3], bot[2]), "cap"),
                 ((top[0], top[2], bot[2], bot[0]), "slab"), ((top[1], bot[1], bot[3], top[3]), "slab")]
        for vs, m in faces:
            bm.faces.new(vs).material_index = k.slot(m)
    k.to_object(f"{f['id']}_roof", collection=coll)
    # the gable (party) walls follow the roof line up to the cut, full depth
    g = Kit()
    zr = lambda y: eave + s * (min(y - y0, y1 - y))

    def outline(c):
        # up to the roof's underside, so the gable's top never lies in the plane of the tiles
        e = eave - th
        poly = [(y0, 0.0), (y0, min(c, e))]
        if c > e:
            for y in sorted({y0 + (c - e) / s, y1 - (c - e) / s}):
                poly.append((y, min(c, zr(y) - th)))
        return poly + [(y1, min(c, e)), (y1, 0.0)]

    for xa, xb in ((-WO, 0), (W, W + WO)):
        near = (X((xa + xb) / 2) - W / 2) * CAM_SIDE > 0
        poly = outline(min(cut, NEAR_CUT) if near else cut)
        a, b = sorted((X(xa), X(xb)))
        out_lo = X(xa) < X(0) if xa < 0 else X(xb) < X(W)  # which x side faces out
        layers = ((a, a + 0.1, "brick"), (a + 0.1, b, "plaster")) if out_lo else ((a, b - 0.1, "plaster"), (b - 0.1, b, "brick"))
        for la, lb, m in layers:
            before = len(g.bm.verts)
            g.prism([(yy, zz) for yy, zz in poly], la, lb, m, top=m)
            for v in list(g.bm.verts)[before:]:
                yy, zz, xx = v.co
                v.co = (xx, yy, base + zz)
    g.to_object(f"{f['id']}_gables", collection=coll)


# ---------------------------------------------------------------- furniture
ASSETS = {}
STAIRS = {}


def asset(key):
    """Import a Poly Haven model once; later uses link its meshes again (instances, cheap)."""
    spec = JOB.get("models", {}).get(key)
    if not spec:
        return None
    if key in ASSETS:
        return ASSETS[key]
    path = os.path.join(CACHE, "models", spec["id"], spec["id"] + ".gltf")
    if not os.path.exists(path):
        log("missing asset", key, path)
        ASSETS[key] = None
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    lib = bpy.data.collections.get("_assets") or bpy.data.collections.new("_assets")
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        lib.objects.link(o)
        o.hide_render = True
        o.hide_viewport = True
    ASSETS[key] = [o for o in new if o.type == "MESH"]
    return ASSETS[key]


def place_asset(key, matrix, coll, name, yaw=math.pi, scale=(1, 1, 1), offset=(0, 0, 0)):
    """Instances of a model's meshes under `matrix`. Poly Haven models face -Y; our furniture faces +Y: yaw pi."""
    obs = asset(key)
    if not obs:
        return False
    local = Matrix.Translation(offset) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Diagonal((*scale, 1))
    for o in obs:
        c = bpy.data.objects.new(f"{name}_{o.name}", o.data)
        c.matrix_world = matrix @ local @ o.matrix_world
        coll.objects.link(c)
    return True


DEFAULTS = {"counter": (2.0, 0.62), "hob": (0.6, 0.52), "sink": (0.5, 0.42), "fridge": (0.6, 0.62), "dining-table": (0.9, 1.6), "chair": (0.45, 0.55),
            "sofa": (2.2, 0.92), "armchair": (0.9, 0.9), "coffee-table": (1.2, 0.6), "tv-unit": (1.8, 0.42), "rug": (2.0, 2.6), "plant": (0.6, 0.6),
            "floor-lamp": (0.4, 0.4), "coat-rack": (0.9, 0.3), "wc": (0.38, 0.55), "basin": (0.4, 0.26), "vanity": (1.0, 0.5), "shower": (0.9, 0.9),
            "bath": (1.7, 0.75), "bed": (1.6, 2.05), "cot": (1.24, 0.66), "wardrobe": (1.2, 0.6), "nightstand": (0.45, 0.4), "desk": (1.4, 0.7),
            "office-chair": (0.6, 0.6), "washer": (0.6, 0.6), "dryer": (0.6, 0.6), "boiler": (0.45, 0.35), "stairs": (0.98, 3.2), "railing": (1.0, 0.05), "box": (0.5, 0.5),
            "sofa-u": (3.0, 2.2), "bookshelf": (1.6, 0.36),
            "shelf-wall": (4.0, 0.36), "shelf-open": (0.45, 0.35), "cabinet": (0.9, 0.45), "air-purifier": (0.3, 0.3),
            "coffee-table-round": (0.9, 0.9), "side-table-round": (0.42, 0.42), "armchair-wing": (0.74, 0.8), "footstool": (0.5, 0.5),
            "rug-shag": (2.0, 1.6), "curtain": (0.6, 0.06), "pendant-capiz": (0.5, 0.5),
            "paint": (1.0, 0.006), "wall-tiles": (1.0, 0.012), "bed-box": (1.6, 2.12), "bed-day": (2.0, 0.95), "nightstand-white": (0.4, 0.48),
            "cot-sleeper": (0.92, 0.56), "baby-monitor": (0.24, 0.24), "trolley": (0.45, 0.36), "wardrobe-sliding": (2.0, 0.62),
            "wardrobe-panel": (0.9, 0.55), "mirror-wall": (0.38, 0.03), "dressing-table": (0.9, 0.42), "radiator-cover": (2.0, 0.26),
            "radiator": (0.6, 0.1), "towel-radiator": (0.5, 0.08), "roller-blind": (1.0, 0.05), "pendant-cylinder": (0.24, 0.24),
            "pendant-globe": (0.45, 0.45), "pendant-dome": (0.4, 0.4), "frames": (1.0, 0.03), "dresser-changing": (1.0, 0.5),
            "wall-shelf": (0.7, 0.18), "desk-work": (1.6, 0.7), "desk-white": (1.5, 0.6), "desk-lamp-arch": (0.5, 0.2),
            "office-chair-mesh": (0.64, 0.64), "guitar": (0.4, 0.12), "shower-black": (1.0, 0.9), "wc-wall": (0.6, 0.74),
            "bath-tiled": (1.8, 0.78), "vanity-white": (0.8, 0.46), "hamper": (0.4, 0.35),
            "display-tower": (0.6, 0.42), "buffet": (1.3, 0.5), "robot-dock": (0.36, 0.5), "kitchen-tall": (0.6, 0.62),
            "wall-cabinets": (1.0, 0.35), "hood": (0.9, 0.5), "track-spots": (1.0, 0.04), "chair-shell": (0.48, 0.55),
            "pendant-smoke": (0.3, 0.3), "gallery": (2.4, 0.03), "painting": (0.75, 0.04), "plant-stand": (0.4, 0.4)}


def tone(hexs, rough=0.9, kind="paint", **kw):
    """A flat material of an sRGB hex colour (a piece's `color`), made once per colour."""
    h = hexs.lstrip("#").lower()
    key = f"{kind}_{h}"
    if key not in MATS:
        principled(key, tuple(srgb_to_lin(int(h[i:i + 2], 16)) for i in (0, 2, 4)), rough=rough, **kw)
    return key


def piece_matrix(it, base):
    """A piece's frame on the plan (see furnish): x across it, y the way it faces, z up."""
    return Matrix.Translation(P(it["x"], it["y"], base)) @ (Matrix.Diagonal((-1, 1, 1, 1)) if MIRROR else Matrix.Identity(4)) @ Matrix.Rotation(math.radians(it.get("rot", 0)), 4, "Z")


def furnish(it, base, coll, name, zmin=None, zmax=None):
    """One piece of furniture. zmin/zmax (stairs only): keep the steps between those heights above `base` (a storey's
    stairs stop at its cut height; the flight seen down a stairwell starts at the well's floor)."""
    t = it["type"]
    dw, dd = DEFAULTS.get(t, (0.5, 0.5))
    w, d = it.get("w", dw), it.get("d", dd)
    rot = math.radians(it.get("rot", 0))
    # local frame: x across, y = facing direction (+y is the front), z up; rot turns it on the plan
    M = piece_matrix(it, base)
    # rot follows the plan convention (x right, y towards the garden), which in Blender's right-handed XY is a
    # rotation by +rot about Z; a mirrored house flips the placed piece as a whole
    k = Kit()
    x0, x1, y0, y1 = -w / 2, w / 2, -d / 2, d / 2
    bev = 0.006
    segs, smooth = 2, False
    if t == "counter":
        # base units: white fronts (a drawer over a door, or two deep drawers) with long black bar handles, a dark stone
        # top; `wine` ("-x" / "+x") puts a 60 cm wine cooler (black glass door) at that end; `fronts` sets the unit count
        k.box(x0 + 0.0, x1, y0, y1 - 0.06, 0, 0.1, "anthracite")
        wine = it.get("wine")
        n = it.get("fronts") or max(1, round(w / 0.6))
        edges = [x0 + w * i / n for i in range(n + 1)]
        if wine:
            edges = ([x0, x0 + 0.6] + [x0 + 0.6 + (w - 0.6) * i / (n - 1) for i in range(1, n)]) if wine == "-x" else \
                    ([x0 + (w - 0.6) * i / (n - 1) for i in range(n)] + [x1])
        for i, (a, b) in enumerate(zip(edges, edges[1:])):
            cooler = wine and ((wine == "-x" and i == 0) or (wine == "+x" and i == n - 1))
            if cooler:
                k.box(a + 0.002, b - 0.002, y0, y1 - 0.04, 0.1, 0.86, "anthracite")
                k.box(a + 0.01, b - 0.01, y1 - 0.04, y1 - 0.02, 0.1, 0.855, "black_glass")
                continue
            k.box(a + 0.002, b - 0.002, y0, y1 - 0.02, 0.1, 0.86, "white_matte")
            for z in ((0.8,) if (b - a) < 0.5 else (0.8, 0.5)):  # a drawer line and its bar handle
                k.box(a + 0.004, b - 0.004, y1 - 0.0205, y1 - 0.0195, z - 0.12, z - 0.115, "anthracite")
                k.box(a + 0.08, b - 0.08, y1 - 0.02, y1 - 0.004, z - 0.03, z - 0.018, "black_metal")
        k.box(x0, x1, y0, y1 + 0.02, 0.86, 0.9, "stone_dark")
        bev = 0.004
    elif t == "hob":
        k.box(x0, x1, y0, y1, 0.9, 0.906, "black_glass")
        for cx, cy, r in ((-0.15, -0.1, 0.09), (0.15, -0.1, 0.07), (-0.15, 0.13, 0.07), (0.15, 0.13, 0.1)):
            k.cyl(cx, cy, 0.906, 0.909, r, "anthracite", seg=32)
        bev = 0.002
    elif t == "sink":
        k.tub(x0, x1, y0 + 0.02, y1 - 0.02, 0.88, 0.905, 0.025, 0.18, "steel")
        k.cyl(0, y0 - 0.0, 0.905, 1.2, 0.015, "chrome", seg=12)
        k.box(-0.012, 0.012, y0, y0 + 0.2, 1.17, 1.2, "chrome")
        bev = 0.003
    elif t == "fridge":
        k.box(x0, x1, y0, y1 - 0.02, 0, 0.1, "anthracite")
        k.box(x0, x1, y0, y1, 0.1, 1.2, "white")
        k.box(x0, x1, y0, y1, 1.205, 2.2, "white")
        k.box(x1 - 0.06, x1 - 0.045, y1, y1 + 0.025, 0.9, 1.6, "steel")
        if it.get("magnets"):  # a door covered in souvenir magnets
            seed = int(it["x"] * 31 + it["y"] * 17)
            cols = ["duvet_rust", "coat_blue", "coat_camel", "vase_pink", "coat_green", "brass", "linen", "ink"]
            for zi in range(16):
                for xi in range(7):
                    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
                    if (seed >> 9) % 5 == 0:
                        continue
                    z = (1.25 if zi < 10 else 0.55) + (zi % 10) * 0.065
                    cx, s = x0 + 0.06 + xi * (w - 0.2) / 6, 0.022 + (seed >> 4) % 3 * 0.006  # clear of the handle
                    k.box(cx - s, cx + s, y1, y1 + 0.006, z - s, z + s, cols[(seed >> 6) % len(cols)])
    elif t == "dining-table":
        if it.get("pendant", True):  # a pendant over the table, unless the room has its own lights placed
            place_asset("pendant", M, coll, name + "_pendant", offset=(0, 0, CEIL - 1.17))
        k.box(x0, x1, y0, y1, 0.72, 0.76, "oak_furn")
        for sx in (x0 + 0.06, x1 - 0.1):
            for sy in (y0 + 0.06, y1 - 0.1):
                k.box(sx, sx + 0.04, sy, sy + 0.04, 0, 0.72, "black_metal")
        bev = 0.004
    elif t == "chair":
        if place_asset("dining-chair", M, coll, name):
            return
        k.box(x0, x1, y0, y1, 0.44, 0.48, "oak_furn")
        k.box(x0, x1, y0, y0 + 0.04, 0.48, 0.9, "oak_furn")
    elif t == "sofa":
        legs = 0.12
        k.box(x0 + 0.02, x1 - 0.02, y0 + 0.04, y1 - 0.04, legs, 0.24, "upholstery")
        for i in range(3):
            a, b = x0 + 0.2 + (w - 0.4) * i / 3, x0 + 0.2 + (w - 0.4) * (i + 1) / 3
            k.box(a + 0.008, b - 0.008, y0 + 0.24, y1 - 0.01, 0.24, 0.44, "fabric")
            k.box(a + 0.008, b - 0.008, y0 + 0.02, y0 + 0.26, 0.44, 0.82, "fabric")
        k.box(x0, x0 + 0.2, y0, y1, legs, 0.62, "fabric")
        k.box(x1 - 0.2, x1, y0, y1, legs, 0.62, "fabric")
        k.box(x0, x1, y0, y0 + 0.05, legs, 0.62, "upholstery")
        for sx in (x0 + 0.05, x1 - 0.09):
            for sy in (y0 + 0.06, y1 - 0.1):
                k.box(sx, sx + 0.04, sy, sy + 0.04, 0, legs, "walnut")
        bev = 0.035
        place_asset("pillows", M, coll, name + "_p", offset=(x0 + 0.62, y0 + 0.32, 0.44), scale=(0.9, 0.9, 0.9), yaw=math.pi * 1.02)
    elif t == "sofa-u":
        # a U of soft, rounded modules (the living room's): the backs run along the back (-y) and up the +x arm, which
        # ends in a backless rounded ottoman; the -x end is a long chaise with a low roll on its outer side. Modules
        # stand 1 cm apart (seams), so no two faces share a plane.
        base_h, seat, top, bk = 0.09, 0.43, 0.8, 0.26
        sd = min(0.98, w / 3, d / 2)
        ot = min(0.8, d - sd - 0.3)  # the ottoman's length
        cw = min(0.95, w / 3)        # the chaise's width
        g = 0.006
        k.rbox(x0 + 0.05, x1 - 0.05, y0 + 0.05, y0 + sd - 0.05, 0, base_h, 0.05, "sofa_base")  # the recessed plinths
        k.rbox(x1 - sd + 0.05, x1 - 0.05, y0 + sd - 0.06, y1 - 0.05, 0, base_h, (0.05, 0.25, 0.05, 0.05), "sofa_base")
        k.rbox(x0 + 0.05, x0 + cw - 0.05, y0 + sd - 0.06, y1 - 0.15, 0, base_h, (0.3, 0.3, 0.05, 0.05), "sofa_base")
        n = max(1, round((x1 - bk - x0) / 0.95))                           # the backs along -y
        for i in range(n):
            a0, a1 = x0 + (x1 - bk - x0) * i / n, x0 + (x1 - bk - x0) * (i + 1) / n
            k.rbox(a0 + g, a1 - g, y0, y0 + bk, base_h - 0.01, top, (0.08, 0.08, 0.12 if i == 0 else 0.03, 0.03), "sofa_fabric")
        k.rbox(x1 - bk + g, x1, y0, y1 - ot - g, base_h - 0.01, top, (0.1, 0.03, 0.03, 0.12), "sofa_fabric")  # the arm's back
        m = max(1, round((x1 - bk - x0 - cw) / 0.9))                       # seats along the back
        for i in range(m):
            a0 = x0 + cw + (x1 - bk - x0 - cw) * i / m
            a1 = x0 + cw + (x1 - bk - x0 - cw) * (i + 1) / m
            k.rbox(a0 + g, a1 - g, y0 + bk + g, y0 + sd, base_h - 0.01, seat, 0.06, "sofa_fabric")
        j = max(1, round((y1 - ot - y0 - sd) / 0.8))                        # seats up the +x arm
        for i in range(j):
            b0 = y0 + sd + (y1 - ot - y0 - sd) * i / j
            b1 = y0 + sd + (y1 - ot - y0 - sd) * (i + 1) / j
            k.rbox(x1 - sd, x1 - bk - g, b0 + g, b1 - g, base_h - 0.01, seat, 0.06, "sofa_fabric")
        k.rbox(x1 - sd, x1, y1 - ot, y1, base_h - 0.01, seat, (0.34, 0.34, 0.08, 0.08), "sofa_fabric")  # the ottoman
        k.rbox(x0, x0 + cw - g, y0 + bk + g, y1 - 0.08, base_h - 0.01, seat, (0.4, 0.4, 0.06, 0.06), "sofa_fabric")  # chaise
        k.rbox(x0 + 0.015, x0 + 0.22, y0 + bk + 0.02, y0 + bk + 0.75, seat - 0.004, seat + 0.17, (0.1, 0.1, 0.04, 0.04), "sofa_fabric")
        bev, segs, smooth = 0.065, 4, True
        place_asset("pillows", M, coll, name + "_p", offset=(x0 + cw + 0.45, y0 + bk + 0.12, seat), scale=(0.9, 0.9, 0.9), yaw=math.pi * 1.02)
    elif t == "shelf-wall":
        # a built-in shelving wall, painted: a back panel, uprights of varied spacing, shelves at their own heights per
        # compartment, a radiator in one, and books, frames, vases and figurines as simple shapes. The compartments
        # ([width, shelf heights, radiator], from the -x end) are the living room's own wall, scaled to w.
        h = it.get("h", 2.4)
        cols = [[1.9, [1.3, 2.02], True], [0.8, [0.55, 1.18, 1.75]], [0.65, [0.62, 1.25, 2.05]], [0.85, [1.3, 2.05]]]
        up, sh, cap = 0.04, 0.035, 0.05
        scale = (w - up * (len(cols) + 1)) / sum(c[0] for c in cols)
        # parts that meet overlap a little or stand a few mm apart, so no two faces share a plane
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.003, y0 + 0.02, 0, h - cap + 0.004, "sage")  # back panel
        k.box(x0 + 0.002, x1 - 0.002, y0 + 0.007, y1 + 0.003, h - cap, h, "sage")        # top
        xs = x0
        seed = int(it["x"] * 17 + it["y"] * 5)

        def rnd():
            nonlocal seed
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            return (seed >> 8) % 1000 / 1000

        books = ["coat_blue", "duvet_rust", "linen", "coat_green", "walnut", "coat_camel", "white", "anthracite", "duvet_sage"]
        for ci, c in enumerate(cols):
            k.box(xs, xs + up, y0 + 0.005, y1, 0, h - cap + 0.002, "sage")            # upright
            a0, a1 = xs + up, xs + up + c[0] * scale
            xs = a1
            radiator = len(c) > 2 and c[2]
            levels = ([] if radiator else [0.0]) + list(c[1])
            if not radiator:
                k.box(a0 - 0.002, a1 + 0.002, y0 + 0.018, y1 - 0.01, 0, 0.08, "sage")  # plinth board
            for z in c[1]:
                k.box(a0 - 0.002, a1 + 0.002, y0 + 0.018, y1 - 0.005, z - sh, z, "sage")
            if radiator:
                ra0, ra1 = a1 - min(1.15, (a1 - a0) * 0.62), a1 - 0.08
                k.box(ra0, ra1, y0 + 0.05, y0 + 0.11, 0.15, 0.85, "white")
                n = int((ra1 - ra0) / 0.035)
                for i in range(n):
                    rx = ra0 + 0.01 + (ra1 - ra0 - 0.02) * i / n
                    k.box(rx, rx + 0.012, y0 + 0.11, y0 + 0.125, 0.17, 0.83, "white")
                for lx in (ra0 + 0.05, ra1 - 0.07):
                    k.cyl(lx + 0.01, y0 + 0.08, 0.08, 0.15, 0.01, "chrome", seg=8)
            # what stands on each shelf
            tops = [z for z in levels if z + 0.25 < h - cap]
            for li, z in enumerate(tops):
                z = z + (0.08 if z == 0.0 else 0.0)
                if radiator and z < 0.9:
                    continue
                kind = (ci * 3 + li) % 4
                x = a0 + 0.04 + rnd() * 0.1
                while x < a1 - 0.12:
                    r = rnd()
                    if kind == 0:   # a row of books
                        n = 5 + int(r * 10)
                        for _ in range(n):
                            bw = 0.022 + rnd() * 0.03
                            if x + bw > a1 - 0.03:
                                break
                            bh = 0.19 + rnd() * 0.1
                            k.box(x, x + bw, y0 + 0.06, y0 + 0.06 + 0.15 + rnd() * 0.06, z, z + bh, books[int(rnd() * len(books))])
                            x += bw + 0.002
                        x += 0.12 + rnd() * 0.25
                        kind = 1
                    elif kind == 1:  # a framed photo, leaning
                        fw, fh = 0.18 + r * 0.12, 0.22 + rnd() * 0.08
                        k.box(x, x + fw, y0 + 0.04, y0 + 0.06, z, z + fh, "black_metal" if r > 0.4 else "white")
                        k.box(x + 0.025, x + fw - 0.025, y0 + 0.06, y0 + 0.062, z + 0.025, z + fh - 0.025, "linen")
                        x += fw + 0.1 + rnd() * 0.2
                        kind = 2
                    elif kind == 2:  # a vase
                        rr = 0.04 + r * 0.03
                        k.lathe(x + rr, y0 + 0.16, [(rr * 0.6, z), (rr, z + 0.06), (rr * 0.9, z + 0.13), (rr * 0.4, z + 0.18), (rr * 0.45, z + 0.2)], "vase_pink" if r > 0.5 else "ceramic", seg=12)
                        x += 2 * rr + 0.12 + rnd() * 0.15
                        kind = 3
                    else:            # figurines
                        for _ in range(2 + int(r * 2)):
                            k.cyl(x + 0.02, y0 + 0.15, z, z + 0.1 + rnd() * 0.08, 0.018, "figure", seg=8)
                            x += 0.06
                        x += 0.15 + rnd() * 0.2
                        kind = 0
        k.box(xs, xs + up, y0 + 0.005, y1, 0, h - cap + 0.002, "sage")                # last upright
        bev = 0.004
    elif t == "shelf-open":
        # a tall, narrow open shelf unit (white), a back panel and a few things on it
        h = it.get("h", 1.85)
        n = max(2, round(h / 0.38))
        k.box(x0, x0 + 0.025, y0, y1, 0, h, "white")
        k.box(x1 - 0.025, x1, y0, y1, 0, h, "white")
        k.box(x0 + 0.023, x1 - 0.023, y0, y0 + 0.012, 0, h - 0.025, "white")
        for i in range(n + 1):
            z = 0.04 + (h - 0.065) * i / n
            k.box(x0 + 0.023, x1 - 0.023, y0 + 0.01, y1, z, z + 0.025, "white")
            if 0 < i < n and i % 2:
                k.lathe(x0 + w * 0.35, 0, [(0.04, z + 0.025), (0.055, z + 0.09), (0.03, z + 0.17)], "ceramic", seg=18)
            elif 0 < i < n:
                k.box(x0 + 0.06, x0 + 0.2, y0 + 0.05, y0 + 0.25, z + 0.025, z + 0.06, "linen")
        bev = 0.003
    elif t == "cabinet":
        # a white cabinet with panel doors and knobs
        h = it.get("h", 0.95)
        k.box(x0 + 0.03, x1 - 0.03, y0, y1 - 0.04, 0, 0.07, "white_matte")
        k.box(x0, x1, y0, y1 - 0.02, 0.07, h, "white")
        nd = max(1, round(w / 0.45))
        for i in range(nd):
            a, b = x0 + w * i / nd, x0 + w * (i + 1) / nd
            k.box(a + 0.004, b - 0.004, y1 - 0.02, y1, 0.075, h - 0.005, "white")
            k.box(a + 0.06, b - 0.06, y1, y1 + 0.006, 0.14, h - 0.07, "white_matte")   # the raised panel
            hx = b - 0.04 if i % 2 == 0 else a + 0.04
            k.cyl(hx, y1 + 0.02, h - 0.2, h - 0.18, 0.012, "chrome", seg=10)
        bev = 0.004
    elif t == "air-purifier":
        k.rbox(x0, x1, y0, y1, 0, 0.56, 0.07, "white_matte")
        k.cyl(0, 0, 0.56, 0.575, min(w, d) * 0.38, "anthracite", seg=32)
        bev = 0.006
    elif t == "coffee-table-round":
        # a round oak table on four legs joined by a low cross
        r = min(w, d) / 2
        k.cyl(0, 0, 0.4, 0.435, r, "oak_furn", seg=48)
        for i in range(4):
            a = math.pi / 4 + i * math.pi / 2
            k.cyl(r * 0.72 * math.cos(a), r * 0.72 * math.sin(a), 0, 0.4, 0.022, "oak_furn", seg=12)
        k.obox(0, 0, 2 * r * 0.72, 0.035, math.pi / 4, 0.08, 0.105, "oak_furn")
        k.obox(0, 0, 2 * r * 0.72, 0.035, -math.pi / 4, 0.085, 0.11, "oak_furn")
        bev = 0.005
    elif t == "side-table-round":
        r = min(w, d) / 2
        k.cyl(0, 0, 0.5, 0.525, r, "oak_furn", seg=40)
        for i in range(3):
            a = math.pi / 2 + i * 2 * math.pi / 3
            k.cyl(r * 0.62 * math.cos(a), r * 0.62 * math.sin(a), 0, 0.5, 0.016, "oak_furn", seg=10)
        k.cyl(0, 0, 0.2, 0.215, r * 0.66, "oak_furn", seg=32)  # the ring shelf
        if it.get("flower"):  # an amaryllis in a pot, a woven lantern beside it
            k.lathe(-0.06, 0.04, [(0.05, 0.525), (0.075, 0.6), (0.07, 0.66)], "vase_pink", seg=16)
            k.cyl(-0.06, 0.04, 0.6, 0.98, 0.008, "leaf", seg=6)
            for i in range(4):
                a = i * math.pi / 2 + 0.4
                k.lathe(-0.06 + 0.07 * math.cos(a), 0.04 + 0.07 * math.sin(a), [(0.012, 0.95), (0.055, 1.02), (0.06, 1.04)], "bloom_red", seg=10, caps=True)
            k.cyl(0.09, -0.05, 0.525, 0.68, 0.075, "linen", seg=18)
        bev = 0.004
    elif t == "armchair-wing":
        # a bouclé wingback: a tall back with a rounded top, low rounded arms, a deep seat, slim oak legs
        for sx in (x0 + 0.08, x1 - 0.08):
            for sy in (y0 + 0.1, y1 - 0.1):
                k.cyl(sx, sy, 0, 0.2, 0.018, "oak_furn", seg=10)
        k.rbox(x0 + 0.05, x1 - 0.05, y0 + 0.08, y1, 0.2, 0.44, (0.16, 0.16, 0.06, 0.06), "boucle")
        hw, zs, zt = w / 2 - 0.02, 0.86, 1.06
        back = [(-hw, 0.2), (hw, 0.2)] + [(hw * math.cos(a), zs + (zt - zs) * math.sin(a)) for a in (math.pi * i / 12 for i in range(13))]
        k.prism_xz([(x, max(z, 0.21)) for x, z in back], y0, y0 + 0.17, "boucle")
        for a0, a1 in ((x0, x0 + 0.12), (x1 - 0.12, x1)):
            k.rbox(a0, a1, y0 + 0.165, y1 - 0.12, 0.43, 0.64, (0.06, 0.06, 0.02, 0.02), "boucle")  # the arms
        bev, segs, smooth = 0.04, 4, True
    elif t == "footstool":
        # a bouclé pouf on four tapered oak legs: round, or a soft rectangle (shape "square") with magazines on it
        r = min(w, d) / 2
        if it.get("shape") == "square":
            for sx in (x0 + 0.07, x1 - 0.07):
                for sy in (y0 + 0.07, y1 - 0.07):
                    k.cyl(sx, sy, 0, 0.16, 0.016, "oak_furn", seg=10)
            k.rbox(x0, x1, y0, y1, 0.16, 0.44, 0.08, "boucle")
            k.box(-0.15, 0.13, -0.11, 0.1, 0.44, 0.455, "paper")
            k.box(-0.13, 0.15, -0.09, 0.12, 0.455, 0.465, "duvet_rust")
        else:
            for i in range(4):
                a = math.pi / 4 + i * math.pi / 2
                k.cyl(r * 0.7 * math.cos(a), r * 0.7 * math.sin(a), 0, 0.15, 0.015, "oak_furn", seg=10)
            k.cyl(0, 0, 0.15, 0.42, r, "boucle", seg=40)
        bev, segs, smooth = 0.06, 4, True
    elif t == "rug-shag":
        k.rbox(x0, x1, y0, y1, 0.014, 0.045, 0.03, tone(it["color"], 1.0, "shag", **{"Sheen Weight": 0.8}) if it.get("color") else "shag")
        bev = 0.012
    elif t == "curtain":
        # sheer curtains hanging in soft folds from a rod under the ceiling, w along the rod
        h = it.get("h", CEIL - 0.06)
        # (2026-11-01) real pleats: a wave of about 11 cm with slightly uneven depth, 4 mm thick, smooth shaded
        n = max(12, int(w / 0.012))
        seed = int(abs(it["x"]) * 97 + abs(it["y"]) * 31)
        amp = lambda i: 0.032 * (0.75 + 0.25 * math.sin(i * 0.37 + seed))
        pts = [(x0 + w * i / n, amp(i) * math.sin(2 * math.pi * (w * i / n) / 0.11)) for i in range(n + 1)]
        poly = [(x, y + 0.002) for x, y in pts] + [(x, y - 0.002) for x, y in reversed(pts)]
        if it.get("color"):
            hx = it["color"].lstrip("#").lower()
            mat = f"curtain_{hx}"
            if mat not in MATS:
                rgb = tuple(srgb_to_lin(int(hx[i:i + 2], 16)) for i in (0, 2, 4))
                textured(mat, JOB.get("textures", {}).get("linen", "rough_linen"), bump=0.5, wash=(rgb, 0.7), ao=0.5, **{"Sheen Weight": 0.5})
        else:
            mat = "sheer"
        k.prism(poly, 0.03, h, mat)
        k.box(x0 - 0.05, x1 + 0.05, -0.012, 0.012, h + 0.01, h + 0.035, "white_matte")  # the rail
        bev, smooth = 0.0, True
    elif t == "pendant-capiz":
        # a capiz shell pendant: tiers of pearly shells widening downwards, on a cord from the ceiling
        drop = it.get("h", 0.75)
        zt = CEIL - drop
        k.cyl(0, 0, zt + 0.42, CEIL, 0.004, "black_metal", seg=6)
        k.cyl(0, 0, CEIL - 0.02, CEIL - 0.001, 0.05, "white_matte", seg=20)
        # one closed bell, its profile stepping out in skirts (the shell tiers), so it reads solid from any side
        tiers = 5
        prof = [(0.17, zt + 0.03)]
        for i in reversed(range(tiers)):
            r = 0.09 + 0.033 * i
            z = zt + 0.07 * (tiers - 1 - i)
            prof += [(r + 0.008, z, 0.018), (r - 0.006, z + 0.075)]
        prof += [(0.04, zt + 0.42), (0.03, zt + 0.44)]
        k.lathe(0, 0, prof, "capiz", seg=72, scallops=18)
        bev = 0.0
    elif t == "bookshelf":
        # an open shelf unit, books from both sides (it can stand free as a divider)
        h = it.get("h", 1.45)
        fr = 0.025
        n = max(2, round(h / 0.36))
        cols = max(1, round(w / 0.42))
        for sx in [x0 + (w - fr) * i / cols for i in range(cols + 1)]:  # uprights
            k.box(sx, sx + fr, y0, y1, 0, h, "oak_furn")
        for j in range(n + 1):                                           # shelves
            z = 0.06 + (h - 0.06 - fr) * j / n
            for i in range(cols):
                a0, a1 = x0 + (w - fr) * i / cols + fr, x0 + (w - fr) * (i + 1) / cols
                k.box(a0, a1, y0, y1, z, z + fr, "oak_furn")
                if j == n:
                    continue
                # books: a deterministic row of spines in a few colours, some gaps
                cells = ["coat_blue", "duvet_rust", "linen", "coat_green", "walnut", "coat_camel", "white", "duvet_sage"]
                seed = int(it["x"] * 13 + it["y"] * 7) + i * 5 + j * 11
                x = a0 + 0.02
                b = 0
                while x < a1 - 0.06:
                    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
                    bw = 0.025 + (seed % 5) * 0.008
                    bh = min(0.3, (h - 0.06) / n - fr - 0.04) * (0.72 + (seed >> 4) % 4 * 0.08)
                    if (seed >> 7) % 9 == 0:
                        x += 0.07  # a gap
                        continue
                    if x + bw > a1 - 0.01:
                        break
                    k.box(x, x + bw, y0 + 0.03, y1 - 0.03, z + fr, z + fr + bh, cells[(seed >> 3) % len(cells)])
                    x += bw + 0.002
                    b += 1
        k.box(x0 + fr, x1 - fr, y0 + 0.01, y1 - 0.01, 0, 0.06, "oak_furn")  # plinth
        bev = 0.002
    elif t == "armchair":
        if place_asset("lounge-chair", M, coll, name, scale=(0.85, 0.85, 0.85)):
            return
    elif t == "coffee-table":
        if place_asset("coffee-table", M, coll, name, yaw=math.pi / 2 if w > d else 0):
            return
        k.box(x0, x1, y0, y1, 0.36, 0.4, "oak_furn")
    elif t == "tv-unit":
        # the media unit as it is: a white wall-hung row (BESTÅ-like), its frame z..z+h, 60 cm doors with a framed panel
        # front, a long soundbar and a few things on top, the TV on the wall above (tvw wide, its bottom at `tv`, moved
        # along the unit by `tvAt`). Its LED strip underneath and the TV's Ambilight are light passes (lamp_light).
        z, h = it.get("z", 0.14), it.get("h", 0.38)
        top = z + h
        k.box(x0, x1, y0, y1 - 0.02, z, top, "white")                                            # the carcass
        n = it.get("fronts") or max(2, round(w / 0.6))
        for i in range(n):
            a, b = x0 + w * i / n, x0 + w * (i + 1) / n
            k.box(a + 0.002, b - 0.002, y1 - 0.02, y1, z + 0.003, top - 0.003, "panel_white")     # the door
            k.box(a + 0.055, b - 0.055, y1, y1 + 0.004, z + 0.055, top - 0.055, "white_matte")    # its sunk panel's frame
            k.box(a + 0.07, b - 0.07, y1 + 0.004, y1 + 0.005, z + 0.07, top - 0.07, "panel_white")
        sb, tc = it.get("soundbar", 1.2), it.get("tvAt", 0.0)
        k.rbox(tc - sb / 2, tc + sb / 2, y1 - 0.2, y1 - 0.08, top, top + 0.085, 0.04, "white_matte")  # under the TV
        k.rbox(x1 - 0.55, x1 - 0.2, y0 + 0.08, y0 + 0.3, top, top + 0.11, 0.01, "anthracite")    # a games console
        for i, m in enumerate(("coat_blue", "linen", "duvet_rust")):                              # a stack of books
            k.box(x0 + 0.5, x0 + 0.75 - i * 0.02, y0 + 0.12, y0 + 0.32, top + i * 0.03, top + (i + 1) * 0.03 - 0.002, m)
        tvw = it.get("tvw", min(1.45, w * 0.72))
        tvh = tvw * 0.5625
        tz = it.get("tv", 0.85)
        k.box(tc - 0.2, tc + 0.2, y0 + 0.004, y0 + 0.03, tz + 0.1, tz + tvh - 0.1, "black_metal")  # the wall bracket
        k.box(tc - tvw / 2, tc + tvw / 2, y0 + 0.03, y0 + 0.06, tz, tz + tvh, "black_metal")
        k.box(tc - tvw / 2 + 0.008, tc + tvw / 2 - 0.008, y0 + 0.06, y0 + 0.062, tz + 0.008, tz + tvh - 0.008, "screen")
        bev = 0.002
    elif t == "display-tower":
        # a white open tower of stacked cubes (the collectibles cabinet): glass shelves halfway up each cube, small
        # figurines, souvenirs and a framed picture on them; things on top. Its inner strip lights are a light pass.
        h, cubes = it.get("h", 1.5), it.get("cubes", 2)
        sw = 0.025
        k.box(x0, x1, y0, y0 + 0.012, 0.0, h, "white")                                           # back
        k.box(x0, x0 + sw, y0, y1, 0.0, h, "white")
        k.box(x1 - sw, x1, y0, y1, 0.0, h, "white")
        ch = (h - 0.08 - sw) / cubes
        seed = int(it["x"] * 23 + it["y"] * 11)
        figs = ["figure", "brass", "duvet_rust", "coat_blue", "vase_pink", "coat_green", "ceramic", "linen"]
        for c in range(cubes + 1):
            zb = 0.08 + c * ch
            k.box(x0 + sw - 0.002, x1 - sw + 0.002, y0 + 0.01, y1, zb - sw, zb, "white")           # a board
            if c == cubes:
                break
            for zs in (zb, zb + ch / 2):                                                           # floor and glass shelf
                if zs > zb:
                    k.box(x0 + sw + 0.004, x1 - sw - 0.004, y0 + 0.02, y1 - 0.03, zs - 0.008, zs, "shelf_glass")
                x = x0 + sw + 0.05
                while x < x1 - sw - 0.06:
                    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
                    r, fh = 0.012 + (seed >> 5) % 3 * 0.006, 0.05 + (seed >> 8) % 6 * 0.025
                    k.cyl(x, y0 + 0.1 + (seed >> 3) % 3 * 0.06, zs, zs + fh, r, figs[(seed >> 11) % len(figs)], seg=8)
                    x += 2 * r + 0.035 + (seed >> 13) % 3 * 0.02
            if c == cubes - 1:  # a small framed picture leaning in the top cube
                k.box(-0.08, 0.08, y0 + 0.1, y0 + 0.115, zb + ch / 2, zb + ch / 2 + 0.17, "brass")
        k.box(x0 + 0.04, x0 + 0.22, y0 + 0.08, y0 + 0.1, h, h + 0.22, "black_metal")  # a photo frame on top
        k.lathe(x1 - 0.12, 0, [(0.05, h), (0.06, h + 0.05), (0.05, h + 0.11), (0.03, h + 0.14)], "globe", seg=16)
        bev = 0.003
    elif t == "buffet":
        # a white Dutch buffet cabinet: a base with two panel doors either side of three drawers, black knobs and cup
        # handles, a cornice-topped glazed hutch with two sliding glass doors (glasses behind)
        h, hb = it.get("h", 2.1), 0.88
        k.box(x0 + 0.03, x1 - 0.03, y0, y1 - 0.04, 0, 0.08, "white_matte")                      # plinth
        k.box(x0, x1, y0, y1 - 0.02, 0.08, hb, "white")
        k.box(x0 - 0.015, x1 + 0.015, y0, y1 + 0.015, hb, hb + 0.03, "white")                    # the base's top
        dw = w * 0.3
        for a, b in ((x0 + 0.03, x0 + 0.03 + dw), (x1 - 0.03 - dw, x1 - 0.03)):
            k.box(a, b, y1 - 0.02, y1, 0.12, hb - 0.04, "white")
            k.box(a + 0.05, b - 0.05, y1, y1 + 0.006, 0.18, hb - 0.1, "white_matte")
            k.cyl(b - 0.04 if a < 0 else a + 0.04, y1 + 0.015, 0.55, 0.57, 0.012, "black_metal", seg=10)
        for j in range(3):
            z0 = 0.13 + j * (hb - 0.17) / 3
            k.box(x0 + 0.05 + dw, x1 - 0.05 - dw, y1 - 0.02, y1, z0, z0 + (hb - 0.17) / 3 - 0.012, "white")
            k.box(-0.04, 0.04, y1, y1 + 0.02, z0 + 0.1, z0 + 0.13, "black_metal")
        hd = d * 0.55
        z0h, z1h = hb + 0.03, h - 0.1
        k.box(x0 + 0.02, x1 - 0.02, y0, y0 + 0.012, z0h, z1h, "white")                          # the hutch: back,
        for a in (x0 + 0.02, x1 - 0.045):                                                        # sides,
            k.box(a, a + 0.025, y0, y0 + hd, z0h, z1h, "white")
        k.box(x0 - 0.02, x1 + 0.02, y0, y0 + hd + 0.04, z1h, h, "white")                         # cornice
        rows = 3
        rh = (z1h - z0h - 0.08) / rows
        for r in range(rows):                                                                     # shelves, glasses on them
            zr = z0h + 0.04 + r * rh
            k.box(x0 + 0.043, x1 - 0.043, y0 + 0.01, y0 + hd - 0.03, zr - 0.02, zr, "white")
            for gi in range(int((w - 0.2) / 0.09)):
                k.cyl(x0 + 0.12 + gi * 0.09, y0 + hd * 0.45, zr, zr + 0.14, 0.03, "shower_glass", seg=10)
        for i, (a, b) in enumerate(((x0 + 0.03, 0.012), (-0.012, x1 - 0.03))):                   # two sliding glass doors
            yy = y0 + hd + (0.022 if i else 0.0)
            k.box(a, a + 0.05, yy, yy + 0.02, z0h + 0.02, z1h - 0.01, "white")
            k.box(b - 0.05, b, yy, yy + 0.02, z0h + 0.02, z1h - 0.01, "white")
            for r in range(rows + 1):
                zr = z0h + 0.02 + r * (z1h - z0h - 0.07) / rows
                k.box(a + 0.05, b - 0.05, yy, yy + 0.02, zr, zr + 0.04, "white")
            k.box(a + 0.05, b - 0.05, yy + 0.008, yy + 0.012, z0h + 0.06, z1h - 0.03, "glass")
            k.box(b - 0.03 if i == 0 else a + 0.02, (b - 0.02) if i == 0 else a + 0.03, yy + 0.02, yy + 0.03, 1.4, 1.48, "black_metal")
        bev = 0.004
    elif t == "robot-dock":
        # a robot vacuum's tall base station (white, a bronze band), the robot docked on its ramp, a bulb lamp on top
        h = it.get("h", 0.6)
        k.rbox(x0, x1, y0, y1 - 0.15, 0, h, 0.03, "white_matte")
        k.box(x0 + 0.005, x1 - 0.005, y1 - 0.152, y1 - 0.148, h * 0.25, h * 0.45, "brass")
        k.box(x0 - 0.05, x1 + 0.05, y0 + 0.1, y1 + 0.12, 0, 0.012, "white_matte")               # the ramp
        k.cyl(0, y1 - 0.02, 0.012, 0.1, 0.17, "white_matte", seg=40)                              # the robot
        k.cyl(0, y1 - 0.06, 0.1, 0.12, 0.045, "panel_white", seg=20)
        k.cyl(0.04, 0, h, h + 0.12, 0.04, "anthracite", seg=16)                                   # the lamp
        k.lathe(0.04, 0, [(0.01, h + 0.12), (0.04, h + 0.16), (0.035, h + 0.21), (0.01, h + 0.23)], "globe", seg=16)
        k.lathe(-0.07, 0.02, [(0.03, h), (0.035, h + 0.04), (0.012, h + 0.13)], "brass", seg=14)  # a bronze vase
        bev = 0.004
    elif t == "rug":
        k.box(x0, x1, y0, y1, 0.012, 0.022, tone(it["color"], 1.0, "rug", **{"Sheen Weight": 0.6}) if it.get("color") else "rug")
        bev = 0.004
    elif t == "plant":
        key = ["plant-tall", "plant-ivy"][int(it["x"] * 10 + it["y"] * 10) % 2]
        if place_asset(key, M, coll, name):
            return
    elif t == "floor-lamp":
        # a tall lamp: a round foot, a slim stem and a white drum shade
        h = it.get("h", 1.62)
        k.cyl(0, 0, 0, 0.025, 0.15, "black_metal", seg=32)
        k.cyl(0, 0, 0.025, h - 0.1, 0.012, "black_metal" if not it.get("shade") else "chrome", seg=12)
        if it.get("shade") == "box":  # the living room's: a yellow box shade, open at top and bottom
            sh = tone(it["color"], 0.9, "shade", **{"Transmission Weight": 0.3}) if it.get("color") else "shade_yellow"
            hw, hd2, z0s = 0.2, 0.14, h - 0.3
            for a0, a1, b0, b1 in ((-hw, hw, -hd2, -hd2 + 0.006), (-hw, hw, hd2 - 0.006, hd2), (-hw, -hw + 0.006, -hd2 + 0.006, hd2 - 0.006), (hw - 0.006, hw, -hd2 + 0.006, hd2 - 0.006)):
                k.box(a0, a1, b0, b1, z0s, h, sh)
        else:
            k.lathe(0, 0, [(0.22, h - 0.36), (0.22, h), (0.214, h), (0.214, h - 0.36)], "lampshade", seg=48, loop=True)
        k.cyl(0, 0, h - 0.1, h - 0.09, 0.03, "black_metal", seg=12)
        bev = 0.0
    elif t == "coat-rack":
        k.box(x0, x1, y0, y0 + 0.02, 1.62, 1.75, "oak_furn")
        for i, m in enumerate(("coat_blue", "coat_camel", "coat_green")):
            cx = x0 + 0.18 + i * (w - 0.36) / 2
            k.box(cx - 0.012, cx + 0.012, y0 + 0.02, y0 + 0.08, 1.66, 1.69, "black_metal")
            k.box(cx - 0.2, cx + 0.2, y0 + 0.03 + i * 0.012, y0 + 0.2 + i * 0.012, 0.95 + i * 0.04, 1.66 - i * 0.012, m)  # they overlap: offset
        k.box(x0 + 0.05, x1 - 0.05, y0, y0 + 0.32, 0.0, 0.42, "oak_furn")
        bev = 0.03
    elif t == "wc":
        k.box(x0 - 0.06, x1 + 0.06, y0, y0 + 0.16, 0, 1.0, "white_matte")
        k.box(-0.11, 0.11, y0 + 0.16, y0 + 0.17, 0.82, 0.97, "chrome")
        k.cyl(0, y0 + 0.36, 0.28, 0.4, 0.18, "ceramic", ry=0.23, seg=40)
        k.cyl(0, y0 + 0.36, 0.4, 0.42, 0.18, "ceramic", ry=0.23, seg=40)
        k.box(-0.17, 0.17, y0 + 0.16, y0 + 0.3, 0.28, 0.39, "ceramic")
        bev = 0.01
    elif t == "basin":
        k.tub(x0, x1, y0, y1, 0.72, 0.86, 0.03, 0.09, "ceramic")
        k.cyl(0, y0 + 0.04, 0.86, 1.0, 0.012, "chrome", seg=12)
        bev = 0.004
    elif t == "vanity":
        k.box(x0, x1, y0, y1 - 0.01, 0.38, 0.795, "oak_furn")
        k.tub(x0, x1, y0, y1, 0.8, 0.9, 0.04, 0.08, "ceramic")  # the basin stays inside its top
        k.cyl(0, y0 + 0.05, 0.9, 1.08, 0.012, "chrome", seg=12)
        k.box(x0 + 0.05, x1 - 0.05, y0, y0 + 0.012, 1.1, min(1.9, CUT), "mirror")
        bev = 0.004
    elif t == "shower":
        k.box(x0, x1, y0, y1, 0, 0.035, "ceramic")
        k.box(x0, x0 + 0.01, y0, y1, 0.035, 2.0, "shower_glass")
        k.box(x0 + 0.01, x1 - 0.35, y0, y0 + 0.01, 0.035, 2.0, "shower_glass")
        k.cyl(x1 - 0.1, y1 - 0.06, 0.8, 2.0, 0.012, "chrome", seg=12)
        k.cyl(x1 - 0.1, y1 - 0.25, 1.98, 2.0, 0.11, "chrome", seg=24)
        bev = 0.0
    elif t == "bath":
        k.tub(x0, x1, y0, y1, 0, 0.58, 0.07, 0.42, "ceramic")
        bev = 0.008
    elif t == "bed":
        frame = 0.3
        k.box(x0, x1, y0, y1, 0.08, frame, "upholstery")
        k.box(x0 + 0.03, x1 - 0.03, y0 + 0.06, y1 - 0.03, frame, frame + 0.2, "mattress")
        duv = ["duvet", "duvet_sage", "duvet_rust"][int(it["x"] * 7 + it["y"] * 3) % 3]
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.62, y1 - 0.01, frame + 0.17, frame + 0.28, duv)
        k.box(x0 + 0.0, x1 - 0.0, y1 - 0.45, y1 + 0.005, frame + 0.12, frame + 0.29, duv)
        n = 2 if w > 1.2 else 1
        for i in range(n):
            a = x0 + 0.08 + (w - 0.16) * i / n
            b = x0 + 0.08 + (w - 0.16) * (i + 1) / n
            k.box(a + 0.03, b - 0.03, y0 + 0.12, y0 + 0.5, frame + 0.2, frame + 0.33, "linen")
        k.box(x0 - 0.02, x1 + 0.02, y0 - 0.08, y0, 0.08, 1.05, "upholstery")
        for sx in (x0 + 0.05, x1 - 0.09):
            for sy in (y0 + 0.05, y1 - 0.09):
                k.box(sx, sx + 0.04, sy, sy + 0.04, 0, 0.08, "walnut")
        bev = 0.03
    elif t == "cot":
        top = 0.88
        for sx in (x0, x1 - 0.045):
            for sy in (y0, y1 - 0.045):
                k.box(sx, sx + 0.045, sy, sy + 0.045, 0, top, "white_matte")
        for sy in (y0, y1 - 0.03):
            k.box(x0 + 0.045, x1 - 0.045, sy, sy + 0.03, top - 0.05, top, "white_matte")
            k.box(x0 + 0.045, x1 - 0.045, sy, sy + 0.03, 0.25, 0.3, "white_matte")
            n = int((w - 0.1) / 0.075)
            for i in range(1, n):
                cx = x0 + 0.045 + (w - 0.09) * i / n
                k.box(cx - 0.011, cx + 0.011, sy + 0.004, sy + 0.026, 0.3, top - 0.05, "white_matte")
        for sx in (x0, x1 - 0.03):
            k.box(sx, sx + 0.03, y0 + 0.045, y1 - 0.045, 0.25, top - 0.02, "white_matte")
        k.box(x0 + 0.05, x1 - 0.05, y0 + 0.04, y1 - 0.04, 0.3, 0.42, "mattress")
        k.box(x0 + 0.3, x1 - 0.06, y0 + 0.06, y1 - 0.06, 0.42, 0.46, "duvet_sage")
        bev = 0.006
    elif t == "wardrobe":
        h = it.get("h", 2.2)
        n = max(2, round(w / 0.5))
        for i in range(n):
            a, b = x0 + w * i / n, x0 + w * (i + 1) / n
            k.box(a + 0.002, b - 0.002, y0, y1, 0.0, h, "white")
            hx = b - 0.04 if i % 2 == 0 else a + 0.025
            k.box(hx, hx + 0.015, y1, y1 + 0.02, 0.9, 1.3, "steel")
        bev = 0.004
    elif t == "nightstand":
        if not place_asset("side-table", M, coll, name, scale=(0.8, 0.85, 0.85)):
            k.box(x0, x1, y0, y1, 0, 0.5, "oak_furn")
        lamp = Kit()
        lamp.cyl(0.05, 0, 0.47, 0.5, 0.06, "ceramic", seg=24)
        lamp.cyl(0.05, 0, 0.5, 0.68, 0.015, "ceramic", seg=12)
        lamp.cyl(0.05, 0, 0.62, 0.8, 0.11, "lampshade", seg=32)
        lamp.to_object(name + "_lamp", matrix=M, collection=coll)
        return
    elif t == "desk":
        k.box(x0, x1, y0, y1, 0.72, 0.75, "oak_furn")
        for sx in (x0 + 0.04, x1 - 0.08):
            k.box(sx, sx + 0.04, y0 + 0.05, y1 - 0.05, 0, 0.72, "black_metal")
        mw = 0.62
        k.box(-0.1, 0.1, y0 + 0.08, y0 + 0.26, 0.75, 0.76, "black_metal")
        k.box(-0.02, 0.02, y0 + 0.12, y0 + 0.15, 0.76, 1.0, "black_metal")
        k.box(-mw / 2, mw / 2, y0 + 0.15, y0 + 0.18, 0.86, 1.22, "black_metal")
        k.box(-mw / 2 + 0.01, mw / 2 - 0.01, y0 + 0.18, y0 + 0.182, 0.87, 1.21, "screen")
        k.box(-0.22, 0.22, y0 + 0.36, y0 + 0.5, 0.75, 0.765, "anthracite")
        k.box(0.32, 0.38, y0 + 0.4, y0 + 0.5, 0.75, 0.765, "anthracite")
        bev = 0.003
        place_asset("desk-lamp", M, coll, name + "_lamp", offset=(x0 + 0.18, y0 + 0.18, 0.75), yaw=math.pi * 0.8)
    elif t == "office-chair":
        for i in range(5):
            a = 2 * math.pi * i / 5
            ex, ey = 0.3 * math.cos(a), 0.3 * math.sin(a)
            k.prism([(0, 0), (ex - 0.02 * math.sin(a), ey + 0.02 * math.cos(a)), (ex + 0.02 * math.sin(a), ey - 0.02 * math.cos(a))], 0.05, 0.08, "black_metal")
            k.cyl(ex, ey, 0, 0.05, 0.025, "black_metal", seg=10)
        k.cyl(0, 0, 0.08, 0.42, 0.025, "chrome", seg=12)
        k.box(-0.25, 0.25, -0.24, 0.24, 0.42, 0.5, "upholstery")
        k.box(-0.23, 0.23, -0.3, -0.25, 0.55, 1.05, "upholstery")
        k.box(-0.03, 0.03, -0.29, -0.24, 0.45, 0.6, "black_metal")
        bev = 0.02
    elif t in ("washer", "dryer"):
        k.box(x0, x1, y0, y1, 0, 0.85, "white")
        k.box(x0 + 0.02, x1 - 0.02, y1 - 0.01, y1 + 0.004, 0.74, 0.82, "anthracite")
        k.cyl_y(0, y1, y1 + 0.03, 0.42, 0.18, "chrome", seg=40)
        k.cyl_y(0, y1 + 0.03, y1 + 0.035, 0.42, 0.14, "black_glass", seg=40)
        bev = 0.008
    elif t == "boiler":
        k.box(x0, x1, y0, y1, 1.05, 1.8, "white")
        for sx in (-0.12, -0.04, 0.04, 0.12):
            k.cyl(sx, y0 + 0.1, 0.0, 1.05, 0.011, "chrome", seg=10)
        bev = 0.01
    elif t == "stairs":
        stairs(k, w, d, it.get("h", SH), zmin, zmax)
        bev = 0.003
    elif t == "railing":
        h = 0.95
        k.box(x0, x1, -0.03, 0.03, h - 0.05, h, "oak_furn")
        for sx in (x0, x1 - 0.06):
            k.box(sx, sx + 0.06, -0.03, 0.03, 0, h - 0.05, "white_matte")  # under the handrail
        n = max(2, int(w / 0.11))
        for i in range(1, n):
            cx = x0 + w * i / n
            k.box(cx - 0.012, cx + 0.012, -0.012, 0.012, 0, h - 0.05, "white_matte")
        bev = 0.002
    elif t in ("paint", "wall-tiles"):
        # a coat of paint or a tiled finish on a wall: a thin panel a few mm off the wall face (x along the wall), from
        # z up to h (default the storey's cut height); a few panels go round a window
        z0 = it.get("z", 0.07 if t == "paint" else 0.0)
        z1 = min(it.get("h", CEIL), zmax if zmax is not None else CEIL)
        k.box(x0, x1, y0, y1, z0, z1, tone(it.get("color", "#a9cbbd"), 0.92) if t == "paint" else "wall_tile")
        bev = 0.0
    elif t == "bed-box":
        # the parents' box-spring bed: a tall upholstered base, a tufted headboard at -y, a duvet over the edges, pillows
        hb = 0.09
        duv = tone(it.get("color", "#eebfae"), 0.95, "duvet", **{"Sheen Weight": 0.5})
        k.box(x0 + 0.05, x1 - 0.05, y0 + hb + 0.05, y1 - 0.05, 0, 0.05, "black_metal")      # recessed feet rail
        k.box(x0, x1, y0 + hb, y1, 0.05, 0.42, "headboard")                                   # the box spring
        k.box(x0 + 0.02, x1 - 0.02, y0 + hb + 0.02, y1 - 0.02, 0.42, 0.6, "mattress")
        k.rbox(x0 - 0.02, x1 + 0.02, y0 + hb + 0.5, y1 + 0.02, 0.47, 0.66, 0.04, duv)         # the duvet hangs over
        n = 2 if w > 1.2 else 1
        for i in range(n):
            a, b = x0 + 0.06 + (w - 0.12) * i / n, x0 + 0.06 + (w - 0.12) * (i + 1) / n
            k.rbox(a + 0.03, b - 0.03, y0 + hb + 0.06, y0 + hb + 0.46, 0.6, 0.72, 0.09, duv)
        k.box(x0 - 0.02, x1 + 0.02, y0, y0 + hb, 0.05, 1.25, "headboard")
        cols = max(2, round(w / 0.3))
        for i in range(cols):                                                                # the tufted panels
            a, b = x0 + w * i / cols, x0 + w * (i + 1) / cols
            for z_0, z_1 in ((0.62, 0.93), (0.94, 1.22)):
                k.rbox(a + 0.008, b - 0.008, y0 + hb - 0.01, y0 + hb + 0.025, z_0, z_1, 0.02, "headboard")
        bev, segs = 0.012, 2
    elif t == "bed-day":
        # a white single day bed along a wall (back at -y): drawers in the base, a striped blanket, cushions on the back
        k.box(x0, x1, y0, y1, 0, 0.33, "white_matte")
        for i in range(2):
            a, b = x0 + 0.08 + (w - 0.16) * i / 2, x0 + 0.08 + (w - 0.16) * (i + 1) / 2
            k.box(a + 0.01, b - 0.01, y1, y1 + 0.015, 0.05, 0.28, "white")
            k.box((a + b) / 2 - 0.08, (a + b) / 2 + 0.08, y1 + 0.015, y1 + 0.03, 0.2, 0.22, "steel")
        k.box(x0 + 0.03, x1 - 0.03, y0 + 0.03, y1 - 0.03, 0.33, 0.47, "mattress")
        k.rbox(x0 - 0.01, x1 - 0.25, y0 + 0.2, y1 + 0.02, 0.4, 0.5, 0.03, "linen")           # the blanket
        for i, m in enumerate(("linen", "duvet", "linen", "duvet_sage")):
            cx = x0 + 0.35 + i * (w - 0.6) / 3
            k.rbox(cx - 0.2, cx + 0.2, y0 + 0.03, y0 + 0.17, 0.47, 0.78, 0.065, m)
        k.rbox(x1 - 0.5, x1 - 0.04, y0 + 0.18, y1 - 0.1, 0.47, 0.6, 0.06, "coat_blue")       # the pillow, at +x
        bev, segs = 0.01, 2
    elif t == "nightstand-white":
        # a white two-drawer bedside chest with a glass globe lamp on a green base
        h = it.get("h", 0.55)
        k.box(x0, x1, y0, y1 - 0.02, 0, h, "white")
        for z_0, z_1 in ((0.03, 0.27), (0.285, h - 0.02)):
            k.box(x0 + 0.004, x1 - 0.004, y1 - 0.02, y1, z_0, z_1, "white")
        k.cyl(0.07, -0.02, h, h + 0.09, 0.05, "coat_green", seg=24)
        k.lathe(0.07, -0.02, [(0.003, h + 0.09), (0.05, h + 0.11), (0.075, h + 0.17), (0.05, h + 0.23), (0.003, h + 0.25)], "globe", seg=24)
        bev = 0.003
    elif t == "cot-sleeper":
        # a bedside crib: a grey fabric bassinet (its long side to the bed) on a grey stand with two T-feet on wheels
        top, depth = 0.86, 0.24
        for sx in (x0 + 0.1, x1 - 0.1):
            k.cyl(sx, 0, 0.06, top - depth + 0.02, 0.022, "frame_grey", seg=14)
            k.box(sx - 0.022, sx + 0.022, y0 - 0.06, y1 + 0.06, 0.035, 0.065, "frame_grey")
            for sy in (y0 - 0.04, y1 + 0.04):
                k.cyl(sx, sy, 0, 0.035, 0.03, "anthracite", seg=12)
        k.tub(x0, x1, y0, y1, top - depth - 0.06, top, 0.035, depth, "bassinet")
        k.box(x0 + 0.04, x1 - 0.04, y0 + 0.04, y1 - 0.04, top - depth, top - depth + 0.05, "mattress")
        k.rbox(x0 + 0.18, x1 - 0.05, y0 + 0.05, y1 - 0.05, top - depth + 0.05, top - depth + 0.11, 0.04, "linen")
        bev, segs = 0.012, 2
    elif t == "baby-monitor":
        # the baby camera on its floor stand: a round foot, a pole, a white camera head looking down into the crib
        h = it.get("h", 1.15)
        k.cyl(0, 0, 0, 0.02, 0.11, "white_matte", seg=24)
        k.cyl(0, 0, 0.02, h - 0.005, 0.011, "frame_grey", seg=10)
        k.box(-0.01, 0.01, -0.01, 0.12, h - 0.02, h, "frame_grey")
        k.rbox(-0.04, 0.04, 0.08, 0.2, h - 0.1, h - 0.02, 0.02, "white")
        k.cyl(0, 0.2, h - 0.075, h - 0.045, 0.018, "black_glass", seg=16)
        bev = 0.003
    elif t == "trolley":
        # a three-tier cart in cream metal, baskets of mesh (open tubs) on four posts and wheels
        for sx in (x0 + 0.015, x1 - 0.015):
            for sy in (y0 + 0.015, y1 - 0.015):
                k.cyl(sx, sy, 0.05, 0.88, 0.011, "cream_metal", seg=10)
                k.cyl(sx, sy, 0, 0.05, 0.022, "anthracite", seg=10)
        for z in (0.12, 0.43, 0.74):
            k.tub(x0 + 0.03, x1 - 0.03, y0 + 0.03, y1 - 0.03, z, z + 0.14, 0.008, 0.12, "cream_metal")
            k.box(x0 + 0.06, x1 - 0.12, y0 + 0.06, y1 - 0.08, z + 0.02, z + 0.1, ["linen", "coat_green", "duvet"][int(z * 10) % 3])
        bev = 0.002
    elif t == "wardrobe-sliding":
        # a white built-in wardrobe with sliding doors on aluminium tracks, floor to nearly the ceiling
        h = min(it.get("h", 2.4), CEIL - 0.05)
        k.box(x0, x1, y0, y1 - 0.04, 0, h - 0.003, "white_matte")
        k.box(x0 + 0.003, x1 - 0.003, y1 - 0.045, y1 + 0.006, h - 0.05, h, "steel")      # top track
        k.box(x0 + 0.003, x1 - 0.003, y1 - 0.045, y1 + 0.006, 0, 0.035, "steel")         # bottom track
        n = max(2, round(w / 1.0))
        for i in range(n):
            a, b = x0 + w * i / n - (0.02 if i else -0.01), x0 + w * (i + 1) / n + (0.02 if i < n - 1 else -0.01)
            f0, f1 = (y1 - 0.038, y1 - 0.02) if i % 2 == 0 else (y1 - 0.017, y1 + 0.001)
            k.box(a, b, f0, f1, 0.04, h - 0.055, "white")
            for sx in (a - 0.002, b - 0.016):                                              # aluminium stiles
                k.box(sx, sx + 0.018, f0 - 0.002, f1 + 0.003, 0.038, h - 0.053, "steel")
        bev = 0.002
    elif t == "wardrobe-panel":
        # a cream two-door wardrobe on short legs: framed panel doors, a cross rail, wooden knobs
        h = it.get("h", 1.85)
        for sx in (x0 + 0.03, x1 - 0.06):
            for sy in (y0 + 0.03, y1 - 0.06):
                k.box(sx, sx + 0.03, sy, sy + 0.03, 0, 0.1, "greige")
        k.box(x0, x1, y0, y1 - 0.02, 0.1, h, "greige", top="greige")
        k.box(x0 - 0.015, x1 + 0.015, y0 - 0.005, y1 + 0.01, h, h + 0.03, "greige")          # the cornice
        for i, (a, b) in enumerate(((x0 + 0.02, -0.003), (0.003, x1 - 0.02))):
            k.box(a, b, y1 - 0.02, y1, 0.13, h - 0.03, "greige")
            k.box(a + 0.06, b - 0.06, y1, y1 + 0.006, 0.2, h * 0.72, "white_matte")          # lower panel
            k.box(a + 0.06, b - 0.06, y1, y1 + 0.006, h * 0.72 + 0.06, h - 0.1, "white_matte")  # upper panel
            k.cyl(-0.025 if i == 0 else 0.025, y1 + 0.02, 0.98, 1.0, 0.016, "pine_knob", seg=12)
        bev = 0.004
    elif t == "mirror-wall":
        # a tall narrow white-framed mirror hung on a wall
        z0, z1 = it.get("z", 0.6), it.get("h", 2.0)
        k.box(x0, x1, y0, y1, z0, z1, "white")
        k.box(x0 + 0.03, x1 - 0.03, y1, y1 + 0.004, z0 + 0.03, z1 - 0.03, "mirror")
        bev = 0.002
    elif t == "dressing-table":
        # a white dressing table: four slim legs, a drawer apron, a small mirror and bottles on the top
        h = 0.76
        for sx in (x0 + 0.02, x1 - 0.06):
            for sy in (y0 + 0.02, y1 - 0.06):
                k.box(sx, sx + 0.04, sy, sy + 0.04, 0, h - 0.03, "white")
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.01, y1 - 0.01, h - 0.15, h - 0.025, "white")
        k.box(x0 + 0.04, x1 - 0.04, y1 - 0.01, y1 - 0.002, h - 0.14, h - 0.035, "white_matte")
        k.box(x0, x1, y0, y1, h - 0.025, h, "white")
        k.box(-0.18, 0.18, y0 + 0.04, y0 + 0.07, h, h + 0.42, "white")
        k.box(-0.15, 0.15, y0 + 0.07, y0 + 0.074, h + 0.04, h + 0.39, "mirror")
        for i, (cx, r, hh, m) in enumerate(((-0.3, 0.025, 0.14, "vase_pink"), (-0.25, 0.02, 0.1, "white"), (0.26, 0.03, 0.12, "coat_green"), (0.32, 0.02, 0.17, "ceramic"))):
            k.cyl(cx, y0 + 0.15 + 0.03 * i, h, h + hh, r, m, seg=14)
        bev = 0.003
    elif t == "radiator-cover":
        # a white radiator cover under a window: slatted fronts between stiles, a shelf on top that stands proud
        h = it.get("h", 0.66)
        k.box(x0 - 0.01, x1 + 0.01, y0, y1 + 0.02, h - 0.025, h, "white")
        k.box(x0, x0 + 0.02, y0, y1, 0, h - 0.025, "white")
        k.box(x1 - 0.02, x1, y0, y1, 0, h - 0.025, "white")
        k.box(x0 + 0.025, x1 - 0.025, y1 - 0.04, y1 - 0.03, 0.02, h - 0.03, "well")             # the dark inside
        n = max(1, round(w / 0.75))
        for i in range(n + 1):
            sx = x0 + 0.02 + (w - 0.09) * i / n
            k.box(sx, sx + 0.05, y1 - 0.033, y1, 0, h - 0.025, "white")                       # stiles
        k.box(x0 + 0.025, x1 - 0.025, y1 - 0.028, y1 - 0.002, 0, 0.08, "white")              # plinth rail
        for i in range(n):
            a, b = x0 + 0.07 + (w - 0.09) * i / n, x0 + 0.02 + (w - 0.09) * (i + 1) / n
            z = 0.11
            while z < h - 0.06:
                k.box(a, b, y1 - 0.028, y1 - 0.006, z, z + 0.022, "white")                    # slats
                z += 0.04
        bev = 0.002
    elif t == "radiator":
        # a white panel radiator on a wall
        z0, z1 = it.get("z", 0.12), it.get("h", 0.62)
        k.box(x0, x1, y0 + 0.03, y1, z0, z1, "white")
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.04, y1 - 0.01, z1, z1 + 0.012, "anthracite")
        for sx in (x0 + 0.1, x1 - 0.12):
            k.box(sx, sx + 0.02, y0, y0 + 0.03, z1 - 0.1, z1 - 0.05, "white_matte")
        bev = 0.003
    elif t == "towel-radiator":
        # a black towel ladder: two rails and bars in groups
        z0, z1 = it.get("z", 0.25), it.get("h", 1.55)
        for sx in (x0, x1 - 0.03):
            k.box(sx, sx + 0.03, y0 + 0.04, y1, z0, z1, "black_metal")
            k.box(sx + 0.005, sx + 0.025, y0, y0 + 0.04, z0 + 0.1, z0 + 0.13, "black_metal")
            k.box(sx + 0.005, sx + 0.025, y0, y0 + 0.04, z1 - 0.13, z1 - 0.1, "black_metal")
        z = z0 + 0.05
        i = 0
        while z < z1 - 0.04:
            k.box(x0 + 0.03, x1 - 0.03, y0 + 0.05, y1 - 0.01, z, z + 0.018, "black_metal")
            i += 1
            z += 0.05 if i % 5 else 0.13
        bev = 0.002
    elif t == "roller-blind":
        # a roller blind in a window: the cassette under the head and the cloth pulled part way down to z
        z0, z1 = it.get("z", 1.7), it.get("h", 2.38)
        cloth = tone(it.get("color", "#efe7da"), 0.95, "blind", **{"Transmission Weight": 0.3})
        k.rbox(x0, x1, y0, y1, z1 - 0.07, z1, 0.02, "white")
        if it.get("slats"):  # a wooden venetian blind instead: 5 cm slats, cloth ladder tapes over them
            z = z1 - 0.08
            while z > z0 + 0.02:
                k.box(x0 + 0.015, x1 - 0.015, y0 + 0.004, y0 + 0.05, z - 0.006, z, cloth)
                z -= 0.022
            for i in range(int(w / 0.4) + 1):
                tx = x0 + 0.08 + (w - 0.16) * i / max(1, int(w / 0.4))
                k.box(tx - 0.012, tx + 0.012, y0 + 0.05, y0 + 0.053, z0, z1 - 0.07, "linen")
        else:
            k.box(x0 + 0.015, x1 - 0.015, y0 + 0.012, y0 + 0.016, z0, z1 - 0.07, cloth)
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.006, y0 + 0.024, z0 - 0.025, z0, "white")         # the bottom bar
        bev = 0.0
    elif t in ("pendant-cylinder", "pendant-globe", "pendant-dome"):
        # ceiling lights: a beige cylinder (bedroom), a ribbed paper globe (a child's room), a white metal dome (office)
        drop = it.get("h", 0.7)
        zt = CEIL - drop
        k.cyl(0, 0, zt, CEIL, 0.004, "black_metal" if t == "pendant-cylinder" else "white", seg=6)
        k.cyl(0, 0, CEIL - 0.02, CEIL - 0.001, 0.05, "white_matte", seg=20)
        if t == "pendant-cylinder":
            k.lathe(0, 0, [(0.075, zt - 0.26), (0.075, zt), (0.068, zt), (0.068, zt - 0.26)], "linen", seg=32, loop=True)
            k.cyl(0, 0, zt - 0.015, zt + 0.002, 0.069, "linen", seg=32)
        elif t == "pendant-globe":
            r = min(w, d) / 2
            prof = [(0.03, zt + 0.01)] + [(r * math.sin(a), zt - r * 1.1 * (1 - math.cos(a)), 0.012) for a in (math.pi * i / 12 for i in range(1, 12))] + [(0.05, zt - 2.2 * r + 0.01)]
            k.lathe(0, 0, [(q[0], q[1]) for q in prof], "lampshade", seg=40)
        else:
            r = min(w, d) / 2
            k.cyl(0, 0, zt - 0.12, zt + 0.002, 0.045, "white", seg=20)
            k.lathe(0, 0, [(0.05, zt - 0.1), (r * 0.7, zt - 0.2), (r, zt - 0.34), (r - 0.006, zt - 0.34), (r * 0.7 - 0.006, zt - 0.2), (0.044, zt - 0.1)], "white", seg=48, loop=True)
        bev = 0.0
    elif t == "frames":
        # a row of picture frames on a wall (x along it): frame colour from `color`, paper with a simple drawing
        n = max(1, round(w / 0.5))
        z0, fh = it.get("z", 1.3), it.get("h", 0.45)
        fm = tone(it.get("color", "#e8e1d4"), 0.6, "frame")
        gap = 0.12
        fw = (w - gap * (n - 1)) / n
        for i in range(n):
            a = x0 + i * (fw + gap)
            zz = z0 + (0.06 if i % 2 else 0.0)
            k.box(a, a + fw, y0, y1, zz, zz + fh, fm)
            k.box(a + 0.04, a + fw - 0.04, y1, y1 + 0.003, zz + 0.04, zz + fh - 0.04, "paper")
            k.box(a + fw * 0.35, a + fw * 0.65, y1 + 0.003, y1 + 0.005, zz + fh * 0.3, zz + fh * 0.7, ["ink", "coat_camel", "duvet_sage"][i % 3])
        bev = 0.002
    elif t == "dresser-changing":
        # a greige chest of three drawers on short legs, wooden knobs, a changing mat on top and a mobile over it
        h = 0.9
        for sx in (x0 + 0.02, x1 - 0.06):
            for sy in (y0 + 0.02, y1 - 0.06):
                k.box(sx, sx + 0.04, sy, sy + 0.04, 0, 0.12, "greige")
        k.box(x0 + 0.01, x1 - 0.01, y0 + 0.01, y1 - 0.02, 0.12, h - 0.03, "greige")
        k.box(x0, x1, y0, y1 + 0.01, h - 0.03, h, "greige")
        for j in range(3):
            z_0 = 0.14 + j * (h - 0.2) / 3
            k.box(x0 + 0.03, x1 - 0.03, y1 - 0.02, y1, z_0, z_0 + (h - 0.2) / 3 - 0.012, "greige")
            for sx in (-w / 4, w / 4):
                k.cyl(sx, y1 + 0.012, z_0 + 0.1, z_0 + 0.13, 0.02, "pine_knob", seg=10)
        k.tub(x0 + 0.08, x1 - 0.14, y0 + 0.03, y1 - 0.04, h, h + 0.1, 0.06, 0.05, "white_matte", inner="mattress")
        k.cyl(x1 - 0.08, y0 + 0.06, h, h + 0.6, 0.01, "frame_grey", seg=8)                    # the mobile's arm
        k.box(x1 - 0.085, x1 - 0.075, y0 + 0.06, y0 + 0.3, h + 0.58, h + 0.6, "frame_grey")
        for i, m in enumerate(("coat_camel", "vase_pink", "coat_camel")):
            k.cyl(x1 - 0.08 + 0.08 * math.cos(2.1 * i), y0 + 0.3 + 0.08 * math.sin(2.1 * i), h + 0.38, h + 0.46, 0.025, m, seg=10)
        bev = 0.004
    elif t == "wall-shelf":
        # a small wall shelf with pegs under it and soft toys on top
        z = it.get("z", 1.55)
        k.box(x0, x1, y0, y1, z, z + 0.02, "greige")
        k.box(x0, x1, y0, y0 + 0.02, z - 0.12, z, "greige")
        for sx in (x0 + 0.01, x1 - 0.03):
            k.box(sx, sx + 0.02, y0 + 0.02, y1 - 0.02, z - 0.12, z, "greige")
        for i in range(3):
            k.cyl(x0 + w * (i + 1) / 4, y0 + 0.02, z - 0.08, z - 0.06, 0.01, "pine_knob", seg=8)
        for i, m in enumerate(("coat_camel", "linen", "walnut", "coat_blue")):
            cx = x0 + 0.1 + i * (w - 0.2) / 3
            k.rbox(cx - 0.05, cx + 0.05, y0 + 0.05, y1 - 0.03, z + 0.02, z + 0.15, 0.04, m)
        bev, segs = 0.01, 2
    elif t == "desk-work":
        # A standing desk: a cherry top on black T-legs, a beige mat, keyboard, trackpad and
        # mouse, a wooden monitor riser with the Mac mini on it, a curved monitor, a closed laptop on a stand, binders
        h = it.get("h", 0.75)
        for sx in (x0 + 0.15, x1 - 0.15):
            k.box(sx - 0.04, sx + 0.04, y0 + 0.12, y0 + 0.2, 0.04, h - 0.03, "black_metal")
            k.box(sx - 0.035, sx + 0.035, y0 + 0.02, y1 - 0.04, 0, 0.04, "black_metal")
        k.box(x0 + 0.19, x1 - 0.19, y0 + 0.13, y0 + 0.19, h - 0.12, h - 0.03, "black_metal")
        k.box(x0, x1, y0, y1, h - 0.03, h, "cherry")
        k.rbox(-0.45, 0.45, y1 - 0.47, y1 - 0.06, h, h + 0.003, 0.05, "desk_mat")
        k.rbox(-0.12, 0.16, y1 - 0.32, y1 - 0.2, h + 0.003, h + 0.013, 0.008, "white")       # keyboard
        k.rbox(0.2, 0.36, y1 - 0.36, y1 - 0.25, h + 0.003, h + 0.008, 0.01, "frame_grey")   # trackpad
        k.rbox(0.33, 0.4, y1 - 0.25, y1 - 0.13, h + 0.003, h + 0.03, 0.03, "anthracite")    # mouse
        k.box(-0.5, 0.36, y0 + 0.04, y0 + 0.26, h + 0.1, h + 0.125, "oak_furn")             # the riser
        for sx in (-0.48, 0.32):
            k.box(sx, sx + 0.02, y0 + 0.05, y0 + 0.25, h, h + 0.1, "black_metal")
        k.rbox(0.22, 0.35, y0 + 0.09, y0 + 0.22, h + 0.125, h + 0.175, 0.012, "steel")     # the Mac mini (home server)
        k.box(-0.08, 0.08, y0 + 0.04, y0 + 0.14, h + 0.125, h + 0.135, "black_metal")       # monitor foot
        k.box(-0.025, 0.025, y0 + 0.05, y0 + 0.08, h + 0.135, h + 0.33, "black_metal")
        R, mw = 1.5, 0.8                                                                    # the curved monitor
        arc = [(R * math.sin(a), y0 + 0.11 + R * (1 - math.cos(a))) for a in [(-mw / 2 + mw * i / 12) / R for i in range(13)]]
        k.prism(arc + [(x, y - 0.03) for x, y in reversed(arc)], h + 0.21, h + 0.57, "black_metal")
        k.prism(arc[1:-1] + [(x, y + 0.004) for x, y in reversed(arc[1:-1])], h + 0.225, h + 0.555, "screen_lit")
        k.rbox(x0 + 0.1, x0 + 0.12, y0 + 0.06, y0 + 0.36, h + 0.02, h + 0.24, 0.004, "frame_grey")  # laptop on a stand
        k.box(x0 + 0.08, x0 + 0.14, y0 + 0.1, y0 + 0.3, h, h + 0.02, "black_metal")
        for i in range(3):                                                                  # binders
            k.box(x1 - 0.12 - i * 0.075, x1 - 0.05 - i * 0.075, y0 + 0.05, y0 + 0.33, h, h + 0.32, "anthracite")
        k.cyl(x0 + 0.35, y0 + 0.12, h, h + 0.2, 0.045, "anthracite", seg=16)               # speaker
        bev = 0.002
    elif t == "desk-white":
        # a white desk on a drawer unit and a leg: two monitors, a pen pot, boxes
        h = 0.74
        k.box(x0 + 0.02, x0 + 0.38, y0 + 0.03, y1 - 0.03, 0, h - 0.025, "white")
        for j in range(4):
            k.box(x0 + 0.025, x0 + 0.375, y1 - 0.03, y1 - 0.012, 0.03 + j * 0.17, 0.18 + j * 0.17, "white_matte")
        k.cyl(x1 - 0.06, y0 + 0.06, 0, h - 0.025, 0.025, "white", seg=12)
        k.cyl(x1 - 0.06, y1 - 0.06, 0, h - 0.025, 0.025, "white", seg=12)
        k.box(x0, x1, y0, y1, h - 0.025, h, "white")
        for cx in (-w / 4 + 0.05, w / 4 - 0.02):
            k.box(cx - 0.1, cx + 0.1, y0 + 0.06, y0 + 0.2, h, h + 0.01, "black_metal")
            k.box(cx - 0.02, cx + 0.02, y0 + 0.08, y0 + 0.11, h + 0.01, h + 0.15, "black_metal")
            k.box(cx - 0.31, cx + 0.31, y0 + 0.11, y0 + 0.14, h + 0.1, h + 0.47, "black_metal")
            k.box(cx - 0.3, cx + 0.3, y0 + 0.14, y0 + 0.143, h + 0.11, h + 0.46, "screen")
        k.box(x0 + 0.05, x0 + 0.3, y1 - 0.3, y1 - 0.05, h, h + 0.1, "white_matte")
        k.box(x0 + 0.08, x0 + 0.28, y1 - 0.28, y1 - 0.08, h + 0.1, h + 0.16, "coat_camel")
        k.cyl(x1 - 0.12, y0 + 0.25, h, h + 0.1, 0.04, "anthracite", seg=14)
        bev = 0.002
    elif t == "desk-lamp-arch":
        # a black architect lamp clamped to a desk's back edge: a post, two arms and a cone shade reaching over the desk
        # (local +y is where it reaches)
        z = it.get("z", 0.75)
        k.box(-0.03, 0.03, y0, y0 + 0.06, z - 0.06, z + 0.04, "black_metal")
        k.cyl(0, y0 + 0.03, z + 0.04, z + 0.1, 0.018, "black_metal", seg=12)
        bars = [((y0 + 0.03, z + 0.1), (y0 + 0.12, z + 0.55)), ((y0 + 0.12, z + 0.55), (y1 - 0.02, z + 0.42))]
        for (ya, za), (yb, zb) in bars:
            L = math.hypot(yb - ya, zb - za)
            nz, ny = (yb - ya) / L * 0.009, -(zb - za) / L * 0.009
            # an arm: a thin bar in the y-z plane, built as a prism along x
            poly = [(ya + ny, za + nz), (yb + ny, zb + nz), (yb - ny, zb - nz), (ya - ny, za - nz)]
            bm = k.bm
            a = [bm.verts.new((-0.008, yy, zz)) for yy, zz in poly]
            c = [bm.verts.new((0.008, yy, zz)) for yy, zz in poly]
            s = k.slot("black_metal")
            bm.faces.new(a).material_index = s
            bm.faces.new(c[::-1]).material_index = s
            for i in range(4):
                j = (i + 1) % 4
                bm.faces.new([a[i], c[i], c[j], a[j]]).material_index = s
        k.cyl(0, y1 - 0.02, z + 0.36, z + 0.44, 0.03, "black_metal", seg=16)
        k.lathe(0, y1 - 0.02, [(0.032, z + 0.37), (0.085, z + 0.22), (0.079, z + 0.22), (0.026, z + 0.37)], "black_metal", seg=32, loop=True)
        bev = 0.0
    elif t == "office-chair-mesh":
        # a grey mesh desk chair: five-star chrome base, a mesh seat, a tall mesh back with a headrest, arms (back at -y)
        for i in range(5):
            a = 2 * math.pi * i / 5 + 0.3
            ex, ey = 0.3 * math.cos(a), 0.3 * math.sin(a)
            k.prism([(0, 0), (ex - 0.02 * math.sin(a), ey + 0.02 * math.cos(a)), (ex + 0.02 * math.sin(a), ey - 0.02 * math.cos(a))], 0.05, 0.08, "chrome")
            k.cyl(ex, ey, 0, 0.05, 0.025, "anthracite", seg=10)
        k.cyl(0, 0, 0.08, 0.44, 0.025, "chrome", seg=12)
        k.rbox(-0.25, 0.25, -0.22, 0.25, 0.44, 0.51, 0.08, "mesh_grey")
        k.rbox(-0.23, 0.23, -0.3, -0.24, 0.58, 1.12, 0.1, "mesh_grey")
        k.rbox(-0.15, 0.15, -0.325, -0.265, 1.16, 1.3, 0.05, "mesh_grey")
        k.box(-0.025, 0.025, -0.312, -0.252, 0.47, 1.17, "white_matte")
        for sx in (-0.27, 0.23):
            k.box(sx, sx + 0.04, -0.1, -0.06, 0.5, 0.66, "white_matte")
            k.rbox(sx - 0.01, sx + 0.05, -0.16, 0.12, 0.66, 0.69, 0.02, "anthracite")
        bev, segs = 0.008, 2
    elif t == "guitar":
        # an acoustic guitar standing on its floor stand, its face to +y
        k.box(-0.12, 0.12, -0.08, 0.05, 0, 0.03, "black_metal")
        k.cyl(0, -0.02, 0.17, 0.58, 0.012, "black_metal", seg=8)
        poly = [(0.19 * math.cos(a), 0.3 + 0.2 * math.sin(a)) for a in (2 * math.pi * i / 28 for i in range(28))]
        k.prism_xz(poly, -0.05, 0.05, "black_glass")
        k.prism_xz([(0.15 * math.cos(a), 0.6 + 0.15 * math.sin(a)) for a in (2 * math.pi * i / 24 for i in range(24))], -0.045, 0.045, "black_glass")
        k.box(-0.025, 0.025, -0.02, 0.02, 0.72, 1.12, "walnut")
        k.box(-0.035, 0.035, -0.025, 0.025, 1.12, 1.22, "black_glass")
        k.cyl_y(0, 0.05, 0.052, 0.45, 0.045, "ink", seg=20)
        bev = 0.003
    elif t == "shower-black":
        # a walk-in shower in a black-framed glass enclosure on the -x and -y sides: a grey tray, a rain shower column,
        # a hand shower and a thermostat bar on the +x wall
        h = 2.0
        k.box(x0, x1, y0, y1, 0, 0.04, "tiles_grey")
        k.box(x0 + 0.01, x0 + 0.018, y0 + 0.03, y1 - 0.01, 0.06, h - 0.03, "shower_glass")
        k.box(x0 + 0.03, x1 - 0.01, y0 + 0.01, y0 + 0.018, 0.06, h - 0.03, "shower_glass")
        k.box(x0, x0 + 0.03, y0, y0 + 0.03, 0.04, h, "frame_dark")                            # the corner post
        k.box(x0 + 0.001, x0 + 0.027, y0 + 0.03, y1, 0.04, 0.06, "frame_dark")
        k.box(x0 + 0.001, x0 + 0.027, y0 + 0.03, y1, h - 0.03, h, "frame_dark")
        k.box(x0 + 0.03, x1, y0 + 0.001, y0 + 0.027, 0.04, 0.06, "frame_dark")
        k.box(x0 + 0.03, x1, y0 + 0.001, y0 + 0.027, h - 0.03, h, "frame_dark")
        k.box(x0 - 0.008, x0 + 0.035, (y0 + y1) / 2 - 0.08, (y0 + y1) / 2 + 0.08, 1.0, 1.03, "frame_dark")  # the handle
        cx, cy = x1 - 0.06, (y0 + y1) / 2 + 0.1
        k.cyl(cx, cy, 0.95, 2.09, 0.012, "frame_dark", seg=12)
        k.box(cx - 0.5, cx, cy - 0.01, cy + 0.01, 2.08, 2.1, "frame_dark")
        k.cyl(cx - 0.32, cy, 2.04, 2.08, 0.15, "frame_dark", seg=32)
        k.box(cx - 0.02, x1, cy - 0.18, cy + 0.18, 1.0, 1.06, "frame_dark")                   # thermostat bar
        k.cyl(cx - 0.03, cy - 0.25, 1.25, 1.45, 0.016, "frame_dark", seg=12)                  # hand shower
        k.cyl(cx - 0.03, cy - 0.25, 1.45, 1.47, 0.05, "frame_dark", seg=16)
        bev = 0.0
    elif t == "wc-wall":
        # a wall-hung WC in front of a tiled cistern box with a shelf on top and a black flush plate (back at -y)
        bx = 0.22
        k.box(x0, x1, y0, y0 + bx, 0, 1.08, "wall_tile")
        k.box(x0 - 0.01, x1 + 0.01, y0, y0 + bx + 0.015, 1.08, 1.1, "wall_tile")
        k.box(-0.11, 0.11, y0 + bx, y0 + bx + 0.008, 0.88, 1.03, "frame_dark")
        k.rbox(-0.17, 0.17, y0 + bx, y0 + bx + 0.2, 0.3, 0.395, (0.04, 0.04, 0.02, 0.02), "ceramic")
        k.cyl(0, y0 + bx + 0.3, 0.27, 0.4, 0.18, "ceramic", ry=0.24, seg=40)
        k.cyl(0, y0 + bx + 0.3, 0.405, 0.43, 0.18, "ceramic", ry=0.24, seg=40)
        for i, (cx, m, hh) in enumerate(((x0 + 0.08, "coat_camel", 0.12), (x0 + 0.2, "duvet_rust", 0.08), (x1 - 0.12, "linen", 0.25), (x1 - 0.06, "ceramic", 0.18))):
            k.cyl(cx, y0 + 0.1, 1.1, 1.1 + hh, 0.03 if i < 2 else 0.012, m, seg=12)
        k.cyl(x1 + 0.08, y0 + bx + 0.12, 0, 0.02, 0.09, "chrome", seg=20)                      # the roll stand
        k.cyl(x1 + 0.08, y0 + bx + 0.12, 0.02, 0.7, 0.008, "chrome", seg=8)
        k.cyl(x1 + 0.08, y0 + bx + 0.12, 0.4, 0.5, 0.055, "paper", seg=20)
        bev = 0.004
    elif t == "bath-tiled":
        # a built-in bath against the wall (back at -y): a white tub in a grey tiled apron, a bamboo tray across it
        h = 0.58
        k.tub(x0, x1 - 0.005, y0, y1 - 0.015, 0.0, h, 0.07, 0.42, "ceramic")
        k.box(x0 + 0.002, x1 + 0.007, y1 - 0.02, y1, 0, h - 0.03, "wall_tile")  # the apron overlaps the tub a little
        k.box(x1 - 0.01, x1 + 0.007, y0 + 0.003, y1 - 0.02, 0, h - 0.03, "wall_tile")
        mx = x0 + w * 0.45                                                                   # mixer and hand shower
        k.box(mx - 0.12, mx + 0.12, y0 - 0.01, y0 + 0.05, h + 0.2, h + 0.24, "frame_dark")
        k.box(mx - 0.012, mx + 0.012, y0 + 0.05, y0 + 0.12, h + 0.17, h + 0.21, "frame_dark")
        k.cyl(mx - 0.4, y0 + 0.03, h + 0.3, h + 0.52, 0.014, "frame_dark", seg=12)
        k.cyl(mx - 0.4, y0 + 0.03, h + 0.52, h + 0.545, 0.04, "frame_dark", seg=16)
        tx = x0 + w * 0.12
        k.box(tx - 0.16, tx + 0.16, y0 + 0.03, y1 - 0.04, h, h + 0.025, "bamboo")
        k.cyl(tx, y0 + 0.35, h + 0.025, h + 0.04, 0.05, "anthracite", seg=16)
        k.rbox(x1 - 0.75, x1 - 0.15, y0 + 0.14, y1 - 0.14, h - 0.418, h - 0.18, 0.12, "coat_green")  # the baby bath in it
        bev = 0.004
    elif t == "vanity-white":
        # a white wall-hung vanity (back at -y): two drawers with black bar handles, a long ceramic basin top, a black tap,
        # a wide mirror cabinet above with a light bar on top
        k.box(x0, x1, y0, y1 - 0.02, 0.36, 0.82, "white")
        for z_0, z_1 in ((0.37, 0.59), (0.6, 0.81)):
            k.box(x0 + 0.004, x1 - 0.004, y1 - 0.02, y1, z_0, z_1, "white")
            k.box(x0 + 0.06, x0 + 0.075, y1, y1 + 0.012, z_0 + 0.03, z_1 - 0.03, "frame_dark")
        k.tub(x0 - 0.005, x1 + 0.005, y0, y1 + 0.01, 0.82, 0.86, 0.05, 0.03, "ceramic")
        k.cyl(0, y0 + 0.06, 0.86, 1.04, 0.012, "frame_dark", seg=12)
        k.box(-0.012, 0.012, y0 + 0.06, y0 + 0.16, 1.02, 1.04, "frame_dark")
        k.box(x0 + 0.02, x1 - 0.02, y0, y0 + 0.12, 1.12, 1.98, "white_matte")
        k.box(x0 + 0.025, x1 - 0.025, y0 + 0.12, y0 + 0.126, 1.125, 1.975, "mirror")
        k.box(-0.3, 0.3, y0 + 0.02, y0 + 0.16, 2.0, 2.04, "frame_dark")
        bev = 0.003
    elif t == "hamper":
        # a grey fabric laundry hamper with a rounded lid
        h = it.get("h", 0.62)
        k.rbox(x0, x1, y0, y1, 0, h - 0.03, 0.04, tone(it.get("color", "#8a8c90"), 0.95, "hamper", **{"Sheen Weight": 0.4}))
        k.rbox(x0 - 0.01, x1 + 0.01, y0 - 0.01, y1 + 0.01, h - 0.03, h, 0.05, "greige")
        bev = 0.006
    elif t == "kitchen-tall":
        # a tall white kitchen column with a built-in black oven at waist height, a door below and one above
        h = it.get("h", 2.25)
        k.box(x0, x1, y0, y1 - 0.06, 0, 0.1, "anthracite")
        k.box(x0, x1, y0, y1 - 0.02, 0.1, h, "white_matte")
        for z0_, z1_ in ((0.1, 0.78), (1.4, h)):
            k.box(x0 + 0.002, x1 - 0.002, y1 - 0.02, y1, z0_ + 0.003, z1_ - 0.003, "white_matte")
        k.box(x0 + 0.08, x1 - 0.08, y1, y1 + 0.016, 0.7, 0.712, "black_metal")
        k.box(x0 + 0.01, x1 - 0.01, y1 - 0.02, y1 + 0.002, 0.8, 1.38, "black_glass")       # the oven
        k.box(x0 + 0.06, x1 - 0.06, y1 + 0.002, y1 + 0.02, 1.26, 1.272, "black_metal")
        k.box(-0.03, 0.03, y1 + 0.002, y1 + 0.004, 1.33, 1.345, "coat_blue")              # its clock
        bev = 0.003
    elif t == "wall-cabinets":
        # a row of white wall cabinets z..z+h (h 0.72), doors 0.4-0.6 wide; `glass` lists the doors (0-based) with a
        # framed glass panel and dishes behind it; a strip of light underneath
        z, h = it.get("z", 1.45), it.get("h", 0.72)
        glass_doors = set(it.get("glass", []))
        n = it.get("doors") or max(1, round(w / 0.5))
        k.box(x0, x1, y0, y0 + 0.012, z, z + h, "white_matte")
        k.box(x0, x1, y0, y1 - 0.02, z, z + 0.018, "white_matte")
        k.box(x0, x1, y0, y1 - 0.02, z + h - 0.018, z + h, "white_matte")
        for sx in (x0, x1 - 0.018):
            k.box(sx, sx + 0.018, y0, y1 - 0.02, z, z + h, "white_matte")
        for i in range(n):
            a, b = x0 + w * i / n, x0 + w * (i + 1) / n
            if i in glass_doors:
                k.box(a + 0.03, b - 0.03, y0 + 0.012, y1 - 0.03, z + h * 0.45, z + h * 0.45 + 0.015, "white_matte")  # a shelf
                for j in range(3):
                    k.cyl(a + (b - a) * (j + 1) / 4, y0 + 0.15, z + 0.018, z + 0.12, 0.05, ["ceramic", "duvet_rust", "ceramic"][j], seg=14)
                    k.cyl(a + (b - a) * (j + 1) / 4, y0 + 0.15, z + h * 0.45 + 0.015, z + h * 0.45 + 0.1, 0.06, "ceramic", seg=14)
                for p0, p1, q0, q1 in ((a, a + 0.05, z, z + h), (b - 0.05, b, z, z + h), (a + 0.05, b - 0.05, z, z + 0.05), (a + 0.05, b - 0.05, z + h - 0.05, z + h)):
                    k.box(p0 + 0.002, p1 - 0.002, y1 - 0.02, y1, q0 + 0.003, q1 - 0.003, "white_matte")
                k.box(a + 0.05, b - 0.05, y1 - 0.012, y1 - 0.008, z + 0.05, z + h - 0.05, "glass")
            else:
                k.box(a + 0.002, b - 0.002, y1 - 0.02, y1, z + 0.003, z + h - 0.003, "white_matte")
        k.box(x0 + 0.05, x1 - 0.05, y1 - 0.08, y1 - 0.06, z - 0.006, z, "globe")                # the under-cabinet light
        bev = 0.003
    elif t == "hood":
        # a black chimney cooker hood: a flat glass canopy over the hob, a black flue to the ceiling
        z = it.get("z", 1.55)
        k.box(x0, x1, y0, y1, z, z + 0.05, "black_glass")
        k.box(x0 + 0.02, x1 - 0.02, y0 + 0.01, y1 - 0.03, z - 0.008, z, "steel")
        k.box(-0.13, 0.13, y0, y0 + 0.24, z + 0.05, CEIL - 0.002, "anthracite")
        bev = 0.003
    elif t == "track-spots":
        # a black ceiling track (w along it) with `n` cylinder spots hanging off it, angled down
        n = it.get("n", 3)
        k.box(x0, x1, -0.015, 0.015, CEIL - 0.035, CEIL - 0.001, "black_metal")
        for i in range(n):
            cx = x0 + 0.15 + (w - 0.3) * i / max(1, n - 1)
            k.cyl(cx, 0, CEIL - 0.1, CEIL - 0.035, 0.006, "black_metal", seg=8)
            k.cyl(cx, 0.0, CEIL - 0.22, CEIL - 0.1, 0.03, "black_metal", seg=16)
        bev = 0.0
    elif t == "chair-shell":
        # a dining chair: a grey upholstered shell (seat and a back curving round) on four black legs; faces +y
        for sx in (x0 + 0.06, x1 - 0.06):
            for sy in (y0 + 0.07, y1 - 0.06):
                k.cyl(sx, sy, 0, 0.45, 0.012, "black_metal", seg=8)
        k.rbox(x0 + 0.01, x1 - 0.01, y0 + 0.04, y1, 0.45, 0.5, 0.1, "chair_grey")
        k.rbox(x0, x1, y0, y0 + 0.07, 0.5, 0.86, (0.04, 0.04, 0.12, 0.12), "chair_grey")
        bev, segs, smooth = 0.02, 3, True
    elif t == "pendant-smoke":
        # a smoked glass globe pendant with a brass cap (the dining pendants), `h` its drop from the ceiling
        drop = it.get("h", 0.9)
        zt = CEIL - drop
        r = min(w, d) / 2
        k.cyl(0, 0, zt + 0.05, CEIL, 0.004, "black_metal", seg=6)
        k.cyl(0, 0, CEIL - 0.02, CEIL - 0.001, 0.05, "brass", seg=20)
        k.lathe(0, 0, [(0.045, zt + 0.05), (0.05, zt), (0.045, zt - 0.03)], "brass", seg=24)
        prof = [(0.045, zt - 0.03)] + [(r * math.sin(a), zt - 0.03 - r * (1 - math.cos(a))) for a in (math.pi * i / 14 for i in range(2, 14))] + [(0.02, zt - 0.03 - 2 * r)]
        k.lathe(0, 0, prof, "smoke_globe", seg=36)
        k.lathe(0, 0, [(0.008, zt - 0.06), (0.025, zt - 0.1), (0.03, zt - 0.17), (0.012, zt - 0.22)], "globe", seg=16)  # the bulb
        bev, smooth = 0.0, True  # smooth: a faceted globe reads as a disco ball
    elif t == "gallery":
        # a gallery wall (x along the wall, z from `z` to z+h): a deterministic cluster of frames of mixed sizes, mostly
        # pale with watercolour-ish city prints, a few dark ones (the two Vermeer canvases)
        z0g, hg = it.get("z", 1.15), it.get("h", 1.25)
        seed = int(it["x"] * 19 + it["y"] * 7) + 3
        inks = ["coat_blue", "coat_camel", "duvet_sage", "duvet_rust", "vase_pink", "linen"]
        cols = max(3, round(w / 0.42))
        cw = w / cols
        for c in range(cols):
            z = z0g + hg
            while True:
                seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
                big = (seed >> 7) % 5 == 0
                fh = (0.5 if big else 0.22 + (seed >> 9) % 4 * 0.05)
                fw = min(cw - 0.06, fh * (0.75 if big else 1.15))
                if z - fh < z0g - 0.05:
                    break
                cx = x0 + cw * (c + 0.5) + ((seed >> 5) % 5 - 2) * 0.01
                fm = "canvas_dark" if big else ("walnut" if (seed >> 11) % 3 == 0 else "frame")
                k.box(cx - fw / 2, cx + fw / 2, y0, y0 + 0.025, z - fh, z, fm)
                if not big:
                    k.box(cx - fw / 2 + 0.03, cx + fw / 2 - 0.03, y0 + 0.025, y0 + 0.027, z - fh + 0.03, z - 0.03, "paper")
                    k.box(cx - fw / 4, cx + fw / 4, y0 + 0.027, y0 + 0.029, z - fh * 0.7, z - fh * 0.3, inks[(seed >> 13) % len(inks)])
                else:
                    k.box(cx - fw * 0.15, cx + fw * 0.2, y0 + 0.025, y0 + 0.027, z - fh * 0.75, z - fh * 0.2, "coat_camel")
                z -= fh + 0.08 + (seed >> 15) % 3 * 0.02
        bev = 0.002
    elif t == "painting":
        # one large framed canvas (w x h, its bottom at z), gold-toned (the cranes) unless `color` says otherwise
        z, h = it.get("z", 0.95), it.get("h", 1.3)
        k.box(x0, x1, y0, y0 + 0.035, z, z + h, "frame_dark")
        canvas = tone(it["color"], 0.7, "canvas") if it.get("color") else "canvas_gold"
        k.box(x0 + 0.02, x1 - 0.02, y0 + 0.035, y0 + 0.037, z + 0.02, z + h - 0.02, canvas)
        k.box(x0 + w * 0.15, x1 - w * 0.2, y0 + 0.037, y0 + 0.039, z + h * 0.6, z + h * 0.75, "linen")   # a crane in flight
        k.box(x0 + w * 0.5, x0 + w * 0.7, y0 + 0.037, y0 + 0.039, z + h * 0.18, z + h * 0.45, "linen")  # one standing
        bev = 0.002
    elif t == "plant-stand":
        # a three-legged grey metal plant stand with two tiers, a big leafy plant and a palm on it
        h = it.get("h", 0.75)
        r = min(w, d) / 2
        for i in range(3):
            a = i * 2 * math.pi / 3
            k.cyl(r * 0.8 * math.cos(a), r * 0.8 * math.sin(a), 0, h, 0.012, "frame_grey", seg=8)
        for z in (0.2, h):
            k.cyl(0, 0, z - 0.015, z, r, "frame_grey", seg=24)
        k.lathe(0, 0, [(0.1, 0.2), (0.14, 0.42)], "anthracite", seg=18)
        k.lathe(0, 0, [(0.07, h), (0.1, h + 0.16)], "vase_pink", seg=18)
        seed = int(it["x"] * 29 + it["y"] * 13)
        for i in range(46):  # leaves: broad pads in a loose crown over the top tier, a palm's fronds on the lower one
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            top = i < 34
            a = (seed >> 4) % 360 * math.pi / 180
            rr = (0.04 + (seed >> 9) % 7 * 0.035) if top else (0.12 + (seed >> 9) % 4 * 0.05)
            z = (h + 0.12 + (seed >> 12) % 10 * 0.06) if top else (0.38 + (seed >> 12) % 5 * 0.05)
            L, Wd = (0.15, 0.11) if top else (0.24, 0.05)
            k.obox(rr * math.cos(a), rr * math.sin(a), L, Wd, a + 0.4, z, z + 0.01, "leaf")
        for a in (0.3, 2.4, 4.4):  # stems
            k.obox(0.06 * math.cos(a), 0.06 * math.sin(a), 0.012, 0.012, a, h + 0.1, h + 0.7, "leaf")
        bev = 0.0
    else:
        k.box(x0, x1, y0, y1, 0, it.get("h", 0.5), "oak_furn")
    if k.bm.faces:
        k.to_object(name, matrix=M, collection=coll, bevel=bev, segments=segs, smooth=smooth)
    else:
        k.bm.free()


def stairs(k, w, d, rise_total, zmin=None, zmax=None):
    """A quarter-turn stair in its own frame: enters from -x at the front (-y), winds to climb +y, and winds again at the
    back to leave towards -x. Treads in oak, risers and the stepped underside white."""
    x0, x1, y0, y1 = -w / 2, w / 2, -d / 2, d / 2
    s = w
    nw = 4
    straight = max(0.0, d - 2 * s)
    ns = max(1, round(straight / 0.23)) if straight > 0.05 else 0
    N = 2 * nw + ns
    rise = rise_total / (N + 1)
    steps = []

    def bound_bottom(th):
        px, py = x0, y0 + s
        c, sn = math.cos(th), math.sin(th)
        ts = []
        if sn < -1e-6:
            ts.append(-s / sn)
        if c > 1e-6:
            ts.append(s / c)
        t = min(ts)
        return (px + c * t, py + sn * t)

    def bound_top(th):
        px, py = x0, y1 - s
        c, sn = math.cos(th), math.sin(th)
        ts = []
        if sn > 1e-6:
            ts.append(s / sn)
        if c > 1e-6:
            ts.append(s / c)
        t = min(ts)
        return (px + c * t, py + sn * t)

    for i in range(nw):
        a, b = -math.pi / 2 + (math.pi / 2) * i / nw, -math.pi / 2 + (math.pi / 2) * (i + 1) / nw
        poly = [(x0, y0 + s), bound_bottom(a)]
        if a < -math.pi / 4 < b:
            poly.append((x1, y0))
        poly.append(bound_bottom(b))
        steps.append(poly)
    for i in range(ns):
        ya, yb = y0 + s + straight * i / ns, y0 + s + straight * (i + 1) / ns
        steps.append([(x0, ya), (x1, ya), (x1, yb), (x0, yb)])
    for i in range(nw):
        a, b = (math.pi / 2) * i / nw, (math.pi / 2) * (i + 1) / nw
        poly = [(x0, y1 - s), bound_top(a)]
        if a < math.pi / 4 < b:
            poly.append((x1, y1))
        poly.append(bound_top(b))
        steps.append(poly)
    for i, poly in enumerate(steps):
        top = (i + 1) * rise
        if (zmax is not None and top > zmax + 1e-3) or (zmin is not None and top - rise - 0.12 < zmin - 1e-3):
            continue
        k.prism(poly, max(0.0, top - rise - 0.12), top - 0.035, "white_matte")
        k.prism(poly, top - 0.035, top, "oak_furn")


# ---------------------------------------------------------------- scene, camera, lights
def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev in ("METAL", "CUDA", "OPTIX", "HIP"):
        try:
            prefs.compute_device_type = dev
            prefs.get_devices()
            if any(d.type == dev for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == dev
                sc.cycles.device = "GPU"
                log("cycles device", dev)
                break
        except Exception:
            continue
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 3
    sc.cycles.transmission_bounces = 6
    sc.cycles.transparent_max_bounces = 8
    sc.cycles.sample_clamp_indirect = 8
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = JOB.get("look", "AgX - Medium High Contrast")
    except Exception:
        try:
            sc.view_settings.look = "Medium High Contrast"
        except Exception:
            pass
    sc.view_settings.exposure = JOB.get("exposure", 0.0)
    if not sc.world:
        sc.world = bpy.data.worlds.new("World")
    return sc


def world_day(sc, strength=1.0):
    w = sc.world
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    p = os.path.join(CACHE, "hdri", JOB.get("hdri", "kloofendal_48d_partly_cloudy_puresky") + ".hdr")
    if os.path.exists(p):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(p, check_existing=True)
        mp = nt.nodes.new("ShaderNodeMapping")
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp.inputs["Rotation"].default_value = (0, 0, math.radians(JOB.get("hdri_rot", 0)))
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (0.6, 0.7, 0.85, 1)
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def world_flat(sc, colour, strength):
    w = sc.world
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (*colour, 1)
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_sun(name, az_deg, el_deg, strength, colour=(1, 0.96, 0.9), angle=2.5):
    d = bpy.data.lights.new(name, "SUN")
    d.energy = strength
    d.color = colour
    d.angle = math.radians(angle)
    o = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(o)
    # sun direction: azimuth in the scene's XY (0 = from +Y, the garden), elevation above the horizon
    az, el = math.radians(az_deg), math.radians(el_deg)
    v = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    o.rotation_euler = (-v).to_track_quat("-Z", "Y").to_euler()
    return o


def make_camera(sc):
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    o = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(o)
    sc.camera = o
    a = math.radians(JOB.get("cam_az", -32))  # 0 = straight from the garden; + swings to the x = 0 side
    el = math.radians(JOB.get("cam_el", 52))
    d = Vector((-math.sin(a) * math.cos(el), math.cos(a) * math.cos(el), math.sin(el)))
    if MIRROR:
        d.x = -d.x
    o.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    o.location = Vector((W / 2, 6, 0)) + d * 40
    bpy.context.view_layer.update()
    return o, d


def fit_camera(sc, cam, floors):
    """One scale and size for every storey, so the pictures line up; each storey is centred on its own floor."""
    R = cam.matrix_world.to_3x3()
    right, up = R.col[0], R.col[1]
    xs, ys = [], []
    for f in floors:
        for x in (-WO - 0.2, W + WO + 0.2):
            for y in (-WO - 0.2, f["depth"] + WO + 0.2):
                for z in (-SLAB, CUT if not f.get("roof") else 1.7):
                    p = P(x, y, z)
                    xs.append(p.dot(right))
                    ys.append(p.dot(up))
    ex, ey = max(xs) - min(xs), max(ys) - min(ys)
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    width = JOB.get("width", 1600)
    pad = 1.04
    sc.render.resolution_x = width
    sc.render.resolution_y = int(round(width * ey / ex / 2) * 2)
    cam.data.ortho_scale = max(ex, ey) * pad
    # shift the camera (in its own plane) so the box is centred
    base_loc = cam.location.copy()
    cur_x, cur_y = base_loc.dot(right), base_loc.dot(up)
    cam.location = base_loc + right * (cx - cur_x) + up * (cy - cur_y)
    bpy.context.view_layer.update()
    return cam.location.copy()


def projector(sc, cam):
    """pixel (u, v) = A @ (x, y, z, 1) for model coordinates (z absolute), from the camera as it is now."""
    from bpy_extras.object_utils import world_to_camera_view
    rx, ry = sc.render.resolution_x, sc.render.resolution_y

    def px(x, y, z):
        v = world_to_camera_view(sc, cam, P(x, y, z))
        return (v.x * rx, (1 - v.y) * ry)

    o = px(0, 0, 0)
    ax, ay, az = px(1, 0, 0), px(0, 1, 0), px(0, 0, 1)
    A = [[ax[0] - o[0], ay[0] - o[0], az[0] - o[0], o[0]], [ax[1] - o[1], ay[1] - o[1], az[1] - o[1], o[1]]]
    return A, px


KELVIN = {2200: (1.0, 0.56, 0.24), 2700: (1.0, 0.68, 0.40), 3000: (1.0, 0.74, 0.5)}


def room_lights(f, room, coll):
    """A warm ceiling light per rectangle of the room, power by area."""
    base = f["level"] * SH
    obs = []
    for i, q in enumerate(room["rects"]):
        area = q["w"] * q["d"]
        if area < 0.3:
            continue
        L = bpy.data.lights.new(f"L_{room['id']}_{i}", "AREA")
        L.shape = "RECTANGLE"
        L.size, L.size_y = max(0.3, q["w"] * 0.45), max(0.3, q["d"] * 0.45)
        L.energy = min(260, 13 * area + 25) * JOB.get("lamp_gain", 1.0)
        L.color = KELVIN[JOB.get("room_kelvin", 2700)]
        o = bpy.data.objects.new(L.name, L)
        o.location = P(q["x"] + q["w"] / 2, q["y"] + q["d"] / 2, base + min(CEIL - 0.05, CUT + 0.4))
        coll.objects.link(o)
        obs.append(o)
    return obs


def lamp_light(light, f, coll):
    """A placed HA light: a ceiling light over the pin, a table lamp, or a dim night light. The TV unit's lights take
    their place from the furniture, not the pin: "strip" is the LED strip under the TV unit (yellow on the floor) and
    the strip lights inside the display towers; "ambilight" lights the wall behind the TV, blue."""
    base = f["level"] * SH
    kind = light.get("kind", "ceiling")
    if kind in ("strip", "ambilight"):
        obs = []

        def area(name, M, local, size, size_y, energy, colour, aim=(0, 0, -1)):
            """A rectangular light at `local` in the piece's frame, shining along `aim` (its -Z), unseen by the camera."""
            L = bpy.data.lights.new(name, "AREA")
            L.shape, L.size, L.size_y, L.energy, L.color = "RECTANGLE", size, size_y, energy, colour
            o = bpy.data.objects.new(name, L)
            o.matrix_world = M @ Matrix.Translation(local) @ Vector(aim).to_track_quat("-Z", "Y").to_matrix().to_4x4()
            o.visible_camera = False
            coll.objects.link(o)
            obs.append(o)

        for i, it in enumerate(f.get("furniture", []) or []):
            M = piece_matrix(it, base)
            w, d = it.get("w", DEFAULTS.get(it["type"], (0.5, 0.5))[0]), it.get("d", DEFAULTS.get(it["type"], (0.5, 0.5))[1])
            if it["type"] == "tv-unit" and kind == "strip":  # under the hung unit, shining down: a warm yellow wash
                area(f"L_{light['id']}_{i}", M, (0, 0.05, it.get("z", 0.14) - 0.01), w - 0.1, 0.06, 55 * w * JOB.get("strip_gain", 1.0), (1.0, 0.5, 0.03))  # saturated: AgX bleaches it
            elif it["type"] == "tv-unit":                   # the TV's back edges, shining out over the wall round it
                tvw = it.get("tvw", min(1.45, w * 0.72))
                # yb: in the 3 cm gap between the wall and the TV's back (at -d/2 + 0.04 they sat inside the TV's body and
                # never lit anything, 2026-11-01)
                tvh, tz, tc, yb = tvw * 0.5625, it.get("tv", 0.85), it.get("tvAt", 0.0), -d / 2 + 0.017
                blue = (0.06, 0.28, 1.0)  # pure: AgX turns a bright pale blue white
                for j, (pos, sz, aim) in enumerate((((tc, yb, tz + tvh - 0.03), (tvw * 0.9, 0.03), (0, -1, 0.9)),
                                                    ((tc, yb, tz + 0.03), (tvw * 0.9, 0.03), (0, -1, -0.9)),
                                                    ((tc - tvw / 2 + 0.03, yb, tz + tvh / 2), (0.03, tvh * 0.9), (-0.9, -1, 0)),
                                                    ((tc + tvw / 2 - 0.03, yb, tz + tvh / 2), (0.03, tvh * 0.9), (0.9, -1, 0)))):
                    area(f"L_{light['id']}_{i}_{j}", M, pos, *sz, (30 if j < 2 else 18) * JOB.get("ambilight_gain", 1.0), blue, aim)
            elif it["type"] == "display-tower" and kind == "strip":  # one strip under each cube's top board
                h, cubes = it.get("h", 1.5), it.get("cubes", 2)
                ch = (h - 0.08 - 0.025) / cubes
                for c in range(cubes):
                    area(f"L_{light['id']}_{i}_{c}", M, (0, d / 2 - 0.08, 0.08 + (c + 1) * ch - 0.03), w - 0.1, 0.03, 6, KELVIN[3000])
        if obs:
            return obs
        kind = "lamp"
    L = bpy.data.lights.new("L_" + light["id"], "POINT")
    if kind == "night":
        L.energy, L.shadow_soft_size, L.color, z = 4, 0.05, KELVIN[2200], 0.35
    elif kind == "lamp":
        L.energy, L.shadow_soft_size, L.color, z = 30, 0.08, KELVIN[2700], 0.95
    else:
        L.energy, L.shadow_soft_size, L.color, z = 120, 0.25, KELVIN[2700], min(CEIL - 0.3, CUT + 0.2)
    o = bpy.data.objects.new(L.name, L)
    o.location = P(light["x"], light["y"], base + z)
    coll.objects.link(o)
    return [o]


# ---------------------------------------------------------------- render passes
def render_to(sc, path, samples, rgba=True, quality=82):
    sc.cycles.samples = samples
    s = sc.render.image_settings
    s.file_format = "WEBP"
    s.color_mode = "RGBA" if rgba else "RGB"
    s.quality = quality
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    s.file_format = "PNG"
    s.color_mode = "RGBA"
    log("rendered", os.path.basename(path), f"{time.time() - t:.1f}s")


def set_visible(objs, on):
    for o in objs:
        o.hide_render = not on


def main():
    sc = setup_scene()
    make_materials()
    floors = sorted(H["floors"], key=lambda f: f["level"])
    want = JOB.get("floors") or [f["id"] for f in floors]
    colls, rooms = {}, {}
    for f in floors:
        c = bpy.data.collections.new(f["id"])
        sc.collection.children.link(c)
        colls[f["id"]] = c
        rooms[f["id"]] = build_storey(f, c)
        log("built", f["id"], len(c.objects), "objects")
    cam, _ = make_camera(sc)
    fit_camera(sc, cam, floors)
    cam_home = cam.location.copy()
    sun = add_sun("sun", JOB.get("sun_az", -125), JOB.get("sun_el", 42), JOB.get("sun_strength", 3.2))
    moon = add_sun("moon", 160, 50, 0.25, colour=(0.6, 0.7, 1.0), angle=1.0)
    light_coll = bpy.data.collections.new("lights")
    sc.collection.children.link(light_coll)
    # every light in the scene, off by default
    passes = {}
    for f in floors:
        for r in f["rooms"]:
            if r.get("kind") in ("storage",) or sum(q["w"] * q["d"] for q in r["rects"]) < 0.6:
                continue
            passes[f"room:{r['id']}"] = (f, room_lights(f, r, light_coll))
    for l in JOB.get("lights", []):
        f = next((x for x in floors if x["id"] == l["floor"]), None)
        if f:
            passes[f"light:{l['id']}"] = (f, lamp_light(l, f, light_coll))
    all_lights = [o for _, obs in passes.values() for o in obs]
    set_visible(all_lights, False)
    if JOB.get("views"):  # eye-level stills from given cameras (photo comparisons), see render_views
        render_views(sc, floors, colls, passes, sun, moon)
        return
    if JOB.get("glb"):  # the 3D view's models instead of the photos (a second run of this script, see render.ts)
        export_glbs(sc, floors, want, colls, passes, sun, moon)
        return

    manifest = {"version": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "width": sc.render.resolution_x, "height": sc.render.resolution_y,
                "mirror": MIRROR, "cut": CUT, "floors": {}, "camera": {"az": JOB.get("cam_az", -32), "el": JOB.get("cam_el", 52)}}
    s_day, s_night, s_light = JOB.get("samples_day", 96), JOB.get("samples_night", 64), JOB.get("samples_light", 48)
    for f in floors:
        if f["id"] not in want:
            continue
        base = f["level"] * SH
        for fid, c in colls.items():
            c.hide_render = fid != f["id"]
        for x in floors:  # this storey's stairs, and the flight below seen down the stairwell
            STAIRS[x["id"]].hide_render = x["level"] != f["level"]
        cam.location = cam_home + Vector((0, 0, base))
        bpy.context.view_layer.update()
        A, px = projector(sc, cam)
        entry = {"base": base, "project": A, "images": {}, "rooms": {}, "lights": {}}
        fid = f["id"]
        # day
        world_day(sc, JOB.get("sky", 0.8))
        sun.hide_render, moon.hide_render = False, True
        render_to(sc, os.path.join(OUT, f"{fid}-day.webp"), s_day)
        entry["images"]["day"] = f"{fid}-day.webp"
        # night: moonlight and a little sky, every lamp off
        world_flat(sc, (0.06, 0.08, 0.14), JOB.get("night_sky", 0.9))
        sun.hide_render, moon.hide_render = True, False
        render_to(sc, os.path.join(OUT, f"{fid}-night.webp"), s_night)
        entry["images"]["night"] = f"{fid}-night.webp"
        # one overlay per light on this storey: only that light, a black world
        world_flat(sc, (0, 0, 0), 0)
        moon.hide_render = True
        for key, (lf, obs) in passes.items():
            if lf["id"] != fid:
                continue
            set_visible(obs, True)
            name = key.replace(":", "-").replace(".", "_")
            # with alpha: outside the house it's transparent, so `screen` can't darken the page around the picture
            render_to(sc, os.path.join(OUT, f"{fid}-{name}.webp"), s_light, quality=80)
            set_visible(obs, False)
            entry["lights"][key] = f"{fid}-{name}.webp"
        # room mask
        entry["mask"], entry["rooms"] = render_mask(sc, f, rooms[fid], fid)
        for r in f["rooms"]:
            q = max(r["rects"], key=lambda q: q["w"] * q["d"])
            u, v = px(q["x"] + q["w"] / 2, q["y"] + q["d"] / 2, base)
            entry["rooms"].setdefault(r["id"], {})["centre"] = [round(u, 1), round(v, 1)]
        manifest["floors"][fid] = entry
        manifest["pins"] = manifest.get("pins", {})
        for p in JOB.get("pins", []):
            if p["floor"] == fid:
                u, v = px(p["x"], p["y"], base + 0.5)
                manifest["pins"][p["id"]] = {"floor": fid, "u": round(u, 1), "v": round(v, 1)}
        json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    log("done", len(manifest["floors"]), "floors")


def render_views(sc, floors, colls, passes, sun, moon):
    """(2026-11-01) Eye-level perspective stills of the full-height storey with a ceiling (job: views, cut and
    near_cut at the room height, ceiling): per view {name, floor, pos [x, y, z], look [x, y, z] in plan metres, lens},
    an evening picture (every lamp of the storey on, a dark blue sky) and, with day, a daylight one. For comparing
    with reference photos; not used by the page."""
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = JOB.get("view_size", (1600, 1200))
    cd = bpy.data.cameras.new("eye")
    co = bpy.data.objects.new("eye", cd)
    sc.collection.objects.link(co)
    sc.camera = co
    for v in JOB["views"]:
        f = next(x for x in floors if x["id"] == v.get("floor", "ground"))
        base = f["level"] * SH
        for fid, c in colls.items():
            c.hide_render = fid != f["id"]
        for x in floors:
            STAIRS[x["id"]].hide_render = x["level"] != f["level"]
        pos, look = Vector(P(*v["pos"][:2], base + v["pos"][2])), Vector(P(*v["look"][:2], base + v["look"][2]))
        co.location = pos
        co.rotation_euler = (look - pos).to_track_quat("-Z", "Y").to_euler()
        cd.lens, cd.sensor_width = v.get("lens", 24), 36
        lamps = [o for key, (lf, obs) in passes.items() if lf["id"] == f["id"] for o in obs]
        world_flat(sc, (0.02, 0.03, 0.06), 0.5)
        sun.hide_render, moon.hide_render = True, True
        set_visible(lamps, True)
        sc.view_settings.exposure = JOB.get("evening_exposure", 0.6)
        render_to(sc, os.path.join(OUT, f"{v['name']}-evening.webp"), JOB.get("samples_view", 256), rgba=False)
        set_visible(lamps, False)
        if JOB.get("day", True):
            world_day(sc, JOB.get("sky", 0.8))
            sun.hide_render = False
            sc.view_settings.exposure = JOB.get("day_exposure", 0.3)
            render_to(sc, os.path.join(OUT, f"{v['name']}-day.webp"), JOB.get("samples_view", 256), rgba=False)
        log("view", v["name"])


# ---------------------------------------------------------------- the 3D view: baked GLBs
# The orbitable 3D view is this same scene with its light baked into textures (the floor3d-card idea, baked in Cycles).
# Per storey the visible meshes are copied with their modifiers applied, the heavy Poly Haven meshes decimated, joined
# and cut into a few chunks of similar area, each unwrapped onto its own atlas. Each chunk gets three maps, saved next
# to the GLB as WebP: its albedo (full detail, a few samples), the day's diffuse light (sun and sky) and the light of
# the rooms' ceiling lights (black world), both at a lower resolution, since light is soft; a storey with placed lights
# (a night light, a table lamp: pins of their own) gets a fourth map with only those. The page multiplies albedo by
# light, adds the lamp light room by room from the live states, and tone maps (AgX, like the photos);
# night is the day light dimmed to moonlight. Glass and leaves (alpha-cut textures) stay unbaked meshes.
import numpy as np


def preload_compressors():
    """The bpy wheel's glTF meshopt bridge can't find libmeshoptimizer on its rpath: load it first, by hand."""
    import ctypes
    lib = os.path.join(os.path.dirname(bpy.__file__), "lib")
    for n in ("libmeshoptimizer.dylib", "libmeshoptimizer.so"):
        p = os.path.join(lib, n)
        if os.path.exists(p):
            try:
                ctypes.CDLL(p, mode=ctypes.RTLD_GLOBAL)
            except OSError as e:
                log("meshopt preload failed", e)
    # the exporter stores positions with 12 mantissa bits and one exponent per vertex, about 8 mm steps across a
    # 13 m storey: a frame's photo 2 mm in front of it lands on the frame's plane and the two z-fight. 20 bits: 0.03 mm.
    from io_scene_gltf2.io.exp import meshopt
    meshopt.EXP_FILTER_BITS = 20


def bake_materials():
    """Box-projected textures follow Object coordinates; the joined meshes sit at the origin, so map by world position
    instead (the same for walls and floors, built in world coordinates). Metals bake as their colour (no reflections
    in a diffuse bake)."""
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        nt = m.node_tree
        for tc in [n for n in nt.nodes if n.bl_idname == "ShaderNodeTexCoord"]:
            for l in list(tc.outputs["Object"].links):
                nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], l.to_socket)
        for b in [n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"]:
            s = b.inputs["Metallic"]
            for l in list(s.links):
                nt.links.remove(l)
            if s.default_value > 0.5:
                c = b.inputs["Base Color"]
                if not c.is_linked:
                    c.default_value = (*[v * 0.75 for v in c.default_value[:3]], 1)
            s.default_value = 0.0


def is_glass(m):
    return bool(m) and "glass" in m.name.lower()


def is_cutout(m):
    """A material with an alpha-cut texture (Poly Haven leaves)."""
    if not m or not m.node_tree:
        return False
    return any(n.bl_idname == "ShaderNodeBsdfPrincipled" and n.inputs["Alpha"].is_linked for n in m.node_tree.nodes)


def copy_meshes(objs, coll, max_faces):
    """World-space copies with modifiers applied; heavy meshes (the Poly Haven models) decimated."""
    out = []
    for o in objs:
        n = len(o.data.polygons)
        cap = max_faces * (6 if any(is_cutout(s.material) for s in o.material_slots) else 1)  # leaves fall apart sooner
        dec = None
        if n > cap:
            dec = o.modifiers.new("glb_decimate", "DECIMATE")
            dec.ratio = max(0.04, cap / n)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        if dec:
            o.modifiers.remove(dec)
        me.transform(o.matrix_world)
        if o.matrix_world.determinant() < 0:
            me.flip_normals()
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        c = bpy.data.objects.new("glb_" + o.name, me)
        coll.objects.link(c)
        out.append(c)
    return out


def coplanar_report(me, label):
    """Faces that lie in one plane, face the same way and overlap (more than 1 cm2): they z-fight in the 3D view. A
    check for the model's geometry (house:render --check), not part of the output."""
    from collections import defaultdict
    buckets = defaultdict(list)
    mats = [m.name if m else "?" for m in me.materials]
    for p in me.polygons:
        if p.area < 1e-5 or p.normal.z < -0.7:  # faces looking down are only seen from under the floor
            continue
        n = p.normal
        d = n.dot(p.center)
        buckets[(round(n.x, 2), round(n.y, 2), round(n.z, 2), round(d / 0.002))].append(p)

    def clip(poly, a, b):  # keep the part of poly left of the edge a -> b (Sutherland-Hodgman, convex)
        out = []
        side = lambda q: (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        for i in range(len(poly)):
            p0, p1 = poly[i], poly[(i + 1) % len(poly)]
            s0, s1 = side(p0), side(p1)
            if s0 >= 0:
                out.append(p0)
            if (s0 >= 0) != (s1 >= 0):
                t = s0 / (s0 - s1)
                out.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t))
        return out

    def area(poly):
        return abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))) / 2

    hits = []
    keys = list(buckets)
    for key in keys:
        group = buckets[key] + buckets.get((*key[:3], key[3] + 1), [])
        if len(group) < 2:
            continue
        n = group[0].normal
        u = n.orthogonal().normalized()
        v = n.cross(u)
        flat = []
        for p in group:
            pts = [(u.dot(me.vertices[i].co), v.dot(me.vertices[i].co)) for i in p.vertices]
            if sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) < 0:
                pts = pts[::-1]
            xs, ys = [q[0] for q in pts], [q[1] for q in pts]
            flat.append((min(xs), max(xs), min(ys), max(ys), pts, p))
        flat.sort(key=lambda f: f[0])
        for i, A in enumerate(flat):
            for B in flat[i + 1:]:
                if B[0] >= A[1]:
                    break
                if B[3] <= A[2] or B[2] >= A[3] or abs(n.dot(A[5].center) - n.dot(B[5].center)) > 0.001:
                    continue
                inter = A[4]
                for j in range(len(B[4])):
                    inter = clip(inter, B[4][j], B[4][(j + 1) % len(B[4])])
                    if len(inter) < 3:
                        break
                if len(inter) >= 3 and area(inter) > 1e-4:
                    hits.append((area(inter), A[5], B[5]))
    hits.sort(key=lambda h: -h[0])
    log(f"check {label}: {len(hits)} overlapping coplanar face pairs")
    for a, p, q in hits[:40]:
        c = p.center
        log(f"  {a * 1e4:7.1f} cm2 at ({c.x:.2f}, {c.y:.2f}, {c.z:.2f}) n=({p.normal.x:.0f},{p.normal.y:.0f},{p.normal.z:.0f}) {mats[p.material_index]} / {mats[q.material_index]}")
    return hits


def select_only(objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def join(objs):
    select_only(objs)
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    return objs[0]


def subset(me, idx, name, coll):
    """A new object with only the faces idx of me."""
    m2 = me.copy()
    bm = bmesh.new()
    bm.from_mesh(m2)
    keep = set(idx)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
    bm.to_mesh(m2)
    bm.free()
    ob = bpy.data.objects.new(name, m2)
    coll.objects.link(ob)
    return ob


def split_by_area(me, faces, k):
    """k groups of faces with about the same area, cut along the longest axis each time (so each group is one area)."""
    items = [(i, me.polygons[i].center.copy(), me.polygons[i].area) for i in faces]

    def split(items, k):
        if k <= 1 or len(items) < 2:
            return [items]
        ax = max(range(3), key=lambda a: max(t[1][a] for t in items) - min(t[1][a] for t in items))
        items = sorted(items, key=lambda t: t[1][ax])
        ka, goal, acc, j = k // 2, sum(t[2] for t in items) * (k // 2) / k, 0.0, 0
        for j, t in enumerate(items):
            acc += t[2]
            if acc >= goal:
                break
        return split(items[:j + 1], ka) + split(items[j + 1:], k - ka)

    return [[t[0] for t in g] for g in split(items, k) if g]


def keep_uv(me, name):
    for l in [l for l in me.uv_layers if l.name != name]:
        me.uv_layers.remove(l)


def unwrap(ob, margin):
    me = ob.data
    lm = me.uv_layers.new(name="lightmap")
    me.uv_layers.active = lm
    for l in me.uv_layers:  # the models' own textures keep reading their UVs
        l.active_render = l.name == "UVMap"
    select_only([ob])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    # smart_project's own packing leaves half the atlas empty: pack again, tightly
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


def bake(sc, ob, img, samples, margin, passes, kind="DIFFUSE"):
    """A bake of ob into img through its lightmap UVs: diffuse ({'COLOR'}: albedo; {'DIRECT', 'INDIRECT'}: light), or
    kind "AO" (contact shadows) / "ROUGHNESS" (passes ignored)."""
    added = []
    for m in {s.material for s in ob.material_slots if s.material and s.material.node_tree}:
        n = m.node_tree.nodes.new("ShaderNodeTexImage")
        n.image = img
        m.node_tree.nodes.active = n
        added.append((m, n))
    sc.cycles.samples = samples
    bk = sc.render.bake
    bk.target, bk.margin, bk.margin_type, bk.use_clear = "IMAGE_TEXTURES", margin, "EXTEND", True
    select_only([ob])
    t = time.time()
    if kind == "DIFFUSE":
        bpy.ops.object.bake(type="DIFFUSE", pass_filter=passes, uv_layer="lightmap", margin=margin, use_clear=True)
    else:
        bpy.ops.object.bake(type=kind, uv_layer="lightmap", margin=margin, use_clear=True)
    for m, n in added:
        m.node_tree.nodes.remove(n)
    log("baked", img.name, f"{img.size[0]}px", samples, "samples", f"{time.time() - t:.1f}s")


def pixels(img, blur=0):
    """An image's RGB as an (h, w, 3) array, with `blur` passes of a [1 2 1] blur (bake noise out)."""
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    c = np.clip(px.reshape(h, w, 4)[..., :3], 0, None)
    for _ in range(blur):
        for ax in (0, 1):
            c = (np.roll(c, 1, ax) + 2 * c + np.roll(c, -1, ax)) / 4
    return c


def save_map(img, path, light, quality, ao=None, rough=None):
    """8-bit WebP: albedo in sRGB; light (scene-linear, can pass 1) as sqrt(l / (1 + l)), decoded by the page.
    Albedo extras (2026-11-01): ao (h, w) darkens it by fine contact shadows the low-res light maps can't hold; rough
    (h, w) goes into alpha as 1 - gloss / 2, gloss = (1 - roughness)^2, which the page turns into reflections (alpha
    stays >= 0.5, so browsers that premultiply images lose no colour)."""
    w, h = img.size
    c = pixels(img)
    if ao is not None:
        c = c * (1 - JOB.get("glb_ao", 0.6) * (1 - np.clip(ao, 0, 1)))[..., None]
    if light:  # a light [1 2 1] blur takes the bake's last noise out (light is soft; the island margins cover the reach)
        for ax in (0, 1):
            c = (np.roll(c, 1, ax) + 2 * c + np.roll(c, -1, ax)) / 4
    v = np.sqrt(c / (c + 1)) if light else np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(v, 0, 1)
    if rough is not None:
        rgba[..., 3] = 1 - 0.5 * np.square(1 - np.clip(rough, 0, 1))
    out = bpy.data.images.new(img.name + "_8bit", w, h, alpha=rough is not None)
    out.colorspace_settings.name = "Non-Color"  # the values are already encoded: write them as they are
    out.pixels.foreach_set(rgba.ravel())
    out.file_format = "WEBP"
    out.save(filepath=path, quality=quality)
    bpy.data.images.remove(out)
    bpy.data.images.remove(img)


def pow2(n, lo=256, hi=2048):
    s = lo
    while s < n and s < hi:
        s *= 2
    return s


def DOOR_LABEL(name):
    """glTF node name from the leaf's object name: ground_door_3 -> ground3 (the page finds these by name)."""
    return name.replace("_door_", "")


def export_glbs(sc, floors, want, colls, passes, sun, moon):
    preload_compressors()
    bake_materials()
    dens, dens_l = JOB.get("glb_density", 100), JOB.get("glb_light_density", 36)  # atlas pixels per metre
    atlas, fill = JOB.get("glb_atlas", 2048), 0.55                                 # fill: how much islands cover
    s_alb, s_day, s_lamp = JOB.get("glb_samples_albedo", 4), JOB.get("glb_samples", 256), JOB.get("glb_samples_lamp", 256)
    q = JOB.get("glb_quality", 82)
    out = {"version": 1, "gloss": bool(JOB.get("glb_gloss", True)), "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "mirror": MIRROR, "cut": CUT, "storeyHeight": SH,
           "camera": {"az": JOB.get("cam_az", -32), "el": JOB.get("cam_el", 52)}, "exposure": JOB.get("exposure", 0.0), "floors": {}}
    for f in floors:
        fid = f["id"]
        if fid not in want:
            continue
        t0 = time.time()
        base = f["level"] * SH
        for k, c in colls.items():
            c.hide_render = k != fid
        for x in floors:
            STAIRS[x["id"]].hide_render = x["id"] != fid
        src = [o for o in list(colls[fid].all_objects) + list(STAIRS[fid].all_objects) if o.type == "MESH"]
        coll = bpy.data.collections.new("glb_" + fid)
        sc.collection.children.link(coll)
        leaves = [o for o in src if o.name in DOORS]
        leaf_names = {o.name for o in leaves}
        ups = [o for o in src if o.name in UPS]
        up_names = {o.name for o in ups}
        capobs = [o for o in src if o.name in CUTCAPS]
        ob = join(copy_meshes([o for o in src if o.name not in leaf_names and o.name not in up_names and o.name not in CUTCAPS], coll, JOB.get("glb_max_faces", 2500)))
        # the outer walls' upper parts (above the dollhouse cut): one node per side, the page folds them down by camera
        up_copies = copy_meshes(ups, coll, 100000)
        up_keys = []
        for uc, uo in zip(up_copies, ups):
            uc.data.attributes.new("up_id", "INT", "FACE")
            for qq in uc.data.polygons:
                uc.data.attributes["up_id"].data[qq.index].value = len(up_keys)
            up_keys.append(UPS[uo.name])
        up_ob = join(up_copies) if up_copies else None
        # the door leaves: copied apart, one atlas for all of them (a part of its own), cut into one node per leaf below
        leaf_copies = copy_meshes(leaves, coll, 100000)
        door_names = []
        for lc, lo in zip(leaf_copies, leaves):
            lc.data.attributes.new("door_id", "INT", "FACE")
            for qq in lc.data.polygons:
                lc.data.attributes["door_id"].data[qq.index].value = len(door_names)
            door_names.append(lo.name)
        door_ob = join(leaf_copies) if leaf_copies else None
        colls[fid].hide_render = True  # the copies stand in for the storey now
        STAIRS[fid].hide_render = True
        me = ob.data
        if JOB.get("check"):
            coplanar_report(me, fid)
        mats = list(me.materials)
        kind = ["glass" if is_glass(m) else "cutout" if is_cutout(m) else "solid" for m in mats]
        groups = {"glass": [], "cutout": [], "solid": []}
        for p in me.polygons:
            if p.normal.z < -0.7 and p.center.z < base - 0.05:
                continue  # nobody looks at the slab from below
            groups[kind[p.material_index]].append(p.index)
        extra = [subset(me, groups[g], f"{fid}_{g}", coll) for g in ("glass", "cutout") if groups[g]]
        if capobs:
            extra.append(join(copy_meshes(capobs, coll, 100000)))
            extra[-1].name = f"{fid}_cutcap"
        area = sum(me.polygons[i].area for i in groups["solid"])
        k = max(1, math.ceil(area * dens * dens / fill / (atlas * atlas)))
        parts = [subset(me, g, f"part{i}", coll) for i, g in enumerate(split_by_area(me, groups["solid"], k))]
        door_part = None
        if door_ob:
            door_part = door_ob
            door_part.name = "part_doors"
            parts.append(door_part)
        up_part = None
        if up_ob:
            up_part = up_ob
            up_part.name = "part_ups"
            parts.append(up_part)
        bpy.data.objects.remove(ob)
        log(fid, f"{area:.0f} m2 in {len(parts)} atlases,", sum(len(p.data.polygons) for p in parts), "faces")
        maps = []
        for i, p in enumerate(parts):
            a = sum(q.area for q in p.data.polygons)
            sa, sl = pow2(math.sqrt(a / fill) * dens, hi=atlas), pow2(math.sqrt(a / fill) * dens_l, lo=128, hi=atlas)
            unwrap(p, 3.0 / sl)
            maps.append({"p": p, "sa": sa, "sl": sl, "albedo": f"{fid}-albedo{i}.webp", "sun": f"{fid}-sun{i}.webp", "lamp": f"{fid}-lamp{i}.webp"})
        lights = [o for lf, obs in passes.values() if lf["id"] == fid for o in obs]
        # the rooms' ceiling lights in "lamp", the placed lights (a night light by the cot) apart in "place": the page
        # lights each with its own lamps, so a night light glows where it stands instead of lifting the whole room
        ceiling = [o for key, (lf, obs) in passes.items() if lf["id"] == fid and key.startswith("room:") for o in obs]
        placed = [o for key, (lf, obs) in passes.items() if lf["id"] == fid and key.startswith("light:") for o in obs]
        if placed:
            for i, m in enumerate(maps):
                m["place"] = f"{fid}-place{i}.webp"
        # albedo and the day's light: sun and sky, every lamp off
        world_day(sc, JOB.get("sky", 0.8))
        sun.hide_render, moon.hide_render = False, True
        set_visible(lights, False)
        sc.world.light_settings.distance = JOB.get("glb_ao_distance", 0.25)
        for m in maps:
            # contact shadows and roughness at the albedo's resolution (the light maps are 2-4x coarser)
            ao = rough = None
            if JOB.get("glb_ao", 0.6) > 0:
                img = bpy.data.images.new(m["albedo"] + "_ao", m["sa"], m["sa"], alpha=False, float_buffer=True)
                bake(sc, m["p"], img, JOB.get("glb_samples_ao", 48), 4, None, kind="AO")
                ao = pixels(img, blur=1)[..., 0]
                bpy.data.images.remove(img)
            if JOB.get("glb_gloss", True):
                img = bpy.data.images.new(m["albedo"] + "_rough", m["sa"], m["sa"], alpha=False, float_buffer=True)
                bake(sc, m["p"], img, 1, 4, None, kind="ROUGHNESS")
                rough = pixels(img)[..., 0]
                bpy.data.images.remove(img)
            img = bpy.data.images.new(m["albedo"], m["sa"], m["sa"], alpha=False, float_buffer=True)
            bake(sc, m["p"], img, s_alb, 4, {"COLOR"})
            save_map(img, os.path.join(OUT, m["albedo"]), False, q, ao=ao, rough=rough)
            img = bpy.data.images.new(m["sun"], m["sl"], m["sl"], alpha=False, float_buffer=True)
            bake(sc, m["p"], img, s_day, 2, {"DIRECT", "INDIRECT"})
            save_map(img, os.path.join(OUT, m["sun"]), True, q)
        # the lamps, a black world (the page masks them room by room): the ceiling lights, then the placed ones
        world_flat(sc, (0, 0, 0), 0)
        sun.hide_render = True
        for key, obs in (("lamp", ceiling), ("place", placed)):
            if key == "place" and not obs:
                continue
            set_visible(obs, True)
            for m in maps:
                img = bpy.data.images.new(m[key], m["sl"], m["sl"], alpha=False, float_buffer=True)
                bake(sc, m["p"], img, s_lamp, 2, {"DIRECT", "INDIRECT"})
                save_map(img, os.path.join(OUT, m[key]), True, q)
            set_visible(obs, False)
        # the GLB: geometry and lightmap UVs only for the baked parts (named baked<i>, the page puts the maps on),
        # glass with a plain see-through material, leaves with their own textures
        for i, m in enumerate(maps):
            pm = m["p"].data
            keep_uv(pm, "lightmap")
            mat = bpy.data.materials.new(f"baked{i}")
            pm.materials.clear()
            pm.materials.append(mat)
            for qq in pm.polygons:
                qq.material_index = 0
        for e in extra:
            if e.name.endswith("_glass"):
                gm = principled(f"{fid}_glass", (0.8, 0.88, 0.92), rough=0.05)
                gm.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.25
                keep_uv(e.data, "")
                e.data.materials.clear()
                e.data.materials.append(gm)
                for qq in e.data.polygons:
                    qq.material_index = 0
            else:
                keep_uv(e.data, "UVMap")
        # the leaves: one object per door, its origin on the hinge pivot, named door_<n> for the page
        leaf_objs, door_meta = [], {}
        if door_part:
            dm = door_part.data
            ids = [dm.attributes["door_id"].data[qq.index].value for qq in dm.polygons]
            mat0 = dm.materials[0]
            for n, name in enumerate(door_names):
                sub = subset(dm, [i for i, v in enumerate(ids) if v == n], f"door_{DOOR_LABEL(name)}", coll)
                meta = DOORS[name]
                sub.data.transform(Matrix.Translation((-meta["x"], -meta["y"], 0)))
                sub.location = (meta["x"], meta["y"], 0)
                sub.data.materials.clear()
                sub.data.materials.append(mat0)
                if "door_id" in sub.data.attributes:
                    sub.data.attributes.remove(sub.data.attributes["door_id"])
                leaf_objs.append(sub)
                door_meta[sub.name] = {k_: meta[k_] for k_ in ("angle", "open", "hinge", "into")}
        up_objs, up_meta = [], {}
        if up_part:
            um = up_part.data
            ids = [um.attributes["up_id"].data[qq.index].value for qq in um.polygons]
            mat0 = um.materials[0]
            for n, key in enumerate(up_keys):
                sub = subset(um, [i for i, v in enumerate(ids) if v == n], f"wup_{key}", coll)
                sub.data.materials.clear()
                sub.data.materials.append(mat0)
                if "up_id" in sub.data.attributes:
                    sub.data.attributes.remove(sub.data.attributes["up_id"])
                up_objs.append(sub)
                up_meta[sub.name] = {"cut": base + NEAR_CUT}
        export = [m["p"] for m in maps if m["p"] is not door_part and m["p"] is not up_part] + extra + leaf_objs + up_objs
        path = os.path.join(OUT, f"{fid}.glb")
        select_only(export)
        opts = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_texcoords=True,
                    export_normals=False, export_tangents=False, export_materials="EXPORT", export_image_format="WEBP",
                    export_image_quality=q, export_cameras=False, export_lights=False, export_animations=False,
                    export_yup=True, export_extras=False, export_draco_mesh_compression_enable=False)
        try:
            bpy.ops.export_scene.gltf(**opts, export_meshopt_compression_enable=True)
        except Exception as e:
            log("meshopt export failed, exporting uncompressed:", str(e).splitlines()[-1][:200])
            bpy.ops.export_scene.gltf(**opts)
        size = os.path.getsize(path) + sum(os.path.getsize(os.path.join(OUT, m[k])) for m in maps for k in ("albedo", "sun", "lamp", "place") if k in m)
        tris = sum(len(qq.vertices) - 2 for p in export for qq in p.data.polygons)
        out["floors"][fid] = {"file": f"{fid}.glb", "base": base, "bytes": size, "tris": tris,
                              "maps": [{k: m[k] for k in ("albedo", "sun", "lamp", "place") if k in m} for m in maps], "doors": door_meta, "ups": up_meta,
                              "placed": [key[6:] for key, (lf, _) in passes.items() if lf["id"] == fid and key.startswith("light:")]}
        log("glb", fid, f"{size / 1e6:.1f} MB with maps,", tris, "tris,", f"{time.time() - t0:.0f}s")
        for o in list(coll.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(coll)
        json.dump(out, open(os.path.join(OUT, "glb.json"), "w"), indent=1)
    log("done", len(out["floors"]), "glb floors")


def render_mask(sc, f, room_obs, fid):
    """Flat colours per room floor, nothing else: the page reads the colour under a tap."""
    keep = {o.name: (o.hide_render, list(o.material_slots)) for o in bpy.data.objects}
    hidden = []
    for o in sc.objects:
        if o.type in ("MESH", "LIGHT") and not o.hide_render and o not in room_obs.values():
            o.hide_render = True
            hidden.append(o)
    colours = {}
    saved = {}
    for i, (rid, ob) in enumerate(room_obs.items()):
        r, g, b = ((i + 1) * 47) % 256, ((i + 1) * 97 + 40) % 256, ((i + 1) * 151 + 80) % 256
        colours[rid] = {"colour": "#%02x%02x%02x" % (r, g, b)}
        m = bpy.data.materials.new("mask_" + rid)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b), 1)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        saved[rid] = [s.material for s in ob.material_slots]
        for s in ob.material_slots:
            s.material = m
    vt, look, exp = sc.view_settings.view_transform, sc.view_settings.look, sc.view_settings.exposure
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0
    filt = sc.cycles.filter_width
    sc.cycles.filter_width = 0.01
    den = sc.cycles.use_denoising
    sc.cycles.use_denoising = False
    world_flat(sc, (0, 0, 0), 0)
    sc.cycles.samples = 1
    path = os.path.join(OUT, f"{fid}-mask.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.view_settings.view_transform, sc.view_settings.look, sc.view_settings.exposure = vt, look, exp
    sc.cycles.filter_width = filt
    sc.cycles.use_denoising = den
    for rid, ob in room_obs.items():
        for s, m in zip(ob.material_slots, saved[rid]):
            s.material = m
    for o in hidden:
        o.hide_render = False
    log("mask", fid)
    return f"{fid}-mask.png", colours


def srgb_to_lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


if __name__ == "__main__":
    main()
