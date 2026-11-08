// Minimal service worker: lets the app install to the home screen and open offline
// with the last-seen shell. Data is always fetched live (network-first); the API is never cached.
const SHELL = "cc-shell-v3";
const SHELL_FILES = ["/", "/manifest.webmanifest", "/icons/icon-192.png?v=2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/login") return; // live only
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(SHELL).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});

// Push: the Worker sends {title, body, url, tag}; tapping the notification opens (or focuses) the app at url.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Command Center", {
    body: d.body || "", tag: d.tag, icon: "/icons/icon-192.png?v=2", badge: "/icons/icon-192.png?v=2", data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (url.startsWith(location.origin)) { const w = list.find(c => c.url.startsWith(location.origin)); if (w) return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
