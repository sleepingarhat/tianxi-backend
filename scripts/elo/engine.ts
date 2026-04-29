/**
 * Elo rating engine — pure math, no DB
 *
 * Multi-runner race semantics:
 *   For a race with N finishers, for each pair (i,j) where i placed better than j:
 *     expected_i = 1 / (1 + 10^((R_j - R_i)/400))
 *     expected_j = 1 / (1 + 10^((R_i - R_j)/400))
 *     delta_i += K/(N-1) * (1 - expected_i)
 *     delta_j += K/(N-1) * (0 - expected_j)
 *   Deltas summed across all (N-1) pairs for each runner, applied simultaneously.
 *
 * DNF/PU (finishing_position_num = 999) runners are excluded.
 * Ties handled by treating them as 0.5/0.5 expected.
 */

export interface Runner {
  entityId: string;         // horse_id, jockey_id, or trainer_id
  finish: number;           // 1..N, 999 for DNF
  currentRating: number;    // rating BEFORE this race
}

export interface EloConfig {
  k: number;                // K-factor, typical 32-60 for sports
  initialRating: number;    // usually 1500
}

export const DEFAULT_CONFIG: EloConfig = {
  k: 40,
  initialRating: 1500,
};

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Compute deltas for a race. Returns Map<entityId, deltaRating>.
 * DNF runners (finish === 999) get delta 0 but still consume their K budget from rivals.
 * To keep things principled, we exclude DNFs from pair comparisons entirely.
 */
export function computeRaceDeltas(
  runners: Runner[],
  config: EloConfig = DEFAULT_CONFIG,
): Map<string, number> {
  const deltas = new Map<string, number>();
  const valid = runners.filter((r) => r.finish !== 999);
  if (valid.length < 2) {
    for (const r of runners) deltas.set(r.entityId, 0);
    return deltas;
  }

  // Initialize deltas
  for (const r of runners) deltas.set(r.entityId, 0);

  const N = valid.length;
  const scale = config.k / (N - 1);

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      // Determine actual score based on finishing positions
      let scoreA: number;
      let scoreB: number;
      if (a.finish < b.finish) {
        scoreA = 1;
        scoreB = 0;
      } else if (a.finish > b.finish) {
        scoreA = 0;
        scoreB = 1;
      } else {
        scoreA = 0.5;
        scoreB = 0.5;
      }
      const expA = expectedScore(a.currentRating, b.currentRating);
      const expB = 1 - expA;
      deltas.set(a.entityId, (deltas.get(a.entityId) ?? 0) + scale * (scoreA - expA));
      deltas.set(b.entityId, (deltas.get(b.entityId) ?? 0) + scale * (scoreB - expB));
    }
  }

  return deltas;
}
