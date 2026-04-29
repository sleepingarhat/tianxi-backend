/**
 * Ingest horses/trackwork/trackwork_<CODE>.csv
 *
 * Replit-confirmed 7-column format (晨操):
 *   horse_code, date, venue, batch, distance, time, partner, comment
 *   (optional 8th: horse_name — harmlessly ignored)
 *
 * Time field may be:
 *   - structured: '0.36.80' / '1.02.30' (MIN.SEC.HUND) → parsed to seconds
 *   - text: 'slow' / '慢跑' / 'gallops' → stored raw in time_text, time_sec = NULL
 *
 * UPSERT key: UNIQUE(horse_id, trackwork_date, venue, distance, time_text)
 * Fallback: if venue missing, that column is NULL in the key tuple.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import { parseHKDate, parseTrackworkTime } from '../lib/parsers.js';
import { trackworkId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  horsesProcessed: number;
}

function extractHorseCode(filename: string): string | null {
  // trackwork_A123.csv → A123 | trackwork_B1234.csv → B1234
  const m = filename.match(/^trackwork_([A-Z0-9]+)\.csv$/i);
  return m ? m[1].toUpperCase() : null;
}

export function ingestHorseTrackwork(
  db: DB,
  trackworkDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files = readdirSync(trackworkDir).filter(
    (f) => f.startsWith('trackwork_') && f.endsWith('.csv'),
  );
  const stats: IngestStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    horsesProcessed: 0,
  };

  const upsert = db.prepare(
    `INSERT INTO horse_trackwork
       (id, horse_id, trackwork_date, venue, batch, distance, time_text, time_sec,
        partner, comment, source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id, trackwork_date, venue, distance, time_text) DO UPDATE SET
       batch = excluded.batch,
       time_sec = excluded.time_sec,
       partner = excluded.partner,
       comment = excluded.comment,
       source_commit = excluded.source_commit,
       ingested_at = datetime('now')`,
  );

  for (const file of files) {
    stats.horsesProcessed++;
    const horseCode = extractHorseCode(file);
    if (!horseCode) {
      stats.skipped++;
      continue;
    }

    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(join(trackworkDir, file));
    } catch (err) {
      stats.failed++;
      console.error(`[trackwork] parse ${file}:`, err);
      continue;
    }

    const tx = db.transaction(() => {
      for (const r of rows) {
        // Tolerant column aliases — different scrapers may slightly vary
        const rawDate = r['date'] || r['trackwork_date'] || r['日期'] || '';
        const isoDate = parseHKDate(rawDate);
        if (!isoDate) {
          stats.skipped++;
          continue;
        }
        const venue = r['venue'] || r['場地'] || null;
        const batch = r['batch'] || r['批次'] || null;
        const distance = r['distance'] || r['距離'] || null;
        const timeText = r['time'] || r['時間'] || null;
        const timeSec = parseTrackworkTime(timeText);
        const partner = r['partner'] || r['合操'] || null;
        const comment = r['comment'] || r['備註'] || null;

        const id = trackworkId(horseCode, isoDate, venue, distance, timeText);
        try {
          upsert.run(
            id,
            horseCode,
            isoDate,
            venue,
            batch,
            distance,
            timeText,
            timeSec,
            partner,
            comment,
            sourceCommit,
          );
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          console.error(`[trackwork] row ${horseCode} ${isoDate}:`, err);
        }
      }
    });

    try {
      tx();
    } catch (err) {
      stats.failed++;
      console.error(`[trackwork] tx ${file}:`, err);
    }
  }

  return stats;
}
