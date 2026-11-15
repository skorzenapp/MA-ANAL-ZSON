'use strict';
// Veri katmanı: maç kayıtları, takım/oyuncu/lider verileri, tahmin, karne, arama dizini.
const U = require('./util');
const E = require('./espn');
const L = require('./leagues');
const M = require('./model');

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
  const today = U.ymd(new Date());
  const yest = U.ymd(U.addDays(new Date(), -2));
  if (dayStr < yest) return 12 * HOUR;
  if (dayStr <= U.ymd(U.addDays(new Date(), 1))) return 60000;
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
    const v = { matches: uniq, own, pooled: !!L.poolOf(slug), poolSize: used };
    trainCache.set(slug, { at: Date.now(), v });
    return v;
  });
}

const fitCache = new Map();
async function modelFor(slug, cutoff) {
  const tr = await training(slug);
  const dayKey = Math.floor(cutoff / (6 * HOUR));
  const k = `${slug}:${dayKey}`;
  let f = fitCache.get(k);
  if (!f || f.tr !== tr) {
    if (fitCache.size > 200) fitCache.clear();
    f = { tr, mdl: M.fit(tr.matches, cutoff) };
    fitCache.set(k, f);
  }
  return { mdl: f.mdl, tr };
}

async function predict(slug, id) {
  const rec = await matchRecord(slug, id);
  if (!rec) throw Object.assign(new Error('Maç bulunamadı'), { status: 404 });
  const done = rec.status.state === 'post';
  const cutoff = done ? Date.parse(rec.date) : Date.now();
  const { mdl, tr } = await modelFor(slug, cutoff);
  if (!mdl.ok) throw Object.assign(new Error('Bu turnuva için yeterli geçmiş maç verisi yok'), { status: 422 });
  const hid = rec.home.id, aid = rec.away.id;
  if (mdl.games(hid) < 1 || mdl.games(aid) < 1) throw Object.assign(new Error('Takımlardan biri için geçmiş maç verisi bulunamadı'), { status: 422 });
  const neutral = L.NEUTRAL.has(slug) || rec.neutral;
  const r = M.matchup(mdl, hid, aid, { neutral, comp: slug });
  const side = (tid) => ({ att: mdl.att(tid), def: mdl.def(tid), rank: mdl.rank(tid) || mdl.teams, form: mdl.form(tid), games: mdl.games(tid) });
  return {
    markets: r.markets,
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
    },
  };
}

// ---------- karne ----------
const btCache = new Map();
async function backtestLeague(slug) {
  const hit = btCache.get(slug);
  if (hit && Date.now() - hit.at < 6 * HOUR) return hit.v;
  return U.once('bt:' + slug, async () => {
    const tr = await training(slug);
    const r = M.backtest(tr.matches, { now: Date.now(), ownComp: slug });
    const v = { league: slug, pooled: tr.pooled, ...r };
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
    btSummary.total = L.AVAILABLE.length;
    const rows = [];
    (async () => {
      for (const slug of L.AVAILABLE) {
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
        await eachLimit(arr, 5, async (x) => {
          const t = x.team;
          try {
            const r = await E.teamRosterRaw(slug, t.id);
            let ath = (r && r.athletes) || [];
            if (ath[0] && ath[0].items) ath = ath.flatMap((g) => g.items || []);
            for (const a of ath) {
              const name = a.displayName || a.fullName;
              if (!name) continue;
              items.push({ id: String(a.id), name, norm: U.norm(name), teamId: String(t.id), team: t.displayName, teamLogo: E.logoOf(t), league: slug, pos: (a.position && a.position.abbreviation) || '' });
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
  const out = [];
  for (const it of searchIdx.items) {
    if (!toks.every((t) => it.norm.includes(t))) continue;
    let score = 0;
    if (it.norm === nq) score = 100;
    else if (it.norm.startsWith(nq)) score = 80;
    else if (it.norm.split(' ').some((w) => w.startsWith(toks[0]))) score = 60;
    else score = 30;
    out.push({ it, score: score - it.norm.length * 0.05 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 12).map(({ it }) => ({ id: it.id, name: it.name, teamId: it.teamId, team: it.team, teamLogo: it.teamLogo, league: it.league, pos: it.pos }));
}

module.exports = {
  matchesFor, matchDetail, matchRecord, predict, backtestLeague, backtestSummary, standings, teamData, playerData, matchPlayers,
  leadersState, search, startIndex, searchIdx, training, posGroup,
};
