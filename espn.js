'use strict';
// ESPN açık veri istemcisi + yanıtları arayüzün beklediği biçime çeviren fonksiyonlar.
const U = require('./util');

const SITE = (process.env.ESPN_SITE || 'https://site.api.espn.com').replace(/\/$/, '');
const CORE = (process.env.ESPN_CORE || 'https://sports.core.api.espn.com').replace(/\/$/, '');
const WEB = (process.env.ESPN_WEB || 'https://site.web.api.espn.com').replace(/\/$/, '');

const fgLimiter = new U.Limiter(Number(process.env.FG_CONCURRENCY || 8));
const bgLimiter = new U.Limiter(Number(process.env.BG_CONCURRENCY || 6));

const stats = { calls: 0, cached: 0, errors: 0 };
// Kaynak tamamen erişilemezse (art arda hata) tekrar denemeyi bırak: ekran dakikalarca donmasın
const health = { fails: 0, lastOk: Date.now() };
const outage = () => health.fails >= 8 && Date.now() - health.lastOk > 20000;

// ttl: disk/bellek önbellek süresi (ms). neg: 404/400 yanıtı için süre.
async function getJSON(url, { ttl = 600000, neg = 600000, bg = false, retries = 3, disk } = {}) {
  if (disk === undefined) disk = ttl > 120000;
  const mk = 'm:' + url;
  const m = U.memGet(mk);
  if (m !== undefined) { stats.cached++; return m.d; }
  if (disk) {
    const c = U.diskGet('c', url, ttl);
    if (c.hit) { stats.cached++; return c.d; }
  }
  return U.once('f:' + url, async () => {
    const lim = bg ? bgLimiter : fgLimiter;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await lim.run(async () => {
          stats.calls++;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MacAnaliz/1.0)', Accept: 'application/json' },
            signal: AbortSignal.timeout(25000),
          });
          if (res.status === 400 || res.status === 404) return { none: true };
          if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
          if (!res.ok) return { none: true };
          return { d: await res.json() };
        });
        health.fails = 0; health.lastOk = Date.now();
        if (r.none) {
          if (disk) U.diskSet('c', url, null);
          U.memSet(mk, { d: null }, Math.min(neg, 600000));
          return null;
        }
        if (disk) U.diskSet('c', url, r.d);
        // küçük bellek önbelleği: sadece kısa süreli
        if (JSON.stringify(r.d).length < 60000) U.memSet(mk, { d: r.d }, Math.min(ttl, 120000));
        return r.d;
      } catch (e) {
        lastErr = e;
        stats.errors++;
        health.fails++;
        if (outage()) break;
        await U.sleep(400 * 2 ** i + Math.random() * 300);
      }
    }
    // ağ hatası: eski (süresi dolmuş) disk kaydı varsa onu kullan
    const stale = U.diskGet('c', url, Infinity);
    if (stale.hit && stale.d) return stale.d;
    throw lastErr || new Error('fetch failed');
  });
}

// ---------- yardımcılar ----------
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object') v = v.value ?? v.displayValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const truthy = (v) => v === true || (v && typeof v === 'object' && v.didSub !== false);
const logoOf = (t) => (t && (t.logo || (t.logos && t.logos[0] && t.logos[0].href))) || null;
const recOf = (c) => {
  const r = c.records || c.record;
  if (Array.isArray(r) && r.length) {
    const tot = r.find((x) => x.type === 'total') || r[0];
    return tot.summary || tot.displayValue || null;
  }
  return null;
};

function teamObj(c) {
  const t = c.team || {};
  return {
    id: String(t.id != null ? t.id : c.id),
    name: t.displayName || t.name || t.location || '?',
    short: t.shortDisplayName || t.displayName || t.name || '?',
    abbr: t.abbreviation || (t.shortDisplayName || t.name || '?').slice(0, 3).toUpperCase(),
    logo: logoOf(t),
    score: num(c.score),
    winner: !!c.winner,
    record: recOf(c),
    form: typeof c.form === 'string' ? c.form : null,
  };
}

function statusOf(st) {
  st = st || {};
  const t = st.type || {};
  return {
    state: t.state || 'pre',
    name: t.name || '',
    clock: t.state === 'in' ? st.displayClock || t.shortDetail || null : null,
    completed: !!t.completed,
  };
}

// scoreboard / schedule olayını sadeleştir
function normEvent(ev, slug) {
  const comp = (ev.competitions || [])[0] || {};
  const cs = comp.competitors || [];
  const hc = cs.find((c) => c.homeAway === 'home') || cs[0];
  const ac = cs.find((c) => c.homeAway === 'away') || cs[1];
  if (!hc || !ac) return null;
  const venue = comp.venue || {};
  // iki maçlı tur bilgisi (ESPN: leg, series) ve tur adı (season.slug)
  const ser = comp.series || ev.series || null;
  const legO = comp.leg || ev.leg || null;
  return {
    id: String(ev.id),
    league: (ev.league && ev.league.slug) || slug,
    date: new Date(ev.date || comp.date).toISOString(),
    status: statusOf(comp.status || ev.status),
    home: teamObj(hc),
    away: teamObj(ac),
    venue: venue.fullName || null,
    city: venue.address ? venue.address.city || null : null,
    country: venue.address ? venue.address.country || null : null,
    neutral: !!comp.neutralSite,
    odds: comp.odds || null,
    leg: legO && legO.value != null ? Number(legO.value) : null,
    series: ser ? { title: ser.title || null, completed: !!ser.completed, total: ser.totalCompetitions != null ? Number(ser.totalCompetitions) : null, agg: Object.fromEntries((ser.competitors || []).map((c) => [String(c.id), num(c.aggregateScore)])) } : null,
    round: (ev.season && ev.season.slug) || null,
  };
}

// ---------- uç noktalar ----------
async function scoreboardDay(slug, d, { ttl, bg } = {}) {
  const j = await getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${d}&limit=300`, { ttl: ttl || 300000, bg });
  return ((j && j.events) || []).map((e) => normEvent(e, slug)).filter(Boolean);
}
async function scoreboardMonth(slug, ymStr, { ttl, bg } = {}) {
  const j = await getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymStr}&limit=1000`, { ttl: ttl || 3600000, bg });
  return ((j && j.events) || []).map((e) => normEvent(e, slug)).filter(Boolean);
}
async function summaryRaw(slug, id, { ttl, bg } = {}) {
  return getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/summary?event=${id}`, { ttl: ttl || 120000, bg, disk: false });
}
async function standingsRaw(slug) {
  return getJSON(`${SITE}/apis/v2/sports/soccer/${slug}/standings`, { ttl: 1800000 });
}
async function scheduleRaw(slug, teamId, season, { ttl, bg } = {}) {
  const q = season ? `?season=${season}` : '';
  return getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule${q}`, { ttl: ttl || 900000, bg });
}
async function teamsListRaw(slug) {
  return getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/teams?limit=200`, { ttl: 86400000, bg: true });
}
async function teamRosterRaw(slug, teamId) {
  return getJSON(`${SITE}/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/roster`, { ttl: 86400000, bg: true });
}
async function rosterStatsRaw(slug, eventId, teamId, playerId, { bg, ttl } = {}) {
  const u = `${CORE}/v2/sports/soccer/leagues/${slug}/events/${eventId}/competitions/${eventId}/competitors/${teamId}/roster/${playerId}/statistics/0?lang=en&region=us`;
  return getJSON(u, { ttl: ttl || 30 * 86400000, neg: ttl || 30 * 86400000, bg, retries: 2 });
}
async function athleteRaw(id) {
  return getJSON(`${CORE}/v2/sports/soccer/athletes/${id}?lang=en&region=us`, { ttl: 7 * 86400000 });
}

// ---------- oyuncu istatistik eşlemesi (ESPN adı -> arayüz anahtarı) ----------
const DETAIL_MAP = {
  min: 'minutes', goals: 'totalGoals', assists: 'goalAssists', shots: 'totalShots', sot: 'shotsOnTarget',
  xg: 'expectedGoals', xa: 'expectedAssists', keyPasses: 'shotAssists', bigChances: 'bigChanceCreated',
  touchesBox: 'touchesInOppBox', offsides: 'offsides',
  passes: 'totalPasses', accPasses: 'accuratePasses', longBalls: 'totalLongBalls', accLongBalls: 'accurateLongBalls',
  crosses: 'totalCrosses', accCrosses: 'accurateCrosses', finalThird: 'successfulFinalThirdPasses', throughBalls: 'accurateThroughBalls',
  dribbles: 'totalContest', dribblesWon: 'wonContest', progCarries: 'progressiveCarries', touches: 'touches',
  lostBall: 'turnover', fouled: 'foulsSuffered',
  tackles: 'totalTackles', tacklesWon: 'effectiveTackles', interceptions: 'interceptions', clearances: 'totalClearance',
  blocks: 'outfielderBlock', recoveries: 'ballRecovery', duelsWon: 'duelsWon', duels: 'duels', aerialsWon: 'aerialsWon',
  fouls: 'foulsCommitted', yc: 'yellowCards', rc: 'redCards',
  saves: 'saves', conceded: 'goalsConceded', xgPrevented: 'expectedGoalsPrevented', cleanSheets: 'cleanSheet',
};
// bu anahtarlar zengin veri kaynağından gelir (yoksa "takip edilmiyor" sayılır)
const RICH = ['xg', 'xa', 'keyPasses', 'bigChances', 'touchesBox', 'passes', 'accPasses', 'longBalls', 'accLongBalls', 'crosses', 'accCrosses', 'finalThird',
  'throughBalls', 'dribbles', 'dribblesWon', 'progCarries', 'touches', 'lostBall', 'tackles', 'tacklesWon', 'interceptions', 'clearances', 'blocks',
  'recoveries', 'duelsWon', 'duels', 'aerialsWon'];

function flattenStats(resp) {
  const out = {};
  const cats = (resp && resp.splits && resp.splits.categories) || [];
  for (const c of cats) for (const s of c.stats || []) if (out[s.name] == null || (out[s.name] === 0 && s.value)) out[s.name] = num(s.value);
  return out;
}
function mapDetail(flat) {
  if (!flat) return null;
  const o = {};
  for (const [k, n] of Object.entries(DETAIL_MAP)) {
    let v = flat[n];
    if (k === 'blocks' && v == null) v = flat.blockedShots;
    if (v != null) o[k] = v;
  }
  // zengin veri yoksa (hepsi 0) takip edilmiyor say
  const richSum = ['passes', 'touches', 'tackles', 'interceptions'].reduce((a, k) => a + (o[k] || 0), 0);
  if (richSum === 0) for (const k of RICH) delete o[k];
  return o;
}

// özet (summary) içindeki temel oyuncu istatistikleri
function rosterStatsObj(arr) {
  const o = {};
  for (const s of arr || []) o[s.name] = num(s.value);
  return o;
}

// ---------- bahis piyasası ----------
function amer(s) {
  if (s == null) return null;
  if (typeof s === 'number') s = String(s);
  s = String(s).trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV') return 2;
  const n = Number(s.replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}
function parseMarket(list) {
  for (const o of list || []) {
    if (!o) continue;
    const ml = o.moneyline || {};
    const pick = (x) => (x && (x.close || x.current || x.open)) || null;
    const h = amer((pick(ml.home) || {}).odds ?? (o.homeTeamOdds || {}).moneyLine);
    const d = amer((pick(ml.draw) || {}).odds ?? (o.drawOdds || {}).moneyLine);
    const a = amer((pick(ml.away) || {}).odds ?? (o.awayTeamOdds || {}).moneyLine);
    if (!h || !d || !a) continue;
    const s = 1 / h + 1 / d + 1 / a;
    const out = { provider: (o.provider && o.provider.name) || 'Bahis', home: 1 / h / s, draw: 1 / d / s, away: 1 / a / s, decHome: h, decDraw: d, decAway: a, total: null, overProb: null };
    const tot = o.total || {};
    const ov = pick(tot.over), un = pick(tot.under);
    let line = o.overUnder != null ? Number(o.overUnder) : null;
    if (ov && ov.line) { const m = String(ov.line).match(/[\d.]+/); if (m) line = Number(m[0]); }
    if (line != null && Number.isFinite(line)) out.total = line;
    const dO = amer(ov && ov.odds ? ov.odds : o.overOdds), dU = amer(un && un.odds ? un.odds : o.underOdds);
    if (dO && dU) out.overProb = 1 / dO / (1 / dO + 1 / dU);
    return out;
  }
  return null;
}

// Orta hakem adı. ESPN'in açık verisinde birçok ligde bu alan hiç yok (null döner); varsa gameInfo.officials ya da maç başlığından okunur.
function refereeOf(s) {
  const hdr = ((s.header && s.header.competitions) || [])[0] || {};
  const lists = [(s.gameInfo || {}).officials, hdr.officials];
  for (const l of lists) {
    if (!Array.isArray(l) || !l.length) continue;
    const nm = (o) => (o && (o.fullName || o.displayName || o.name)) || null;
    const pos = (o) => String((o && o.position && (o.position.name || o.position.displayName)) || (o && o.role) || '').toLowerCase();
    const main = l.find((o) => /referee|hakem/.test(pos(o)) && !/assistant|fourth|4th|video|var\b|yard/.test(pos(o))) || l.find((o) => o && Number(o.order) === 1 && !pos(o));
    if (main && nm(main)) return String(nm(main)).trim();
  }
  return null;
}

// ---------- maç özeti -> sade kayıt ----------
function parseSummary(s, slug, eventId) {
  if (!s) return null;
  const hdr = ((s.header && s.header.competitions) || [])[0] || {};
  const cs = hdr.competitors || [];
  let hc = cs.find((c) => c.homeAway === 'home');
  let ac = cs.find((c) => c.homeAway === 'away');
  const bt = (s.boxscore && s.boxscore.teams) || [];
  const ros = s.rosters || [];
  const teamFromAny = (homeAway, idx) => {
    const r = ros.find((x) => x.homeAway === homeAway) || ros[idx];
    const b = bt.find((x) => x.homeAway === homeAway) || bt[idx];
    const t = (r && r.team) || (b && b.team) || {};
    return { team: t, homeAway };
  };
  if (!hc) hc = teamFromAny('home', 0);
  if (!ac) ac = teamFromAny('away', 1);
  const home = teamObj(hc), away = teamObj(ac);
  const gi = s.gameInfo || {};
  const venue = gi.venue || {};
  const st = hdr.status || {};
  const status = statusOf(st.type ? st : { type: (hdr.status && hdr.status.type) || {}, displayClock: st.displayClock });

  const keyEvents = (s.keyEvents || []).map((k, i) => {
    const type = String((k.type && (k.type.type || k.type.text)) || '').toLowerCase().replace(/\s+/g, '-');
    let players = (k.participants || []).map((p) => p.athlete && (p.athlete.displayName || p.athlete.shortName)).filter(Boolean);
    if (/substitution/.test(type) && k.text) {
      const m = String(k.text).match(/\.\s*(.+?) replaces (.+?)\.?\s*$/);
      if (m) players = [m[1], m[2]];
    }
    return {
      id: String(k.id != null ? k.id : i),
      type,
      typeText: (k.type && k.type.text) || '',
      clock: (k.clock && k.clock.displayValue) || '',
      min: k.clock && k.clock.value != null ? Math.floor(Number(k.clock.value) / 60) : null,
      teamId: k.team && k.team.id != null ? String(k.team.id) : null,
      players,
      scoring: !!k.scoringPlay,
    };
  });

  const teamStats = {};
  for (const b of bt) {
    if (!b.team) continue;
    const o = {};
    for (const x of b.statistics || []) if (x.displayValue != null) o[x.name] = String(x.displayValue);
    teamStats[String(b.team.id)] = o;
  }

  const rosters = ros.map((r) => ({
    teamId: String(r.team && r.team.id),
    formation: r.formation || null,
    players: (r.roster || []).map((p) => {
      const a = p.athlete || {};
      return {
        id: String(a.id),
        name: a.displayName || a.fullName || '?',
        short: a.shortName || null,
        jersey: p.jersey || a.jersey || '',
        pos: (p.position && p.position.abbreviation) || '',
        starter: !!p.starter,
        subbedIn: truthy(p.subbedIn),
        subbedOut: truthy(p.subbedOut),
        stats: rosterStatsObj(p.stats),
      };
    }),
  }));

  const nameOf = (o) => (o && typeof o === 'object' ? o.displayName || o.name || o.shortDisplayName : o) || '?';
  const lastFive = (s.lastFiveGames || []).map((g) => ({
    teamId: String(g.team && g.team.id),
    events: (g.events || []).map((e) => ({
      id: String(e.id),
      result: e.gameResult || '',
      atVs: e.atVs || 'vs',
      opponent: nameOf(e.opponent),
      opponentLogo: e.opponentLogo || logoOf(e.opponent) || null,
      score: e.score || `${e.homeTeamScore}-${e.awayTeamScore}`,
      date: e.gameDate || null,
    })),
  }));

  let h2h = [];
  const hh = s.headToHeadGames || [];
  if (hh[0] && hh[0].events) {
    const tid = String(hh[0].team && hh[0].team.id);
    const tname = hh[0].team && (hh[0].team.displayName || hh[0].team.name);
    h2h = hh[0].events.map((e) => {
      const isHome = String(e.homeTeamId) === tid;
      const opp = nameOf(e.opponent);
      return {
        id: String(e.id),
        date: e.gameDate || null,
        home: isHome ? tname : opp,
        away: isHome ? opp : tname,
        homeScore: e.homeTeamScore,
        awayScore: e.awayTeamScore,
      };
    });
  }

  const market = parseMarket(s.pickcenter) || parseMarket(s.odds);
  const injuries = [];
  for (const g of s.injuries || []) {
    const tid = String(g.team && g.team.id);
    for (const i of g.injuries || []) {
      injuries.push({ teamId: tid, name: (i.athlete && i.athlete.displayName) || '?', pos: (i.athlete && i.athlete.position && i.athlete.position.abbreviation) || '', status: (i.status || (i.type && i.type.description) || ''), detail: (i.details && (i.details.type || i.details.detail)) || '' });
    }
  }

  return {
    id: String(eventId || (hdr.id)),
    league: slug,
    leagueName: (s.header && s.header.league && s.header.league.name) || null,
    date: new Date(hdr.date || (s.header && s.header.date) || Date.now()).toISOString(),
    status,
    venue: venue.fullName || null,
    city: venue.address ? venue.address.city || null : null,
    country: venue.address ? venue.address.country || null : null,
    neutral: !!hdr.neutralSite,
    referee: refereeOf(s),
    home, away, keyEvents, teamStats, rosters, lastFive, h2h, market, injuries,
  };
}

// ---------- puan durumu ----------
function parseStandings(j) {
  if (!j) return { season: '', groups: [] };
  const mkRows = (entries) =>
    (entries || []).map((e) => {
      const st = {};
      for (const s of e.stats || []) st[s.name] = num(s.value);
      const t = e.team || {};
      const note = e.note || null;
      return {
        teamId: String(t.id),
        name: t.displayName || t.name,
        logo: logoOf(t),
        rank: st.rank != null ? st.rank : null,
        gp: st.gamesPlayed ?? 0, w: st.wins ?? 0, d: st.ties ?? 0, l: st.losses ?? 0,
        gf: st.pointsFor ?? 0, ga: st.pointsAgainst ?? 0,
        gd: st.pointDifferential ?? (st.pointsFor ?? 0) - (st.pointsAgainst ?? 0),
        pts: st.points ?? 0,
        note: note ? note.description || null : null,
        noteColor: note && note.color ? '#' + String(note.color).replace(/^#+/, '') : null,
      };
    }).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const groups = [];
  const kids = j.children || [];
  if (kids.length) {
    for (const c of kids) {
      const rows = mkRows(c.standings && c.standings.entries);
      if (rows.length) groups.push({ name: c.name || (c.standings && c.standings.name) || 'Grup', rows });
    }
  } else if (j.standings && j.standings.entries) {
    groups.push({ name: j.name || 'Puan durumu', rows: mkRows(j.standings.entries) });
  }
  let season = '';
  const se = (j.season && (j.season.displayName || j.season.year)) || (kids[0] && kids[0].standings && kids[0].standings.seasonDisplayName) || '';
  season = String(se).replace(/\s+[A-Za-z].*$/, '');
  return { season, groups };
}

module.exports = {
  SITE, CORE, WEB, getJSON, stats,
  normEvent, scoreboardDay, scoreboardMonth, summaryRaw, standingsRaw, scheduleRaw, teamsListRaw, teamRosterRaw, rosterStatsRaw, athleteRaw,
  flattenStats, mapDetail, DETAIL_MAP, RICH, parseSummary, refereeOf, parseStandings, parseMarket, num, logoOf,
};
