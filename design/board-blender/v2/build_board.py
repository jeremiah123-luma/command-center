# Split-flap board hardware, built and rendered in Blender (Cycles).
# Run:  Blender -b -P build_board.py [-- frame rod clamp bar]   (no args = everything)
# Raw supersampled renders go to ./raw, then compose_preview.py downsamples
# and assembles the final PNGs.
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
OUT = "/Users/jeremiahsleman/dev/cc-app/design/board-blender"
V2 = OUT + "/v2"
RAW = V2 + "/raw"
PX = 0.01            # 1 image pixel (2x density) = 0.01 Blender unit
SAMPLES = int(os.environ.get("BOARD_SAMPLES", "384"))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ALL = {"frame", "rod", "clamp", "bar", "cable", "turn", "glass"}
WANT = set(argv) or ALL

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
          k_coarse=0.06, bump=0.12, aniso=0.0, contrast=0.22, tangent_uv=False, lowfreq=0.0):
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
    lf = None
    if lowfreq > 0:
        tc2 = N.new("ShaderNodeTexCoord")
        nz = N.new("ShaderNodeTexNoise"); nz.noise_dimensions = "3D"
        nz.inputs["Scale"].default_value = lowfreq; nz.inputs["Detail"].default_value = 2.0; nz.inputs["Roughness"].default_value = 0.5
        nt.links.new(tc2.outputs["Object"], nz.inputs["Vector"])
        lf = nz.outputs["Fac"]
        rr = N.new("ShaderNodeMath"); rr.operation = "MULTIPLY_ADD"
        nt.links.new(lf, rr.inputs[0]); rr.inputs[1].default_value = 0.16; rr.inputs[2].default_value = -0.08
        ra = N.new("ShaderNodeMath"); ra.operation = "ADD"
        nt.links.new(rc.outputs[0], ra.inputs[0]); nt.links.new(rr.outputs[0], ra.inputs[1])
        rc = ra
    nt.links.new(rc.outputs[0], b.inputs["Roughness"])
    # colour variation
    cm = N.new("ShaderNodeMath"); cm.operation = "MULTIPLY_ADD"
    nt.links.new(s, cm.inputs[0]); cm.inputs[1].default_value = 0.30; cm.inputs[2].default_value = 0.83
    mx = N.new("ShaderNodeMix"); mx.data_type = "RGBA"; mx.blend_type = "MULTIPLY"
    mx.inputs[0].default_value = 1.0
    mx.inputs[6].default_value = (*base, 1)
    if lf is not None:
        lm = N.new("ShaderNodeMath"); lm.operation = "MULTIPLY_ADD"
        nt.links.new(lf, lm.inputs[0]); lm.inputs[1].default_value = 0.34; lm.inputs[2].default_value = 0.83
        cm2 = N.new("ShaderNodeMath"); cm2.operation = "MULTIPLY"
        nt.links.new(cm.outputs[0], cm2.inputs[0]); nt.links.new(lm.outputs[0], cm2.inputs[1])
        nt.links.new(cm2.outputs[0], mx.inputs[7])
    else:
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

def rubber(name="gasket", color=(0.02, 0.02, 0.021), rough=0.55, textured=False):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; N = nt.nodes
    b = N["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0.0
    if textured:
        tc = N.new("ShaderNodeTexCoord")
        g = N.new("ShaderNodeTexNoise"); g.noise_dimensions = "3D"
        g.inputs["Scale"].default_value = 95; g.inputs["Detail"].default_value = 6; g.inputs["Roughness"].default_value = 0.65
        nt.links.new(tc.outputs["Object"], g.inputs["Vector"])
        vo = N.new("ShaderNodeTexVoronoi"); vo.voronoi_dimensions = "3D"; vo.feature = "F1"
        vo.inputs["Scale"].default_value = 48
        nt.links.new(tc.outputs["Object"], vo.inputs["Vector"])
        mh = N.new("ShaderNodeMath"); mh.operation = "MULTIPLY_ADD"   # grain*0.6 + pebble*0.5
        nt.links.new(g.outputs["Fac"], mh.inputs[0]); mh.inputs[1].default_value = 0.6
        mv = N.new("ShaderNodeMath"); mv.operation = "MULTIPLY_ADD"
        nt.links.new(vo.outputs["Distance"], mv.inputs[0]); mv.inputs[1].default_value = 0.5
        nt.links.new(mh.outputs[0], mv.inputs[2])
        bp = N.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.9; bp.inputs["Distance"].default_value = 0.012
        nt.links.new(mv.outputs[0], bp.inputs["Height"])
        nt.links.new(bp.outputs[0], b.inputs["Normal"])
        rm = N.new("ShaderNodeMath"); rm.operation = "MULTIPLY_ADD"
        nt.links.new(g.outputs["Fac"], rm.inputs[0]); rm.inputs[1].default_value = 0.45; rm.inputs[2].default_value = 0.42
        nt.links.new(rm.outputs[0], b.inputs["Roughness"])
        cc = N.new("ShaderNodeMath"); cc.operation = "MULTIPLY_ADD"
        nt.links.new(g.outputs["Fac"], cc.inputs[0]); cc.inputs[1].default_value = 0.05; cc.inputs[2].default_value = 0.012
        nt.links.new(cc.outputs[0], b.inputs["Base Color"])
    return m

def plain_metal(name, color=(0.9, 0.91, 0.93), rough=0.14):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 1.0
    return m

def loft(name, strips, mat, uv_scale=None, v_of=None, smooth=True):
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
                f.smooth = smooth
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

def screw(sc, name, loc, R, slot_deg, mat, axis="z", head_h=None, slot_w=None, cup_mat=None):
    """Domed (cheese-head) slotted screw sitting in a stepped washer cup."""
    h = head_h or R * 0.42
    sw = slot_w or R * 0.2
    fl = 1.0                       # cup floor height
    Hz = h * 1.5
    a = R / 0.943
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=1.0)
    for v in bm.verts:
        v.co.x *= a * PX; v.co.y *= a * PX; v.co.z = (v.co.z * Hz + fl + h - Hz) * PX
    for f in bm.faces: f.smooth = True
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    o = add_obj(sc, name, me)
    cm = bpy.data.meshes.new(name + "_slot")
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(cm); bm.free()
    cutter = add_obj(sc, name + "_slot", cm)
    cutter.scale = (R * 2.6 * PX, sw * PX, h * 1.2 * PX)
    cutter.location = (0, 0, (fl + h + 0.05 * h) * PX)
    cutter.parent = o
    cutter.hide_render = True; cutter.hide_viewport = True
    bo = o.modifiers.new("slot", "BOOLEAN"); bo.operation = "DIFFERENCE"; bo.object = cutter; bo.solver = "EXACT"
    # washer cup: wall, rim, sloped seat, floor
    cup = cup_mat or mat
    pr = [[(1.45 * R, 0.0), (1.45 * R, 2.0)],
          [(1.45 * R, 2.0), (1.38 * R, 2.4), (1.26 * R, 2.4)],
          [(1.26 * R, 2.4), (1.04 * R, fl)],
          [(1.04 * R, fl), (0.35 * R, fl)]]
    strips = [[circle_ring(r * PX, z * PX, 64) for r, z in p] for p in pr]
    wm = loft(name + "_cup", strips, cup, smooth=True)
    wo = add_obj(sc, name + "_cup", wm)
    wo.parent = o
    if axis == "z":
        o.rotation_euler = (0, 0, math.radians(slot_deg))
    else:
        o.rotation_euler = (math.radians(90), math.radians(slot_deg), 0)
    o.location = (loc[0] * PX, loc[1] * PX, loc[2] * PX)
    return o

def render(sc, name):
    sc.render.filepath = f"{RAW}/{name}.png"
    bpy.ops.render.render(write_still=True, scene=sc.name)
    print("RENDERED", name)

# materials shared
def mats():
    return dict(
        face=steel("brushed_face", (0.58, 0.59, 0.61), 0.34, "uv_v", aniso=0.8, tangent_uv=True, contrast=0.4, bump=0.35, k_fine=0.8, lowfreq=0.5),
        hw=steel("hardware", (0.34, 0.345, 0.36), 0.28, "obj_x", k_fine=0.9, bump=0.03, contrast=0.08),
        black=rubber(textured=True),
        edge=plain_metal("polished_edge"),
        cup=steel("cup", (0.66, 0.67, 0.69), 0.26, "obj_x", k_fine=0.9, bump=0.04, contrast=0.1),
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
    edge_prof = [(0.0, 5.0), (3.0, 7.6)]
    prof.append([(3.0, 7.6), (4.6, 8.4), (6.4, 8.85), (9, Z)])
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
    me = loft("edge", [ring_strip(edge_prof)], M["edge"], v_of=[[0, 1]])
    add_obj(sc, "edge", me)
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
        screw(sc, f"screw{k}", (sx * (cx + off), sy * (cy + off), Z), 14.0, ang, M["hw"], head_h=7.5, slot_w=3.4, cup_mat=M["cup"])
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
        s = screw(sc, f"cs{sx}", (sx, -7.3, 15.5), 7.4, 0, M["hw"], axis="ny", head_h=3.6, slot_w=1.8, cup_mat=M["cup"])
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
        s = screw(sc, f"bs{sx}", (sx * (400 - 26), -15.2, 0), 8.2, 0, M["hw"], axis="ny", head_h=4.2, slot_w=2.1, cup_mat=M["cup"])
        s.rotation_euler = (math.radians(90), math.radians(35 if sx > 0 else -20), 0)
    add_camera(sc, (0, -12, 0), (math.radians(90), 0, 0), W * PX, (W * SS, H * SS))
    add_light(sc, "key", (0, -7, 7), (0, 0, 0), (120, 6), 26000, (1, 0.985, 0.97), up="Y")
    add_light(sc, "fill", (0, -6, -5), (0, 0, 0), (120, 4), 3000, (1, 0.8, 0.58), up="Y")
    add_light(sc, "top", (0, -2, 6), (0, 0, 0), (120, 3), 5000, (0.95, 0.97, 1), up="Y")
    render(sc, "bar")


def tube(bm, pts, r, nseg=14):
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        ax = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))
        n1 = t.cross(ax).normalized(); n2 = t.cross(n1).normalized()
        rings.append([bm.verts.new(p + (n1 * math.cos(2 * math.pi * k / nseg) + n2 * math.sin(2 * math.pi * k / nseg)) * r) for k in range(nseg)])
    for i in range(len(rings) - 1):
        for k in range(nseg):
            f = bm.faces.new((rings[i][k], rings[i][(k + 1) % nseg], rings[i + 1][(k + 1) % nseg], rings[i + 1][k]))
            f.smooth = True

def rod_rig(sc):
    add_light(sc, "key", (-6, -8, 0), (0, 0, 0), (5, 200), 3000, (1, 0.985, 0.97), up="Y")
    add_light(sc, "fill", (6, -6, 0), (0, 0, 0), (4, 200), 700, (1, 0.8, 0.58), up="Y")
    add_light(sc, "top", (0, -3, 0), (0, 0, 0), (6, 200), 500, (0.95, 0.97, 1), up="Y")

def build_cable():
    SS = 4
    sc = new_scene("cable")
    wire = steel("wire", (0.74, 0.75, 0.77), 0.30, "obj_x", k_fine=1.2, k_coarse=0.2, bump=0.06, contrast=0.1)
    bm = bmesh.new()
    PITCH, RH, RS = 150.0, 6.6, 3.3
    zs = [z for z in range(-460, 461, 3)]
    tube(bm, [Vector((0, 0, z * PX)) for z in zs], 3.35 * PX)
    for k in range(6):
        ph = 2 * math.pi * k / 6
        pts = [Vector((RH * PX * math.cos(2 * math.pi * z / PITCH + ph), RH * PX * math.sin(2 * math.pi * z / PITCH + ph), z * PX)) for z in zs]
        tube(bm, pts, RS * PX)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("cable"); bm.to_mesh(me); bm.free(); me.materials.append(wire)
    add_obj(sc, "cable", me)
    add_camera(sc, (0, -12, 0), (math.radians(90), 0, 0), 6.0, (28 * SS, 600 * SS))
    rod_rig(sc)
    render(sc, "cable")

def lathe(sc, name, strips, mat, n=64, smooth=True):
    ss = [[circle_ring(r * PX, z * PX, n) for r, z in p] for p in strips]
    return add_obj(sc, name, loft(name, ss, mat, smooth=smooth))

def build_turnbuckle():
    SS = 4
    W, H = 44, 170
    sc = new_scene("turn")
    M = mats()
    body = steel("tb_body", (0.72, 0.73, 0.75), 0.24, "obj_x", k_fine=0.9, bump=0.06, contrast=0.12)
    nut = M["hw"]
    def half(sign):
        sg = lambda z: sign * z
        ferrule = [(9.6, 85), (10.8, 84), (11, 82), (11, 68), (9, 63)]
        thread = []
        z = 63.0
        while z < 48:
            pass
        thread = [(5.0, 63.0)]
        zz = 62.0
        while zz > 47:
            thread += [(4.2, zz - 0.0), (5.1, zz - 1.5)]
            zz -= 3.0
        thread.append((5.1, 47.5))
        hexnut = [(12.2, 48), (14.0, 46.6), (14.0, 39.4), (12.2, 38)]
        barrel = [(12.2, 38), (14.6, 36.4), (15.2, 33), (15.2, 9), (14.4, 8), (14.4, 4.5), (15.2, 3.5), (15.2, 0)]
        def mirror(p): return [(r, sg(z)) for r, z in p]
        order = (lambda p: p) if sign > 0 else (lambda p: list(reversed(p)))
        # profile must run bottom->top for outward normals
        def prep(p):
            q = mirror(p)
            if q[0][1] > q[-1][1]: q = list(reversed(q))
            return q
        lathe(sc, f"fer{sign}", [prep(ferrule)], body)
        lathe(sc, f"thr{sign}", [prep(thread)], body)
        lathe(sc, f"nut{sign}", [prep(hexnut)], nut, n=6, smooth=False)
        lathe(sc, f"bar{sign}", [prep(barrel)], body)
    half(1); half(-1)
    # taper from ferrule into thread stub (tiny shoulder)
    add_camera(sc, (0, -12, 0), (math.radians(90), 0, 0), H * PX, (W * SS, H * SS))
    rod_rig(sc)
    render(sc, "turnbuckle")

def build_glass():
    SS = 2
    W, H = 1200, 520
    sc = new_scene("glass", world_color=(0, 0, 0), world_strength=0.0)
    gm = bpy.data.materials.new("glass"); gm.use_nodes = True
    nt = gm.node_tree; N = nt.nodes; N.clear()
    out = N.new("ShaderNodeOutputMaterial")
    mix = N.new("ShaderNodeMixShader"); mix.inputs[0].default_value = 0.35
    tr = N.new("ShaderNodeBsdfTransparent")
    gl = N.new("ShaderNodeBsdfGlossy"); gl.inputs["Roughness"].default_value = 0.10
    nt.links.new(tr.outputs[0], mix.inputs[1]); nt.links.new(gl.outputs[0], mix.inputs[2]); nt.links.new(mix.outputs[0], out.inputs[0])
    pm = bpy.data.meshes.new("pane"); bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0); bm.to_mesh(pm); bm.free(); pm.materials.append(gm)
    p = add_obj(sc, "pane", pm); p.scale = (W / 2 * PX, H / 2 * PX, 1)
    # emissive panel overhead whose diagonal bands are what the glass reflects
    em = bpy.data.materials.new("bands"); em.use_nodes = True
    nt = em.node_tree; N = nt.nodes; N.clear()
    out = N.new("ShaderNodeOutputMaterial"); e = N.new("ShaderNodeEmission"); e.inputs["Strength"].default_value = 6.0
    tc = N.new("ShaderNodeTexCoord"); mp = N.new("ShaderNodeMapping"); mp.inputs["Rotation"].default_value = (0, 0, math.radians(-32))
    gr = N.new("ShaderNodeTexGradient"); sepx = N.new("ShaderNodeSeparateXYZ")
    cr = N.new("ShaderNodeValToRGB"); cr.color_ramp.interpolation = "B_SPLINE"
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"]); nt.links.new(mp.outputs[0], gr.inputs["Vector"])
    # stops over gradient 0..1 spanning x in [-9,9] BU -> scale in mapping
    mp.inputs["Scale"].default_value = (1 / 18.0, 1 / 18.0, 1)
    mp.inputs["Location"].default_value = (0.5, 0.5, 0)
    el = cr.color_ramp.elements
    el[0].position = 0.0; el[0].color = (0, 0, 0, 1)
    el[1].position = 1.0; el[1].color = (0, 0, 0, 1)
    for pos, val in ((0.40, 0.0), (0.46, 0.55), (0.52, 0.0), (0.60, 0.0), (0.625, 1.0), (0.65, 0.0), (0.675, 0.0), (0.683, 0.45), (0.69, 0.0)):
        ne = el.new(pos); ne.color = (val, val, val * 0.97, 1)
    nt.links.new(gr.outputs["Color"], cr.inputs["Fac"]); nt.links.new(cr.outputs["Color"], e.inputs["Color"]); nt.links.new(e.outputs[0], out.inputs[0])
    # top-edge sheen: a second strip near the top edge
    mm = bpy.data.meshes.new("panel_above"); bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=9.0); bm.to_mesh(mm); bm.free(); mm.materials.append(em)
    q = add_obj(sc, "bands", mm); q.location = (0, 0, 6); q.rotation_euler = (math.radians(180), 0, 0)
    q.visible_camera = False
    add_camera(sc, (0, 0, 12), (0, 0, 0), W * PX, (W * SS, H * SS))
    render(sc, "glass")

if __name__ == "__main__" or True:
    if "frame" in WANT: build_frame()
    if "cable" in WANT: build_cable()
    if "turn" in WANT: build_turnbuckle()
    if "glass" in WANT: build_glass()
    if "rod" in WANT: build_rod()
    if "clamp" in WANT: build_clamp()
    if "bar" in WANT: build_bar()
    if WANT >= ALL:
        # drop the empty default scene, keep the four piece scenes, save
        bpy.ops.wm.save_as_mainfile(filepath=V2 + "/board.blend")
