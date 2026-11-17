'use strict';
// Lig listesi (arayüzdeki liste ile aynı) ve havuz tanımları.
const raw = require('./leagues.json');
const X = require('./leagues-extra.json'); // sonradan eklenen ligler ve kupalar

const extra = [
  { slug: 'jpn.1', name: 'J1 League', country: 'Japonya', flag: 'jp', available: true, kind: 'league' },
  { slug: 'nor.1', name: 'Eliteserien', country: 'Norveç', flag: 'no', available: true, kind: 'league' },
];

// ESPN'de olmayan, eskiden FotMob'dan gelen ligler kapalı
const OFF = new Set(['pol.1', 'cze.1', 'fin.1', 'tur.2', 'kor.1', ...X.close]);

const xCups = X.cups.map((l) => ({ ...l, available: true, kind: 'cup', domestic: true }));
const xLeagues = X.leagues.map((l) => ({ ...l, available: true, kind: 'league' }));
const ALL = [...raw.cups, ...xCups, ...raw.leagues.filter((l) => l.slug !== 'kor.1'), ...extra, ...xLeagues, ...raw.leagues.filter((l) => l.slug === 'kor.1')]
  .map((l) => ({ ...l, available: l.available && !OFF.has(l.slug) }));

const BY = Object.fromEntries(ALL.map((l) => [l.slug, l]));
const AVAILABLE = ALL.filter((l) => l.available).map((l) => l.slug);

// Tarafsız saha turnuvaları (ev sahibi avantajı yok)
const NEUTRAL = new Set(['fifa.world', 'uefa.euro', 'conmebol.america', ...X.neutral]);

// Kupa ve milli turnuvalarda modeli kurmak için birlikte kullanılan turnuvalar
const NAT = [
  'uefa.nations', 'uefa.euro', 'uefa.euroq', 'fifa.worldq.uefa', 'fifa.world', 'fifa.friendly',
  'fifa.worldq.conmebol', 'conmebol.america', 'fifa.worldq.concacaf', 'concacaf.gold', 'concacaf.nations.league',
  'fifa.worldq.afc', 'afc.asian.cup', 'fifa.worldq.caf', 'caf.nations',
];
const EURO_CLUBS = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'por.1', 'ned.1', 'tur.1', 'bel.1', 'sco.1', 'gre.1', 'den.1', 'aut.1', 'sui.1', 'swe.1', 'nor.1', 'eng.2'];
const POOLS = {
  'uefa.champions': ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', ...EURO_CLUBS],
  'uefa.europa': ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', ...EURO_CLUBS],
  'uefa.europa.conf': ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', ...EURO_CLUBS],
  'conmebol.libertadores': ['conmebol.libertadores', 'conmebol.sudamericana', 'bra.1', 'arg.1', 'col.1', 'chi.1'],
  'conmebol.sudamericana': ['conmebol.libertadores', 'conmebol.sudamericana', 'bra.1', 'arg.1', 'col.1', 'chi.1'],
  'afc.champions': ['afc.champions', 'ksa.1', 'jpn.1', 'kor.1', 'chn.1', 'aus.1'],
  'uefa.nations': NAT,
  'fifa.world': NAT,
  'uefa.euro': NAT,
  'conmebol.america': NAT,
};

Object.assign(POOLS, X.pools);
function poolOf(slug) {
  return POOLS[slug] || null;
}
function isCupOrIntl(slug) {
  const l = BY[slug];
  return !!l && l.kind !== 'league';
}

module.exports = { ALL, BY, AVAILABLE, NEUTRAL, poolOf, isCupOrIntl };
