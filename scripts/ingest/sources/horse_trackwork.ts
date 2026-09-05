/**
 * Ingest horses/trackwork/trackwork_<CODE>.csv
 *
 * ACTUAL scraper format (HorseTrackwork_Scraper.py, verified 2026-09-05):
 *   horse_no, date, work_type, racecourse, track, venue, distance, time,
 *   time_sec, splits, partner, rider, placing, comment, gear, workout_details
 *
 * Historical bug (fixed 2026-09-05): this ingest only read the column names
 * `venue/batch/distance/time/partner/comment`, none of which the scraper ever
 * wrote. Result: 134,859 rows in horse_trackwork with EVERY detail column NULL
 * — the horse page could only show dates. We now read the real column names and
 * additionally parse HKJC's free-text 操練詳情 for older CSVs that predate the
 * scraper's structured columns.
 *
 * 操練詳情 shapes (all parsed below):
 *   快操   "29.6 25.0 (54.6) (助手)"
 *   試閘   "第2組 (徐君禮) 1200M 皮具伯樂 25.3 22.9 23.0 (1.11.22)"
 *   出賽   "1650M (潘頓) (5/14)"
 *   踱步   "內圈 快踱一圈 (助手)"
 *
 * UPSERT key: id (deterministic hash of horse + date + venue + distance +
 * time + work_type + raw details). work_type/details are part of the hash
 * because a horse commonly has several sessions on one morning (游水 + 踱步)
 * that share NULL distance/time — without them they collapsed into one row.
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
  const m = filename.match(/^trackwork_([A-Z0-9]+)\.csv$/i);
  return m ? m[1].toUpperCase() : null;
}

const NA = new Set(['', 'nan', 'NaN', 'None', 'null', '-', '--']);
function clean(v: string | undefined | null): string {
  const s = (v ?? '').trim();
  return NA.has(s) ? '' : s;
}

const PAREN_RE = /[(（]([^)）]*)[)）]/g;
const DIST_RE = /(\d{3,4})\s*[Mm]/;
const GROUP_RE = /第\s*(\d+)\s*組/;
const PLACING_RE = /^\d+\s*\/\s*\d+$/;
const TIME_RE = /^\d+(?:[.:]\d+){1,2}$/;
const SPLIT_RE = /(?<![\d.])(\d{1,2}\.\d)(?![\d])/g;

export interface ParsedDetails {
  distance: string;
  time: string;
  splits: string;
  partner: string;
  rider: string;
  placing: string;
  comment: string;
}

/** Port of parse_workout_details() in HorseTrackwork_Scraper.py — keep in sync. */
export function parseWorkoutDetails(workType: string, track: string, details: string): ParsedDetails {
  const out: ParsedDetails = {
    distance: '', time: '', splits: '', partner: '', rider: '', placing: '', comment: '',
  };
  const text = (details || '').trim();
  if (!text) return out;

  const parens = [...text.matchAll(PAREN_RE)].map((m) => m[1].trim()).filter(Boolean);
  let rest = text.replace(PAREN_RE, ' ');

  for (const p of parens) {
    if (PLACING_RE.test(p)) out.placing = p.replace(/\s+/g, '');
    else if (TIME_RE.test(p)) out.time = p;
    else if (!out.rider) out.rider = p;
  }

  const dm = rest.match(DIST_RE);
  if (dm) {
    out.distance = `${dm[1]}M`;
    rest = rest.replace(dm[0], ' ');
  }

  const splits = [...rest.matchAll(SPLIT_RE)].map((m) => m[1]);
  if (splits.length) {
    out.splits = splits.join(' ');
    for (const sp of splits) rest = rest.replace(sp, ' ');
  }
  if (!out.time && splits.length) {
    out.time = splits.length > 1
      ? splits.reduce((a, b) => a + parseFloat(b), 0).toFixed(1)
      : splits[0];
  }

  const gm = rest.match(GROUP_RE);
  if (gm) rest = rest.replace(gm[0], ' ');

  let leftover = rest.split(/\s+/).filter(Boolean).join(' ');
  if (track && leftover.startsWith(track)) leftover = leftover.slice(track.length).trim();
  leftover = leftover.replace(/^[\s\-－·]+|[\s\-－·]+$/g, '').trim();

  if ((workType === '試閘' || workType === '出賽') && leftover) out.partner = leftover;
  else out.comment = leftover;
  if (gm) out.comment = (`第${gm[1]}組 ` + out.comment).trim();
  return out;
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
    inserted: 0, updated: 0, skipped: 0, failed: 0, horsesProcessed: 0,
  };

  const upsert = db.prepare(
    `INSERT INTO horse_trackwork
       (id, horse_id, trackwork_date, venue, batch, distance, time_text, time_sec,
        partner, comment, work_type, track, rider, splits, gear, placing, details,
        source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       venue = excluded.venue,
       batch = excluded.batch,
       distance = excluded.distance,
       time_text = excluded.time_text,
       time_sec = excluded.time_sec,
       partner = excluded.partner,
       comment = excluded.comment,
       work_type = excluded.work_type,
       track = excluded.track,
       rider = excluded.rider,
       splits = excluded.splits,
       gear = excluded.gear,
       placing = excluded.placing,
       details = excluded.details,
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
        const rawDate = clean(r['date']) || clean(r['trackwork_date']) || clean(r['日期']);
        const isoDate = parseHKDate(rawDate);
        if (!isoDate) {
          stats.skipped++;
          continue;
        }

        const workType = clean(r['work_type']) || clean(r['晨操類別']) || clean(r['batch']);
        const racecourse = clean(r['racecourse']) || clean(r['馬場']);
        const track = clean(r['track']) || clean(r['跑道']);
        const details = clean(r['workout_details']) || clean(r['操練詳情']) || clean(r['details']);
        const gear = clean(r['gear']) || clean(r['配備']);

        // Structured columns win when present; otherwise parse the raw details.
        const p = parseWorkoutDetails(workType, track, details);
        const venue = clean(r['venue']) || [racecourse, track].filter(Boolean).join(' ');
        const distance = clean(r['distance']) || clean(r['距離']) || p.distance;
        const timeText = clean(r['time']) || clean(r['時間']) || p.time;
        const timeSec = parseTrackworkTime(timeText);
        const partner = clean(r['partner']) || clean(r['合操']) || p.partner;
        const rider = clean(r['rider']) || p.rider;
        const splits = clean(r['splits']) || p.splits;
        const placing = clean(r['placing']) || p.placing;
        const comment = clean(r['comment']) || clean(r['備註']) || p.comment || workType;

        const id = trackworkId(horseCode, isoDate, venue, distance, timeText, workType, details);
        upsert.run(
          id,
          `horse_${horseCode}`,
          isoDate,
          venue || null,
          workType || null,
          distance || null,
          timeText || null,
          timeSec,
          partner || null,
          comment || null,
          workType || null,
          track || null,
          rider || null,
          splits || null,
          gear || null,
          placing || null,
          details || null,
          sourceCommit,
        );
        stats.inserted++;
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
