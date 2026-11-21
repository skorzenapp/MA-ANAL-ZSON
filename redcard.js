'use strict';
// Kırmızı kartın gol beklentisine etkisi (canlı olasılıklar için).
// Soru: bir takım 10 kişi kalınca (ya da rakibi 10 kişi kalınca) kalan dakikalarda beklenenden ne kadar farklı gol atılıyor?
// Yöntem: her maç, kırmızı kart dakikalarında parçalara bölünür; her parça için modelin maç beklentisi (mu) o parçanın dakika payıyla
// çarpılır (gol dağılımı için model.shareDone). Poisson regresyon: log λ = log mu + c + a·(az oyuncu) + b·(fazla oyuncu).
// Birden çok ligin ölçümü ters varyans ağırlıklı ortalamayla birleştirilir (kırmızı kart nadir, tek lig çoğu zaman yetmez).

const GLM = require('./glm');
const { shareDone } = require('./model');

const SHR = 0.7;
const Z_MIN = 2.2; // iki özellik denendiği için tek tek z ≥ 2,2
const FEATS = [
  { key: 'down', label: 'Takım 10 kişi (rakipten az oyuncu)' },
  { key: 'up', label: 'Rakip 10 kişi (rakipten fazla oyuncu)' },
];
const END = 90;

const isRed = (type) => /(^|-)red(-|$)/.test(String(type || ''));
const minuteOf = (k) => {
  if (k.min != null && Number.isFinite(k.min)) return k.min;
  const m = String(k.clock || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

// maçın kırmızı kartları ve golleri; kayıt tutarsızsa null (o maç ölçüme girmez)
function eventsOf(rec, homeId, awayId, hg, ag) {
  if (!rec || !Array.isArray(rec.keyEvents)) return null;
  const sideOf = (tid) => (String(tid) === String(homeId) ? 'h' : String(tid) === String(awayId) ? 'a' : null);
  const reds = [], goals = [];
  for (const k of rec.keyEvents) {
    const s = sideOf(k.teamId), m = minuteOf(k);
    if (isRed(k.type)) { if (!s || m == null) return null; reds.push({ min: Math.max(0, Math.min(END, m)), side: s }); }
    else if (k.scoring) { if (!s || m == null) return null; goals.push({ min: Math.max(0, Math.min(END, m)), side: s }); }
  }
  if (goals.filter((g) => g.side === 'h').length !== hg || goals.filter((g) => g.side === 'a').length !== ag) return null;
  // takım istatistiğindeki kırmızı sayısı olay listesiyle tutmuyorsa dakikalar eksik demektir
  const ts = rec.teamStats;
  if (ts && ts[homeId] && ts[awayId] && ts[homeId].redCards != null && ts[awayId].redCards != null) {
    const tot = Number(ts[homeId].redCards) + Number(ts[awayId].redCards);
    if (Number.isFinite(tot) && tot !== reds.length) return null;
  }
  reds.sort((a, b) => a.min - b.min);
  return { reds, goals };
}

// feed: [{hg, ag, lh, la, reds, goals, share}]  -> satırlar [{y, mu, x:[1, az, fazla]}]
function buildRows(feed) {
  const rows = [];
  for (const f of feed) {
    if (!f || !f.goals || f.lh == null || f.la == null || !(f.lh > 0) || !(f.la > 0)) continue;
    for (const side of ['h', 'a']) {
      const lam = side === 'h' ? f.lh : f.la;
      let net = 0, start = 0;
      const segs = [];
      for (const r of f.reds) {
        const m = Math.max(start, r.min);
        segs.push({ a: start, b: m, net });
        net += r.side === side ? -1 : 1;
        start = m;
      }
      segs.push({ a: start, b: END + 1, net });
      for (const sg of segs) {
        const share = shareDone(Math.min(sg.b, END), f.share) - shareDone(sg.a, f.share);
        if (!(share > 1e-4)) continue;
        const y = f.goals.filter((g) => g.side === side && g.min >= sg.a && (g.min < sg.b || (sg.b > END && g.min <= END))).length;
        rows.push({ y, mu: lam * share, x: [1, sg.net < 0 ? 1 : 0, sg.net > 0 ? 1 : 0] });
      }
    }
  }
  return rows;
}

function estimate(rows) {
  const n = rows.filter((r) => r.x[0]).length;
  const cnt = { down: rows.filter((r) => r.x[1]).length, up: rows.filter((r) => r.x[2]).length };
  const empty = { enough: false, n, counts: cnt };
  if (rows.length < 120 || cnt.down < 8 || cnt.up < 8) return empty;
  const r = GLM.fit(rows, 3, { minRows: 120, minActive: 8 });
  if (!r.enough || !r.se) return empty;
  const base = (arr) => (arr.length >= 5 ? arr.reduce((s, x) => s + x.y, 0) / arr.reduce((s, x) => s + x.mu, 0) : null);
  const feats = FEATS.map((f, j) => {
    const b = r.beta[j + 1], se = r.se[j + 1], z = se > 0 ? b / se : 0;
    const on = rows.filter((x) => x.x[j + 1]);
    return { key: f.key, label: f.label, n: cnt[f.key], goals: on.reduce((s, x) => s + x.y, 0), beta: b, se, z, prec: se > 0 ? 1 / (se * se) : 0, adopted: Math.abs(z) >= Z_MIN, ratio: base(on) };
  });
  const applied = {};
  for (const f of feats) if (f.adopted) applied[f.key] = f.beta * SHR;
  return { enough: true, n, counts: cnt, feats, applied: Object.keys(applied).length ? applied : null };
}

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

// net: ev sahibi açısından (deplasman kırmızısı - ev kırmızısı); > 0 ev sahibi fazla oyuncuda
function factors(k, net) {
  if (!k || !net) return { home: 1, away: 1 };
  const hs = net > 0 ? k.up : k.down, as = net > 0 ? k.down : k.up;
  return { home: Math.exp(hs || 0), away: Math.exp(as || 0) };
}
// canlı/kayıtlı maçtaki kırmızı kartlar (olay listesinden)
function redsOfRec(rec) {
  const hid = String(rec.home && rec.home.id), aid = String(rec.away && rec.away.id);
  return (rec.keyEvents || []).filter((k) => isRed(k.type)).map((k) => ({ min: minuteOf(k), side: String(k.teamId) === hid ? 'h' : String(k.teamId) === aid ? 'a' : null })).filter((x) => x.side);
}
function netOf(reds) { return reds.reduce((s, r) => s + (r.side === 'a' ? 1 : -1), 0); }

module.exports = { FEATS, isRed, redsOfRec, eventsOf, buildRows, estimate, pool, factors, netOf, SHR, Z_MIN };
