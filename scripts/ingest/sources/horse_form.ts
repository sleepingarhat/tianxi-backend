/**
 * Ingest horses/form_records/form_<CODE>.csv (3000+ files)
 * Writes to horse_form_records (horse-centric staging)
 * Does NOT touch race_results (race-centric normalized) — that's a separate reconciliation step
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import {
  parseHKDate,
  parseFinishTime,
  parsePosition,
  parseInt10,
  parseFloat10,
  normalizeVenue,
} from '../lib/parsers.js';
import { formRecordId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  horsesProcessed: number;
}

export function ingestHorseFormRecords(
  db: DB,
  formRecordsDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files = readdirSync(formRecordsDir).filter((f) => f.startsWith('form_') && f.endsWith('.csv'));
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0, horsesProcessed: 0 };

  const upsert = db.prepare(
    `INSERT INTO horse_form_records
       (id, horse_id, race_date, venue, race_number, race_index_no, race_class, distance, going, track, course,
        finishing_position, finishing_position_num, total_runners, draw, horse_number,
        actual_weight, declared_weight, jockey_name, trainer_name, lbw, running_position,
        finish_time, finish_time_sec, win_odds, gear, rating, source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id, race_date, venue, race_number) DO UPDATE SET
       race_index_no = excluded.race_index_no,
       race_class = excluded.race_class,
       distance = excluded.distance,
       going = excluded.going,
       track = excluded.track,
       course = excluded.course,
       finishing_position = excluded.finishing_position,
       finishing_position_num = excluded.finishing_position_num,
       draw = excluded.draw,
       horse_number = excluded.horse_number,
       actual_weight = excluded.actual_weight,
       declared_weight = excluded.declared_weight,
       jockey_name = excluded.jockey_name,
       trainer_name = excluded.trainer_name,
       lbw = excluded.lbw,
       running_position = excluded.running_position,
       finish_time = excluded.finish_time,
       finish_time_sec = excluded.finish_time_sec,
       win_odds = excluded.win_odds,
       gear = excluded.gear,
       rating = excluded.rating,
       source_commit = excluded.source_commit,
       ingested_at = datetime('now')`,
  );

  for (const file of files) {
    const horseCode = file.replace(/^form_/, '').replace(/\.csv$/, '');
    stats.horsesProcessed++;
    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(join(formRecordsDir, file));
    } catch (err) {
      stats.failed++;
      // eslint-disable-next-line no-console
      console.error(`[horse_form] failed to parse ${file}:`, err);
      continue;
    }

    const tx = db.transaction((batch: typeof rows) => {
      for (const row of batch) {
        try {
          const dateIso = parseHKDate(row['date']);
          if (!dateIso) {
            stats.skipped++;
            continue;
          }
          const venue = normalizeVenue(row['racecourse']);
          const raceIndex = row['race_index'] || '';
          const distance = parseInt10(row['distance_m']);
          const finishTime = row['finish_time'] || null;
          const horseNo = row['horse_no'] || horseCode;

          const id = formRecordId(horseCode, dateIso, venue, raceIndex);

          upsert.run(
            id,
            horseCode,
            dateIso,
            venue,
            parseInt10(raceIndex),
            raceIndex || null,
            row['race_class'] || null,
            distance,
            row['going'] || null,
            row['track'] || null,
            row['course'] || null,
            row['place'] || null,
            parsePosition(row['place']),
            null, // total_runners not in form CSV
            parseInt10(row['draw']),
            parseInt10(horseNo.replace(/[^0-9]/g, '')) ?? null,
            parseFloat10(row['actual_wt_lbs']),
            parseFloat10(row['declared_wt_lbs']),
            row['jockey'] || null,
            row['trainer'] || null,
            row['lbw'] || null,
            row['running_position'] || null,
            finishTime,
            parseFinishTime(finishTime),
            parseFloat10(row['win_odds']),
            row['gear'] || null,
            parseInt10(row['rating']),
            sourceCommit,
          );

          stats.inserted++;
        } catch (err) {
          stats.failed++;
          // eslint-disable-next-line no-console
          console.error(`[horse_form] failed row in ${file}:`, err);
        }
      }
    });

    tx(rows);
  }

  return stats;
}
