'use strict';
// Kupa ve eleme: iki maçlı turda (ya da tek maçlı eleme turunda) tur atlama olasılığı.
// Toplam skor farkı iki maçın 90 dakikalık gol farkı dağılımlarından bulunur. Toplam eşitse uzatma (30 dk), hâlâ eşitse penaltı.
// Varsayımlar: penaltı 50-50 (ölçülebilir bir fark yok), deplasman golü kuralı yok (UEFA 2021'de kaldırdı).
// Uzatmada gol hızı: varsa ligin gerçek uzatma/penaltı sayılarından ölçülür, yoksa varsayılan çarpan kullanılır.

const KO_RE = /final|round-of|knockout|play-?off|quarter|semi|last-?\d/i;
const NOT_KO_RE = /group|league-phase|league-stage|regular|qualif/i;
const ET_DEFAULT = 0.9; // uzatmada dakika başına gol, normal süreye göre (varsayılan; ölçülemiyorsa)
const ET_FRAC = 30 / 90;
const MAXG = 12;

function pmf(l, n = MAXG) {
  const out = new Array(n + 1);
  let p = Math.exp(-l);
  out[0] = p;
  for (let k = 1; k <= n; k++) { p = (p * l) / k; out[k] = p; }
  const s = out.reduce((a, b) => a + b, 0);
  return out.map((v) => v / s);
}
// iki bağımsız Poisson farkı: {fark: olasılık}
function diffIndep(lx, ly) {
  const a = pmf(lx), b = pmf(ly);
  const d = new Map();
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) d.set(i - j, (d.get(i - j) || 0) + a[i] * b[j]);
  return d;
}
// grid[ev][dep] -> X'in bakışından fark. hostIsX: X ev sahibiyse
function diffFromGrid(grid, hostIsX) {
  const d = new Map();
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) {
    const k = hostIsX ? i - j : j - i;
    d.set(k, (d.get(k) || 0) + grid[i][j]);
  }
  return d;
}
function convolve(A, B) {
  const out = new Map();
  for (const [a, pa] of A) for (const [b, pb] of B) out.set(a + b, (out.get(a + b) || 0) + pa * pb);
  return out;
}
function shift(A, k) {
  if (!k) return A;
  const out = new Map();
  for (const [a, p] of A) out.set(a + k, p);
  return out;
}

// uzatma (30 dk): X kazanır / berabere / Y kazanır
function etSplit(lx, ly, f) {
  const d = diffIndep(lx * ET_FRAC * f, ly * ET_FRAC * f);
  let x = 0, y = 0, e = 0;
  for (const [k, p] of d) { if (k > 0) x += p; else if (k < 0) y += p; else e += p; }
  return { x, d: e, y };
}

// Uzatmaya giden maçların kaçı uzatmada biter? Gerçek sayılardan uzatma gol hızı çarpanını bul.
function calibrateEt(et, avgTotal) {
  const aet = (et && et.aet) || 0, pen = (et && et.pen) || 0, n = aet + pen;
  if (n < 40) return { f: ET_DEFAULT, measured: false, n };
  const target = (aet + 0.5 * 10) / (n + 10); // 10 sanal maçla %50'ye doğru çek
  const per = Math.max(0.6, Number(avgTotal) || 2.6) / 2;
  const resolved = (f) => 1 - etSplit(per, per, f).d;
  let lo = 0.4, hi = 1.6;
  if (resolved(lo) > target) return { f: lo, measured: true, n, observed: aet / n };
  if (resolved(hi) < target) return { f: hi, measured: true, n, observed: aet / n };
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (resolved(mid) < target) lo = mid; else hi = mid; }
  return { f: (lo + hi) / 2, measured: true, n, observed: aet / n };
}

// legs: sırayla oynanan maçlar. Her biri:
//   { host:'x'|'y', state:'pre'|'in'|'post', gx, gy (biten/süren maçta skor), lx, ly (tam maç gol beklentisi, X ve Y), grid (varsa; ev, dep), remain (0-1, süren maçta kalan pay) }
// Dönüş: { decided, agg:{x,y}, diffNow, advance:{x,y}, in90:{x,y,level}, et:{x,y}, pens:{x,y,total}, levelProb }
function compute(legs, f = ET_DEFAULT, penX = 0.5) {
  let K = 0, gxTot = 0, gyTot = 0;
  let dist = new Map([[0, 1]]);
  let last = null;
  let pending = 0;
  for (const g of legs) {
    if (g.state === 'post') { K += g.gx - g.gy; gxTot += g.gx; gyTot += g.gy; continue; }
    pending++;
    if (g.state === 'in') {
      K += (g.gx || 0) - (g.gy || 0); gxTot += g.gx || 0; gyTot += g.gy || 0;
      const r = Math.max(0.02, Math.min(1, g.remain == null ? 0.5 : g.remain));
      dist = convolve(dist, diffIndep(g.lx * r, g.ly * r));
      last = g;
    } else {
      dist = convolve(dist, g.grid ? diffFromGrid(g.grid, g.host === 'x') : diffIndep(g.lx, g.ly));
      last = g;
    }
  }
  const agg = { x: gxTot, y: gyTot };
  if (!pending) {
    return { decided: true, agg, diffNow: K, advance: K > 0 ? { x: 1, y: 0 } : K < 0 ? { x: 0, y: 1 } : null };
  }
  const D = shift(dist, K);
  let px = 0, py = 0, p0 = 0;
  for (const [k, p] of D) { if (k > 0) px += p; else if (k < 0) py += p; else p0 += p; }
  const et = etSplit(last.lx, last.ly, f);
  const etx = p0 * et.x, ety = p0 * et.y, pens = p0 * et.d;
  return {
    decided: false, agg, diffNow: K, levelProb: p0,
    advance: { x: px + etx + pens * penX, y: py + ety + pens * (1 - penX) },
    in90: { x: px, y: py, level: p0 },
    et: { x: etx, y: ety, total: etx + ety },
    pens: { x: pens * penX, y: pens * (1 - penX), total: pens },
  };
}

const isKnockoutRound = (round) => !!round && KO_RE.test(round) && !NOT_KO_RE.test(round);

module.exports = { pmf, diffIndep, diffFromGrid, convolve, etSplit, calibrateEt, compute, isKnockoutRound, ET_DEFAULT };
