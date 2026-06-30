// Plackett-Luce / Harville top-N place probabilities for the TX-Oracle engine.
//
// Ported from scripts/backtest/pl_calibration.py (Phase-1 calibration head,
// validated on 1299 real HK races x2 cadences: Harville gamma=1 >= Henery for
// pTop3, tau ~ 1.0). The worth v_i = exp(_score_i) is a strictly-monotone
// transform of the single ensemble _score, so the predicted top-N SET (ranking,
// box selection, box ROI) is UNCHANGED. This module only upgrades the place
// PROBABILITIES from the crude pTop3 = min(pWin*3, 0.99) approximation to the
// exact Harville values, adds pTop4, and an analytic E[box coverage] forecast.
// It is NOT a model / coverage / EV lift — only better-calibrated probabilities.
//
// Harville is used (gamma = 1 at every position): on real HK top-3 the Henery
// lower-place exponents added nothing over Harville, so the simpler model wins.

export const PL_PROB_MODEL = 'harville-v1';

// CPU guard: HK fields are <= 14. Above this the depth-4 DFS would burn Worker
// CPU for no practical gain, so fall back to the cheap softmax approximation.
const MAX_FIELD = 16;

// N x K array: pPos[i][r] = P(horse i finishes in position r) (r 0-indexed),
// under the Harville sequential model. Exact via depth-K DFS over ordered
// prefixes; each stage's denominator is the worth-sum over the REMAINING field.
function placeMarginals(v: number[], K: number): number[][] {
  const N = v.length;
  K = Math.min(K, N);
  const pPos: number[][] = Array.from({ length: N }, () => new Array(K).fill(0));
  if (N === 0) return pPos;
  const used = new Array(N).fill(false);
  const rec = (depth: number, prob: number): void => {
    let denom = 0;
    for (let i = 0; i < N; i++) if (!used[i]) denom += v[i];
    if (denom <= 0) return;
    for (let i = 0; i < N; i++) {
      if (used[i]) continue;
      const contrib = (prob * v[i]) / denom;
      pPos[i][depth] += contrib;
      if (depth + 1 < K) {
        used[i] = true;
        rec(depth + 1, contrib);
        used[i] = false;
      }
    }
  };
  rec(0, 1.0);
  return pPos;
}

// N x K cumulative: column k-1 = pTopK_i = P(horse i finishes within top k).
function topKCumulative(v: number[], K: number): number[][] {
  return placeMarginals(v, K).map((row) => {
    const c: number[] = [];
    let s = 0;
    for (const x of row) {
      s += x;
      c.push(s);
    }
    return c;
  });
}

// P(the top-m finishers ALL fall within index set S). m=3 -> trio / 三重彩 box
// coverage, m=4 -> first4 / 四重彩. Denominators are over the full field.
function coverageProb(v: number[], S: number[], m: number): number {
  const N = v.length;
  m = Math.min(m, N);
  if (m === 0) return 1.0;
  const used = new Array(N).fill(false);
  const rec = (depth: number, prob: number): number => {
    if (depth === m) return prob;
    let denom = 0;
    for (let i = 0; i < N; i++) if (!used[i]) denom += v[i];
    if (denom <= 0) return 0;
    let tot = 0;
    for (const i of S) {
      if (used[i]) continue;
      used[i] = true;
      tot += rec(depth + 1, (prob * v[i]) / denom);
      used[i] = false;
    }
    return tot;
  };
  return rec(0, 1.0);
}

export interface BoxCoverage {
  trio_n4: number;
  trio_n5: number;
  trio_n6: number;
  first4_n4: number;
  first4_n5: number;
  first4_n6: number;
}

export interface RaceProbabilities {
  pWin: number[];
  pTop3: number[];
  pTop4: number[];
  // Analytic E[box coverage] for our OWN predicted top-N sets, or null when the
  // field is too small / the cheap fallback ran.
  coverage: BoxCoverage | null;
  model: string; // PL_PROB_MODEL when exact, 'softmax-crude' on fallback
  exact: boolean;
}

// Single entry point: given the per-runner ensemble _score array (same order as
// the enriched picks), return pWin (identical to the existing softmax), exact
// Harville pTop3/pTop4, and analytic box-coverage for our predicted top-N sets.
export function computeRaceProbabilities(scores: number[]): RaceProbabilities {
  const N = scores.length;
  const finite = scores.every((s) => Number.isFinite(s));
  const mx = finite && N > 0 ? Math.max(...scores) : 0;
  const v = scores.map((s) => (Number.isFinite(s) ? Math.exp(s - mx) : 0));
  const Z = v.reduce((a, b) => a + b, 0) || 1;
  const pWin = v.map((x) => x / Z);

  // Fallback: empty / oversized field / non-finite scores -> keep the cheap
  // softmax approximation so we never change behaviour or burn CPU.
  if (N === 0 || N > MAX_FIELD || !finite) {
    return {
      pWin,
      pTop3: pWin.map((p) => Math.min(p * 3, 0.99)),
      pTop4: pWin.map((p) => Math.min(p * 4, 0.99)),
      coverage: null,
      model: 'softmax-crude',
      exact: false,
    };
  }

  const cum = topKCumulative(v, Math.min(4, N));
  const at = (i: number, k: number) => cum[i][Math.min(k, cum[i].length - 1)];
  const pTop3 = v.map((_, i) => at(i, 2));
  const pTop4 = v.map((_, i) => at(i, 3));

  // Predicted top-N sets by worth (== by _score == by pWin, monotone).
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => v[b] - v[a]);
  const setN = (n: number) => order.slice(0, Math.min(n, N));
  const coverage: BoxCoverage | null =
    N >= 3
      ? {
          trio_n4: coverageProb(v, setN(4), 3),
          trio_n5: coverageProb(v, setN(5), 3),
          trio_n6: coverageProb(v, setN(6), 3),
          first4_n4: N >= 4 ? coverageProb(v, setN(4), 4) : 0,
          first4_n5: N >= 4 ? coverageProb(v, setN(5), 4) : 0,
          first4_n6: N >= 4 ? coverageProb(v, setN(6), 4) : 0,
        }
      : null;

  return { pWin, pTop3, pTop4, coverage, model: PL_PROB_MODEL, exact: true };
}

// Round a coverage block for JSON emission (3 dp), preserving null.
export function roundCoverage(c: BoxCoverage | null): BoxCoverage | null {
  if (!c) return null;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    trio_n4: r(c.trio_n4),
    trio_n5: r(c.trio_n5),
    trio_n6: r(c.trio_n6),
    first4_n4: r(c.first4_n4),
    first4_n5: r(c.first4_n5),
    first4_n6: r(c.first4_n6),
  };
}
