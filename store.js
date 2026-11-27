'use strict';
// Veri katmanı: maç kayıtları, takım/oyuncu/lider verileri, tahmin, karne, arama dizini.
const U = require('./util');
const E = require('./espn');
const L = require('./leagues');
const M = require('./model');
const SP = require('./spmodel');
const AB = require('./absence');
const XG = require('./xg');
const HV = require('./halves');
const RS = require('./rest');
const TIE = require('./tie');
const ST = require('./stakes');
const WX = require('./weather');
const TV = require('./travel');
const FD = require('./fdata');
const BT = require('./betting');
const RF = require('./referee');
const RC = require('./redcard');
const GS = require('./gamestate');
const H2 = require('./h2h');
const OM = require('./oddsmove');

const DAY = U.DAY;
const HOUR = 3600000;

// ---------- konum / mevki ----------
function posGroup(abbr) {
  const t = String(abbr || '').toUpperCase();
  if (t === 'G' || t === 'GK') return 'G';
  if (/^(CD|CB|LB|RB|D|LWB|RWB|WB|SW)/.test(t)) return 'D';
  if (/^(F|CF|ST|S|LW|RW|AM-L|AM-R)/.test(t)) return 'F';
  return 'M';
}
const POS_TR = { G: 'Kaleci', D: 'Defans', M: 'Orta saha', F: 'Forvet' };

// ---------- maç listesi ----------
function dayTtl(dayStr) {
  // Bugün (UTC) canlı olabilir: kısa süre. Dün sadece gece yarısına yakın saatlerde canlı olabilir. Yarın ve ötesi sakin.
  const now = new Date();
  const today = U.ymd(now), yest = U.ymd(U.addDays(now, -1)), tom = U.ymd(U.addDays(now, 1));
  if (dayStr === today) return 60000;
  if (dayStr === yest) return now.getUTCHours() < 8 ? 60000 : 15 * 60000;
  if (dayStr === tom) return 15 * 60000;
  if (dayStr < yest) return 12 * HOUR;
  return 30 * 60000;
}

const slimTeam = (t) => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr, logo: t.logo, score: t.score, winner: t.winner });

async function matchesFor(dateStr, league, tzMin) {
  const slugs = league === 'all' ? L.AVAILABLE : L.BY[league] && L.BY[league].available ? [league] : [];
  const d0 = U.parseYmd(dateStr);
  const dayKeys = [U.ymd(U.addDays(d0, -1)), dateStr, U.ymd(U.addDays(d0, 1))];
  const startUTC = d0.getTime() - tzMin * 60000;
  const endUTC = startUTC + DAY;
  const errors = [];
  const out = new Map();
  await Promise.all(
    slugs.map(async (slug) => {
      try {
        const arrs = await Promise.all(dayKeys.map((k) => E.scoreboardDay(slug, k, { ttl: dayTtl(k) })));
        for (const ev of arrs.flat()) {
          const t = Date.parse(ev.date);
          if (t >= startUTC && t < endUTC) out.set(slug + ':' + ev.id, { id: ev.id, league: slug, date: ev.date, status: ev.status, home: slimTeam(ev.home), away: slimTeam(ev.away) });
        }
      } catch (e) {
        errors.push(slug);
      }
    }),
  );
  const events = [...out.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const e of events) if (e.status && e.status.state === 'pre') OM.watchMatch(e.league, e.id, Date.parse(e.date)); // oran izleyicisine ekle
  return { events, errors };
}

// ---------- maç kaydı ----------
// ESPN maç kaydı + (varsa) football-data.co.uk'tan piyasa ortalaması ve hakem. Ek veri kayda yazılmaz, her okumada eklenir (CSV günde birkaç kez güncellenir)
async function matchRecord(slug, id, opts = {}) {
  const rec = await matchRecordRaw(slug, id, opts);
  let out = rec;
  if (rec && FD.covered(slug)) {
    if (opts.bg) out = await FD.enrich(slug, rec); // arka plan işleri (analiz) veriyi bekler
    else out = await Promise.race([FD.enrich(slug, rec), U.sleep(6000).then(() => rec)]); // kullanıcı isteği: ikinci kaynak yavaşsa beklemez
  }
  observeOdds(slug, id, out);
  return out;
}
// oran hareketi: yaklaşan maçın oranı kaydedilir, maç izleyiciye eklenir; biten maça (kaydı varsa) kapanış oranı eklenir
function observeOdds(slug, id, rec) {
  try {
    if (!rec || !rec.status) return;
    const st = rec.status.state, k = Date.parse(rec.date);
    if (st === 'pre') { OM.watchMatch(slug, id, k); if (rec.market) OM.record(slug, id, rec.market, k); }
    else if (st === 'post' && rec.market && rec.market.src === 'fd') OM.recordClose(slug, id, rec.market);
  } catch (e) { /* kayıt başarısız olursa maç verisi etkilenmesin */ }
}
async function matchRecordRaw(slug, id, { bg = false, fresh = false } = {}) {
  const key = `${slug}:${id}`;
  const c = U.diskGet('r', key, Infinity);
  if (c.hit && c.d) return c.d;
  const mk = 'rec:' + key;
  const m = fresh ? undefined : U.memGet(mk);
  if (m) return m;
  return U.once(mk, async () => {
    const raw = await E.summaryRaw(slug, id, { ttl: fresh ? 1 : 30000, bg });
    if (!raw) return null;
    const rec = E.parseSummary(raw, slug, id);
    if (!rec) return null;
    const st = rec.status.state;
    if (st === 'post' && rec.status.completed) U.diskSet('r', key, rec);
    else U.memSet(mk, rec, st === 'in' ? 25000 : (st === 'pre' && Date.parse(rec.date) - Date.now() < 3 * 3600000 ? 3 * 60000 : 10 * 60000)); // başlamasına 3 saatten az kaldıysa ilk 11 gelsin diye kısa tut
    return rec;
  });
}

async function matchDetail(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) return null;
  const { market, injuries, ...rest } = rec;
  return { ...rest, generatedAt: Date.now() };
}

// ---------- tahmin ----------
const trainCache = new Map();
const xgMem = new Map();
function xgInfo(slug) {
  let x = xgMem.get(slug);
  if (x === undefined) {
    const c = U.diskGet('xg', slug, 90 * 24 * HOUR);
    x = c.hit && c.d ? c.d : null;
    xgMem.set(slug, x);
  }
  return x;
}
function setXg(slug, v) { xgMem.set(slug, v); U.diskSet('xg', slug, v); trainCache.delete(slug); }
const paramsOf = (tp) => (tp ? { halfLife: tp.halfLife, prior: tp.prior, xgW: tp.xgW || 0, thK: tp.thK || 0 } : { ...M.DEFAULT_PARAMS, xgW: 0, thK: 0 });
async function training(slug) {
  const hit = trainCache.get(slug);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.v;
  return U.once('train:' + slug, async () => {
    const pool = L.poolOf(slug) || [slug];
    const now = new Date();
    const months = [];
    for (let k = 0; k < 16; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      months.push(U.ym(d));
    }
    const cur = U.ym(now), prev = U.ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    const matches = [];
    let own = 0;
    let used = 0;
    const skipped = []; // uzatmalı biten maçlar: güç hesabına girmez ama dinlenme takvimi için tutulur
    const etc = { aet: 0, pen: 0 }; // uzatmada biten ve penaltıya giden maç sayıları (tur atlama hesabı için)
    for (const ps of pool) {
      let got = 0;
      let failed = false;
      await Promise.all(
        months.map(async (mo) => {
          try {
            const evs = await E.scoreboardMonth(ps, mo, { ttl: mo === cur || mo === prev ? 20 * 60000 : 24 * HOUR, bg: ps !== slug });
            for (const e of evs) {
              if (!e.status.completed || e.home.score == null || e.away.score == null) continue;
              if (/AET|PEN|EXTRA/i.test(e.status.name || '')) { if (/PEN/i.test(e.status.name)) etc.pen++; else etc.aet++; skipped.push({ id: e.id, t: Date.parse(e.date), h: e.home.id, a: e.away.id }); continue; } // uzatma/penaltıyla biten maçın skoru 90 dakikalık değil
              got++;
              matches.push({ id: e.id, t: Date.parse(e.date), h: e.home.id, a: e.away.id, hg: e.home.score, ag: e.away.score, c: ps, neutral: e.neutral || L.NEUTRAL.has(ps), hn: e.home.name, an: e.away.name, vc: ps === slug ? e.city || null : null });
              if (ps === slug) own++;
            }
          } catch (err) {
            failed = true;
          }
        }),
      );
      if (ps === slug && failed && !got) throw new Error('Veri kaynağına ulaşılamadı');
      if (got) used++;
    }
    // aynı maç iki turnuvada görünürse tekilleştir
    const seen = new Set();
    const uniq = matches.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    // şut bazlı beklenen gol (analiz işi hesaplayıp diske yazar)
    const xi = xgInfo(slug);
    let xgN = 0;
    if (xi && xi.map) for (const m of uniq) { const x = m.c === slug ? xi.map[m.id] : null; if (x) { m.xh = x[0]; m.xa = x[1]; xgN++; } }
    const v = { matches: uniq, own, pooled: !!L.poolOf(slug), poolSize: used, xgVer: xi ? xi.at : 0, xgN, et: etc, skipped };
    trainCache.set(slug, { at: Date.now(), v });
    return v;
  });
}

// ---------- kendini ayarlama (yarım ömür / önsel) ----------
const tuneMem = new Map();
const tuning = new Map();
const tuneFail = new Map();
function ensureTune(slug) {
  if (tuning.has(slug)) return tuning.get(slug);
  if (Date.now() - (tuneFail.get(slug) || 0) < 10 * 60000) return Promise.resolve(null);
  const p = (async () => {
    const tr = await training(slug);
    const r = await M.tune(tr.matches, Date.now(), slug);
    r.ts = Date.now();
    r.xgVer = tr.xgVer || 0;
    tuneMem.set(slug, r);
    U.diskSet('tn', slug, r);
    return r;
  })()
    .catch((e) => { tuneFail.set(slug, Date.now()); U.log('ayar hatası', slug, e.message); return null; })
    .finally(() => tuning.delete(slug));
  tuning.set(slug, p);
  return p;
}
function tuneInfo(slug) {
  let t = tuneMem.get(slug);
  if (!t) {
    const c = U.diskGet('tn', slug, 24 * HOUR);
    if (c.hit && c.d) { t = c.d; tuneMem.set(slug, t); }
  }
  const xi = xgInfo(slug);
  if (!t || Date.now() - (t.ts || 0) > 24 * HOUR || (t.xgVer || 0) !== (xi ? xi.at : 0)) ensureTune(slug);
  return t || null;
}

const fitCache = new Map();
async function modelFor(slug, cutoff) {
  const tr = await training(slug);
  const tp = tuneInfo(slug);
  const params = paramsOf(tp);
  const k = `${slug}:${Math.floor(cutoff / (6 * HOUR))}:${params.halfLife}:${params.prior}:${params.xgW}:${params.thK}`;
  let f = fitCache.get(k);
  if (!f || f.tr !== tr) {
    if (fitCache.size > 200) fitCache.clear();
    f = { tr, mdl: M.fit(tr.matches, cutoff, { halfLife: params.halfLife, prior: params.prior, xgW: params.xgW, thK: params.thK }) };
    fitCache.set(k, f);
  }
  return { mdl: f.mdl, tr, params, tp };
}

async function predict(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  analysisIfReady(slug, true); // ilk yarı payı, şut verisi ve dinlenme etkisi için lig analizi arka planda hazırlanır
  const out = await predictFromRec(slug, rec);
  if (rec.market) {
    const an = analysisIfReady(slug, false);
    const bl = an && an.blend;
    const pm = [out.markets.home, out.markets.draw, out.markets.away], pk = [rec.market.home, rec.market.draw, rec.market.away];
    out.blend = {
      ready: !!an, enough: !!(bl && bl.enough), adopted: !!(bl && bl.adopted), w: bl && bl.adopted ? bl.applied : null,
      probs: bl && bl.adopted ? BT.mix(pm, pk, bl.applied) : null,
      stats: bl && bl.enough ? { n: bl.n, nTest: bl.nTest, brierTest: bl.brierTest, zVsModel: bl.zVsModel, wAll: bl.wAll, zMarketVsModel: bl.zMarketVsModel } : null,
    };
  }
  return out;
}

async function predictFromRec(slug, rec, adj) {
  const done = rec.status.state === 'post';
  const cutoff = done ? Date.parse(rec.date) : Date.now();
  const { mdl, tr, params, tp } = await modelFor(slug, cutoff);
  if (!mdl.ok) throw Object.assign(new Error('Bu turnuva için yeterli geçmiş maç verisi yok'), { status: 422 });
  const hid = rec.home.id, aid = rec.away.id;
  if (mdl.games(hid) < 1 || mdl.games(aid) < 1) throw Object.assign(new Error('Takımlardan biri için geçmiş maç verisi bulunamadı'), { status: 422 });
  const neutral = L.NEUTRAL.has(slug) || rec.neutral;
  const r = M.matchup(mdl, hid, aid, { neutral, comp: slug, lhMul: adj ? adj.home : 1, laMul: adj ? adj.away : 1 });
  const side = (tid) => ({ att: mdl.att(tid), def: mdl.def(tid), rank: mdl.rank(tid) || mdl.teams, form: mdl.form(tid), games: mdl.games(tid) });
  const an = analysisIfReady(slug, false);
  const half = an && an.half && an.half.enough ? an.half : null;
  const share = half ? half.applied : HV.HALF1;
  return {
    markets: r.markets,
    extra: M.extraMarkets(r.lambdaHome, r.lambdaAway, r.grid, share),
    lambdaHome: r.lambdaHome,
    lambdaAway: r.lambdaAway,
    matrix: r.matrix,
    actual: done && rec.home.score != null ? { home: rec.home.score, away: rec.away.score } : null,
    market: rec.market || null,
    teams: { home: side(hid), away: side(aid) },
    league_: {
      pooled: tr.pooled,
      teams: mdl.teams,
      ownMatches: tr.own,
      matches: mdl.n,
      poolSize: tr.poolSize,
      avgGoals: mdl.avgGoals,
      neutral,
      homeAdv: mdl.ha,
      halfLife: params.halfLife,
      prior: params.prior,
      tuned: !!(tp && tp.tuned),
      xgW: params.xgW || 0,
      thK: params.thK || 0,
      halfShare: { value: share, measured: !!half, raw: half ? half.raw : null, goals: half ? half.goals : 0 },
    },
  };
}


// ---------- kupa / eleme: tur atlama ----------
const ymOf = (ms) => U.ym(new Date(ms));
async function boardAround(slug, t0, spanDays) {
  const months = new Set();
  for (let d = -spanDays; d <= spanDays; d += 10) months.add(ymOf(t0 + d * DAY));
  const cur = U.ym(new Date()), prev = U.ym(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)));
  const out = new Map();
  await Promise.all([...months].map(async (mo) => {
    try { for (const e of await E.scoreboardMonth(slug, mo, { ttl: mo === cur || mo === prev ? 10 * 60000 : 24 * HOUR })) out.set(e.id, e); } catch (e) { /* eksik ay: eldekiyle devam */ }
  }));
  return [...out.values()];
}
async function tieInfo(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const t0 = Date.parse(rec.date);
  // önce sadece bu ayın (ve komşu ayın) tahtasına bak: tur bilgisi yoksa hemen çık
  let board = await boardAround(slug, t0, 0);
  let ev = board.find((e) => e.id === String(id));
  if (!ev) { board = await boardAround(slug, t0, 20); ev = board.find((e) => e.id === String(id)); }
  if (!ev) return { kind: 'none', reason: 'event' };
  const twoLeg = ev.leg != null || (ev.series && ev.series.total === 2);
  const single = !twoLeg && ((ev.series && ev.series.total === 1) || TIE.isKnockoutRound(ev.round));
  if (!twoLeg && !single) return { kind: 'none' };
  const X = ev.home.id, Y = ev.away.id;
  let partner = null;
  if (twoLeg) {
    board = await boardAround(slug, t0, 80);
    const cand = board.filter((e) => e.id !== ev.id && ((e.home.id === X && e.away.id === Y) || (e.home.id === Y && e.away.id === X)) && Math.abs(Date.parse(e.date) - t0) <= 80 * DAY && (e.leg != null || (e.series && e.series.total === 2)) && (e.leg == null || ev.leg == null || e.leg !== ev.leg) && (!e.round || !ev.round || e.round === ev.round));
    cand.sort((a, b) => Math.abs(Date.parse(a.date) - t0) - Math.abs(Date.parse(b.date) - t0));
    partner = cand[0] || null;
  }
  const { mdl, tr } = await modelFor(slug, Math.min(Date.now(), t0));
  const neutralOf = (e) => L.NEUTRAL.has(slug) || !!(e && e.neutral);
  const side = (e) => (e.home.id === X ? 'x' : 'y');
  const evLegs = [];
  if (twoLeg) {
    let first, second;
    if (partner) [first, second] = Date.parse(partner.date) < t0 ? [partner, ev] : [ev, partner];
    else if (ev.leg === 2) { first = null; second = ev; } else { first = ev; second = null; }
    // takvimde olmayan maçı ters saha varsay (ev sahibi X'in rakibi olur)
    // 2. maçtayız ve 1. maç takvimde yoksa: ESPN'in toplam skorundan (aggregateScore) 1. maç sonucunu çıkar
    let lost = { missing: true, host: 'y' };
    if (!first && ev.leg === 2 && ev.series && Number.isFinite(ev.series.agg[X]) && Number.isFinite(ev.series.agg[Y])) {
      const own = ev.status.state === 'pre' ? [0, 0] : [ev.home.score || 0, ev.away.score || 0];
      const gx = ev.series.agg[X] - own[0], gy = ev.series.agg[Y] - own[1];
      if (gx >= 0 && gy >= 0) lost = { missing: true, host: 'y', known: { gx, gy } };
    }
    evLegs.push(first || lost, second || { missing: true, host: 'y' });
  } else evLegs.push(ev);
  const known = mdl.ok && mdl.games(X) >= 1 && mdl.games(Y) >= 1;
  const legs = [];
  const view = [];
  for (const e of evLegs) {
    const missing = !!e.missing;
    const host = missing ? e.host : side(e);
    const state = missing ? (e.known ? 'post' : 'pre') : e.status.state;
    const g = { host, state };
    if (missing && e.known) { g.gx = e.known.gx; g.gy = e.known.gy; }
    if (!missing && state !== 'pre') {
      const hs = e.home.score || 0, as = e.away.score || 0;
      g.gx = host === 'x' ? hs : as; g.gy = host === 'x' ? as : hs;
    }
    if (state !== 'post') {
      if (!known) return { kind: twoLeg ? 'two-leg' : 'single', error: 'Takımlardan biri için geçmiş maç verisi yok' };
      const hostId = host === 'x' ? X : Y, guestId = host === 'x' ? Y : X;
      const r = M.matchup(mdl, hostId, guestId, { neutral: neutralOf(missing ? ev : e), comp: slug });
      g.lx = host === 'x' ? r.lambdaHome : r.lambdaAway;
      g.ly = host === 'x' ? r.lambdaAway : r.lambdaHome;
      if (state === 'pre') g.grid = r.grid;
      if (state === 'in') g.remain = 1 - M.shareDone(parseMinute(e.status));
    }
    legs.push(g);
    view.push({ id: missing ? null : e.id, host, state, date: missing ? null : e.date, score: g.gx != null ? { x: g.gx, y: g.gy } : null, assumed: missing && !e.known, fromAgg: missing && !!e.known });
  }
  const cal = TIE.calibrateEt(tr.et, mdl.ok ? mdl.avgGoals : 2.6);
  const res = TIE.compute(legs, cal.f);
  return {
    kind: twoLeg ? 'two-leg' : 'single',
    round: ev.round || null,
    title: (ev.series && ev.series.title) || null,
    legNo: ev.leg || null,
    teams: { x: { id: X, name: ev.home.name, short: ev.home.short, logo: ev.home.logo }, y: { id: Y, name: ev.away.name, short: ev.away.short, logo: ev.away.logo } },
    legs: view,
    ...res,
    assumptions: { penalty: 0.5, awayGoals: false, et: cal, partnerFound: twoLeg ? !!partner : null, adjusted: false },
  };
}

// ---------- canlı tahmin ----------
function parseMinute(st) {
  const name = String(st.name || '');
  const m = String(st.clock || '').match(/(\d+)/);
  const base = m ? Number(m[1]) : 0;
  if (/HALFTIME/.test(name)) return 45;
  if (/FIRST_HALF/.test(name)) return Math.min(45, base);
  if (/SECOND_HALF/.test(name)) return Math.min(95, Math.max(45, base));
  return Math.min(95, base);
}

async function liveData(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const st = rec.status;
  if (st.state !== 'in') return { state: st.state, live: null };
  const { mdl } = await modelFor(slug, Date.now());
  if (!mdl.ok || mdl.games(rec.home.id) < 1 || mdl.games(rec.away.id) < 1) return { state: 'in', live: null };
  const r = M.matchup(mdl, rec.home.id, rec.away.id, { neutral: L.NEUTRAL.has(slug) || rec.neutral, comp: slug });
  const minute = parseMinute(st);
  const an = analysisIfReady(slug, false);
  const share = an && an.half && an.half.enough ? an.half.applied : HV.HALF1;
  const live = M.liveMarkets(r.lambdaHome, r.lambdaAway, minute, rec.home.score || 0, rec.away.score || 0, share);
  // kırmızı kart: sahada oyuncu sayısı eşit değilse, ölçülmüşse etkisi kalan gol beklentisine uygulanır
  let red = null, shown = live;
  try {
    const reds = RC.redsOfRec(rec);
    if (reds.length) {
      const net = RC.netOf(reds), rp = rcParams(slug);
      const f = RC.factors(rp.k, net);
      const applied = !!(rp.k && net !== 0 && (net > 0 ? (rp.k.up != null || rp.k.down != null) : (rp.k.down != null || rp.k.up != null)));
      let reason;
      if (net === 0) reason = 'Kırmızı kartlar dengelendi (iki takım da aynı sayıda oyuncuyla), etki uygulanmadı.';
      else if (applied) reason = 'Etki ' + (Object.values(rp.src).includes('league') ? 'bu ligin maçlarında' : 'ligler arası birleşik ölçümde') + ' anlamlı bulundu; kalan gol beklentisine uygulandı.';
      else if (!rp.ready) reason = 'Bu lig için kırmızı kart etkisi henüz ölçülmedi (arka planda hesaplanıyor), olasılıklar kırmızı kartı hesaba katmıyor.';
      else reason = 'Kırmızı kartın gol beklentisine etkisi bu ligde (ve birleşik ölçümde) henüz anlamlı çıkmadı, olasılıklar kırmızı kartı hesaba katmıyor. Gerçekte 10 kişi kalan takımın şansı genelde düşer, temkinli yorumla.';
      if (applied) shown = M.liveMarkets(r.lambdaHome * f.home, r.lambdaAway * f.away, minute, rec.home.score || 0, rec.away.score || 0, share);
      red = { reds, net, applied, factors: f, params: rp.k, source: rp.src, reason, base: applied ? { home: live.markets.home, draw: live.markets.draw, away: live.markets.away } : null };
    }
  } catch (e) { U.log('kırmızı kart bilgisi hatası', slug, e.message); }
  // skor durumu ve dakika etkisi: ölçülüp anlamlı bulunduysa kalan dakikalar dakika dakika hesaplanır (eski hesap karşılaştırma için tutulur)
  let gstate = null;
  try {
    const gp = gsParams(slug);
    const fr = red && red.applied ? red.factors : { home: 1, away: 1 };
    const hg = rec.home.score || 0, ag = rec.away.score || 0;
    let reason;
    if (gp.k) {
      const dyn = GS.liveDP(r.lambdaHome * fr.home, r.lambdaAway * fr.away, minute, hg, ag, gp.k, share);
      gstate = { applied: true, k: gp.k, source: gp.src, reason: 'Önde/geride olan takımın ve maç dakikasının gol hızına etkisi ' + (Object.values(gp.src).includes('league') ? 'bu ligin maçlarında' : 'ligler arası birleşik ölçümde') + ' anlamlı bulundu; kalan dakikalar skor durumuna göre dakika dakika hesaplandı.', base: { home: shown.markets.home, draw: shown.markets.draw, away: shown.markets.away } };
      shown = dyn;
    } else if (!gp.ready) reason = 'Bu lig için skor durumu etkisi henüz ölçülmedi (arka planda hesaplanıyor); olasılıklar sabit gol hızıyla hesaplanıyor.';
    else reason = 'Önde/geride olan takımın ve dakikanın gol hızına etkisi ölçüldü ama anlamlı çıkmadı; olasılıklar sabit gol hızıyla hesaplanıyor.';
    if (!gstate) gstate = { applied: false, reason };
  } catch (e) { U.log('skor durumu canlı hesabı hatası', slug, e.message); }
  return { state: 'in', clock: st.clock, live: shown, red, gstate, pre: { home: r.markets.home, draw: r.markets.draw, away: r.markets.away } };
}

// ---------- iki takımı karşılaştır (aynı lig) ----------
async function matchupTeams(slug, a, b) {
  const { mdl } = await modelFor(slug, Date.now());
  if (!mdl.ok) throw Object.assign(new Error('Bu lig için yeterli geçmiş maç verisi yok'), { status: 422 });
  if (a === b) throw Object.assign(new Error('İki farklı takım seç'), { status: 400 });
  if (mdl.games(a) < 1 || mdl.games(b) < 1) throw Object.assign(new Error('Takımlardan biri için geçmiş maç verisi bulunamadı'), { status: 422 });
  const neutral = L.NEUTRAL.has(slug);
  const pack = (r) => ({ markets: r.markets, lambdaHome: r.lambdaHome, lambdaAway: r.lambdaAway, matrix: r.matrix });
  const side = (tid) => ({ att: mdl.att(tid), def: mdl.def(tid), rank: mdl.rank(tid) || mdl.teams, form: mdl.form(tid), games: mdl.games(tid) });
  return {
    ab: pack(M.matchup(mdl, a, b, { neutral, comp: slug })),
    ba: pack(M.matchup(mdl, b, a, { neutral, comp: slug })),
    teams: { a: side(a), b: side(b) },
    league_: { teams: mdl.teams, matches: mdl.n, avgGoals: mdl.avgGoals, neutral },
  };
}

// ---------- oyuncu olasılıkları (deneysel) ----------
const PRIOR = {
  F: { g: 0.28, s: 1.8, t: 0.7, c: 0.12 },
  M: { g: 0.09, s: 1.0, t: 0.35, c: 0.17 },
  D: { g: 0.03, s: 0.5, t: 0.15, c: 0.17 },
  G: { g: 0, s: 0, t: 0, c: 0.04 },
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function propsSide(td, lam, ro, lineup) {
  if (!td) return [];
  const mc = Math.max(1, td.matchCount || 1);
  const gf = td.matches.length ? td.matches.reduce((a, m) => a + (m.gf || 0), 0) / td.matches.length : 1.3;
  const scale = clamp(lam / Math.max(0.4, gf), 0.6, 1.6);
  const K = 8;
  const rinfo = new Map();
  if (ro) for (const p of ro.players) rinfo.set(p.id, p);
  const rows = [];
  for (const p of td.players) {
    const g = posGroup(p.pos);
    const pr = PRIOR[g];
    let pPlay;
    if (lineup) {
      const ri = rinfo.get(p.id);
      if (!ri) continue;
      pPlay = ri.starter ? 0.96 : 0.3;
    } else {
      if (p.apps < 2) continue;
      pPlay = clamp(p.starts / mc + (0.35 * (p.apps - p.starts)) / mc, 0.03, 0.97);
    }
    const n = p.apps;
    rows.push({
      p, g, pPlay,
      rg: (p.goals + K * pr.g) / (n + K),
      rs: (p.shots + K * pr.s) / (n + K),
      rt: (p.sot + K * pr.t) / (n + K),
      rc: (p.yc + K * pr.c) / (n + K),
    });
  }
  const wsum = rows.reduce((a, r) => a + r.rg * r.pPlay, 0);
  return rows
    .map((r) => {
      const lg = wsum > 0 ? (lam * r.rg * r.pPlay) / wsum : 0;
      const ls = r.rs * r.pPlay * scale, lt = r.rt * r.pPlay * scale, lc = r.rc * r.pPlay;
      return {
        id: r.p.id, name: r.p.name, jersey: r.p.jersey, pos: POS_TR[r.g], posAbbr: r.g,
        pPlay: r.pPlay,
        pGoal: 1 - Math.exp(-lg), pShot: 1 - Math.exp(-ls), pSot: 1 - Math.exp(-lt), pCard: 1 - Math.exp(-lc),
        eShots: ls, apps: r.p.apps, goals: r.p.goals,
      };
    })
    .filter((x) => x.posAbbr !== 'G')
    .sort((a, b) => b.pGoal - a.pGoal)
    .slice(0, 14);
}

async function propsFor(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const pred = await predictFromRec(slug, rec);
  const [th, ta] = await Promise.all([teamData(slug, rec.home.id).catch(() => null), teamData(slug, rec.away.id).catch(() => null)]);
  const lineup = rec.rosters.some((r) => r.players.some((p) => p.starter));
  const ro = (tid) => rec.rosters.find((r) => r.teamId === tid);
  return {
    state: rec.status.state,
    lineupKnown: lineup,
    lambdas: { home: pred.lambdaHome, away: pred.lambdaAway },
    home: { teamId: rec.home.id, name: rec.home.name, players: propsSide(th, pred.lambdaHome, ro(rec.home.id), lineup) },
    away: { teamId: rec.away.id, name: rec.away.name, players: propsSide(ta, pred.lambdaAway, ro(rec.away.id), lineup) },
  };
}

// ---------- tahmin defteri: biten maçların sonuçları (toplu) ----------
// list: [[lig, maç kimliği], ...] (en çok 80). Dönüş: her maç için {k, state, completed, et, hg, ag}; et: uzatma/penaltıyla bitti (90 dakikalık skor değil)
async function resultsFor(list) {
  const out = [];
  await eachLimit(list.slice(0, 80), 6, async ([slug, id]) => {
    const k = `${slug}:${id}`;
    try {
      const rec = await matchRecord(slug, id, { bg: true });
      if (!rec) { out.push({ k, state: 'none' }); return; }
      const st = rec.status;
      out.push({ k, state: st.state, completed: !!st.completed, et: /AET|PEN|EXTRA/i.test(st.name || ''), hg: rec.home.score == null ? null : rec.home.score, ag: rec.away.score == null ? null : rec.away.score, date: rec.date });
    } catch (e) { out.push({ k, state: 'error' }); }
  });
  return out;
}

// ---------- günün tablosu ----------
const todayJobs = new Map();
async function runToday(j, date, tz, league, refresh) {
  try {
    const { events } = await matchesFor(date, league, tz);
    const prog = refresh ? { total: 0, done: 0 } : j;
    prog.total = events.length; prog.done = 0;
    const byLeague = new Map();
    events.forEach((ev, i) => { if (!byLeague.has(ev.league)) byLeague.set(ev.league, []); byLeague.get(ev.league).push([ev, i]); });
    const rows = new Array(events.length);
    await eachLimit([...byLeague.entries()], 3, async ([slug, list]) => {
      for (const [ev, i] of list) {
        const row = { id: ev.id, league: ev.league, date: ev.date, status: ev.status, home: ev.home, away: ev.away };
        try {
          const rec = await matchRecord(slug, ev.id, { bg: true });
          if (rec) {
            const p = await predictFromRec(slug, rec);
            const mk = p.markets;
            row.p = { h: mk.home, d: mk.draw, a: mk.away };
            row.over25 = mk.over['2.5'];
            row.btts = mk.btts;
            row.xg = { h: p.lambdaHome, a: p.lambdaAway };
            row.top = mk.topScores && mk.topScores[0] ? mk.topScores[0].s : null;
            const pick = mk.home >= mk.draw && mk.home >= mk.away ? 'h' : mk.away >= mk.draw ? 'a' : 'd';
            row.pick = pick === 'h' ? '1' : pick === 'd' ? 'X' : '2';
            if (p.market) {
              row.market = { h: p.market.home, d: p.market.draw, a: p.market.away, provider: p.market.provider, total: p.market.total, overProb: p.market.overProb };
              row.edge = { h: row.p.h - p.market.home, d: row.p.d - p.market.draw, a: row.p.a - p.market.away };
              row.pickEdge = row.edge[pick];
            }
          }
        } catch (e) {
          row.error = e.message;
        }
        rows[i] = row;
        prog.done++;
      }
    });
    j.rows = rows.filter(Boolean);
    j.status = 'ready';
    j.at = Date.now();
    j.refreshing = false;
  } catch (e) {
    U.log('günün tablosu hata', e.message);
    if (refresh) j.refreshing = false;
    else j.status = 'error';
  }
}

function todayTable(date, tz, league) {
  const key = `${date}:${tz}:${league}`;
  let j = todayJobs.get(key);
  if (todayJobs.size > 60) todayJobs.clear();
  if (!j || j.status === 'error') {
    j = { status: 'building', done: 0, total: 0, rows: [] };
    todayJobs.set(key, j);
    runToday(j, date, tz, league, false);
  } else if (j.status === 'ready' && !j.refreshing && Date.now() - j.at > 5 * 60000) {
    j.refreshing = true;
    runToday(j, date, tz, league, true);
  }
  if (j.status === 'ready') return { status: 'ready', rows: j.rows, at: j.at };
  return { status: j.status, done: j.done, total: j.total, rows: [] };
}

// ---------- günün korner / kart tablosu ----------
const SP_LINES = { corners: [7.5, 8.5, 9.5, 10.5, 11.5], cards: [2.5, 3.5, 4.5, 5.5] };
const spTeamCache = new Map();
// takımın son maçları (en yenisi başta): [{ha, sp:{c,ca,y,ya}}]
function teamSpList(slug, tid) {
  const k = `${slug}:${tid}`;
  const hit = spTeamCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.p;
  if (spTeamCache.size > 3000) spTeamCache.clear();
  const p = (async () => {
    const sch = await teamSchedule(slug, tid, { bg: true });
    if (!sch) return [];
    const fin = sch.finished.slice(0, 15);
    const recs = await Promise.all(fin.map((e) => matchRecord(slug, e.id, { bg: true }).catch(() => null)));
    const out = [];
    fin.forEach((e, i) => {
      const rec = recs[i];
      const ts = rec && rec.teamStats;
      const home = e.home.id === tid;
      const opp = home ? e.away.id : e.home.id;
      if (!ts || !ts[tid] || !ts[opp]) return;
      const c = n0(ts[tid].wonCorners), ca = n0(ts[opp].wonCorners), y = n0(ts[tid].yellowCards), ya = n0(ts[opp].yellowCards);
      if (c == null || ca == null || y == null || ya == null) return;
      out.push({ ha: home ? 'home' : 'away', sp: { c, ca, y, ya } });
    });
    return out;
  })();
  p.catch(() => spTeamCache.delete(k));
  spTeamCache.set(k, { at: Date.now(), p });
  return p;
}

const spJobs = new Map();
async function runSpToday(j, date, tz, league, refresh) {
  try {
    const { events } = await matchesFor(date, league, tz);
    const prog = refresh ? { total: 0, done: 0 } : j;
    prog.total = events.length; prog.done = 0;
    const rows = refresh ? [] : j.rows; // ilk hesapta satırlar geldikçe görünür
    rows.length = 0;
    const byLeague = new Map();
    events.forEach((ev) => { if (!byLeague.has(ev.league)) byLeague.set(ev.league, []); byLeague.get(ev.league).push(ev); });
    await eachLimit([...byLeague.entries()], 3, async ([slug, list]) => {
      for (const ev of list) {
        const row = { id: ev.id, league: ev.league, date: ev.date, status: ev.status, home: ev.home, away: ev.away };
        try {
          const [hl, al] = await Promise.all([teamSpList(slug, ev.home.id), teamSpList(slug, ev.away.id)]);
          const ex = SP.expected(hl, al);
          row.n = { home: hl.length, away: al.length };
          if (ex) {
            const lines = (pmf, ls) => Object.fromEntries(ls.map((l) => [l, SP.pOver(pmf, l)]));
            row.corners = { t: ex.corners.t, home: ex.corners.home, away: ex.corners.away, p: lines(ex.corners.total, SP_LINES.corners) };
            row.cards = { t: ex.cards.t, home: ex.cards.home, away: ex.cards.away, p: lines(ex.cards.total, SP_LINES.cards) };
          }
          if (ev.status.state === 'post') {
            const rec = await matchRecord(slug, ev.id, { bg: true });
            const ts = rec && rec.teamStats;
            if (ts && ts[ev.home.id] && ts[ev.away.id]) {
              const c = n0(ts[ev.home.id].wonCorners), ca = n0(ts[ev.away.id].wonCorners), y = n0(ts[ev.home.id].yellowCards), ya = n0(ts[ev.away.id].yellowCards);
              if (c != null && ca != null) row.actualC = c + ca;
              if (y != null && ya != null) row.actualY = y + ya;
            }
          }
        } catch (e) { row.error = e.message; }
        rows.push(row);
        prog.done++;
      }
    });
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    j.rows = rows;
    j.status = 'ready';
    j.at = Date.now();
    j.refreshing = false;
  } catch (e) {
    U.log('korner/kart tablosu hata', e.message);
    if (refresh) j.refreshing = false;
    else j.status = 'error';
  }
}
function spToday(date, tz, league) {
  const key = `${date}:${tz}:${league}`;
  let j = spJobs.get(key);
  if (spJobs.size > 30) spJobs.clear();
  if (!j || j.status === 'error') {
    j = { status: 'building', done: 0, total: 0, rows: [] };
    spJobs.set(key, j);
    runSpToday(j, date, tz, league, false);
  } else if (j.status === 'ready' && !j.refreshing && Date.now() - j.at > 15 * 60000) {
    j.refreshing = true;
    runSpToday(j, date, tz, league, true);
  }
  return { status: j.status, done: j.done, total: j.total, rows: j.rows.slice(), lines: SP_LINES, at: j.at || null };
}

// ---------- karne ----------
const btCache = new Map();
async function backtestLeague(slug) {
  const hit = btCache.get(slug);
  if (hit && Date.now() - hit.at < 6 * HOUR) return { ...hit.v, tuning: tuneInfo(slug) || hit.v.tuning }; // ayar bilgisi (şut karışımı vb.) güncel kalsın
  return U.once('bt:' + slug, async () => {
    const tr = await training(slug);
    const tp = tuneInfo(slug) || (await ensureTune(slug));
    const params = paramsOf(tp);
    const r = await M.backtest(tr.matches, { now: Date.now(), ownComp: slug, params });
    const v = { league: slug, pooled: tr.pooled, tuning: tp || null, ...r };
    btCache.set(slug, { at: Date.now(), v });
    return v;
  });
}

const btSummary = { status: 'idle', done: 0, total: 0, rows: [], at: 0 };
function backtestSummary() {
  const stale = Date.now() - btSummary.at > 6 * HOUR;
  if (btSummary.status !== 'building' && (btSummary.status === 'idle' || stale)) {
    btSummary.status = 'building';
    btSummary.done = 0;
    btSummary.total = L.AVAILABLE.filter((x) => !L.BY[x].domestic).length;
    const rows = [];
    (async () => {
      for (const slug of L.AVAILABLE.filter((x) => !L.BY[x].domestic)) {
        try {
          const r = await backtestLeague(slug);
          if (r.n >= 10) rows.push({ league: slug, n: r.n, accuracy: r.accuracy, baseHome: r.baseHome, over25: r.over25, btts: r.btts, exact: r.exact });
        } catch (e) { /* lig atlanır */ }
        btSummary.done++;
        btSummary.rows = rows.slice();
      }
      btSummary.rows = rows;
      btSummary.status = 'ready';
      btSummary.at = Date.now();
    })().catch(() => { btSummary.status = 'idle'; });
  }
  return { status: btSummary.status, done: btSummary.done, total: btSummary.total, rows: btSummary.rows };
}

// ---------- puan durumu ----------
async function standings(slug) {
  const j = await E.standingsRaw(slug);
  return E.parseStandings(j);
}

// ---------- takım ----------
const seasonOf = (s) => {
  if (!s) return '';
  const dn = String(s.displayName || '');
  const m = dn.match(/^\d{4}(?:-\d{2,4})?/);
  return m ? m[0] : String(s.year || '');
};

async function teamSchedule(slug, teamId, { bg = false } = {}) {
  const j = await E.scheduleRaw(slug, teamId, null, { bg });
  if (!j) return null;
  let events = (j.events || []).map((e) => E.normEvent(e, slug)).filter(Boolean).filter((e) => e.league === slug);
  const team = j.team || {};
  let finished = events.filter((e) => e.status.state === 'post' && e.status.completed);
  const year = j.season && j.season.year;
  if (finished.length < 5 && year) {
    try {
      const pj = await E.scheduleRaw(slug, teamId, year - 1, { bg });
      const pe = ((pj && pj.events) || []).map((e) => E.normEvent(e, slug)).filter(Boolean).filter((e) => e.league === slug && e.status.state === 'post' && e.status.completed);
      const have = new Set(finished.map((e) => e.id));
      finished = finished.concat(pe.filter((e) => !have.has(e.id)));
    } catch (e) { /* önceki sezon yoksa sorun değil */ }
  }
  finished.sort((a, b) => (a.date < b.date ? 1 : -1));
  const upcoming = events.filter((e) => e.status.state === 'pre').sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    team: { id: String(team.id || teamId), name: team.displayName || team.name || '', logo: E.logoOf(team) },
    season: seasonOf(j.season),
    finished,
    upcoming,
  };
}

const n0 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function goalBin(clock, min) {
  let base = null;
  const m = String(clock || '').match(/(\d+)'/);
  if (m) base = Number(m[1]);
  else if (min != null) base = min;
  if (base == null) return null;
  return base <= 15 ? 0 : base <= 30 ? 1 : base <= 45 ? 2 : base <= 60 ? 3 : base <= 75 ? 4 : 5;
}

const teamCache = new Map();
async function teamData(slug, teamId) {
  const ck = `${slug}:${teamId}`;
  const hit = teamCache.get(ck);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.v;
  return U.once('team:' + ck, async () => {
    const sch = await teamSchedule(slug, teamId);
    if (!sch) return null;
    const cap = L.BY[slug] && L.BY[slug].kind === 'league' ? 40 : 24;
    const fin = sch.finished.slice(0, cap);
    const recs = await Promise.all(fin.map((e) => matchRecord(slug, e.id).catch(() => null)));
    const matches = [];
    const sumFor = {}, sumAg = {}, cnt = {};
    const goalFor = [0, 0, 0, 0, 0, 0], goalAg = [0, 0, 0, 0, 0, 0];
    let goalMatches = 0;
    const pl = new Map();
    let statMatches = 0;
    fin.forEach((e, i) => {
      const rec = recs[i];
      const home = e.home.id === teamId;
      const me = home ? e.home : e.away, opp = home ? e.away : e.home;
      const ts = rec && rec.teamStats && rec.teamStats[teamId];
      const os = rec && rec.teamStats && rec.teamStats[opp.id];
      let sp;
      if (ts && os) {
        const c = n0(ts.wonCorners), ca = n0(os.wonCorners), y = n0(ts.yellowCards), ya = n0(os.yellowCards);
        if (c != null && ca != null && y != null && ya != null) {
          sp = { c, ca, y, ya, r: n0(ts.redCards), ra: n0(os.redCards), f: n0(ts.foulsCommitted), fa: n0(os.foulsCommitted) };
        }
        statMatches++;
        for (const k of Object.keys(ts)) {
          const a = n0(ts[k]), b = n0(os[k]);
          if (a == null || b == null) continue;
          sumFor[k] = (sumFor[k] || 0) + a;
          sumAg[k] = (sumAg[k] || 0) + b;
          cnt[k] = (cnt[k] || 0) + 1;
        }
      }
      matches.push({ id: e.id, date: e.date, opponent: opp.name, opponentShort: opp.short, opponentLogo: opp.logo, homeAway: home ? 'home' : 'away', gf: me.score, ga: opp.score, league: slug, sp });
      if (rec) {
        const evs = rec.keyEvents.filter((k) => k.scoring);
        if (evs.length || (me.score || 0) + (opp.score || 0) === 0) goalMatches++;
        for (const k of evs) {
          const b = goalBin(k.clock, k.min);
          if (b == null) continue;
          if (k.teamId === teamId) goalFor[b]++; else goalAg[b]++;
        }
        const ro = rec.rosters.find((r) => r.teamId === teamId);
        if (ro) {
          for (const p of ro.players) {
            const played = p.starter || p.subbedIn || (p.stats.appearances || 0) > 0;
            if (!played) continue;
            let o = pl.get(p.id);
            if (!o) { o = { id: p.id, name: p.name, jersey: p.jersey, pos: p.pos, apps: 0, starts: 0, goals: 0, assists: 0, shots: 0, sot: 0, fouls: 0, fouled: 0, yc: 0, rc: 0, saves: 0 }; pl.set(p.id, o); }
            o.apps++; if (p.starter) o.starts++;
            o.goals += p.stats.totalGoals || 0; o.assists += p.stats.goalAssists || 0;
            o.shots += p.stats.totalShots || 0; o.sot += p.stats.shotsOnTarget || 0;
            o.fouls += p.stats.foulsCommitted || 0; o.fouled += p.stats.foulsSuffered || 0;
            o.yc += p.stats.yellowCards || 0; o.rc += p.stats.redCards || 0; o.saves += p.stats.saves || 0;
            if (p.jersey) o.jersey = p.jersey;
            if (p.pos) o.pos = p.pos;
          }
        }
      }
    });
    const avgFor = {}, avgAgainst = {};
    for (const k of Object.keys(cnt)) { avgFor[k] = sumFor[k] / cnt[k]; avgAgainst[k] = sumAg[k] / cnt[k]; }

    // sakat/cezalı: sıradaki maçın özetinden
    let injuries = [];
    if (sch.upcoming[0]) {
      try {
        const nr = await matchRecord(slug, sch.upcoming[0].id);
        injuries = ((nr && nr.injuries) || []).filter((x) => x.teamId === teamId).map(({ name, pos, status, detail }) => ({ name, pos, status, detail }));
      } catch (e) { /* */ }
    }
    const v = {
      team: sch.team.name,
      logo: sch.team.logo,
      season: sch.season,
      matchCount: matches.length,
      statMatches,
      avgFor, avgAgainst,
      matches,
      goalMinutes: goalMatches ? { for: goalFor, against: goalAg } : null,
      players: [...pl.values()],
      injuries,
      upcoming: sch.upcoming.slice(0, 8).map((e) => {
        const home = e.home.id === teamId;
        const opp = home ? e.away : e.home;
        return { id: e.id, date: e.date, league: slug, opponent: opp.name, opponentLogo: opp.logo, homeAway: home ? 'home' : 'away' };
      }),
    };
    teamCache.set(ck, { at: Date.now(), v });
    return v;
  });
}

// ---------- oyuncu ----------
function mapDetailFull(flat) {
  const o = E.mapDetail(flat);
  if (!o) return null;
  if (flat.starts != null) o.starts = flat.starts;
  return o;
}
const playedIn = (flat) => flat && ((flat.minutes || 0) > 0 || (flat.appearances || 0) > 0 || (flat.starts || 0) > 0);

async function athleteInfo(playerId, fallback) {
  let a = null;
  try { a = await E.athleteRaw(playerId); } catch (e) { /* */ }
  const g = posGroup((a && a.position && a.position.abbreviation) || (fallback && fallback.pos));
  return {
    id: String(playerId),
    name: (a && (a.displayName || a.fullName)) || (fallback && fallback.name) || '?',
    short: (a && a.shortName) || (fallback && fallback.short) || null,
    photo: a && a.headshot && a.headshot.href ? a.headshot.href : null,
    posTr: POS_TR[g],
    posAbbr: g,
    jersey: (a && a.jersey) || (fallback && fallback.jersey) || null,
    age: a && a.age != null ? a.age : null,
    nation: (a && a.citizenship) || null,
    nationFlag: a && a.flag ? a.flag.href || null : null,
  };
}

const playerCache = new Map();
async function playerData(slug, playerId, teamId) {
  const ck = `${slug}:${teamId}:${playerId}`;
  const hit = playerCache.get(ck);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.v;
  return U.once('pl:' + ck, async () => {
    const sch = await teamSchedule(slug, teamId);
    if (!sch) return null;
    const last = sch.finished.slice(0, 20);
    const details = await Promise.all(last.map((e) => E.rosterStatsRaw(slug, e.id, teamId, playerId).catch(() => null)));
    const totals = {}, tracked = {};
    const matches = [];
    let apps = 0;
    last.forEach((e, i) => {
      const home = e.home.id === teamId;
      const me = home ? e.home : e.away, opp = home ? e.away : e.home;
      const flat = details[i] ? E.flattenStats(details[i]) : null;
      const played = playedIn(flat);
      let stats = null;
      if (played) {
        apps++;
        stats = mapDetailFull(flat);
        for (const [k, v] of Object.entries(stats)) {
          if (v == null) continue;
          totals[k] = (totals[k] || 0) + v;
          tracked[k] = (tracked[k] || 0) + 1;
        }
      }
      matches.push({ id: e.id, date: e.date, opponent: opp.name, opponentShort: opp.short, opponentLogo: opp.logo, homeAway: home ? 'home' : 'away', gf: me.score, ga: opp.score, played, stats });
    });
    // oyuncu bilgisi (kadro kaydından yedek)
    let fb = null;
    for (const e of last) {
      try {
        const rec = await matchRecord(slug, e.id);
        const ro = rec && rec.rosters.find((r) => r.teamId === teamId);
        const p = ro && ro.players.find((x) => x.id === String(playerId));
        if (p) { fb = p; break; }
      } catch (er) { /* */ }
    }
    const player = await athleteInfo(playerId, fb);
    const v = {
      player,
      team: sch.team,
      season: sch.season,
      apps,
      minutes: totals.min || 0,
      matchesChecked: last.length,
      totals,
      tracked,
      matches,
    };
    playerCache.set(ck, { at: Date.now(), v });
    return v;
  });
}

// ---------- maç içi oyuncu istatistikleri ----------
async function matchPlayers(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) return null;
  const live = rec.status.state === 'in';
  const teams = {};
  await Promise.all(
    rec.rosters.map(async (ro) => {
      const out = {};
      teams[ro.teamId] = out;
      await Promise.all(
        ro.players.filter((p) => p.starter || p.subbedIn).map(async (p) => {
          try {
            const d = await E.rosterStatsRaw(slug, id, ro.teamId, p.id, { ttl: live ? 60000 : undefined });
            const m = d ? mapDetailFull(E.flattenStats(d)) : null;
            if (m) out[p.id] = m;
          } catch (e) { /* */ }
        }),
      );
    }),
  );
  return { teams };
}

// ---------- liderler ----------
const leaderJobs = new Map();
const LEADER_TTL = 6 * HOUR;

function leadersState(slug) {
  let j = leaderJobs.get(slug);
  if (!j) {
    const c = U.diskGet('ld', slug, LEADER_TTL);
    if (c.hit && c.d) { j = { status: 'ready', result: c.d, at: c.t }; leaderJobs.set(slug, j); }
  }
  if (!j || (j.status === 'ready' && Date.now() - j.at > LEADER_TTL) || j.status === 'error') {
    if (!j || j.status === 'error' || !j.refreshing) startLeaders(slug, j);
    j = leaderJobs.get(slug);
  }
  if (j.status === 'ready') return j.result;
  return { status: j.status, phase: j.phase, done: j.done, total: j.total };
}

function startLeaders(slug, old) {
  const job = old && old.status === 'ready' ? old : { status: 'building', phase: 'Takımlar', done: 0, total: 0 };
  if (old && old.status === 'ready') job.refreshing = true;
  else leaderJobs.set(slug, job);
  const prog = job.refreshing ? { phase: '', done: 0, total: 0 } : job;
  buildLeaders(slug, prog)
    .then((result) => {
      leaderJobs.set(slug, { status: 'ready', result, at: Date.now() });
      U.diskSet('ld', slug, result);
    })
    .catch((e) => {
      U.log('liderler hata', slug, e.message);
      if (job.refreshing) job.refreshing = false;
      else leaderJobs.set(slug, { status: 'error', error: e.message, at: Date.now() });
    });
}

async function eachLimit(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

async function buildLeaders(slug, prog) {
  U.log('liderler başladı', slug);
  prog.phase = 'Takımlar ve fikstür';
  const st = await standings(slug).catch(() => ({ groups: [] }));
  let teams = [];
  for (const g of st.groups) for (const r of g.rows) teams.push({ id: r.teamId, name: r.name, logo: r.logo });
  if (!teams.length) {
    const tl = await E.teamsListRaw(slug);
    const arr = (tl && tl.sports && tl.sports[0] && tl.sports[0].leagues && tl.sports[0].leagues[0] && tl.sports[0].leagues[0].teams) || [];
    teams = arr.map((x) => ({ id: String(x.team.id), name: x.team.displayName, logo: E.logoOf(x.team) }));
  }
  const teamById = new Map(teams.map((t) => [t.id, t]));
  prog.total = teams.length; prog.done = 0;
  const events = new Map();
  await eachLimit(teams, 6, async (t) => {
    try {
      const s = await teamSchedule(slug, t.id, { bg: true });
      if (s) for (const e of s.finished) events.set(e.id, e);
    } catch (e) { /* takım atlanır */ }
    prog.done++;
  });
  const evs = [...events.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!evs.length) throw new Error('Bu lig için bitmiş maç bulunamadı');

  prog.phase = 'Maç kadroları'; prog.total = evs.length; prog.done = 0;
  const recs = new Map();
  await eachLimit(evs, 8, async (e) => {
    try { const r = await matchRecord(slug, e.id, { bg: true }); if (r) recs.set(e.id, r); } catch (er) { /* */ }
    prog.done++;
  });

  prog.phase = 'Oyuncu istatistikleri'; prog.total = recs.size; prog.done = 0;
  const agg = new Map();
  let richSeen = false;
  const BASIC = { goals: 'totalGoals', assists: 'goalAssists', shots: 'totalShots', sot: 'shotsOnTarget', fouls: 'foulsCommitted', fouled: 'foulsSuffered', yc: 'yellowCards', rc: 'redCards', saves: 'saves', offsides: 'offsides', conceded: 'goalsConceded' };
  await eachLimit([...recs.values()], 3, async (rec) => {
    for (const ro of rec.rosters) {
      const team = teamById.get(ro.teamId) || (ro.teamId === rec.home.id ? rec.home : rec.away);
      const players = ro.players.filter((p) => p.starter || p.subbedIn);
      await eachLimit(players, 6, async (p) => {
        let m = null;
        try {
          const d = await E.rosterStatsRaw(slug, rec.id, ro.teamId, p.id, { bg: true });
          m = d ? mapDetailFull(E.flattenStats(d)) : null;
        } catch (er) { /* */ }
        let a = agg.get(p.id);
        if (!a) {
          a = { id: p.id, name: p.name, team: team.name, teamId: ro.teamId, teamLogo: team.logo || null, g: posGroup(p.pos), s: { apps: 0 }, cs: 0 };
          agg.set(p.id, a);
        }
        a.teamId = ro.teamId; a.team = team.name; if (team.logo) a.teamLogo = team.logo;
        if (p.pos) a.g = posGroup(p.pos);
        const s = a.s;
        s.apps++;
        if (m && (m.min != null || m.passes != null || m.shots != null)) {
          if (m.passes != null || m.tackles != null) richSeen = true;
          for (const [k, v] of Object.entries(m)) if (v != null) s[k] = (s[k] || 0) + v;
          if (m.min == null) s.min = (s.min || 0) + (p.starter ? (p.subbedOut ? 65 : 90) : 25);
        } else {
          for (const [k, n] of Object.entries(BASIC)) { const v = p.stats[n]; if (v != null) s[k] = (s[k] || 0) + v; }
          s.min = (s.min || 0) + (p.starter ? (p.subbedOut ? 65 : 90) : 25);
          if (p.starter) s.starts = (s.starts || 0) + 1;
        }
      });
    }
    prog.done++;
  });

  const players = [...agg.values()].map((a) => {
    const { g, cs, ...rest } = a;
    return { ...rest, pos: POS_TR[g] };
  });
  const keys = new Set();
  let dribbleCandidates = 0;
  for (const p of players) {
    for (const [k, v] of Object.entries(p.s)) if (v > 0) keys.add(k);
    if (p.s.dribbles > 0) dribbleCandidates++;
  }
  const seasonName = st.season ? `${st.season} sezonu` : 'Bu sezon';
  return { status: 'ready', seasonName, full: richSeen, available: [...keys], dribbleCandidates, players };
}

// ---------- arama dizini ----------
const searchIdx = { items: [], building: false, built: 0, total: 0, at: 0, lastTry: 0 };
function startIndex() {
  if (searchIdx.building) return;
  searchIdx.building = true;
  searchIdx.lastTry = Date.now();
  (async () => {
    const leagues = L.AVAILABLE.filter((s) => L.BY[s].kind === 'league');
    searchIdx.total = leagues.length;
    const items = [];
    for (const slug of leagues) {
      try {
        const tl = await E.teamsListRaw(slug);
        const arr = (tl && tl.sports && tl.sports[0] && tl.sports[0].leagues && tl.sports[0].leagues[0] && tl.sports[0].leagues[0].teams) || [];
        for (const x of arr) {
          const t = x.team;
          if (!t || t.id == null) continue;
          items.push({ kind: 'team', id: String(t.id), name: t.displayName || t.name, norm: U.norm([t.displayName, t.shortDisplayName, t.name, t.location, t.abbreviation].filter(Boolean).join(' ')), teamId: String(t.id), team: t.displayName || t.name, teamLogo: E.logoOf(t), league: slug, pos: '' });
        }
        await eachLimit(arr, 5, async (x) => {
          const t = x.team;
          try {
            const r = await E.teamRosterRaw(slug, t.id);
            let ath = (r && r.athletes) || [];
            if (ath[0] && ath[0].items) ath = ath.flatMap((g) => g.items || []);
            for (const a of ath) {
              const name = a.displayName || a.fullName;
              if (!name) continue;
              items.push({ kind: 'player', id: String(a.id), name, norm: U.norm(name), teamId: String(t.id), team: t.displayName, teamLogo: E.logoOf(t), league: slug, pos: (a.position && a.position.abbreviation) || '' });
            }
          } catch (e) { /* takım atlanır */ }
        });
      } catch (e) { /* lig atlanır */ }
      searchIdx.items = items.slice();
      searchIdx.built++;
    }
    if (items.length) searchIdx.items = items;
    searchIdx.at = items.length ? Date.now() : 0;
    searchIdx.building = false;
    U.log('arama dizini hazır:', items.length, 'oyuncu');
  })().catch((e) => { searchIdx.building = false; U.log('dizin hatası', e.message); });
}

function search(q) {
  if (!searchIdx.building && Date.now() - searchIdx.lastTry > 10 * 60000 && (!searchIdx.at || Date.now() - searchIdx.at > 12 * HOUR)) startIndex();
  const nq = U.norm(q);
  if (nq.length < 2) return [];
  const toks = nq.split(' ');
  const teams = [], players = [];
  for (const it of searchIdx.items) {
    if (!toks.every((t) => it.norm.includes(t))) continue;
    let score = 0;
    if (it.norm === nq) score = 100;
    else if (it.norm.startsWith(nq)) score = 80;
    else if (it.norm.split(' ').some((w) => w.startsWith(toks[0]))) score = 60;
    else score = 30;
    (it.kind === 'team' ? teams : players).push({ it, score: score - it.norm.length * 0.05 });
  }
  teams.sort((a, b) => b.score - a.score);
  players.sort((a, b) => b.score - a.score);
  const out = teams.slice(0, 4).concat(players).slice(0, 12);
  return out.map(({ it }) => ({ kind: it.kind, id: it.id, name: it.name, teamId: it.teamId, team: it.team, teamLogo: it.teamLogo, league: it.league, pos: it.pos }));
}

// ---------- lig profilleri ----------
const pct = (a, n) => (n ? a / n : null);
function leagueRates(ms) {
  const n = ms.length;
  if (!n) return null;
  let hw = 0, dr = 0, aw = 0, g = 0, hg = 0, ag = 0, o15 = 0, o25 = 0, o35 = 0, bt = 0, cs = 0, nil = 0;
  for (const m of ms) {
    const t = m.hg + m.ag;
    if (m.hg > m.ag) hw++; else if (m.hg < m.ag) aw++; else dr++;
    g += t; hg += m.hg; ag += m.ag;
    if (t > 1) o15++; if (t > 2) o25++; if (t > 3) o35++;
    if (m.hg > 0 && m.ag > 0) bt++;
    if (m.hg === 0 || m.ag === 0) cs++;
    if (t === 0) nil++;
  }
  return { n, home: pct(hw, n), draw: pct(dr, n), away: pct(aw, n), goals: g / n, homeGoals: hg / n, awayGoals: ag / n, over15: pct(o15, n), over25: pct(o25, n), over35: pct(o35, n), btts: pct(bt, n), cleanSheet: pct(cs, n), nilnil: pct(nil, n) };
}
async function leagueOwn(slug) {
  const tr = await training(slug);
  const since = Date.now() - 365 * DAY;
  const own = tr.matches.filter((m) => m.c === slug && m.t >= since);
  return { own, all: tr.matches.filter((m) => m.c === slug) };
}

const lgTable = { status: 'idle', done: 0, total: 0, rows: [], at: 0 };
function leagueTable() {
  if (lgTable.status === 'idle') {
    const c = U.diskGet('lt', 'all', 12 * HOUR);
    if (c.hit && c.d && c.d.rows && c.d.rows.length) { lgTable.rows = c.d.rows; lgTable.at = c.t; lgTable.status = 'ready'; }
  }
  const stale = Date.now() - lgTable.at > 6 * HOUR;
  if (lgTable.status !== 'building' && (lgTable.status === 'idle' || lgTable.status === 'error' || stale)) {
    const slugs = L.AVAILABLE.filter((x) => !L.BY[x].domestic);
    const keep = lgTable.rows;
    lgTable.status = lgTable.rows.length ? 'ready' : 'building';
    lgTable.refreshing = true;
    lgTable.done = 0;
    lgTable.total = slugs.length;
    const rows = [];
    (async () => {
      for (const slug of slugs) {
        try {
          const { own } = await leagueOwn(slug);
          const r = leagueRates(own);
          if (r && r.n >= 8) rows.push({ league: slug, ...r });
        } catch (e) { /* lig atlanır */ }
        lgTable.done++;
        if (lgTable.status === 'building') lgTable.rows = rows.slice();
      }
      lgTable.rows = rows.length ? rows : keep;
      lgTable.status = 'ready';
      lgTable.at = Date.now();
      lgTable.refreshing = false;
      if (rows.length) U.diskSet('lt', 'all', { rows });
    })().catch(() => { lgTable.status = lgTable.rows.length ? 'ready' : 'error'; lgTable.refreshing = false; });
  }
  return { status: lgTable.status, done: lgTable.done, total: lgTable.total, rows: lgTable.rows, at: lgTable.at };
}

const lgDetail = new Map();
const lgDetailJobs = new Map();
function leagueDetail(slug) {
  const hit = lgDetail.get(slug);
  if (hit && Date.now() - hit.at < 3 * HOUR) return { status: 'ready', ...hit.v };
  let j = lgDetailJobs.get(slug);
  if (!j || j.status === 'error') {
    j = { status: 'building', done: 0, total: 0 };
    lgDetailJobs.set(slug, j);
    (async () => {
      const { own, all } = await leagueOwn(slug);
      const base = own.length >= 15 ? own : all.slice(-300);
      const rates = leagueRates(base);
      // son maçların korner / kart / şut ortalamaları (maç kayıtlarından)
      const recent = all.slice().sort((a, b) => b.t - a.t).slice(0, 50);
      j.total = recent.length;
      const acc = { n: 0, corners: [], yellow: [], red: 0, fouls: [], shots: [], sot: [], possHome: [] };
      await eachLimit(recent, 6, async (m) => {
        try {
          const rec = await matchRecord(slug, m.id, { bg: true });
          const ts = rec && rec.teamStats;
          if (ts) {
            const a = ts[m.h], b = ts[m.a];
            if (a && b) {
              const sum = (k) => (n0(a[k]) != null && n0(b[k]) != null ? n0(a[k]) + n0(b[k]) : null);
              const c = sum('wonCorners'), y = sum('yellowCards'), r = sum('redCards'), f = sum('foulsCommitted'), sh = sum('totalShots'), so = sum('shotsOnTarget');
              if (c != null) acc.corners.push(c);
              if (y != null) { acc.yellow.push(y + (r || 0)); acc.red += r || 0; }
              if (f != null) acc.fouls.push(f);
              if (sh != null) acc.shots.push(sh);
              if (so != null) acc.sot.push(so);
              acc.n++;
            }
          }
        } catch (e) { /* maç atlanır */ }
        j.done++;
      });
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      const rate = (a, line) => (a.length ? a.filter((x) => x > line).length / a.length : null);
      const stats = acc.n >= 5 ? {
        n: acc.n,
        corners: { avg: avg(acc.corners), lines: [8.5, 9.5, 10.5, 11.5].map((l) => ({ line: l, p: rate(acc.corners, l) })) },
        cards: { avg: avg(acc.yellow), lines: [3.5, 4.5, 5.5].map((l) => ({ line: l, p: rate(acc.yellow, l) })), redPerMatch: acc.red / Math.max(1, acc.yellow.length) },
        fouls: avg(acc.fouls), shots: avg(acc.shots), sot: avg(acc.sot),
      } : null;
      // puan durumundan öne çıkan takımlar
      let teams = null;
      try {
        const st = await standings(slug);
        const rows = st.groups.flatMap((g) => g.rows).filter((r) => r.gp >= 3);
        if (rows.length >= 4) {
          const per = rows.map((r) => ({ teamId: r.teamId, name: r.name, logo: r.logo, gp: r.gp, gfpg: r.gf / r.gp, gapg: r.ga / r.gp, pts: r.pts }));
          const top = (arr, key, dir) => arr.slice().sort((x, y) => dir * (y[key] - x[key])).slice(0, 3);
          teams = { bestAttack: top(per, 'gfpg', 1), bestDefense: top(per, 'gapg', -1), mostGoals: top(per.map((r) => ({ ...r, tot: r.gfpg + r.gapg })), 'tot', 1), fewestGoals: top(per.map((r) => ({ ...r, tot: r.gfpg + r.gapg })), 'tot', -1) };
        }
      } catch (e) { /* puan durumu yoksa sorun değil */ }
      const tr = await training(slug);
      const v = { league: slug, season: null, window: base === own ? '12 ay' : 'tüm kayıtlar', rates, stats, teams, pooled: tr.pooled, at: Date.now() };
      lgDetail.set(slug, { at: Date.now(), v });
      j.status = 'ready';
      lgDetailJobs.delete(slug);
    })().catch((e) => { U.log('lig profili hata', slug, e.message); j.status = 'error'; j.error = e.message; });
  }
  if (j.status === 'error') { lgDetailJobs.delete(slug); return { status: 'error', error: j.error || 'Veri kaynağına ulaşılamadı' }; }
  return { status: 'building', done: j.done, total: j.total };
}

// ---------- lig analizi: korner/kart karnesi, eksik oyuncu, şut (xG), ilk yarı payı, pazar karnesi, dinlenme etkisi ----------
const ANALYSIS_N = 400; // her lig için en son bu kadar maçın kaydı okunur (bir kez okunan kayıt diskte kalır)
const anMem = new Map();
const anJobs = new Map();
const anMiss = new Map();
const tickS = () => new Promise((r) => setImmediate(r));

// ---- dinlenme: takımın tüm turnuvalardaki maç zamanları ----
const CONT_CLUBS = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'conmebol.libertadores', 'conmebol.sudamericana', 'afc.champions'];
const CONCACAF_C = new Set(['mex', 'usa', 'hon', 'crc', 'gua', 'slv']);
const CONMEBOL_C = new Set(['uru', 'per', 'par', 'ecu', 'ven', 'bol']);
function relatedComps(slug) {
  const me = L.BY[slug];
  if (!me || me.kind !== 'league') return [];
  const out = new Set();
  for (const l of L.ALL) if (l.available && l.kind === 'cup' && l.domestic && l.country === me.country && l.slug !== slug && !/^(uefa|concacaf)\./.test(l.slug)) out.add(l.slug);
  const pre = slug.split('.')[0];
  if (/\.1$/.test(slug)) {
    for (const c of CONT_CLUBS) { const pool = L.poolOf(c); if (pool && pool.includes(slug)) out.add(c); }
    if (CONCACAF_C.has(pre)) out.add('concacaf.champions');
    if (CONMEBOL_C.has(pre)) { out.add('conmebol.libertadores'); out.add('conmebol.sudamericana'); }
  }
  return [...out].filter((x) => L.BY[x] && L.BY[x].available);
}
const restMem = new Map();
async function restTimes(slug, months, tr0) {
  const key = `${slug}:${months}`;
  const hit = restMem.get(key);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.v;
  return U.once('rest:' + key, async () => {
    const tm = new Map();
    const add = (id, t) => { let a = tm.get(id); if (!a) { a = []; tm.set(id, a); } a.push(t); };
    const seen = new Set();
    const trn = tr0 || (await training(slug));
    for (const m of trn.matches.concat(trn.skipped || [])) { if (seen.has(m.id)) continue; seen.add(m.id); add(m.h, m.t); add(m.a, m.t); }
    const now = new Date();
    const cur = U.ym(now);
    const mos = [];
    for (let k = 0; k < months; k++) mos.push(U.ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))));
    const rel = relatedComps(slug);
    let used = 0;
    await eachLimit(rel.flatMap((rs) => mos.map((mo) => [rs, mo])), 6, async ([rs, mo]) => {
      try {
        const evs = await E.scoreboardMonth(rs, mo, { ttl: mo === cur ? 20 * 60000 : 24 * HOUR, bg: true });
        for (const e of evs) {
          if (!e.status.completed || seen.has(e.id)) continue;
          seen.add(e.id); used++;
          const t = Date.parse(e.date);
          add(e.home.id, t); add(e.away.id, t);
        }
      } catch (e) { /* o ay okunamadıysa o turnuva eksik kalır */ }
    });
    for (const a of tm.values()) a.sort((x, y) => x - y);
    const v = { times: tm, related: rel, used };
    restMem.set(key, { at: Date.now(), v });
    return v;
  });
}

// ---- dinlenme: lig ölçümlerinin birleşik havuzu ----
let restPoolMem = null;
function restPoolData() {
  if (!restPoolMem) { const c = U.diskGet('rs', 'pool', Infinity); restPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return restPoolMem;
}
function restRemember(slug, est) {
  const p = restPoolData();
  p.leagues[slug] = { a: est.a, d: est.d, info: est.info, n: est.n, at: Date.now() };
  U.diskSet('rs', 'pool', p);
}
function restPoolSummary() {
  const list = Object.values(restPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR);
  return RS.pool(list);
}
// bu lig için uygulanacak dinlenme katsayısı: önce ligin kendi ölçümü, anlamlı değilse birleşik ölçüm
function restParams(slug) {
  const an = analysisIfReady(slug, false);
  const est = an && an.rest;
  const pool = restPoolSummary();
  if (est && est.enough && est.significant && est.applied) return { k: est.applied, source: 'league', est, pool, ready: true };
  if (pool.enough && pool.significant && pool.applied) return { k: pool.applied, source: 'pool', est, pool, ready: !!an };
  return { k: null, source: null, est, pool, ready: !!an };
}


// ---- motivasyon: puan durumunda yeri belli takımlar ----
const stakesMem = new Map();
async function stakesCtx(slug, tr) {
  const hit = stakesMem.get(slug);
  if (hit && hit.tr === tr && Date.now() - hit.at < 30 * 60000) return hit.v;
  const own = tr.matches.filter((m) => m.c === slug);
  let rows = null;
  try { const sd = await standings(slug); if (sd && sd.groups && sd.groups.length === 1) rows = sd.groups[0].rows; } catch (e) { /* not bilgisi yoksa varsayılan çizgiler */ }
  const ids = new Set(own.flatMap((m) => [m.h, m.a]));
  const cuts = ST.cutsFromRows(rows, ids.size);
  const now = new Date();
  const windowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 15, 1);
  const v = { ...ST.analyzeLeague(own, cuts, windowStart), cuts };
  stakesMem.set(slug, { at: Date.now(), tr, v });
  return v;
}
let stakesPoolMem = null;
function stakesPoolData() {
  if (!stakesPoolMem) { const c = U.diskGet('st', 'pool', Infinity); stakesPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return stakesPoolMem;
}
function stakesRemember(slug, est) {
  const p = stakesPoolData();
  p.leagues[slug] = { beta: est.beta, info: est.info, n: est.n, at: Date.now() };
  U.diskSet('st', 'pool', p);
}
function stakesPoolSummary() {
  const list = Object.values(stakesPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR);
  const r = ST.pool(list);
  if (r.enough) r.applied = r.significant ? { a: r.beta[0] * ST.SHR, d: r.beta[1] * ST.SHR } : null;
  return r.enough ? { ...r, a: r.beta[0], d: r.beta[1] } : r;
}
function stakesParams(slug) {
  const an = analysisIfReady(slug, false);
  const est = an && an.stakes;
  const pool = stakesPoolSummary();
  if (est && est.enough && est.significant && est.applied) return { k: est.applied, source: 'league', est, pool, ready: true };
  if (pool.enough && pool.significant && pool.applied) return { k: pool.applied, source: 'pool', est, pool, ready: !!an };
  return { k: null, source: null, est, pool, ready: !!an };
}

// ---- hava durumu ----
let wxPoolMem = null;
function wxPoolData() {
  if (!wxPoolMem) { const c = U.diskGet('wp', 'pool', Infinity); wxPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return wxPoolMem;
}
function wxRemember(slug, est) {
  const p = wxPoolData();
  p.leagues[slug] = { feats: Object.fromEntries(est.feats.map((f) => [f.key, { beta: f.beta, prec: f.prec }])), at: Date.now() };
  U.diskSet('wp', 'pool', p);
}
function wxPoolSummary() { return WX.pool(Object.values(wxPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR)); }
// bu lig için uygulanacak hava katsayıları: özellik başına önce ligin kendi ölçümü, anlamlı değilse birleşik ölçüm
function wxParams(slug) {
  const an = analysisIfReady(slug, false);
  const est = an && an.weather;
  const pool = wxPoolSummary();
  const k = {}, src = {};
  for (const f of WX.FEATS) {
    const lf = est && est.enough && est.feats && est.feats.find((x) => x.key === f.key);
    if (lf && lf.adopted) { k[f.key] = lf.beta * WX.SHR; src[f.key] = 'league'; }
    else if (pool[f.key] && pool[f.key].significant && pool[f.key].applied != null) { k[f.key] = pool[f.key].applied; src[f.key] = 'pool'; }
  }
  return { k: Object.keys(k).length ? k : null, src, est, pool, ready: !!an };
}
// ---- kırmızı kart ----
let rcPoolMem = null;
function rcPoolData() {
  if (!rcPoolMem) { const c = U.diskGet('rp', 'pool', Infinity); rcPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return rcPoolMem;
}
function rcRemember(slug, est) {
  const p = rcPoolData();
  p.leagues[slug] = { feats: Object.fromEntries(est.feats.map((f) => [f.key, { beta: f.beta, prec: f.prec }])), at: Date.now() };
  U.diskSet('rp', 'pool', p);
}
function rcPoolSummary() { return RC.pool(Object.values(rcPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR)); }
// canlı maçta uygulanacak katsayılar: özellik başına önce ligin kendi ölçümü, anlamlı değilse birleşik ölçüm
function rcParams(slug) {
  const an = analysisIfReady(slug, false);
  const est = an && an.red;
  const pool = rcPoolSummary();
  const k = {}, src = {};
  for (const f of RC.FEATS) {
    const lf = est && est.enough && est.feats && est.feats.find((x) => x.key === f.key);
    if (lf && lf.adopted) { k[f.key] = lf.beta * RC.SHR; src[f.key] = 'league'; }
    else if (pool[f.key] && pool[f.key].significant && pool[f.key].applied != null) { k[f.key] = pool[f.key].applied; src[f.key] = 'pool'; }
  }
  return { k: Object.keys(k).length ? k : null, src, est, pool, ready: !!an };
}
// ---- skor durumu ve dakika etkisi (canlı) ----
let gsPoolMem = null;
function gsPoolData() {
  if (!gsPoolMem) { const c = U.diskGet('gp', 'pool', Infinity); gsPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return gsPoolMem;
}
function gsRemember(slug, est) {
  const p = gsPoolData();
  p.leagues[slug] = { feats: Object.fromEntries(est.feats.map((f) => [f.key, { beta: f.beta, prec: f.prec }])), at: Date.now() };
  U.diskSet('gp', 'pool', p);
}
function gsPoolSummary() { return GS.pool(Object.values(gsPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR)); }
// canlı maçta uygulanacak katsayılar: ligin kendi ölçümü yalnızca dışarıda testi geçtiyse, değilse birleşik ölçüm (özellik başına)
function gsPick(an, pool) {
  const est = an && an.state;
  const k = {}, src = {};
  const own = !!(est && est.enough && est.feats && est.test && est.test.adopted);
  for (const f of GS.FEATS) {
    const lf = own && est.feats.find((x) => x.key === f.key);
    if (lf && lf.adopted) { k[f.key] = lf.beta * GS.SHR; src[f.key] = 'league'; }
    else if (pool[f.key] && pool[f.key].significant && pool[f.key].applied != null) { k[f.key] = pool[f.key].applied; src[f.key] = 'pool'; }
  }
  return { k: Object.keys(k).length ? k : null, src, own, est };
}
function gsParams(slug) {
  const an = analysisIfReady(slug, false);
  const pool = gsPoolSummary();
  return { ...gsPick(an, pool), pool, ready: !!an };
}
// ---- oran hareketi ----
async function oddsMoveFor(slug, id, { fresh = false } = {}) {
  const rec = await matchRecord(slug, id, { fresh });
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const s = OM.get(slug, id);
  let model = null;
  if (rec.status.state === 'pre') { try { const pr = await predict(slug, id); model = { home: pr.markets.home, draw: pr.markets.draw, away: pr.markets.away }; } catch (e) { /* model hazır değilse çizgi çizilmez */ } }
  const mk = rec.market;
  return {
    state: rec.status.state, kickoff: rec.date, series: s.pts, close: s.close, summary: OM.summary(s), model,
    current: mk ? { home: mk.home, draw: mk.draw, away: mk.away, provider: mk.provider || null, src: mk.src || 'espn' } : null,
  };
}
// ---- karşılaşma geçmişi (H2H) ölçümü ----
let h2PoolMem = null;
function h2PoolData() {
  if (!h2PoolMem) { const c = U.diskGet('hp', 'pool', Infinity); h2PoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return h2PoolMem;
}
function h2Remember(slug, est) {
  const p = h2PoolData();
  p.leagues[slug] = { feats: { h2h: { beta: est.beta, prec: est.feats[0].prec } }, at: Date.now() };
  U.diskSet('hp', 'pool', p);
}
function h2PoolSummary() { return H2.pool(Object.values(h2PoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR)); }
// iki takımın geçmişi: lig verisi (16 ay, bağlı turnuvalar dahil) + ESPN'in maç özetindeki geçmiş listesi
async function h2hFor(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const tr = await training(slug);
  const Hh = rec.home.id, Aa = rec.away.id;
  const t0 = Date.parse(rec.date) - 3 * HOUR;
  const items = [];
  const seen = new Set();
  for (const m of tr.matches) {
    if (m.id === rec.id || m.t >= t0) continue;
    const fwd = m.h === Hh && m.a === Aa, rev = m.h === Aa && m.a === Hh;
    if (!fwd && !rev) continue;
    seen.add(m.id);
    items.push({ id: m.id, t: m.t, home: fwd, gh: fwd ? m.hg : m.ag, ga: fwd ? m.ag : m.hg, hn: m.hn, an: m.an, comp: m.c, src: 'lig' });
  }
  const nH = H2.norm(rec.home.name), nA = H2.norm(rec.away.name);
  for (const e of rec.h2h || []) {
    const t = Date.parse(e.date);
    if (!Number.isFinite(t) || t >= t0 || seen.has(e.id)) continue;
    const eh = H2.norm(e.home), ea = H2.norm(e.away);
    const fwd = eh === nH && ea === nA, rev = eh === nA && ea === nH;
    if (!fwd && !rev) continue;
    const hs = Number(e.homeScore), as = Number(e.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const gh = fwd ? hs : as, ga = fwd ? as : hs;
    if (items.some((x) => Math.abs(x.t - t) < 36 * HOUR && x.gh === gh && x.ga === ga)) continue;
    items.push({ id: e.id, t, home: fwd, gh, ga, hn: e.home, an: e.away, comp: null, src: 'espn' });
  }
  items.sort((a, b) => b.t - a.t);
  const list = items.slice(0, 10);
  const an = analysisPeek(slug);
  return {
    home: { id: Hh, name: rec.home.name }, away: { id: Aa, name: rec.away.name },
    summary: H2.summarize(list),
    meetings: list.map((x) => ({ id: x.id, date: new Date(x.t).toISOString(), home: x.hn, away: x.an, hg: x.home ? x.gh : x.ga, ag: x.home ? x.ga : x.gh, curHome: x.home, comp: x.comp, src: x.src })),
    measure: { league: an && an.h2h ? { enough: !!an.h2h.enough, n: an.h2h.n, beta: an.h2h.beta, se: an.h2h.se, z: an.h2h.z, pct: an.h2h.pct, adopted: !!an.h2h.adopted } : null, pool: h2PoolSummary() },
  };
}
// ---- uzak deplasman ve derbi ----
let tvPoolMem = null;
function tvPoolData() {
  if (!tvPoolMem) { const c = U.diskGet('tp', 'pool', Infinity); tvPoolMem = c.hit && c.d && c.d.leagues ? c.d : { leagues: {} }; }
  return tvPoolMem;
}
function tvRemember(slug, est) {
  const p = tvPoolData();
  p.leagues[slug] = { feats: Object.fromEntries(est.feats.map((f) => [f.key, { beta: f.beta, prec: f.prec }])), at: Date.now() };
  U.diskSet('tp', 'pool', p);
}
function tvPoolSummary() { return TV.pool(Object.values(tvPoolData().leagues).filter((x) => Date.now() - x.at < 90 * 24 * HOUR)); }
// bu lig için uygulanacak katsayılar: özellik başına önce ligin kendi ölçümü, anlamlı değilse birleşik ölçüm
function tvParams(slug) {
  const an = analysisIfReady(slug, false);
  const est = an && an.travel;
  const pool = tvPoolSummary();
  const k = {}, src = {};
  for (const f of TV.FEATS) {
    const lf = est && est.enough && est.feats && est.feats.find((x) => x.key === f.key);
    if (lf && lf.adopted) { k[f.key] = lf.beta * TV.SHR; src[f.key] = 'league'; }
    else if (pool[f.key] && pool[f.key].significant && pool[f.key].applied != null) { k[f.key] = pool[f.key].applied; src[f.key] = 'pool'; }
  }
  return { k: Object.keys(k).length ? k : null, src, est, pool, ready: !!an };
}
// bir ligin takımlarının ev şehirleri ve koordinatları (ev maçlarının oynandığı şehir; koordinat için hava modülünün geocoding'i)
async function travelBase(own) {
  if (WX.isDown()) return { ok: false, reason: 'down' };
  const base = TV.baseCities(own);
  if (base.size < 6) return { ok: false, reason: 'nocity' };
  const loc = await WX.locate([...base.values()]);
  if (!loc.byCity.size) return { ok: false, reason: WX.isDown() ? 'down' : 'geo' };
  return { ok: true, base, coords: Object.fromEntries([...loc.byCity.entries()].map(([c, x]) => [c, { lat: x.lat, lon: x.lon }])), cc: loc.cc, cities: loc.byCity.size, asked: loc.asked };
}
// yaklaşan maç: deplasman takımının yolculuğu
function travelForMatch(slug, rec) {
  const an = analysisIfReady(slug, false);
  const tv = an && an.travel;
  if (!tv || !tv.cityOf || !tv.coords) return null;
  const ch = tv.cityOf[rec.home.id], ca = tv.cityOf[rec.away.id];
  const trip = TV.tripOf(ch, ca, tv.coords);
  return trip ? { ...trip, cityHome: ch, cityAway: ca } : null;
}
// bir ligin maçları için hava işaretleri: ev sahibi takımın sahasının şehri
async function weatherFeed(slug, own) {
  if (WX.isDown()) return { ok: false, reason: 'down' };
  const cnt = new Map();
  for (const m of own) { if (!m.vc || m.neutral) continue; let c = cnt.get(m.h); if (!c) { c = new Map(); cnt.set(m.h, c); } c.set(m.vc, (c.get(m.vc) || 0) + 1); }
  const base = new Map();
  for (const [tid, c] of cnt) base.set(tid, [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  if (base.size < 6) return { ok: false, reason: 'nocity' };
  const loc = await WX.locate([...base.values()]);
  if (!loc.byCity.size) return { ok: false, reason: WX.isDown() ? 'down' : 'geo' };
  const t0 = own[0].t - DAY, t1 = own[own.length - 1].t + DAY;
  const hm = new Map();
  await eachLimit([...loc.byCity.keys()], 3, async (c) => { hm.set(c, await WX.hourlyFor(loc.byCity.get(c), t0, t1)); });
  const flags = new Map();
  const sums = { t: 0, p: 0, w: 0, n: 0 };
  for (const m of own) {
    const city = base.get(m.h), h = city && hm.get(city);
    const w = h && WX.weatherAt(h, m.t);
    if (w) { flags.set(m.id, { fl: WX.flagsOf(w), w }); sums.t += w.t; sums.p += w.p; sums.w += w.w; sums.n++; }
  }
  if (!flags.size) return { ok: false, reason: WX.isDown() ? 'down' : 'nodata' };
  return { ok: true, flags, cc: loc.cc, cities: loc.byCity.size, asked: loc.asked, avg: { t: sums.t / sums.n, p: sums.p / sums.n, w: sums.w / sums.n } };
}
// yaklaşan maç: maç saatindeki tahmin
async function weatherForMatch(slug, rec) {
  const t = Date.parse(rec.date);
  if (t - Date.now() > 15 * 24 * HOUR || WX.isDown()) return null;
  const city = rec.city;
  if (!city) return null;
  const an = analysisIfReady(slug, false);
  const cc = an && an.weather && an.weather.cc;
  const res = (await WX.geocode(city)).slice().sort((a, b) => b.pop - a.pop);
  const pick = (cc && res.find((r) => r.cc === cc)) || (cc ? null : res[0]);
  if (!pick) return null;
  const hm = await WX.hourlyFor(pick, t - DAY, t + DAY);
  const w = WX.weatherAt(hm, t);
  if (!w) return null;
  return { city, w, fl: WX.flagsOf(w) };
}

async function runAnalysis(slug, job) {
  const tr0 = await training(slug);
  const own = tr0.matches.filter((m) => m.c === slug).sort((a, b) => b.t - a.t).slice(0, ANALYSIS_N).sort((a, b) => a.t - b.t);
  job.total = own.length; job.done = 0; job.phase = 'read';
  if (FD.covered(slug)) { try { const l = await FD.learn(slug, own); U.log('football-data', slug, 'satır', l.rows, 'eşleşen takım', l.mapped); } catch (e) { U.log('football-data hatası', slug, e.message); } }
  const recs = new Array(own.length);
  let fail = 0;
  await eachLimit(own.map((m, i) => [m, i]), 6, async ([m, i]) => {
    try { recs[i] = await matchRecord(slug, m.id, { bg: true }); } catch (e) { fail++; }
    job.done++;
  });
  if (fail > own.length * 0.5) throw new Error('Veri kaynağına ulaşılamadı');
  job.phase = 'calc';
  // --- korner / kart ---
  const spRecs = [];
  own.forEach((m, i) => {
    const rec = recs[i];
    const ts = rec && rec.teamStats;
    if (!ts || !ts[m.h] || !ts[m.a]) return;
    const c = n0(ts[m.h].wonCorners), ca = n0(ts[m.a].wonCorners), y = n0(ts[m.h].yellowCards), ya = n0(ts[m.a].yellowCards);
    if (c == null || ca == null || y == null || ya == null) return;
    spRecs.push({ t: m.t, h: m.h, a: m.a, ref: rec.referee || null, sp: { c, ca, y, ya } });
  });
  const sp = spRecs.length >= 40 ? SP.backtestSp(spRecs) : { n: spRecs.length, enough: false };
  const spRows = sp.rowsLite || []; delete sp.rowsLite;
  // --- hakem etkisi (sarı kart) ---
  let referee = { enough: false, n: 0, withRef: 0, matches: own.length, reason: 'nodata' };
  try { referee = RF.analyze(spRows, own.length); referee.refKnown = recs.filter((r) => r && r.referee).length; } catch (e) { U.log('hakem analizi hatası', slug, e.message); }

  // --- şut bazlı beklenen gol: katsayılar bu ligin maçlarından; modele katılıp katılmayacağına tune karar verir ---
  let xg = { enough: false, n: 0 };
  let tr = tr0;
  try {
    const b = XG.build(own, recs);
    if (b.enough) {
      xg = { enough: true, n: b.n, coef: b.coef, corr: b.corr, coverage: own.length ? b.n / own.length : 0 };
      const prev = xgInfo(slug);
      if (!prev || Math.abs(b.n - prev.n) >= 10) {
        setXg(slug, { at: Date.now(), coef: b.coef, corr: b.corr, n: b.n, map: b.map });
        tr = await training(slug); // şut bilgisi eklenmiş eğitim verisi
      }
    } else xg = { enough: false, n: b.n, coverage: own.length ? b.n / own.length : 0 };
  } catch (e) { U.log('xg hatası', slug, e.message); }

  // --- ilk yarı payı (gol dakikalarından) ---
  const hsOf = new Array(own.length).fill(null);
  const halves = [];
  own.forEach((m, i) => { const r = recs[i]; if (!r) return; const hh = HV.halvesOf(r, m.h, m.a, m.hg, m.ag); if (hh) { hsOf[i] = hh; halves.push(hh); } });
  const half = HV.share(halves);
  const share = half.enough ? half.applied : HV.HALF1;

  // --- her maç için modelin o güne kadarki verilerle beklentisi (haftalık yeniden uyum) ---
  const tp = tuneInfo(slug);
  const params = paramsOf(tp);
  const lam = new Map();
  const p3 = new Map(); // maç -> modelin 1X2 olasılıkları (piyasa karşılaştırması için)
  const items = [];
  const WK = 7 * DAY;
  for (let s0 = own[0].t + 21 * DAY; s0 <= own[own.length - 1].t + WK; s0 += WK) {
    const idxs = [];
    own.forEach((m, i) => { if (m.t >= s0 && m.t < s0 + WK) idxs.push(i); });
    if (!idxs.length) continue;
    await tickS();
    const mdl = M.fit(tr.matches, s0, { halfLife: params.halfLife, prior: params.prior, iters: 40, xgW: params.xgW, thK: params.thK });
    if (!mdl.ok) continue;
    for (const i of idxs) {
      const m = own[i];
      if (mdl.games(m.h) < 3 || mdl.games(m.a) < 3) continue;
      const r = M.matchup(mdl, m.h, m.a, { neutral: m.neutral, comp: m.c });
      lam.set(m.id, [r.lambdaHome, r.lambdaAway]);
      p3.set(m.id, [r.markets.home, r.markets.draw, r.markets.away]);
      items.push({ ex: M.extraMarkets(r.lambdaHome, r.lambdaAway, r.grid, share), ex46: M.extraMarkets(r.lambdaHome, r.lambdaAway, r.grid, HV.HALF1), hg: m.hg, ag: m.ag, hs: hsOf[i] });
    }
  }
  // --- yeni pazarların karnesi ---
  let markets = { enough: false, n: items.length };
  if (items.length >= 60) {
    const ev = HV.evaluate(items);
    markets = { enough: true, n: items.length, withHalves: items.filter((x) => x.hs).length, share, ...ev };
  }

  // --- eksik oyuncu etkisi ---
  const rows = [];
  const withRost = own.map((m, i) => ({ m, rec: recs[i] })).filter((x) => x.rec && x.rec.rosters && x.rec.rosters.length);
  const withRoster = withRost.length;
  let absence = { enough: false, n: 0, rosters: withRoster };
  if (withRoster >= 60) {
    const feed = withRost.map(({ m, rec }) => ({ t: m.t, id: m.id, h: m.h, a: m.a, hg: m.hg, ag: m.ag, lh: lam.has(m.id) ? lam.get(m.id)[0] : null, la: lam.has(m.id) ? lam.get(m.id)[1] : null, rosters: rec.rosters }));
    rows.push(...AB.buildRows(feed));
    absence = { ...AB.estimate(rows), rosters: withRoster };
    if (!absence.enough) absence = { enough: false, n: rows.length, rosters: withRoster };
  }

  // --- dinlenme / maç yoğunluğu etkisi ---
  let rest = { enough: false, n: 0 };
  try {
    const rt = await restTimes(slug, 16, tr);
    const feed = own.map((m) => {
      const l = lam.get(m.id);
      return { hg: m.hg, ag: m.ag, lh: l ? l[0] : null, la: l ? l[1] : null, rh: RS.restDays(rt.times.get(m.h), m.t), ra: RS.restDays(rt.times.get(m.a), m.t) };
    });
    const rr = RS.buildRows(feed);
    rest = { ...RS.estimate(rr), related: rt.related.length, extraMatches: rt.used };
    if (rest.enough) restRemember(slug, rest);
  } catch (e) { U.log('dinlenme analizi hatası', slug, e.message); }

  // --- motivasyon: işi bitmiş takımlar ---
  let stakes = { enough: false, n: 0 };
  try {
    const ctx = await stakesCtx(slug, tr);
    if (!ctx.seasonsUsed) stakes = { enough: false, n: 0, reason: ctx.reason };
    else {
      const feed = own.map((m) => { const l = lam.get(m.id), f = ctx.flags.get(m.id); return { hg: m.hg, ag: m.ag, lh: l ? l[0] : null, la: l ? l[1] : null, sh: f ? f.h : null, sa: f ? f.a : null }; });
      stakes = { ...ST.estimate(ST.buildRows(feed)), seasons: ctx.seasonsUsed, cuts: ctx.cuts };
      if (stakes.enough) stakesRemember(slug, stakes);
    }
  } catch (e) { U.log('motivasyon analizi hatası', slug, e.message); }

  // --- hava durumu etkisi (Open-Meteo) ---
  let weather = { enough: false, n: 0 };
  try {
    if (L.isCupOrIntl(slug) || L.NEUTRAL.has(slug)) weather = { enough: false, n: 0, reason: 'intl' };
    else {
      const wf = await weatherFeed(slug, own);
      if (!wf.ok) weather = { enough: false, n: 0, reason: wf.reason };
      else {
        const feed = own.map((m) => { const l = lam.get(m.id), f = wf.flags.get(m.id); return { hg: m.hg, ag: m.ag, lh: l ? l[0] : null, la: l ? l[1] : null, fl: f ? f.fl : null }; });
        weather = { ...WX.estimate(WX.buildRows(feed)), cities: wf.cities, matched: wf.flags.size, cc: wf.cc, avg: wf.avg };
        if (weather.enough) wxRemember(slug, weather);
      }
    }
  } catch (e) { U.log('hava analizi hatası', slug, e.message); }

  // --- uzak deplasman ve derbi etkisi ---
  let travel = { enough: false, n: 0 };
  try {
    if (L.isCupOrIntl(slug) || L.NEUTRAL.has(slug)) travel = { enough: false, n: 0, reason: 'intl' };
    else {
      const tb = await travelBase(own);
      if (!tb.ok) travel = { enough: false, n: 0, reason: tb.reason };
      else {
        let matched = 0;
        const feed = own.map((m) => {
          const l = lam.get(m.id);
          const trip = m.neutral ? null : TV.tripOf(tb.base.get(m.h), tb.base.get(m.a), tb.coords);
          if (trip) matched++;
          return { hg: m.hg, ag: m.ag, lh: l ? l[0] : null, la: l ? l[1] : null, trip };
        });
        const nFar = feed.filter((f) => f.trip && f.trip.far).length, nDerby = feed.filter((f) => f.trip && f.trip.derby).length;
        const kms = feed.filter((f) => f.trip && !f.trip.derby).map((f) => f.trip.km).sort((a, b) => a - b);
        travel = { ...TV.estimate(TV.buildRows(feed)), cities: tb.cities, matched, nFar, nDerby, medianKm: kms.length ? Math.round(kms[Math.floor(kms.length / 2)]) : null, maxKm: kms.length ? Math.round(kms[kms.length - 1]) : null, cc: tb.cc, cityOf: Object.fromEntries(tb.base), coords: tb.coords };
        if (travel.enough) tvRemember(slug, travel);
      }
    }
  } catch (e) { U.log('mesafe analizi hatası', slug, e.message); }

  // --- kırmızı kartın gol beklentisine etkisi (canlı olasılıklar için) ---
  let state = { enough: false, n: 0, usable: 0 };
  let h2h = { enough: false, n: 0 };
  let red = { enough: false, n: 0, counts: { down: 0, up: 0 }, reds: 0, usable: 0 };
  try {
    const feed = [];
    let reds = 0;
    own.forEach((m, i) => {
      const l = lam.get(m.id), ev = RC.eventsOf(recs[i], m.h, m.a, m.hg, m.ag);
      if (!l || !ev) return;
      reds += ev.reds.length;
      feed.push({ t: m.t, hg: m.hg, ag: m.ag, lh: l[0], la: l[1], reds: ev.reds, goals: ev.goals, share });
    });
    red = { ...RC.estimate(RC.buildRows(feed)), reds, usable: feed.length };
    if (red.enough) rcRemember(slug, red);
    // skor durumu ve dakika etkisi: aynı maç listesiyle (zaman sırasıyla)
    feed.sort((a, b) => a.t - b.t);
    const est = GS.estimate(GS.buildRows(feed));
    state = { ...est, usable: feed.length, test: est.enough ? GS.evaluate(feed) : null };
    if (state.enough) gsRemember(slug, state);
  } catch (e) { U.log('skor durumu analizi hatası', slug, e.message); }

  // --- karşılaşma geçmişi (H2H): önceki maçın sürprizi sonrakini etkiliyor mu? (yalnızca bilgi) ---
  try {
    const feed = [];
    for (const m of own) { const l = lam.get(m.id); if (!l) continue; feed.push({ t: m.t, pair: m.h < m.a ? m.h + '|' + m.a : m.a + '|' + m.h, home: m.h, hg: m.hg, ag: m.ag, lh: l[0], la: l[1] }); }
    feed.sort((a, b) => a.t - b.t);
    const items = H2.withSurprise(feed);
    h2h = { ...H2.estimate(H2.buildRows(items)), pairs: items.filter((x) => x.x != null).length };
    if (h2h.enough) h2Remember(slug, h2h);
  } catch (e) { U.log('H2H analizi hatası', slug, e.message); }

  // --- ikinci kaynak (football-data.co.uk) kullanımı ---
  const fd = FD.covered(slug) ? { covered: true, code: FD.codeOf(slug), odds: recs.filter((r) => r && r.fd && r.fd.odds).length, ref: recs.filter((r) => r && r.fd && r.fd.ref).length, espnOdds: recs.filter((r) => r && r.market && !(r.fd && r.fd.odds)).length, of: own.length } : { covered: false };

  // --- model ve piyasa: karışım ağırlığı, sanal kâr/zarar ---
  let blend = { enough: false, n: 0 }, bets = { enough: false, n: 0 };
  try {
    const list = [];
    own.forEach((m, i) => {
      const rec = recs[i], p = p3.get(m.id), mk = rec && rec.market;
      if (!p || !mk) return;
      list.push({ t: m.t, pm: p, pk: [mk.home, mk.draw, mk.away], dec: [mk.decHome, mk.decDraw, mk.decAway], y: m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2 });
    });
    const rowsB = BT.buildRows(list);
    const cov = p3.size ? rowsB.length / p3.size : 0;
    blend = { ...BT.analyzeBlend(rowsB), withMarket: rowsB.length, coverage: cov };
    bets = { ...BT.analyzeBets(rowsB), withMarket: rowsB.length };
  } catch (e) { U.log('piyasa analizi hatası', slug, e.message); }

  return { league: slug, at: Date.now(), matches: own.length, sp, referee, absence, params, xg, half, markets, rest, stakes, weather, travel, red, state, h2h, blend, bets, fd };
}

function leagueAnalysis(slug) {
  const hit = anMem.get(slug);
  if (hit && Date.now() - hit.at < 12 * HOUR) return { status: 'ready', ...hit.v, restPool: restPoolSummary(), stakesPool: stakesPoolSummary(), weatherPool: wxPoolSummary(), travelPool: tvPoolSummary(), redPool: rcPoolSummary(), statePool: gsPoolSummary(), h2hPool: h2PoolSummary() };
  const c = U.diskGet('an', slug, 12 * HOUR);
  if (c.hit && c.d) { anMem.set(slug, { at: c.t, v: c.d }); return { status: 'ready', ...c.d, restPool: restPoolSummary(), stakesPool: stakesPoolSummary(), weatherPool: wxPoolSummary(), travelPool: tvPoolSummary(), redPool: rcPoolSummary(), statePool: gsPoolSummary(), h2hPool: h2PoolSummary() }; }
  let j = anJobs.get(slug);
  if (j && j.status === 'error' && Date.now() - j.at < 5 * 60000) return { status: 'error', error: j.error };
  if (!j || j.status === 'error') {
    j = { status: 'building', done: 0, total: 0, phase: 'read', at: Date.now() };
    anJobs.set(slug, j);
    runAnalysis(slug, j).then((v) => {
      anMem.set(slug, { at: Date.now(), v });
      U.diskSet('an', slug, v);
      anMiss.delete(slug);
      anJobs.delete(slug);
    }).catch((e) => { U.log('lig analizi hata', slug, e.message); j.status = 'error'; j.error = e.message || 'Hata'; j.at = Date.now(); });
  }
  return { status: 'building', done: j.done, total: j.total, phase: j.phase };
}
// ---------- ölçüm özeti: tüm liglerde hangi etki ölçüldü, hangisi doğrulandı ----------
const MEASURES = [
  { key: 'blend', label: 'Model + piyasa karışımı', short: 'Piyasa', what: 'Model ile bahis oranlarını karıştırmak, modelden anlamlı iyi mi?' },
  { key: 'bets', label: 'Sanal kâr/zarar', short: 'Kâr', what: 'Model piyasadan farklı düşündüğü maçlara oynansaydı kâr eder miydi? (kanıtlı kâr, kanıtlı zarar ya da kanıt yok)' },
  { key: 'xg', label: 'Şut bazlı beklenen gol', short: 'xG', what: 'Şut sayılarından hesaplanan beklenen gol modele katılınca tahmin düzeliyor mu?' },
  { key: 'half', label: 'İlk yarı gol payı', short: 'İlk yarı', what: 'Bu ligde goller ilk yarıda varsayılandan (%46) anlamlı farklı mı atılıyor?' },
  { key: 'rest', label: 'Dinlenme süresi', short: 'Dinlenme', what: 'Kısa dinlenen takım beklenenden az gol atıyor mu?' },
  { key: 'stakes', label: 'Motivasyon (işi bitmiş takım)', short: 'Motivasyon', what: 'Puan durumunda yeri değişmeyecek takımın golü değişiyor mu?' },
  { key: 'weather', label: 'Hava durumu', short: 'Hava', what: 'Sıcak, soğuk, yağmur ya da rüzgâr gol beklentisini değiştiriyor mu?' },
  { key: 'travel', label: 'Uzak deplasman ve derbi', short: 'Mesafe', what: 'Uzak (≥ 600 km) deplasmana giden takımın golü ya da aynı şehir derbilerindeki goller beklentiden farklı mı?' },
  { key: 'red', label: 'Kırmızı kartın canlı etkisi', short: 'Kırmızı', what: '10 kişi kalan takımın (ve rakibinin) kalan dakikalardaki golü değişiyor mu?' },
  { key: 'state', label: 'Skor durumu ve dakika (canlı)', short: 'Canlı', what: 'Önde ya da geride olan takım ve maçın dakikası, kalan dakikalardaki gol hızını değiştiriyor mu? Anlamlıysa canlı olasılıklar dakika dakika hesaplanır.' },
  { key: 'h2h', label: 'Karşılaşma geçmişi (H2H)', short: 'H2H', what: 'İki takımın önceki maçındaki sürpriz (modelin beklentisinden fazla/az gol farkı) sonraki maçın golünü etkiliyor mu? Yalnızca bilgi: tahmine katılmaz.' },
  { key: 'referee', label: 'Hakem etkisi (sarı kart)', short: 'Hakem', what: 'Hakem bilgisi sarı kart tahminini iyileştiriyor mu? (ESPN çoğu ligde hakem vermiyor)' },
  { key: 'absence', label: 'Kilit oyuncu eksikliği', short: 'Eksik', what: 'Golcü ya da savunma kilidi oyuncu yokken takımın golü değişiyor mu?' },
];
function analysisPeek(slug) {
  const hit = anMem.get(slug);
  if (hit) return hit.v;
  const c = U.diskGet('an', slug, 30 * 24 * HOUR);
  if (c.hit && c.d) { anMem.set(slug, { at: c.t, v: c.d }); return c.d; }
  return null;
}
// durum: ok = ölçüldü ve kullanılıyor, no = ölçüldü, anlamlı değil, bad = ölçüldü, kanıtlı olumsuz, na = ölçülemedi / veri yok
function measureCells(an) {
  const C = {};
  const bl = an.blend, bt = an.bets, xg = an.xg, hf = an.half, rs = an.rest, sk = an.stakes, wx = an.weather, tv = an.travel, rd = an.red, rf = an.referee, ab = an.absence, gs = an.state, h2 = an.h2h;
  C.blend = bl && bl.enough ? { s: bl.adopted ? 'ok' : 'no', t: (bl.adopted ? 'Karışım iyi' : 'Fark yok') + ' · z=' + bl.zVsModel.toFixed(1) } : { s: 'na', t: 'Oran verisi yok' };
  if (bt && bt.enough) {
    const v = (bt.rows || []).map((r) => r.verdict);
    C.bets = v.includes('profit') ? { s: 'ok', t: 'Kanıtlı kâr' } : v.includes('loss') ? { s: 'bad', t: 'Kanıtlı zarar' } : { s: 'no', t: 'Kanıt yok' };
  } else C.bets = { s: 'na', t: 'Oran verisi yok' };
  C.xg = xg && xg.enough ? { s: an.params && an.params.xgW > 0 ? 'ok' : 'no', t: an.params && an.params.xgW > 0 ? 'Modele katıldı' : 'Katılmadı' } : { s: 'na', t: 'Şut verisi yok' };
  C.half = hf && hf.enough ? { s: hf.significant ? 'ok' : 'no', t: 'Pay %' + Math.round(hf.applied * 100) } : { s: 'na', t: 'Az gol' };
  C.rest = rs && rs.enough ? { s: rs.significant ? 'ok' : 'no', t: rs.significant ? 'Anlamlı' : 'Anlamlı değil' } : { s: 'na', t: 'Veri yetersiz' };
  C.stakes = sk && sk.enough ? { s: sk.significant ? 'ok' : 'no', t: sk.significant ? 'Anlamlı' : 'Anlamlı değil' } : { s: 'na', t: sk && sk.reason ? 'Ölçülemedi' : 'Veri yetersiz' };
  C.weather = wx && wx.enough ? { s: (wx.feats || []).some((f) => f.adopted) ? 'ok' : 'no', t: (wx.feats || []).filter((f) => f.adopted).map((f) => f.label).join(', ') || 'Anlamlı değil' } : { s: 'na', t: wx && wx.reason ? 'Ölçülemedi' : 'Veri yetersiz' };
  C.travel = tv && tv.enough ? { s: (tv.feats || []).some((f) => f.adopted) ? 'ok' : 'no', t: (tv.feats || []).filter((f) => f.adopted).map((f) => f.key === 'derby' ? 'Derbi' : f.key === 'farAway' ? 'Uzak deplasman' : 'Uzak: ev sahibi').join(', ') || 'Anlamlı değil' } : { s: 'na', t: tv && tv.reason ? 'Ölçülemedi' : 'Veri yetersiz' };
  C.red = rd && rd.enough ? { s: rd.applied ? 'ok' : 'no', t: rd.applied ? 'Anlamlı' : 'Anlamlı değil' } : { s: 'na', t: 'Az kırmızı kart' };
  if (gs && gs.enough) { const pk = gsPick(an, gsPoolSummary()); C.state = pk.k ? { s: 'ok', t: 'Kullanılıyor (' + Object.keys(pk.k).length + ' etki)' } : { s: 'no', t: gs.test && gs.test.enough ? 'Anlamlı değil' : 'Anlamlı değil' }; } else C.state = { s: 'na', t: 'Az maç/gol dakikası' };
  C.h2h = h2 && h2.enough ? (h2.adopted ? { s: 'inf', t: 'Anlamlı (bilgi, tahmine katılmıyor)' } : { s: 'no', t: 'Anlamlı değil' }) : { s: 'na', t: 'Az tekrar maçı' };
  C.referee = rf && rf.enough ? { s: rf.adopted ? 'ok' : 'no', t: rf.adopted ? 'Anlamlı' : 'Anlamlı değil' } : { s: 'na', t: rf && rf.reason === 'nodata' ? 'Hakem verisi yok' : 'Veri yetersiz' };
  C.absence = ab && ab.enough ? { s: ab.significant ? 'ok' : 'no', t: ab.significant ? 'Anlamlı' : 'Anlamlı değil' } : { s: 'na', t: 'Kadro verisi yok' };
  return C;
}
function measureSummary(run) {
  const slugs = L.AVAILABLE.filter((x) => L.BY[x].kind === 'league');
  const rows = [];
  const missing = [];
  for (const slug of slugs) {
    const an = analysisPeek(slug);
    if (!an) { missing.push(slug); continue; }
    rows.push({ league: slug, name: L.BY[slug].name, country: L.BY[slug].country || '', at: an.at, matches: an.matches, cells: measureCells(an) });
  }
  // istenirse eksik liglerden birkaçının analizini arka planda başlat (aynı anda en çok 3 analiz)
  const n = Math.max(0, Math.min(3, Number(run) || 0));
  if (n) {
    let active = [...anJobs.values()].filter((j) => j.status === 'building').length;
    let started = 0;
    for (const slug of missing) {
      if (active >= 3 || started >= n) break;
      const j = anJobs.get(slug);
      if (j && (j.status === 'building' || (j.status === 'error' && Date.now() - j.at < 5 * 60000))) continue; // çalışan ya da az önce hata veren lig atlanır
      leagueAnalysis(slug); active++; started++;
    }
  }
  const building = [...anJobs.entries()].filter(([, j]) => j.status === 'building').map(([slug, j]) => ({ league: slug, name: (L.BY[slug] && L.BY[slug].name) || slug, done: j.done, total: j.total, phase: j.phase }));
  const totals = {};
  for (const m of MEASURES) totals[m.key] = { ok: 0, no: 0, bad: 0, inf: 0, na: 0 };
  for (const r of rows) for (const m of MEASURES) totals[m.key][r.cells[m.key].s]++;
  return { measures: MEASURES, rows: rows.sort((a, b) => (a.name < b.name ? -1 : 1)), totals, computed: rows.length, total: slugs.length, missing: missing.length, building, pools: { rest: restPoolSummary(), stakes: stakesPoolSummary(), weather: wxPoolSummary(), travel: tvPoolSummary(), red: rcPoolSummary(), state: gsPoolSummary(), h2h: h2PoolSummary() }, fd: FD.status(), at: Date.now() };
}

// Hesaplanmış analiz varsa verir (12 saatten eskiyse de kullanır, yenisini arka planda ister); yoksa ve istenirse arka planda başlatır (bekletmez)
function analysisIfReady(slug, start) {
  const hit = anMem.get(slug);
  if (hit) {
    if (start && Date.now() - hit.at > 12 * HOUR && !anJobs.has(slug)) leagueAnalysis(slug);
    return hit.v;
  }
  const miss = anMiss.get(slug);
  if (miss && Date.now() - miss < 60000 && !start) return null;
  const c = U.diskGet('an', slug, 14 * 24 * HOUR);
  if (c.hit && c.d) {
    anMem.set(slug, { at: c.t, v: c.d });
    if (start && Date.now() - c.t > 12 * HOUR && !anJobs.has(slug)) leagueAnalysis(slug);
    return c.d;
  }
  anMiss.set(slug, Date.now());
  if (start && !anJobs.has(slug)) leagueAnalysis(slug);
  return null;
}

// takımın son 30 maçındaki kadro geçmişi (en yenisi başta): [{players: Map(id -> {name, pos, starter, goals, assists})}]
const histCache = new Map();
async function teamHist(slug, tid) {
  const k = `${slug}:${tid}`;
  const hit = histCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.v;
  const sch = await teamSchedule(slug, tid);
  if (!sch) return [];
  const fin = sch.finished.slice(0, 30);
  const recs = await Promise.all(fin.map((e) => matchRecord(slug, e.id, { bg: true }).catch(() => null)));
  const out = [];
  for (const rec of recs) {
    const ro = rec && rec.rosters && rec.rosters.find((r) => r.teamId === tid);
    if (!ro || ro.players.length < 11) continue;
    const m = new Map();
    for (const p of ro.players) if (AB.played(p)) m.set(p.id, { name: p.name, pos: p.pos, starter: p.starter, goals: (p.stats && p.stats.totalGoals) || 0, assists: (p.stats && p.stats.goalAssists) || 0 });
    if (m.size >= 11) out.push({ players: m });
  }
  if (histCache.size > 600) histCache.clear();
  histCache.set(k, { at: Date.now(), v: out });
  return out;
}
// açıklanan kadro: her takım için {squad:Set, starters:Set}; ilk 11'i (en az 11 ilk 11 oyuncusu) iki takımda da bilinmiyorsa null
function lineupOf(rec) {
  const side = (tid) => {
    const ro = (rec.rosters || []).find((r) => String(r.teamId) === String(tid));
    if (!ro) return null;
    const st = ro.players.filter((p) => p.starter);
    if (st.length < 11) return null;
    return { squad: new Set(ro.players.map((p) => p.id)), starters: new Set(st.map((p) => p.id)), names: new Map(ro.players.map((p) => [p.id, p.name])) };
  };
  const h = side(rec.home.id), a = side(rec.away.id);
  return h && a ? { home: h, away: a } : null;
}

// ---------- eksik oyuncu ve dinlenmeye göre ayarlı tahmin ----------
async function predictAdj(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  if (rec.status.state !== 'pre') return { applicable: false, state: rec.status.state };
  analysisIfReady(slug, true);
  // dinlenme
  let rest = null;
  try {
    const rt = await restTimes(slug, 2);
    const t = Date.parse(rec.date);
    const rh = RS.restDays(rt.times.get(rec.home.id), t), ra = RS.restDays(rt.times.get(rec.away.id), t);
    const rp = restParams(slug);
    const anyShort = RS.isShort(rh) || RS.isShort(ra);
    let reason;
    if (rp.k && rp.source === 'league') reason = `Bu ligin ${Math.round(rp.est.n)} maçında ölçüldü ve anlamlı bulundu.`;
    else if (rp.k && rp.source === 'pool') reason = `Bu ligde tek başına anlamlı çıkmadı, ama analiz edilen ${rp.pool.leagues} ligin birleşik ölçümünde anlamlı bulundu.`;
    else if (!rp.ready) reason = 'Bu lig için dinlenme etkisi henüz ölçülmedi (arka planda hesaplanıyor), tahmine katılmadı.';
    else if (rp.est && !rp.est.enough) reason = 'Bu ligde kısa dinlenmeli yeterli maç yok, etki ölçülemedi; tahmine katılmadı.';
    else reason = 'Bu ligin geçmiş maçlarında kısa dinlenmenin gol beklentisine etkisi anlamlı çıkmadı, tahmine katılmadı.';
    rest = {
      home: { days: rh, short: RS.isShort(rh) }, away: { days: ra, short: RS.isShort(ra) },
      applied: !!rp.k && anyShort, source: rp.source, params: rp.k, reason, anyShort,
      factors: rp.k ? RS.factors(rp.k, rh, ra) : { home: 1, away: 1 },
    };
  } catch (e) { U.log('dinlenme bilgisi hatası', slug, e.message); }
  // motivasyon: puan durumunda yeri belli takımlar
  let stk = null;
  try {
    const tr = await training(slug);
    const ctx = await stakesCtx(slug, tr);
    const cur = ctx.current;
    const sh = cur && cur.now.get(rec.home.id), sa = cur && cur.now.get(rec.away.id);
    if (sh && sa) {
      const sp = stakesParams(slug);
      const anyS = sh.settled || sa.settled;
      let reason;
      if (sp.k && sp.source === 'league') reason = `Bu ligin ${Math.round(sp.est.n)} maçında ölçüldü ve anlamlı bulundu.`;
      else if (sp.k && sp.source === 'pool') reason = `Bu ligde tek başına anlamlı çıkmadı, ama analiz edilen ${sp.pool.leagues} ligin birleşik ölçümünde anlamlı bulundu.`;
      else if (!sp.ready) reason = 'Bu lig için motivasyon etkisi henüz ölçülmedi (arka planda hesaplanıyor), tahmine katılmadı.';
      else if (sp.est && !sp.est.enough) reason = 'Bu ligin geçmişinde "işi bitmiş" takım-maç sayısı ölçüm için yetersiz, tahmine katılmadı.';
      else reason = 'Bu ligin geçmiş maçlarında "işi bitmiş" takımların gol beklentisi anlamlı değişmedi, tahmine katılmadı.';
      stk = {
        home: { settled: sh.settled, remaining: sh.remaining, points: sh.points }, away: { settled: sa.settled, remaining: sa.remaining, points: sa.points },
        anyStakes: anyS, applied: !!sp.k && anyS, source: sp.source, params: sp.k, reason,
        factors: sp.k ? ST.factors(sp.k, sh.settled, sa.settled) : { home: 1, away: 1 },
      };
    }
  } catch (e) { U.log('motivasyon bilgisi hatası', slug, e.message); }
  // hava durumu (maç saatindeki tahmin)
  let wx = null;
  try {
    const wm = await weatherForMatch(slug, rec);
    if (wm) {
      const wp = wxParams(slug);
      const names = WX.FEATS.filter((f, j) => wm.fl[j]);
      const used = names.filter((f) => wp.k && wp.k[f.key] != null);
      wx = {
        city: wm.city, t: wm.w.t, rain: wm.w.p, wind: wm.w.w, flags: names.map((f) => ({ key: f.key, label: f.label, applied: !!(wp.k && wp.k[f.key] != null), source: wp.src[f.key] || null, beta: wp.k && wp.k[f.key] != null ? wp.k[f.key] : null })),
        anyFlag: names.length > 0, applied: used.length > 0, ready: wp.ready, factor: wp.k ? WX.factor(wp.k, wm.fl) : 1,
      };
    }
  } catch (e) { U.log('hava bilgisi hatası', slug, e.message); }
  // uzak deplasman ve derbi
  let tvx = null;
  try {
    const tr = travelForMatch(slug, rec);
    if (tr) {
      const tp = tvParams(slug);
      const fl = TV.flagsOf(tr);
      const used = fl.filter((f) => tp.k && tp.k[f.key] != null);
      let reason;
      if (!fl.length) reason = null;
      else if (used.length) reason = tp.src[used[0].key] === 'league' ? `Bu ligin ${Math.round(tp.est.n)} maçında ölçüldü ve anlamlı bulundu.` : `Bu ligde tek başına anlamlı çıkmadı, ama analiz edilen ${tp.pool[used[0].key].leagues} ligin birleşik ölçümünde anlamlı bulundu.`;
      else if (!tp.ready) reason = 'Bu lig için mesafe etkisi henüz ölçülmedi (arka planda hesaplanıyor), tahmine katılmadı.';
      else if (tp.est && !tp.est.enough) reason = 'Bu ligde uzak deplasman/derbi maçı ölçüm için yetersiz ya da şehir koordinatları alınamadı; tahmine katılmadı.';
      else reason = 'Bu ligin geçmiş maçlarında mesafe/derbi etkisi anlamlı çıkmadı, tahmine katılmadı.';
      tvx = {
        km: Math.round(tr.km), far: tr.far, derby: tr.derby, cityHome: tr.cityHome, cityAway: tr.cityAway,
        flags: fl.map((f) => ({ key: f.key, label: f.label, applied: !!(tp.k && tp.k[f.key] != null), source: tp.src[f.key] || null, beta: tp.k && tp.k[f.key] != null ? tp.k[f.key] : null })),
        anyFlag: fl.length > 0, applied: used.length > 0, ready: tp.ready, reason,
        factors: tp.k ? TV.factors(tp.k, tr) : { home: 1, away: 1 },
      };
    }
  } catch (e) { U.log('mesafe bilgisi hatası', slug, e.message); }
  // eksik oyuncular: ilk 11 açıklandıysa gerçek kadroya göre, açıklanmadıysa ESPN'in sakat/cezalı listesine göre
  let abs = null, lineup = { known: false, used: false, cleared: [] };
  try {
    const [th, ta] = await Promise.all([teamData(slug, rec.home.id), teamData(slug, rec.away.id)]);
    const lu = lineupOf(rec);
    lineup.known = !!lu;
    let mh = null, ma = null, fromLineup = false;
    if (lu) {
      const [hh, ha] = await Promise.all([teamHist(slug, rec.home.id), teamHist(slug, rec.away.id)]);
      const lh = AB.lineupMiss(hh, lu.home.squad, lu.home.starters), la = AB.lineupMiss(ha, lu.away.squad, lu.away.starters);
      if (lh && la) { mh = lh; ma = la; fromLineup = true; lineup.used = true; }
    }
    if (th && ta) {
      const inj = (tid, td) => {
        const own = (rec.injuries || []).filter((x) => x.teamId === tid);
        return own.length ? own : td.injuries || [];
      };
      const ih = AB.currentMiss(th, inj(rec.home.id, th)), ia = AB.currentMiss(ta, inj(rec.away.id, ta));
      if (!fromLineup) { mh = ih; ma = ia; }
      else {
        // sakat listesinde görünüp ilk 11'de başlayanlar: uyarı gereksiz
        const starting = (lineupSide, injs) => (injs.absent || []).filter((p) => [...lineupSide.starters].some((pid) => AB.sameName(lineupSide.names.get(pid), p.name))).map((p) => p.name);
        lineup.cleared = [...starting(lu.home, ih), ...starting(lu.away, ia)];
      }
    }
    if (mh && ma && (mh.absent.length || ma.absent.length)) {
      const an = analysisIfReady(slug, true);
      const ab = an && an.absence;
      let source = 'prior', reason = 'Bu lig için ölçüm henüz yapılmadı (arka planda hesaplanıyor), varsayılan etki kullanıldı.';
      let k = AB.DEFAULT_K;
      if (ab && ab.enough) {
        if (ab.significant && ab.applied) { source = 'validated'; k = ab.applied; reason = 'Bu ligin ' + ab.n / 2 + ' maçında ölçüldü ve anlamlı bulundu.'; }
        else { source = 'prior'; reason = 'Bu ligin geçmiş maçlarında etki anlamlı çıkmadı, varsayılan etki gösteriliyor. Sadece bilgi içindir.'; }
      } else if (an) reason = 'Bu lig için yeterli kadro verisi yok, varsayılan etki kullanıldı.';
      abs = { mh, ma, k, source, reason, f: AB.factors(k, mh, ma), fromLineup };
    }
  } catch (e) { U.log('eksik oyuncu bilgisi hatası', slug, e.message); }
  // hakem (ESPN vermiyorsa null)
  let refx = null;
  try {
    if (rec.referee) {
      const an = analysisIfReady(slug, true);
      const ra = an && an.referee;
      const r = RF.lookup(ra, rec.referee);
      const ready = !!(ra && ra.enough);
      refx = { name: rec.referee, src: rec.refSrc || 'ESPN', ready, n: r ? r.n : 0, ratio: r ? r.ratio : null, avg: r && r.avg != null ? r.avg : null, adopted: !!(ready && ra.adopted), z: ready ? ra.z : null, nTest: ready ? ra.nTest : null };
      refx.applied = !!(refx.adopted && r && r.n >= RF.MIN_PRIOR);
      refx.reason = refx.applied ? `Bu ligin ${ra.nTest} maçlık yürüyen testinde hakem bilgisi kart tahminini anlamlı iyileştirdi (z=${ra.z.toFixed(1)}).`
        : !ready ? 'Bu lig için hakem etkisi henüz ölçülmedi ya da ölçüm için yeterli hakemli maç yok; kart tahminine katılmadı.'
          : !ra.adopted ? `Bu ligin yürüyen testinde hakem bilgisi kart tahminini anlamlı iyileştirmedi (z=${ra.z.toFixed(1)}), kart tahminine katılmadı.`
            : 'Bu hakemin ligde yeterli maçı yok (en az ' + RF.MIN_PRIOR + '), kart tahminine katılmadı.';
      if (refx.ready) {
        const [hl, al] = await Promise.all([teamSpList(slug, rec.home.id), teamSpList(slug, rec.away.id)]);
        const ex = SP.expected(hl, al);
        if (ex) { refx.cards = { base: ex.cards.t, adjusted: refx.applied ? ex.cards.t * refx.ratio : null }; }
      }
    }
  } catch (e) { U.log('hakem bilgisi hatası', slug, e.message); }
  const anyAbs = !!abs, anyRest = !!(rest && rest.anyShort), anyStakes = !!(stk && stk.anyStakes), anyWx = !!(wx && wx.anyFlag), anyTv = !!(tvx && tvx.anyFlag);
  if (!anyAbs && !anyRest && !anyStakes && !anyWx && !anyTv) return { applicable: true, any: false, anyRest: false, anyStakes: false, anyWx: false, anyTv: false, rest, stakes: stk, weather: wx, travel: tvx, referee: refx, lineup };
  const fa = abs ? abs.f : { home: 1, away: 1 }, fr = rest && rest.applied ? rest.factors : { home: 1, away: 1 }, fs = stk && stk.applied ? stk.factors : { home: 1, away: 1 }, fw = wx && wx.applied ? wx.factor : 1, ft = tvx && tvx.applied ? tvx.factors : { home: 1, away: 1 };
  const f = { home: fa.home * fr.home * fs.home * fw * ft.home, away: fa.away * fr.away * fs.away * fw * ft.away };
  const adjusts = anyAbs || (rest && rest.applied) || (stk && stk.applied) || (wx && wx.applied) || (tvx && tvx.applied);
  let base = null, adjusted = null;
  if (adjusts) {
    const pick = (p) => ({ home: p.markets.home, draw: p.markets.draw, away: p.markets.away, over25: p.markets.over['2.5'], over15: p.markets.over['1.5'], btts: p.markets.btts, top: p.markets.topScores[0] ? p.markets.topScores[0].s : null, lh: p.lambdaHome, la: p.lambdaAway });
    base = pick(await predictFromRec(slug, rec));
    adjusted = pick(await predictFromRec(slug, rec, f));
  }
  return {
    applicable: true, any: anyAbs, anyRest, anyStakes, anyWx, anyTv, adjusts,
    home: abs ? abs.mh : { absent: [], att: 0, def: 0 }, away: abs ? abs.ma : { absent: [], att: 0, def: 0 },
    factors: f,
    params: abs ? { att: abs.k.att, def: abs.k.def, source: abs.source, reason: abs.reason } : null,
    rest, stakes: stk, weather: wx, travel: tvx, referee: refx, lineup, base, adjusted,
  };
}

module.exports = {
  matchesFor, matchDetail, matchRecord, h2hFor, oddsMoveFor, resultsFor, predict, liveData, matchupTeams, propsFor, todayTable, backtestLeague, backtestSummary, standings, teamData, playerData, matchPlayers,
  leadersState, search, startIndex, searchIdx, training, posGroup, leagueTable, leagueDetail, leagueAnalysis, measureSummary, predictAdj, spToday, tieInfo,
};
