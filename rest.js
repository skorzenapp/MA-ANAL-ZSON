'use strict';
// Dinlenme süresi / maç yoğunluğu etkisi.
// Soru: son maçından beri çok az dinlenen takım (kısa dinlenme: < 3,6 gün) beklenenden az gol atıyor mu,
// rakibi ise beklenenden çok mu atıyor? Modelin maç beklentisi (mu) üstüne iki katsayı eklenir:
//   log λ = log mu + a·(kendi kısa dinlenmesi) + d·(rakibin kısa dinlenmesi)
// Katsayılar poisson olabilirlik ile bulunur; sıfırdan farkı olabilirlik oranı testiyle (2 serbestlik, 5,99) sınanır.
// Birden çok ligin ölçümü bilgi matrisleriyle birleştirilir (Wald testi).

const DAY = 86400000;
const SHORT_DAYS = 3.6;
const SHR = 0.7; // ölçülen etkiyi biraz küçült

// times: bir takımın TÜM turnuvalardaki maç zamanları, eskiden yeniye
function lastBefore(times, t) {
  if (!times || !times.length) return null;
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t - 3600000) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? times[ans] : null;
}
// Dinlenme günü (bilinmiyorsa null: ilk maçlar, veri başlangıcı)
function restDays(times, t, from) {
  const p = lastBefore(times, t);
  if (p == null) return null;
  return (t - p) / DAY;
}
const isShort = (d) => d != null && d < SHORT_DAYS;

// feed: [{hg, ag, lh, la, rh, ra}]  rh/ra: ev ve deplasmanın dinlenme günü (null: bilinmiyor)
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0)) continue;
    if (f.rh == null || f.ra == null) continue;
    const sh = isShort(f.rh) ? 1 : 0, sa = isShort(f.ra) ? 1 : 0;
    rows.push({ y: f.hg, mu: f.lh, s: sh, o: sa });
    rows.push({ y: f.ag, mu: f.la, s: sa, o: sh });
  }
  return rows;
}

function ll(rows, a, d) {
  let s = 0;
  for (const r of rows) { const eta = Math.log(r.mu) + a * r.s + d * r.o; s += r.y * eta - Math.exp(eta); }
  return s;
}

// Fisher bilgisi (a, d) noktasında: [Iaa, Iad, Idd]
function info(rows, a, d) {
  let aa = 0, ad = 0, dd = 0;
  for (const r of rows) { const m = r.mu * Math.exp(a * r.s + d * r.o); aa += m * r.s * r.s; ad += m * r.s * r.o; dd += m * r.o * r.o; }
  return [aa, ad, dd];
}

function estimate(rows, minShort = 25) {
  const n = rows.length;
  const nShort = rows.reduce((s, r) => s + r.s, 0);
  const nOpp = rows.reduce((s, r) => s + r.o, 0);
  if (n < 120 || nShort < minShort || nOpp < minShort) return { enough: false, n, nShort, nOpp };
  const ll0 = ll(rows, 0, 0);
  let best = { a: 0, d: 0, v: ll0 };
  for (let a = -0.6; a <= 0.6001; a += 0.05) for (let d = -0.6; d <= 0.6001; d += 0.05) { const v = ll(rows, a, d); if (v > best.v) best = { a, d, v }; }
  const c = { ...best };
  for (let a = c.a - 0.05; a <= c.a + 0.0501; a += 0.01) for (let d = c.d - 0.05; d <= c.d + 0.0501; d += 0.01) { const v = ll(rows, a, d); if (v > best.v) best = { a, d, v }; }
  const LR = 2 * (best.v - ll0);
  const I = info(rows, best.a, best.d);
  const det = I[0] * I[2] - I[1] * I[1];
  const se = det > 0 ? { a: Math.sqrt(I[2] / det), d: Math.sqrt(I[0] / det) } : null;
  const ratio = (arr) => (arr.length >= 8 ? arr.reduce((s, r) => s + r.y, 0) / arr.reduce((s, r) => s + r.mu, 0) : null);
  const shortRows = rows.filter((r) => r.s && !r.o), restRows = rows.filter((r) => !r.s && !r.o), oppRows = rows.filter((r) => r.o && !r.s);
  const significant = LR >= 5.99;
  return {
    enough: true, n: n / 2, nShort, nOpp, a: best.a, d: best.d, LR, significant, se, info: I,
    applied: significant ? { a: best.a * SHR, d: best.d * SHR } : null,
    ratios: { short: ratio(shortRows), normal: ratio(restRows), oppShort: ratio(oppRows) },
  };
}

// Birden çok ligin ölçümünü birleştir: list: [{a, d, info:[Iaa,Iad,Idd]}]
function pool(list) {
  const L = list.filter((x) => x && x.info && Number.isFinite(x.a) && Number.isFinite(x.d));
  if (L.length < 3) return { enough: false, leagues: L.length };
  let Iaa = 0, Iad = 0, Idd = 0, ba = 0, bd = 0;
  for (const x of L) {
    const [aa, ad, dd] = x.info;
    Iaa += aa; Iad += ad; Idd += dd;
    ba += aa * x.a + ad * x.d;
    bd += ad * x.a + dd * x.d;
  }
  const det = Iaa * Idd - Iad * Iad;
  if (!(det > 0)) return { enough: false, leagues: L.length };
  const a = (Idd * ba - Iad * bd) / det, d = (Iaa * bd - Iad * ba) / det;
  const W = Iaa * a * a + 2 * Iad * a * d + Idd * d * d;
  const significant = W >= 5.99;
  return { enough: true, leagues: L.length, a, d, W, significant, se: { a: Math.sqrt(Idd / det), d: Math.sqrt(Iaa / det) }, applied: significant ? { a: a * SHR, d: d * SHR } : null };
}

// kısa dinlenmesi olan takımın gol beklentisi düşer; rakibinin (kısa dinlenen takıma karşı) artar
function factors(k, rh, ra) {
  if (!k) return { home: 1, away: 1 };
  const sh = isShort(rh) ? 1 : 0, sa = isShort(ra) ? 1 : 0;
  return { home: Math.exp(k.a * sh + k.d * sa), away: Math.exp(k.a * sa + k.d * sh) };
}

module.exports = { DAY, SHORT_DAYS, lastBefore, restDays, isShort, buildRows, estimate, pool, factors, ll };
