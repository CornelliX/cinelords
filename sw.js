// Gleiche Domain wie LiveLords: der Cache-Speicher ist geteilt, daher räumt jede App nur Caches mit dem eigenen Präfix ab
const CACHE = 'cine-v1'
const FILMS_CACHE = 'cine-films'
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/cinelords/', '/cinelords/index.html'])))
  self.skipWaiting()
})
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('cine-') && k !== CACHE && k !== FILMS_CACHE).map(k => caches.delete(k)))))
  self.clients.claim()
})
self.addEventListener('fetch', e => {
  // films.json: sofort aus dem Gerätespeicher, im Hintergrund neu laden. Hat sich die Liste geändert, bekommt die
  // Seite eine Nachricht und übernimmt sie (applyFilmsUpdate in app.js).
  if (new URL(e.request.url).pathname.endsWith('/films.json')) {
    e.respondWith(caches.open(FILMS_CACHE).then(async cache => {
      const cached = await cache.match('films.json')
      const update = fetch(e.request.url, { cache: 'no-cache' }).then(async res => {
        if (!res.ok) return res
        const old = cached ? await (await cache.match('films.json')).text() : null   // frische Kopie: `cached` geht an die Seite
        await cache.put('films.json', res.clone())
        if (old !== null && old !== await res.clone().text()) {
          (await self.clients.matchAll()).forEach(c => c.postMessage({ type: 'films-updated' }))
        }
        return res
      })
      e.waitUntil(update.catch(() => {}))
      return cached || update
    }))
    return
  }
  // HTML immer vom Netz (neue Bundles greifen sofort), offline aus dem Cache
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
    return
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)))
})
