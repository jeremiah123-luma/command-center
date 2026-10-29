# v3: the whole hanging board as ONE model in ONE scene: frame, screws, gasket, both clamps, cables and
# turnbuckles, under one camera and one light rig. The web needs the frame to stretch (9-slice) and the cables to
# run any length, so the passes below render that same scene with parts hidden and compose.py slices them.
# Run:  Blender -b -P build_board.py [-- frame hanger assembly]   (no args = all three)
# Helpers (materials, lofts, screws) are copied verbatim from ../v2/build_board.py.
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


def lathe(sc, name, strips, mat, n=64, smooth=True):
    ss = [[circle_ring(r * PX, z * PX, n) for r, z in p] for p in strips]
    return add_obj(sc, name, loft(name, ss, mat, smooth=smooth))


# ================================================================== v3 settings
V3 = OUT + "/v3"
RAW3 = V3 + "/raw"
os.makedirs(RAW3, exist_ok=True)
PASSES = [a for a in argv if a in ("frame", "hanger", "assembly")] or ["frame", "hanger", "assembly"]
K_KEY = float(os.environ.get("K_KEY", "3100"))   # matched to v2's frame brightness
K_FILL = float(os.environ.get("K_FILL", "550"))
K_TOP = float(os.environ.get("K_TOP", "120"))
W, H = 1200, 520                  # frame, image px at 2x density
XA = (W / 2 - 0.27 * W) * PX      # cable axis: 27% in from each side (the web places them there)
Z0 = (H / 2 - 10) * PX            # clamp plate bottom: 10 px below the frame's top edge
TB = 300                          # turnbuckle centre, px above Z0
HANG = 600                        # hanger crop height (px); the cable tile is the next 600 px up
CY = -12                          # cable axis y (px): in front of the frame face, through the clamp collar

sc = new_scene("board")
try:
    pr = bpy.context.preferences.addons["cycles"].preferences
    pr.compute_device_type = "METAL"; pr.get_devices()
    for d in pr.devices: d.use = True
    sc.cycles.device = "GPU"
except Exception as e:
    print("GPU unavailable, CPU render:", e)
M = mats()

def coll(name):
    c = bpy.data.collections.new(name); sc.collection.children.link(c); return c
C_FRAME, C_HANG, C_SCREEN = coll("frame"), coll("hangers"), coll("screen")
def gather(c):
    """move everything built so far that still sits in the scene root into collection c"""
    for o in list(sc.collection.objects):
        sc.collection.objects.unlink(o); c.objects.link(o)

# ------------------------------------------------------------------ FRAME (built flat as in v2, then stood up)
def build_frame():
    R_OUT, R_IN, T = 72.0, 16.0, 88.0
    def contour(d, z):
        r = R_IN + (R_OUT - R_IN) * (1 - d / T)
        return [Vector((x * PX, y * PX, z * PX)) for x, y in rr_pts(W / 2 - d, H / 2 - d, r, 28)]
    def ring_strip(prof):
        return [contour(d, z) for d, z in prof]
    Z = 9.0
    prof = []
    edge_prof = [(0.0, 5.0), (3.0, 7.6)]
    prof.append([(3.0, 7.6), (4.6, 8.4), (6.4, 8.85), (9, Z)])
    prof.append([(9, Z), (52, Z)])
    prof.append([(52, Z), (53.5, Z - 1.1), (55.5, Z - 1.6), (57.5, Z - 1.1), (59, Z)])
    prof.append([(59, Z), (63, Z)])
    prof.append([(63 + 3.5 * math.sin(math.radians(a)), Z - 3.5 + 3.5 * math.cos(math.radians(a))) for a in range(0, 61, 15)])
    prof.append([(63 + 3.5 * math.sin(math.radians(60)), Z - 3.5 + 3.5 * math.cos(math.radians(60))), (78.5, 3.4)])
    prof.append([(78.5, 3.4), (79.2, 3.0), (79.6, 2.0), (79.6, -2.0)])
    strips = [ring_strip(p) for p in prof]
    vof = [[d / T for d, z in p] for p in prof]
    add_obj(sc, "frame", loft("frame", strips, M["face"], v_of=vof))
    add_obj(sc, "edge", loft("edge", [ring_strip(edge_prof)], M["edge"], v_of=[[0, 1]]))
    gp = []
    gd0, gd1, gh = 78.0, 88.0, 5.2
    for i in range(0, 25):
        a = math.pi - math.pi * i / 24
        gp.append(((gd0 + gd1) / 2 + (gd1 - gd0) / 2 * math.cos(a), gh * math.sin(a) - 1.0))
    add_obj(sc, "gasket", loft("gasket", [ring_strip(gp)], M["black"], v_of=[[0] * len(gp)]))
    dS = 42.0
    r = R_IN + (R_OUT - R_IN) * (1 - dS / T)
    hw, hh = W / 2 - dS, H / 2 - dS
    cx, cy = hw - r, hh - r
    off = r * math.cos(math.radians(45))
    for k, (sx, sy, ang) in enumerate(((1, 1, 24), (-1, 1, -63), (-1, -1, 71), (1, -1, -12))):
        screw(sc, f"screw{k}", (sx * (cx + off), sy * (cy + off), Z), 14.0, ang, M["hw"], head_h=7.5, slot_w=3.4, cup_mat=M["cup"])
    pm = bpy.data.meshes.new("panel"); bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0); bm.to_mesh(pm); bm.free()
    p = add_obj(sc, "panel", pm); p.scale = (W / 2 * PX, H / 2 * PX, 1); p.location = (0, 0, -9 * PX)
    p.is_shadow_catcher = True
    # stand it up: local +Z (the face) -> world -Y (toward the camera), local +Y (top edge) -> world +Z
    root = bpy.data.objects.new("frame_root", None); sc.collection.objects.link(root)
    root.rotation_euler = (math.radians(90), 0, 0)
    for o in list(sc.collection.objects):
        if o is not root and o.parent is None: o.parent = root
    gather(C_FRAME)

# ------------------------------------------------------------------ HANGERS: clamp + swaged sleeve + cable + turnbuckle + cable
def cable_mesh(name, z_a, z_b, mat):
    bm = bmesh.new()
    PITCH, RH, RS = 150.0, 6.6, 3.3                   # same rope as v2: 6 strands round a core, 150 px lay
    zs = [z_a + i * 3.0 for i in range(int((z_b - z_a) / 3.0) + 1)]
    tube(bm, [Vector((0, 0, z * PX)) for z in zs], 3.35 * PX)
    for k in range(6):
        ph = 2 * math.pi * k / 6                       # phase from absolute z, so every segment is the same rope
        tube(bm, [Vector((RH * PX * math.cos(2 * math.pi * z / PITCH + ph), RH * PX * math.sin(2 * math.pi * z / PITCH + ph), z * PX)) for z in zs], RS * PX)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(mat)
    return me

def build_hanger(xa, tag):
    plate_m = steel("plate", (0.66, 0.67, 0.69), 0.30, "obj_x", k_fine=0.55, bump=0.1)
    wire = steel("wire", (0.74, 0.75, 0.77), 0.30, "obj_x", k_fine=1.2, k_coarse=0.2, bump=0.06, contrast=0.1)
    body = steel("tb_body", (0.72, 0.73, 0.75), 0.24, "obj_x", k_fine=0.9, bump=0.06, contrast=0.12)
    def at(o, x, y, z): o.location = (xa + x * PX, y * PX, Z0 + z * PX); return o
    # clamp (v2 geometry): plate, gusset, collar with a split ring, two screws
    o = at(add_obj(sc, f"plate{tag}", prism_rr("plate", 90, 31, 7, 8, plate_m)), 0, 0, 15.5); add_bevel(o, 2.2, 4)
    o = at(add_obj(sc, f"neck{tag}", prism_rr("neck", 52, 14, 11, 4, plate_m)), 0, -7, 34); add_bevel(o, 1.6, 3)
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=72, radius1=19 * PX, radius2=19 * PX, depth=26 * PX)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("collar"); bm.to_mesh(me); bm.free(); me.materials.append(plate_m)
    o = at(add_obj(sc, f"collar{tag}", me), 0, CY, 44); add_bevel(o, 2.4, 4)
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=72, radius1=19.4 * PX, radius2=19.4 * PX, depth=1.4 * PX)
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new("band"); bm.to_mesh(me); bm.free(); me.materials.append(M["black"])
    at(add_obj(sc, f"band{tag}", me), 0, CY, 44)
    for sx, ang in ((-30, 30), (30, -50)):
        s = screw(sc, f"cs{tag}{sx}", (0, 0, 0), 7.4, 0, M["hw"], axis="ny", head_h=3.6, slot_w=1.8, cup_mat=M["cup"])
        s.rotation_euler = (math.radians(90), math.radians(ang), 0)
        at(s, sx, -7.3, 15.5)
    # swaged sleeve where the rope leaves the collar
    o = lathe(sc, f"sleeve{tag}", [[(13.0, 56.0), (13.0, 60.0), (12.2, 63.0), (11.2, 74.0), (10.4, 78.0)]], body)
    at(o, 0, CY, 0)
    # rope: collar -> lower ferrule, upper ferrule -> well past the top of the crop
    at(add_obj(sc, f"rope_lo{tag}", cable_mesh("rope_lo", 60.0, TB - 80.0, wire)), 0, CY, 0)
    at(add_obj(sc, f"rope_hi{tag}", cable_mesh("rope_hi", TB + 80.0, 2 * HANG + 90.0, wire)), 0, CY, 0)
    # turnbuckle (v2 profile)
    nut = M["hw"]
    parts = []
    for sign in (1, -1):
        sg = lambda z, s=sign: s * z
        ferrule = [(9.6, 85), (10.8, 84), (11, 82), (11, 68), (9, 63)]
        thread = [(5.0, 63.0)]
        zz = 62.0
        while zz > 47:
            thread += [(4.2, zz), (5.1, zz - 1.5)]; zz -= 3.0
        thread.append((5.1, 47.5))
        hexnut = [(12.2, 48), (14.0, 46.6), (14.0, 39.4), (12.2, 38)]
        barrel = [(12.2, 38), (14.6, 36.4), (15.2, 33), (15.2, 9), (14.4, 8), (14.4, 4.5), (15.2, 3.5), (15.2, 0)]
        def prep(p):
            q = [(r, sg(z)) for r, z in p]
            return q if q[0][1] <= q[-1][1] else list(reversed(q))
        parts += [lathe(sc, f"fer{tag}{sign}", [prep(ferrule)], body), lathe(sc, f"thr{tag}{sign}", [prep(thread)], body),
                  lathe(sc, f"nut{tag}{sign}", [prep(hexnut)], nut, n=6, smooth=False), lathe(sc, f"bar{tag}{sign}", [prep(barrel)], body)]
    for o in parts: at(o, 0, CY, TB)

# a dark screen in the opening, only for the assembly preview
def build_screen():
    sm = bpy.data.materials.new("screen"); sm.use_nodes = True
    b = sm.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value = (0.012, 0.012, 0.013, 1); b.inputs["Roughness"].default_value = 0.35
    pm = bpy.data.meshes.new("screen"); bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0); bm.to_mesh(pm); bm.free(); pm.materials.append(sm)
    p = add_obj(sc, "screen", pm); p.scale = ((W / 2 - 80) * PX, (H / 2 - 80) * PX, 1)
    p.rotation_euler = (math.radians(90), 0, 0); p.location = (0, 0.03, 0)
    gather(C_SCREEN)

build_frame()
build_hanger(-XA, "L"); build_hanger(XA, "R"); gather(C_HANG)
build_screen()

# ------------------------------------------------------------------ ONE light rig for the whole model
# key and fill are tall panels, so light doesn't change along the rope (that is what lets the cable tile repeat);
# the narrow top light only adds the sheen on the frame's top bevel, so it is linked to the frame alone.
add_light(sc, "key", (-7, -12, 6), (0, 0, 6), (16, 80), K_KEY, (1.0, 0.985, 0.97), up="Y")
add_light(sc, "fill", (7.5, -8, 6), (0, 0, 6), (14, 80), K_FILL, (1.0, 0.80, 0.58), up="Y")
top = add_light(sc, "top", (0, -6, 9), (0, 0, 0), (20, 2), K_TOP, (0.92, 0.95, 1.0))
top.light_linking.receiver_collection = C_FRAME

def show(frame, hang, screen):
    for c, on in ((C_FRAME, frame), (C_HANG, hang), (C_SCREEN, screen)):
        for o in c.objects:                            # (all_objects is a stale cache after relinking)
            if o.name.endswith("_slot"): continue      # boolean cutters stay hidden
            o.hide_render = not on

def shoot(name, cx, cz, ortho, res, samples=None):
    for o in [o for o in sc.objects if o.type == "CAMERA"]: bpy.data.objects.remove(o)
    add_camera(sc, (cx, -12, cz), (math.radians(90), 0, 0), ortho, res)
    sc.cycles.samples = samples or SAMPLES
    sc.render.filepath = f"{RAW3}/{name}.png"
    bpy.ops.render.render(write_still=True, scene=sc.name)
    print("RENDERED", name)

if "frame" in PASSES:
    show(True, False, False)
    shoot("frame", 0, 0, W * PX, (W * 2, H * 2))
if "hanger" in PASSES:
    show(False, True, False); shoot("hanger", -XA, Z0 + HANG * PX, 2 * HANG * PX, (96 * 4, 2 * HANG * 4))
if "assembly" in PASSES:
    show(True, True, True); shoot("assembly", 0, 3.35, 12.4, (1240, 1230), samples=min(SAMPLES, 160))   # frame + ~7 BU of rope
bpy.ops.wm.save_as_mainfile(filepath=V3 + "/board.blend")
