'use strict';
// Kilit oyuncu eksikliğinin gol beklentisine etkisi.
// Fikir: bir takımın kilit oyuncusu (gol ve asist payı büyük) oynamadığında, o takımın attığı gol modelin
// beklentisinin altında kalıyor mu? Bunu geçmiş maçların kadro verisinden ölçeriz ve sadece istatistiksel
// olarak anlamlıysa "doğrulandı" sayarız.

const DEFAULT_K = { att: 0.35, def: 0.25 }; // ölçüm yapılamadığında kullanılan varsayılan etki (doğrulanmamış)

function posGroup(abbr) {
  const t = String(abbr || '').toUpperCase();
  if (t === 'G' || t === 'GK') return 'G';
  if (/^(CD|CB|LB|RB|D|LWB|RWB|WB|SW)/.test(t)) return 'D';
  if (/^(F|CF|ST|S|LW|RW|AM-L|AM-R)/.test(t)) return 'F';
  return 'M';
}
const played = (p) => !!(p.starter || p.subbedIn || (p.stats && (p.stats.appearances || 0) > 0));

// Bir takımın "şu maçtan önceki" geçmişinden eksik oyuncu özelliklerini çıkarır.
// hist: bu takımın önceki maçları, EN YENİ başta: [{players: Map(id -> {pos, starter, goals, assists})}]
// cur: bu maçta oynayan oyuncu kimlikleri (Set)
function missFeatures(hist, cur) {
  const H = hist.slice(0, 30);
  if (H.length < 8) return null;
  const agg = new Map();
  H.forEach((m, idx) => {
    for (const [id, p] of m.players) {
      let o = agg.get(id);
      if (!o) { o = { id, pos: p.pos, apps: 0, starts: 0, goals: 0, assists: 0, last: idx }; agg.set(id, o); }
      o.apps++; if (p.starter) o.starts++;
      o.goals += p.goals || 0; o.assists += p.assists || 0;
      if (idx < o.last) o.last = idx;
    }
  });
  let C = 0;
  for (const o of agg.values()) C += o.goals + 0.5 * o.assists;
  let missAtt = 0, absDef = 0;
  for (const o of agg.values()) {
    if (cur.has(o.id)) continue;
    if (o.last > 5) continue; // son 6 maçta hiç oynamadıysa takımdan ayrılmış olabilir: sayma
    if (C > 0 && o.apps >= 0.4 * H.length) missAtt += (o.goals + 0.5 * o.assists) / C;
    const g = posGroup(o.pos);
    if ((g === 'G' || g === 'D') && o.starts >= 0.6 * H.length) absDef++;
  }
  return { att: Math.min(0.6, missAtt), def: Math.min(1, absDef / 5), n: H.length };
}

// Maç öncesi, açıklanan kadroya göre: kilit oyuncu(lar) bu maçın 18'inde yok mu?
// hist: missFeatures ile aynı (en yenisi başta; oyuncu bilgisinde name de olabilir). squad: 18'e girenlerin kimlikleri, starters: ilk 11.
// Ölçümde "eksik" = o maçta hiç oynamayan kilit oyuncu idi. Burada: 18'de yok -> tam eksik (ağırlık 1); yedekte -> yarım (0,5, oyuna girebilir).
// Aynı eşikler (son 6 maçta oynamış, maçların %40'ında oynamış, %60'ında ilk 11'de savunmacı) kullanılır ki ölçülen katsayı aynen geçerli olsun.
function lineupMiss(hist, squad, starters) {
  const H = hist.slice(0, 30);
  if (H.length < 8) return null;
  const agg = new Map();
  H.forEach((m, idx) => {
    for (const [id, p] of m.players) {
      let o = agg.get(id);
      if (!o) { o = { id, name: p.name || null, pos: p.pos, apps: 0, starts: 0, goals: 0, assists: 0, last: idx }; agg.set(id, o); }
      o.apps++; if (p.starter) o.starts++;
      o.goals += p.goals || 0; o.assists += p.assists || 0;
      if (idx < o.last) o.last = idx;
      if (!o.name && p.name) o.name = p.name;
    }
  });
  let C = 0;
  for (const o of agg.values()) C += o.goals + 0.5 * o.assists;
  let att = 0, def = 0;
  const absent = [];
  for (const o of agg.values()) {
    if (starters.has(o.id) || o.last > 5) continue;
    const w = squad.has(o.id) ? 0.5 : 1;
    const share = C > 0 ? (o.goals + 0.5 * o.assists) / C : 0;
    const regAtt = C > 0 && o.apps >= 0.4 * H.length;
    const g = posGroup(o.pos);
    const regDef = (g === 'G' || g === 'D') && o.starts >= 0.6 * H.length;
    if (regAtt) att += w * share;
    if (regDef) def += w / 5;
    if ((regAtt && share >= 0.08) || regDef) absent.push({ name: o.name || '?', pos: o.pos, status: w === 1 ? 'Kadroda yok' : 'Yedekte', detail: '', share, goals: o.goals, assists: o.assists, starts: o.starts, kind: regAtt && share >= 0.08 ? 'att' : 'def', w });
  }
  absent.sort((a, b) => b.share - a.share || b.starts - a.starts);
  return { absent, att: Math.min(0.6, att), def: Math.min(1, def), n: H.length };
}

// rows: [{y: atılan gol, mu: modelin beklentisi, x: atan takımın hücum eksiği, z: rakibin savunma eksiği}]
function ll(rows, kA, kD) {
  let s = 0;
  for (const r of rows) {
    const eta = Math.log(r.mu) - kA * r.x + kD * r.z;
    s += r.y * eta - Math.exp(eta);
  }
  return s;
}
function estimate(rows) {
  const n = rows.length;
  if (n < 60) return { enough: false, n };
  const ll0 = ll(rows, 0, 0);
  let best = { kA: 0, kD: 0, v: ll0 };
  for (let a = 0; a <= 4.001; a += 0.1) for (let d = 0; d <= 4.001; d += 0.1) {
    const v = ll(rows, a, d);
    if (v > best.v) best = { kA: a, kD: d, v };
  }
  const c = { ...best };
  for (let a = Math.max(0, c.kA - 0.1); a <= c.kA + 0.1001; a += 0.02) for (let d = Math.max(0, c.kD - 0.1); d <= c.kD + 0.1001; d += 0.02) {
    const v = ll(rows, a, d);
    if (v > best.v) best = { kA: a, kD: d, v };
  }
  const LR = 2 * (best.v - ll0);
  const aff = rows.filter((r) => r.x >= 0.15), none = rows.filter((r) => r.x < 0.05);
  const ratio = (arr) => (arr.length >= 5 ? arr.reduce((s, r) => s + r.y, 0) / arr.reduce((s, r) => s + r.mu, 0) : null);
  const affD = rows.filter((r) => r.z >= 0.15), noneD = rows.filter((r) => r.z < 0.05);
  const significant = LR >= 5.99 && (best.kA > 0 || best.kD > 0);
  const SHR = 0.7; // ölçülen etkiyi biraz küçült (aşırı uyumdan kaçınmak için)
  return {
    enough: true, n, nAtt: aff.length, nDef: affD.length,
    kA: best.kA, kD: best.kD, LR, significant,
    applied: significant ? { att: best.kA * SHR, def: best.kD * SHR } : null,
    ratioAtt: { aff: ratio(aff), none: ratio(none) },
    ratioDef: { aff: ratio(affD), none: ratio(noneD) },
  };
}

// recs: eskiden yeniye [{t, id, h, a, hg, ag, lh, la, rosters}], lh/la: o maç için modelin beklentisi (yoksa null)
function buildRows(recs) {
  const hist = new Map(); // takım -> [{players}] eskiden yeniye
  const rows = [];
  const playersOf = (ro) => {
    const m = new Map();
    for (const p of ro.players) if (played(p)) m.set(p.id, { pos: p.pos, starter: p.starter, goals: (p.stats && p.stats.totalGoals) || 0, assists: (p.stats && p.stats.goalAssists) || 0 });
    return m;
  };
  for (const r of recs) {
    const rh = r.rosters.find((x) => x.teamId === r.h), ra = r.rosters.find((x) => x.teamId === r.a);
    if (!rh || !ra || rh.players.length < 11 || ra.players.length < 11) continue;
    const ph = playersOf(rh), pa = playersOf(ra);
    if (ph.size < 11 || pa.size < 11) continue;
    if (r.lh != null && r.la != null && r.lh > 0 && r.la > 0) {
      const fh = missFeatures((hist.get(r.h) || []).slice().reverse(), new Set(ph.keys()));
      const fa = missFeatures((hist.get(r.a) || []).slice().reverse(), new Set(pa.keys()));
      if (fh && fa) {
        rows.push({ y: r.hg, mu: r.lh, x: fh.att, z: fa.def });
        rows.push({ y: r.ag, mu: r.la, x: fa.att, z: fh.def });
      }
    }
    for (const [id, pl] of [[r.h, ph], [r.a, pa]]) { let a = hist.get(id); if (!a) { a = []; hist.set(id, a); } a.push({ players: pl }); }
  }
  return rows;
}

// ESPN'in sakat/cezalı listesi ile takımın oyuncu istatistiklerinden maç öncesi eksik özelliklerini hesaplar
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function sameName(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '), ys = y.split(' ');
  const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
  return lx.length > 2 && lx === ly && (xs[0][0] === ys[0][0] || xs.length === 1 || ys.length === 1);
}
const weightOf = (status) => (/doubt|question|day|probable/i.test(String(status || '')) ? 0.5 : 1);
const statusTr = (s) => { const v = String(s || ''); return /susp/i.test(v) ? 'Cezalı' : /doubt|question|day|probable/i.test(v) ? 'Şüpheli' : 'Yok'; };

// td: store.teamData çıktısı (players, matchCount), injuries: [{name,pos,status,detail}]
function currentMiss(td, injuries) {
  const N = Math.max(1, td.matchCount || 1);
  const players = (td.players || []).filter((p) => p.apps >= 3);
  let C = 0;
  for (const p of players) C += p.goals + 0.5 * p.assists;
  const absent = [];
  let att = 0, def = 0;
  for (const inj of injuries || []) {
    const p = players.find((q) => sameName(q.name, inj.name));
    if (!p) continue;
    const w = weightOf(inj.status);
    const share = C > 0 ? (p.goals + 0.5 * p.assists) / C : 0;
    const g = posGroup(p.pos);
    const regAtt = p.apps >= 0.4 * N && share >= 0.08;
    const regDef = (g === 'G' || g === 'D') && p.starts >= 0.6 * N;
    if (!regAtt && !regDef) continue;
    if (regAtt) att += share * w;
    if (regDef) def += w / 5;
    absent.push({ name: p.name, pos: p.pos, status: statusTr(inj.status), detail: inj.detail || '', share, goals: p.goals, assists: p.assists, starts: p.starts, kind: regAtt ? 'att' : 'def', w });
  }
  return { absent, att: Math.min(0.6, att), def: Math.min(1, def) };
}

// çarpanlar: sakat eksiği olan takımın gol beklentisi düşer, rakibinin savunma eksiği ise artırır
function factors(k, mh, ma) {
  return { home: Math.exp(-k.att * mh.att + k.def * ma.def), away: Math.exp(-k.att * ma.att + k.def * mh.def) };
}

module.exports = { DEFAULT_K, posGroup, played, missFeatures, lineupMiss, buildRows, estimate, currentMiss, factors, sameName, statusTr };
