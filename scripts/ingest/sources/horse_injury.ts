/**
 * Ingest horses/injury/injury_<CODE>.csv
 *
 * Expected Replit schema:
 *   horse_code, date, injury_type, resolution_date, description
 *
 * `days_out` is auto-computed = resolution_date - date (NULL if ongoing).
 * UPSERT key: UNIQUE(horse_id, injury_date, injury_type)
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import { parseHKDate, daysBetween } from '../lib/parsers.js';
import { injuryId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  horsesProcessed: number;
}

function extractHorseCode(filename: string): string | null {
  const m = filename.match(/^injury_([A-Z0-9]+)\.csv$/i);
  return m ? m[1].toUpperCase() : null;
}

export function ingestHorseInjury(
  db: DB,
  injuryDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files = readdirSync(injuryDir).filter(
    (f) => f.startsWith('injury_') && f.endsWith('.csv'),
  );
  const stats: IngestStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    horsesProcessed: 0,
  };

  const upsert = db.prepare(
    `INSERT INTO horse_injury
       (id, horse_id, injury_date, injury_type, resolution_date, days_out,
        description, source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id, injury_date, injury_type) DO UPDATE SET
       resolution_date = excluded.resolution_date,
       days_out = excluded.days_out,
       description = excluded.description,
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
      rows = parseCsv(join(injuryDir, file));
    } catch (err) {
      stats.failed++;
      console.error(`[injury] parse ${file}:`, err);
      continue;
    }

    const tx = db.transaction(() => {
      for (const r of rows) {
        const rawDate = r['date'] || r['injury_date'] || r['日期'] || '';
        const isoDate = parseHKDate(rawDate);
        if (!isoDate) {
          stats.skipped++;
          continue;
        }
        const injuryType = r['injury_type'] || r['type'] || r['類別'] || r['種類'] || '';
        if (!injuryType) {
          stats.skipped++;
          continue;
        }
        const resRaw = r['resolution_date'] || r['resolved_at'] || r['復出日期'] || '';
        const resIso = parseHKDate(resRaw);
        const description = r['description'] || r['備註'] || r['說明'] || null;
        const daysOut = daysBetween(isoDate, resIso);

        const id = injuryId(horseCode, isoDate, injuryType);
        try {
          upsert.run(
            id,
            horseCode,
            isoDate,
            injuryType,
            resIso,
            daysOut,
            description,
            sourceCommit,
          );
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          console.error(`[injury] row ${horseCode} ${isoDate}:`, err);
        }
      }
    });

    try {
      tx();
    } catch (err) {
      stats.failed++;
      console.error(`[injury] tx ${file}:`, err);
    }
  }

  return stats;
}
