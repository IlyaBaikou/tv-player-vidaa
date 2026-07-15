/* TV Player VIDAA — offline shell cache. Remote config and streams are never cached. */
var CACHE = "tv-player-vidaa-shell-v3";
var SHELL = [
  "./",
  "index.html",
  "styles.css?v=5",
  "config.js?v=5",
  "data.js?v=5",
  "app.js?v=5",
  "manifest.json",
  "assets/rubik.ttf",
  "assets/icon.svg",
  "assets/icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key.indexOf("tv-player-vidaa-shell-") === 0 && key !== CACHE; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put("index.html", copy); });
      return response;
    }).catch(function () { return caches.match("index.html"); }));
    return;
  }

  if (url.pathname.indexOf("/epg/") >= 0) {
    event.respondWith(fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () { return caches.match(request); }));
    return;
  }

  event.respondWith(caches.match(request).then(function (cached) {
    return cached || fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  }));
});
