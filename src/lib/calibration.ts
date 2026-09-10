// Probability calibration (Stage 2 of the accuracy programme).
//
// The engine's win probabilities are already close to observed frequency, but
// the top-3 probabilities are over-confident in the high band (engine says
// ~64%, reality ~47%). Platt scaling fixes this with a 2-parameter logistic
// regression in logit space:
//
//   p_cal = sigmoid(a * logit(p_raw) + b)
//
// a < 1 shrinks extreme probabilities towards the middle (less over-confident),
// b shifts the whole curve. Because a > 0 the mapping is strictly increasing,
// so ranking / pick order never changes — only the stated probability does.

export type PlattParams = { a: number; b: number };
export type Sample = { p: number; y: number };

const EPS = 1e-6;

export function clampP(p: number): number {
  return Math.min(1 - 1e-4, Math.max(1e-4, p));
}

export function logit(p: number): number {
  const q = clampP(p);
  return Math.log(q / (1 - q));
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function applyPlatt(p: number, params: PlattParams | null | undefined): number {
  if (!params || !Number.isFinite(params.a) || !Number.isFinite(params.b)) return p;
  return sigmoid(params.a * logit(p) + params.b);
}

/**
 * Fit Platt scaling by Newton/IRLS with light L2 regularisation (keeps the fit
 * stable when a probability band has few samples).
 */
export function fitPlatt(samples: Sample[], lambda = 1e-3): PlattParams | null {
  const rows = samples.filter((s) => Number.isFinite(s.p) && (s.y === 0 || s.y === 1));
  if (rows.length < 50) return null;
  const x = rows.map((s) => logit(s.p));
  const y = rows.map((s) => s.y);
  let a = 1, b = 0;
  for (let iter = 0; iter < 60; iter++) {
    let g0 = lambda * (a - 1), g1 = lambda * b;
    let h00 = lambda, h01 = 0, h11 = lambda;
    for (let i = 0; i < rows.length; i++) {
      const xi = x[i]!;
      const pi = sigmoid(a * xi + b);
      const r = pi - y[i]!;
      const w = Math.max(pi * (1 - pi), 1e-8);
      g0 += r * xi; g1 += r;
      h00 += w * xi * xi; h01 += w * xi; h11 += w;
    }
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const db = (g1 * h00 - g0 * h01) / det;
    a -= da; b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) break;
  }
  if (!(a > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a: Math.round(a * 10000) / 10000, b: Math.round(b * 10000) / 10000 };
}

const ECE_EDGES = [0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 1];

/** Brier score, log-loss and expected calibration error for a sample set. */
export function scoreSamples(samples: Sample[]) {
  const rows = samples.filter((s) => Number.isFinite(s.p));
  const n = rows.length;
  if (!n) return { n: 0, brier: null, logLoss: null, ece: null };
  let brier = 0, ll = 0;
  const bins = ECE_EDGES.slice(0, -1).map(() => ({ n: 0, pSum: 0, ySum: 0 }));
  for (const s of rows) {
    const p = Math.min(0.999, Math.max(0.001, s.p));
    brier += (p - s.y) * (p - s.y);
    ll += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
    let idx = bins.length - 1;
    for (let i = 0; i < ECE_EDGES.length - 1; i++) {
      if (p >= ECE_EDGES[i]! - EPS && p < ECE_EDGES[i + 1]!) { idx = i; break; }
    }
    const bin = bins[idx]!;
    bin.n++; bin.pSum += p; bin.ySum += s.y;
  }
  let ece = 0;
  for (const bin of bins) {
    if (!bin.n) continue;
    ece += (bin.n / n) * Math.abs(bin.ySum / bin.n - bin.pSum / bin.n);
  }
  return {
    n,
    brier: Math.round((brier / n) * 100000) / 100000,
    logLoss: Math.round((ll / n) * 100000) / 100000,
    ece: Math.round(ece * 100000) / 100000,
  };
}

export type StoredCalibration = {
  version: number;
  top3: PlattParams | null;
  win: PlattParams | null;
  fittedAt: string;
  days: number;
  samples: number;
  holdout?: unknown;
};

export function parseCalibration(raw: unknown): StoredCalibration | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return v as StoredCalibration;
  } catch {
    return null;
  }
}
