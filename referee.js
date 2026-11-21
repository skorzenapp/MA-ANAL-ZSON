'use strict';
// Hakem etkisi: bir hakemin maçlarında sarı kart sayısı, kart modelinin beklentisinden sistemli sapıyor mu?
// Hakem başına oran = (gerçek kart + K) / (beklenen kart + K): az maçı olan hakem 1'e (ortalamaya) çekilir.
// Doğrulama yürüyen testtir: her maç için hakemin SADECE o maçtan önceki maçları kullanılır; geleceği görmez.
// Ölçüt: Poisson log-olabilirlik farkı (hakemli beklenti - hakemsiz beklenti), eşli z >= 1,64 ve ortalaması pozitif.
// Not: ESPN'in açık verisi çoğu ligde hakem adını vermez; veri yoksa hiçbir şey ölçülmez, tahmine karışmaz.

const K = 50;          // ön bilgi ağırlığı (beklenen kart biriminde, kabaca 12 maç)
const MIN_PRIOR = 4;   // hakemin testte sayılması için o güne kadar en az bu kadar maçı olmalı
const MIN_TEST = 100;  // en az bu kadar test maçı
const Z_REF = 1.64;

const keyOf = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ratioOf = (st) => (st.a + K) / (st.e + K);

// rows: [{t, ref, act, pred}]  act = iki takımın toplam sarı kartı, pred = modelin hakem bilmeden beklentisi
function analyze(rows, total) {
  const use = (rows || []).filter((r) => r && r.ref && keyOf(r.ref) && r.pred > 0 && r.act != null).sort((a, b) => a.t - b.t);
  const out = { withRef: use.length, matches: total == null ? use.length : total, K };
  if (!use.length) return { ...out, enough: false, n: 0, reason: 'nodata' };
  const st = new Map();
  const d = [];
  for (const r of use) {
    const k = keyOf(r.ref);
    let s = st.get(k);
    if (!s) { s = { name: r.ref, n: 0, a: 0, e: 0 }; st.set(k, s); }
    if (s.n >= MIN_PRIOR) {
      const mu1 = r.pred * ratioOf(s);
      d.push((r.act * Math.log(mu1) - mu1) - (r.act * Math.log(r.pred) - r.pred));
    }
    s.n++; s.a += r.act; s.e += r.pred;
  }
  const refs = [...st.entries()].map(([key, s]) => ({ key, name: s.name, n: s.n, avg: s.a / s.n, exp: s.e / s.n, ratio: ratioOf(s), raw: s.e ? s.a / s.e : null }));
  if (d.length < MIN_TEST) return { ...out, enough: false, n: use.length, nTest: d.length, nRefs: refs.length, reason: 'few' };
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / (d.length - 1));
  const z = sd > 0 ? mean / (sd / Math.sqrt(d.length)) : 0;
  const adopted = mean > 0 && z >= Z_REF;
  refs.sort((a, b) => b.n - a.n);
  const keep = refs.filter((r) => r.n >= 3).slice(0, 200).map((r) => ({ key: r.key, name: r.name, n: r.n, avg: +r.avg.toFixed(2), exp: +r.exp.toFixed(2), ratio: +r.ratio.toFixed(3) }));
  const sorted = keep.slice().sort((a, b) => b.ratio - a.ratio);
  return { ...out, enough: true, n: use.length, nTest: d.length, nRefs: refs.length, gain: mean, z, adopted, refs: keep, high: sorted.slice(0, 3), low: sorted.slice(-3).reverse() };
}

// bir hakemin oranı (yoksa null); ölçüm 'adopted' değilse uygulanmaz
function lookup(an, name) {
  if (!an || !an.enough || !name) return null;
  const k = keyOf(name);
  const r = (an.refs || []).find((x) => x.key === k);
  return r || { key: k, name, n: 0, ratio: 1 };
}

module.exports = { analyze, lookup, keyOf, K, MIN_PRIOR, MIN_TEST, Z_REF };
