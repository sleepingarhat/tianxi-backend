/**
 * (cache-bust rev2: profiles ingest now wired into lgb_walkforward.yml DB build)
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

  // ⑨ age/career-stage: the horses UPSERT below has ALWAYS failed in the bulk
  // CI build (import-csv pre-creates prefixed 'horse_<code>' rows holding the
  // same code → UNIQUE(code) collision; ins≈2 fail≈6000). Same trap that made
  // pedigree use its own table — so age gets its own collision-free table too.
  // birth_season = seasonYear(profile_last_scraped) − current_age, where
  // seasonYear uses a JULY-1 boundary (HK season-age convention approximation).
  db.exec(`CREATE TABLE IF NOT EXISTS horse_birth_season (
    code TEXT PRIMARY KEY,
    birth_season INTEGER NOT NULL,
    current_age INTEGER NOT NULL,
    scraped TEXT
  )`);
  const upsertBirthSeason = db.prepare(
    `INSERT INTO horse_birth_season (code, birth_season, current_age, scraped)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       birth_season = excluded.birth_season,
       current_age = excluded.current_age,
       scraped = excluded.scraped`,
  );
  const seasonYearOf = (iso: string): number => {
    const y = parseInt(iso.slice(0, 4), 10);
    const m = parseInt(iso.slice(5, 7), 10);
    return m >= 7 ? y : y - 1;
  };

  const upsertHorse = db.prepare(
    `INSERT INTO horses (id, name_en, name_ch, code, country_of_origin, colour, sex, import_type, sire, dam, dam_sire, current_rating, status, age, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
       age = COALESCE(excluded.age, horses.age),
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
        // 出生地___馬齡 e.g. "澳洲 / 4" — CURRENT age at scrape time; only
        // populated for horses still in training (retired horses lose it on
        // the HKJC page). Stored raw; as-of conversion happens in dump-features.
        const ageMatch = (row['出生地___馬齡'] || '').match(/\/\s*(\d+)\s*$/);
        const currentAge = ageMatch ? parseInt(ageMatch[1], 10) : null;
        // ⑨ collision-free age store (works even when the horses UPSERT below
        // fails on the prefixed-row UNIQUE(code) collision in the bulk build).
        if (currentAge != null) {
          const scrapedIso = parseHKDate(row['profile_last_scraped']);
          if (scrapedIso && /^\d{4}-\d{2}-\d{2}/.test(scrapedIso)) {
            upsertBirthSeason.run(code, seasonYearOf(scrapedIso) - currentAge, currentAge, scrapedIso);
          }
        }

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
          currentAge,
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
