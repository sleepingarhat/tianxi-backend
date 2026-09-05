/**
 * Deterministic ID generation for upserts
 * Keep short + readable (not cryptographic hashes) so D1 admin tooling can trace
 */
import { createHash } from 'node:crypto';

export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

export function formRecordId(horseCode: string, dateIso: string, venue: string | null, raceNo: string | number): string {
  return `hfr_${horseCode}_${dateIso}_${venue ?? 'NA'}_${raceNo}`;
}

// 2026-09-05: added workType + raw details to the hash. A horse often has 2-3
// sessions on one morning (游水 + 踱步 + 快操) that share NULL distance/time, so
// the old 3-part key collapsed them into a single row. `None` (not `null`) is the
// placeholder for blank parts — matches the Python backfill that seeded D1.
export function trackworkId(
  horseCode: string,
  dateIso: string,
  venue: string | null,
  distance: string | null,
  timeText: string | null,
  workType: string | null = null,
  details: string | null = null,
): string {
  const nn = (v: string | null) => (v == null || v === '' ? 'None' : v);
  const key = `${nn(venue)}|${nn(distance)}|${nn(timeText)}|${workType ?? ''}|${details ?? ''}`;
  return `htw_${horseCode}_${dateIso}_${shortHash(key)}`;
}

export function injuryId(horseCode: string, dateIso: string, injuryType: string): string {
  return `hinj_${horseCode}_${dateIso}_${shortHash(injuryType)}`;
}

export function trialSessionId(dateIso: string, venue: string | null, groupNo: string | number): string {
  return `ts_${dateIso}_${shortHash(venue ?? 'NA')}_${groupNo}`;
}

export function trialRunnerId(sessionId: string, horseCode: string): string {
  return `trr_${sessionId}_${horseCode}`;
}

export function jockeySeasonId(jockeyCode: string, season: string): string {
  return `jsr_${jockeyCode}_${season.replace(/\//g, '-')}`;
}

export function entryId(dateIso: string, venue: string, raceNo: string | number, horseNo: string | number): string {
  return `eu_${dateIso}_${venue}_${raceNo}_${horseNo}`;
}
