/**
 * Ingest jockeys/records/jockey_<CODE>.csv
 * Each row = one ride. Aggregates into jockey_season_records + upserts raw into a helper table is NOT needed —
 * the ride-level detail already exists in race_results once form_records are reconciled.
 *
 * Strategy: collapse per-jockey per-season → jockey_season_records row.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import { parsePosition } from '../lib/parsers.js';
import { jockeySeasonId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  jockeysProcessed: number;
}

export function ingestJockeyRecords(
  db: DB,
  recordsDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files = readdirSync(recordsDir).filter((f) => f.startsWith('jockey_') && f.endsWith('.csv'));
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0, jockeysProcessed: 0 };

  const upsert = db.prepare(
    `INSERT INTO jockey_season_records
       (id, jockey_id, season, rides, wins, seconds, thirds, fourths, stakes_hkd, win_rate, top3_rate, source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(jockey_id, season) DO UPDATE SET
       rides = excluded.rides,
       wins = excluded.wins,
       seconds = excluded.seconds,
       thirds = excluded.thirds,
       fourths = excluded.fourths,
       win_rate = excluded.win_rate,
       top3_rate = excluded.top3_rate,
       source_commit = excluded.source_commit,
       ingested_at = datetime('now')`,
  );

  for (const file of files) {
    stats.jockeysProcessed++;
    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(join(recordsDir, file));
    } catch (err) {
      stats.failed++;
      console.error(`[jockey_records] failed to parse ${file}:`, err);
      continue;
    }

    if (rows.length === 0) continue;

    // Group by season
    const seasons = new Map<string, {
      jockeyCode: string;
      jockeyName: string;
      rides: number;
      wins: number;
      seconds: number;
      thirds: number;
      fourths: number;
    }>();

    for (const r of rows) {
      const season = r['season'] || 'Unknown';
      const code = r['jockey_code'] || '';
      if (!code) continue;
      const key = season;
      if (!seasons.has(key)) {
        seasons.set(key, {
          jockeyCode: code,
          jockeyName: r['jockey_name'] || code,
          rides: 0,
          wins: 0,
          seconds: 0,
          thirds: 0,
          fourths: 0,
        });
      }
      const agg = seasons.get(key)!;
      agg.rides++;
      const pos = parsePosition(r['place']);
      if (pos === 1) agg.wins++;
      else if (pos === 2) agg.seconds++;
      else if (pos === 3) agg.thirds++;
      else if (pos === 4) agg.fourths++;
    }

    const tx = db.transaction(() => {
      for (const [season, agg] of seasons) {
        try {
          const top3 = agg.wins + agg.seconds + agg.thirds;
          const winRate = agg.rides > 0 ? agg.wins / agg.rides : 0;
          const top3Rate = agg.rides > 0 ? top3 / agg.rides : 0;
          upsert.run(
            jockeySeasonId(agg.jockeyCode, season),
            agg.jockeyCode,
            season,
            agg.rides,
            agg.wins,
            agg.seconds,
            agg.thirds,
            agg.fourths,
            null, // stakes not in raw per-ride CSV
            winRate,
            top3Rate,
            sourceCommit,
          );
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          console.error(`[jockey_records] failed season ${season}:`, err);
        }
      }
    });
    tx();
  }

  return stats;
}
