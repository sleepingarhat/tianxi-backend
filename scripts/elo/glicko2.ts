/**
 * Glicko-2 rating engine — pure math, no DB (Glickman 2013 spec).
 *
 * Multi-runner race semantics (mirrors elo/engine.ts):
 *   Each race is one rating period. For runner i, every other valid runner j
 *   is one pairwise "game" with score 1 (beat j), 0 (lost to j), 0.5 (tie).
 *   All runners update simultaneously from pre-race states.
 *
 * Inactivity: before applying a race, the caller passes `periodsIdle`
 *   (elapsed days / 30, floored at 1). RD inflates by sqrt(RD² + σ²·p) on the
 *   Glicko scale — this is the "system knows it is uncertain about a horse
 *   returning from a layoff" property that plain Elo lacks.
 *
 * DNF/PU (finish 999) runners are excluded, same as Elo.
 */

export interface G2State {
  r: number;    // rating, 1500-centred
  rd: number;   // rating deviation (rating points)
  vol: number;  // volatility σ (Glicko scale)
}

export interface G2Runner {
  entityId: string;
  finish: number;         // 1..N, 999 = DNF
  state: G2State;         // pre-race state
  periodsIdle: number;    // elapsed periods since last race (≥ 1)
}

export interface G2Config {
  tau: number;            // volatility constraint, 0.3–1.2 typical
  initialRating: number;
  initialRd: number;
  maxRd: number;
  initialVol: number;
}

export const G2_DEFAULT: G2Config = {
  tau: 0.5,
  initialRating: 1500,
  initialRd: 350,
  maxRd: 350,
  initialVol: 0.06,
};

const SCALE = 173.7178;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}
function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/** Inflate RD for idle periods (rating-point scale). */
export function inflateRd(rd: number, vol: number, periods: number, maxRd: number): number {
  const phi = rd / SCALE;
  const phiStar = Math.sqrt(phi * phi + vol * vol * Math.max(0, periods));
  return Math.min(maxRd, phiStar * SCALE);
}

/** New volatility via Illinois algorithm (Glickman step 5). */
function newVolatility(phi: number, v: number, delta: number, sigma: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const d2 = delta * delta;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (d2 - phi2 - v - ex)) / (2 * Math.pow(phi2 + v + ex, 2)) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > 1e-6 && iter < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B; fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C; fB = fC;
    iter++;
  }
  return Math.exp(A / 2);
}

/**
 * Compute post-race states for a race. Returns Map<entityId, G2State>.
 * Runners with <2 valid opponents (or DNF) only get RD inflation, no update.
 */
export function computeRaceG2(
  runners: G2Runner[],
  config: G2Config = G2_DEFAULT,
): Map<string, G2State> {
  const out = new Map<string, G2State>();
  const valid = runners.filter((r) => r.finish !== 999);

  // Pre-inflate everyone (idle-time uncertainty growth happens regardless).
  const pre = new Map<string, { mu: number; phi: number; vol: number }>();
  for (const r of runners) {
    const rdInfl = inflateRd(r.state.rd, r.state.vol, r.periodsIdle, config.maxRd);
    pre.set(r.entityId, {
      mu: (r.state.r - config.initialRating) / SCALE,
      phi: rdInfl / SCALE,
      vol: r.state.vol,
    });
  }

  for (const r of runners) {
    const me = pre.get(r.entityId)!;
    const opps = valid.filter((o) => o.entityId !== r.entityId);
    if (r.finish === 999 || opps.length < 1) {
      // No game outcome: keep rating, keep inflated RD.
      out.set(r.entityId, { r: r.state.r, rd: me.phi * SCALE, vol: me.vol });
      continue;
    }
    let vInv = 0;
    let deltaSum = 0;
    for (const o of opps) {
      const op = pre.get(o.entityId)!;
      const e = E(me.mu, op.mu, op.phi);
      const gj = g(op.phi);
      const s = r.finish < o.finish ? 1 : r.finish > o.finish ? 0 : 0.5;
      vInv += gj * gj * e * (1 - e);
      deltaSum += gj * (s - e);
    }
    if (vInv === 0) {
      out.set(r.entityId, { r: r.state.r, rd: me.phi * SCALE, vol: me.vol });
      continue;
    }
    const v = 1 / vInv;
    const delta = v * deltaSum;
    const volNew = newVolatility(me.phi, v, delta, me.vol, config.tau);
    const phiStar = Math.sqrt(me.phi * me.phi + volNew * volNew);
    const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    const muNew = me.mu + phiNew * phiNew * deltaSum;
    out.set(r.entityId, {
      r: config.initialRating + muNew * SCALE,
      rd: Math.min(config.maxRd, phiNew * SCALE),
      vol: volNew,
    });
  }
  return out;
}
