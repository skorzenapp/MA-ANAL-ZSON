'use strict';
// Hava etkisi: maç saatindeki sıcaklık, yağmur ve rüzgâr gol beklentisini değiştiriyor mu?
// Veri: Open-Meteo (ücretsiz, anahtarsız): şehir -> koordinat (geocoding), geçmiş (archive) ve yakın geçmiş/tahmin (forecast) saatlik veri.
// ESPN futbolda hava durumu vermez. Maçın yaşandığı şehir, ev sahibi takımın sahasının şehri alınır.
// Yöntem: modelin maç beklentisine (mu) üç saatlik hava durumu işaretleri eklenir (glm.js), olabilirlik oranı testi + özellik başına z testi.

const U = require('./util');
const GLM = require('./glm');

const GEO = (process.env.WX_GEO || 'https://geocoding-api.open-meteo.com').replace(/\/$/, '');
const ARCHIVE = (process.env.WX_ARCHIVE || 'https://archive-api.open-meteo.com').replace(/\/$/, '');
const FORECAST = (process.env.WX_FORECAST || 'https://api.open-meteo.com').replace(/\/$/, '');
const HOUR = 3600000, DAY = 86400000;
const SHR = 0.7;
const Z_MIN = 2.5; // 4 özellik birlikte denendiği için tek tek z ≥ 2,5 (yaklaşık Bonferroni)

const FEATS = [
  { key: 'hot', label: 'Sıcak (≥ 27 °C)', test: (w) => w.t >= 27 },
  { key: 'cold', label: 'Soğuk (≤ 3 °C)', test: (w) => w.t <= 3 },
  { key: 'rain', label: 'Yağmur (3 saatte ≥ 1 mm)', test: (w) => w.p >= 1 },
  { key: 'wind', label: 'Rüzgâr (≥ 30 km/sa)', test: (w) => w.w >= 30 },
];
const flagsOf = (w) => (w ? FEATS.map((f) => (f.test(w) ? 1 : 0)) : null);

// ---------- ağ (önbellekli, yavaş ve nazik) ----------
const lim = new U.Limiter(3);
let downUntil = 0;
const stats = { calls: 0, fails: 0 };
async function fetchJSON(url, { ttl, ns = 'wx' } = {}) {
  const c = U.diskGet(ns, url, ttl);
  if (c.hit) return c.d;
  if (Date.now() < downUntil) { const old = U.diskGet(ns, url, Infinity); return old.hit ? old.d : null; }
  return U.once('wx:' + url, async () => {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await lim.run(async () => {
          stats.calls++;
          const res = await fetch(url, { headers: { 'User-Agent': 'MacAnaliz/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
          if (res.status === 429) throw new Error('HTTP 429');
          if (res.status >= 500) throw new Error('HTTP ' + res.status);
          if (!res.ok) return { none: true };
          return { d: await res.json() };
        });
        if (r.none) return null;
        U.diskSet(ns, url, r.d);
        return r.d;
      } catch (e) { lastErr = e; stats.fails++; await U.sleep(600 * (i + 1)); }
    }
    downUntil = Date.now() + 5 * 60000; // ulaşılamıyorsa 5 dakika dene(me)
    const old = U.diskGet(ns, url, Infinity);
    return old.hit ? old.d : null;
  });
}
const isDown = () => Date.now() < downUntil;

// ---------- şehir -> koordinat ----------
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function geocode(name) {
  const n = clean(name);
  if (!n) return [];
  const j = await fetchJSON(`${GEO}/v1/search?name=${encodeURIComponent(n)}&count=10&language=en&format=json`, { ttl: 365 * DAY, ns: 'wxg' });
  return ((j && j.results) || []).map((r) => ({ lat: r.latitude, lon: r.longitude, cc: r.country_code, pop: r.population || 0, name: r.name, country: r.country }));
}
// cities: [name] -> { byCity: Map(name -> {lat, lon, cc}), cc }
async function locate(cities) {
  const names = [...new Set(cities.map(clean).filter(Boolean))].slice(0, 40);
  const found = await Promise.all(names.map(async (n) => [n, await geocode(n)]));
  const votes = new Map();
  for (const [, res] of found) {
    if (!res.length) continue;
    const top = res.slice().sort((a, b) => b.pop - a.pop)[0];
    votes.set(top.cc, (votes.get(top.cc) || 0) + 1);
  }
  let cc = null, best = 0;
  for (const [k, v] of votes) if (v > best) { best = v; cc = k; }
  const byCity = new Map();
  for (const [n, res] of found) {
    const pick = res.filter((r) => r.cc === cc).sort((a, b) => b.pop - a.pop)[0];
    if (pick) byCity.set(n, { lat: pick.lat, lon: pick.lon, cc });
  }
  return { byCity, cc, asked: names.length };
}

// ---------- saatlik veri ----------
const r2 = (v) => Math.round(v * 100) / 100;
function hourlyMap(j) {
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time)) return new Map();
  const m = new Map();
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i] + (String(h.time[i]).length === 16 ? ':00Z' : 'Z'));
    if (!Number.isFinite(t)) continue;
    const T = h.temperature_2m ? h.temperature_2m[i] : null, P = h.precipitation ? h.precipitation[i] : null, W = h.wind_speed_10m ? h.wind_speed_10m[i] : null;
    if (T == null && P == null && W == null) continue;
    m.set(t, { t: T, p: P == null ? 0 : P, w: W });
  }
  return m;
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const VARS = 'temperature_2m,precipitation,wind_speed_10m';
// from-to: ms. Geçmiş için archive (yaklaşık 6 gün gecikmeli), son günler ve gelecek için forecast
async function hourlyFor(loc, fromMs, toMs) {
  const out = new Map();
  const now = Date.now();
  const cut = now - 7 * DAY;
  if (fromMs < cut) {
    const end = Math.min(toMs, cut);
    const j = await fetchJSON(`${ARCHIVE}/v1/archive?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}&start_date=${iso(fromMs)}&end_date=${iso(end)}&hourly=${VARS}&timezone=UTC`, { ttl: 30 * DAY });
    for (const [k, v] of hourlyMap(j)) out.set(k, v);
  }
  if (toMs >= cut) {
    const past = Math.min(92, Math.max(0, Math.ceil((now - Math.max(fromMs, cut)) / DAY) + 1));
    const fut = Math.min(16, Math.max(1, Math.ceil((toMs - now) / DAY) + 1));
    const j = await fetchJSON(`${FORECAST}/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}&hourly=${VARS}&past_days=${past}&forecast_days=${fut}&timezone=UTC`, { ttl: 3 * HOUR });
    for (const [k, v] of hourlyMap(j)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}
// Maç saati: başlangıç ve sonraki iki saatin ortalaması (yağmur: üç saatin toplamı)
function weatherAt(hm, tMs) {
  const t0 = Math.floor(tMs / HOUR) * HOUR;
  let ts = 0, nt = 0, ps = 0, np = 0, ws = 0, nw = 0;
  for (let k = 0; k < 3; k++) {
    const x = hm.get(t0 + k * HOUR);
    if (!x) continue;
    if (x.t != null) { ts += x.t; nt++; }
    if (x.p != null) { ps += x.p; np++; }
    if (x.w != null) { ws += x.w; nw++; }
  }
  if (nt < 2 || np < 2) return null;
  return { t: r2(ts / nt), p: r2(ps), w: nw ? r2(ws / nw) : 0 };
}

// ---------- ölçüm ----------
// feed: [{hg, ag, lh, la, fl:[0/1 x4] | null}]
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (!f || !f.fl || f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0)) continue;
    rows.push({ y: f.hg, mu: f.lh, x: f.fl });
    rows.push({ y: f.ag, mu: f.la, x: f.fl });
  }
  return rows;
}
function estimate(rows, minMatches = 25) {
  const n = rows.length / 2;
  const cnt = FEATS.map((_, j) => rows.reduce((s, r) => s + r.x[j], 0) / 2);
  const active = FEATS.map((_, j) => j).filter((j) => cnt[j] >= minMatches && n - cnt[j] >= minMatches);
  const counts = Object.fromEntries(FEATS.map((f, j) => [f.key, cnt[j]]));
  if (n < 60 || !active.length) return { enough: false, n, counts };
  const sub = rows.map((r) => ({ y: r.y, mu: r.mu, x: active.map((j) => r.x[j]) }));
  const r = GLM.fit(sub, active.length, { minRows: 120, minActive: minMatches * 2 });
  if (!r.enough || !r.se) return { enough: false, n, counts };
  const base = (arr) => (arr.length >= 8 ? arr.reduce((s, x) => s + x.y, 0) / arr.reduce((s, x) => s + x.mu, 0) : null);
  const feats = active.map((j, a) => {
    const z = r.se[a] > 0 ? r.beta[a] / r.se[a] : 0;
    const on = rows.filter((x) => x.x[j]), off = rows.filter((x) => !x.x[j]);
    return { key: FEATS[j].key, label: FEATS[j].label, n: cnt[j], beta: r.beta[a], se: r.se[a], z, prec: r.se[a] > 0 ? 1 / (r.se[a] * r.se[a]) : 0, adopted: r.significant && Math.abs(z) >= Z_MIN, ratioOn: base(on), ratioOff: base(off) };
  });
  const applied = {};
  for (const f of feats) if (f.adopted) applied[f.key] = f.beta * SHR;
  return { enough: true, n, counts, feats, LR: r.LR, df: active.length, crit: r.crit, significant: r.significant, applied: Object.keys(applied).length ? applied : null };
}
// Ligler arası: özellik başına ters varyans ağırlıklı ortalama (en az 3 lig)
function pool(list) {
  const out = {};
  for (const f of FEATS) {
    const L = list.filter((x) => x && x.feats && x.feats[f.key] && x.feats[f.key].prec > 0);
    if (L.length < 3) { out[f.key] = { enough: false, leagues: L.length }; continue; }
    const P = L.reduce((s, x) => s + x.feats[f.key].prec, 0);
    const beta = L.reduce((s, x) => s + x.feats[f.key].prec * x.feats[f.key].beta, 0) / P;
    const z = beta * Math.sqrt(P);
    out[f.key] = { enough: true, leagues: L.length, beta, se: 1 / Math.sqrt(P), z, significant: Math.abs(z) >= Z_MIN, applied: Math.abs(z) >= Z_MIN ? beta * SHR : null };
  }
  return out;
}
// Maç için çarpan (iki takımın golüne de uygulanır)
function factor(k, fl) {
  if (!k || !fl) return 1;
  let s = 0;
  FEATS.forEach((f, j) => { if (fl[j] && k[f.key] != null) s += k[f.key]; });
  return Math.exp(s);
}

module.exports = { FEATS, flagsOf, geocode, locate, hourlyFor, hourlyMap, weatherAt, buildRows, estimate, pool, factor, isDown, stats, SHR, Z_MIN };
