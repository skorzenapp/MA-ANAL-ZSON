'use strict';
// Korner / kart modeli (arayüzdeki "Korner & Kart" sekmesinin aynısı) ve yürüyen geriye test.
// Arayüzdeki ML / s2 / l2 / _o işlevlerinin sunucuya taşınmış hali: formül değişirse ikisi birlikte değişmeli.

const PRIOR_N = 10;

// Negatif binom (aşırı yayılma varsa) ya da Poisson olasılık dizisi
function nbPmf(mean, ratio, max = 40) {
  const out = [];
  if (ratio <= 1.03) {
    let a = Math.exp(-mean);
    for (let s = 0; s <= max; s++) { if (s > 0) a *= mean / s; out.push(a); }
  } else {
    const a = mean / (ratio - 1), s = a / (a + mean);
    let u = Math.pow(s, a);
    for (let c = 0; c <= max; c++) { if (c > 0) u *= ((c - 1 + a) / c) * (1 - s); out.push(u); }
  }
  const tot = out.reduce((x, y) => x + y, 0);
  return out.map((x) => x / tot);
}
const pOver = (pmf, line) => pmf.reduce((s, v, i) => (i > line ? s + v : s), 0);

function dispersion(arr) {
  if (arr.length < 5) return 1.3;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.max(1, Math.min(2.2, m ? v / m : 1));
}

// list: takımın maçları, EN YENİ başta: [{ha:'home'|'away', sp:{c,ca,y,ya,...}}]
function sideStats(list, role) {
  const n = list.slice(0, 15);
  if (n.length < 3) return null;
  const wavg = (arr, f) => {
    let p = 0, m = 0;
    arr.forEach((g, x) => { const j = f(g.sp); if (j == null) return; const w = Math.pow(0.92, x); p += j * w; m += w; });
    return m ? p / m : null;
  };
  const v = n.filter((c) => c.ha === role);
  const s = v.length / (v.length + 6);
  const u = (f) => { const a = wavg(n, f), b = v.length ? wavg(v, f) : null; return a == null ? null : b == null ? a : b * s + a * (1 - s); };
  return { cFor: u((c) => c.c), cAg: u((c) => c.ca), yFor: u((c) => c.y), yAg: u((c) => c.ya), n: n.length, list: n.map((x) => x.sp) };
}

// iki takımın geçmişinden beklenen korner ve sarı kart
function expected(homeList, awayList) {
  const i = sideStats(homeList, 'home'), a = sideStats(awayList, 'away');
  if (!i || !a) return null;
  const all = [...i.list, ...a.list];
  const u = all.reduce((s, q) => s + q.c + q.ca, 0) / (2 * all.length);
  const c = all.reduce((s, q) => s + q.y + q.ya, 0) / (2 * all.length);
  const f = (M, q, L) => (M * q + L * PRIOR_N) / (q + PRIOR_N);
  const ch = (f(i.cFor, i.n, u) + f(a.cAg, a.n, u)) / 2, ca = (f(a.cFor, a.n, u) + f(i.cAg, i.n, u)) / 2;
  const yh = (f(i.yFor, i.n, c) + f(a.yAg, a.n, c)) / 2, ya = (f(a.yFor, a.n, c) + f(i.yAg, i.n, c)) / 2;
  const rc = dispersion(all.map((q) => q.c + q.ca)), ry = dispersion(all.map((q) => q.y + q.ya));
  return {
    corners: { t: ch + ca, total: nbPmf(ch + ca, rc, 40) },
    cards: { t: yh + ya, total: nbPmf(yh + ya, ry, 25) },
    base: { corners: { mean: u * 2, ratio: rc }, cards: { mean: c * 2, ratio: ry } },
  };
}

// recs: [{t, h, a, sp:{c,ca,y,ya}}]  (h/a: ev/deplasman takım kimliği; sp: ev sahibi açısından c = ev korneri, ca = deplasman korneri ...)
// Her test maçı için sadece ondan ÖNCEKİ maçlar kullanılır (geleceği görmez).
function backtestSp(recs, { minTest = 20 } = {}) {
  const sorted = recs.filter((r) => r.sp).sort((x, y) => x.t - y.t);
  const byTeam = new Map(); // takım -> [{t, ha, sp}] eskiden yeniye
  const add = (id, e) => { let a = byTeam.get(id); if (!a) { a = []; byTeam.set(id, a); } a.push(e); };
  const rows = [];
  const flip = (sp) => ({ c: sp.ca, ca: sp.c, y: sp.ya, ya: sp.y });
  let sumC = 0, sumY = 0, nAll = 0;
  const totsC = [], totsY = [];
  for (const r of sorted) {
    const hl = (byTeam.get(r.h) || []).slice().reverse(), al = (byTeam.get(r.a) || []).slice().reverse();
    const ex = expected(hl, al);
    if (ex && nAll >= 20) {
      const meanC = sumC / nAll, meanY = sumY / nAll;
      rows.push({
        t: r.t, actC: r.sp.c + r.sp.ca, actY: r.sp.y + r.sp.ya,
        predC: ex.corners.t, predY: ex.cards.t, pmfC: ex.corners.total, pmfY: ex.cards.total,
        baseC: meanC, baseY: meanY, rC: dispersion(totsC), rY: dispersion(totsY),
      });
    }
    // geçmişe ekle (bu maçtan sonrakiler için)
    add(r.h, { t: r.t, ha: 'home', sp: r.sp });
    add(r.a, { t: r.t, ha: 'away', sp: flip(r.sp) });
    sumC += r.sp.c + r.sp.ca; sumY += r.sp.y + r.sp.ya; nAll++;
    totsC.push(r.sp.c + r.sp.ca); totsY.push(r.sp.y + r.sp.ya);
  }
  if (rows.length < minTest) return { n: rows.length, enough: false };

  const mk = (key) => {
    const act = rows.map((r) => (key === 'C' ? r.actC : r.actY));
    const pred = rows.map((r) => (key === 'C' ? r.predC : r.predY));
    const base = rows.map((r) => (key === 'C' ? r.baseC : r.baseY));
    const n = rows.length;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mae = (p) => mean(p.map((v, i) => Math.abs(v - act[i])));
    const m = Math.round(mean(act));
    const lines = [m - 1.5, m - 0.5, m + 0.5].filter((l) => l > 0.4).map((line) => {
      let hit = 0, brier = 0, brierBase = 0, over = 0;
      const conf = [{ lo: 0.5, hi: 0.6, n: 0, hit: 0 }, { lo: 0.6, hi: 0.7, n: 0, hit: 0 }, { lo: 0.7, hi: 1.01, n: 0, hit: 0 }];
      for (const r of rows) {
        const a = key === 'C' ? r.actC : r.actY;
        const pm = pOver(key === 'C' ? r.pmfC : r.pmfY, line);
        const pb = pOver(nbPmf(key === 'C' ? r.baseC : r.baseY, key === 'C' ? r.rC : r.rY, 40), line);
        const o = a > line ? 1 : 0;
        over += o;
        const ok = (pm >= 0.5) === (o === 1);
        if (ok) hit++;
        brier += (pm - o) ** 2; brierBase += (pb - o) ** 2;
        const cf = Math.max(pm, 1 - pm);
        const b = conf.find((x) => cf >= x.lo && cf < x.hi);
        if (b) { b.n++; if (ok) b.hit++; }
      }
      const rate = over / n;
      return {
        line, n,
        overRate: rate,
        hit: hit / n,
        hitBase: Math.max(rate, 1 - rate),   // geriye bakarak seçilen "hep aynı tarafı söyle" tahmini: zor bir kıyas
        brier: brier / n, brierBase: brierBase / n,
        skill: brierBase > 0 ? 1 - brier / brierBase : null,
        conf: conf.map((c) => ({ lo: c.lo, hi: Math.min(1, c.hi), n: c.n, hit: c.n ? c.hit / c.n : null })),
      };
    });
    const avgSkill = lines.length ? lines.reduce((s, l) => s + (l.skill || 0), 0) / lines.length : null;
    return { n, meanActual: mean(act), meanPred: mean(pred), bias: mean(pred) - mean(act), mae: mae(pred), maeBase: mae(base), lines, skill: avgSkill };
  };
  return { n: rows.length, enough: true, corners: mk('C'), cards: mk('Y'), from: rows[0].t, to: rows[rows.length - 1].t };
}

module.exports = { nbPmf, pOver, dispersion, sideStats, expected, backtestSp };
