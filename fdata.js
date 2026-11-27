'use strict';
// İkinci veri kaynağı: football-data.co.uk (ücretsiz CSV dosyaları, anahtar/kayıt gerekmez).
// Sağladıkları: bahis şirketi ortalama oranları (kapanış), hakem adı (geçmiş maçlar ve yaklaşan maçlar için fixtures.csv), sarı/kırmızı kart.
// ESPN'in vermediği ya da çok az verdiği yerleri doldurur: ESPN'den gelen maç kaydına ek olarak "piyasa" ve "hakem" tamamlanır.
// Kullanım koşulu (site): veri "özel kişiler için"; ticari kullanım ya da toplu otomatik kazıma yasak. Bu yüzden istekler az ve önbellekli:
// lig başına en çok 2 dosya (bu sezon + geçen sezon), 3 saatte bir en çok bir kez; fixtures.csv 90 dakikada bir.
// Maç eşleştirme: tarih (±1,5 gün) + skor, takım adları ESPN ile farklı yazıldığı için ad benzerliği + skor eşleşmesinden öğrenilen ad tablosu.

const U = require('./util');

const BASE = (process.env.FD_BASE || 'https://www.football-data.co.uk').replace(/\/$/, '');
const ENABLED = process.env.FD !== '0';
const HOUR = 3600000, DAY = 86400000;

// ESPN lig kodu -> football-data dosyası. main: mmz4281/<sezon>/<kod>.csv ; extra: new/<kod>.csv (tüm sezonlar tek dosyada)
const MAP = {
  'eng.1': ['main', 'E0'], 'eng.2': ['main', 'E1'], 'eng.3': ['main', 'E2'], 'eng.4': ['main', 'E3'], 'eng.5': ['main', 'EC'],
  'sco.1': ['main', 'SC0'], 'sco.2': ['main', 'SC1'],
  'ger.1': ['main', 'D1'], 'ger.2': ['main', 'D2'], 'ita.1': ['main', 'I1'], 'ita.2': ['main', 'I2'],
  'esp.1': ['main', 'SP1'], 'esp.2': ['main', 'SP2'], 'fra.1': ['main', 'F1'], 'fra.2': ['main', 'F2'],
  'ned.1': ['main', 'N1'], 'bel.1': ['main', 'B1'], 'por.1': ['main', 'P1'], 'tur.1': ['main', 'T1'], 'gre.1': ['main', 'G1'],
  'arg.1': ['extra', 'ARG'], 'aut.1': ['extra', 'AUT'], 'bra.1': ['extra', 'BRA'], 'chn.1': ['extra', 'CHN'], 'den.1': ['extra', 'DNK'],
  'jpn.1': ['extra', 'JPN'], 'mex.1': ['extra', 'MEX'], 'nor.1': ['extra', 'NOR'], 'rus.1': ['extra', 'RUS'], 'swe.1': ['extra', 'SWE'], 'usa.1': ['extra', 'USA'],
};
const codeOf = (slug) => (MAP[slug] ? MAP[slug][1] : null);
const covered = (slug) => !!MAP[slug];

// ---------- ağ ----------
const stats = { calls: 0, fails: 0, notFound: 0, bytes: 0, lastError: null, lastOk: 0 };
const lim = new U.Limiter(2);
let downUntil = 0;
async function fetchText(url) {
  return lim.run(async () => {
    stats.calls++;
    const res = await fetch(url, { headers: { 'User-Agent': 'MacAnaliz/1.8 (kisisel kullanim)', Accept: 'text/csv,*/*' }, signal: AbortSignal.timeout(40000) });
    if (res.status === 404) return { none: true };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const t = await res.text();
    stats.bytes += t.length;
    return { t };
  });
}

// ---------- CSV ----------
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
const num = (v) => { if (v == null) return null; const x = parseFloat(String(v).trim()); return Number.isFinite(x) ? x : null; };
const int = (v) => { const x = num(v); return x == null ? null : Math.round(x); };
// dd/mm/yy ya da dd/mm/yyyy (+ saat) -> UTC ms (saat İngiltere saati sayılır, ±1 saatlik fark eşleştirmeyi etkilemez)
function parseDate(d, t) {
  const m = String(d || '').trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += y > 70 ? 1900 : 2000;
  let hh = 12, mm = 0;
  const tm = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (tm) { hh = Number(tm[1]); mm = Number(tm[2]); }
  const ms = Date.UTC(y, Number(m[2]) - 1, Number(m[1]), hh, mm);
  return Number.isFinite(ms) ? ms : null;
}
// oran üçlüsü -> marj çıkarılmış olasılıklar
function triple(h, d, a) {
  if (!(h > 1) || !(d > 1) || !(a > 1)) return null;
  const s = 1 / h + 1 / d + 1 / a;
  return { dec: [h, d, a], p: [1 / h / s, 1 / d / s, 1 / a / s], margin: s - 1 };
}
function pair(o, u) {
  if (!(o > 1) || !(u > 1)) return null;
  const s = 1 / o + 1 / u;
  return { over: 1 / o / s, under: 1 / u / s };
}
// satırdaki ilk eksiksiz oran üçlüsü (öncelik sırasına göre)
const X12 = [['AvgCH', 'AvgCD', 'AvgCA'], ['AvgH', 'AvgD', 'AvgA'], ['B365CH', 'B365CD', 'B365CA'], ['B365H', 'B365D', 'B365A'], ['PSCH', 'PSCD', 'PSCA'], ['PSH', 'PSD', 'PSA'], ['PH', 'PD', 'PA'], ['PPCH', 'PPCD', 'PPCA'], ['MaxCH', 'MaxCD', 'MaxCA'], ['MaxH', 'MaxD', 'MaxA']];
const BOOK = [['B365CH', 'B365CD', 'B365CA'], ['B365H', 'B365D', 'B365A']]; // bahisçinin gerçekte alabileceği fiyat
const OU = [['AvgC>2.5', 'AvgC<2.5'], ['Avg>2.5', 'Avg<2.5'], ['B365C>2.5', 'B365C<2.5'], ['B365>2.5', 'B365<2.5'], ['P>2.5', 'P<2.5'], ['PC>2.5', 'PC<2.5'], ['Max>2.5', 'Max<2.5']];
// CSV satırı -> ortak biçim. Ana dosyalar: HomeTeam/AwayTeam/FTHG/FTAG, ek lig dosyaları: Home/Away/HG/AG
function normRows(text) {
  const tbl = parseCsv(text);
  if (tbl.length < 2) return [];
  const head = tbl[0].map((x) => String(x).trim());
  const ix = new Map(head.map((x, i) => [x, i]));
  const g = (r, k) => (ix.has(k) ? r[ix.get(k)] : undefined);
  const first = (r, names) => { for (const n of names) { const v = g(r, n); if (v != null && String(v).trim() !== '') return String(v).trim(); } return null; };
  const out = [];
  for (let i = 1; i < tbl.length; i++) {
    const r = tbl[i];
    const h = first(r, ['HomeTeam', 'Home']), a = first(r, ['AwayTeam', 'Away']);
    const t = parseDate(first(r, ['Date']), first(r, ['Time']));
    if (!h || !a || t == null) continue;
    const hg = int(first(r, ['FTHG', 'HG'])), ag = int(first(r, ['FTAG', 'AG']));
    const o = { t, h, a, hg: hg == null || ag == null ? null : hg, ag: hg == null || ag == null ? null : ag };
    const dv = first(r, ['Div']);
    if (dv) o.div = dv;
    const ref = first(r, ['Referee']);
    if (ref) o.ref = ref;
    for (const [k, f] of [['hy', 'HY'], ['ay', 'AY'], ['hr', 'HR'], ['ar', 'AR']]) { const v = int(g(r, f)); if (v != null) o[k] = v; }
    for (const cols of X12) {
      const tr = triple(num(g(r, cols[0])), num(g(r, cols[1])), num(g(r, cols[2])));
      if (tr) { o.p = tr.p.map((x) => +x.toFixed(5)); o.src = cols[0].replace(/[HDA]$/, ''); o.dec = tr.dec; break; }
    }
    if (o.p) for (const cols of BOOK) { const b = [num(g(r, cols[0])), num(g(r, cols[1])), num(g(r, cols[2]))]; if (b.every((x) => x > 1)) { o.dec = b; break; } }
    for (const cols of OU) { const pr = pair(num(g(r, cols[0])), num(g(r, cols[1]))); if (pr) { o.ou = +pr.over.toFixed(5); break; } }
    out.push(o);
  }
  return out;
}

// ---------- takım adı benzerliği ----------
const STOP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'as', 'ssc', 'fk', 'sk', 'bk', 'if', 'ik', 'club', 'de', 'la', 'el', 'the', 'and', 'ud', 'cd', 'sd', 'rc', 'us', 'ss', 'fsv', 'sv', 'tsv', 'vfb', 'vfl', 'calcio']);
const ALIAS = [[/\bman\b/g, 'manchester'], [/\butd\b/g, 'united'], [/\bnott'?m\b/g, 'nottingham'], [/\bath\b/g, 'athletic'], [/\bsp\b/g, 'sporting'], [/\bwolves\b/g, 'wolverhampton'], [/\bspurs\b/g, 'tottenham'], [/\bpsg\b/g, 'paris'], [/\bm'?gladbach\b/g, 'monchengladbach'], [/\bin\b/g, 'internazionale']];
function tokens(name) {
  let s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/[.&]/g, ' ');
  for (const [re, to] of ALIAS) s = s.replace(re, to);
  s = s.replace(/[^a-z0-9' ]/g, ' ').replace(/'/g, '');
  return s.split(/\s+/).filter((x) => x && !STOP.has(x));
}
function tokMatch(a, b) { return a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))); }
// 0..1: kısa adın bütün sözcükleri uzun adda varsa yüksek; tek kelimelik adlarda ön ek eşleşmesi
function sim(x, y) {
  const A = tokens(x), B = tokens(y);
  if (!A.length || !B.length) return 0;
  if (A.join(' ') === B.join(' ')) return 1;
  const [S, Lg] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set();
  let m = 0;
  for (const t of S) { const j = Lg.findIndex((u, k) => !used.has(k) && tokMatch(t, u)); if (j >= 0) { used.add(j); m++; } }
  if (m === S.length) return 0.85 + 0.1 * (S.length / Lg.length);
  return (0.8 * m) / Math.max(A.length, B.length);
}

// ---------- lig verisi (bellek + disk) ----------
const leagueMem = new Map(); // slug -> { at, rows, fix }
async function fetchRows(url, ttl, ns = 'fd') {
  const c = U.diskGet(ns, url, ttl);
  if (c.hit) return c.d && c.d.rows ? c.d.rows : null;
  if (Date.now() < downUntil) { const old = U.diskGet(ns, url, Infinity); return old.hit && old.d ? old.d.rows || null : null; }
  return U.once('fd:' + url, async () => {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetchText(url);
        if (r.none) { stats.notFound++; U.diskSet(ns, url, { rows: null }); return null; }
        const rows = normRows(r.t);
        U.diskSet(ns, url, { rows });
        stats.lastOk = Date.now(); stats.lastError = null;
        return rows;
      } catch (e) { lastErr = e; stats.fails++; stats.lastError = String(e.message || e).slice(0, 120); await U.sleep(700 * (i + 1)); }
    }
    downUntil = Date.now() + 10 * 60000; // ulaşılamıyorsa 10 dakika dene(me)
    U.log('football-data.co.uk ulaşılamadı:', lastErr && lastErr.message);
    const old = U.diskGet(ns, url, Infinity);
    return old.hit && old.d ? old.d.rows || null : null;
  });
}
function seasonCode(d) { const y = d.getUTCFullYear(), m = d.getUTCMonth(); const s = m >= 6 ? y : y - 1; return String(s % 100).padStart(2, '0') + String((s + 1) % 100).padStart(2, '0'); }
// fixtures.csv: yaklaşan maçlar (tüm ligler tek dosyada, Div sütunuyla ayrılır)
async function fixturesFor(code) {
  const rows = await fetchRows(`${BASE}/fixtures.csv`, 90 * 60000, 'fdx');
  return (rows || []).filter((r) => r.div === code);
}
// bir lig için tüm satırlar (geçmiş + yaklaşan), t'ye göre sıralı
async function load(slug) {
  if (!ENABLED || !MAP[slug]) return null;
  const hit = leagueMem.get(slug);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;
  return U.once('fdl:' + slug, async () => {
    const [kind, code] = MAP[slug];
    const now = new Date();
    let rows = [];
    if (kind === 'main') {
      const cur = seasonCode(now), prev = seasonCode(new Date(now.getTime() - 365 * DAY));
      const [a, b] = await Promise.all([fetchRows(`${BASE}/mmz4281/${cur}/${code}.csv`, 3 * HOUR), fetchRows(`${BASE}/mmz4281/${prev}/${code}.csv`, 20 * DAY)]);
      rows = [...(b || []), ...(a || [])];
      const fx = await fixturesFor(code).catch(() => []);
      for (const f of fx) if (f && !rows.some((r) => r.h === f.h && r.a === f.a && Math.abs(r.t - f.t) < 2 * DAY)) rows.push({ ...f, fixture: true });
    } else {
      const all = await fetchRows(`${BASE}/new/${code}.csv`, 12 * HOUR);
      const cut = Date.now() - 800 * DAY;
      rows = (all || []).filter((r) => r.t >= cut);
    }
    rows.sort((x, y) => x.t - y.t);
    const v = { at: Date.now(), ttl: rows.length ? 3 * HOUR : 10 * 60000, rows, code, kind, map: loadMap(slug) }; // veri alınamadıysa 10 dakika sonra yeniden dene
    leagueMem.set(slug, v);
    return v;
  });
}

// ---------- takım adı tablosu (ESPN takım kimliği -> football-data adı) ----------
function loadMap(slug) {
  const c = U.diskGet('fdm', slug, Infinity);
  return new Map(c.hit && c.d ? Object.entries(c.d) : []);
}
function saveMap(slug, map) { U.diskSet('fdm', slug, Object.fromEntries(map)); }
const DAYMS = 36 * HOUR;
// matches: [{id,t,h,a,hg,ag,hn,an}] (ESPN'den biten maçlar). Skor + tarih eşleşmelerinden takım adlarını öğrenir.
async function learn(slug, matches) {
  const L = await load(slug);
  if (!L || !L.rows.length) return { rows: 0, mapped: 0 };
  const done = L.rows.filter((r) => r.hg != null);
  const cands = (m) => done.filter((r) => Math.abs(r.t - m.t) <= DAYMS && r.hg === m.hg && r.ag === m.ag);
  const votes = new Map(); // espnId -> Map(fdName -> sayı)
  const vote = (id, name) => { let v = votes.get(id); if (!v) { v = new Map(); votes.set(id, v); } v.set(name, (v.get(name) || 0) + 1); };
  const map = new Map(L.map);
  const nameOf = (m, side) => (side === 'h' ? m.hn : m.an);
  for (const m of matches) {
    if (m.hg == null || m.ag == null) continue;
    const c = cands(m);
    if (c.length === 1) { vote(m.h, c[0].h); vote(m.a, c[0].a); continue; }
    const good = c.filter((r) => sim(nameOf(m, 'h'), r.h) >= 0.85 && sim(nameOf(m, 'a'), r.a) >= 0.85);
    if (good.length === 1) { vote(m.h, good[0].h); vote(m.a, good[0].a); }
  }
  const best = (id) => { const v = votes.get(id); if (!v) return null; const arr = [...v.entries()].sort((x, y) => y[1] - x[1]); return { name: arr[0][0], n: arr[0][1], tot: [...v.values()].reduce((s, x) => s + x, 0) }; };
  for (const id of votes.keys()) { const b = best(id); if (b && (b.n >= 2 || b.tot === b.n)) map.set(id, b.name); }
  // ikinci tur: bir tarafı bilinen belirsiz maçlardan diğer tarafı öğren
  for (let pass = 0; pass < 2; pass++) {
    for (const m of matches) {
      if (m.hg == null || m.ag == null) continue;
      const kh = map.get(m.h), ka = map.get(m.a);
      if (kh && ka) continue;
      const c = cands(m).filter((r) => (kh ? r.h === kh : true) && (ka ? r.a === ka : true));
      if (c.length === 1) { if (!kh) vote(m.h, c[0].h); if (!ka) vote(m.a, c[0].a); }
    }
    for (const id of votes.keys()) { if (map.has(id)) continue; const b = best(id); if (b && (b.n >= 2 || b.tot === b.n)) map.set(id, b.name); }
  }
  // aynı football-data adına giden iki takım varsa ikisi de güvenilmez: oyu çok olan kalır
  const inv = new Map();
  for (const [id, name] of map) { const l = inv.get(name) || []; l.push(id); inv.set(name, l); }
  for (const [, ids] of inv) if (ids.length > 1) { const sorted = ids.sort((x, y) => ((best(y) || { n: 0 }).n) - ((best(x) || { n: 0 }).n)); for (const id of sorted.slice(1)) map.delete(id); }
  L.map = map;
  saveMap(slug, map);
  return { rows: done.length, mapped: map.size };
}

// ---------- maç eşleştirme ----------
function sideOk(map, id, espnName, fdName) {
  const known = map.get(id);
  if (known) return known === fdName ? 1 : 0;
  return sim(espnName, fdName) >= 0.8 ? 0.8 : 0;
}
// rec: ESPN maç kaydı (home/away {id,name,short,score}, date, status). Eşleşen football-data satırını verir (yoksa null)
async function lookup(slug, rec) {
  const L = await load(slug);
  if (!L || !L.rows.length) return null;
  const t = Date.parse(rec.date);
  if (!Number.isFinite(t)) return null;
  const finished = rec.status && rec.status.state === 'post';
  const hn = rec.home.name || rec.home.short, an = rec.away.name || rec.away.short;
  const hs = rec.home.score, as = rec.away.score;
  let best = null, bs = 0;
  for (const r of L.rows) {
    const dt = Math.abs(r.t - t);
    if (finished) {
      if (r.hg == null || dt > DAYMS || r.hg !== Number(hs) || r.ag !== Number(as)) continue;
    } else if (r.hg != null || dt > 2.5 * DAY) continue;
    const a = sideOk(L.map, rec.home.id, hn, r.h), b = sideOk(L.map, rec.away.id, an, r.a);
    // bitmiş maçta skor da eşleştiği için tek taraf yeter; yaklaşan maçta iki taraf da tutmalı
    const ok = finished ? a + b >= 0.8 && (a > 0 || b > 0) : a > 0 && b > 0;
    if (!ok) continue;
    const score = a + b + (finished ? 0 : 0) - dt / (10 * DAY);
    if (score > bs) { bs = score; best = r; }
  }
  return best;
}
// ESPN maç kaydına piyasa ve hakem ekler (eksikse ya da fd daha iyiyse). Kayıt değiştirilmez; yeni nesne döner
async function enrich(slug, rec) {
  if (!ENABLED || !MAP[slug] || !rec) return rec;
  let r;
  try { r = await lookup(slug, rec); } catch (e) { return rec; }
  if (!r) return rec;
  const out = { ...rec, fd: { odds: false, ref: false } };
  // yaklaşan maçta ESPN'in kendi (güncel) oranı varsa o kalır: fixtures.csv günde birkaç kez güncellenir, oran hareketi için ESPN daha taze. Biten maçta kapanış ortalaması (daha keskin) kullanılır
  const keepEspn = !!(rec.market && rec.status && rec.status.state === 'pre');
  if (r.p && !keepEspn) {
    const dec = r.dec || [1 / r.p[0], 1 / r.p[1], 1 / r.p[2]];
    out.market = { provider: 'Piyasa ortalaması (football-data.co.uk)', home: r.p[0], draw: r.p[1], away: r.p[2], decHome: dec[0], decDraw: dec[1], decAway: dec[2], total: r.ou != null ? 2.5 : null, overProb: r.ou != null ? r.ou : null, src: 'fd' };
    out.fd.odds = true;
  }
  if (!rec.referee && r.ref) { out.referee = r.ref; out.refSrc = 'football-data.co.uk'; out.fd.ref = true; }
  return out;
}
function status() {
  const leagues = [...leagueMem.entries()].map(([slug, v]) => ({ slug, code: v.code, rows: v.rows.length, withOdds: v.rows.filter((x) => x.p).length, withRef: v.rows.filter((x) => x.ref).length, upcoming: v.rows.filter((x) => x.fixture || x.hg == null).length, mapped: v.map.size, at: v.at }));
  return { enabled: ENABLED, base: BASE, covered: Object.keys(MAP).length, calls: stats.calls, fails: stats.fails, notFound: stats.notFound, lastError: stats.lastError, lastOk: stats.lastOk, leagues };
}

module.exports = { ENABLED, covered, codeOf, load, learn, lookup, enrich, status, parseCsv, normRows, parseDate, triple, sim, tokens, seasonCode, MAP };
