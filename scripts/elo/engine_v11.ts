/**
 * Elo v1.1 engine — adds:
 *   1. 180-day idle decay (R = R*0.9 + 1500*0.1) on first race after idle gap
 *   2. Axis-aware rating state (overall + surface_distance buckets)
 *
 * Re-uses the pairwise pair math from engine.ts via computeRaceDeltas().
 * This file only handles the STATE management around it (decay, per-axis lookup).
 */
import { DEFAULT_CONFIG, type EloConfig } from './engine.js';

export interface AxisState {
  rating: number;
  gamesPlayed: number;
  lastRaceDate: string | null; // ISO YYYY-MM-DD
}

export const DEFAULT_V11_CONFIG = {
  ...DEFAULT_CONFIG,
  decayThresholdDays: 180,
  decayWeight: 0.9, // R = R * w + 1500 * (1-w)
  anchorRating: 1500,
};

export type V11Config = typeof DEFAULT_V11_CONFIG;

/**
 * Apply idle decay if gap > threshold. Returns new rating + days-applied flag.
 */
export function applyDecayIfIdle(
  state: AxisState,
  currentDate: string,
  cfg: V11Config = DEFAULT_V11_CONFIG,
): { rating: number; decayAppliedDays: number | null; daysSinceLast: number | null } {
  if (!state.lastRaceDate) {
    return { rating: state.rating, decayAppliedDays: null, daysSinceLast: null };
  }
  const gapMs = Date.parse(currentDate + 'T00:00:00Z') - Date.parse(state.lastRaceDate + 'T00:00:00Z');
  const days = Math.round(gapMs / 86_400_000);
  if (!Number.isFinite(days) || days <= cfg.decayThresholdDays) {
    return { rating: state.rating, decayAppliedDays: null, daysSinceLast: days };
  }
  const decayed = state.rating * cfg.decayWeight + cfg.anchorRating * (1 - cfg.decayWeight);
  return { rating: decayed, decayAppliedDays: days, daysSinceLast: days };
}

/**
 * Build axis_key for horse layer: 'overall' | '<surface>_<bucket>'
 * E.g. 'turf_sprint', 'awt_mile'. Returns null if either piece missing
 * (meaning: this race can only update 'overall', not any axis).
 */
export function buildAxisKey(surface: 'turf' | 'awt' | null, bucket: string | null): string | null {
  if (!surface || !bucket) return null;
  return `${surface}_${bucket}`;
}

/**
 * Lookup/init rating for a (horseId, axis) pair.
 */
export function getOrInitAxisState(
  store: Map<string, AxisState>,
  horseId: string,
  axisKey: string,
  initialRating: number,
): AxisState {
  const k = `${horseId}|${axisKey}`;
  let s = store.get(k);
  if (!s) {
    s = { rating: initialRating, gamesPlayed: 0, lastRaceDate: null };
    store.set(k, s);
  }
  return s;
}

export function axisStoreKey(horseId: string, axisKey: string): string {
  return `${horseId}|${axisKey}`;
}
