'use strict';
// Küçük yardımcılar: önbellek (disk + bellek), eşzamanlılık sınırı, tarih işlemleri.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class Limiter {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          this.active--;
          const nx = this.q.shift();
          if (nx) nx();
        });
      };
      this.active < this.n ? go() : this.q.push(go);
    });
  }
}

// Disk önbelleği: { t: yazılma zamanı, d: veri }
function diskPath(ns, key) {
  const h = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(DATA_DIR, ns, h.slice(0, 2), h + '.json');
}
function diskGet(ns, key, ttl) {
  try {
    const f = diskPath(ns, key);
    const raw = fs.readFileSync(f, 'utf8');
    const o = JSON.parse(raw);
    if (ttl === Infinity || Date.now() - o.t < ttl) return { hit: true, d: o.d, t: o.t };
  } catch (e) { /* yok */ }
  return { hit: false };
}
function diskSet(ns, key, d) {
  try {
    const f = diskPath(ns, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ t: Date.now(), d }));
    fs.renameSync(tmp, f);
  } catch (e) { /* disk yazılamazsa sorun değil */ }
}

// Bellek önbelleği (küçük nesneler için)
const mem = new Map();
function memGet(key) {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.x < Date.now()) { mem.delete(key); return undefined; }
  return e.v;
}
function memSet(key, v, ttl) {
  if (mem.size > 4000) {
    const first = mem.keys().next().value;
    mem.delete(first);
  }
  mem.set(key, { v, x: Date.now() + ttl });
}

// Aynı anda aynı işi iki kez yapma
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Tarih yardımcıları
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const ym = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;
const parseYmd = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const DAY = 86400000;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o').replace(/ð/g, 'd').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneOld(ns, maxAgeMs) {
  const root = path.join(DATA_DIR, ns);
  const now = Date.now();
  let n = 0;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) { fs.unlinkSync(f); n++; } } catch (e2) { /* */ }
      }
    }
  };
  walk(root);
  return n;
}

module.exports = { DATA_DIR, sleep, log, Limiter, diskGet, diskSet, memGet, memSet, once, ymd, ym, parseYmd, addDays, DAY, norm, pruneOld, pad };
