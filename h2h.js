'use strict';
// Karşılaşma geçmişi (H2H): iki takımın birbirine karşı geçmişi + "geçmiş maçın sürprizi sonraki maçın golünü etkiliyor mu?" ölçümü.
// Ölçüm: aynı iki takımın önceki lig maçında (modelin beklentisine göre) ev sahibi takım kaç gol "fazla" yaptıysa (sürpriz), bu maçın golleri
// modelin beklentisinden o yönde sapıyor mu? Poisson regresyon: log λ = log mu + c + β·sürpriz (ev sahibi için +, deplasman için −). Etki ancak z ≥ 2 ise anlamlı sayılır.
// Bu sürümde sonuç yalnızca BİLGİDİR: tahmine katılmaz.

const GLM = require('./glm');

const SHR = 0.7;
const Z_MIN = 2.0;
const CAP = 3; // sürprizin (gol farkı) en çok ±3 sayılır

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// meetings: [{t, home (bool: şu anki ev sahibi takım o maçta ev sahibiydi), gh, ga (şu anki ev sahibi / deplasman takımın golü)}] yeniden eskiye
function summarize(ms) {
  const n = ms.length;
  const out = { n, w: 0, d: 0, l: 0, gf: 0, ga: 0, avgGoals: null, over25: null, btts: null, atHome: { n: 0, w: 0, d: 0, l: 0 } };
  if (!n) return out;
  let o25 = 0, bt = 0;
  for (const m of ms) {
    out.gf += m.gh; out.ga += m.ga;
    const r = m.gh > m.ga ? 'w' : m.gh === m.ga ? 'd' : 'l';
    out[r]++;
    if (m.gh + m.ga > 2) o25++;
    if (m.gh > 0 && m.ga > 0) bt++;
    if (m.home) { out.atHome.n++; out.atHome[r]++; }
  }
  out.avgGoals = (out.gf + out.ga) / n; out.over25 = o25 / n; out.btts = bt / n;
  return out;
}

// feed (zaman sırasıyla): [{pair, home, hg, ag, lh, la}] -> her maç için önceki karşılaşmaların sürprizi (ev sahibi takım açısından)
function withSurprise(feed) {
  const hist = new Map();
  const out = [];
  for (const f of feed) {
    const key = f.pair;
    const prior = hist.get(key) || [];
    let x = null;
    if (prior.length) {
      const last = prior.slice(-2);
      x = last.reduce((s, p) => s + (p.home === f.home ? p.res : -p.res), 0) / last.length;
      x = Math.max(-CAP, Math.min(CAP, x));
    }
    out.push({ ...f, x });
    if (f.lh > 0 && f.la > 0) { prior.push({ home: f.home, res: f.hg - f.ag - (f.lh - f.la) }); hist.set(key, prior); }
  }
  return out;
}
function buildRows(items) {
  const rows = [];
  for (const f of items) {
    if (f.x == null || !(f.lh > 0) || !(f.la > 0)) continue;
    rows.push({ y: f.hg, mu: f.lh, x: [1, f.x] });
    rows.push({ y: f.ag, mu: f.la, x: [1, -f.x] });
  }
  return rows;
}
function estimate(rows) {
  const n = rows.length / 2;
  if (n < 60) return { enough: false, n };
  const r = GLM.fit(rows, 2, { minRows: 120, minActive: 20 });
  if (!r.enough || !r.se) return { enough: false, n };
  const b = r.beta[1], se = r.se[1], z = se > 0 ? b / se : 0;
  const feat = { key: 'h2h', label: 'Önceki karşılaşmanın sürprizi', beta: b, se, z, prec: se > 0 ? 1 / (se * se) : 0, adopted: Math.abs(z) >= Z_MIN };
  return { enough: true, n, feats: [feat], beta: b, se, z, adopted: feat.adopted, applied: feat.adopted ? b * SHR : null, pct: (Math.exp(b) - 1) * 100 };
}
function pool(list) {
  const L = list.filter((x) => x && x.feats && x.feats.h2h && x.feats.h2h.prec > 0);
  if (L.length < 3) return { enough: false, leagues: L.length };
  const P = L.reduce((s, x) => s + x.feats.h2h.prec, 0);
  const beta = L.reduce((s, x) => s + x.feats.h2h.prec * x.feats.h2h.beta, 0) / P;
  const z = beta * Math.sqrt(P);
  return { enough: true, leagues: L.length, beta, se: 1 / Math.sqrt(P), z, significant: Math.abs(z) >= Z_MIN, pct: (Math.exp(beta) - 1) * 100 };
}

module.exports = { SHR, Z_MIN, CAP, norm, summarize, withSurprise, buildRows, estimate, pool };
