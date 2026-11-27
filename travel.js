'use strict';
// Uzak deplasman ve derbi etkisi: deplasman takımının yolculuk mesafesi ve aynı şehirdeki derbiler gol beklentisini değiştiriyor mu?
// Veri: her takımın ev şehri (ev maçlarının oynandığı şehir) hava modülündeki şehir→koordinat çevirisiyle (Open-Meteo geocoding) koordinata çevrilir.
// Mesafe, deplasman takımının ev şehri ile maçın oynandığı şehir arasındaki kuş uçuşu uzaklıktır (yolculuk süresi bilinmez).
// Yöntem: modelin maç beklentisine (mu) işaretler eklenir (glm.js), olabilirlik oranı testi + özellik başına z testi; katsayılar %30 küçültülür.

const GLM = require('./glm');

const SHR = 0.7;
const Z_MIN = 2.5; // 3 özellik birlikte denendiği için tek tek z ≥ 2,5
const FAR_KM = 600;
const DERBY_KM = 30;
const MIN_MATCHES = 15; // bir özelliğin "açık" ve "kapalı" olduğu en az maç sayısı (nadir olduğu için hava ölçümünden düşük)

// per: özelliğin kaç satıra (takım-maç) yazıldığı (derbide iki takıma da)
const FEATS = [
  { key: 'farAway', label: 'Uzak deplasman (≥ 600 km): deplasman takımının golü', per: 1 },
  { key: 'farHome', label: 'Uzak deplasman (≥ 600 km): ev sahibinin golü', per: 1 },
  { key: 'derby', label: 'Aynı şehir derbisi: iki takımın golü', per: 2 },
];

// kuş uçuşu mesafe (km)
function km(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
// maç için işaretler: [farAway, farHome, derby] satır başına değil maç başına (buildRows satıra böler)
function tripOf(cityH, cityA, coords) {
  if (!cityH || !cityA || !coords) return null;
  const a = coords[cityA], h = coords[cityH];
  if (!a || !h) return null;
  const d = cityH === cityA ? 0 : km(a, h);
  if (d == null || !Number.isFinite(d)) return null;
  return { km: d, far: d >= FAR_KM, derby: d < DERBY_KM };
}

// feed: [{hg, ag, lh, la, trip:{far, derby} | null}]
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (!f || !f.trip || f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0)) continue;
    const far = f.trip.far ? 1 : 0, dby = f.trip.derby ? 1 : 0;
    rows.push({ y: f.hg, mu: f.lh, x: [0, far, dby] });
    rows.push({ y: f.ag, mu: f.la, x: [far, 0, dby] });
  }
  return rows;
}
function estimate(rows, minMatches = MIN_MATCHES) {
  const n = rows.length / 2;
  const cnt = FEATS.map((f, j) => rows.reduce((s, r) => s + r.x[j], 0) / f.per);
  const active = FEATS.map((_, j) => j).filter((j) => cnt[j] >= minMatches && n - cnt[j] >= minMatches);
  const counts = Object.fromEntries(FEATS.map((f, j) => [f.key, cnt[j]]));
  if (n < 60 || !active.length) return { enough: false, n, counts };
  const sub = rows.map((r) => ({ y: r.y, mu: r.mu, x: active.map((j) => r.x[j]) }));
  const r = GLM.fit(sub, active.length, { minRows: 120, minActive: minMatches });
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
// Maç için çarpanlar: k = {farAway, farHome, derby} katsayıları (log), trip = {far, derby}
function factors(k, trip) {
  if (!k || !trip) return { home: 1, away: 1 };
  const far = trip.far ? 1 : 0, dby = trip.derby ? 1 : 0;
  const lh = (k.farHome || 0) * far + (k.derby || 0) * dby;
  const la = (k.farAway || 0) * far + (k.derby || 0) * dby;
  return { home: Math.exp(lh), away: Math.exp(la) };
}
// maçta hangi özellikler açık: [{key,label}]
function flagsOf(trip) {
  if (!trip) return [];
  const out = [];
  if (trip.far) out.push(FEATS[0], FEATS[1]);
  if (trip.derby) out.push(FEATS[2]);
  return out;
}
// takım -> ev şehri: ev maçlarının en sık oynandığı şehir; tarafsız saha maçları sayılmaz
function baseCities(matches) {
  const cnt = new Map();
  for (const m of matches) {
    if (!m.vc || m.neutral) continue;
    let c = cnt.get(m.h);
    if (!c) { c = new Map(); cnt.set(m.h, c); }
    c.set(m.vc, (c.get(m.vc) || 0) + 1);
  }
  const base = new Map();
  for (const [tid, c] of cnt) base.set(tid, [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return base;
}

module.exports = { FEATS, FAR_KM, DERBY_KM, MIN_MATCHES, SHR, Z_MIN, km, tripOf, buildRows, estimate, pool, factors, flagsOf, baseCities };
