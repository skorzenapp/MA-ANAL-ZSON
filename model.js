'use strict';
// Zaman ağırlıklı Poisson / Dixon-Coles hücum-savunma modeli ve karne (backtest) hesabı.
const DAY = 86400000;
const HALF_LIFE_DAYS = 150;

function poisPmf(l, n) {
  const out = new Array(n + 1);
  let p = Math.exp(-l);
  out[0] = p;
  for (let k = 1; k <= n; k++) { p *= l / k; out[k] = p; }
  return out;
}

// matches: [{t, h, a, hg, ag, c, neutral}]  (t: ms, c: turnuva anahtarı)
function fit(matches, now, { halfLife = HALF_LIFE_DAYS, prior = 2.5, iters = 70 } = {}) {
  const idx = new Map();
  const ids = [];
  const games = [];
  const ix = (id) => {
    let i = idx.get(id);
    if (i === undefined) { i = ids.length; idx.set(id, i); ids.push(id); games.push(0); }
    return i;
  };
  const M = [];
  const comps = new Map();
  for (const m of matches) {
    if (m.t >= now) continue;
    const w = Math.pow(0.5, (now - m.t) / (halfLife * DAY));
    if (w < 1e-4) continue;
    const h = ix(m.h), a = ix(m.a);
    games[h]++; games[a]++;
    let c = comps.get(m.c);
    if (c === undefined) { c = comps.size; comps.set(m.c, c); }
    M.push({ h, a, hg: m.hg, ag: m.ag, w, c, nu: m.neutral ? 1 : 0, t: m.t, id: m.id });
  }
  const n = ids.length;
  const att = new Float64Array(n).fill(1);
  const def = new Float64Array(n).fill(1);
  const fc = new Float64Array(Math.max(1, comps.size)).fill(1);
  let ha = 1.3;
  let totW = 0, totG = 0;
  for (const m of M) { totW += m.w; totG += m.w * (m.hg + m.ag); }
  const avgTeamGoals = totW ? totG / (2 * totW) : 1.3;
  let mu = avgTeamGoals;
  if (M.length < 10) return { ok: false, n: M.length };

  const na = new Float64Array(n), da = new Float64Array(n), nd = new Float64Array(n), dd = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    na.fill(0); da.fill(0); nd.fill(0); dd.fill(0);
    for (const m of M) {
      const hf = m.nu ? 1 : ha;
      const f = fc[m.c];
      na[m.h] += m.w * m.hg; da[m.h] += m.w * mu * f * hf * def[m.a];
      na[m.a] += m.w * m.ag; da[m.a] += m.w * mu * f * def[m.h];
      nd[m.h] += m.w * m.ag; dd[m.h] += m.w * mu * f * att[m.a];
      nd[m.a] += m.w * m.hg; dd[m.a] += m.w * mu * f * hf * att[m.h];
    }
    const pr = prior * avgTeamGoals;
    for (let i = 0; i < n; i++) {
      att[i] = (na[i] + pr) / (da[i] + pr);
      def[i] = (nd[i] + pr) / (dd[i] + pr);
    }
    // ev sahibi avantajı
    let hn = 0, hd = 0;
    for (const m of M) if (!m.nu) { hn += m.w * m.hg; hd += m.w * mu * fc[m.c] * att[m.h] * def[m.a]; }
    if (hd > 0) ha = Math.max(0.95, Math.min(1.7, hn / hd));
    // turnuva katsayıları
    if (comps.size > 1) {
      const gn = new Float64Array(comps.size), ge = new Float64Array(comps.size), gw = new Float64Array(comps.size);
      for (const m of M) {
        const hf = m.nu ? 1 : ha;
        gn[m.c] += m.w * (m.hg + m.ag);
        ge[m.c] += m.w * mu * (hf * att[m.h] * def[m.a] + att[m.a] * def[m.h]);
        gw[m.c] += m.w;
      }
      let sum = 0, sw = 0;
      for (let c = 0; c < comps.size; c++) { fc[c] = ge[c] > 0 ? Math.max(0.5, Math.min(2, gn[c] / ge[c])) : 1; sum += fc[c] * gw[c]; sw += gw[c]; }
      const mean = sum / sw;
      for (let c = 0; c < comps.size; c++) fc[c] /= mean;
    }
    // normalize
    let sa = 0, sd = 0, k = 0;
    for (let i = 0; i < n; i++) if (games[i] > 0) { sa += att[i]; sd += def[i]; k++; }
    const ma = sa / k, md = sd / k;
    for (let i = 0; i < n; i++) { att[i] /= ma; def[i] /= md; }
    mu *= ma * md;
    // mu ayarı
    let gn = 0, ge = 0;
    for (const m of M) { const hf = m.nu ? 1 : ha; gn += m.w * (m.hg + m.ag); ge += m.w * fc[m.c] * mu * (hf * att[m.h] * def[m.a] + att[m.a] * def[m.h]); }
    if (ge > 0) mu *= gn / ge;
  }

  // Dixon-Coles rho
  let bestRho = 0, bestLL = -Infinity;
  for (let r = -0.2; r <= 0.1001; r += 0.01) {
    let ll = 0;
    for (const m of M) {
      if (m.hg > 1 || m.ag > 1) continue;
      const hf = m.nu ? 1 : ha;
      const lh = mu * fc[m.c] * hf * att[m.h] * def[m.a];
      const la = mu * fc[m.c] * att[m.a] * def[m.h];
      const t = tau(m.hg, m.ag, lh, la, r);
      if (t <= 0) { ll = -Infinity; break; }
      ll += m.w * Math.log(t);
    }
    if (ll > bestLL) { bestLL = ll; bestRho = r; }
  }

  // form (son 6) ve sıralama
  const recent = new Map();
  const sorted = M.slice().sort((x, y) => y.t - x.t);
  for (const m of sorted) {
    for (const [side, own, opp] of [[0, m.hg, m.ag], [1, m.ag, m.hg]]) {
      const id = ids[side ? m.a : m.h];
      let arr = recent.get(id);
      if (!arr) { arr = []; recent.set(id, arr); }
      if (arr.length < 6) arr.push(own > opp ? 'W' : own === opp ? 'D' : 'L');
    }
  }
  const strength = ids.map((id, i) => ({ id, s: Math.log(att[i]) - Math.log(def[i]), g: games[i] })).filter((x) => x.g >= 3).sort((a, b) => b.s - a.s);
  const rank = new Map(strength.map((x, i) => [x.id, i + 1]));

  return {
    ok: true,
    n: M.length,
    mu, ha, rho: bestRho,
    att: (id) => (idx.has(id) ? att[idx.get(id)] : 1),
    def: (id) => (idx.has(id) ? def[idx.get(id)] : 1),
    games: (id) => (idx.has(id) ? games[idx.get(id)] : 0),
    form: (id) => (recent.get(id) || []).slice().reverse(),
    rank: (id) => rank.get(id) || null,
    comp: (c) => (comps.has(c) ? fc[comps.get(c)] : 1),
    teams: strength.length,
    avgGoals: totW ? totG / totW : 2.6,
  };
}

function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

const G = 12;
function grid(lh, la, rho) {
  const ph = poisPmf(lh, G), pa = poisPmf(la, G);
  const p = [];
  let sum = 0;
  for (let i = 0; i <= G; i++) {
    p[i] = [];
    for (let j = 0; j <= G; j++) {
      const v = ph[i] * pa[j] * tau(i, j, lh, la, rho);
      p[i][j] = v; sum += v;
    }
  }
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) p[i][j] /= sum;
  return p;
}

function markets(p) {
  const out = { home: 0, draw: 0, away: 0, over: {}, homeOver: {}, awayOver: {}, btts: 0 };
  const tot = new Array(2 * G + 1).fill(0);
  const scores = [];
  let cs0 = 0, cs1 = 0;
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
    const v = p[i][j];
    if (i > j) out.home += v; else if (i === j) out.draw += v; else out.away += v;
    tot[i + j] += v;
    if (i >= 1 && j >= 1) out.btts += v;
    if (j === 0) cs0 += v;
    if (i === 0) cs1 += v;
    if (i <= 6 && j <= 6) scores.push({ s: `${i}-${j}`, p: v });
  }
  for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5']) {
    const line = Number(l);
    out.over[l] = tot.reduce((a, v, k) => (k > line ? a + v : a), 0);
  }
  for (const l of ['0.5', '1.5', '2.5']) {
    const line = Number(l);
    let h = 0, a = 0;
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) { if (i > line) h += p[i][j]; if (j > line) a += p[i][j]; }
    out.homeOver[l] = h; out.awayOver[l] = a;
  }
  out.bttsNo = 1 - out.btts;
  out.dc1X = out.home + out.draw; out.dcX2 = out.draw + out.away; out.dc12 = out.home + out.away;
  out.homeCleanSheet = cs0; // ev sahibi gol yemez = deplasman 0 atar
  out.awayCleanSheet = cs1;
  out.goalDist = [0, 1, 2, 3, 4, 5].map((k) => tot[k]).concat([tot.slice(6).reduce((a, b) => a + b, 0)]);
  out.topScores = scores.sort((a, b) => b.p - a.p).slice(0, 12);
  return out;
}

function matchup(model, h, a, { neutral = false, comp } = {}) {
  const f = comp != null ? model.comp(comp) : 1;
  const ha = neutral ? 1 : model.ha;
  const lh = model.mu * f * ha * model.att(h) * model.def(a);
  const la = model.mu * f * model.att(a) * model.def(h);
  const p = grid(lh, la, model.rho);
  const mk = markets(p);
  const matrix = [];
  for (let i = 0; i <= 6; i++) { matrix[i] = []; for (let j = 0; j <= 6; j++) matrix[i][j] = p[i][j]; }
  return { lambdaHome: lh, lambdaAway: la, markets: mk, matrix, grid: p };
}

// ---------- karne ----------
function backtest(matches, { now, days = 300, step = 7, ownComp, minGames = 3 } = {}) {
  const start = now - days * DAY;
  const own = matches.filter((m) => m.c === ownComp && m.t >= start && m.t < now).sort((a, b) => a.t - b.t);
  const rows = [];
  let base = { h: 0, d: 0, a: 0 };
  for (let s = start; s < now; s += step * DAY) {
    const block = own.filter((m) => m.t >= s && m.t < s + step * DAY);
    if (!block.length) continue;
    const mdl = fit(matches, s, { iters: 45 });
    if (!mdl.ok) continue;
    for (const m of block) {
      if (mdl.games(m.h) < minGames || mdl.games(m.a) < minGames) continue;
      const r = matchup(mdl, m.h, m.a, { neutral: m.neutral, comp: m.c });
      const mk = r.markets;
      rows.push({ m, mk, top: r.markets.topScores[0], mdl });
    }
  }
  const n = rows.length;
  if (!n) return { n: 0 };
  let acc = 0, hHome = 0, hDraw = 0, over = 0, btts = 0, exact = 0, bs = 0, bb = 0;
  const pick = { 1: 0, X: 0, 2: 0 };
  const conf = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]].map(([lo, hi]) => ({ lo, hi, n: 0, hits: 0 }));
  const cal = Array.from({ length: 8 }, (_, k) => ({ lo: k / 10, hi: k === 7 ? 1 : (k + 1) / 10, n: 0, pred: 0, obs: 0 }));
  const monthly = new Map();
  const freq = { h: 0, d: 0, a: 0 };
  for (const r of rows) { const { hg, ag } = r.m; if (hg > ag) freq.h++; else if (hg === ag) freq.d++; else freq.a++; }
  const pb = { h: freq.h / n, d: freq.d / n, a: freq.a / n };
  const detail = [];
  for (const r of rows) {
    const { m, mk, top } = r;
    const res = m.hg > m.ag ? 'h' : m.hg === m.ag ? 'd' : 'a';
    const probs = { h: mk.home, d: mk.draw, a: mk.away };
    const pk = mk.home >= mk.draw && mk.home >= mk.away ? 'h' : mk.away >= mk.draw ? 'a' : 'd';
    const hit = pk === res;
    if (hit) acc++;
    if (res === 'h') hHome++;
    if (res === 'd') hDraw++;
    pick[pk === 'h' ? 1 : pk === 'd' ? 'X' : 2]++;
    const pO = mk.over['2.5'];
    const overHit = (pO >= 0.5) === (m.hg + m.ag > 2.5);
    if (overHit) over++;
    const bHit = (mk.btts >= 0.5) === (m.hg >= 1 && m.ag >= 1);
    if (bHit) btts++;
    const topHit = top.s === `${m.hg}-${m.ag}`;
    if (topHit) exact++;
    for (const k of ['h', 'd', 'a']) {
      bs += (probs[k] - (res === k ? 1 : 0)) ** 2;
      bb += (pb[k] - (res === k ? 1 : 0)) ** 2;
      const c = cal.find((x) => probs[k] >= x.lo && probs[k] < x.hi + (x.hi === 1 ? 1e-9 : 0));
      if (c) { c.n++; c.pred += probs[k]; c.obs += res === k ? 1 : 0; }
    }
    const fav = Math.max(mk.home, mk.draw, mk.away);
    const cb = conf.find((x) => fav >= x.lo && fav < x.hi + (x.hi === 1 ? 1e-9 : 0));
    if (cb) { cb.n++; if (hit) cb.hits++; }
    const mo = new Date(m.t).toISOString().slice(0, 7);
    const me = monthly.get(mo) || { month: mo, n: 0, hit: 0 };
    me.n++; if (hit) me.hit++;
    monthly.set(mo, me);
    detail.push({
      id: m.id, t: m.t, home: m.hn, away: m.an, hg: m.hg, ag: m.ag,
      pH: mk.home, pD: mk.draw, pA: mk.away,
      pick: pk === 'h' ? '1' : pk === 'd' ? 'X' : '2', hit,
      pOver: pO, overHit, top: top.s, topHit,
    });
  }
  return {
    n,
    accuracy: acc / n,
    baseHome: hHome / n,
    baseDraw: hDraw / n,
    over25: over / n,
    btts: btts / n,
    exact: exact / n,
    skill: bb > 0 ? 1 - bs / bb : null,
    monthly: [...monthly.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((x) => ({ month: x.month, n: x.n, acc: x.hit / x.n })),
    confidence: conf.map((c) => ({ lo: c.lo, hi: c.hi, n: c.n, hit: c.n ? c.hits / c.n : null })),
    pickShare: { 1: pick[1] / n, X: pick.X / n, 2: pick[2] / n },
    calibration: cal.map((c) => ({ lo: c.lo, hi: c.hi, n: c.n, pred: c.n ? c.pred / c.n : 0, obs: c.n ? c.obs / c.n : 0 })),
    recent: detail.sort((a, b) => b.t - a.t).slice(0, 15),
  };
}

module.exports = { fit, matchup, markets, grid, backtest, poisPmf, HALF_LIFE_DAYS };
