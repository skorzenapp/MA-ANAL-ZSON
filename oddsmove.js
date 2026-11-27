'use strict';
// Oran hareketi: yaklaşan maçların piyasa oranını (marjı çıkarılmış olasılık) zaman içinde kaydeder.
// Kayıt yalnızca bu sunucu çalışırken yapılır: maç sayfası açıldıkça ve izleyici (maça yaklaştıkça sıklaşan aralıklarla) yeni nokta ekler.
// Geçmişe dönük açılış oranı yoktur. Biten maçta, kayıt varsa son noktaya football-data.co.uk'un kapanış ortalaması eklenir.

const U = require('./util');

const NS = 'om';
const HOUR = 3600000, MIN = 60000;
const MAX_PTS = 300;
const MOVE_P = 0.002; // olasılıkta en az bu kadar oynama (0,2 puan) yeni nokta sayılır
const MOVE_OV = 0.004;
const HEARTBEAT = 6 * HOUR; // oran oynamasa da en geç 6 saatte bir nokta
const MIN_GAP = 2 * MIN;
const WATCH_AHEAD = 72 * HOUR;
const WATCH_MAX = 120;

const r4 = (x) => Math.round(x * 10000) / 10000;
const key = (slug, id) => `${slug}:${id}`;
const blank = () => ({ pts: [], close: null });
function get(slug, id) {
  const c = U.diskGet(NS, key(slug, id), Infinity);
  return c.hit && c.d && Array.isArray(c.d.pts) ? c.d : blank();
}
function has(slug, id) { const c = U.diskGet(NS, key(slug, id), Infinity); return !!(c.hit && c.d); }

// market: { home, draw, away (marjsız olasılık), decHome.., overProb, provider }
function record(slug, id, market, kickoff, now = Date.now()) {
  if (!market || !(market.home > 0) || !(market.draw > 0) || !(market.away > 0)) return false;
  if (kickoff && kickoff <= now) return false; // başladıktan sonra kayıt yok (canlı oran değil, maç öncesi hareket)
  const s = get(slug, id);
  const last = s.pts[s.pts.length - 1];
  const p = [r4(market.home), r4(market.draw), r4(market.away)];
  const ov = market.overProb != null ? r4(market.overProb) : null;
  let moved = !last;
  if (last) {
    moved = Math.max(Math.abs(p[0] - last.p[0]), Math.abs(p[1] - last.p[1]), Math.abs(p[2] - last.p[2])) >= MOVE_P || (ov != null && last.ov != null && Math.abs(ov - last.ov) >= MOVE_OV);
    if (now - last.t < MIN_GAP) return false;
    if (!moved && now - last.t < HEARTBEAT) return false;
  }
  const pt = { t: now, p, ov, prov: market.provider || null };
  if (market.decHome > 1 && market.decDraw > 1 && market.decAway > 1) pt.dec = [market.decHome, market.decDraw, market.decAway].map((x) => Math.round(x * 100) / 100);
  s.pts.push(pt);
  if (s.pts.length > MAX_PTS) s.pts.splice(1, s.pts.length - MAX_PTS); // ilk (açılış) nokta kalır
  s.kick = kickoff || s.kick || null;
  U.diskSet(NS, key(slug, id), s);
  return true;
}
// biten maç: yalnızca daha önce kaydı olan maçlara kapanış eklenir (geçmiş maçlar için yeni dosya açılmaz)
function recordClose(slug, id, market, now = Date.now()) {
  if (!market || !(market.home > 0) || !has(slug, id)) return false;
  const s = get(slug, id);
  const p = [r4(market.home), r4(market.draw), r4(market.away)];
  if (s.close && s.close.p.every((x, i) => x === p[i])) return false;
  s.close = { t: now, p, ov: market.overProb != null ? r4(market.overProb) : null, prov: market.provider || null };
  if (market.decHome > 1) s.close.dec = [market.decHome, market.decDraw, market.decAway].map((x) => Math.round(x * 100) / 100);
  U.diskSet(NS, key(slug, id), s);
  return true;
}

// özet: açılış → son (puan farkı)
function summary(s) {
  if (!s || !s.pts || !s.pts.length) return null;
  const a = s.pts[0], b = s.pts[s.pts.length - 1];
  const d = b.p.map((x, i) => x - a.p[i]);
  return { n: s.pts.length, from: a.t, to: b.t, open: a.p, last: b.p, delta: d };
}

// ---- izleyici ----
const watch = new Map(); // key -> { slug, id, kick, next, strikes }
function watchMatch(slug, id, kick, now = Date.now()) {
  if (!Number.isFinite(kick) || kick <= now || kick - now > WATCH_AHEAD) return;
  const k = key(slug, id);
  if (watch.has(k)) return;
  if (watch.size >= WATCH_MAX) {
    // en uzaktaki maçı at
    let far = null;
    for (const [kk, w] of watch) if (!far || w.kick > far.w.kick) far = { kk, w };
    if (far && far.w.kick > kick) watch.delete(far.kk); else return;
  }
  watch.set(k, { slug, id, kick, next: 0, strikes: 0 });
}
const everyOf = (left) => (left > 48 * HOUR ? 6 * HOUR : left > 12 * HOUR ? 3 * HOUR : left > 2 * HOUR ? HOUR : 20 * MIN);
// fetchRec(slug, id) -> maç kaydı (kayıt, matchRecord içinde yapılır). Vadesi gelen en çok `limit` maçı yoklar.
async function tick(fetchRec, now = Date.now(), limit = 20) {
  const due = [...watch.entries()].filter(([, w]) => w.next <= now).sort((a, b) => a[1].kick - b[1].kick).slice(0, limit);
  let done = 0;
  for (const [k, w] of due) {
    if (w.kick <= now) { watch.delete(k); continue; }
    let rec = null;
    try { rec = await fetchRec(w.slug, w.id); } catch (e) { rec = null; }
    done++;
    if (!rec || !rec.status || rec.status.state !== 'pre') { watch.delete(k); continue; }
    if (!rec.market) { w.strikes++; if (w.strikes >= 2) { watch.delete(k); continue; } w.next = now + 12 * HOUR; continue; }
    w.next = now + everyOf(w.kick - now);
  }
  for (const [k, w] of watch) if (w.kick < now - HOUR) watch.delete(k);
  return { polled: done, watching: watch.size };
}
let timer = null;
function start(fetchRec, everyMs = Number(process.env.ODDS_TICK_MS) || 10 * MIN) {
  if (timer || process.env.ODDS_TRACK === '0') return false;
  timer = setInterval(() => tick(fetchRec).catch((e) => U.log('oran izleyici hatası', e.message)), everyMs);
  if (timer.unref) timer.unref();
  return true;
}
const status = () => ({ watching: watch.size, tracking: !!timer });

module.exports = { MAX_PTS, MOVE_P, HEARTBEAT, get, record, recordClose, summary, watchMatch, tick, start, status, everyOf, _watch: watch };
