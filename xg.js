'use strict';
// Şut bazlı "beklenen gol" (xG benzeri) göstergesi.
// ESPN şut konumu vermiyor; elimizde takımın toplam şutu ve isabetli şutu var. Bunlardan basit bir regresyonla
// "şut kalitesine göre beklenen gol" üretiriz:  xG ≈ a·(isabetli şut) + b·(isabetsiz şut).
// Katsayılar ligin kendi maçlarından (en küçük kareler, negatif olamaz) bulunur ve toplam xG = toplam gol olacak şekilde ölçeklenir.
// Modele katılıp katılmayacağına model.tune karar verir (dışarıda test).

const num = (v) => {
  if (v == null || v === '') return null;
  const x = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(x) ? x : null;
};

// st: takımın maç istatistikleri (ESPN teamStats nesnesi)
function shotsOf(st) {
  if (!st) return null;
  const shots = num(st.totalShots), sot = num(st.shotsOnTarget);
  if (shots == null || sot == null || shots < 0 || sot < 0 || sot > shots) return null;
  return { shots, sot, off: shots - sot };
}

// rows: [{sot, off, g}]
function fitCoef(rows) {
  const n = rows.length;
  if (n < 60) return null;
  let sss = 0, soo = 0, sso = 0, sgs = 0, sgo = 0, sg = 0;
  for (const r of rows) { sss += r.sot * r.sot; soo += r.off * r.off; sso += r.sot * r.off; sgs += r.g * r.sot; sgo += r.g * r.off; sg += r.g; }
  const det = sss * soo - sso * sso;
  let a, b;
  if (Math.abs(det) < 1e-9) { a = sgs / (sss || 1); b = 0; }
  else { a = (sgs * soo - sgo * sso) / det; b = (sgo * sss - sgs * sso) / det; }
  if (a < 0) { a = 0; b = sgo / (soo || 1); }
  if (b < 0) { b = 0; a = sgs / (sss || 1); }
  if (a < 0) a = 0;
  if (a === 0 && b === 0) return null;
  let tot = 0;
  for (const r of rows) tot += a * r.sot + b * r.off;
  if (tot <= 0) return null;
  const k = sg / tot;
  a *= k; b *= k;
  // gol ile xG arasındaki korelasyon (maç-takım düzeyinde)
  let mx = 0, my = 0;
  const xs = rows.map((r) => a * r.sot + b * r.off);
  for (let i = 0; i < n; i++) { mx += xs[i]; my += rows[i].g; }
  mx /= n; my /= n;
  let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < n; i++) { cxy += (xs[i] - mx) * (rows[i].g - my); cxx += (xs[i] - mx) ** 2; cyy += (rows[i].g - my) ** 2; }
  const corr = cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : 0;
  return { a, b, corr, n, meanGoals: my };
}

const xgOf = (coef, sh) => (coef && sh ? coef.a * sh.sot + coef.b * sh.off : null);

// own: [{id, h, a, hg, ag}], recs: aynı sıradaki maç kayıtları (teamStats ile)
function build(own, recs) {
  const rows = [];
  const per = [];
  own.forEach((m, i) => {
    const ts = recs[i] && recs[i].teamStats;
    if (!ts) return;
    const sh = shotsOf(ts[m.h]), sa = shotsOf(ts[m.a]);
    if (!sh || !sa) return;
    rows.push({ sot: sh.sot, off: sh.off, g: m.hg }, { sot: sa.sot, off: sa.off, g: m.ag });
    per.push({ id: m.id, sh, sa });
  });
  const coef = fitCoef(rows);
  if (!coef) return { enough: false, n: per.length };
  const map = {};
  for (const p of per) map[p.id] = [Math.round(xgOf(coef, p.sh) * 1000) / 1000, Math.round(xgOf(coef, p.sa) * 1000) / 1000];
  return { enough: true, n: per.length, coef: { a: coef.a, b: coef.b }, corr: coef.corr, map };
}

module.exports = { shotsOf, fitCoef, xgOf, build };
