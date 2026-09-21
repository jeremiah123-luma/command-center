/**
 * Command Center — standalone backend (Cloudflare Worker)
 *
 * One file, five jobs:
 *   1. Gate everything behind a PIN (signed cookie session)
 *   2. Google OAuth once, then read Calendar + Gmail with the stored refresh token
 *   3. Read Canvas (planner items with submission status), cached 10 min
 *   4. Keep small state: dismissed item ids + voice notes (KV)
 *   5. Optional chat: /api/chat → Anthropic API with two tools (dismiss, note)
 *
 * Routes
 *   GET  /login, POST /login, POST /logout
 *   GET  /auth/google  → Google consent   GET /auth/google/callback → stores refresh token
 *   GET  /api/canvas   GET /api/calendar   GET /api/gmail   GET /api/state
 *   POST /api/state    { dismiss?: id, note?: text, undismiss?: id, deleteNote?: id }
 *   POST /api/chat     { messages:[{role,content}] }  → { reply }
 *   GET  /api/health
 *   everything else → static asset (public/), gated
 */

const SESSION_COOKIE = "cc_session";
const SESSION_DAYS = 90;
const CANVAS_CACHE_SECONDS = 600;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---- public routes (no session needed) ----
      if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });
      // Fallback ingest: an external runner POSTs the Canvas snapshot here. Auth = shared secret header, not the PIN cookie.
      if (path === "/api/canvas/ingest" && request.method === "POST") {
        if (!env.INGEST_SECRET || request.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return json({ error: "forbidden" }, 403);
        const snap = await request.json().catch(() => null);
        if (!snap || !Array.isArray(snap.items)) return json({ error: "bad snapshot" }, 400);
        snap.ok = true; snap.updatedAt = snap.updatedAt || new Date().toISOString(); snap.source = "ingest";
        await env.STATE.put("canvas:snapshot", JSON.stringify(snap));
        return json({ ok: true, items: snap.items.length });
      }
      if (path === "/login") return request.method === "POST" ? handleLoginPost(request, env) : loginPage();
      if (path === "/logout") return logout(url);
      if (path === "/manifest.webmanifest" || path === "/sw.js" || path.startsWith("/icons/") || path === "/privacy" || path === "/terms") return env.ASSETS.fetch(request);

      // ---- everything below needs a valid session ----
      const authed = await hasSession(request, env);
      if (!authed) {
        if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
        return Response.redirect(`${url.origin}/login`, 302);
      }

      if (path === "/auth/google") return googleAuthStart(url, env);
      if (path === "/auth/google/callback") return googleAuthCallback(url, env);

      if (path === "/api/canvas") return json(await getCanvas(env, url.searchParams.get("refresh") === "1"));
      if (path === "/api/calendar") return json(await getCalendar(env));
      if (path === "/api/gmail") return json(await getGmail(env));
      if (path === "/api/state") return request.method === "POST" ? postState(request, env) : json(await getState(env));
      if (path === "/api/chat") return request.method === "POST" ? chat(request, env) : json({ error: "POST only" }, 405);

      // static dashboard
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: String(err && err.message || err) }, 500);
    }
  },

  // Cron (see wrangler.toml [triggers]): warm the Canvas cache so the app opens instantly.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getCanvas(env, true).then(r => { if (r.ok) console.log(`canvas warm ok: ${r.items.length} items`); else console.error(`canvas warm failed: ${r.error}`); }).catch(() => {}));
  },
};

/* ───────────────────────── helpers ───────────────────────── */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function getCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/* ───────────────────────── auth (PIN → signed cookie) ───────────────────────── */

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${exp}.${crypto.randomUUID()}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}
async function hasSession(request, env) {
  const tok = getCookie(request, SESSION_COOKIE);
  if (!tok || !env.SESSION_SECRET) return false;
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (Number(exp) < Date.now()) return false;
  const expect = await hmac(env.SESSION_SECRET, `${exp}.${nonce}`);
  return timingSafeEqual(sig, expect);
}
async function handleLoginPost(request, env) {
  const form = await request.formData().catch(() => null);
  const pin = String(form?.get("pin") || "").trim();
  // simple brute-force brake: 5 tries per 10 min per IP
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const key = `login:${ip}`;
  const tries = Number(await env.STATE.get(key)) || 0;
  if (tries >= 5) return loginPage("Too many attempts. Try again in 10 minutes.", 429);
  if (!env.PIN || !timingSafeEqual(pin, String(env.PIN))) {
    await env.STATE.put(key, String(tries + 1), { expirationTtl: 600 });
    return loginPage("Wrong code.", 401);
  }
  await env.STATE.delete(key);
  const tok = await makeSession(env);
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/`,
      "set-cookie": `${SESSION_COOKIE}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    },
  });
}
function logout(url) {
  return new Response(null, { status: 302, headers: { location: `${url.origin}/login`, "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
}
function loginPage(msg = "", status = 200) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Command Center — Unlock</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#05080e">
<style>
  html,body{height:100%;margin:0;background:#05080e;color:#dceaf3;font-family:"Rajdhani","Exo 2",system-ui,sans-serif;display:grid;place-items:center}
  form{width:min(360px,90vw);padding:28px 26px;border:1px solid rgba(92,230,255,.28);border-radius:6px;background:rgba(10,20,32,.72);position:relative;text-align:center}
  h1{margin:0 0 6px;font-size:16px;letter-spacing:.24em;text-transform:uppercase;color:#5ce6ff;text-shadow:0 0 18px rgba(92,230,255,.3)}
  p{margin:0 0 20px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;color:#86a6b8;text-transform:uppercase}
  input{width:100%;box-sizing:border-box;font:600 34px ui-monospace,monospace;letter-spacing:.5em;text-align:center;padding:12px 0 12px .5em;background:rgba(5,8,14,.7);border:1px solid rgba(92,230,255,.28);color:#fff;border-radius:4px;outline:none}
  input:focus{border-color:#5ce6ff;box-shadow:0 0 14px rgba(92,230,255,.25)}
  button{margin-top:16px;width:100%;padding:12px;font:600 13px ui-monospace,monospace;letter-spacing:.24em;text-transform:uppercase;background:rgba(92,230,255,.1);border:1px solid #5ce6ff;color:#5ce6ff;border-radius:4px;cursor:pointer}
  .err{color:#ff4f63;margin-top:12px;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.1em}
</style></head><body>
<form method="post" action="/login" autocomplete="off">
  <h1>Command Center</h1><p>Enter access code</p>
  <input name="pin" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" autofocus required aria-label="Access code">
  <button type="submit">Unlock</button>
  ${msg ? `<div class="err">${msg}</div>` : ""}
</form></body></html>`, status);
}

/* ───────────────────────── Google OAuth + APIs ───────────────────────── */

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/gmail.readonly"].join(" ");

function googleAuthStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID) return html("<p>GOOGLE_CLIENT_ID secret is not set yet.</p>", 500);
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",           // forces a refresh_token to be issued
    include_granted_scopes: "true",
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
}
async function googleAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return html(`<p>Google returned no code: ${url.searchParams.get("error") || "unknown"}</p>`, 400);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code" }),
  });
  const tok = await r.json();
  if (!tok.refresh_token) return html(`<p>No refresh token in Google's reply. Remove the app at myaccount.google.com/permissions and try again.</p><pre>${escapeHtml(JSON.stringify(tok, null, 1))}</pre>`, 400);
  await env.STATE.put("google:refresh_token", tok.refresh_token);
  await env.STATE.put("google:access", JSON.stringify({ token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 }));
  return Response.redirect(`${url.origin}/?connected=google`, 302);
}
async function googleAccessToken(env) {
  const cached = JSON.parse((await env.STATE.get("google:access")) || "null");
  if (cached && cached.exp > Date.now()) return cached.token;
  const refresh = await env.STATE.get("google:refresh_token");
  if (!refresh) throw new Error("google_not_connected");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }),
  });
  const tok = await r.json();
  if (!tok.access_token) throw new Error("google_refresh_failed: " + (tok.error || r.status));
  await env.STATE.put("google:access", JSON.stringify({ token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 }));
  return tok.access_token;
}
async function gfetch(env, url) {
  const t = await googleAccessToken(env);
  const r = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`google_api_${r.status}`);
  return r.json();
}

async function getCalendar(env) {
  try {
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 14 * 86400000);
    // primary + any calendar whose name mentions Canvas (the Canvas ICS feed)
    const list = await gfetch(env, "https://www.googleapis.com/calendar/v3/users/me/calendarList");
    const cals = (list.items || []).filter(c => c.primary || /canvas/i.test(c.summary || ""));
    const out = [];
    for (const c of cals) {
      const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "80", timeZone: env.TIMEZONE });
      const ev = await gfetch(env, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const e of ev.items || []) out.push({ id: e.id, summary: e.summary, description: e.description, location: e.location, start: e.start, end: e.end, htmlLink: e.htmlLink, status: e.status, src: c.primary ? "primary" : "canvas" });
    }
    return { ok: true, events: out, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: String(e.message || e), events: [] };
  }
}

async function getGmail(env) {
  try {
    const q = new URLSearchParams({ q: "is:unread in:inbox newer_than:14d", maxResults: "25" });
    const list = await gfetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/threads?${q}`);
    const threads = [];
    for (const t of (list.threads || []).slice(0, 25)) {
      const th = await gfetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const m = (th.messages || [])[th.messages.length - 1];
      const h = Object.fromEntries((m?.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
      threads.push({ id: t.id, from: h.from || "", subject: h.subject || "(no subject)", snippet: m?.snippet || "", ts: Number(m?.internalDate) || 0, important: (m?.labelIds || []).includes("IMPORTANT") });
    }
    return { ok: true, threads, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: String(e.message || e), threads: [] };
  }
}

/* ───────────────────────── Canvas ───────────────────────── */

function shortCode(code = "", name = "") {
  const c = code.replace(/^[A-Z]{2}\d{2}-/, "");
  const m = c.match(/^([A-Z]{2,5})(\d{3}[A-Z]?)/);
  if (m) return `${m[1]} ${m[2]}`;
  if (c.startsWith("FYS")) return "FYS";
  if (/Commons/.test(name)) return "PHYS 111 Commons";
  return c || name.slice(0, 14);
}
async function canvasGet(env, path, params = {}) {
  let url = `${env.CANVAS_BASE}/api/v1${path}?${new URLSearchParams(params)}`;
  const out = [];
  while (url) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${env.CANVAS_TOKEN}`, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) CommandCenter/1.0", accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9" } });
    if (r.status === 401) throw new Error("canvas_token_invalid");
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      const ray = r.headers.get("x-amz-cf-id") || r.headers.get("cf-ray") || "";
      throw new Error(`canvas_${r.status} via=${r.headers.get("via") || r.headers.get("server") || "?"} ${ray ? "id=" + ray : ""} body="${body}"`);
    }
    const data = await r.json();
    out.push(...(Array.isArray(data) ? data : [data]));
    const link = r.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}
async function getCanvas(env, force = false) {
  const cachedAny = await env.STATE.get("canvas:snapshot", "json");
  if (cachedAny && cachedAny.source === "ingest" && Date.now() - Date.parse(cachedAny.updatedAt) < 3 * 3600000) return cachedAny; // external runner owns the data
  if (!force && cachedAny && Date.now() - Date.parse(cachedAny.updatedAt) < CANVAS_CACHE_SECONDS * 1000) return cachedAny;
  if (!env.CANVAS_TOKEN) return { ok: false, error: "canvas_token_missing", items: [] };
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10) + "T00:00:00Z";
    const end = new Date(now.getTime() + 35 * 86400000).toISOString().slice(0, 10) + "T00:00:00Z";
    const courses = Object.fromEntries((await canvasGet(env, "/courses", { enrollment_state: "active", per_page: 100 })).map(c => [c.id, c]));
    const planner = await canvasGet(env, "/planner/items", { start_date: start, end_date: end, per_page: 100 });
    const GRADED = new Set(["assignment", "quiz", "discussion_topic", "wiki_page"]);
    const seen = new Set(), items = [];
    for (const it of planner) {
      if (!GRADED.has(it.plannable_type)) continue;
      const p = it.plannable || {}, s = it.submissions && typeof it.submissions === "object" ? it.submissions : {};
      const course = courses[it.course_id] || {};
      const id = `${it.plannable_type}-${p.id || it.plannable_id}`;
      if (seen.has(id)) continue; seen.add(id);
      items.push({
        id, type: it.plannable_type, courseId: it.course_id,
        course: shortCode(course.course_code, course.name), courseName: course.name || it.context_name,
        title: (p.title || "").trim(), dueAt: p.due_at || it.plannable_date, points: p.points_possible ?? null,
        submitted: !!s.submitted, graded: !!s.graded, excused: !!s.excused, late: !!s.late, missing: !!s.missing,
        url: env.CANVAS_BASE + (it.html_url || ""),
      });
    }
    items.sort((a, b) => (a.dueAt || "").localeCompare(b.dueAt || ""));
    const snap = { ok: true, updatedAt: now.toISOString(), items, counts: { open: items.filter(x => !x.submitted && !x.excused).length, submitted: items.filter(x => x.submitted).length } };
    await env.STATE.put("canvas:snapshot", JSON.stringify(snap));
    return snap;
  } catch (e) {
    const stale = await env.STATE.get("canvas:snapshot", "json");
    return { ok: false, error: String(e.message || e), items: stale?.items || [], updatedAt: stale?.updatedAt || null, stale: !!stale };
  }
}

/* ───────────────────────── state: dismissed + notes ───────────────────────── */

async function getState(env) {
  const ignored = (await env.STATE.get("state:ignored", "json")) || [];
  const notes = (await env.STATE.get("state:notes", "json")) || [];
  return { ignored, notes, google: !!(await env.STATE.get("google:refresh_token")), chat: !!env.ANTHROPIC_API_KEY };
}
async function postState(request, env) {
  const body = await request.json().catch(() => ({}));
  let ignored = (await env.STATE.get("state:ignored", "json")) || [];
  let notes = (await env.STATE.get("state:notes", "json")) || [];
  if (body.dismiss && !ignored.includes(String(body.dismiss))) ignored.push(String(body.dismiss));
  if (body.undismiss) ignored = ignored.filter(x => x !== String(body.undismiss));
  if (body.note && String(body.note).trim()) notes.unshift({ id: String(Date.now()), text: String(body.note).trim().slice(0, 500), createdAt: new Date().toISOString() });
  if (body.deleteNote) notes = notes.filter(n => n.id !== String(body.deleteNote));
  notes = notes.slice(0, 200);
  await env.STATE.put("state:ignored", JSON.stringify(ignored));
  await env.STATE.put("state:notes", JSON.stringify(notes));
  return json({ ignored, notes });
}

/* ───────────────────────── chat (optional) ───────────────────────── */

async function chat(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "chat_disabled" }, 501);
  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length) return json({ error: "no messages" }, 400);

  // Build the same DATA block the page used to send.
  const [canvas, cal, mail, state] = await Promise.all([getCanvas(env), getCalendar(env), getGmail(env), getState(env)]);
  const fmt = d => new Date(d).toLocaleString("en-US", { timeZone: env.TIMEZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const live = (canvas.items || []).filter(x => !state.ignored.includes(x.id) && !(x.type === "discussion_topic" && x.points == null) && !x.submitted && !x.excused).slice(0, 25);
  const data = [
    `NOW: ${fmt(now)} (${env.TIMEZONE})`,
    "\nCANVAS — open coursework (id | course | title | due | pts | state):",
    ...(live.length ? live.map(x => `  ${x.id} | ${x.course} | ${x.title} | ${x.dueAt ? fmt(x.dueAt) : "no due date"} | ${x.points ?? "-"} | ${x.dueAt && new Date(x.dueAt) < now ? "OVERDUE" : "open"}`) : ["  (nothing open)"]),
    "\nCALENDAR — next 3 days:",
    ...((cal.events || []).filter(e => e.start?.dateTime && new Date(e.start.dateTime) < new Date(now.getTime() + 3 * 86400000)).slice(0, 16).map(e => `  ${fmt(e.start.dateTime)} | ${e.summary}${e.location ? " | " + e.location : ""}`)),
    "\nINBOX — unread (from | subject):",
    ...((mail.threads || []).slice(0, 10).map(r => `  ${r.important ? "★ " : ""}${r.from} | ${r.subject}`)),
    "\nSAVED NOTES (newest first):",
    ...(state.notes.length ? state.notes.slice(0, 10).map(n => `  [${n.id}] ${n.text}`) : ["  (none yet)"]),
  ].join("\n");

  const system = `You are the voice of Jeremy's Command Center — the terse, capable assistant inside his heads-up display. Jeremy is an NJIT computer-science freshman speaking to you out loud.
STYLE: one to three short sentences, spoken-word friendly. Plain text only — no markdown, lists, emojis or headers. Say times like a person would. Lead with the answer.
TRUTH: the DATA block is the only source of facts. Never invent. If it isn't in the data, say so briefly. Times are ${env.TIMEZONE}.
ACTIONS: When he tells you something to remember (reminder, idea, to-do, plan) call save_note with a clean one-line version, then confirm briefly. When he says an item is done, fake, a glitch, or to hide/dismiss it, call dismiss_item with its exact id, then confirm. If ambiguous, ask one short question. Never call a tool for a plain question. Don't narrate tool use.

DATA:
${data}`;

  const tools = [
    { name: "save_note", description: "Save something Jeremy said for later (reminders, ideas, to-dos). Pass a clean one-line version.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "dismiss_item", description: "Hide a Canvas item from the dashboard because it's done, a glitch, or not real. Takes the exact item id from DATA.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ];

  let convo = messages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
  const actions = [];
  for (let round = 0; round < 4; round++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.CHAT_MODEL || "claude-haiku-4-5", max_tokens: 400, system, tools, messages: convo }),
    });
    const res = await r.json();
    if (!r.ok) return json({ error: res.error?.message || `anthropic_${r.status}` }, 502);
    const toolUses = (res.content || []).filter(b => b.type === "tool_use");
    const text = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (!toolUses.length) return json({ reply: text || "…", actions });
    // run tools, feed results back
    convo.push({ role: "assistant", content: res.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        if (tu.name === "save_note") { await postState(new Request("http://x", { method: "POST", body: JSON.stringify({ note: tu.input.text }) }), env); out = "saved"; actions.push({ type: "note", text: tu.input.text }); }
        else if (tu.name === "dismiss_item") {
          const item = (canvas.items || []).find(x => x.id === String(tu.input.id));
          if (!item) throw new Error(`no item with id ${tu.input.id}`);
          await postState(new Request("http://x", { method: "POST", body: JSON.stringify({ dismiss: item.id }) }), env);
          out = `dismissed: ${item.title} (${item.course})`; actions.push({ type: "dismiss", id: item.id, title: item.title });
        } else out = "unknown tool";
      } catch (e) { out = `Error: ${e.message}`; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(out) });
    }
    convo.push({ role: "user", content: results });
  }
  return json({ reply: "I did that.", actions });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

// named exports for tests
export { getCanvas, shortCode, getState, postState };
