'use strict';
// İlk yarı / ikinci yarı gol payı ve yeni pazarların (ilk yarı, İY/MS, maç farkı, gol aralığı, handikap...) karnesi.
// Gol dakikaları ESPN'in maç olaylarından gelir. Olaylar skorla tutmuyorsa o maç yarı hesabına katılmaz.

const HALF1 = 0.46;
const SHRINK_GOALS = 120; // ölçülen payı varsayılana doğru çeken "sanal gol" sayısı

function clockBase(k) {
  const m = String((k && k.clock) || '').match(/(\d+)'(?:\s*\+\s*(\d+)')?/);
  if (m) return { base: Number(m[1]), extra: m[2] ? Number(m[2]) : 0 };
  if (k && k.min != null) return { base: Number(k.min), extra: 0 };
  return null;
}

// Bir maçın golleri yarılara bölünür. Dönüş: null (güvenilmez) ya da {h1:[ev,dep], h2:[ev,dep], first:'h'|'a'|null}
function halvesOf(rec, hid, aid, hg, ag) {
  if (!rec || !Array.isArray(rec.keyEvents)) return null;
  const evs = rec.keyEvents.filter((k) => k.scoring);
  const list = [];
  for (const k of evs) {
    const c = clockBase(k);
    if (!c) return null;
    if (c.base > 90 && !c.extra) return null; // uzatma golü: 90 dakikalık hesaba katma
    if (k.teamId !== hid && k.teamId !== aid) return null;
    list.push({ side: k.teamId === hid ? 0 : 1, base: c.base, extra: c.extra });
  }
  const cnt = [0, 0];
  for (const e of list) cnt[e.side]++;
  if (cnt[0] !== hg || cnt[1] !== ag) return null;
  const h1 = [0, 0], h2 = [0, 0];
  for (const e of list) (e.base <= 45 ? h1 : h2)[e.side]++;
  list.sort((x, y) => x.base * 1000 + x.extra - (y.base * 1000 + y.extra));
  return { h1, h2, first: list.length ? (list[0].side === 0 ? 'h' : 'a') : null };
}

// Lig düzeyinde ilk yarı payı. Az gol varsa varsayılana (%46) yaklaşır.
function share(halves) {
  let g1 = 0, g = 0, n = 0;
  for (const h of halves) { g1 += h.h1[0] + h.h1[1]; g += h.h1[0] + h.h1[1] + h.h2[0] + h.h2[1]; n++; }
  if (n < 30 || g < 80) return { enough: false, n, goals: g };
  const raw = g1 / g;
  const applied = (g1 + HALF1 * SHRINK_GOALS) / (g + SHRINK_GOALS);
  const se = Math.sqrt((raw * (1 - raw)) / g);
  const z = (raw - HALF1) / se;
  return { enough: true, n, goals: g, raw, applied, se, z, significant: Math.abs(z) >= 1.96, def: HALF1 };
}

// ---------- karne ----------
// items: [{ex, ex46, hg, ag, hs: {h1:[..],h2:[..],first}|null}]   ex: M.extraMarkets çıktısı (ölçülen payla), ex46: %46 payla
const sgn = (x) => (x > 0 ? '1' : x < 0 ? '2' : 'X');
const GROUPS = [
  {
    key: 'ht', label: 'İlk yarı sonucu (1X2)', needHalves: true,
    cats: [['1', (e) => e.half1.home, (o) => (o.hs.h1[0] > o.hs.h1[1])], ['X', (e) => e.half1.draw, (o) => (o.hs.h1[0] === o.hs.h1[1])], ['2', (e) => e.half1.away, (o) => (o.hs.h1[0] < o.hs.h1[1])]],
  },
  {
    key: 'htg', label: 'İlk yarı gol sayısı', needHalves: true,
    cats: [['0.5 üstü', (e) => e.half1.over['0.5'], (o) => o.hs.h1[0] + o.hs.h1[1] > 0.5], ['1.5 üstü', (e) => e.half1.over['1.5'], (o) => o.hs.h1[0] + o.hs.h1[1] > 1.5]],
    binary: true,
  },
  {
    key: 'more', label: 'Hangi yarıda daha çok gol', needHalves: true,
    cats: [['1. yarı', (e) => e.moreGoals.first, (o) => o.hs.h1[0] + o.hs.h1[1] > o.hs.h2[0] + o.hs.h2[1]], ['Eşit', (e) => e.moreGoals.equal, (o) => o.hs.h1[0] + o.hs.h1[1] === o.hs.h2[0] + o.hs.h2[1]], ['2. yarı', (e) => e.moreGoals.second, (o) => o.hs.h1[0] + o.hs.h1[1] < o.hs.h2[0] + o.hs.h2[1]]],
  },
  {
    key: 'htft', label: 'İlk yarı / maç sonu', needHalves: true,
    cats: ['1/1', '1/X', '1/2', 'X/1', 'X/X', 'X/2', '2/1', '2/X', '2/2'].map((k) => [k, (e) => e.htft[k] || 0, (o) => sgn(o.hs.h1[0] - o.hs.h1[1]) + '/' + sgn(o.hg - o.ag) === k]),
  },
  {
    key: 'margin', label: 'Maç farkı',
    cats: [['Ev 3+', 0, (d) => d >= 3], ['Ev 2', 1, (d) => d === 2], ['Ev 1', 2, (d) => d === 1], ['Beraberlik', 3, (d) => d === 0], ['Dep 1', 4, (d) => d === -1], ['Dep 2', 5, (d) => d === -2], ['Dep 3+', 6, (d) => d <= -3]]
      .map(([l, i, f]) => [l, (e) => e.margin[i].p, (o) => f(o.hg - o.ag)]),
  },
  {
    key: 'bands', label: 'Toplam gol aralığı',
    cats: [['0-1', 0, 0, 1], ['2-3', 1, 2, 3], ['4-5', 2, 4, 5], ['6+', 3, 6, 99]].map(([l, i, lo, hi]) => [l, (e) => e.bands[i].p, (o) => o.hg + o.ag >= lo && o.hg + o.ag <= hi]),
  },
  {
    key: 'euro', label: 'Avrupa handikapı (-1 / +1)',
    cats: [['Ev -1: ev', (e) => e.euro[-1].h, (o) => o.hg - 1 > o.ag], ['Ev -1: ber.', (e) => e.euro[-1].d, (o) => o.hg - 1 === o.ag], ['Ev -1: dep', (e) => e.euro[-1].a, (o) => o.hg - 1 < o.ag],
      ['Ev +1: ev', (e) => e.euro[1].h, (o) => o.hg + 1 > o.ag], ['Ev +1: ber.', (e) => e.euro[1].d, (o) => o.hg + 1 === o.ag], ['Ev +1: dep', (e) => e.euro[1].a, (o) => o.hg + 1 < o.ag]],
    binary: true,
  },
  {
    key: 'asian', label: 'Asya handikapı (yarım hatlar)',
    cats: [-1.5, -0.5, 0.5, 1.5].map((line) => [`Ev ${line > 0 ? '+' : ''}${line}`, (e) => e.asian.find((x) => x.line === line).win, (o) => o.hg + line > o.ag]),
    binary: true,
  },
  {
    key: 'first', label: 'İlk golü kim atar', needFirst: true,
    cats: [['Ev', (e) => e.firstGoal.home, (o) => o.hs.first === 'h'], ['Dep', (e) => e.firstGoal.away, (o) => o.hs.first === 'a'], ['Gol yok', (e) => e.firstGoal.none, (o) => o.hs.first === null]],
  },
  {
    key: 'eo', label: 'Toplam gol tek / çift',
    cats: [['Çift', (e) => e.even, (o) => (o.hg + o.ag) % 2 === 0], ['Tek', (e) => e.odd, (o) => (o.hg + o.ag) % 2 === 1]],
  },
];

function evalGroup(g, items, which = 'ex') {
  const use = items.filter((o) => (!g.needHalves && !g.needFirst) || o.hs);
  const n = use.length;
  if (n < 30) return { key: g.key, label: g.label, n, enough: false };
  const K = g.cats.length;
  const pred = g.cats.map(() => 0), obs = g.cats.map(() => 0);
  const rows = use.map((o) => {
    const p = g.cats.map((c) => Math.min(1, Math.max(0, c[1](o[which]))));
    const y = g.cats.map((c) => (c[2](o) ? 1 : 0));
    for (let k = 0; k < K; k++) { pred[k] += p[k]; obs[k] += y[k]; }
    return { p, y };
  });
  const base = obs.map((v) => v / n);
  let bm = 0, bb = 0;
  const diffs = [];
  for (const r of rows) {
    let sm = 0, sb = 0;
    for (let k = 0; k < K; k++) { sm += (r.p[k] - r.y[k]) ** 2; sb += (base[k] - r.y[k]) ** 2; }
    bm += sm; bb += sb; diffs.push(sb - sm);
  }
  const md = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - md) ** 2, 0) / (n - 1));
  const z = sd > 0 ? md / (sd / Math.sqrt(n)) : 0;
  let ece = 0;
  for (let k = 0; k < K; k++) ece += Math.abs(pred[k] / n - base[k]);
  return {
    key: g.key, label: g.label, n, enough: true,
    brier: bm / n, brierBase: bb / n, skill: bb > 0 ? 1 - bm / bb : null, z,
    verdict: z >= 1.64 ? 'ok' : z <= -1.64 ? 'worse' : 'neutral',
    bias: ece / K,
    cats: g.cats.map((c, k) => ({ label: c[0], pred: pred[k] / n, obs: base[k], n })),
  };
}

function evaluate(items) {
  const groups = GROUPS.map((g) => evalGroup(g, items, 'ex'));
  // ilk yarı pazarlarında ölçülen pay ile varsayılan %46'yı karşılaştır
  const cmp = {};
  for (const key of ['ht', 'htg']) {
    const g = GROUPS.find((x) => x.key === key);
    const a = evalGroup(g, items, 'ex'), b = evalGroup(g, items.filter((o) => o.ex46).map((o) => ({ ...o, ex46: o.ex46 })), 'ex46');
    if (a.enough && b.enough) cmp[key] = { n: a.n, measured: a.brier, def: b.brier };
  }
  return { groups, shareCompare: cmp };
}

module.exports = { HALF1, halvesOf, share, GROUPS, evaluate, evalGroup, clockBase };
