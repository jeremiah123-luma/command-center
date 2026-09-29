#!/usr/bin/env python3
"""Assemble public/index.html from the artifact dashboard + a standalone data layer.
The render code (panels, hero dial, pager, styling) is reused verbatim; only the parts that
talked to the Claude viewer (db / mcp / sample) are replaced with fetch('/api/...') calls."""
import re, pathlib
HERE = pathlib.Path(__file__).parent
SRC = HERE / "dashboard.source.html"
OUT = HERE / "public" / "index.html"

src = SRC.read_text()
head_bits, body = src.split("<style>", 1)
style_and_rest = "<style>" + body
style, rest = style_and_rest.split("</style>", 1)
markup, script_tail = rest.split("<script>", 1)
script = script_tail.split("</script>", 1)[0]

# ---- script surgery: keep everything before BOOT, keep the PAGER, replace BOOT + COMMS ----
before_boot = script.split("/* ══════════════════════════════════════════════\n     BOOT")[0] if "BOOT\n" in script else script.split("/* ── BOOT ── */")[0]
pager = "/* ══════════════════════════════════════════════\n     PAGER" + script.split("/* ══════════════════════════════════════════════\n     PAGER", 1)[1]
pager = pager.rsplit("})();\n", 1)[0] + "})();\n"   # drop the outer IIFE close; we re-add it

new_boot = r'''
  /* ══════════════════════════════════════════════
     DATA LAYER — standalone: everything comes from this app's own /api
     ══════════════════════════════════════════════ */
  var notes=[], chatEnabled=false, googleConnected=true;
  async function api(path,opts){
    var r=await fetch(path,Object.assign({credentials:"same-origin",headers:{"content-type":"application/json"}},opts||{}));
    if(r.status===401){ location.href="/login"; throw new Error("unauthorized"); }
    return r.json();
  }
  async function loadState(){
    try{ var s=await api("/api/state"); ignored=s.ignored||[]; notes=s.notes||[]; chatEnabled=!!s.chat; googleConnected=!!s.google; if(canvas) renderCanvas(); }catch(e){}
  }
  async function loadCanvas(force){
    canvasBoot("fetching snapshot");
    try{
      var d=await api("/api/canvas"+(force?"?refresh=1":""));
      if(d.error==="canvas_token_missing"){ canvasState("Canvas token not set","Run: npx wrangler secret put CANVAS_TOKEN",""); return; }
      if(d.error==="canvas_token_invalid"){ canvasState("Canvas token expired","Generate a new one in Canvas → Settings, then re-run wrangler secret put CANVAS_TOKEN.","",function(){loadCanvas(true);}); return; }
      if(!d.items || (d.ok===false && !d.stale)){ canvasState("Canvas unavailable",d.error||"No data returned.","",function(){loadCanvas(true);}); return; }
      canvas=d; renderCanvas();
      if(d.stale) $("cv-sync").textContent="⚠ showing cached data — "+(d.error||"Canvas unreachable");
    }catch(e){ if(String(e.message)!=="unauthorized") canvasState("Canvas unavailable",String(e.message||e),"",function(){loadCanvas(true);}); }
  }
  async function loadCalendar(){
    try{
      var d=await api("/api/calendar");
      if(!d.ok){ if(/google_not_connected/.test(d.error||"")) { $("cal-body").innerHTML='<div class="state"><strong>Connect Google</strong>One-time sign-in to read your Calendar and Gmail.<br><a class="retry" href="/auth/google">Connect Google</a></div>'; $("cal-badge").textContent="offline"; setSrc("src-cal","err"); return; }
                showErr("cal-body","cal-badge","src-cal","upstream_error","Google Calendar",true); return; }
      calSources.primary=d.events.filter(function(e){return e.src==="primary";}); calSources.canvas=d.events.filter(function(e){return e.src==="canvas";});
      setSrc("src-cal","on"); ingestCal();
    }catch(e){}
  }
  async function loadGmail(){
    try{
      var d=await api("/api/gmail");
      if(!d.ok){ if(/google_not_connected/.test(d.error||"")){ $("mail-body").innerHTML='<div class="state"><strong>Connect Google</strong><a class="retry" href="/auth/google">Connect Google</a></div>'; $("mail-badge").textContent="offline"; setSrc("src-mail","err"); return; }
                showErr("mail-body","mail-badge","src-mail","upstream_error","Gmail",true); return; }
      renderMail((d.threads||[]).map(function(t){return {id:t.id,messages:[{sender:t.from,subject:t.subject,snippet:t.snippet,internalDate:String(t.ts),labelIds:t.important?["IMPORTANT"]:[]}]};}));
      setSrc("src-mail","on");
    }catch(e){}
  }
  // dismiss × on overdue rows → server
  dbRef={ doc:function(path){ return { set:function(data){ if(path==="canvas/ignored"){ var newest=(data.ids||[]).filter(function(id){return ignored.indexOf(id)<0;}); return Promise.all(newest.map(function(id){return api("/api/state",{method:"POST",body:JSON.stringify({dismiss:id})});})).then(loadState); } return Promise.resolve(); } }; } };
  function refreshAll(){ loadState().then(function(){ loadCanvas(false); }); loadCalendar(); loadGmail(); }
  tick(); refreshAll();
  CC.standalone=true; startCommute(api); startSpotify(api); startCar(api);   // live traffic, Spotify and the car go through this app's Worker
  setInterval(function(){ if(document.visibilityState==="visible") refreshAll(); },5*60000);
  document.addEventListener("visibilitychange",function(){ if(document.visibilityState==="visible") refreshAll(); });
  if(location.search.indexOf("connected=google")>-1) history.replaceState(null,"",location.pathname);
  if("serviceWorker" in navigator){ navigator.serviceWorker.register("/sw.js").catch(function(){}); }

  /* ══════════════════════════════════════════════
     COMMS LINK — real microphone (no viewer frame here) → /api/chat
     ══════════════════════════════════════════════ */
  (function(){
    var mic=$("mic"), drawer=$("voice"), log=$("voice-log"), status=$("voice-status"),
        form=$("voice-form"), input=$("voice-input"), stopBtn=$("voice-stop"), speakBox=$("voice-speak");
    var SR=window.SpeechRecognition||window.webkitSpeechRecognition||null;
    var turns=[], ctl=null, rec=null, listening=false, busy=false, speakOn=true;
    try{ speakOn=localStorage.getItem("cc.speak")!=="0"; }catch(e){}
    speakBox.checked=speakOn;
    speakBox.addEventListener("change",function(){ speakOn=speakBox.checked; try{localStorage.setItem("cc.speak",speakOn?"1":"0");}catch(e){} if(!speakOn&&window.speechSynthesis) speechSynthesis.cancel(); });
    mic.hidden=false;
    if(!SR){ mic.title="Tap, then use your keyboard's mic key"; input.placeholder="Tap the mic key on your keyboard, or type"; }

    function setStatus(t,cls){ status.textContent=t; status.className="status"+(cls?" "+cls:""); }
    function addMsg(cls,text){ var d=document.createElement("div"); d.className="msg "+cls; d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }
    function openDrawer(){ CC.openSheet(drawer); if(!log.children.length) addMsg("sys", chatEnabled ? "Link open · ask what's due, tell me things, or “dismiss …”" : "Answers are off here — anything you say is saved as a note."); }
    function closeDrawer(){ CC.closeSheet(drawer); if(listening&&rec) rec.stop(); }
    $("voice-close").addEventListener("click",closeDrawer);
    CC.on("sheetclose",function(el){ if(el===drawer&&listening&&rec) rec.stop(); });

    function speak(text){
      if(!speakOn||!window.speechSynthesis||!text) return;
      try{ speechSynthesis.cancel(); var u=new SpeechSynthesisUtterance(text.slice(0,600)); u.rate=1.02; u.pitch=.95;
        var vs=speechSynthesis.getVoices(), pick=vs.filter(function(v){return /en[-_]US/i.test(v.lang)&&/Samantha|Ava|Google US English|Alex|Aria/i.test(v.name);})[0]||vs.filter(function(v){return /^en/i.test(v.lang);})[0];
        if(pick) u.voice=pick; speechSynthesis.speak(u); }catch(e){}
    }
    async function ask(text){
      if(busy||!text.trim()) return;
      busy=true; mic.classList.add("thinking"); setStatus("Thinking","busy"); stopBtn.hidden=false; $("voice-send").disabled=true;
      addMsg("you",text);
      var bubble=addMsg("ai","…");
      try{
        if(!chatEnabled){
          await api("/api/state",{method:"POST",body:JSON.stringify({note:text})}); await loadState();
          bubble.textContent="Logged."; speak("Logged."); setStatus("Standing by");
        }else{
          turns.push({role:"user",content:text}); while(turns.length>12) turns.shift();
          ctl=new AbortController();
          var res=await api("/api/chat",{method:"POST",body:JSON.stringify({messages:turns}),signal:ctl.signal});
          if(res.error){ turns.pop(); bubble.textContent=res.error==="chat_disabled"?"Answers are off here. Try again later.":"Couldn't get an answer just now. Try again in a minute."; setStatus("Error","live"); }
          else{
            var reply=(res.reply||"").trim(); bubble.textContent=reply; turns.push({role:"assistant",content:reply}); speak(reply); setStatus("Standing by");
            (res.actions||[]).forEach(function(a){ addMsg("sys", a.type==="note"?"note saved":"dismissed · "+a.title); });
            if((res.actions||[]).length){ await loadState(); }
          }
        }
      }catch(e){ bubble.textContent=e.name==="AbortError"?"(stopped)":"Connection hiccup — try again."; setStatus("Standing by"); turns.pop(); }
      finally{ busy=false; ctl=null; mic.classList.remove("thinking"); stopBtn.hidden=true; $("voice-send").disabled=false; }
    }
    stopBtn.addEventListener("click",function(){ if(ctl) ctl.abort(); if(window.speechSynthesis) speechSynthesis.cancel(); });
    function clearInterim(){ [].forEach.call(log.querySelectorAll(".msg.interim"),function(n){ n.remove(); }); }
    // typing while the mic is on: drop what it heard so far and send the typed message instead
    form.addEventListener("submit",function(e){ e.preventDefault(); var t=input.value; input.value=""; if(listening&&rec){ rec.typed=true; try{ rec.abort(); }catch(x){} } clearInterim(); openDrawer(); ask(t); });

    function startListening(){
      openDrawer();
      if(!SR){ input.focus(); setStatus("Dictate or type"); return; }
      if(window.speechSynthesis) speechSynthesis.cancel();
      rec=new SR(); rec.lang="en-US"; rec.interimResults=true; rec.continuous=false; rec.maxAlternatives=1;
      var finalText="", interim=addMsg("you interim","listening…");
      rec.onstart=function(){ listening=true; mic.classList.add("listening"); setStatus("Listening","live"); };
      rec.onresult=function(ev){ var s=""; for(var i=ev.resultIndex;i<ev.results.length;i++){ s+=ev.results[i][0].transcript; if(ev.results[i].isFinal) finalText+=ev.results[i][0].transcript; } interim.textContent=(finalText||s||"listening…"); };
      rec.onerror=function(ev){ listening=false; mic.classList.remove("listening"); interim.remove();
        if(ev.error==="not-allowed"||ev.error==="service-not-allowed"){ addMsg("sys","Microphone permission denied — allow it in your browser settings for this site, or use the keyboard mic key."); input.focus(); }
        else addMsg("sys", ev.error==="no-speech"?"Didn't catch that.":"Mic error: "+ev.error);
        setStatus("Standing by"); };
      rec.onend=function(){ if(this.typed){ listening=false; mic.classList.remove("listening"); clearInterim(); return; }  listening=false; mic.classList.remove("listening"); var t=(finalText||interim.textContent||"").trim(); interim.remove(); if(t&&t!=="listening…"){ setStatus("Heard you"); ask(t); } else setStatus("Standing by"); };
      try{ rec.start(); }catch(e){ interim.remove(); addMsg("sys","Couldn't start the mic."); }
    }
    mic.addEventListener("click",function(){ if(listening&&rec){ rec.stop(); return; } if(busy) return; startListening(); });
    document.addEventListener("keydown",function(e){ if(e.key==="Escape"&&!drawer.hidden) closeDrawer(); });
  })();

'''

new_script = before_boot + new_boot + pager

# ---- small render-layer tweaks for the standalone build ----
# sync line copy: server caches 10 min, cron warms every 30
new_script = new_script.replace('" — hourly sync may have stalled"', '" — server cache may be stale"')
new_script = new_script.replace('var el=$("cv-sync"); if(!canvas){el.textContent="";return;}', 'var el=$("cv-sync"); if(!canvas||!canvas.updatedAt){el.textContent="";return;}')

# lock: a quiet "Lock" at the bottom of Today (the dock owns the bottom edge of the screen now)
AFTER = '<div class="stack gap-l" id="after" hidden></div>'
assert markup.count(AFTER) == 1, "Today markup changed: update the lock anchor in build_frontend.py"
markup = markup.replace(AFTER, AFTER + '\n        <form method="post" action="/logout" class="lock-form"><button type="submit" class="logout">Lock</button></form>')

title = re.search(r"<title>(.*?)</title>", head_bits).group(1)
fonts = re.search(r'<link rel="stylesheet" href="([^"]+)">', head_bits).group(1)

head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="Live personal dashboard: Canvas coursework, schedule, inbox, and a voice link.">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Command Center">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-180.png?v=2">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
{style}</style>
<style>
  /* standalone extras: the publish skeleton used to provide these */
  html{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}
  body{{margin:0}} img{{max-width:100%}} [hidden]{{display:none!important}}
  a.retry{{text-decoration:none}}
  .lock-form{{margin-top:40px}}
  .logout{{background:none;border:0;padding:0;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}}
  .logout:hover{{color:var(--o)}}
</style>
</head>
<body>
'''
foot = '''
<script>
''' + new_script + '''</script>
</body>
</html>
'''
OUT.write_text(head + markup + foot)
print("wrote", OUT, len((head+markup+foot).encode()), "bytes")
