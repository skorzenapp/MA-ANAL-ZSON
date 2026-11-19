'use strict';
// Motivasyon: "bir şey için oynamayan" takım (sezon sonuna doğru puan durumunda yeri matematiksel olarak belli) beklenenden
// az gol atıyor mu, rakibi ise beklenenden çok mu atıyor? Dinlenme etkisiyle aynı yöntem (glm.js): iki katsayı, olabilirlik oranı testi,
// ligler arası birleşik ölçüm.
//   log λ = log mu + a·(kendi takımının işi bitmiş) + d·(rakibin işi bitmiş)
// "İşi bitmiş" = şampiyonluk, Avrupa kupası sınırları ve küme düşme çizgisi için puan durumundaki yeri artık değişemez (kalan maçlarda 3 puan hesabıyla).

const GLM = require('./glm');
const DAY = 86400000;
const SHR = 0.7;

// Maçları sezonlara böl: iki maç arası 60 günden fazla boşluk yeni sezon demek
function splitSeasons(own, gapDays = 60) {
  const list = own.slice().sort((a, b) => a.t - b.t);
  const out = [];
  let cur = [];
  for (const m of list) {
    if (cur.length && m.t - cur[cur.length - 1].t > gapDays * DAY) { out.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Puan durumundaki "çizgiler": 1. sıra (şampiyonluk) ve notu değişen yerler (Avrupa kupaları, küme düşme)
// rows: [{rank, note}] -> [kaç takım çizginin üstünde]
function cutsFromRows(rows, n) {
  const R = (rows || []).filter((r) => r && r.rank != null).sort((a, b) => a.rank - b.rank);
  const cuts = new Set([1]);
  let notes = 0;
  for (let i = 0; i < R.length - 1; i++) {
    if ((R[i].note || null) !== (R[i + 1].note || null)) cuts.add(i + 1);
    if (R[i].note) notes++;
  }
  if (R.length && R[R.length - 1].note) notes++;
  if (!notes) { cuts.add(Math.max(2, n - 3)); } // not yoksa: şampiyonluk ve son 3 (küme düşme) varsay
  return [...cuts].filter((c) => c >= 1 && c < n).sort((a, b) => a - b);
}

// Bir takımın bu çizgilerin hepsinde yeri belli mi?
function settledOf(i, P, Rm, cuts) {
  const n = P.length;
  const best = P[i] + 3 * Rm[i];
  let canBeat = 0; // i'nin şimdiki puanında bile ondan öne geçebilen ya da eşitlenebilen takım sayısı
  let beatenBy = 0; // i'nin alabileceği en fazla puandan bile kesin önde olan takım sayısı
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    if (P[j] + 3 * Rm[j] >= P[i]) canBeat++;
    if (P[j] > best) beatenBy++;
  }
  for (const c of cuts) {
    const guaranteedIn = canBeat <= c - 1;
    const guaranteedOut = beatenBy >= c;
    if (!guaranteedIn && !guaranteedOut) return false;
  }
  return true;
}

// Bir sezonun maçlarını sırayla oynat. Her maç için maçtan ÖNCEKİ durumla iki takımın "işi bitmiş mi" bayrağı.
// Dönüş: { ok, reason, n, G, complete, flags: Map(id -> {h, a, rh, ra}), now: Map(teamId -> {settled, remaining, points}) }
function simulate(season, cuts, G) {
  const ids = [...new Set(season.flatMap((m) => [m.h, m.a]))];
  const n = ids.length;
  const ix = new Map(ids.map((id, i) => [id, i]));
  if (n < 8) return { ok: false, reason: 'few-teams', n };
  const gT = G || 2 * (n - 1);
  const P = new Array(n).fill(0), Pl = new Array(n).fill(0);
  const flags = new Map();
  const c = cuts && cuts.length ? cuts.filter((x) => x < n) : [1, Math.max(2, n - 3)];
  for (const m of season) {
    const hi = ix.get(m.h), ai = ix.get(m.a);
    const Rm = Pl.map((p) => gT - p);
    if (Rm.some((r) => r < 0)) return { ok: false, reason: 'format', n, G: gT };
    flags.set(m.id, { h: settledOf(hi, P, Rm, c), a: settledOf(ai, P, Rm, c), rh: Rm[hi], ra: Rm[ai] });
    Pl[hi]++; Pl[ai]++;
    if (m.hg > m.ag) P[hi] += 3; else if (m.hg < m.ag) P[ai] += 3; else { P[hi]++; P[ai]++; }
  }
  if (Pl.some((p) => p > gT)) return { ok: false, reason: 'format', n, G: gT };
  const complete = Pl.every((p) => p === gT);
  const spread = Math.max(...Pl) - Math.min(...Pl);
  if (complete === false && spread > 4) return { ok: false, reason: 'gaps', n, G: gT };
  const Rm = Pl.map((p) => gT - p);
  const nowMap = new Map();
  ids.forEach((id, i) => nowMap.set(id, { settled: settledOf(i, P, Rm, c), remaining: Rm[i], points: P[i], played: Pl[i] }));
  return { ok: true, n, G: gT, complete, flags, now: nowMap };
}

// Tüm lig geçmişi: kullanılabilir sezonlar. own: lig maçları, windowStart: eğitim verisinin başladığı an
function analyzeLeague(own, cuts, windowStart) {
  const seasons = splitSeasons(own);
  const flags = new Map();
  let current = null;
  let used = 0, reason = null;
  seasons.forEach((s, k) => {
    const last = k === seasons.length - 1;
    if (s.length < 60) return;
    if (s[0].t < windowStart + 14 * DAY) return; // başı eksik (veri penceresinden önce başlamış)
    const sim = simulate(s, cuts);
    if (!sim.ok) { reason = reason || sim.reason; return; }
    if (!sim.complete && !last) { reason = reason || 'incomplete'; return; }
    used++;
    for (const [id, f] of sim.flags) flags.set(id, f);
    if (last && !sim.complete) current = { ...sim, season: k };
  });
  return { flags, current, seasonsUsed: used, reason: used ? null : reason || 'no-season' };
}

// feed: [{hg, ag, lh, la, sh, sa}]; sh/sa: ev/dep takımın işi bitmiş mi (boolean) — null: bilinmiyor
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (!f || f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0) || f.sh == null || f.sa == null) continue;
    const sh = f.sh ? 1 : 0, sa = f.sa ? 1 : 0;
    rows.push({ y: f.hg, mu: f.lh, x: [sh, sa] });
    rows.push({ y: f.ag, mu: f.la, x: [sa, sh] });
  }
  return rows;
}

function estimate(rows) {
  const r = GLM.fit(rows, 2, { minRows: 120, minActive: 25 });
  const nOwn = rows.reduce((s, x) => s + x.x[0], 0), nOpp = rows.reduce((s, x) => s + x.x[1], 0);
  if (!r.enough) return { enough: false, n: rows.length / 2, nOwn, nOpp };
  const ratio = (arr) => (arr.length >= 8 ? arr.reduce((s, x) => s + x.y, 0) / arr.reduce((s, x) => s + x.mu, 0) : null);
  const settledRows = rows.filter((x) => x.x[0] && !x.x[1]), normalRows = rows.filter((x) => !x.x[0] && !x.x[1]), oppRows = rows.filter((x) => x.x[1] && !x.x[0]);
  return {
    enough: true, n: rows.length / 2, nOwn, nOpp, a: r.beta[0], d: r.beta[1], se: r.se ? { a: r.se[0], d: r.se[1] } : null, LR: r.LR, crit: r.crit, significant: r.significant,
    beta: r.beta, info: r.info,
    applied: r.significant ? { a: r.beta[0] * SHR, d: r.beta[1] * SHR } : null,
    ratios: { settled: ratio(settledRows), normal: ratio(normalRows), oppSettled: ratio(oppRows) },
  };
}

function pool(list) { return GLM.pool(list, 2, 3); }

function factors(k, sh, sa) {
  if (!k) return { home: 1, away: 1 };
  const a = sh ? 1 : 0, b = sa ? 1 : 0;
  return { home: Math.exp(k.a * a + k.d * b), away: Math.exp(k.a * b + k.d * a) };
}

module.exports = { splitSeasons, cutsFromRows, settledOf, simulate, analyzeLeague, buildRows, estimate, pool, factors, SHR };
