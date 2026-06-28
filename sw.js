/* Payroll Helper service worker — precache the app shell so it works fully offline.
 * Bump CACHE when any app file changes to force a refresh on next launch. */
var CACHE = "payroll-helper-v1";
var ASSETS = [
  "./",
  "./index.html",
  "./payroll-helper.html",
  "./app.js",
  "./manifest.json",
  "./apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./src/normalize.js",
  "./src/dates.js",
  "./src/rates.js",
  "./src/rulelib.js",
  "./src/payroll.js",
  "./src/review.js",
  "./src/email.js",
  "./src/audit.js",
  "./src/reconcile.js",
  "./src/discovery.js",
  "./src/storage.js",
  "./src/parser.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache-first for app assets; network only as a fallback (and refresh the cache when online).
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { try { c.put(e.request, copy); } catch (_) {} });
        return res;
      }).catch(function () { return caches.match("./payroll-helper.html"); });
    })
  );
});
