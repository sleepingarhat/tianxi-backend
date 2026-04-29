/**
 * Ingest trials/trial_sessions.csv + trials/trial_results.csv
 * Writes to trial_sessions + trial_runners
 */
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import {
  parseHKDate,
  parseFinishTime,
  parsePosition,
  parseInt10,
  normalizeVenue,
} from '../lib/parsers.js';
import { trialSessionId, trialRunnerId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function ingestTrials(
  db: DB,
  sessionsPath: string,
  resultsPath: string,
  sourceCommit: string | null,
): { sessions: IngestStats; runners: IngestStats } {
  const sessionRows = parseCsv(sessionsPath);
  const resultRows = parseCsv(resultsPath);

  const sessionStats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  const runnerStats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

  const upsertSession = db.prepare(
    `INSERT INTO trial_sessions (id, trial_date, venue, session_number, distance, going, track, total_runners, source_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trial_date, venue, session_number) DO UPDATE SET
       distance = excluded.distance,
       going = excluded.going,
       track = excluded.track,
       total_runners = excluded.total_runners,
       source_commit = excluded.source_commit`,
  );

  const upsertRunner = db.prepare(
    `INSERT INTO trial_runners
       (id, session_id, horse_id, horse_number, finishing_position, time_text, time_sec,
        jockey_name, lbw, gear, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, horse_id) DO UPDATE SET
       finishing_position = excluded.finishing_position,
       time_text = excluded.time_text,
       time_sec = excluded.time_sec,
       jockey_name = excluded.jockey_name,
       lbw = excluded.lbw,
       gear = excluded.gear,
       comment = excluded.comment`,
  );

  // Sessions first
  const sessionTx = db.transaction((batch: typeof sessionRows) => {
    for (const row of batch) {
      try {
        const dateIso = parseHKDate(row['trial_date']);
        if (!dateIso) {
          sessionStats.skipped++;
          continue;
        }
        const venue = row['trial_venue'] || null;
        const groupNo = parseInt10(row['group_no']);
        if (groupNo == null) {
          sessionStats.skipped++;
          continue;
        }
        const id = trialSessionId(dateIso, venue, groupNo);
        const track = venue && venue.includes('全天候') ? 'awt' : 'turf';

        upsertSession.run(
          id,
          dateIso,
          venue,
          groupNo,
          parseInt10(row['distance_m']),
          row['going'] || null,
          track,
          null, // total_runners computed from results
          sourceCommit,
        );
        sessionStats.inserted++;
      } catch (err) {
        sessionStats.failed++;
        console.error('[trials_sessions] failed row', row['trial_date'], err);
      }
    }
  });

  sessionTx(sessionRows);

  // Then runners
  const runnerTx = db.transaction((batch: typeof resultRows) => {
    for (const row of batch) {
      try {
        const dateIso = parseHKDate(row['trial_date']);
        if (!dateIso) {
          runnerStats.skipped++;
          continue;
        }
        const venue = row['trial_venue'] || null;
        const groupNo = parseInt10(row['group_no']);
        if (groupNo == null) {
          runnerStats.skipped++;
          continue;
        }
        const sessionId = trialSessionId(dateIso, venue, groupNo);
        const horseCode = (row['horse_no'] || '').trim();
        if (!horseCode) {
          runnerStats.skipped++;
          continue;
        }
        const finishTime = row['finish_time'] || null;

        upsertRunner.run(
          trialRunnerId(sessionId, horseCode),
          sessionId,
          horseCode,
          null, // horse_number not explicitly in CSV
          parsePosition(row['draw']), // note: trials don't have finishing_position per se, use draw as placeholder TODO verify
          finishTime,
          parseFinishTime(finishTime),
          row['jockey'] || null,
          row['lbw'] || null,
          row['gear'] || null,
          row['commentary'] || null,
        );
        runnerStats.inserted++;
      } catch (err) {
        runnerStats.failed++;
        console.error('[trial_runners] failed row', row['horse_no'], err);
      }
    }
  });

  runnerTx(resultRows);

  return { sessions: sessionStats, runners: runnerStats };
}

// Silence unused import warning during scaffolding (used when surface normalization re-added)
void normalizeVenue;
