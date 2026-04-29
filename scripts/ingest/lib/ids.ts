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

export function trackworkId(horseCode: string, dateIso: string, venue: string | null, distance: string | null, timeText: string | null): string {
  return `htw_${horseCode}_${dateIso}_${shortHash(`${venue}|${distance}|${timeText}`)}`;
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
