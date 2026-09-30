/* CC-01 player (design/cc2/player): a 3D music player that replaces the now-playing sheet.
   Loaded on demand the first time the album circle is tapped (dashboard.source.html → openPlayer), so Today never waits
   for three.js. Everything visual is lifted from design/cc2/player/cc01.html; the made-up TRACKS / S state is replaced by
   the app's real Spotify state, read through the `bridge` the page passes in:
     bridge.state()   → { mode: "connect" | "empty" | "track", d, posMs, liked, canVol, vol, device, recent[], note }
     bridge.toggle() / next() / prev() / like() → Promise<{ok}>     bridge.volume(v)   bridge.play(uri)   bridge.connect()
   No new API calls: it uses the same /api/spotify/* calls the 2D sheet made. */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export function createPlayer({ canvas, loading, dots, live, chips, bridge }) {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  THREE.ColorManagement.enabled = false;

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias:false, alpha:false, powerPreference:"high-performance" }); }
  catch (e) { return null; }                                    // the page falls back to the 2D sheet
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(DPR);

  /* ── finishes ── */
  const FIN = {
    classic: { body:{c:"#F4F5F6"}, disc:{c:"#D2D4D6"}, btn:{c:"#FAFBFC"}, ring:"#CFD2D6", sw:"#FF4D00", icon:"#8E8E8C" },
    ink:     { body:{c:"#1c1a19"}, disc:{c:"#1e1c1b"}, btn:{c:"#F3F1EE"}, ring:"#FF4D00", sw:"#FF4D00", icon:"#CFC9C3" },
    signal:  { body:{c:"#F04E00"}, disc:{c:"#1e1c1b"}, btn:{c:"#F3F1EE"}, ring:"#141414", sw:"#141414", icon:"#E6E6E6" },
    paper:   { body:{c:"#E9E4DE"}, disc:{c:"#1e1c1b"}, btn:{c:"#FF4D00"}, ring:"#FF4D00", sw:"#FF4D00", icon:"#CFC9C3" }
  };
  let F = FIN.classic;

  /* ── scene ── */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const C = h => new THREE.Color(h);
  const lin = h => new THREE.Color(h).convertSRGBToLinear();
  // tone map + halftone in the deepest shadows, so the physical materials sit on the app's black stage
  const FILMIC = `vec3 cx = gl_FragColor.rgb*1.1; cx = clamp((cx*(2.51*cx + 0.03))/(cx*(2.43*cx + 0.59) + 0.14), 0.0, 1.0);
    gl_FragColor.rgb = pow(cx, vec3(1.0/2.2));
    { float L = dot(gl_FragColor.rgb, vec3(0.299,0.587,0.114)); vec2 hp = gl_FragCoord.xy/${(4.5*DPR).toFixed(2)};
      hp = mat2(0.7071,-0.7071,0.7071,0.7071)*hp; float hd = length(fract(hp)-0.5), hr = clamp((0.34-L)*0.9, 0.0, 0.3);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb*0.35, (1.0-smoothstep(hr-0.05, hr, hd))*step(0.03,hr)*0.55); }`;
  // o: { c, rough, metal, cc (clearcoat), ccRough, env, split (steel back below this z) }
  function pbr(o){
    const m = new THREE.MeshPhysicalMaterial({ color:lin(o.c), roughness:o.rough ?? .5, metalness:o.metal ?? 0, clearcoat:o.cc ?? 0, clearcoatRoughness:o.ccRough ?? .08, envMapIntensity:o.env ?? 1 });
    m.userData.u = { uSplit:{value:o.split ?? -99}, uBack:{value:lin(o.back || "#EEF0F2")} };
    m.onBeforeCompile = sh => { Object.assign(sh.uniforms, m.userData.u);
      sh.vertexShader = "varying float vLZ;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vLZ = position.z;");
      sh.fragmentShader = "varying float vLZ; uniform float uSplit; uniform vec3 uBack;\n" + sh.fragmentShader
        .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
          float isBack = 1.0 - step(uSplit, vLZ);                 // polished steel back, like the real thing
          diffuseColor.rgb = mix(diffuseColor.rgb, uBack, isBack); metalnessFactor = mix(metalnessFactor, 1.0, isBack); roughnessFactor = mix(roughnessFactor, 0.2, isBack);`)
        .replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\n #ifdef USE_CLEARCOAT\n material.clearcoat *= 1.0 - isBack;\n #endif")
        .replace("#include <tonemapping_fragment>", FILMIC); };
    m.customProgramCacheKey = () => "cc-pbr"; return m; }
  const setPBR = (m, c) => m.color.copy(lin(c));
  const INK = new THREE.ShaderMaterial({ side:THREE.BackSide, uniforms:{ uW:{value:0.008} },
    vertexShader:`uniform float uW; void main(){ gl_Position = projectionMatrix*modelViewMatrix*vec4(position + normal*uW, 1.0); }`,
    fragmentShader:`void main(){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); }` });
  function inked(geo, mat){ const m = new THREE.Mesh(geo, mat); m.add(new THREE.Mesh(geo, INK)); return m; }

  // stage: black, one warm light top-right, dots only around the light's edge (the app's look)
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2,2), new THREE.ShaderMaterial({ depthWrite:false, depthTest:false,
    uniforms:{ uT:{value:0}, uRes:{value:new THREE.Vector2(1,1)}, uDot:{value:6*DPR}, uGlow:{value:C("#FF4D00")} },
    vertexShader:`void main(){ gl_Position = vec4(position.xy,0.999,1.0); }`,
    fragmentShader:`uniform float uT; uniform vec2 uRes; uniform float uDot; uniform vec3 uGlow;
      void main(){
        vec2 uv = gl_FragCoord.xy/uRes; float asp = uRes.x/uRes.y;
        vec2 c = vec2(0.86+0.05*sin(uT*0.21), 0.9+0.04*cos(uT*0.17));
        vec2 q = (uv-c)*vec2(asp,1.0);
        float g = exp(-dot(q,q)*3.6);
        vec3 col = vec3(0.039,0.035,0.031);
        col = mix(col, uGlow*0.5, g*0.75);
        vec2 p = gl_FragCoord.xy/uDot; p = mat2(0.866,-0.5,0.5,0.866)*p;
        float d = length(fract(p)-0.5);
        float edge = smoothstep(0.12,0.38,g)*(1.0-smoothstep(0.55,0.9,g));
        float r = edge*0.36;
        col = mix(col, uGlow*0.9, (1.0-smoothstep(r-0.06,r,d))*step(0.03,r)*0.5);
        vec2 s = (uv-vec2(0.5,0.13))*vec2(asp*1.4,5.0);          // floor shadow under the player
        col *= 1.0 - 0.55*exp(-dot(s,s)*2.2);
        gl_FragColor = vec4(col,1.0);
      }` }));
  bg.frustumCulled = false; bg.renderOrder = -1; scene.add(bg);

  /* ── the player ── */
  const pod = new THREE.Group(); pod.visible = false; scene.add(pod);
  const W = 1.36, H = 2.3, D = 0.3, FZ = D/2;
  const bodyMat = pbr({ c:"#F4F5F6", rough:.42, cc:1, ccRough:.05, split:0, env:1.5 });   // glossy white front, steel back
  const body = inked(new RoundedBoxGeometry(W, H, D, 8, 0.16), bodyMat); pod.add(body);
  const seamShape = (() => { const w = (W+0.006)/2, h = (H+0.006)/2, r = 0.153, sh = new THREE.Shape();
    sh.moveTo(-w+r, -h); sh.lineTo(w-r, -h); sh.quadraticCurveTo(w, -h, w, -h+r); sh.lineTo(w, h-r); sh.quadraticCurveTo(w, h, w-r, h);
    sh.lineTo(-w+r, h); sh.quadraticCurveTo(-w, h, -w, h-r); sh.lineTo(-w, -h+r); sh.quadraticCurveTo(-w, -h, -w+r, -h); return sh; })();
  const seam = new THREE.Mesh(new THREE.ExtrudeGeometry(seamShape, { depth:0.01, bevelEnabled:false, curveSegments:10 }), new THREE.MeshBasicMaterial({ color:0x000000 }));
  seam.geometry.translate(0, 0, -0.005); pod.add(seam);

  const flatVS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
  const rrFS = (inner) => `uniform vec2 uSize; uniform float uR; varying vec2 vUv; ${inner.head||""}
    float sd(vec2 p, vec2 b, float r){ vec2 q = abs(p)-b+r; return length(max(q,0.0)) + min(max(q.x,q.y),0.0) - r; }
    void main(){ vec2 p = (vUv-0.5)*uSize; float d = sd(p, uSize*0.5, uR); if (d > 0.0) discard; ${inner.body} }`;
  function panel(w, h, r, fs, uniforms){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({ transparent:true, vertexShader:flatVS,
    fragmentShader:fs, uniforms:Object.assign({ uSize:{value:new THREE.Vector2(w, h)}, uR:{value:r} }, uniforms) })); }

  const SC = document.createElement("canvas"); SC.width = 640; SC.height = 460; const sx = SC.getContext("2d");
  const scTex = new THREE.CanvasTexture(SC); scTex.minFilter = THREE.LinearFilter; scTex.generateMipmaps = false;
  const SW = 1.12, SH = SW*460/640, SY = 0.6;
  const bezel = panel(SW+0.09, SH+0.09, 0.07, rrFS({ body:"gl_FragColor = vec4(0.02,0.02,0.02,1.0);" }), {});
  bezel.position.set(0, SY, FZ+0.002); pod.add(bezel);
  const screen = panel(SW, SH, 0.035, rrFS({ head:"uniform sampler2D map;", body:"vec3 c = texture2D(map,vUv).rgb; float s = 0.95+0.05*step(0.5,fract(vUv.y*230.0)); gl_FragColor = vec4(c*s,1.0);" }), { map:{value:scTex} });
  screen.position.set(0, SY, FZ+0.004); pod.add(screen);
  const glassMat = new THREE.ShaderMaterial({ transparent:true, depthWrite:false, uniforms:{ uSize:{value:new THREE.Vector2(SW+0.09, SH+0.09)}, uR:{value:0.07}, uYaw:{value:0} }, vertexShader:flatVS,
    fragmentShader:rrFS({ head:"uniform float uYaw;", body:"float x = vUv.x + vUv.y*0.55 - 0.55 + uYaw*0.35; float band = smoothstep(0.0,0.06,x)*(1.0-smoothstep(0.1,0.34,x)); float top = smoothstep(0.55,1.0,vUv.y)*0.05; gl_FragColor = vec4(vec3(1.0), band*0.085 + top);" }) });
  const glassPane = new THREE.Mesh(new THREE.PlaneGeometry(SW+0.09, SH+0.09), glassMat); glassPane.position.set(0, SY, FZ+0.006); pod.add(glassPane);

  // wheel
  const WY = -0.5, WR = 0.44, BR = 0.15, BTNZ = 0.035;
  const wheel = new THREE.Group(); wheel.position.set(0, WY, FZ); pod.add(wheel);
  const discMat = pbr({ c:"#D2D4D6", rough:.72, env:.6 });
  const disc = inked(new THREE.CylinderGeometry(WR, WR, 0.03, 72), discMat);
  disc.rotation.x = Math.PI/2; disc.position.z = 0.012; wheel.add(disc);
  const ringMat = pbr({ c:"#CFD2D6", rough:.22, metal:1, env:1.4 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(WR+0.016, 0.013, 10, 96), ringMat); ring.position.z = 0.018; wheel.add(ring);

  // the four buttons: icons drawn on the wheel; the one you press lights up orange
  const WC = document.createElement("canvas"); WC.width = WC.height = 512; const wx = WC.getContext("2d");
  let lit = null, litUntil = 0;
  function drawWheel(){
    wx.clearRect(0,0,512,512); const c = 256, rr = 190;
    const col = k => (lit === k ? "#FF4D00" : F.icon);
    const tri = (x,y,dir,s) => { wx.beginPath(); wx.moveTo(x-s*dir*.5,y-s); wx.lineTo(x+s*dir*.5+s*dir*.5,y); wx.lineTo(x-s*dir*.5,y+s); wx.closePath(); wx.fill(); };
    wx.fillStyle = col("menu"); for (let k = -1; k <= 1; k++) wx.fillRect(c-22, c-rr+k*11-3, 44, 6);                  // ☰ (top)
    wx.fillStyle = col("next"); tri(c+rr-16, c, 1, 14); tri(c+rr+2, c, 1, 14); wx.fillRect(c+rr+17, c-14, 5, 28);      // ⏭ (right)
    wx.fillStyle = col("prev"); tri(c-rr+16, c, -1, 14); tri(c-rr-2, c, -1, 14); wx.fillRect(c-rr-22, c-14, 5, 28);    // ⏮ (left)
    wx.fillStyle = col("play"); tri(c-14, c+rr, 1, 13); wx.fillRect(c+8, c+rr-13, 6, 26); wx.fillRect(c+19, c+rr-13, 6, 26); // ▶❙❙ (bottom)
  }
  drawWheel();
  const wTex = new THREE.CanvasTexture(WC);
  const icons = new THREE.Mesh(new THREE.CircleGeometry(WR, 72), new THREE.ShaderMaterial({ transparent:true, depthWrite:false, uniforms:{ map:{value:wTex} }, vertexShader:flatVS,
    fragmentShader:`uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map,vUv); }` }));
  icons.position.z = 0.0285; wheel.add(icons);
  const btnMat = pbr({ c:"#F7F8F9", rough:.35, cc:.8, ccRough:.08 });
  const btn = inked(new THREE.CylinderGeometry(BR, BR, 0.022, 56), btnMat); btn.rotation.x = Math.PI/2; btn.position.z = BTNZ; wheel.add(btn);

  // top edge: the orange hold switch and a headphone jack; bottom edge: a charging port
  const swMat = pbr({ c:"#FF4D00", rough:.35, cc:1, ccRough:.1 });
  const slot = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.03, 0.12, 2, 0.012), new THREE.MeshBasicMaterial({ color:0x050505 })); slot.position.set(W/2-0.34, H/2-0.005, 0.02); pod.add(slot);
  const hold = inked(new RoundedBoxGeometry(0.15, 0.06, 0.1, 3, 0.025), swMat); hold.position.set(W/2-0.4, H/2+0.02, 0.02); pod.add(hold);
  const jack = new THREE.Mesh(new THREE.CircleGeometry(0.05, 32), new THREE.MeshBasicMaterial({ color:0x020202 })); jack.rotation.x = -Math.PI/2; jack.position.set(-W/2+0.3, H/2+0.001, 0.0); pod.add(jack);
  const jackRing = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.062, 32), new THREE.MeshBasicMaterial({ color:0x6d6a67 })); jackRing.rotation.x = -Math.PI/2; jackRing.position.set(-W/2+0.3, H/2+0.0015, 0.0); pod.add(jackRing);
  const port = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.02, 0.07, 2, 0.01), new THREE.MeshBasicMaterial({ color:0x030303 })); port.position.set(0, -H/2+0.004, 0.0); pod.add(port);

  // back: polished steel with the CC tile (Sligoil, grey C + orange C), "CC-01" and small print
  const BC = document.createElement("canvas"); BC.width = 600; BC.height = 1000; const bx = BC.getContext("2d");
  function drawBack(){
    bx.clearRect(0,0,600,1000);
    const tS = 214, tx0 = 300 - tS/2, ty0 = 250;
    bx.fillStyle = "#000"; bx.beginPath(); bx.roundRect ? bx.roundRect(tx0, ty0, tS, tS, 30) : bx.rect(tx0, ty0, tS, tS); bx.fill();
    bx.strokeStyle = "#2E2E2E"; bx.lineWidth = 2; bx.beginPath(); bx.roundRect ? bx.roundRect(tx0+1, ty0+1, tS-2, tS-2, 29) : bx.rect(tx0+1, ty0+1, tS-2, tS-2); bx.stroke();
    bx.font = "112px Sligoil"; bx.textBaseline = "middle"; bx.textAlign = "left";
    const cw = bx.measureText("C").width, gap = -cw*0.04, total = cw*2+gap, x0 = tx0 + (tS-total)/2, yM = ty0 + tS/2 + 3;
    bx.fillStyle = "#E6E6E6"; bx.fillText("C", x0, yM); bx.fillStyle = "#FF4D00"; bx.fillText("C", x0+cw+gap, yM);
    bx.textAlign = "center"; bx.fillStyle = "rgba(20,20,22,.78)";
    bx.font = "500 38px 'Petrona', Georgia, serif"; bx.fillText("CC-01", 300, 560);
    bx.font = "500 15px 'Geist Mono', monospace"; bx.fillStyle = "rgba(20,20,22,.6)";
    bx.fillText("COMMAND CENTER · 64 GB", 300, 608);
    bx.fillText("DESIGNED BY JEREMY IN NEW JERSEY", 300, 636);
  }
  drawBack();
  const bTex = new THREE.CanvasTexture(BC);
  const back = panel(1.16, 1.16*1000/600, 0.1, rrFS({ head:"uniform sampler2D map;", body:"vec4 c = texture2D(map,vUv); if (c.a < 0.02) discard; gl_FragColor = c;" }), { map:{value:bTex} });
  back.position.z = -FZ-0.002; back.rotation.y = Math.PI; pod.add(back);

  { const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
    const key = new THREE.DirectionalLight(0xffe6d2, 1.4); key.position.set(-3, 4, 5); scene.add(key);
    const kick = new THREE.DirectionalLight(0xff6a2a, 1.3); kick.position.set(4, 3, -2); scene.add(kick);
    scene.add(new THREE.AmbientLight(0xffffff, 0.12)); }

  /* ── the screen, drawn from the real Spotify state ── */
  const mmss = s => Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
  function wrap(text, maxW, font, n){ sx.font = font; const words = String(text).split(" "), lines = []; let cur = "";
    for (const w of words){ const t2 = cur ? cur+" "+w : w; if (sx.measureText(t2).width > maxW && cur){ lines.push(cur); cur = w; } else cur = t2; }
    if (cur) lines.push(cur); if (lines.length > n){ lines.length = n; lines[n-1] = lines[n-1].replace(/\s*\S*$/, "") + "…"; } return lines; }
  function clip(text, maxW, font){ sx.font = font; let t = String(text); if (sx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && sx.measureText(t+"…").width > maxW) t = t.slice(0,-1); return t+"…"; }
  // the real cover, drawn into the square; until it arrives (or if it won't load) the halftone placeholder from the reference
  let artUrl = "", artImg = null;
  function wantArt(url){ if (url === artUrl) return; artUrl = url; artImg = null; if (!url) return;
    const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => { if (artUrl === url) artImg = im; }; im.src = url; }
  function art(x, y, s){
    if (artImg){ sx.drawImage(artImg, x, y, s, s); return; }
    sx.fillStyle = "#111"; sx.fillRect(x, y, s, s);
    const g = sx.createRadialGradient(x+s*.75, y+s*.2, 4, x+s*.75, y+s*.2, s*1.1); g.addColorStop(0, "#FF4D00"); g.addColorStop(1, "rgba(0,0,0,0)");
    sx.fillStyle = g; sx.fillRect(x, y, s, s); sx.fillStyle = "#FF4D00";
    for (let yy = 0; yy < s; yy += 11) for (let xx = 0; xx < s; xx += 11){ const k = Math.max(0, 1 - Math.hypot(xx - s*.2, yy - s*.85)/(s*.9)); if (k > .05){ sx.beginPath(); sx.arc(x+xx+5.5, y+yy+5.5, 4.6*k, 0, 7); sx.fill(); } }
  }
  const V = { menu:false, sel:0, vol:null, volUntil:0, noVolUntil:0 };
  function head(label, right, liked){
    sx.textAlign = "left"; sx.textBaseline = "alphabetic"; sx.font = "500 18px 'Geist Mono', monospace"; sx.fillStyle = "rgba(255,255,255,.5)";
    sx.fillText(label, 30, 44);
    if (liked){ sx.fillStyle = "#FF4D00"; const w = sx.measureText(label).width, hx = 30+w+16, hy = 38;   // a small heart after the label
      sx.beginPath(); sx.moveTo(hx, hy+6); sx.bezierCurveTo(hx-9, hy-1, hx-5, hy-9, hx, hy-4); sx.bezierCurveTo(hx+5, hy-9, hx+9, hy-1, hx, hy+6); sx.fill(); }
    if (right){ sx.textAlign = "right"; sx.fillStyle = "rgba(255,255,255,.5)"; sx.fillText(clip(right, 250, "500 18px 'Geist Mono', monospace"), 610, 44); sx.textAlign = "left"; }
  }
  function drawScreen(now){
    const st = bridge.state(), d = st.d;
    sx.fillStyle = "#070606"; sx.fillRect(0,0,640,460);
    if (st.mode === "connect"){
      head("SPOTIFY", "");
      sx.fillStyle = "#F2F2F2"; sx.font = "500 50px 'Petrona', Georgia, serif"; sx.fillText("Connect Spotify", 30, 190);
      sx.font = "500 18px 'Geist Mono', monospace"; sx.fillStyle = "rgba(255,255,255,.55)"; sx.fillText("PRESS THE CENTER BUTTON TO SIGN IN", 30, 236);
    } else if (V.menu){
      const list = st.recent; head("LIBRARY", list.length ? (V.sel+1)+" / "+list.length : "");
      const top = Math.max(0, Math.min(V.sel - 1, list.length - 4));
      list.slice(top, top+4).forEach((t, j) => { const k = top + j, y = 70 + j*90, on = k === V.sel;
        if (on){ sx.fillStyle = "#FF4D00"; sx.fillRect(18, y, 604, 80); }
        sx.fillStyle = on ? "#000" : "#F2F2F2"; sx.fillText(clip(t.title, 540, "500 34px 'Petrona', Georgia, serif"), 34, y+38);
        sx.fillStyle = on ? "rgba(0,0,0,.65)" : "rgba(255,255,255,.45)"; sx.fillText(clip((t.artists||"").toUpperCase()+(t.durationMs ? "  ·  "+mmss(t.durationMs/1000) : ""), 540, "500 16px 'Geist Mono', monospace"), 34, y+64);
        if (d && d.item && t.uri === d.item.uri){ sx.fillStyle = on ? "#000" : "#FF4D00"; sx.beginPath(); sx.arc(598, y+40, 6, 0, 7); sx.fill(); } });
      if (!list.length){ sx.fillStyle = "rgba(255,255,255,.55)"; sx.font = "500 18px 'Geist Mono', monospace"; sx.fillText("NOTHING PLAYED YET", 30, 110); }
    } else if (st.mode === "empty"){
      head("SPOTIFY", st.device || "");
      sx.fillStyle = "#F2F2F2"; sx.font = "500 46px 'Petrona', Georgia, serif"; sx.fillText("Nothing playing", 30, 190);
      sx.font = "500 18px 'Geist Mono', monospace"; sx.fillStyle = "rgba(255,255,255,.55)"; sx.fillText("START A SONG IN SPOTIFY", 30, 234);
    } else {
      const it = d.item, playing = !!d.isPlaying;
      head(playing ? "NOW PLAYING" : "PAUSED", st.device ? st.device.toUpperCase() : "", st.liked);
      if (!playing){ sx.fillStyle = "#FF4D00"; sx.fillRect(30, 30, 4, 18); }
      wantArt(it.art); art(30, 74, 184);
      const lines = wrap(it.title, 370, "500 46px 'Petrona', Georgia, serif", 2);
      sx.fillStyle = "#F2F2F2"; lines.forEach((l, k) => sx.fillText(l, 238, 118 + k*50));
      sx.font = "500 18px 'Geist Mono', monospace"; sx.fillStyle = "rgba(255,255,255,.5)";
      sx.fillText(clip((it.artists||"").toUpperCase(), 370, "500 18px 'Geist Mono', monospace"), 240, 118 + lines.length*50 + 2);
      if (now < V.noVolUntil){
        sx.fillStyle = "rgba(255,255,255,.5)"; sx.font = "500 18px 'Geist Mono', monospace"; sx.fillText("VOLUME", 30, 330);
        sx.fillStyle = "#FF4D00"; sx.fillText("THIS DEVICE WON'T TAKE VOLUME", 30, 372);
        sx.fillStyle = "rgba(255,255,255,.45)"; sx.fillText("USE THE BUTTONS ON "+(st.device ? clip(st.device.toUpperCase(), 250, "500 18px 'Geist Mono', monospace") : "THE DEVICE"), 30, 404);
      } else if (now < V.volUntil && V.vol != null){
        sx.fillStyle = "rgba(255,255,255,.5)"; sx.font = "500 18px 'Geist Mono', monospace"; sx.fillText("VOLUME", 30, 330);
        sx.textAlign = "right"; sx.fillStyle = "#FF4D00"; sx.font = "700 30px 'Geist Mono', monospace"; sx.fillText(String(Math.round(V.vol)), 610, 332); sx.textAlign = "left";
        const n = 24, on = Math.round(V.vol/100*n); for (let k = 0; k < n; k++){ sx.fillStyle = k < on ? "#FF4D00" : "rgba(255,255,255,.12)"; sx.fillRect(30 + k*24.2, 352, 18, 44); }
      } else {
        const dur = (it.durationMs||0)/1000, pos = Math.min(dur||0, (st.posMs||0)/1000);
        sx.fillStyle = "rgba(255,255,255,.14)"; sx.fillRect(30, 364, 580, 6);
        sx.fillStyle = "#FF4D00"; sx.fillRect(30, 364, dur ? 580*Math.min(1, pos/dur) : 0, 6);
        sx.font = "500 19px 'Geist Mono', monospace"; sx.fillStyle = "rgba(255,255,255,.7)";
        sx.fillText(mmss(pos), 30, 408); if (dur){ sx.textAlign = "right"; sx.fillText("-"+mmss(Math.max(0, dur - pos)), 610, 408); sx.textAlign = "left"; }
      }
    }
    if (st.note){ sx.fillStyle = "rgba(7,6,6,.92)"; sx.fillRect(0, 418, 640, 42); sx.fillStyle = "#FFCD1A"; sx.font = "500 17px 'Geist Mono', monospace"; sx.fillText(clip(st.note.toUpperCase(), 580, "500 17px 'Geist Mono', monospace"), 30, 446); }
    scTex.needsUpdate = true;
  }

  /* ── finishes (remembered in localStorage cc01.look) ── */
  function applyFinish(name){
    if (!FIN[name]) name = "classic"; F = FIN[name];
    setPBR(bodyMat, F.body.c); setPBR(discMat, F.disc.c); setPBR(ringMat, F.ring); setPBR(btnMat, F.btn.c); setPBR(swMat, F.sw);
    bodyMat.roughness = name === "ink" ? .3 : .42;
    drawWheel(); wTex.needsUpdate = true; drawBack(); bTex.needsUpdate = true;
    chips.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === name)));
    try { localStorage.setItem("cc01.look", name); } catch(e){}
  }
  chips.querySelectorAll("button").forEach(b => b.addEventListener("click", () => applyFinish(b.dataset.f)));

  /* ── actions: the button lights up, the wheel rocks, and the colour plates slip a little ── */
  let shift = 0, tilt = { x:0, y:0 }, press = 0, ringFlash = 0;
  function feel(which){ lit = which; litUntil = performance.now() + 420; drawWheel(); wTex.needsUpdate = true; shift = 1;
    const a = { menu:[1,0], play:[-1,0], next:[0,1], prev:[0,-1] }[which] || [0,0]; tilt.x = -a[0]*0.09; tilt.y = a[1]*0.09; }
  function say(t){ live.textContent = t; }
  function flashRing(){ ringFlash = performance.now() + 700; setPBR(ringMat, "#FF4D00"); }
  const A = {
    next(){ feel("next"); if (bridge.state().mode === "track") bridge.next(); },
    prev(){ feel("prev"); if (bridge.state().mode === "track") bridge.prev(); },
    center(fromBtn){
      const st = bridge.state(); if (fromBtn){ press = 1; shift = 0.7; feel("center"); } else feel("play");
      if (st.mode === "connect"){ bridge.connect(); return; }
      if (V.menu){ const t = st.recent[V.sel]; V.menu = false; if (t && !(st.d && st.d.item && t.uri === st.d.item.uri)) { bridge.play(t.uri); say("Playing "+t.title); } return; }
      if (st.mode !== "track") return;
      bridge.toggle(); say((st.d.isPlaying ? "Paused " : "Playing ") + st.d.item.title);
    },
    menu(){ const st = bridge.state(); V.menu = !V.menu; const i = st.recent.findIndex(t => st.d && st.d.item && t.uri === st.d.item.uri); V.sel = Math.max(0, i); feel("menu"); say(V.menu ? "Library" : "Now playing"); },
    like(){ const st = bridge.state(); if (st.mode !== "track") return; press = 1; shift = 0.7;
      bridge.like().then(r => { if (r && r.ok) { flashRing(); say(st.liked ? "Removed from Liked Songs" : "Saved to Liked Songs"); } }); },
    vol(dir){ const st = bridge.state(); if (st.mode !== "track") return;
      if (!st.canVol){ V.noVolUntil = performance.now() + 1600; return; }
      if (V.vol == null || performance.now() > V.volUntil) V.vol = st.vol ?? 50;
      V.vol = Math.max(0, Math.min(100, V.vol + dir*3)); V.volUntil = performance.now() + 1400; bridge.volume(V.vol); }
  };

  /* ── pointer: spin the wheel for volume (a detent every 15°, clockwise = up), tap its edge for the four buttons,
       press the center to play/pause, hold it 600 ms to like; drag anywhere else to turn the player ── */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let mode = null, lastAng = 0, acc = 0, spun = 0, sx0 = 0, lx = 0, ly = 0, yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, holdT = 0, held = false;
  function hitWheel(e){
    const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
    ray.setFromCamera(ndc, camera); const h = ray.intersectObjects([disc, btn], false)[0]; if (!h) return null;
    const p = wheel.worldToLocal(h.point.clone()); return { r:Math.hypot(p.x,p.y), a:Math.atan2(p.y,p.x) };
  }
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId); sx0 = lx = e.clientX; ly = e.clientY;
    const w = hitWheel(e);
    if (w && w.r < BR+0.02){ mode = "btn"; press = 0.6; held = false; clearTimeout(holdT); holdT = setTimeout(() => { if (mode === "btn"){ held = true; A.like(); } }, 600); }
    else if (w){ mode = "wheel"; lastAng = w.a; acc = 0; spun = 0; }
    else { mode = "turn"; canvas.classList.add("drag"); }
  });
  canvas.addEventListener("pointermove", e => {
    if (mode === "wheel"){
      const w = hitWheel(e); if (!w) return;
      let d = w.a - lastAng; if (d > Math.PI) d -= 2*Math.PI; if (d < -Math.PI) d += 2*Math.PI; lastAng = w.a;
      acc += d; spun += Math.abs(d);
      const STEP = Math.PI/12;                                 // a detent every 15°
      while (Math.abs(acc) >= STEP){ const dir = acc < 0 ? 1 : -1; acc += dir*STEP;        // clockwise = up
        const n = bridge.state().recent.length; if (V.menu){ if (n) V.sel = (V.sel + dir + n) % n; } else A.vol(dir); }
    } else if (mode === "turn"){
      tYaw += (e.clientX-lx)*0.012; tPitch += (e.clientY-ly)*0.008; tPitch = Math.max(-0.6, Math.min(0.6, tPitch)); lx = e.clientX; ly = e.clientY;
    }
  });
  function end(e){
    clearTimeout(holdT);
    if (mode === "wheel" && spun < 0.18){
      const deg = (lastAng*180/Math.PI + 360) % 360;
      if (deg >= 45 && deg < 135) A.menu(); else if (deg >= 135 && deg < 225) A.prev(); else if (deg >= 225 && deg < 315) A.center(false); else A.next();
    } else if (mode === "btn" && !held){ const w = hitWheel(e); if (w && w.r < BR+0.04) A.center(true); }
    else if (mode === "turn"){ const q = Math.round(tYaw/Math.PI)*Math.PI; tYaw = Math.abs(tYaw - q) < 0.9 ? q : tYaw; tPitch = 0; if (Math.abs(e.clientX-sx0) < 4) tYaw = Math.round(tYaw/(2*Math.PI))*2*Math.PI; }
    mode = null; held = false; canvas.classList.remove("drag");
  }
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  function onKey(e){
    if (!running || (e.target.closest && e.target.closest("button,input"))) return;
    const n = bridge.state().recent.length;
    if (e.key === " "){ e.preventDefault(); A.center(false); } else if (e.key === "ArrowRight") A.next(); else if (e.key === "ArrowLeft") A.prev();
    else if (e.key === "ArrowUp"){ e.preventDefault(); V.menu ? (n && (V.sel = (V.sel+n-1)%n)) : A.vol(1); } else if (e.key === "ArrowDown"){ e.preventDefault(); V.menu ? (n && (V.sel = (V.sel+1)%n)) : A.vol(-1); }
    else if (e.key === "m" || e.key === "M") A.menu(); else if (e.key === "l" || e.key === "L") A.like();
  }
  window.addEventListener("keydown", onKey);

  /* ── post: the colour plates sit slightly off register, like a printed comic ── */
  const rt = new THREE.WebGLRenderTarget(1, 1, { samples:4 });
  const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const post = new THREE.Mesh(new THREE.PlaneGeometry(2,2), new THREE.ShaderMaterial({ uniforms:{ t:{value:rt.texture}, uS:{value:0}, uRes:{value:new THREE.Vector2(1,1)} },
    vertexShader:`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`,
    fragmentShader:`uniform sampler2D t; uniform float uS; uniform vec2 uRes; varying vec2 vUv;
      void main(){ vec2 o = vec2(uS/uRes.x, uS*0.4/uRes.y);
        vec3 c = texture2D(t, vUv).rgb; float r = texture2D(t, vUv + o).r; float b = texture2D(t, vUv - o).b;
        gl_FragColor = vec4(r, c.g, mix(c.b, b, 0.85), 1.0); }` }));
  postScene.add(post);

  // sized to the sheet's canvas (not the window), so it fits under the sheet's header and above the finish chips
  let cw = 0, ch = 0;
  function resize(){
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h || (w === cw && h === ch)) return; cw = w; ch = h;
    renderer.setSize(w, h, false); rt.setSize(Math.round(w*DPR), Math.round(h*DPR));
    camera.aspect = w/h; const k = 2*Math.tan(15*Math.PI/180); camera.position.set(0, 0, Math.max((W/0.64)/(k*camera.aspect), (H/0.72)/k)); camera.updateProjectionMatrix();
    bg.material.uniforms.uRes.value.set(w*DPR, h*DPR); post.material.uniforms.uRes.value.set(w*DPR, h*DPR);
  }
  window.addEventListener("resize", resize);

  /* ── loop: only while the sheet is open ── */
  let running = false, raf = 0, last = performance.now(), lastDraw = 0;
  function frame(now){
    raf = 0; if (!running) return;
    resize();
    const dt = Math.min(0.1, (now - last)/1000); last = now;
    if (lit && now > litUntil){ lit = null; drawWheel(); wTex.needsUpdate = true; }
    if (ringFlash && now > ringFlash){ ringFlash = 0; setPBR(ringMat, F.ring); }
    const step = REDUCED ? 0 : Math.floor(now/1000*12)/12;    // idle motion drawn on twos
    yaw += (tYaw - yaw)*Math.min(1, dt*9); pitch += (tPitch - pitch)*Math.min(1, dt*9);
    pod.rotation.set(pitch + Math.sin(step*0.9)*0.04, yaw + Math.sin(step*0.6)*0.1, Math.sin(step*0.7)*0.02);
    pod.position.y = 0.04 + Math.sin(step*1.1)*0.04;
    tilt.x *= Math.pow(0.001, dt); tilt.y *= Math.pow(0.001, dt); wheel.rotation.set(tilt.x, tilt.y, 0);
    // rocking about the wheel's centre pushed the pressed edge ~0.04 into the body (the wheel only stands ~0.03 proud),
    // so the white face showed through the disc, rim and icons. Lift it by exactly that much: it pivots on the pressed edge.
    wheel.position.z = FZ + (WR + 0.03) * (Math.abs(Math.sin(tilt.x)) + Math.abs(Math.sin(tilt.y)));
    press = Math.max(0, press - dt*5); btn.position.z = BTNZ - press*0.009;
    shift = Math.max(0, shift - dt*3);
    post.material.uniforms.uS.value = (0.7 + shift*2.2) * DPR * (REDUCED ? 0.6 : 1);
    bg.material.uniforms.uT.value = step; glassMat.uniforms.uYaw.value = pod.rotation.y;
    if (now - lastDraw > 66){ drawScreen(now); lastDraw = now; }
    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(postScene, postCam);
    raf = requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running && !raf){ last = performance.now(); raf = requestAnimationFrame(frame); } });

  // the loading line: . → .. → ... → . until the fonts are in and the shaders are compiled
  let dotN = 1; const dotTimer = setInterval(() => { dotN = dotN % 3 + 1; dots.textContent = ".".repeat(dotN); }, 400);
  let saved = "classic"; try { saved = localStorage.getItem("cc01.look") || "classic"; } catch(e){}
  const ready = Promise.all(["112px Sligoil","500 46px Petrona","500 20px 'Geist Mono'","700 30px 'Geist Mono'"].map(f => document.fonts.load(f))).catch(()=>{}).then(() => {
    applyFinish(saved); resize(); renderer.compile(scene, camera);
    clearInterval(dotTimer); loading.style.opacity = 0; pod.visible = true;
  });

  return {
    ready,
    start(){ if (running) return; running = true; last = performance.now(); V.menu = false; if (!raf) raf = requestAnimationFrame(frame); },
    stop(){ running = false; if (raf){ cancelAnimationFrame(raf); raf = 0; } },
  };
}
