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
  const firstValue = (row: Record<string, string>, ...keys: string[]): string | null => {
    for (const key of keys) {
      const value = (row[key] ?? '').trim();
      if (value) return value;
    }
    return null;
  };
  const countryOfOrigin = (row: Record<string, string>): string | null => {
    const direct = firstValue(row, '出生地');
    if (direct) return direct;
    const originAndAge = firstValue(row, '出生地___馬齡', '出生地 / 馬齡');
    return originAndAge?.split('/')[0]?.trim() || null;
  };

  const upsertHorse = db.prepare(
    `INSERT INTO horses (id, name_en, name_ch, code, country_of_origin, colour, sex, import_type,
                         sire, dam, dam_sire, current_trainer_id, current_rating, season_stakes, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name_ch = COALESCE(excluded.name_ch, horses.name_ch),
       country_of_origin = COALESCE(excluded.country_of_origin, horses.country_of_origin),
       colour = COALESCE(excluded.colour, horses.colour),
       sex = COALESCE(excluded.sex, horses.sex),
       import_type = COALESCE(excluded.import_type, horses.import_type),
       sire = COALESCE(excluded.sire, horses.sire),
       dam = COALESCE(excluded.dam, horses.dam),
       dam_sire = COALESCE(excluded.dam_sire, horses.dam_sire),
        current_trainer_id = COALESCE(excluded.current_trainer_id, horses.current_trainer_id),
       current_rating = COALESCE(excluded.current_rating, horses.current_rating),
        season_stakes = COALESCE(excluded.season_stakes, horses.season_stakes),
       status = COALESCE(excluded.status, horses.status),
       updated_at = datetime('now')`,
  );

  const upsertExtra = db.prepare(
    `INSERT INTO horse_profile_extra
       (horse_id, name_with_status, status, last_race_date, country_of_origin, colour_sex_raw,
         import_type, season_stakes_raw, season_stakes_int, total_stakes_raw, total_stakes_int,
         record_wins, record_seconds, record_thirds, record_total_starts, current_trainer,
         owner, last_rating, sire, dam, dam_sire, half_siblings,
         profile_last_scraped, profile_checked_at, source_commit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id) DO UPDATE SET
        name_with_status = COALESCE(excluded.name_with_status, horse_profile_extra.name_with_status),
        status = COALESCE(excluded.status, horse_profile_extra.status),
        last_race_date = COALESCE(excluded.last_race_date, horse_profile_extra.last_race_date),
        country_of_origin = COALESCE(excluded.country_of_origin, horse_profile_extra.country_of_origin),
        colour_sex_raw = COALESCE(excluded.colour_sex_raw, horse_profile_extra.colour_sex_raw),
        import_type = COALESCE(excluded.import_type, horse_profile_extra.import_type),
        season_stakes_raw = COALESCE(excluded.season_stakes_raw, horse_profile_extra.season_stakes_raw),
        season_stakes_int = COALESCE(excluded.season_stakes_int, horse_profile_extra.season_stakes_int),
        total_stakes_raw = COALESCE(excluded.total_stakes_raw, horse_profile_extra.total_stakes_raw),
        total_stakes_int = COALESCE(excluded.total_stakes_int, horse_profile_extra.total_stakes_int),
        record_wins = COALESCE(excluded.record_wins, horse_profile_extra.record_wins),
        record_seconds = COALESCE(excluded.record_seconds, horse_profile_extra.record_seconds),
        record_thirds = COALESCE(excluded.record_thirds, horse_profile_extra.record_thirds),
        record_total_starts = COALESCE(excluded.record_total_starts, horse_profile_extra.record_total_starts),
        current_trainer = COALESCE(excluded.current_trainer, horse_profile_extra.current_trainer),
        owner = COALESCE(excluded.owner, horse_profile_extra.owner),
        last_rating = COALESCE(excluded.last_rating, horse_profile_extra.last_rating),
        sire = COALESCE(excluded.sire, horse_profile_extra.sire),
        dam = COALESCE(excluded.dam, horse_profile_extra.dam),
        dam_sire = COALESCE(excluded.dam_sire, horse_profile_extra.dam_sire),
        half_siblings = COALESCE(excluded.half_siblings, horse_profile_extra.half_siblings),
        profile_last_scraped = COALESCE(excluded.profile_last_scraped, horse_profile_extra.profile_last_scraped),
        profile_checked_at = COALESCE(excluded.profile_checked_at, horse_profile_extra.profile_checked_at),
        source_commit = COALESCE(excluded.source_commit, horse_profile_extra.source_commit),
       updated_at = datetime('now')`,
  );

  const findHorseByCode = db.prepare(
    `SELECT id FROM horses
     WHERE code = ?
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  );
  const findTrainerByName = db.prepare(
    `SELECT id FROM trainers
     WHERE name_ch = ? OR name_en = ?
     LIMIT 1`,
  );
  const migrateLegacyHorseId = db.transaction((legacyId: string, canonicalId: string) => {
    if (legacyId === canonicalId) return;
    const canonicalExists = db.prepare('SELECT 1 FROM horses WHERE id = ?').get(canonicalId);
    if (canonicalExists) {
      throw new Error(
        `cannot canonicalize ${legacyId}: target ${canonicalId} already exists`,
      );
    }
    const tables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (name === 'horses') continue;
      const safeTable = `"${name.replace(/"/g, '""')}"`;
      const hasHorseId = (
        db.prepare(`PRAGMA table_info(${safeTable})`).all() as Array<{ name: string }>
      ).some((column) => column.name === 'horse_id');
      if (hasHorseId) {
        db.prepare(`UPDATE ${safeTable} SET horse_id = ? WHERE horse_id = ?`)
          .run(canonicalId, legacyId);
      }
    }
    db.prepare('UPDATE horses SET id = ? WHERE id = ?').run(canonicalId, legacyId);
  });

  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      try {
        const code = (row['horse_no'] || '').trim();
        if (!code) {
          stats.skipped++;
          continue;
        }
        const canonicalId = `horse_${code}`;
        const existingHorse = findHorseByCode.get(code, canonicalId) as { id: string } | undefined;
        if (existingHorse?.id && existingHorse.id !== canonicalId) {
          migrateLegacyHorseId(existingHorse.id, canonicalId);
        }
        const id = canonicalId;
        const name = (row['name'] || '').trim();
        const colourSexRaw = firstValue(row, '毛色___性別', '毛色 / 性別');
        const { colour, sex } = parseColourSex(colourSexRaw);
        const recordRaw = firstValue(
          row,
          '冠-亞-季-總出賽次數',
          '冠-亞-季-總出賽次數*',
          '冠-亞-季-總出賽次數＊',
        );
        const recBreak = parseRecordBreakdown(recordRaw);
        const status = normalizeStatus(row['status']);
        const lastRating = parseFloat10(firstValue(row, '最後評分', '現時評分'));
        const totalStakesRaw = firstValue(row, '總獎金', '總獎金*', '總獎金＊');
        const seasonStakesRaw = firstValue(row, '今季獎金', '今季獎金*', '今季獎金＊');
        const trainerName = firstValue(row, '練馬師');
        const trainer = trainerName
          ? findTrainerByName.get(trainerName, trainerName) as { id: string } | undefined
          : undefined;
        const origin = countryOfOrigin(row);
        const importType = firstValue(row, '進口類別');
        const sire = firstValue(row, '父系');
        const dam = firstValue(row, '母系');
        const damSire = firstValue(row, '外祖父');

        upsertHorse.run(
          id,
          name || code,
          name || null,
          code,
          origin,
          colour,
          sex,
          importType,
          sire,
          dam,
          damSire,
          trainer?.id ?? null,
          lastRating != null ? Math.round(lastRating) : null,
          parseStakesInt(seasonStakesRaw),
          status,
        );

        upsertExtra.run(
          id,
          name || null,
          status,
          parseHKDate(row['last_race_date']),
          origin,
          colourSexRaw,
          importType,
          seasonStakesRaw,
          parseStakesInt(seasonStakesRaw),
          totalStakesRaw,
          parseStakesInt(totalStakesRaw),
          recBreak.wins,
          recBreak.seconds,
          recBreak.thirds,
          recBreak.total,
          trainerName,
          firstValue(row, '馬主'),
          lastRating,
          sire,
          dam,
          damSire,
          firstValue(row, '同父系馬'),
          parseHKDate(firstValue(row, 'profile_last_scraped', 'profile_checked_at')),
          firstValue(row, 'profile_checked_at')
            ?? firstValue(row, 'profile_last_scraped'),
          sourceCommit,
        );

        if (existingHorse) stats.updated++;
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
