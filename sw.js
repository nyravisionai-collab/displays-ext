/* રિમોટ વિડિયો કંટ્રોલ — Service Worker
   એપ ઇન્સ્ટોલ થાય એ માટે + એક વાર ખૂલેલી એપ ઓફલાઇન(ઇન્ટરનેટ વગર) પણ ખૂલે. */
'use strict';

var CACHE = 'rvc-v1';

var PRECACHE = [
  './',
  './index.html',
  './player.html',
  './controller.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // એક ફાઇલ ન મળે તો પણ install અટકે નહીં
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // પેજનાં navigation (?room=1234 વગેરે query હોય તો પણ કૅશમાંથી)
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () {
          return caches.match('./index.html');
        });
      })
    );
    return;
  }

  // બીજા assets (icons, manifest, peerjs CDN): cache-first, પછી network + runtime cache
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});
