/**
 * Ingest entries/entries_<date>.txt — forward-only upcoming racecards
 *
 * Format observed (2026-04-21):
 *   # meeting=2026-04-22 racecourse=HV written=2026-04-21
 *   E175
 *   G125
 *   ...
 *
 * Each line after the header is a horse code entered in some race of that meeting.
 * HKJC does NOT archive historical entries, so this is forward-only capture.
 *
 * NOTE (2026-04-21): current format is race-less — just flat horse list per meeting.
 * Replit will enrich with race_number/draw/jockey once scraped.
 * This ingestion writes a minimal row-per-horse per meeting and leaves race_number
 * NULL to be reconciled when richer data arrives.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../lib/db.js';
import { readTxtLines } from '../lib/csv.js';
import { entryId } from '../lib/ids.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  filesProcessed: number;
}

interface Header {
  meeting: string | null;
  racecourse: string | null;
  written: string | null;
}

function parseHeader(line: string): Header {
  const h: Header = { meeting: null, racecourse: null, written: null };
  if (!line.startsWith('#')) return h;
  const re = /(\w+)=([\S]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === 'meeting') h.meeting = m[2];
    else if (m[1] === 'racecourse') h.racecourse = m[2];
    else if (m[1] === 'written') h.written = m[2];
  }
  return h;
}

export function ingestEntries(
  db: DB,
  entriesDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files = readdirSync(entriesDir).filter((f) => f.startsWith('entries_') && f.endsWith('.txt'));
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0, filesProcessed: 0 };

  const upsert = db.prepare(
    `INSERT INTO entries_upcoming
       (id, race_date, venue, race_number, horse_id, horse_number, horse_code, scraped_at, source_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(race_date, venue, race_number, horse_number) DO UPDATE SET
       horse_id = excluded.horse_id,
       horse_code = excluded.horse_code,
       scraped_at = excluded.scraped_at,
       source_commit = excluded.source_commit`,
  );

  // Pre-race meeting placeholder — lets /api/meetings/smart/current surface
  // future race days before results scraper backfills track_condition / total_races.
  // Non-destructive: post-race ingest owns the details columns and will overwrite.
  const upsertMeeting = db.prepare(
    `INSERT INTO race_meetings (id, date, venue)
     VALUES (?, ?, ?)
     ON CONFLICT(date, venue) DO NOTHING`,
  );

  // Stub horse row — unblocks FK in entries_upcoming.horse_id when the horse
  // has not yet appeared in race_results/pool-a ingests (e.g. first-time
  // entrant debuting on the upcoming card). We insert id + code + name only;
  // richer fields (colour/sex/age/owner) land later via horse profile scraper.
  const upsertHorseStub = db.prepare(
    `INSERT INTO horses (id, code, name)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const file of files) {
    stats.filesProcessed++;
    try {
      const lines = readTxtLines(join(entriesDir, file));
      if (lines.length === 0) continue;
      const header = parseHeader(lines[0]);
      const meeting = header.meeting;
      const venue = header.racecourse;
      if (!meeting || !venue) {
        stats.skipped++;
        continue;
      }

      const horses = lines.slice(1).filter((l) => !l.startsWith('#'));

      const tx = db.transaction(() => {
        // Seed race_meetings so home page can surface this future meeting
        // via /api/meetings/smart/current before results scraper runs.
        upsertMeeting.run(`${meeting}_${venue}`, meeting, venue);

        // Flat list — assign race_number = 0 sentinel (unknown), horse_number = index+1
        // When Replit enriches with real race/draw data, UPSERT keys become stable
        for (let i = 0; i < horses.length; i++) {
          const code = horses[i];
          const horseNo = i + 1;
          const raceNo = 0; // sentinel: unknown race in current txt format
          const id = entryId(meeting, venue, raceNo, horseNo);
          try {
            // Seed horses stub so downstream FK (entries_upcoming.horse_id →
            // horses.id) can resolve in D1 even for debut entrants. D1 stores
            // horses.id as prefixed 'horse_<code>'; match that here.
            upsertHorseStub.run(`horse_${code}`, code, code);
            upsert.run(
              id,
              meeting,
              venue,
              raceNo,
              code, // horse_id = code (convention); push-delta prefixes to horse_<code> for D1
              horseNo,
              code,
              header.written,
              sourceCommit,
            );
            stats.inserted++;
          } catch (err) {
            stats.failed++;
            console.error(`[entries] failed row ${code} in ${file}:`, err);
          }
        }
      });
      tx();
    } catch (err) {
      stats.failed++;
      console.error(`[entries] failed to read ${file}:`, err);
    }
  }

  return stats;
}
