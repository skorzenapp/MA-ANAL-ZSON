'use strict';
// Küçük Poisson regresyon (log bağlantı, modelin beklentisi sabit "offset") ve birden çok ligin ölçümünü birleştirme.
// Kullanım: "modelin beklediği gole göre, şu durum varken gerçek gol yüzde kaç farklı?" sorusu.
//   log λ = log mu + β1·x1 + β2·x2 + ...      rows: [{y, mu, x:[x1, x2, ...]}]
// Sıfırdan farkı olabilirlik oranı testiyle (k serbestlik derecesi) sınanır.

const CHI2_05 = [0, 3.84, 5.99, 7.81, 9.49, 11.07];

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1;
    const x = solve(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return A.map((_, i) => cols.map((c) => c[i]));
}

function loglik(rows, beta) {
  let s = 0;
  for (const r of rows) {
    let eta = Math.log(r.mu);
    for (let j = 0; j < beta.length; j++) eta += beta[j] * r.x[j];
    s += r.y * eta - Math.exp(eta);
  }
  return s;
}
function hessian(rows, beta, ridge = 0) {
  const k = beta.length;
  const H = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of rows) {
    let eta = Math.log(r.mu);
    for (let j = 0; j < k; j++) eta += beta[j] * r.x[j];
    const m = Math.exp(eta);
    for (let a = 0; a < k; a++) { if (!r.x[a]) continue; for (let b = a; b < k; b++) H[a][b] += m * r.x[a] * r.x[b]; }
  }
  for (let a = 0; a < k; a++) { for (let b = 0; b < a; b++) H[a][b] = H[b][a]; H[a][a] += ridge; }
  return H;
}

// minRows: ölçüm için en az satır; minActive: her özelliğin 1 olduğu en az satır sayısı
function fit(rows, k, { minRows = 120, minActive = 25 } = {}) {
  const n = rows.length;
  const active = new Array(k).fill(0);
  for (const r of rows) for (let j = 0; j < k; j++) if (r.x[j]) active[j]++;
  if (n < minRows || active.some((a) => a < minActive)) return { enough: false, n, active };
  let beta = new Array(k).fill(0);
  const ll0 = loglik(rows, beta);
  let ll = ll0;
  for (let it = 0; it < 40; it++) {
    const grad = new Array(k).fill(0);
    for (const r of rows) {
      let eta = Math.log(r.mu);
      for (let j = 0; j < k; j++) eta += beta[j] * r.x[j];
      const m = Math.exp(eta);
      for (let j = 0; j < k; j++) grad[j] += r.x[j] * (r.y - m);
    }
    const H = hessian(rows, beta, 1e-6);
    const step = solve(H, grad);
    if (!step) break;
    let t = 1, ok = false;
    for (let ls = 0; ls < 12; ls++) {
      const nb = beta.map((b, j) => Math.max(-1.2, Math.min(1.2, b + t * step[j])));
      const nl = loglik(rows, nb);
      if (nl >= ll - 1e-12) { beta = nb; const gain = nl - ll; ll = nl; ok = true; if (gain < 1e-9) it = 99; break; }
      t /= 2;
    }
    if (!ok) break;
  }
  const info = hessian(rows, beta, 0);
  const inv = invert(info.map((r, i) => r.map((v, j) => v + (i === j ? 1e-9 : 0))));
  const se = inv ? inv.map((r, i) => Math.sqrt(Math.max(0, r[i]))) : null;
  const LR = 2 * (ll - ll0);
  return { enough: true, n, active, beta, se, info, LR, df: k, crit: CHI2_05[k] || 3.84 * k, significant: LR >= (CHI2_05[k] || 3.84 * k) };
}

// Birden çok ligin ölçümü: list: [{beta, info}]
function pool(list, k, minLeagues = 3) {
  const L = list.filter((x) => x && Array.isArray(x.beta) && x.beta.length === k && Array.isArray(x.info) && x.info.length === k);
  if (L.length < minLeagues) return { enough: false, leagues: L.length };
  const I = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (const x of L) for (let a = 0; a < k; a++) { for (let c = 0; c < k; c++) { I[a][c] += x.info[a][c]; b[a] += x.info[a][c] * x.beta[c]; } }
  const beta = solve(I, b);
  if (!beta) return { enough: false, leagues: L.length };
  let W = 0;
  for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) W += beta[a] * I[a][c] * beta[c];
  const inv = invert(I);
  const crit = CHI2_05[k] || 3.84 * k;
  return { enough: true, leagues: L.length, beta, se: inv ? inv.map((r, i) => Math.sqrt(Math.max(0, r[i]))) : null, W, crit, significant: W >= crit };
}

module.exports = { fit, pool, solve, invert, loglik, CHI2_05 };
