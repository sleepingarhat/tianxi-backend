/**
 * Ingest horses/profiles/horse_profiles.csv
 * Updates: horses (UPSERT) + horse_profile_extra (UPSERT)
 */
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import {
  parseHKDate,
  parseStakesInt,
  parseRecordBreakdown,
  parseFloat10,
  normalizeStatus,
  parseColourSex,
} from '../lib/parsers.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function ingestHorseProfiles(
  db: DB,
  csvPath: string,
  sourceCommit: string | null,
): IngestStats {
  const rows = parseCsv(csvPath);
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

  const upsertHorse = db.prepare(
    `INSERT INTO horses (id, name_en, name_ch, code, country_of_origin, colour, sex, import_type, sire, dam, dam_sire, current_rating, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name_ch = COALESCE(excluded.name_ch, horses.name_ch),
       country_of_origin = COALESCE(excluded.country_of_origin, horses.country_of_origin),
       colour = COALESCE(excluded.colour, horses.colour),
       sex = COALESCE(excluded.sex, horses.sex),
       import_type = COALESCE(excluded.import_type, horses.import_type),
       sire = COALESCE(excluded.sire, horses.sire),
       dam = COALESCE(excluded.dam, horses.dam),
       dam_sire = COALESCE(excluded.dam_sire, horses.dam_sire),
       current_rating = COALESCE(excluded.current_rating, horses.current_rating),
       status = COALESCE(excluded.status, horses.status),
       updated_at = datetime('now')`,
  );

  const upsertExtra = db.prepare(
    `INSERT INTO horse_profile_extra
       (horse_id, name_with_status, status, last_race_date, country_of_origin, colour_sex_raw,
        import_type, total_stakes_raw, total_stakes_int, record_wins, record_seconds, record_thirds,
        record_total_starts, owner, last_rating, sire, dam, dam_sire, half_siblings,
        profile_last_scraped, source_commit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id) DO UPDATE SET
       name_with_status = excluded.name_with_status,
       status = excluded.status,
       last_race_date = excluded.last_race_date,
       country_of_origin = excluded.country_of_origin,
       colour_sex_raw = excluded.colour_sex_raw,
       import_type = excluded.import_type,
       total_stakes_raw = excluded.total_stakes_raw,
       total_stakes_int = excluded.total_stakes_int,
       record_wins = excluded.record_wins,
       record_seconds = excluded.record_seconds,
       record_thirds = excluded.record_thirds,
       record_total_starts = excluded.record_total_starts,
       owner = excluded.owner,
       last_rating = excluded.last_rating,
       sire = excluded.sire,
       dam = excluded.dam,
       dam_sire = excluded.dam_sire,
       half_siblings = excluded.half_siblings,
       profile_last_scraped = excluded.profile_last_scraped,
       source_commit = excluded.source_commit,
       updated_at = datetime('now')`,
  );

  const existingIds = new Set(
    (db.prepare('SELECT id FROM horses').all() as Array<{ id: string }>).map((r) => r.id),
  );

  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      try {
        const code = (row['horse_no'] || '').trim();
        if (!code) {
          stats.skipped++;
          continue;
        }
        const id = code; // use HKJC code as id
        const name = (row['name'] || '').trim();
        const { colour, sex } = parseColourSex(row['毛色___性別']);
        const recBreak = parseRecordBreakdown(row['冠-亞-季-總出賽次數']);
        const status = normalizeStatus(row['status']);
        const lastRating = parseFloat10(row['最後評分']);

        const wasExisting = existingIds.has(id);

        upsertHorse.run(
          id,
          name || code,
          name || null,
          code,
          row['出生地'] || null,
          colour,
          sex,
          row['進口類別'] || null,
          row['父系'] || null,
          row['母系'] || null,
          row['外祖父'] || null,
          lastRating != null ? Math.round(lastRating) : null,
          status,
        );

        upsertExtra.run(
          id,
          name || null,
          status,
          parseHKDate(row['last_race_date']),
          row['出生地'] || null,
          row['毛色___性別'] || null,
          row['進口類別'] || null,
          row['總獎金'] || null,
          parseStakesInt(row['總獎金']),
          recBreak.wins,
          recBreak.seconds,
          recBreak.thirds,
          recBreak.total,
          row['馬主'] || null,
          lastRating,
          row['父系'] || null,
          row['母系'] || null,
          row['外祖父'] || null,
          row['同父系馬'] || null,
          parseHKDate(row['profile_last_scraped']),
          sourceCommit,
        );

        if (wasExisting) stats.updated++;
        else stats.inserted++;
      } catch (err) {
        stats.failed++;
        // eslint-disable-next-line no-console
        console.error('[horse_profiles] failed row', row['horse_no'], err);
      }
    }
  });

  tx(rows);
  return stats;
}
