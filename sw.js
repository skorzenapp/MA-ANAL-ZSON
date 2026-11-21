/* Maç Analiz: çevrimdışı önbellek. Sürüm: index-0V3t4hSL.js */
const BUILD = 'index-0V3t4hSL.js';
const SHELL = 'shell-' + BUILD;
const API = 'api-v1';

// API sınıfları: fresh = bu süre içinde doğrudan önbellekten, swr = bu süre içinde önbellekten verip arkada yeniler
const CLASSES = [
  [/^\/api\/matches\//, { fresh: 8e3, swr: 10 * 6e4 }],
  [/^\/api\/(match|predict|match-players)\//, { fresh: 15e3, swr: 5 * 6e4 }],
  [/^\/api\/(team|player|standings|matchup)\//, { fresh: 6e4, swr: 6 * 36e5 }],
];
const classOf = (p) => { for (const [re, c] of CLASSES) if (re.test(p)) return c; return null; };

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    const r = await fetch('./index.html', { cache: 'reload' });
    if (!r.ok) throw new Error('index.html alınamadı');
    const html = await r.clone().text();
    const urls = new Set(['./manifest.webmanifest', './favicon.png', './apple-touch-icon.png']);
    for (const m of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) urls.add(m[1]);
    await c.put('./index.html', r);
    await Promise.all([...urls].map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const lastNote = new Map();
async function notify(path) {
  const t = Date.now();
  if (t - (lastNote.get(path) || 0) < 3000) return;
  lastNote.set(path, t);
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'api-updated', path });
}
const norm = (txt) => { try { return JSON.stringify(JSON.parse(txt), (k, v) => (k === 'generatedAt' ? undefined : v)); } catch (e) { return txt; } };

async function fetchAndStore(req, path, cached) {
  const r = await fetch(req);
  if (!r.ok) return r;
  const cache = await caches.open(API);
  const body = await r.clone().arrayBuffer();
  const h = new Headers(r.headers);
  h.delete('content-encoding'); h.delete('content-length');
  h.set('x-zq-t', String(Date.now()));
  const stored = new Response(body, { status: 200, headers: h });
  let changed = false;
  if (cached) {
    try { changed = norm(await cached.clone().text()) !== norm(new TextDecoder().decode(body)); } catch (e) { changed = true; }
  }
  await cache.put(req, stored);
  if (changed) notify(path);
  return r;
}

async function apiResponse(e, req, path, cls) {
  const cache = await caches.open(API);
  const cached = await cache.match(req);
  const age = cached ? Date.now() - Number(cached.headers.get('x-zq-t') || 0) : Infinity;
  if (cached && age < cls.fresh) return cached;
  if (cached && age < cls.swr) { e.waitUntil(fetchAndStore(req, path, cached).catch(() => {})); return cached; }
  const net = fetchAndStore(req, path, cached);
  if (!cached) return net;
  // çok eski kayıt: ağı en çok 2.5 sn bekle, olmazsa eskisini göster (ağ arkada yine de yenilenir)
  e.waitUntil(net.catch(() => {}));
  return Promise.race([net, new Promise((ok) => setTimeout(() => ok(cached), 2500))]).catch(() => cached);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    const cls = classOf(url.pathname);
    if (cls) e.respondWith(apiResponse(e, req, url.pathname + url.search, cls).catch(() => fetch(req)));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith((async () => (await caches.match('./index.html', { cacheName: SHELL })) || fetch(req))());
    return;
  }
  if (url.pathname === '/sw.js') return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: SHELL, ignoreSearch: true });
    return hit || fetch(req);
  })());
});
