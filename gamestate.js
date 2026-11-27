'use strict';
// Maç içi skor durumu ve dakika etkisi (canlı olasılıklar için).
// Soru: önde ya da geride olan takım kalan dakikalarda beklenenden farklı gol atıyor mu? Gol hızı dakikaya göre sabit mi?
// Yöntem: her maç, gol dakikalarında ve her 15 dakikada bölünür; her parçada o takımın skor durumu (önde / berabere / geride) ve dakika dilimi bilinir.
// Poisson regresyon (glm.js): log λ = log mu + c + a·önde + b·geride + dilim etkileri; mu = modelin maç beklentisi × parçanın dakika payı (model.shareDone).
// Etkiler anlamlıysa canlı olasılıklar, dakika dakika ilerleyen bir hesapla (her dakika skor durumuna göre gol hızı) yeniden hesaplanır.
// Doğrulama: maçların ilk %60'ı ile ölçülür, son %40'ında 20/45/65/80. dakikalarda "maç sonucu" tahmini eski (sabit hızlı) canlı modelle karşılaştırılır.

const GLM = require('./glm');
const M = require('./model');

const SHR = 0.7;
const Z_MIN = 2.6; // 7 özellik birlikte denendiği için tek tek z ≥ 2,6
const END = 90;
const G = 12;
const BIN = 15;
const FEATS = [
  { key: 'lead', label: 'Önde olan takımın golü' },
  { key: 'trail', label: 'Geride olan takımın golü' },
  { key: 'b1', label: '15–30. dakika', bin: 1 },
  { key: 'b2', label: '30–45. dakika', bin: 2 },
  { key: 'b3', label: '45–60. dakika', bin: 3 },
  { key: 'b4', label: '60–75. dakika', bin: 4 },
  { key: 'b5', label: '75–90. dakika', bin: 5 },
];
const CHECKPOINTS = [20, 45, 65, 80];

const gt = (min) => Math.max(0, Math.min(END - 0.5, min - 0.5)); // gol dakikası → o dakikanın ortası

// feed: [{hg, ag, lh, la, goals:[{min, side}], share}]  ->  satırlar [{y, mu, x:[1, önde, geride, b1..b5]}]
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (!f || !f.goals || f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0)) continue;
    const times = f.goals.map((g) => ({ t: gt(g.min), side: g.side })).sort((a, b) => a.t - b.t);
    const cuts = [...new Set([0, 15, 30, 45, 60, 75, END, ...times.map((g) => g.t)])].sort((a, b) => a - b);
    for (const side of ['h', 'a']) {
      const lam = side === 'h' ? f.lh : f.la;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i], b = cuts[i + 1];
        const share = M.shareDone(b, f.share) - M.shareDone(a, f.share);
        if (!(share > 1e-4)) continue;
        let d = 0, y = 0;
        for (const g of times) {
          const own = g.side === side;
          if (g.t <= a) d += own ? 1 : -1;
          else if (g.t <= b && own) y++; // (a, b]: golün olduğu an, onu getiren parçaya (gol öncesi duruma) yazılır
        }
        const bin = Math.min(5, Math.floor(a / BIN));
        const x = [1, d > 0 ? 1 : 0, d < 0 ? 1 : 0, 0, 0, 0, 0, 0];
        if (bin >= 1) x[2 + bin] = 1;
        rows.push({ y, mu: lam * share, x });
      }
    }
  }
  return rows;
}

function estimate(rows) {
  const k = FEATS.length + 1;
  const cnt = {};
  FEATS.forEach((f, j) => { cnt[f.key] = rows.filter((r) => r.x[j + 1]).length; });
  const empty = { enough: false, n: rows.length, counts: cnt };
  if (rows.length < 600 || FEATS.some((f) => cnt[f.key] < 30)) return empty;
  const r = GLM.fit(rows, k, { minRows: 600, minActive: 30 });
  if (!r.enough || !r.se) return empty;
  const base = (arr) => (arr.length >= 10 ? arr.reduce((s, x) => s + x.y, 0) / arr.reduce((s, x) => s + x.mu, 0) : null);
  const feats = FEATS.map((f, j) => {
    const b = r.beta[j + 1], se = r.se[j + 1], z = se > 0 ? b / se : 0;
    const on = rows.filter((x) => x.x[j + 1]);
    return { key: f.key, label: f.label, n: cnt[f.key], goals: on.reduce((s, x) => s + x.y, 0), beta: b, se, z, prec: se > 0 ? 1 / (se * se) : 0, adopted: Math.abs(z) >= Z_MIN, ratio: base(on) };
  });
  const applied = {};
  for (const f of feats) if (f.adopted) applied[f.key] = f.beta * SHR;
  return { enough: true, n: rows.length, counts: cnt, feats, LR: r.LR, significant: r.significant, applied: Object.keys(applied).length ? applied : null, ratioBase: base(rows.filter((x) => !x.x[1] && !x.x[2] && !x.x[3] && !x.x[4] && !x.x[5] && !x.x[6] && !x.x[7])) };
}

// Birden çok ligin ölçümü: özellik başına ters varyans ağırlıklı ortalama (en az 3 lig)
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

// ---- dakika dakika canlı hesap ----
// k: {lead, trail, b1..b5} (log çarpanlar; yoksa 0). d: bu takım açısından skor farkı, m: dakika
function mul(k, d, m) {
  const bin = Math.min(5, Math.floor(m / BIN));
  return Math.exp((d > 0 ? k.lead || 0 : d < 0 ? k.trail || 0 : 0) + (bin ? k['b' + bin] || 0 : 0));
}
function dpRun(lh, la, from, hg, ag, k, share, kappa) {
  let P = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(0));
  P[Math.min(G, hg)][Math.min(G, ag)] = 1;
  let N = 1, fh = 0, fa = 0;
  const d0 = hg - ag;
  const step = (m, dsh) => {
    const Q = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(0));
    for (let i = 0; i <= G; i++) {
      for (let j = 0; j <= G; j++) {
        const v = P[i][j];
        if (v < 1e-14) continue;
        const d = i - j;
        const ph = Math.min(0.95, kappa * lh * dsh * mul(k, d, m)), pa = Math.min(0.95, kappa * la * dsh * mul(k, -d, m)); // dakikada en çok 1 gol; olasılık = hız (beklenen gol korunur)
        const i1 = Math.min(G, i + 1), j1 = Math.min(G, j + 1);
        Q[i][j] += v * (1 - ph) * (1 - pa);
        Q[i1][j] += v * ph * (1 - pa);
        Q[i][j1] += v * (1 - ph) * pa;
        Q[i1][j1] += v * ph * pa;
      }
    }
    P = Q;
    const rh = kappa * lh * dsh * mul(k, d0, m), ra = kappa * la * dsh * mul(k, -d0, m), rt = rh + ra;
    if (rt > 0) { const any = 1 - Math.exp(-rt); fh += N * any * (rh / rt); fa += N * any * (ra / rt); N *= Math.exp(-rt); }
  };
  const start = Math.max(0, Math.floor(from));
  for (let m = start; m < END; m++) step(m, M.shareDone(m + 1, share) - M.shareDone(m, share));
  step(END - 1, from >= END ? 0.01 : Math.max(0, 1 - M.shareDone(END, share)));
  return { P, fh, fa, N };
}
// lh/la: 90 dakikalık beklenen goller (kırmızı kart çarpanı dahil olabilir). Çıktı biçimi model.liveMarkets ile aynı.
function liveDP(lh, la, minute, hg, ag, k, share = 0.46) {
  k = k || {};
  const has = Object.values(k).some((v) => v);
  let kappa = 1;
  if (has) {
    // maç başında toplam gol beklentisi modelinkiyle aynı kalsın (etkiler gol sayısını değil, dağılımını değiştirir)
    const r0 = dpRun(lh, la, 0, 0, 0, k, share, 1);
    let e = 0;
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) e += r0.P[i][j] * (i + j);
    if (e > 0) kappa = Math.min(1.5, Math.max(0.67, (lh + la) / e));
  }
  const r = dpRun(lh, la, minute, hg, ag, k, share, kappa);
  let sum = 0, eh = 0, ea = 0;
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) sum += r.P[i][j];
  if (sum > 0) for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) { r.P[i][j] /= sum; eh += r.P[i][j] * (i - hg); ea += r.P[i][j] * (j - ag); }
  return { minute, score: { home: hg, away: ag }, remaining: { home: eh, away: ea }, markets: M.markets(r.P), nextGoal: { home: r.fh, away: r.fa, none: r.N }, kappa };
}

// k katsayıları (anlamlı özelliklerin %70'i) ile eski (sabit hızlı) canlı modelin karşılaştırması: son %40 maçta 1X2 log kaybı
function evaluate(feed) {
  const list = feed.filter((f) => f && f.goals && f.lh > 0 && f.la > 0);
  const cut = Math.floor(list.length * 0.6);
  const train = list.slice(0, cut), test = list.slice(cut);
  const est = estimate(buildRows(train));
  if (!est.enough || test.length < 60) return { enough: false, nTrain: train.length, nTest: test.length };
  if (!est.applied) return { enough: true, applicable: false, nTrain: train.length, nTest: test.length, adopted: false, z: 0, gain: 0, reason: 'none' };
  const k = est.applied;
  const diffs = [];
  let sa = 0, sb = 0, nn = 0;
  for (const f of test) {
    const res = f.hg > f.ag ? 'home' : f.hg === f.ag ? 'draw' : 'away';
    let d = 0, c = 0;
    for (const cp of CHECKPOINTS) {
      const hg = f.goals.filter((g) => g.side === 'h' && g.min <= cp).length, ag = f.goals.filter((g) => g.side === 'a' && g.min <= cp).length;
      const A = M.liveMarkets(f.lh, f.la, cp, hg, ag, f.share).markets[res], B = liveDP(f.lh, f.la, cp, hg, ag, k, f.share).markets[res];
      const la_ = -Math.log(Math.max(1e-6, A)), lb_ = -Math.log(Math.max(1e-6, B));
      d += la_ - lb_; sa += la_; sb += lb_; nn++; c++;
    }
    diffs.push(d / c);
  }
  const n = diffs.length, mean = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const z = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { enough: true, applicable: true, nTrain: train.length, nTest: n, llStatic: sa / nn, llDyn: sb / nn, gain: mean, z, adopted: mean > 0 && z >= 1.64, trainApplied: k };
}

module.exports = { FEATS, SHR, Z_MIN, CHECKPOINTS, buildRows, estimate, pool, mul, liveDP, evaluate };
