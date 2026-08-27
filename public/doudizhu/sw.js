/* 牌桌壳离线缓存。对局接口和 WebSocket 始终走网络——没有后端裁判就打不了。 */
const CACHE = "doudizhu-shell-v1";
const PRECACHE = [
  "/doudizhu/",
  "/doudizhu/index.html",
  "/doudizhu/game.css",
  "/doudizhu/game.js",
  "/doudizhu/manifest.webmanifest",
  "/doudizhu/icons/icon-192.png",
  "/doudizhu/icons/icon-512.png",
  "/doudizhu/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/doudizhu/assets/")) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.pathname.startsWith("/doudizhu/")) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw err;
  }
}
