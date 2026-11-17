'use strict';
// Maç Analiz sunucusu: /api uçları + arayüz dosyaları. Dış bağımlılık yok (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('./util');
const L = require('./leagues');
const S = require('./store');
const E = require('./espn');

const PORT = Number(process.env.PORT || 8080);
// Arayüz dosyaları: ../public klasörü varsa orada, yoksa (tek klasörlü sürüm) sunucu dosyalarının yanında
const PUBLIC = fs.existsSync(path.join(__dirname, '..', 'public', 'index.html')) ? path.join(__dirname, '..', 'public') : __dirname;
// Sadece arayüz dosyaları sunulur (sunucu kodu ve ayar dosyaları asla)
const ALLOW = /^(?:assets\/[^/]+|index\.html|manifest\.webmanifest|favicon\.png|icon-\d+\.png|apple-touch-icon\.png|sw\.js|(?:index|extras)-[\w-]+\.(?:js|css))$/;
const SLUG = /^[a-z0-9._-]{2,40}$/i;
const ID = /^[0-9a-z_-]{1,40}$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);

function send(req, res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'Content-Length': buf.length, ...headers };
  res.writeHead(code, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJSON(req, res, code, obj, cache) {
  let buf = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache || 'no-store', Vary: 'Accept-Encoding' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf, { level: 5 });
    h['Content-Encoding'] = 'gzip';
  }
  send(req, res, code, buf, h);
}

// ---------- API ----------
const routes = [];
const route = (re, fn) => routes.push([re, fn]);

const must = (cond, status, msg) => { if (!cond) throw Object.assign(new Error(msg), { status }); };
const league = (s) => { must(SLUG.test(s) && L.BY[s], 404, 'Bilinmeyen lig'); return s; };
const openLeague = (s) => { league(s); must(L.BY[s].available, 404, 'Bu lig için veri yok'); return s; };
const id = (s) => { must(ID.test(s), 400, 'Geçersiz kimlik'); return s; };

route(/^\/api\/health$/, async () => ({ data: { ok: true, uptime: Math.round(process.uptime()), espn: E.stats, search: { players: S.searchIdx.items.length, building: S.searchIdx.building }, leagues: L.AVAILABLE.length } }));

route(/^\/api\/matches\/(\d{8})\/([^/]+)$/, async ([, date, lg], q) => {
  if (lg !== 'all') league(lg);
  const tz = Math.max(-840, Math.min(840, parseInt(q.get('tz') || '0', 10) || 0));
  const r = await S.matchesFor(date, lg, tz);
  if (!r.events.length && r.errors.length && r.errors.length >= (lg === 'all' ? L.AVAILABLE.length : 1)) throw Object.assign(new Error('Veri kaynağına ulaşılamadı'), { status: 502 });
  return { data: { events: r.events, errors: r.errors } };
});

route(/^\/api\/match\/([^/]+)\/([^/]+)$/, async ([, lg, mid]) => {
  const d = await S.matchDetail(openLeague(lg), id(mid));
  must(d, 404, 'Maç bulunamadı');
  return { data: d };
});

route(/^\/api\/predict\/([^/]+)\/([^/]+)$/, async ([, lg, mid]) => ({ data: await S.predict(openLeague(lg), id(mid)) }));

route(/^\/api\/live\/([^/]+)\/([^/]+)$/, async ([, lg, mid]) => ({ data: await S.liveData(openLeague(lg), id(mid)) }));

route(/^\/api\/props\/([^/]+)\/([^/]+)$/, async ([, lg, mid]) => ({ data: await S.propsFor(openLeague(lg), id(mid)) }));

route(/^\/api\/matchup\/([^/]+)\/([^/]+)\/([^/]+)$/, async ([, lg, a, b]) => ({ data: await S.matchupTeams(openLeague(lg), id(a), id(b)) }));

route(/^\/api\/today\/(\d{8})\/([^/]+)$/, async ([, date, lg], q) => {
  if (lg !== 'all') openLeague(lg);
  const tz = Math.max(-840, Math.min(840, parseInt(q.get('tz') || '0', 10) || 0));
  return { data: S.todayTable(date, tz, lg) };
});

route(/^\/api\/team\/([^/]+)\/([^/]+)$/, async ([, lg, tid]) => {
  const d = await S.teamData(openLeague(lg), id(tid));
  must(d, 404, 'Takım bulunamadı');
  return { data: d };
});

route(/^\/api\/player\/([^/]+)\/([^/]+)$/, async ([, lg, pid], q) => {
  const d = await S.playerData(openLeague(lg), id(pid), id(q.get('team') || ''));
  must(d, 404, 'Oyuncu bulunamadı');
  return { data: d };
});

route(/^\/api\/match-players\/([^/]+)\/([^/]+)$/, async ([, lg, mid]) => {
  const d = await S.matchPlayers(openLeague(lg), id(mid));
  must(d, 404, 'Maç bulunamadı');
  return { data: d };
});

route(/^\/api\/standings\/([^/]+)$/, async ([, lg]) => ({ data: await S.standings(openLeague(lg)) }));

route(/^\/api\/leaders\/([^/]+)$/, async ([, lg]) => ({ data: S.leadersState(openLeague(lg)) }));

route(/^\/api\/search$/, async (_m, q) => ({ data: S.search(String(q.get('q') || '').slice(0, 60)) }));

route(/^\/api\/league-table$/, async () => ({ data: S.leagueTable() }));
route(/^\/api\/league\/([^/]+)$/, async ([, lg]) => ({ data: S.leagueDetail(openLeague(lg)) }));

route(/^\/api\/backtest\/([^/]+)$/, async ([, lg]) => ({ data: await S.backtestLeague(openLeague(lg)) }));
route(/^\/api\/backtest-summary$/, async () => ({ data: S.backtestSummary() }));

async function handleApi(req, res, url) {
  for (const [re, fn] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    try {
      const r = await fn(m.slice(0), url.searchParams);
      sendJSON(req, res, 200, r.data, r.cache);
    } catch (e) {
      const status = e.status || 502;
      if (!e.status) U.log('API hata', req.url, e.message);
      sendJSON(req, res, status, { error: e.status ? e.message : 'Veri kaynağına ulaşılamadı. Biraz sonra tekrar dene.' });
    }
    return;
  }
  sendJSON(req, res, 404, { error: 'Bulunamadı' });
}

// ---------- statik dosyalar ----------
const fileCache = new Map();
function loadFile(f) {
  let st;
  try { st = fs.statSync(f); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const c = fileCache.get(f);
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(f);
  const ext = path.extname(f).toLowerCase();
  const o = { mtime: st.mtimeMs, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 512 ? zlib.gzipSync(raw, { level: 9 }) : null, ext, etag: '"' + st.mtimeMs.toString(36) + '-' + raw.length.toString(36) + '"' };
  fileCache.set(f, o);
  return o;
}

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(req, res, 400, 'Bad request'); }
  if (p.includes('\0')) return send(req, res, 400, 'Bad request');
  let f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) return send(req, res, 403, 'Forbidden');
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  const rel = path.relative(PUBLIC, f).split(path.sep).join('/');
  let o = ALLOW.test(rel) ? loadFile(f) : null;
  if (!o) {
    if (path.extname(p)) return send(req, res, 404, 'Bulunamadı', { 'Content-Type': 'text/plain; charset=utf-8' });
    f = path.join(PUBLIC, 'index.html'); // SPA yedeği
    o = loadFile(f);
    if (!o) return send(req, res, 404, 'Arayüz dosyaları yok (public klasörü)', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const isAsset = /(?:^|\/)(?:index|extras)-[\w-]{6,}\.(?:js|css)$/.test(rel);
  const h = {
    'Content-Type': MIME[o.ext] || 'application/octet-stream',
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : o.ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=86400',
    ETag: o.etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === o.etag) return send(req, res, 304, '', h);
  const useGz = o.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (useGz) h['Content-Encoding'] = 'gzip';
  send(req, res, 200, useGz ? o.gz : o.raw, h);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(req, res, 400, 'Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => { U.log('beklenmeyen hata', e); if (!res.headersSent) sendJSON(req, res, 500, { error: 'Sunucu hatası' }); });
  } else {
    try { serveStatic(req, res, url); } catch (e) { U.log('statik hata', e.message); if (!res.headersSent) send(req, res, 500, 'Sunucu hatası'); }
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

process.on('unhandledRejection', (e) => U.log('işlenmeyen söz hatası:', e && e.message ? e.message : e));

server.listen(PORT, '0.0.0.0', () => {
  U.log(`Maç Analiz hazır: http://localhost:${PORT}  (${L.AVAILABLE.length} açık lig, veri klasörü: ${U.DATA_DIR})`);
  if (process.env.WARM !== '0') setTimeout(() => { if (!S.searchIdx.lastTry) S.startIndex(); }, 5000); // oyuncu arama dizinini arka planda kur
});

// eski önbellek dosyalarını temizle (günde bir)
function prune() {
  const a = U.pruneOld('c', 45 * U.DAY), b = U.pruneOld('r', 400 * U.DAY), c = U.pruneOld('ld', 10 * U.DAY);
  if (a + b + c) U.log('önbellek temizlendi:', a + b + c, 'dosya');
}
setTimeout(prune, 60000).unref();
setInterval(prune, U.DAY).unref();

module.exports = server;
