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
  return { events, errors };
}

// ---------- maç kaydı ----------
async function matchRecord(slug, id, { bg = false } = {}) {
  const key = `${slug}:${id}`;
  const c = U.diskGet('r', key, Infinity);
  if (c.hit && c.d) return c.d;
  const mk = 'rec:' + key;
  const m = U.memGet(mk);
  if (m) return m;
  return U.once(mk, async () => {
    const raw = await E.summaryRaw(slug, id, { ttl: 30000, bg });
    if (!raw) return null;
    const rec = E.parseSummary(raw, slug, id);
    if (!rec) return null;
    const st = rec.status.state;
    if (st === 'post' && rec.status.completed) U.diskSet('r', key, rec);
    else U.memSet(mk, rec, st === 'in' ? 25000 : 10 * 60000);
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
const paramsOf = (tp) => (tp ? { halfLife: tp.halfLife, prior: tp.prior, xgW: tp.xgW || 0 } : { ...M.DEFAULT_PARAMS, xgW: 0 });
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
    for (const ps of pool) {
      let got = 0;
      let failed = false;
      await Promise.all(
        months.map(async (mo) => {
          try {
            const evs = await E.scoreboardMonth(ps, mo, { ttl: mo === cur || mo === prev ? 20 * 60000 : 24 * HOUR, bg: ps !== slug });
            for (const e of evs) {
              if (!e.status.completed || e.home.score == null || e.away.score == null) continue;
              got++;
              matches.push({ id: e.id, t: Date.parse(e.date), h: e.home.id, a: e.away.id, hg: e.home.score, ag: e.away.score, c: ps, neutral: e.neutral || L.NEUTRAL.has(ps), hn: e.home.name, an: e.away.name });
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
    const v = { matches: uniq, own, pooled: !!L.poolOf(slug), poolSize: used, xgVer: xi ? xi.at : 0, xgN };
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
  const k = `${slug}:${Math.floor(cutoff / (6 * HOUR))}:${params.halfLife}:${params.prior}:${params.xgW}`;
  let f = fitCache.get(k);
  if (!f || f.tr !== tr) {
    if (fitCache.size > 200) fitCache.clear();
    f = { tr, mdl: M.fit(tr.matches, cutoff, { halfLife: params.halfLife, prior: params.prior, xgW: params.xgW }) };
    fitCache.set(k, f);
  }
  return { mdl: f.mdl, tr, params, tp };
}

async function predict(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  analysisIfReady(slug, true); // ilk yarı payı, şut verisi ve dinlenme etkisi için lig analizi arka planda hazırlanır
  return predictFromRec(slug, rec);
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
      halfShare: { value: share, measured: !!half, raw: half ? half.raw : null, goals: half ? half.goals : 0 },
    },
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
  return { state: 'in', clock: st.clock, live, pre: { home: r.markets.home, draw: r.markets.draw, away: r.markets.away } };
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
    for (const m of trn.matches) { if (seen.has(m.id)) continue; seen.add(m.id); add(m.h, m.t); add(m.a, m.t); }
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

async function runAnalysis(slug, job) {
  const tr0 = await training(slug);
  const own = tr0.matches.filter((m) => m.c === slug).sort((a, b) => b.t - a.t).slice(0, ANALYSIS_N).sort((a, b) => a.t - b.t);
  job.total = own.length; job.done = 0; job.phase = 'read';
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
    spRecs.push({ t: m.t, h: m.h, a: m.a, sp: { c, ca, y, ya } });
  });
  const sp = spRecs.length >= 40 ? SP.backtestSp(spRecs) : { n: spRecs.length, enough: false };

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
  const items = [];
  const WK = 7 * DAY;
  for (let s0 = own[0].t + 21 * DAY; s0 <= own[own.length - 1].t + WK; s0 += WK) {
    const idxs = [];
    own.forEach((m, i) => { if (m.t >= s0 && m.t < s0 + WK) idxs.push(i); });
    if (!idxs.length) continue;
    await tickS();
    const mdl = M.fit(tr.matches, s0, { halfLife: params.halfLife, prior: params.prior, iters: 40, xgW: params.xgW });
    if (!mdl.ok) continue;
    for (const i of idxs) {
      const m = own[i];
      if (mdl.games(m.h) < 3 || mdl.games(m.a) < 3) continue;
      const r = M.matchup(mdl, m.h, m.a, { neutral: m.neutral, comp: m.c });
      lam.set(m.id, [r.lambdaHome, r.lambdaAway]);
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

  return { league: slug, at: Date.now(), matches: own.length, sp, absence, params, xg, half, markets, rest };
}

function leagueAnalysis(slug) {
  const hit = anMem.get(slug);
  if (hit && Date.now() - hit.at < 12 * HOUR) return { status: 'ready', ...hit.v, restPool: restPoolSummary() };
  const c = U.diskGet('an', slug, 12 * HOUR);
  if (c.hit && c.d) { anMem.set(slug, { at: c.t, v: c.d }); return { status: 'ready', ...c.d, restPool: restPoolSummary() }; }
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
  // eksik oyuncular
  let abs = null;
  try {
    const [th, ta] = await Promise.all([teamData(slug, rec.home.id), teamData(slug, rec.away.id)]);
    if (th && ta) {
      const inj = (tid, td) => {
        const own = (rec.injuries || []).filter((x) => x.teamId === tid);
        return own.length ? own : td.injuries || [];
      };
      const mh = AB.currentMiss(th, inj(rec.home.id, th)), ma = AB.currentMiss(ta, inj(rec.away.id, ta));
      if (mh.absent.length || ma.absent.length) {
        const an = analysisIfReady(slug, true);
        const ab = an && an.absence;
        let source = 'prior', reason = 'Bu lig için ölçüm henüz yapılmadı (arka planda hesaplanıyor), varsayılan etki kullanıldı.';
        let k = AB.DEFAULT_K;
        if (ab && ab.enough) {
          if (ab.significant && ab.applied) { source = 'validated'; k = ab.applied; reason = 'Bu ligin ' + ab.n / 2 + ' maçında ölçüldü ve anlamlı bulundu.'; }
          else { source = 'prior'; reason = 'Bu ligin geçmiş maçlarında etki anlamlı çıkmadı, varsayılan etki gösteriliyor. Sadece bilgi içindir.'; }
        } else if (an) reason = 'Bu lig için yeterli kadro verisi yok, varsayılan etki kullanıldı.';
        abs = { mh, ma, k, source, reason, f: AB.factors(k, mh, ma) };
      }
    }
  } catch (e) { U.log('eksik oyuncu bilgisi hatası', slug, e.message); }
  const anyAbs = !!abs, anyRest = !!(rest && rest.anyShort);
  if (!anyAbs && !anyRest) return { applicable: true, any: false, anyRest: false, rest };
  const fa = abs ? abs.f : { home: 1, away: 1 }, fr = rest && rest.applied ? rest.factors : { home: 1, away: 1 };
  const f = { home: fa.home * fr.home, away: fa.away * fr.away };
  const adjusts = anyAbs || (rest && rest.applied);
  let base = null, adjusted = null;
  if (adjusts) {
    const pick = (p) => ({ home: p.markets.home, draw: p.markets.draw, away: p.markets.away, over25: p.markets.over['2.5'], over15: p.markets.over['1.5'], btts: p.markets.btts, top: p.markets.topScores[0] ? p.markets.topScores[0].s : null, lh: p.lambdaHome, la: p.lambdaAway });
    base = pick(await predictFromRec(slug, rec));
    adjusted = pick(await predictFromRec(slug, rec, f));
  }
  return {
    applicable: true, any: anyAbs, anyRest, adjusts,
    home: abs ? abs.mh : { absent: [], att: 0, def: 0 }, away: abs ? abs.ma : { absent: [], att: 0, def: 0 },
    factors: f,
    params: abs ? { att: abs.k.att, def: abs.k.def, source: abs.source, reason: abs.reason } : null,
    rest, base, adjusted,
  };
}

module.exports = {
  matchesFor, matchDetail, matchRecord, predict, liveData, matchupTeams, propsFor, todayTable, backtestLeague, backtestSummary, standings, teamData, playerData, matchPlayers,
  leadersState, search, startIndex, searchIdx, training, posGroup, leagueTable, leagueDetail, leagueAnalysis, predictAdj, spToday,
};
