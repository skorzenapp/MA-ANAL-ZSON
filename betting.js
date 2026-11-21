'use strict';
// Model ve piyasa: (1) iki olasılığı karıştırmanın faydası, (2) "model piyasadan X puan farklıysa oyna" stratejisinin sanal kâr/zararı.
// Piyasa olasılıkları ESPN maç özetindeki oranlardan marjı atılarak alınır (maçtan önceki mi, kapanış mı olduğu belirsizdir).
// Model olasılıkları, her maç için o güne kadarki verilerle (haftalık yeniden uyum) hesaplanmıştır, yani geleceği görmez.

const Z_BLEND = 1.64; // karışımın modelden iyi sayılması için eşleştirilmiş fark testi eşiği
const Z_BET = 2.2; // sanal kâr için daha sıkı eşik (birkaç eşik denendiği için)

const sum = (a) => a.reduce((s, v) => s + v, 0);
const brier = (p, y) => p.reduce((s, v, k) => s + (v - (k === y ? 1 : 0)) ** 2, 0);
const logloss = (p, y) => -Math.log(Math.max(1e-9, p[y]));
const mix = (pm, pk, w) => { const q = pm.map((v, k) => (1 - w) * v + w * pk[k]); const s = sum(q); return q.map((v) => v / s); };

// list: [{t, pm:[ev,ber,dep], pk:[...], dec:[...], y: 0|1|2}] -> geçerli satırlar, eskiden yeniye
function buildRows(list) {
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v) && v > 0);
  return list.filter((r) => r && ok(r.pm) && ok(r.pk) && ok(r.dec) && r.dec.every((d) => d > 1) && (r.y === 0 || r.y === 1 || r.y === 2)).sort((a, b) => a.t - b.t);
}

function pairedZ(diffs) {
  const n = diffs.length;
  if (n < 5) return 0;
  const m = sum(diffs) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
}

function bestW(rows) {
  let best = { w: 0, b: Infinity };
  for (let k = 0; k <= 20; k++) {
    const w = k / 20;
    const b = sum(rows.map((r) => brier(mix(r.pm, r.pk, w), r.y))) / rows.length;
    if (b < best.b - 1e-12) best = { w, b };
  }
  return best.w;
}

function analyzeBlend(rows) {
  const n = rows.length;
  if (n < 80) return { enough: false, n };
  const split = Math.floor(n * 0.6);
  const sel = rows.slice(0, split), test = rows.slice(split);
  const wSel = bestW(sel), wAll = bestW(rows);
  const avg = (arr, f) => sum(arr.map(f)) / arr.length;
  const bt = {
    model: avg(test, (r) => brier(r.pm, r.y)), market: avg(test, (r) => brier(r.pk, r.y)), blend: avg(test, (r) => brier(mix(r.pm, r.pk, wSel), r.y)),
  };
  const lt = {
    model: avg(test, (r) => logloss(r.pm, r.y)), market: avg(test, (r) => logloss(r.pk, r.y)), blend: avg(test, (r) => logloss(mix(r.pm, r.pk, wSel), r.y)),
  };
  const zVsModel = pairedZ(test.map((r) => brier(r.pm, r.y) - brier(mix(r.pm, r.pk, wSel), r.y)));
  const zVsMarket = pairedZ(test.map((r) => brier(r.pk, r.y) - brier(mix(r.pm, r.pk, wSel), r.y)));
  const zMarketVsModel = pairedZ(test.map((r) => brier(r.pm, r.y) - brier(r.pk, r.y)));
  const adopted = test.length >= 30 && bt.blend < bt.model && zVsModel >= Z_BLEND && wAll > 0;
  const bAll = { model: avg(rows, (r) => brier(r.pm, r.y)), market: avg(rows, (r) => brier(r.pk, r.y)), blend: avg(rows, (r) => brier(mix(r.pm, r.pk, wAll), r.y)) };
  return { enough: true, n, nSel: sel.length, nTest: test.length, wSel, wAll, brierTest: bt, loglossTest: lt, brierAll: bAll, zVsModel, zVsMarket, zMarketVsModel, adopted, applied: adopted ? wAll : null };
}

// th: model olasılığı - piyasa olasılığı en az bu kadar olan sonuca 1 birim oyna (piyasanın gerçek oranıyla)
function analyzeBets(rows, ths = [0.03, 0.05, 0.08, 0.12]) {
  const n = rows.length;
  if (n < 80) return { enough: false, n };
  const over = sum(rows.map((r) => sum(r.dec.map((d) => 1 / d)) - 1)) / n;
  const strat = (th) => {
    const pr = [];
    for (const r of rows) {
      let k = 0, e = -1;
      for (let j = 0; j < 3; j++) { const d = r.pm[j] - r.pk[j]; if (d > e) { e = d; k = j; } }
      if (e >= th) pr.push(r.y === k ? r.dec[k] - 1 : -1);
    }
    const m = pr.length;
    const roi = m ? sum(pr) / m : null;
    const sd = m > 1 ? Math.sqrt(pr.reduce((s, v) => s + (v - roi) ** 2, 0) / (m - 1)) : 0;
    const se = m > 1 ? sd / Math.sqrt(m) : null;
    const z = se ? roi / se : 0;
    return { th, bets: m, wins: pr.filter((v) => v > 0).length, profit: sum(pr), roi, se, z, lo: se != null ? roi - 1.96 * se : null, hi: se != null ? roi + 1.96 * se : null, verdict: m >= 40 && z >= Z_BET ? 'profit' : m >= 40 && z <= -Z_BET ? 'loss' : m < 40 ? 'few' : 'unclear' };
  };
  return { enough: true, n, overround: over, rows: ths.map(strat), all: strat(-1) };
}

module.exports = { buildRows, analyzeBlend, analyzeBets, mix, brier, pairedZ, Z_BLEND, Z_BET };
