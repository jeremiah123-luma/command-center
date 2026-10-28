# Split-flap board hardware, built and rendered in Blender (Cycles).
# Run:  Blender -b -P build_board.py [-- frame rod clamp bar]   (no args = everything)
# Raw supersampled renders go to ./raw, then compose_preview.py downsamples
# and assembles the final PNGs.
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
OUT = "/Users/jeremiahsleman/dev/cc-app/design/board-blender"
RAW = OUT + "/raw"
PX = 0.01            # 1 image pixel (2x density) = 0.01 Blender unit
SAMPLES = int(os.environ.get("BOARD_SAMPLES", "384"))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
WANT = set(argv) or {"frame", "rod", "clamp", "bar"}

for d in list(bpy.data.scenes):
    pass

# ------------------------------------------------------------------ helpers
def new_scene(name, world_color=(0.10, 0.105, 0.115), world_strength=0.8):
    sc = bpy.data.scenes.new(name)
    sc.render.engine = "CYCLES"
    cy = sc.cycles
    cy.device = "CPU"
    cy.samples = SAMPLES
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.max_bounces = 8
    cy.glossy_bounces = 6
    cy.filter_width = 1.5
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "16"
    sc.render.dither_intensity = 0.0
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    w = bpy.data.worlds.new(name + "_world")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (*world_color, 1)
    bg.inputs[1].default_value = world_strength
    sc.world = w
    return sc

def add_obj(sc, name, mesh):
    o = bpy.data.objects.new(name, mesh)
    sc.collection.objects.link(o)
    return o

def add_light(sc, name, loc, target, size, power, color=(1, 1, 1), up="Y"):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "RECTANGLE"
    ld.size, ld.size_y = size
    ld.energy = power
    ld.color = color
    o = add_obj(sc, name, ld)
    o.location = loc
    d = Vector(target) - Vector(loc)
    o.rotation_euler = d.to_track_quat("-Z", up).to_euler()
    return o

def add_camera(sc, loc, rot, ortho, res):
    cd = bpy.data.cameras.new("cam")
    cd.type = "ORTHO"
    cd.ortho_scale = ortho
    cd.clip_start, cd.clip_end = 0.01, 200
    o = add_obj(sc, "cam", cd)
    o.location = loc
    o.rotation_euler = rot
    sc.camera = o
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    return o

def steel(name, base=(0.62, 0.63, 0.65), rough=0.30, mode="obj_x", k_fine=0.55,
          k_coarse=0.06, bump=0.12, aniso=0.0, contrast=0.22, tangent_uv=False):
    """Brushed steel. Streak pattern depends on ONE coordinate only so it is
    uniform along the brushing direction (mode: obj_x, obj_z, uv_v)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N = nt.nodes
    N.clear()
    out = N.new("ShaderNodeOutputMaterial")
    b = N.new("ShaderNodeBsdfPrincipled")
    tc = N.new("ShaderNodeTexCoord")
    sep = N.new("ShaderNodeSeparateXYZ")
    if mode == "uv_v":
        nt.links.new(tc.outputs["UV"], sep.inputs[0]); axis = "Y"; unit = 88.0
    elif mode == "obj_x":
        nt.links.new(tc.outputs["Object"], sep.inputs[0]); axis = "X"; unit = 100.0
    else:
        nt.links.new(tc.outputs["Object"], sep.inputs[0]); axis = "Z"; unit = 100.0

    def noise(k, detail, rough_):
        mul = N.new("ShaderNodeMath"); mul.operation = "MULTIPLY"
        nt.links.new(sep.outputs[axis], mul.inputs[0]); mul.inputs[1].default_value = unit * k
        comb = N.new("ShaderNodeCombineXYZ")
        nt.links.new(mul.outputs[0], comb.inputs["X"])
        comb.inputs["Y"].default_value = 3.7
        nz = N.new("ShaderNodeTexNoise"); nz.noise_dimensions = "3D"
        nz.inputs["Scale"].default_value = 1.0
        nz.inputs["Detail"].default_value = detail
        nz.inputs["Roughness"].default_value = rough_
        nt.links.new(comb.outputs[0], nz.inputs["Vector"])
        return nz.outputs["Fac"]

    f1 = noise(k_fine, 3.0, 0.65)
    f2 = noise(k_fine * 0.23, 2.0, 0.5)
    f3 = noise(k_coarse, 1.0, 0.5)
    def mix(a, wa, c, wc):
        ma = N.new("ShaderNodeMath"); ma.operation = "MULTIPLY"; nt.links.new(a, ma.inputs[0]); ma.inputs[1].default_value = wa
        mc = N.new("ShaderNodeMath"); mc.operation = "MULTIPLY_ADD"; nt.links.new(c, mc.inputs[0]); mc.inputs[1].default_value = wc
        nt.links.new(ma.outputs[0], mc.inputs[2])
        return mc.outputs[0]
    s = mix(f1, 0.5, f2, 0.3)
    s = mix(s, 1.0, f3, 0.35)      # approx 0..1 centred ~0.55
    # roughness variation
    r = N.new("ShaderNodeMath"); r.operation = "MULTIPLY_ADD"
    nt.links.new(s, r.inputs[0]); r.inputs[1].default_value = contrast; r.inputs[2].default_value = rough - contrast * 0.55
    rc = N.new("ShaderNodeClamp"); nt.links.new(r.outputs[0], rc.inputs[0]); rc.inputs[1].default_value = 0.12; rc.inputs[2].default_value = 0.6
    nt.links.new(rc.outputs[0], b.inputs["Roughness"])
    # colour variation
    cm = N.new("ShaderNodeMath"); cm.operation = "MULTIPLY_ADD"
    nt.links.new(s, cm.inputs[0]); cm.inputs[1].default_value = 0.30; cm.inputs[2].default_value = 0.83
    mx = N.new("ShaderNodeMix"); mx.data_type = "RGBA"; mx.blend_type = "MULTIPLY"
    mx.inputs[0].default_value = 1.0
    mx.inputs[6].default_value = (*base, 1)
    nt.links.new(cm.outputs[0], mx.inputs[7])
    nt.links.new(mx.outputs[2], b.inputs["Base Color"])
    bp = N.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = bump; bp.inputs["Distance"].default_value = 0.01
    nt.links.new(s, bp.inputs["Height"])
    nt.links.new(bp.outputs[0], b.inputs["Normal"])
    b.inputs["Metallic"].default_value = 1.0
    if aniso > 0:
        b.inputs["Anisotropic"].default_value = aniso
        if tangent_uv:
            tg = N.new("ShaderNodeTangent"); tg.direction_type = "UV_MAP"; tg.uv_map = "UVMap"
            nt.links.new(tg.outputs[0], b.inputs["Tangent"])
    nt.links.new(b.outputs[0], out.inputs[0])
    return m

def rubber(name="gasket", color=(0.015, 0.015, 0.016), rough=0.55):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0.0
    return m

def loft(name, strips, mat, uv_scale=None, v_of=None):
    """strips: list of strips; strip = list of rings; ring = list of Vector.
    Closed loop in each ring, quads between consecutive rings, smooth shaded.
    Vertices are not shared between strips so hard edges stay crisp."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    for si, strip in enumerate(strips):
        vs = [[bm.verts.new(p) for p in ring] for ring in strip]
        M = len(strip[0])
        for i in range(len(strip) - 1):
            for j in range(M):
                j2 = (j + 1) % M
                f = bm.faces.new((vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]))
                f.smooth = True
                for loop, (ii, jj, jr) in zip(f.loops, ((i, j, j), (i, j2, j + 1), (i + 1, j2, j + 1), (i + 1, j, j))):
                    v = v_of[si][ii] if v_of else ii
                    loop[uvl].uv = (jr / M * 40.0, v)
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    return me

def circle_ring(r, z, n=64, cx=0.0, cy=0.0):
    return [Vector((cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n), z)) for i in range(n)]

def rr_pts(hw, hh, r, K=20):
    """rounded-rect outline, CCW, K+1 points per corner"""
    r = max(0.001, min(r, hw, hh))
    pts = []
    for (sx, sy, a0) in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        cx, cy = sx * (hw - r), sy * (hh - r)
        for k in range(K + 1):
            a = math.radians(a0 + 90 * k / K)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def prism_rr(name, w, h, depth, r, mat, bevel=2.0, y0=0.0):
    """rounded rect (x,z plane, in px) extruded toward -y, then bevel modifier."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    pts = rr_pts(w / 2, h / 2, r, 10)
    ring0 = [bm.verts.new((x * PX, y0 * PX, z * PX)) for x, z in pts]
    f = bm.faces.new(ring0)
    res = bmesh.ops.extrude_face_region(bm, geom=[f])
    vv = [e for e in res["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=vv, vec=(0, -depth * PX, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for fc in bm.faces: fc.smooth = True
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    return me

def add_bevel(o, width_px, seg=3, angle=35):
    md = o.modifiers.new("bevel", "BEVEL")
    md.width = width_px * PX; md.segments = seg
    md.limit_method = "ANGLE"; md.angle_limit = math.radians(angle)
    md.harden_normals = True
    return md

def screw(sc, name, loc, R, slot_deg, mat, axis="z", head_h=None, slot_w=None):
    """pan-head slotted screw + washer. axis 'z' faces +Z (top view), 'ny' faces -Y (front view)."""
    h = head_h or R * 0.42
    sw = slot_w or R * 0.2
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=64, radius1=R * PX, radius2=R * PX, depth=h * PX)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, h * PX / 2))
    for f in bm.faces: f.smooth = True
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    o = add_obj(sc, name, me)
    md = add_bevel(o, h * 0.42, 4, 30)
    # slot cutter
    cm = bpy.data.meshes.new(name + "_slot")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(cm); bm.free()
    cutter = add_obj(sc, name + "_slot", cm)
    cutter.scale = (R * 2.4 * PX, sw * PX, h * 0.9 * PX)
    cutter.location = (0, 0, h * PX)
    cutter.parent = o
    cutter.hide_render = True; cutter.hide_viewport = True
    bo = o.modifiers.new("slot", "BOOLEAN"); bo.operation = "DIFFERENCE"; bo.object = cutter; bo.solver = "EXACT"
    # washer
    wm = bpy.data.meshes.new(name + "_washer")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=64, radius1=R * 1.32 * PX, radius2=R * 1.32 * PX, depth=1.6 * PX)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.8 * PX))
    for f in bm.faces: f.smooth = True
    bm.to_mesh(wm); bm.free()
    wm.materials.append(mat)
    wo = add_obj(sc, name + "_washer", wm)
    add_bevel(wo, 0.5, 2, 30)
    wo.parent = o
    if axis == "z":
        o.rotation_euler = (0, 0, math.radians(slot_deg))
        o.location = (loc[0] * PX, loc[1] * PX, loc[2] * PX)
    else:   # faces -Y
        o.rotation_euler = (math.radians(90), 0, 0)
        o.rotation_euler = (math.radians(90), math.radians(slot_deg), 0)
        o.location = (loc[0] * PX, loc[1] * PX, loc[2] * PX)
    # parent keeps child transforms relative; washer and cutter inherit
    return o

def render(sc, name):
    sc.render.filepath = f"{RAW}/{name}.png"
    bpy.ops.render.render(write_still=True, scene=sc.name)
    print("RENDERED", name)

# materials shared
def mats():
    return dict(
        face=steel("brushed_face", (0.58, 0.59, 0.61), 0.34, "uv_v", aniso=0.8, tangent_uv=True, contrast=0.4, bump=0.35, k_fine=0.8),
        hw=steel("hardware", (0.34, 0.345, 0.36), 0.28, "obj_x", k_fine=0.9, bump=0.03, contrast=0.08),
        black=rubber(),
    )

# ------------------------------------------------------------------ FRAME
def build_frame():
    SS = 2
    W, H = 1200, 520
    sc = new_scene("frame")
    M = mats()
    R_OUT, R_IN, T = 72.0, 16.0, 88.0
    def contour(d, z):
        r = R_IN + (R_OUT - R_IN) * (1 - d / T)
        return [Vector((x * PX, y * PX, z * PX)) for x, y in rr_pts(W / 2 - d, H / 2 - d, r, 28)]
    def ring_strip(prof):
        return [contour(d, z) for d, z in prof]
    def arc(cx, cz, r, a0, a1, n=8):
        return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]
    Z = 9.0
    prof = []
    # outer fillet: starts vertical at d=0
    prof.append([(9 - 9 * math.cos(math.radians(a)), 9 * math.sin(math.radians(a))) for a in range(0, 91, 10)])
    prof.append([(9, Z), (52, Z)])
    prof.append([(52, Z), (53.5, Z - 1.1), (55.5, Z - 1.6), (57.5, Z - 1.1), (59, Z)])    # engraved pinstripe
    prof.append([(59, Z), (63, Z)])
    prof.append([(63 + 3.5 * math.sin(math.radians(a)), Z - 3.5 + 3.5 * math.cos(math.radians(a))) for a in range(0, 61, 15)])
    prof.append([(63 + 3.5 * math.sin(math.radians(60)), Z - 3.5 + 3.5 * math.cos(math.radians(60))), (78.5, 3.4)])
    prof.append([(78.5, 3.4), (79.2, 3.0), (79.6, 2.0), (79.6, -2.0)])
    strips = [ring_strip(p) for p in prof]
    vof = [[d / T for d, z in p] for p in prof]
    me = loft("frame", strips, M["face"], v_of=vof)
    add_obj(sc, "frame", me)
    # gasket: rubber dome between metal and opening
    gp = []
    gd0, gd1, gh = 78.0, 88.0, 5.2
    for i in range(0, 25):
        a = math.pi - math.pi * i / 24
        gp.append((gd0 + (gd1 - gd0) / 2 * (1 + math.cos(a + math.pi) * -1) if False else (gd0 + gd1) / 2 + (gd1 - gd0) / 2 * math.cos(a), gh * math.sin(a) - 1.0))
    gstrip = ring_strip(gp)
    me = loft("gasket", [gstrip], M["black"], v_of=[[0] * len(gp)])
    add_obj(sc, "gasket", me)
    # screws: on corner diagonal, centred in the band
    dS = 42.0
    r = R_IN + (R_OUT - R_IN) * (1 - dS / T)
    hw, hh = W / 2 - dS, H / 2 - dS
    cx, cy = hw - r, hh - r
    off = r * math.cos(math.radians(45))
    for k, (sx, sy, ang) in enumerate(((1, 1, 24), (-1, 1, -63), (-1, -1, 71), (1, -1, -12))):
        screw(sc, f"screw{k}", (sx * (cx + off), sy * (cy + off), Z), 16.0, ang, M["hw"], head_h=7.0, slot_w=3.6)
    # shadow catcher plane = the live panel level
    pm = bpy.data.meshes.new("panel")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    bm.to_mesh(pm); bm.free()
    p = add_obj(sc, "panel", pm)
    p.scale = (W / 2 * PX, H / 2 * PX, 1); p.location = (0, 0, -9 * PX)
    p.is_shadow_catcher = True
    add_camera(sc, (0, 0, 12), (0, 0, 0), W * PX, (W * SS, H * SS))
    add_light(sc, "key", (-7, 4.5, 12), (0, 0, 0), (16, 9), 1000, (1.0, 0.985, 0.97))
    add_light(sc, "fill", (7.5, -5, 8), (0, 0, 0), (14, 9), 140, (1.0, 0.80, 0.58))
    add_light(sc, "rim", (0, 9, 6), (0, 0, 0), (20, 2), 120, (0.92, 0.95, 1.0))
    render(sc, "frame")

# ------------------------------------------------------------------ ROD
def build_rod():
    SS = 4
    sc = new_scene("rod")
    M = mats()
    rod_mat = steel("rod_steel", (0.74, 0.75, 0.77), 0.24, "obj_x", k_fine=0.9, k_coarse=0.12, bump=0.08, contrast=0.12)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=96, radius1=14 * PX, radius2=14 * PX, depth=60.0)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("rod"); bm.to_mesh(me); bm.free(); me.materials.append(rod_mat)
    add_obj(sc, "rod", me)
    add_camera(sc, (0, -12, 0), (math.radians(90), 0, 0), 6.0, (28 * SS, 600 * SS))
    add_light(sc, "key", (-6, -8, 0), (0, 0, 0), (5, 200), 3000, (1, 0.985, 0.97), up="Y")
    add_light(sc, "fill", (6, -6, 0), (0, 0, 0), (4, 200), 700, (1, 0.8, 0.58), up="Y")
    add_light(sc, "top", (0, -3, 0), (0, 0, 0), (6, 200), 500, (0.95, 0.97, 1), up="Y")
    render(sc, "rod")

# ------------------------------------------------------------------ CLAMP
def build_clamp():
    SS = 4
    W, H = 90, 70
    sc = new_scene("clamp")
    M = mats()
    plate_m = steel("plate", (0.66, 0.67, 0.69), 0.30, "obj_x", k_fine=0.55, bump=0.1)
    rod_mat = steel("rod_steel", (0.74, 0.75, 0.77), 0.24, "obj_x", k_fine=0.9, k_coarse=0.12, bump=0.08, contrast=0.12)
    # plate
    me = prism_rr("plate", 90, 31, 7, 8, plate_m)
    o = add_obj(sc, "plate", me); o.location = (0, 0, 15.5 * PX); add_bevel(o, 2.2, 4)
    # neck gusset (tapered block) between plate and collar
    me = prism_rr("neck", 52, 14, 11, 4, plate_m)
    o = add_obj(sc, "neck", me); o.location = (0, -7 * PX, 34 * PX); add_bevel(o, 1.6, 3)
    # collar around the rod
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=72, radius1=19 * PX, radius2=19 * PX, depth=26 * PX)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("collar"); bm.to_mesh(me); bm.free(); me.materials.append(plate_m)
    o = add_obj(sc, "collar", me); o.location = (0, -12 * PX, 44 * PX); add_bevel(o, 2.4, 4)
    # split line ring on collar
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=72, radius1=19.4 * PX, radius2=19.4 * PX, depth=1.4 * PX)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("band"); bm.to_mesh(me); bm.free(); me.materials.append(M["black"])
    o = add_obj(sc, "band", me); o.location = (0, -12 * PX, 44 * PX)
    # rod stub
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=72, radius1=14 * PX, radius2=14 * PX, depth=60 * PX)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("stub"); bm.to_mesh(me); bm.free(); me.materials.append(rod_mat)
    o = add_obj(sc, "stub", me); o.location = (0, -12 * PX, 70 * PX)
    # screws (face -Y)
    for sx, ang in ((-30, 30), (30, -50)):
        s = screw(sc, f"cs{sx}", (sx, -7.3, 15.5), 8.5, 0, M["hw"], axis="ny", head_h=4.0, slot_w=2.0)
        s.rotation_euler = (math.radians(90), math.radians(ang), 0)
    add_camera(sc, (0, -12, 35 * PX), (math.radians(90), 0, 0), W * PX, (W * SS, H * SS))
    sc.camera.location = (0, -12, 35 * PX)
    add_light(sc, "key", (-1.6, -2.2, 1.8), (0, 0, 0.3), (2.2, 2.2), 190, (1, 0.985, 0.97))
    add_light(sc, "fill", (1.8, -1.6, 0.4), (0, 0, 0.3), (2.0, 1.6), 30, (1, 0.8, 0.58))
    add_light(sc, "top", (0, -0.8, 2.2), (0, 0, 0.3), (2.4, 1.2), 50, (0.95, 0.97, 1))
    render(sc, "clamp")

# ------------------------------------------------------------------ CEILING BAR
def build_bar():
    SS = 4
    W, H = 800, 40
    sc = new_scene("bar")
    M = mats()
    bar_m = steel("bar", (0.66, 0.67, 0.69), 0.30, "obj_z", k_fine=0.55, bump=0.1)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("body"); bm.to_mesh(me); bm.free(); me.materials.append(bar_m)
    o = add_obj(sc, "body", me)
    o.scale = (740 * PX, 14 * PX, 28 * PX); o.location = (0, -5 * PX, 0)
    # bevel sized in object space compensating scale: apply scale via data
    for v in me.vertices:
        v.co.x *= o.scale.x; v.co.y *= o.scale.y; v.co.z *= o.scale.z
    o.scale = (1, 1, 1)
    add_bevel(o, 3.0, 4)
    for sx in (-1, 1):
        cap = prism_rr(f"cap{sx}", 52, 40, 22, 17, bar_m, y0=7)
        c = add_obj(sc, f"cap{sx}", cap); c.location = (sx * (400 - 26) * PX, 0, 0); add_bevel(c, 3.5, 5)
        s = screw(sc, f"bs{sx}", (sx * (400 - 26), -15.2, 0), 9.5, 0, M["hw"], axis="ny", head_h=4.5, slot_w=2.3)
        s.rotation_euler = (math.radians(90), math.radians(35 if sx > 0 else -20), 0)
    add_camera(sc, (0, -12, 0), (math.radians(90), 0, 0), W * PX, (W * SS, H * SS))
    add_light(sc, "key", (0, -6, 6), (0, 0, 0), (400, 3.5), 420000, (1, 0.985, 0.97), up="Y") if False else None
    add_light(sc, "key", (-60 * 0, -7, 7), (0, 0, 0), (120, 6), 26000, (1, 0.985, 0.97), up="Y")
    add_light(sc, "fill", (0, -6, -5), (0, 0, 0), (120, 4), 3000, (1, 0.8, 0.58), up="Y")
    add_light(sc, "top", (0, -2, 6), (0, 0, 0), (120, 3), 5000, (0.95, 0.97, 1), up="Y")
    render(sc, "bar")

if __name__ == "__main__" or True:
    if "frame" in WANT: build_frame()
    if "rod" in WANT: build_rod()
    if "clamp" in WANT: build_clamp()
    if "bar" in WANT: build_bar()
    if WANT >= {"frame", "rod", "clamp", "bar"}:
        # drop the empty default scene, keep the four piece scenes, save
        bpy.ops.wm.save_as_mainfile(filepath=OUT + "/board.blend")
