/**
 * Command Center — standalone backend (Cloudflare Worker)
 *
 * One file, five jobs:
 *   1. Gate everything behind a PIN (signed cookie session)
 *   2. Google OAuth once, then read Calendar + Gmail with the stored refresh token
 *   3. Read Canvas (planner items with submission status), cached 10 min
 *   4. Keep small state: dismissed item ids + voice notes (KV)
 *   5. Chat: /api/chat → Cloudflare Workers AI (free daily allowance) with two tools (dismiss, note);
 *      the Anthropic API instead only if ANTHROPIC_API_KEY is set
 *
 * Routes
 *   GET  /login, POST /login, POST /logout
 *   GET  /auth/google  → Google consent   GET /auth/google/callback → stores refresh token
 *   GET  /api/canvas   GET /api/calendar   GET /api/gmail   GET /api/state
 *   POST /api/state    { dismiss?: id, note?: text, undismiss?: id, deleteNote?: id }
 *   POST /api/chat     { messages:[{role,content}] }  → { reply }
 *   GET  /api/quote?kind=verse|substack&n=<open count>  → { text, source, sub, url }
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
      if (path === "/auth/spotify") return spotifyAuthStart(url, env);
      if (path === "/auth/spotify/callback") return spotifyAuthCallback(url, env);
      if (path === "/auth/smartcar") return smartcarAuthStart(url, env);
      if (path === "/auth/smartcar/callback") return smartcarAuthCallback(url, env);

      if (path === "/api/canvas") return json(await getCanvas(env, url.searchParams.get("refresh") === "1"));
      if (path === "/api/calendar") return json(await getCalendar(env));
      if (path === "/api/gmail") return json(await getGmail(env));
      // Home coordinates for the weather live in the HOME_LATLON secret ("lat,lon"), never in the code.
      if (path === "/api/places") return json(placesFromEnv(env));
      if (path === "/api/state") return request.method === "POST" ? postState(request, env) : json(await getState(env));
      if (path === "/api/chat") return request.method === "POST" ? chat(request, env) : json({ error: "POST only" }, 405);
      if (path === "/api/commute") return json(await getCommute(env, url));
      if (path === "/api/spotify/now") return json(await spotifyNow(env));
      if (path === "/api/car") return json(await getCar(env, { onOpen: true }));
      if (path === "/api/quote") return json(await getQuote(env, url));
      if (path === "/api/spotify/control" && request.method === "POST") return json(await spotifyControl(request, env));

      // static dashboard
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: String(err && err.message || err) }, 500);
    }
  },

  // Cron (see wrangler.toml [triggers]): warm the Canvas cache so the app opens instantly, and read the car's battery
  // at its scheduled times (morning before the leave time, midday, evening, late night).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getCanvas(env, true).then(r => { if (r.ok) console.log(`canvas warm ok: ${r.items.length} items`); else console.error(`canvas warm failed: ${r.error}`); }).catch(() => {}));
    ctx.waitUntil(carCron(env).catch(e => console.error(`car cron: ${e.message || e}`)));
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
<title>Command Center</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#000000">
<link rel="apple-touch-icon" href="/icons/icon-180.png?v=2"><link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png?v=2">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Command Center"><meta name="apple-mobile-web-app-status-bar-style" content="black">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
  html,body{height:100%;margin:0;background:#000;color:#E6E6E6;font-family:"Geist",system-ui,sans-serif;display:grid;place-items:center}
  form{width:min(340px,88vw);display:flex;flex-direction:column;gap:14px}
  img{width:64px;height:64px;border-radius:14px;margin-bottom:6px}
  h1{margin:0;font-weight:600;font-size:28px;letter-spacing:-.04em;line-height:1}
  p{margin:0;font-family:"Geist Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.08em;color:#757575;text-transform:uppercase}
  input{width:100%;box-sizing:border-box;font:500 30px "Geist Mono",ui-monospace,monospace;letter-spacing:.45em;text-align:center;padding:12px 0 12px .45em;background:#000;border:1px solid #2E2E2E;color:#fff;outline:none}
  input:focus{border-color:#FF4D00}
  button{width:100%;padding:13px;font:500 12px "Geist Mono",ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;background:#E6E6E6;border:0;color:#000;cursor:pointer}
  button:hover{background:#FF4D00}
  .err{color:#FF4D4D;font-family:"Geist Mono",ui-monospace,monospace;font-size:12px}
</style></head><body>
<form method="post" action="/login" autocomplete="off">
  <img src="/icons/icon-180.png?v=2" alt="">
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

function placesFromEnv(env) {
  const [lat, lon] = String(env.HOME_LATLON || "").split(",").map(Number);
  return { home: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null };
}

async function getState(env) {
  const ignored = (await env.STATE.get("state:ignored", "json")) || [];
  const notes = (await env.STATE.get("state:notes", "json")) || [];
  return { ignored, notes, google: !!(await env.STATE.get("google:refresh_token")), chat: !!(env.ANTHROPIC_API_KEY || env.AI) };
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

/* ───────────────────────── chat ─────────────────────────
   Default: Cloudflare Workers AI (binding AI in wrangler.toml, model CHAT_AI_MODEL). Free up to 10,000 neurons a day; this
   Worker keeps its own count (KV "ai:neurons:YYYY-MM-DD") and stops at AI_DAILY_NEURONS (default 9,000) so it can never
   spill into paid usage. Past that, or if Workers AI refuses, the message is saved as a note and Talk says so.
   If ANTHROPIC_API_KEY is set, the Anthropic API is used instead (paid; off unless that secret exists). */
// neurons per million tokens, input / output (developers.cloudflare.com/workers-ai/platform/pricing, Sep 2026)
const AI_RATES = {
  "@cf/ibm-granite/granite-4.0-h-micro": [1542, 10158],
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/zai-org/glm-4.7-flash": [5500, 36400],
  "@cf/google/gemma-4-26b-a4b-it": [9091, 27273],
  "@cf/meta/llama-4-scout-17b-16e-instruct": [24545, 77273],
};
const AI_DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const OUT_OF_FREE = "Out of free answers for today — saved as a note.";

async function chat(request, env) {
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: "chat_disabled" }, 501);
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

  const actions = [];
  async function runTool(name, input) {
    try {
      if (name === "save_note") {
        const text = String(input?.text || "").trim(); if (!text) throw new Error("empty note");
        await postState(new Request("http://x", { method: "POST", body: JSON.stringify({ note: text }) }), env);
        actions.push({ type: "note", text }); return "saved";
      }
      if (name === "dismiss_item") {
        const item = (canvas.items || []).find(x => x.id === String(input?.id));
        if (!item) throw new Error(`no item with id ${input?.id}`);
        await postState(new Request("http://x", { method: "POST", body: JSON.stringify({ dismiss: item.id }) }), env);
        actions.push({ type: "dismiss", id: item.id, title: item.title }); return `dismissed: ${item.title} (${item.course})`;
      }
      return "unknown tool";
    } catch (e) { return `Error: ${e.message}`; }
  }
  if (!env.ANTHROPIC_API_KEY) return workersAiChat(env, system, messages, tools, runTool, actions);

  let convo = messages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
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
    for (const tu of toolUses) results.push({ type: "tool_result", tool_use_id: tu.id, content: String(await runTool(tu.name, tu.input)) });
    convo.push({ role: "user", content: results });
  }
  return json({ reply: "I did that.", actions });
}

/* ───────────────────────── live traffic: Google Routes API ─────────────────────────
   GET /api/commute?arrive=<ISO>  → when to leave home to be at NJIT by `arrive`, with traffic.
   GET /api/commute?home=<ISO>    → the drive home leaving NJIT at that time (one Google call, cached 12 h; the app
                                    asks once, about 20 min before the last class ends).
   Needs secrets GOOGLE_MAPS_KEY + HOME_ADDRESS (optional CAMPUS_ADDRESS, MAPS_MONTHLY_CAP).
   Traffic-aware requests are the "Compute Routes Pro" SKU: 5,000 free a month. Results are cached in KV
   (10 min when the drive is < 3 h away, 1 h when < 24 h, 3 h otherwise). Two counters stop calling Google:
   MAPS_DAILY_CAP (default 100 a day) and MAPS_MONTHLY_CAP (default 3000 a month). 100 × 31 days is still under the
   free 5,000, so the app can't run past the free tier. Past either cap it falls back to the fixed 45-minute drive. */
const CAMPUS_DEFAULT = "NJIT, 323 Dr Martin Luther King Jr Blvd, Newark, NJ 07102";
async function routeOnce(env, departAt, toHome) {
  const today = new Date().toISOString().slice(0, 10), ck = `maps:calls:${today.slice(0, 7)}`, dk = `maps:calls:day:${today}`;
  const used = Number(await env.STATE.get(ck)) || 0, cap = Number(env.MAPS_MONTHLY_CAP || 3000);
  const usedToday = Number(await env.STATE.get(dk)) || 0, dayCap = Number(env.MAPS_DAILY_CAP || 100);
  if (used >= cap) throw new Error("maps_cap_reached");
  if (usedToday >= dayCap) throw new Error("maps_daily_cap_reached");
  const home = { address: env.HOME_ADDRESS }, campus = { address: env.CAMPUS_ADDRESS || CAMPUS_DEFAULT };
  const body = { origin: toHome ? campus : home, destination: toHome ? home : campus,
    travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE_OPTIMAL", trafficModel: "BEST_GUESS" };
  if (departAt && departAt.getTime() > Date.now() + 60000) body.departureTime = departAt.toISOString();
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GOOGLE_MAPS_KEY, "x-goog-fieldmask": "routes.duration,routes.staticDuration,routes.distanceMeters" },
    body: JSON.stringify(body),
  });
  await env.STATE.put(ck, String(used + 1), { expirationTtl: 40 * 86400 });
  await env.STATE.put(dk, String(usedToday + 1), { expirationTtl: 2 * 86400 });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.routes || !j.routes[0]) throw new Error(`maps_${r.status}${j.error && j.error.status ? "_" + j.error.status : ""}`);
  const sec = s => Number(String(s || "0").replace("s", "")) || 0;
  return { sec: sec(j.routes[0].duration), staticSec: sec(j.routes[0].staticDuration), distanceMi: j.routes[0].distanceMeters ? Math.round(j.routes[0].distanceMeters / 160.934) / 10 : null };
}
async function getDriveHome(env, iso) {
  const leave = new Date(iso || "");
  if (isNaN(leave)) return { ok: false, error: "bad_home" };
  if (Math.abs(leave.getTime() - Date.now()) > 6 * 3600e3) return { ok: false, error: "too_far" };
  const key = `commute:home:${leave.toISOString().slice(0, 16)}`;
  const cached = await env.STATE.get(key, "json");
  if (cached) return Object.assign(cached, { cached: true });
  try {
    const r = await routeOnce(env, leave, true);   // departs at `leave` if that's still ahead, otherwise right now
    const out = { ok: true, home: true, departAt: leave.toISOString(), durationMin: Math.round(r.sec / 60), staticMin: Math.round(r.staticSec / 60), distanceMi: r.distanceMi, checkedAt: new Date().toISOString() };
    out.ratio = out.staticMin ? +(out.durationMin / out.staticMin).toFixed(2) : 1;
    await env.STATE.put(key, JSON.stringify(out), { expirationTtl: 12 * 3600 });
    return out;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function getCommute(env, url) {
  if (!env.GOOGLE_MAPS_KEY || !env.HOME_ADDRESS) return { ok: false, error: "maps_not_configured" };
  if (url.searchParams.has("home")) return getDriveHome(env, url.searchParams.get("home"));
  const arrive = new Date(url.searchParams.get("arrive") || "");
  if (isNaN(arrive)) return { ok: false, error: "bad_arrive" };
  const ahead = arrive.getTime() - Date.now();
  if (ahead > 48 * 3600e3) return { ok: false, error: "too_far_ahead" };
  const key = `commute:${arrive.toISOString().slice(0, 16)}`;
  const cached = await env.STATE.get(key, "json");
  if (cached) return Object.assign(cached, { cached: true });
  try {
    // Google can't route "arrive by" for driving, so guess a departure, ask, and correct once.
    let r = await routeOnce(env, new Date(arrive.getTime() - 45 * 60e3));
    let depart = new Date(arrive.getTime() - r.sec * 1000);
    if (depart.getTime() > Date.now()) { r = await routeOnce(env, depart); depart = new Date(arrive.getTime() - r.sec * 1000); }
    let out;
    if (depart.getTime() <= Date.now()) {            // past the leave time already: how long from right now?
      const n = await routeOnce(env, null);
      out = { ok: true, late: true, etaAt: new Date(Date.now() + n.sec * 1000).toISOString(), durationMin: Math.round(n.sec / 60), staticMin: Math.round(n.staticSec / 60), distanceMi: n.distanceMi };
    } else {
      out = { ok: true, late: false, departAt: depart.toISOString(), durationMin: Math.round(r.sec / 60), staticMin: Math.round(r.staticSec / 60), distanceMi: r.distanceMi };
    }
    out.ratio = out.staticMin ? +(out.durationMin / out.staticMin).toFixed(2) : 1;
    out.arriveBy = arrive.toISOString(); out.checkedAt = new Date().toISOString();
    const ttl = ahead < 3 * 3600e3 ? 600 : ahead < 24 * 3600e3 ? 3600 : 10800;
    await env.STATE.put(key, JSON.stringify(out), { expirationTtl: ttl });
    return out;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ───────────────────────── Spotify ─────────────────────────
   Secrets SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (developer.spotify.com app, redirect URI
   <origin>/auth/spotify/callback). Dev-mode apps need the owner to have Premium (Feb 2026 rules);
   play/pause/skip need Premium too. Refresh token lives in KV "spotify:refresh_token". */
const SPOTIFY_SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify";
async function spotifyAuthStart(url, env) {
  if (!env.SPOTIFY_CLIENT_ID) return html("<p>SPOTIFY_CLIENT_ID secret is not set yet.</p>", 500);
  const state = crypto.randomUUID();
  await env.STATE.put(`spotify:state:${state}`, "1", { expirationTtl: 600 });
  const q = new URLSearchParams({ response_type: "code", client_id: env.SPOTIFY_CLIENT_ID, scope: SPOTIFY_SCOPES, redirect_uri: `${url.origin}/auth/spotify/callback`, state });
  return Response.redirect(`https://accounts.spotify.com/authorize?${q}`, 302);
}
async function spotifyAuthCallback(url, env) {
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code) return html(`<p>Spotify returned no code: ${escapeHtml(url.searchParams.get("error") || "unknown")}</p>`, 400);
  if (!state || !(await env.STATE.get(`spotify:state:${state}`))) return html("<p>That sign-in link expired. Go back and tap Connect Spotify again.</p>", 400);
  await env.STATE.delete(`spotify:state:${state}`);
  const tok = await spotifyToken(env, { grant_type: "authorization_code", code, redirect_uri: `${url.origin}/auth/spotify/callback` });
  if (!tok.refresh_token) return html(`<p>Spotify sign-in failed.</p><pre>${escapeHtml(JSON.stringify(tok, null, 1))}</pre>`, 400);
  await env.STATE.put("spotify:refresh_token", tok.refresh_token);
  await env.STATE.put("spotify:access", JSON.stringify({ token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 }));
  return Response.redirect(`${url.origin}/?connected=spotify`, 302);
}
async function spotifyToken(env, params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`) },
    body: new URLSearchParams(params),
  });
  return r.json().catch(() => ({}));
}
async function spotifyAccess(env) {
  const c = JSON.parse((await env.STATE.get("spotify:access")) || "null");
  if (c && c.exp > Date.now()) return c.token;
  const refresh = await env.STATE.get("spotify:refresh_token");
  if (!refresh) return null;
  const tok = await spotifyToken(env, { grant_type: "refresh_token", refresh_token: refresh });
  if (!tok.access_token) return null;
  if (tok.refresh_token) await env.STATE.put("spotify:refresh_token", tok.refresh_token);
  await env.STATE.put("spotify:access", JSON.stringify({ token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 }));
  return tok.access_token;
}
async function sfetch(env, path, opts = {}) {
  const t = await spotifyAccess(env);
  if (!t) throw new Error("spotify_not_connected");
  return fetch(`https://api.spotify.com/v1${path}`, Object.assign({}, opts, { headers: Object.assign({ authorization: `Bearer ${t}` }, opts.headers || {}) }));
}
async function spotifyNow(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return { ok: false, error: "spotify_not_configured" };
  if (!(await env.STATE.get("spotify:refresh_token"))) return { ok: false, error: "spotify_not_connected" };
  try {
    const r = await sfetch(env, "/me/player?additional_types=episode");
    if (r.status === 204) return { ok: true, item: null };
    if (r.status === 401) { await env.STATE.delete("spotify:access"); return { ok: false, error: "spotify_auth" }; }
    if (!r.ok) return { ok: false, error: `spotify_${r.status}` };
    const p = await r.json(), it = p.item;
    if (!it) return { ok: true, item: null, isPlaying: !!p.is_playing };
    const imgs = (it.album && it.album.images) || it.images || (it.show && it.show.images) || [];
    const art = (imgs.slice().sort((a, b) => (a.width || 0) - (b.width || 0)).find(i => (i.width || 0) >= 120) || imgs[0] || {}).url || "";
    let liked = null;
    if (it.uri) {
      const lk = `spotify:liked:${it.uri}`, c = await env.STATE.get(lk);
      if (c !== null) liked = c === "1";
      else {
        const cr = await sfetch(env, `/me/library/contains?uris=${encodeURIComponent(it.uri)}`);
        if (cr.ok) { const a = await cr.json(); liked = !!a[0]; await env.STATE.put(lk, liked ? "1" : "0", { expirationTtl: 600 }); }
      }
    }
    return {
      ok: true, isPlaying: !!p.is_playing, progressMs: p.progress_ms || 0, liked,
      item: { title: it.name, artists: (it.artists || []).map(a => a.name).join(", ") || (it.show && it.show.name) || "", album: (it.album && it.album.name) || "", art, uri: it.uri, durationMs: it.duration_ms || 0, url: (it.external_urls && it.external_urls.spotify) || "" },
      device: p.device ? { name: p.device.name, type: p.device.type, volume: p.device.volume_percent, canVolume: !!p.device.supports_volume } : null,
    };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function spotifyControl(request, env) {
  const { action, uri, value } = await request.json().catch(() => ({}));
  const map = { play: ["PUT", "/me/player/play"], pause: ["PUT", "/me/player/pause"], next: ["POST", "/me/player/next"], previous: ["POST", "/me/player/previous"] };
  try {
    if (action === "like" || action === "unlike") {
      if (!uri) return { ok: false, error: "no_track" };
      const r = await sfetch(env, `/me/library?uris=${encodeURIComponent(uri)}`, { method: action === "like" ? "PUT" : "DELETE" });
      if (r.ok) await env.STATE.put(`spotify:liked:${uri}`, action === "like" ? "1" : "0", { expirationTtl: 600 });
      return { ok: r.ok, status: r.status };
    }
    if (action === "volume") {
      const v = Math.max(0, Math.min(100, Math.round(Number(value))));
      if (!isFinite(v)) return { ok: false, error: "bad_volume" };
      const r = await sfetch(env, `/me/player/volume?volume_percent=${v}`, { method: "PUT" });
      if (r.status === 403) return { ok: false, error: "premium_required" };
      if (r.status === 404) return { ok: false, error: "no_active_device" };
      return { ok: r.ok, status: r.status };
    }
    const m = map[action];
    if (!m) return { ok: false, error: "bad_action" };
    const playOne = action === "play" && typeof value === "string" && /^spotify:(track|episode):[A-Za-z0-9]+$/.test(value);   // library list: start this song
    const r = await sfetch(env, m[1], playOne ? { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ uris: [value] }) } : { method: m[0] });
    if (r.status === 403) return { ok: false, error: "premium_required" };
    if (r.status === 404) return { ok: false, error: "no_active_device" };
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* Workers AI path: OpenAI-style messages + tools; up to 3 rounds of tool calls. Counts neurons from the reported token
   usage (or a length estimate) against the daily budget before and after each call. */
async function workersAiChat(env, system, messages, tools, runTool, actions) {
  const model = env.CHAT_AI_MODEL || AI_DEFAULT_MODEL, rate = AI_RATES[model] || [30000, 100000];
  const budget = Number(env.AI_DAILY_NEURONS || 9000), day = new Date().toISOString().slice(0, 10), key = `ai:neurons:${day}`;
  const lastUser = String([...messages].reverse().find(m => m.role !== "assistant")?.content || "").trim();
  async function outOfFree() {
    if (lastUser) { await postState(new Request("http://x", { method: "POST", body: JSON.stringify({ note: lastUser }) }), env); actions.push({ type: "note", text: lastUser }); }
    return json({ reply: OUT_OF_FREE, actions, limited: true });
  }
  let used = Number(await env.STATE.get(key)) || 0;
  if (used >= budget) return outOfFree();
  const oaTools = tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const convo = [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }))];
  const clean = t => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
  for (let round = 0; round < 3; round++) {
    let res;
    try { res = await env.AI.run(model, { messages: convo, tools: oaTools, max_tokens: 700, temperature: 0.3 }); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (/neuron|allocation|4006|quota|limit|capacity exceeded/i.test(msg)) return outOfFree();
      return json({ error: `workers_ai: ${msg.slice(0, 160)}` }, 502);
    }
    const msgOut = res?.choices?.[0]?.message || {};
    const u = res?.usage || {}, inTok = u.prompt_tokens ?? Math.ceil(JSON.stringify(convo).length / 4), outTok = u.completion_tokens ?? Math.ceil(JSON.stringify(res || "").length / 4);
    used += (inTok * rate[0] + outTok * rate[1]) / 1e6;
    await env.STATE.put(key, String(Math.round(used * 10) / 10), { expirationTtl: 3 * 86400 });
    const calls = (res?.tool_calls || msgOut.tool_calls || []).map((c, i) => {
      const fn = c.function || c; let args = fn.arguments ?? c.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { args = {}; } }
      return { id: c.id || `call_${round}_${i}`, name: fn.name || c.name, args };
    }).filter(c => c.name);
    const text = clean(res?.response ?? msgOut.content ?? "");
    if (!calls.length) return json({ reply: text || "…", actions, model, neuronsToday: Math.round(used) });
    convo.push({ role: "assistant", content: "", tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    for (const c of calls) convo.push({ role: "tool", tool_call_id: c.id, name: c.name, content: String(await runTool(c.name, c.args)) });
    if (used >= budget) return json({ reply: actions.length ? "Done." : OUT_OF_FREE, actions, limited: true });
  }
  return json({ reply: "Done.", actions, model, neuronsToday: Math.round(used) });
}

/* ───────────────────────── the car (Smartcar API v3, read-only) ─────────────────────────
   Battery % and range for one vehicle (BMW i4), from the two signals the free plan allows:
   tractionbattery-stateofcharge and tractionbattery-range. Nothing here sends commands to the car.
   Auth (v3): the owner connects once through Smartcar Connect (/auth/smartcar); the redirect carries a user_id, which we keep
   in KV with the vehicle id from /v3/connections. Each read uses an app token from the client-credentials flow (1 hour,
   cached in KV, re-requested when it runs out — there is no per-user token to refresh).
   Budget: a check is 2 signal requests. At most ~4 scheduled checks a day (carCron) plus one when the app opens and the
   last reading is 3+ hours old; hard caps SMARTCAR_DAILY_CAP checks a day (default 6) and SMARTCAR_MONTHLY_CAP requests
   a month (default 360, under the free plan's per-vehicle monthly allowance). Smartcar refuses (430 VEHICLE_REQUEST_LIMIT)
   rather than bills when a plan limit is hit; if that ever comes back we stop asking until next month.
   Connect uses SMARTCAR_APPLICATION_ID (a [var], not secret); the app token uses the secrets SMARTCAR_CLIENT_ID and
   SMARTCAR_CLIENT_SECRET. Optional: SMARTCAR_DAILY_CAP, SMARTCAR_MONTHLY_CAP, CAR_MIN_PERCENT (default 60). */
const SC_API = "https://vehicle.api.smartcar.com/v3";
const SC_SIGNALS = { percent: "tractionbattery-stateofcharge", range: "tractionbattery-range" };
function etNow(d = new Date(), tz = "America/New_York") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
async function smartcarAuthStart(url, env) {
  if (!env.SMARTCAR_APPLICATION_ID) return html("<p>SMARTCAR_APPLICATION_ID isn't set in wrangler.toml.</p>", 500);
  const state = crypto.randomUUID();
  await env.STATE.put(`smartcar:state:${state}`, "1", { expirationTtl: 600 });
  // Connect takes the Application ID (Configuration → Application details), not the API client id
  const q = new URLSearchParams({ application_id: env.SMARTCAR_APPLICATION_ID, response_type: "code", redirect_uri: `${url.origin}/auth/smartcar/callback`, scope: "read_battery", make: "BMW", state });
  return Response.redirect(`https://connect.smartcar.com/oauth/authorize?${q}`, 302);
}
async function smartcarAuthCallback(url, env) {
  const state = url.searchParams.get("state");
  if (!state || !(await env.STATE.get(`smartcar:state:${state}`))) return html("<p>That sign-in link expired. Go back and tap Connect BMW again.</p>", 400);
  await env.STATE.delete(`smartcar:state:${state}`);
  if (url.searchParams.get("error")) return html(`<p>Smartcar didn't connect: ${escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error"))}</p><p><a href="/">Back to Command Center</a></p>`, 400);
  try {
    const found = await smartcarFindVehicle(env, url.searchParams.get("user_id"));
    if (!found) return html("<p>Connected, but Smartcar didn't list a vehicle yet. Try Connect BMW again in a minute.</p>", 502);
    await env.STATE.put("smartcar:vehicle", JSON.stringify(found));
    await env.STATE.delete("car:reading");
    await getCar(env, { force: true });                       // first reading right away (counts toward the caps)
  } catch (e) { return html(`<p>Couldn't finish connecting: ${escapeHtml(String(e.message || e))}</p>`, 502); }
  return Response.redirect(`${url.origin}/?connected=smartcar`, 302);
}
async function smartcarToken(env) {
  const c = await env.STATE.get("smartcar:app_token", "json");
  if (c && c.exp > Date.now()) return c.token;
  const r = await fetch("https://iam.smartcar.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "command-center/1.0" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.SMARTCAR_CLIENT_ID, client_secret: env.SMARTCAR_CLIENT_SECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`smartcar_token_${r.status}`);
  await env.STATE.put("smartcar:app_token", JSON.stringify({ token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 }), { expirationTtl: Math.max(60, (j.expires_in || 3600) - 60) });
  return j.access_token;
}
async function smartcarFindVehicle(env, userId) {                // one call to /connections at connect time
  const q = new URLSearchParams({ "filter[vehicle.mode]": "live", "page[size]": "10" });
  if (userId) q.set("filter[userId]", userId);
  const r = await fetch(`${SC_API}/connections?${q}`, { headers: { authorization: `Bearer ${await smartcarToken(env)}`, "user-agent": "command-center/1.0" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`smartcar_connections_${r.status}`);
  const c = (j.data || [])[0]; if (!c) return null;
  const v = c.attributes?.vehicle || {};
  return { vehicleId: c.relationships?.vehicle?.data?.id, userId: userId || c.relationships?.user?.data?.id || c.attributes?.user?.id, make: v.make || "", model: v.model || "", year: v.year || null };
}
async function smartcarSignal(env, veh, code) {
  const r = await fetch(`${SC_API}/vehicles/${encodeURIComponent(veh.vehicleId)}/signals/${code}`, {
    headers: { authorization: `Bearer ${await smartcarToken(env)}`, "sc-user-id": veh.userId, "user-agent": "command-center/1.0" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.code || j.type || `smartcar_${r.status}`); e.status = r.status; throw e; }
  const a = j.data?.attributes || {};
  if (a.status && a.status.value && a.status.value !== "SUCCESS") throw new Error(`signal_${a.status.value}`);
  return { body: a.body || {}, at: j.data?.meta?.oemUpdatedAt || j.data?.meta?.retrievedAt || new Date().toISOString() };
}
// the one place that decides whether we may ask the car right now
async function carAllowance(env) {
  const t = etNow(new Date(), env.TIMEZONE), dayCap = Number(env.SMARTCAR_DAILY_CAP || 6), monthCap = Number(env.SMARTCAR_MONTHLY_CAP || 360);
  const checks = Number(await env.STATE.get(`car:checks:${t.day}`)) || 0, reqs = Number(await env.STATE.get(`car:req:${t.month}`)) || 0;
  if (await env.STATE.get(`car:blocked:${t.month}`)) return { ok: false, why: "plan_limit" };
  if (checks >= dayCap) return { ok: false, why: "daily_cap" };
  if (reqs + 2 > monthCap) return { ok: false, why: "monthly_cap" };
  return { ok: true, t, checks, reqs };
}
async function getCar(env, opt = {}) {
  if (!env.SMARTCAR_CLIENT_ID || !env.SMARTCAR_CLIENT_SECRET) return { ok: false, error: "smartcar_not_configured" };
  const veh = await env.STATE.get("smartcar:vehicle", "json");
  if (!veh || !veh.vehicleId) return { ok: false, error: "smartcar_not_connected" };
  const minPercent = Number(env.CAR_MIN_PERCENT || 60);
  const last = await env.STATE.get("car:reading", "json");
  const age = last ? Date.now() - Date.parse(last.checkedAt) : Infinity;
  const want = opt.force || (opt.onOpen && age >= 3 * 3600e3) || opt.scheduled;
  const out = r => Object.assign({ ok: true, minPercent, model: [veh.year, veh.make, veh.model].filter(Boolean).join(" ") }, r);
  if (!want) return last ? out(last) : out({ percent: null, rangeMi: null, checkedAt: null, charging: false });
  const al = await carAllowance(env);
  if (!al.ok) return last ? out(Object.assign({}, last, { held: al.why })) : out({ percent: null, rangeMi: null, checkedAt: null, charging: false, held: al.why });
  if (await env.STATE.get("car:busy")) return last ? out(last) : out({ percent: null, rangeMi: null, checkedAt: null, charging: false });
  await env.STATE.put("car:busy", "1", { expirationTtl: 60 });   // one check at a time
  await env.STATE.put(`car:checks:${al.t.day}`, String(al.checks + 1), { expirationTtl: 3 * 86400 });
  let sent = 0;
  try {
    sent++; const soc = await smartcarSignal(env, veh, SC_SIGNALS.percent);
    sent++; const rng = await smartcarSignal(env, veh, SC_SIGNALS.range);
    const percent = Math.round(Number(soc.body.value));
    const unit = String(rng.body.unit || "km").toLowerCase(), rv = Number(rng.body.value);
    const rangeMi = isFinite(rv) ? Math.round(/mi/.test(unit) ? rv : rv / 1.609344) : null;
    // "charging": the % went up since the last reading (the charging-status signal is a paid one, so we infer it)
    const charging = !!(last && last.percent != null && percent > last.percent);
    const reading = { percent: isFinite(percent) ? percent : null, rangeMi, checkedAt: new Date().toISOString(), oemAt: soc.at, charging, prevPercent: last ? last.percent : null };
    await env.STATE.put("car:reading", JSON.stringify(reading));
    return out(reading);
  } catch (e) {
    if (e.status === 430 || /VEHICLE_REQUEST_LIMIT|INVALID_PLAN/.test(e.message)) await env.STATE.put(`car:blocked:${al.t.month}`, e.message, { expirationTtl: 32 * 86400 });
    return last ? out(Object.assign({}, last, { error: String(e.message || e) })) : { ok: false, error: String(e.message || e), minPercent };
  } finally {
    await env.STATE.put(`car:req:${al.t.month}`, String(al.reqs + sent), { expirationTtl: 40 * 86400 });
    await env.STATE.delete("car:busy");
  }
}
// scheduled reads: morning (30 min before today's leave time, from the calendar; 8:00 when there's no class),
// 12:30, 18:30 and 22:30 Eastern. Each slot runs once, within an hour of its time.
async function carCron(env) {
  if (!env.SMARTCAR_CLIENT_ID || !(await env.STATE.get("smartcar:vehicle"))) return;
  const t = etNow(new Date(), env.TIMEZONE);
  let morning = Number(await env.STATE.get(`car:morning:${t.day}`));
  if (!morning && t.min >= 4 * 60) {                               // work out today's morning slot once
    morning = 8 * 60;
    try {
      const cal = await getCalendar(env), toMin = d => etNow(new Date(d), env.TIMEZONE);
      const first = (cal.events || []).filter(e => e.start?.dateTime && e.status !== "cancelled" && /NJIT/i.test(e.location || "") && !/zoom|virtual|online/i.test(e.location || ""))
        .map(e => toMin(e.start.dateTime)).filter(x => x.day === t.day).sort((a, b) => a.min - b.min)[0];
      if (first) morning = Math.max(5 * 60, first.min - 55 - 30);  // leave = class − 45 min drive − 10 min buffer; check 30 min before that
    } catch {}
    await env.STATE.put(`car:morning:${t.day}`, String(morning), { expirationTtl: 2 * 86400 });
  }
  for (const [name, at] of [["morning", morning], ["midday", 750], ["evening", 1110], ["late", 1350]]) {
    const from = name === "morning" ? at - 30 : at;               // cron ticks every 30 min: take the tick just before the morning slot
    if (!at || t.min < from || t.min >= from + 60) continue;
    const k = `car:slot:${t.day}:${name}`;
    if (await env.STATE.get(k)) continue;
    await env.STATE.put(k, "1", { expirationTtl: 2 * 86400 });
    const r = await getCar(env, { scheduled: true });
    console.log(`car ${name}: ${r.percent ?? "-"}% ${r.rangeMi ?? "-"} mi${r.held ? " (held: " + r.held + ")" : ""}${r.error ? " (" + r.error + ")" : ""}`);
  }
}

/* ───────────────────────── quote: a Bible verse or a line from a Substack post ─────────────────────────
   The front end alternates kinds each time the app opens. Verses: a fixed list of references, text from
   bible-api.com (World English Bible, public domain), cached in KV for good. Substack: there's no public API for
   the "For You" feed, so the pool is recent posts from the publications you subscribe to (SUBSTACK_HANDLE's
   public profile) plus any feeds in SUBSTACK_FEEDS, refreshed every 6 h. Two filters keep the lines spiritual,
   theological or philosophical: SUBSTACK_ALLOW (only those publications are read) and SPIRITUAL_WORDS (a post
   is skipped unless its title, subtitle or categories mention one). Nothing survives, or anything fails: a verse. */
const VERSES = [
  "Psalm 46:1", "Joshua 1:9", "Isaiah 40:31", "Proverbs 3:5-6", "Philippians 4:6-7", "Romans 8:28", "Matthew 6:34",
  "Lamentations 3:22-23", "2 Timothy 1:7", "Psalm 23:1-3", "Colossians 3:23", "Isaiah 41:10", "Micah 6:8",
  "James 1:5", "Psalm 118:24", "Matthew 11:28-29", "Romans 12:2", "Galatians 6:9", "Psalm 121:1-2", "John 16:33",
  "Proverbs 16:3", "Hebrews 12:1", "1 Corinthians 16:13-14", "Psalm 37:5", "Ecclesiastes 3:1", "John 14:27",
  "Philippians 4:13", "Isaiah 26:3", "Psalm 90:12", "1 Peter 5:7", "Jeremiah 29:11", "Psalm 16:8",
  "Deuteronomy 31:6", "Psalm 27:1", "Psalm 34:18", "Psalm 55:22", "Psalm 62:1-2", "Psalm 73:26", "Psalm 91:1-2",
  "Psalm 119:105", "Psalm 139:14", "Psalm 143:8", "Psalm 145:18", "Psalm 147:3", "Psalm 19:14", "Psalm 32:8",
  "Psalm 37:4", "Psalm 51:10", "Psalm 56:3", "Psalm 84:11", "Psalm 103:2-4", "Psalm 127:1", "Psalm 130:5",
  "Proverbs 4:23", "Proverbs 9:10", "Proverbs 11:2", "Proverbs 12:25", "Proverbs 15:1", "Proverbs 16:9",
  "Proverbs 17:17", "Proverbs 18:10", "Proverbs 19:21", "Proverbs 22:1", "Proverbs 27:17", "Ecclesiastes 4:9-10",
  "Ecclesiastes 9:10", "Isaiah 30:15", "Isaiah 40:28-29", "Isaiah 43:2", "Isaiah 43:18-19", "Isaiah 55:8-9",
  "Isaiah 58:11", "Jeremiah 17:7-8", "Zephaniah 3:17", "Habakkuk 3:19", "Nahum 1:7", "Exodus 14:14",
  "Numbers 6:24-26", "1 Samuel 16:7", "2 Chronicles 15:7", "Nehemiah 8:10", "Matthew 5:14-16", "Matthew 5:9",
  "Matthew 6:33", "Matthew 7:7", "Matthew 19:26", "Matthew 28:20", "Mark 9:23", "Mark 10:27", "Luke 1:37",
  "Luke 6:31", "Luke 12:25", "John 1:5", "John 8:12", "John 10:10", "John 13:34-35", "John 14:1", "John 15:5",
  "Acts 20:35", "Romans 5:3-4", "Romans 8:38-39", "Romans 12:12", "Romans 15:13", "1 Corinthians 10:13",
  "1 Corinthians 13:4-7", "1 Corinthians 15:58", "2 Corinthians 4:16-18", "2 Corinthians 5:7", "2 Corinthians 12:9",
  "Galatians 5:22-23", "Ephesians 2:10", "Ephesians 3:20", "Ephesians 4:32", "Ephesians 6:10", "Philippians 1:6",
  "Philippians 3:13-14", "Philippians 4:8", "Colossians 3:12-14", "Colossians 3:15", "1 Thessalonians 5:16-18",
  "2 Thessalonians 3:13", "1 Timothy 4:12", "2 Timothy 4:7", "Hebrews 10:23", "Hebrews 11:1", "Hebrews 13:8",
  "James 1:2-4", "James 1:12", "James 1:19", "1 Peter 4:10", "1 Peter 5:10", "2 Peter 3:9", "1 John 4:18",
  "1 John 4:19", "Revelation 21:4",
];
const VERSE_FALLBACK = [
  { source: "Psalm 46:1", text: "God is our refuge and strength, a very present help in trouble." },
  { source: "Philippians 4:13", text: "I can do all things through Christ, who strengthens me." },
];
const SUBSTACK_TTL = 6 * 3600e3;
const SUBSTACK_POOL_KEY = "substack:pool:v2";   // bumped when the filters change so an old pool is not reused
const UA = { "user-agent": "Mozilla/5.0 (compatible; CommandCenter/1.0; personal dashboard)" };
// A Substack post makes the pool only if its title, subtitle or RSS categories contain one of these. Each entry
// matches at the start of a word, so "pray" also matches prayer and praying. Add or remove words freely.
const SPIRITUAL_WORDS = [
  "god", "christ", "jesus", "lord", "holy", "spirit", "sacred", "divine", "eternal", "heaven", "soul", "grace", "mercy",
  "faith", "pray", "worship", "fasting", "fasted", "liturg", "vigil", "rosary", "psalm", "scripture", "bible", "gospel", "apostol",
  "theolog", "church", "saint", "st.", "orthodox", "catholic", "coptic", "monk", "monaster", "trinity", "incarnat",
  "resurrect", "creation", "creator", "repent", "forgiv", "sins", "sinner", "sinned", "sinful", "devil", "angel",
  "suffer", "virtue", "evangel", "our lady", "mother of god", "fatima",
  "philosoph", "stoic", "ethic", "meaning", "wisdom", "contemplat", "socrates", "plato", "aristotle", "augustine",
  "aquinas", "chesterton", "lewis",
];
const SPIRITUAL_RX = new RegExp("\\b(?:" + SPIRITUAL_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");
const onTopic = s => SPIRITUAL_RX.test(s);

async function getQuote(env, url) {
  const n = Math.max(0, parseInt(url.searchParams.get("n") || "0", 10) || 0);
  if (url.searchParams.get("kind") === "substack") {
    const q = await substackQuote(env).catch(e => { console.error(`substack: ${e.message || e}`); return null; });
    if (q) return { ok: true, kind: "substack", ...q };
  }
  return { ok: true, kind: "verse", ...(await verseQuote(env, n)) };
}

async function verseQuote(env, n) {
  const ref = VERSES[Math.floor(Math.random() * VERSES.length)];
  const key = `quote:verse:${ref}`;
  const cached = await env.STATE.get(key, "json");
  if (cached) return cached;
  try {
    const r = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=web`, { headers: UA });
    if (r.ok) {
      const d = await r.json();
      const text = String(d.text || "").replace(/\s+/g, " ").trim();
      if (text) {
        const v = { text, source: ref, sub: "WEB", url: `https://www.biblegateway.com/passage/?search=${encodeURIComponent(ref)}&version=WEB` };
        await env.STATE.put(key, JSON.stringify(v));
        return v;
      }
    }
  } catch (e) {}
  const f = VERSE_FALLBACK[n % VERSE_FALLBACK.length];
  return { ...f, sub: "WEB", url: "" };
}

async function substackQuote(env) {
  let pool = await env.STATE.get(SUBSTACK_POOL_KEY, "json");
  if (!pool || Date.now() - pool.at > SUBSTACK_TTL) {
    const fresh = await buildSubstackPool(env);
    if (fresh.quotes.length || !pool) { pool = fresh; await env.STATE.put(SUBSTACK_POOL_KEY, JSON.stringify(pool)); }
  }
  if (!pool.quotes.length) return null;
  // don't show the same line twice in a row
  const last = await env.STATE.get("substack:last");
  const others = pool.quotes.filter(q => q.text !== last), choices = others.length ? others : pool.quotes;
  const q = choices[Math.floor(Math.random() * choices.length)];
  await env.STATE.put("substack:last", q.text);
  return q;
}

async function substackFeeds(env) {
  const feeds = new Set();
  const toFeed = s => {
    s = s.trim(); if (!s) return null;
    if (!/^https?:\/\//.test(s)) s = s.includes(".") ? `https://${s}` : `https://${s}.substack.com`;
    return /\/feed\/?$/.test(s) ? s : s.replace(/\/+$/, "") + "/feed";
  };
  for (const s of String(env.SUBSTACK_FEEDS || "").split(/[\s,]+/)) { const f = toFeed(s); if (f) feeds.add(f); }
  // SUBSTACK_ALLOW set: read only those publications and skip the profile's subscriptions altogether.
  const allow = String(env.SUBSTACK_ALLOW || "").split(/[\s,]+/).map(toFeed).filter(Boolean);
  for (const f of allow) feeds.add(f);
  const handle = allow.length ? "" : String(env.SUBSTACK_HANDLE || "").replace(/^@/, "").trim();
  if (handle) {
    try {
      const r = await fetch(`https://substack.com/api/v1/user/${encodeURIComponent(handle)}/public_profile`, { headers: UA });
      if (r.ok) {
        const p = await r.json();
        for (const sub of p.subscriptions || []) {
          const pub = sub.publication || {};
          const f = pub.subdomain ? toFeed(pub.subdomain) : pub.custom_domain ? toFeed(pub.custom_domain) : null;
          if (f) feeds.add(f);
        }
      } else console.error(`substack profile ${handle}: HTTP ${r.status}`);
    } catch (e) { console.error(`substack profile: ${e.message || e}`); }
  }
  return [...feeds].sort(() => Math.random() - 0.5).slice(0, 15);   // keep each refresh to 16 requests at most
}

async function buildSubstackPool(env) {
  const feeds = await substackFeeds(env);
  const monthAgo = Date.now() - 30 * 86400e3;
  const lists = await Promise.all(feeds.map(async f => {
    try {
      const r = await fetch(f, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      const xml = await r.text();
      const pubName = decodeEntities(stripCdata((xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1] || ""));
      const out = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const it = m[1], tag = t => stripCdata((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "");
        const date = Date.parse(tag("pubDate"));
        if (date && date < monthAgo) continue;
        const title = decodeEntities(tag("title")), subtitle = decodeEntities(tag("description"));
        const cats = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map(c => decodeEntities(stripCdata(c[1]))).join(" ");
        if (!onTopic(`${title} ${subtitle} ${cats}`)) continue;   // off-topic post from an allowed publication
        const text = pickLine(tag("content:encoded"), subtitle);
        if (!text) continue;
        out.push({ text, source: decodeEntities(tag("dc:creator")) || pubName, sub: title, url: tag("link").trim() });
        if (out.length >= 3) break;
      }
      return out;
    } catch (e) { return []; }
  }));
  const seen = new Set();
  return { at: Date.now(), quotes: lists.flat().filter(q => !seen.has(q.text) && seen.add(q.text)) };
}

function stripCdata(s) { return s.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, ""); }
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : named[e.toLowerCase()] ?? all);
}
function plain(htmlStr) { return decodeEntities(htmlStr.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
// A line worth reading on its own: a pull quote if the post has one, else a sentence from the opening paragraphs that
// doesn't lean on what came before ("This…", "But…"), else the post's subtitle.
function pickLine(content, subtitle) {
  const ok = s => s.length >= 50 && s.length <= 240 && !/subscribe|http|click|sign up|paid subscri|supported publication|podcast|footnote|\[\d+\]/i.test(s);
  for (const m of content.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g)) { const t = plain(m[1]); if (ok(t)) return t; }
  const paras = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => plain(m[1])).filter(Boolean).slice(0, 12);
  const lines = [];
  for (const p of paras) for (const s of p.match(/[^.!?]+[.!?]+["”’)]*/g) || []) {
    const t = s.trim();
    if (ok(t) && /^[A-Z“"]/.test(t) && !/^(This|That|These|Those|It|He|She|They|But|And|So|Or|Also|Here|There|Then|Which|As)\b/.test(t) && !/\?$/.test(t)) lines.push(t);
  }
  if (lines.length) return lines[Math.floor(Math.random() * lines.length)];
  return ok(subtitle) ? subtitle : null;
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

// named exports for tests
export { getCanvas, shortCode, placesFromEnv, getState, postState, getCommute, spotifyNow, getCar, carCron, smartcarAuthStart, smartcarAuthCallback, substackFeeds, buildSubstackPool, onTopic };
