/**
 * Ingest trials/trial_sessions.csv + trials/trial_results.csv
 * Writes to trial_sessions + trial_runners
 */
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';
import {
  parseHKDate,
  parseFinishTime,
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

  // Then runners. HK barrier trials carry NO official finishing place, but the
  // de-facto order within a session is the finish time (also matches the last
  // token of running_position). So GROUP rows by session, rank by finish time
  // ascending -> finishing_position 1..N, and record total_runners. horse_id is
  // stored PREFIXED ('horse_<code>') to match horses.id / race_results.horse_id
  // in both bulk-local.db (training) and D1, so feature joins are direct.
  type TrialEntry = { horseCode: string; timeSec: number | null; row: Record<string, string> };
  const bySession = new Map<string, TrialEntry[]>();
  for (const row of resultRows) {
    const dateIso = parseHKDate(row['trial_date']);
    const venue = row['trial_venue'] || null;
    const groupNo = parseInt10(row['group_no']);
    const horseCode = (row['horse_no'] || '').trim();
    if (!dateIso || groupNo == null || !horseCode) {
      runnerStats.skipped++;
      continue;
    }
    const sessionId = trialSessionId(dateIso, venue, groupNo);
    let arr = bySession.get(sessionId);
    if (!arr) {
      arr = [];
      bySession.set(sessionId, arr);
    }
    arr.push({ horseCode, timeSec: parseFinishTime(row['finish_time'] || null), row });
  }

  const updateSessionTotal = db.prepare(
    `UPDATE trial_sessions SET total_runners = ? WHERE id = ?`,
  );

  const runnerTx = db.transaction(() => {
    for (const [sessionId, entries] of bySession) {
      // rank by finish time ascending; rows without a parseable time sort last
      // and receive a null finishing_position (their order is untrustworthy).
      const ranked = entries
        .map((e, i) => ({ ...e, i }))
        .sort((a, b) => {
          if (a.timeSec == null && b.timeSec == null) return a.i - b.i;
          if (a.timeSec == null) return 1;
          if (b.timeSec == null) return -1;
          if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
          return a.i - b.i;
        });
      const total = ranked.length;
      updateSessionTotal.run(total, sessionId);
      ranked.forEach((e, idx) => {
        try {
          const finishPos = e.timeSec == null ? null : idx + 1;
          upsertRunner.run(
            trialRunnerId(sessionId, e.horseCode),
            sessionId,
            `horse_${e.horseCode}`,
            null, // horse_number not explicitly in CSV
            finishPos,
            e.row['finish_time'] || null,
            e.timeSec,
            e.row['jockey'] || null,
            e.row['lbw'] || null,
            e.row['gear'] || null,
            e.row['commentary'] || null,
          );
          runnerStats.inserted++;
        } catch (err) {
          runnerStats.failed++;
          console.error('[trial_runners] failed row', e.horseCode, err);
        }
      });
    }
  });

  runnerTx();

  return { sessions: sessionStats, runners: runnerStats };
}

// Silence unused import warning during scaffolding (used when surface normalization re-added)
void normalizeVenue;
