const CACHE = 'rp-engine-shell-v21';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/brand/app-icon.png', '/brand/tavern-background.jpg', '/audio-worklet.js', '/microphone-worklet.js'];
const VAD = ['/vad/manifest.json', '/vad/fireredvad_stream_vad_with_cache.onnx', '/vad/cmvn.ark', '/vad/LICENSE-FireRedVAD'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(async cache => {
      await cache.addAll(SHELL);
      // VAD is optional. A failed model fetch must never prevent the PWA shell
      // from installing because manual Send voice remains fully functional.
      await Promise.allSettled(VAD.map(path => cache.add(path)));
    })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/ort-wasm/') || url.pathname.startsWith('/wasm/')) return;
  if (url.pathname.startsWith('/vad/')) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, response.clone())));
      return response;
    })));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      // Clone synchronously, before the browser starts consuming the response
      // returned below. Cloning inside a later promise races with body usage.
      const cacheCopy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, cacheCopy)));
    }
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match('/index.html'))));
});
