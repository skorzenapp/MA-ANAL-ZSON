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
// xgW: şut bazlı beklenen gol (m.xh / m.xa) ile gerçek golün karışım oranı. Karışım sadece xh/xa bilinen maçlarda yapılır.
function fit(matches, now, { halfLife = HALF_LIFE_DAYS, prior = 2.5, iters = 70, xgW = 0 } = {}) {
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
  let xUsed = 0;
  for (const m of matches) {
    if (m.t >= now) continue;
    const w = Math.pow(0.5, (now - m.t) / (halfLife * DAY));
    if (w < 1e-4) continue;
    const h = ix(m.h), a = ix(m.a);
    games[h]++; games[a]++;
    let c = comps.get(m.c);
    if (c === undefined) { c = comps.size; comps.set(m.c, c); }
    const xw = xgW > 0 && m.xh != null && m.xa != null ? xgW : 0;
    if (xw) xUsed++;
    M.push({ h, a, hg: xw ? (1 - xw) * m.hg + xw * m.xh : m.hg, ag: xw ? (1 - xw) * m.ag + xw * m.xa : m.ag, ohg: m.hg, oag: m.ag, w, c, nu: m.neutral ? 1 : 0, t: m.t, id: m.id });
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
      if (m.ohg > 1 || m.oag > 1) continue;
      const hf = m.nu ? 1 : ha;
      const lh = mu * fc[m.c] * hf * att[m.h] * def[m.a];
      const la = mu * fc[m.c] * att[m.a] * def[m.h];
      const t = tau(m.ohg, m.oag, lh, la, r);
      if (t <= 0) { ll = -Infinity; break; }
      ll += m.w * Math.log(t);
    }
    if (ll > bestLL) { bestLL = ll; bestRho = r; }
  }

  // form (son 6) ve sıralama
  const recent = new Map();
  const sorted = M.slice().sort((x, y) => y.t - x.t);
  for (const m of sorted) {
    for (const [side, own, opp] of [[0, m.ohg, m.oag], [1, m.oag, m.ohg]]) {
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
    mu, ha, rho: bestRho, xgW, xUsed,
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
  for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5']) {
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

// ---------- daha fazla pazar (handikap, ilk yarı, İY/MS, ilk gol, kombine...) ----------
// Gol dağılımının %46'sı ilk yarıda, %54'ü ikinci yarıda varsayılır (liveMarkets ile aynı).
const HALF1 = 0.46;
function indepGrid(lh, la, k = G) {
  const ph = poisPmf(lh, k), pa = poisPmf(la, k);
  const p = [];
  let sum = 0;
  for (let i = 0; i <= k; i++) { p[i] = []; for (let j = 0; j <= k; j++) { p[i][j] = ph[i] * pa[j]; sum += p[i][j]; } }
  for (let i = 0; i <= k; i++) for (let j = 0; j <= k; j++) p[i][j] /= sum;
  return p;
}
function extraMarkets(lh, la, p, share = HALF1) {
  const H1 = share;
  const sumWhere = (f) => { let s = 0; for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) if (f(i, j)) s += p[i][j]; return s; };
  const out = {};
  // Avrupa handikapı (üç yollu): ev sahibine h gol eklenir
  out.euro = {};
  for (const h of [-2, -1, 1, 2]) out.euro[h] = { h: sumWhere((i, j) => i + h > j), d: sumWhere((i, j) => i + h === j), a: sumWhere((i, j) => i + h < j) };
  // Asya handikapı: iade (push) tam sayı hatlarda olur
  out.asian = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5].map((line) => ({
    line, win: sumWhere((i, j) => i + line > j), push: sumWhere((i, j) => i + line === j), lose: sumWhere((i, j) => i + line < j),
  }));
  // ilk ve ikinci yarı (bağımsız Poisson)
  const g1 = indepGrid(lh * H1, la * H1), g2 = indepGrid(lh * (1 - H1), la * (1 - H1));
  const m1 = markets(g1), m2 = markets(g2);
  const half = (m, l) => ({ home: m.home, draw: m.draw, away: m.away, over: { 0.5: m.over['0.5'], 1.5: m.over['1.5'], 2.5: m.over['2.5'] }, btts: m.btts, lambda: { home: lh * l, away: la * l } });
  out.half1 = half(m1, H1);
  out.half2 = half(m2, 1 - H1);
  // hangi yarıda daha çok gol
  const t1 = poisPmf((lh + la) * H1, 20), t2 = poisPmf((lh + la) * (1 - H1), 20);
  let first = 0, eq = 0, second = 0;
  for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) { const v = t1[a] * t2[b]; if (a > b) first += v; else if (a === b) eq += v; else second += v; }
  out.moreGoals = { first, equal: eq, second };
  // İY/MS
  const K = 8;
  const a1 = poisPmf(lh * H1, K), b1 = poisPmf(la * H1, K), a2 = poisPmf(lh * (1 - H1), K), b2 = poisPmf(la * (1 - H1), K);
  const sg = (x) => (x > 0 ? '1' : x < 0 ? '2' : 'X');
  const ht = {};
  let tot = 0;
  for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) {
    const v1 = a1[i] * b1[j];
    for (let k = 0; k <= K; k++) for (let l = 0; l <= K; l++) {
      const v = v1 * a2[k] * b2[l];
      const key = sg(i - j) + '/' + sg(i + k - j - l);
      ht[key] = (ht[key] || 0) + v; tot += v;
    }
  }
  for (const k of Object.keys(ht)) ht[k] /= tot;
  out.htft = ht;
  // ilk gol
  const p00 = p[0][0];
  const sl = lh + la || 1;
  out.firstGoal = { home: (1 - p00) * (lh / sl), away: (1 - p00) * (la / sl), none: p00 };
  // tek / çift, gol aralıkları
  out.even = sumWhere((i, j) => (i + j) % 2 === 0);
  out.odd = 1 - out.even;
  out.bands = [['0-1', 0, 1], ['2-3', 2, 3], ['4-5', 4, 5], ['6+', 6, 99]].map(([label, lo, hi]) => ({ label, p: sumWhere((i, j) => i + j >= lo && i + j <= hi) }));
  // kombine
  const res = (i, j) => (i > j ? 'h' : i === j ? 'd' : 'a');
  out.combo1x2 = {};
  for (const r of ['h', 'd', 'a']) out.combo1x2[r] = { over: sumWhere((i, j) => res(i, j) === r && i + j > 2.5), under: sumWhere((i, j) => res(i, j) === r && i + j < 2.5) };
  out.comboBtts = {};
  for (const y of ['yes', 'no']) out.comboBtts[y] = { over: sumWhere((i, j) => ((i > 0 && j > 0) === (y === 'yes')) && i + j > 2.5), under: sumWhere((i, j) => ((i > 0 && j > 0) === (y === 'yes')) && i + j < 2.5) };
  // maç farkı
  const dd = (f) => sumWhere((i, j) => f(i - j));
  out.margin = [['Ev 3+', dd((d) => d >= 3)], ['Ev 2', dd((d) => d === 2)], ['Ev 1', dd((d) => d === 1)], ['Beraberlik', dd((d) => d === 0)], ['Dep 1', dd((d) => d === -1)], ['Dep 2', dd((d) => d === -2)], ['Dep 3+', dd((d) => d <= -3)]].map(([label, v]) => ({ label, p: v }));
  out.split = H1;
  return out;
}

function matchup(model, h, a, { neutral = false, comp, lhMul = 1, laMul = 1 } = {}) {
  const f = comp != null ? model.comp(comp) : 1;
  const ha = neutral ? 1 : model.ha;
  const lh = model.mu * f * ha * model.att(h) * model.def(a) * lhMul;
  const la = model.mu * f * model.att(a) * model.def(h) * laMul;
  const p = grid(lh, la, model.rho);
  const mk = markets(p);
  const matrix = [];
  for (let i = 0; i <= 6; i++) { matrix[i] = []; for (let j = 0; j <= 6; j++) matrix[i][j] = p[i][j]; }
  return { lambdaHome: lh, lambdaAway: la, markets: mk, matrix, grid: p };
}

// ---------- canlı (maç sürerken) ----------
// Golün ilk yarıda ~%46, ikinci yarıda ~%54 atıldığı varsayımıyla "şu ana kadar oynanan pay"
function shareDone(m, s1 = 0.46) {
  if (m <= 0) return 0;
  if (m <= 45) return (s1 * m) / 45;
  return Math.min(0.995, s1 + ((1 - s1) * (Math.min(m, 95) - 45)) / 45);
}
// lh/la: 90 dakikalık beklenen goller, minute: oynanan dakika, hg/ag: şu anki skor
function liveMarkets(lh, la, minute, hg, ag, share = 0.46) {
  const rem = Math.max(0.01, 1 - shareDone(minute, share));
  const rh = lh * rem, ra = la * rem;
  const ph = poisPmf(rh, G), pa = poisPmf(ra, G);
  const p = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(0));
  let sum = 0;
  for (let x = 0; x <= G; x++) {
    for (let y = 0; y <= G; y++) {
      const i = hg + x, j = ag + y;
      if (i > G || j > G) continue;
      const v = ph[x] * pa[y];
      p[i][j] += v; sum += v;
    }
  }
  if (sum <= 0) p[Math.min(G, hg)][Math.min(G, ag)] = sum = 1;
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) p[i][j] /= sum;
  const none = Math.exp(-(rh + ra));
  const tot = rh + ra;
  return {
    minute, score: { home: hg, away: ag },
    remaining: { home: rh, away: ra },
    markets: markets(p),
    nextGoal: { home: tot > 0 ? ((1 - none) * rh) / tot : 0, away: tot > 0 ? ((1 - none) * ra) / tot : 0, none },
  };
}

// ---------- kendini ayarlama ----------
const tick = () => new Promise((r) => setImmediate(r));
const DEFAULT_PARAMS = { halfLife: HALF_LIFE_DAYS, prior: 2.5 };

async function evalParams(matches, ownComp, from, to, step, params, minGames = 3) {
  const own = matches.filter((m) => m.c === ownComp && m.t >= from && m.t < to);
  let bs = 0, ll = 0, n = 0;
  for (let s = from; s < to; s += step * DAY) {
    const block = own.filter((m) => m.t >= s && m.t < s + step * DAY);
    if (!block.length) continue;
    await tick();
    const mdl = fit(matches, s, { halfLife: params.halfLife, prior: params.prior, iters: 40, xgW: params.xgW || 0 });
    if (!mdl.ok) continue;
    for (const m of block) {
      if (mdl.games(m.h) < minGames || mdl.games(m.a) < minGames) continue;
      const mk = matchup(mdl, m.h, m.a, { neutral: m.neutral, comp: m.c }).markets;
      const res = m.hg > m.ag ? 'h' : m.hg === m.ag ? 'd' : 'a';
      const pr = { h: mk.home, d: mk.draw, a: mk.away };
      for (const k of ['h', 'd', 'a']) bs += (pr[k] - (res === k ? 1 : 0)) ** 2;
      ll -= Math.log(Math.max(1e-6, pr[res]));
      n++;
    }
  }
  return { n, brier: n ? bs / n : null, logloss: n ? ll / n : null };
}

// Yarım ömür ve önsel (shrinkage) ayarını geriye dönük testle seçer.
// Seçim: 300-120 gün önce. Dürüst ölçüm: son 120 gün seçimde kullanılmaz (dışarıda test).
// 2. aşama: şut bazlı beklenen gol karışımı (xgW) aynı kuralla denenir: seçimde belirgin iyileşme + dışarıda kötüleşmeme.
const BR_GAIN = 0.0005;
async function tune(matches, now, ownComp) {
  const cands = [];
  for (const halfLife of [90, 150, 240]) for (const prior of [1.5, 2.5, 5]) cands.push({ halfLife, prior });
  const selFrom = now - 300 * DAY, selTo = now - 120 * DAY;
  const sel = [];
  for (const c of cands) sel.push({ c, r: await evalParams(matches, ownComp, selFrom, selTo, 14, c) });
  const def = sel.find((x) => x.c.halfLife === DEFAULT_PARAMS.halfLife && x.c.prior === DEFAULT_PARAMS.prior);
  if (!def.r.n || def.r.n < 40) return { ...DEFAULT_PARAMS, xgW: 0, tuned: false, reason: 'few', selN: def.r.n, xg: xgTally(matches, ownComp, selFrom, selTo, null) };
  const best = sel.reduce((a, b) => (b.r.brier < a.r.brier ? b : a), def);
  const holdDef = await evalParams(matches, ownComp, selTo, now, 10, DEFAULT_PARAMS);
  let tunedOK = false, holdBest = holdDef;
  if (best !== def && def.r.brier - best.r.brier >= BR_GAIN) {
    holdBest = await evalParams(matches, ownComp, selTo, now, 10, best.c);
    tunedOK = holdBest.brier != null && holdDef.brier != null && holdBest.brier <= holdDef.brier;
  }
  const chosen = tunedOK ? best.c : DEFAULT_PARAMS;
  const selChosen = tunedOK ? best.r : def.r;
  const holdChosen = tunedOK ? holdBest : holdDef;

  // ---- 2. aşama: şut karışımı ----
  const xg = xgTally(matches, ownComp, selFrom, selTo, now);
  let xgW = 0;
  if (xg.enough) {
    const tries = [];
    for (const w of [0.3, 0.6]) tries.push({ w, r: await evalParams(matches, ownComp, selFrom, selTo, 14, { ...chosen, xgW: w }) });
    const bx = tries.reduce((a, b) => (b.r.brier < a.r.brier ? b : a));
    xg.candidateW = bx.w;
    xg.selBrier = { base: selChosen.brier, xg: bx.r.brier };
    if (selChosen.brier - bx.r.brier >= BR_GAIN) {
      const holdX = await evalParams(matches, ownComp, selTo, now, 10, { ...chosen, xgW: bx.w });
      xg.holdBrier = { base: holdChosen.brier, xg: holdX.brier };
      xg.holdLogloss = { base: holdChosen.logloss, xg: holdX.logloss };
      xg.holdN = holdX.n;
      if (holdX.brier != null && holdChosen.brier != null && holdX.brier <= holdChosen.brier) xgW = bx.w;
    } else xg.holdBrier = null;
    xg.adopted = xgW > 0;
  }
  return {
    halfLife: chosen.halfLife, prior: chosen.prior, xgW, tuned: tunedOK,
    candidate: { halfLife: best.c.halfLife, prior: best.c.prior },
    selN: def.r.n, selBrier: { default: def.r.brier, best: best.r.brier },
    holdN: holdDef.n, holdBrier: { default: holdDef.brier, tuned: holdBest.brier },
    holdLogloss: { default: holdDef.logloss, tuned: holdBest.logloss },
    xg,
  };
}

// Şut verisinin kapsamı: kendi turnuvadaki maçların kaçında xh/xa var
function xgTally(matches, ownComp, selFrom, selTo, now) {
  const own = matches.filter((m) => m.c === ownComp);
  const withX = own.filter((m) => m.xh != null && m.xa != null);
  const inSel = withX.filter((m) => m.t >= selFrom && m.t < selTo).length;
  const out = { coverage: own.length ? withX.length / own.length : 0, nWith: withX.length, selWith: inSel, tested: false, adopted: false };
  if (now == null) { out.reason = 'few'; return out; }
  if (withX.length < 120 || inSel < 40) { out.reason = withX.length ? 'few' : 'none'; return out; }
  out.tested = true; out.enough = true;
  return out;
}

// ---------- karne ----------
async function backtest(matches, { now, days = 300, step = 7, ownComp, minGames = 3, params = DEFAULT_PARAMS } = {}) {
  const start = now - days * DAY;
  const own = matches.filter((m) => m.c === ownComp && m.t >= start && m.t < now).sort((a, b) => a.t - b.t);
  const rows = [];
  let base = { h: 0, d: 0, a: 0 };
  for (let s = start; s < now; s += step * DAY) {
    const block = own.filter((m) => m.t >= s && m.t < s + step * DAY);
    if (!block.length) continue;
    await tick();
    const mdl = fit(matches, s, { halfLife: params.halfLife, prior: params.prior, iters: 45, xgW: params.xgW || 0 });
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

module.exports = { fit, matchup, markets, grid, extraMarkets, backtest, poisPmf, liveMarkets, tune, DEFAULT_PARAMS, HALF_LIFE_DAYS };
