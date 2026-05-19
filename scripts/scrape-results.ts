#!/usr/bin/env tsx
/**
 * HKJC race results scraper.
 *
 * Fetches LocalResults pages for a given meeting, parses race header +
 * results table, and emits a single .sql file with INSERT statements
 * suitable for `wrangler d1 execute tianxi-db --remote --file=...`.
 *
 * Usage:
 *   tsx scripts/scrape-results.ts --date=YYYY-MM-DD --venue=ST|HV \
 *     [--out=/tmp/results-{date}-{venue}.sql] [--max-races=14] [--min-races=8]
 *
 * Safety:
 *   - All writes wrapped in BEGIN / COMMIT for atomicity.
 *   - Refuses to write if races_parsed < --min-races (prevents partial ingest
 *     from regressing race_meetings.total_races on transient HKJC outages).
 *   - race_meetings.total_races never decreases: uses MAX(existing, new).
 *   - Tolerant fetch loop: tries up to 3 consecutive misses before stopping
 *     (some racecards have non-contiguous numbering after scratches).
 *
 * ID conventions (match existing data):
 *   horses.id   = 'horse_' + last token of HKJC horseid (HK_2023_J182 → horse_J182)
 *   jockeys.id  = 'jockey_' + name_ch
 *   trainers.id = 'trainer_' + name_ch
 *   races.id           = 'race_{date}_{venue}_{N}'
 *   race_meetings.id   = '{date}_{venue}'
 *   race_results.id    = 'result_{race_id}_{horse_number}'
 */
import { writeFileSync } from 'node:fs';

interface Args {
  date: string;
  venue: string;
  out: string;
  maxRaces: number;
  minRaces: number;
}

function parseArgs(): Args {
  const get = (k: string, d = '') => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const date = get('date');
  const venue = get('venue').toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad --date: ${date}`);
  if (!['ST', 'HV'].includes(venue)) throw new Error(`bad --venue: ${venue}`);
  return {
    date,
    venue,
    out: get('out', `/tmp/results-${date}-${venue}.sql`),
    maxRaces: Number(get('max-races', '14')),
    minRaces: Number(get('min-races', '8')),
  };
}

function esc(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Convert "1:50.43" → 110.43 seconds. */
function parseFinishTime(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d{2})\.(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3]}`);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Split combined "草地 - "C+3" 賽道" into {track, course}. */
function splitTrackCourse(s: string | null): { track: string | null; course: string | null } {
  if (!s) return { track: null, course: null };
  const t = s.trim();
  // "草地 - "C+3" 賽道" → track="草地", course=C+3
  const m = t.match(/^(.+?)\s*-\s*"?([^"]+?)"?\s*賽道\s*$/);
  if (m) return { track: m[1].trim(), course: m[2].trim() };
  // "全天候跑道" — no separator, no course
  return { track: t, course: null };
}

interface RaceHeader {
  race_number: number;
  klass: string | null;
  distance: number | null;
  going: string | null;
  track: string | null;
  course: string | null;
  prize: string | null;
  title: string | null;
}

interface RaceResultRow {
  finishing_position: number;
  horse_number: number | null;
  horse_id: string | null;
  horse_name_ch: string | null;
  horse_code: string | null;
  jockey_name: string | null;
  trainer_name: string | null;
  actual_weight: number | null;
  declared_weight: number | null;
  draw: number | null;
  lbw: string | null;
  running_position: string | null;
  finish_time: number | null;
  win_odds: number | null;
}

interface ParsedRace {
  header: RaceHeader;
  results: RaceResultRow[];
}

function parseRaceHeader(html: string, raceNumber: number): RaceHeader | null {
  const re = new RegExp(`第\\s*${raceNumber}\\s*場[\\s\\S]{0,5000}`);
  const m = html.match(re);
  if (!m) return null;
  const ctx = m[0];

  const detailM = ctx.match(/<td[^>]*>\s*([^<\s][^<]*?)\s*-\s*(\d+)米[^<]*<\/td>[\s\S]*?場地狀況[\s\S]*?<td[^>]*colspan="\d+">([^<]+)<\/td>/);
  const trackM = ctx.match(/<tr>\s*<td[^>]*>\s*([^<]+?)<\/td>[\s\S]*?賽道[\s\S]*?<td[^>]*colspan="\d+">\s*([^<]+?)\s*<\/td>/);
  const prizeM = ctx.match(/HK\$\s*([\d,]+)/);

  const tcRaw = trackM ? stripHtml(trackM[2]).replace(/&quot;/g, '"') : null;
  const { track, course } = splitTrackCourse(tcRaw);

  return {
    race_number: raceNumber,
    klass: detailM ? detailM[1].trim() : null,
    distance: detailM ? Number(detailM[2]) : null,
    going: detailM ? stripHtml(detailM[3]) : null,
    title: trackM ? stripHtml(trackM[1]) : null,
    track,
    course,
    prize: prizeM ? prizeM[1].replace(/,/g, '') : null,
  };
}

function parseResultsTable(html: string): RaceResultRow[] {
  const tableM = html.match(/<table[^>]*class="[^"]*table_bd[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) return [];
  const tbodyM = tableM[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbodyM) return [];
  const tbody = tbodyM[1];

  const rows: RaceResultRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let tm: RegExpExecArray | null;
  while ((tm = trRe.exec(tbody)) !== null) {
    const cells = [...tm[1].matchAll(/<td[\s\S]*?<\/td>/g)].map((c) => c[0]);
    if (cells.length < 8) continue;

    const posText = stripHtml(cells[0]);
    const pos = /^\d+$/.test(posText) ? Number(posText) : 999;
    const horseNumberText = stripHtml(cells[1]);
    const horse_number = /^\d+$/.test(horseNumberText) ? Number(horseNumberText) : null;

    const horseHrefM = cells[2].match(/horseid=([^"&]+)/);
    const horseLast = horseHrefM ? horseHrefM[1].split('_').pop() ?? null : null;
    const horseNameCh = (cells[2].match(/>([^<()]+?)<\/a>/) || [, null])[1];
    const horseCodeM = cells[2].match(/\(([A-Z0-9]+)\)/);

    const jockey = stripHtml(cells[3]) || null;
    const trainer = stripHtml(cells[4]) || null;
    const actualW = Number(stripHtml(cells[5]));
    const declaredW = Number(stripHtml(cells[6]));
    const draw = Number(stripHtml(cells[7]));
    const lbwRaw = cells.length > 8 ? stripHtml(cells[8]) : null;
    const lbw = lbwRaw && lbwRaw !== '---' ? lbwRaw : null;
    // running positions: nested <div> per leg, e.g. "3 1 1"
    const running_position = cells.length > 9
      ? (stripHtml(cells[9]).split(/\s+/).filter(Boolean).join('-') || null)
      : null;
    const finish_time = cells.length > 10 ? parseFinishTime(stripHtml(cells[10])) : null;
    const winOddsRaw = cells.length > 11 ? Number(stripHtml(cells[11])) : NaN;
    const win_odds = Number.isFinite(winOddsRaw) && winOddsRaw > 0 ? winOddsRaw : null;

    rows.push({
      finishing_position: pos,
      horse_number,
      horse_id: horseLast ? `horse_${horseLast}` : null,
      horse_name_ch: horseNameCh ? horseNameCh.trim() : null,
      horse_code: horseCodeM ? horseCodeM[1] : null,
      jockey_name: jockey && jockey !== '---' ? jockey : null,
      trainer_name: trainer && trainer !== '---' ? trainer : null,
      actual_weight: Number.isFinite(actualW) ? actualW : null,
      declared_weight: Number.isFinite(declaredW) ? declaredW : null,
      draw: Number.isFinite(draw) ? draw : null,
      lbw,
      running_position,
      finish_time,
      win_odds,
    });
  }
  return rows;
}

async function fetchRace(date: string, venue: string, raceNo: number): Promise<string | null> {
  const d = date.replace(/-/g, '/');
  const url = `https://racing.hkjc.com/racing/information/Chinese/Racing/LocalResults.aspx?RaceDate=${d}&Racecourse=${venue}&RaceNo=${raceNo}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const t = await r.text();
  if (t.length < 150000) return null;
  if (!t.includes('名次') || !/\d:\d{2}\.\d{2}/.test(t)) return null;
  return t;
}

async function main() {
  const a = parseArgs();
  console.error(`[results] scraping ${a.date} @ ${a.venue} (1..${a.maxRaces}, min=${a.minRaces})`);

  const meetingId = `${a.date}_${a.venue}`;
  const parsed: ParsedRace[] = [];

  // Tolerant loop: allow up to MAX_MISSES consecutive misses (race scratches /
  // transient errors) before giving up. HKJC race numbers are normally
  // contiguous but this guards against single-page transient failures.
  const MAX_MISSES = 2;
  let misses = 0;
  for (let n = 1; n <= a.maxRaces; n++) {
    const html = await fetchRace(a.date, a.venue, n);
    if (!html) {
      misses++;
      console.error(`[results] race ${n}: no page (miss ${misses}/${MAX_MISSES + 1})`);
      if (misses > MAX_MISSES) {
        console.error(`[results] ${misses} consecutive misses — stopping`);
        break;
      }
      continue;
    }
    misses = 0;
    const header = parseRaceHeader(html, n);
    if (!header) {
      console.error(`[results] race ${n}: header parse failed — skipping`);
      continue;
    }
    const results = parseResultsTable(html);
    if (results.length === 0) {
      console.error(`[results] race ${n}: zero result rows — skipping`);
      continue;
    }
    console.error(`[results] race ${n}: ${results.length} rows · ${header.klass} ${header.distance}m ${header.going} · ${header.track ?? '?'} ${header.course ?? ''}`);
    parsed.push({ header, results });
  }

  if (parsed.length === 0) {
    console.error('[results] NO races parsed — no SQL written, exit 0');
    process.exit(0);
  }

  // SAFETY GATE: refuse partial ingest below threshold to avoid regressing
  // race_meetings.total_races on transient HKJC outages.
  if (parsed.length < a.minRaces) {
    console.error(`[results] only ${parsed.length} races parsed (min ${a.minRaces}) — refusing partial write`);
    console.log(JSON.stringify({ ok: false, reason: 'below_min_races', races_parsed: parsed.length, min_races: a.minRaces }));
    process.exit(2);
  }

  const horses = new Map<string, { name_ch: string; code: string | null }>();
  const jockeys = new Map<string, string>();
  const trainers = new Map<string, string>();
  for (const p of parsed) {
    for (const r of p.results) {
      if (r.horse_id && r.horse_name_ch) horses.set(r.horse_id, { name_ch: r.horse_name_ch, code: r.horse_code });
      if (r.jockey_name) jockeys.set(`jockey_${r.jockey_name}`, r.jockey_name);
      if (r.trainer_name) trainers.set(`trainer_${r.trainer_name}`, r.trainer_name);
    }
  }

  const sql: string[] = [];
  sql.push(`-- HKJC race results · ${a.date} @ ${a.venue} · ${parsed.length} races · ${new Date().toISOString()}`);
  // Note: D1 wraps the whole --file in an atomic session automatically;
  // explicit BEGIN/COMMIT are rejected ("use state.storage.transaction()").

  for (const [id, h] of horses) {
    sql.push(`INSERT OR IGNORE INTO horses (id, name_en, name_ch, code) VALUES (${esc(id)}, ${esc(h.name_ch)}, ${esc(h.name_ch)}, ${esc(h.code)});`);
  }
  for (const [id, name] of jockeys) {
    sql.push(`INSERT OR IGNORE INTO jockeys (id, name_en, name_ch) VALUES (${esc(id)}, ${esc(name)}, ${esc(name)});`);
  }
  for (const [id, name] of trainers) {
    sql.push(`INSERT OR IGNORE INTO trainers (id, name_en, name_ch) VALUES (${esc(id)}, ${esc(name)}, ${esc(name)});`);
  }

  // race_meetings: never regress total_races (MAX of existing vs new)
  const firstGoing = parsed[0].header.going;
  // Guard against phantom meetings: only persist race_meetings if there is prior
  // evidence (entries_upcoming row OR existing race_meetings row). entries_upcoming
  // is retained for past dates so post-race ingestion still works; pure phantom
  // dates from stale HKJC results scrape have neither and get silently no-op'd.
  sql.push(
    `INSERT INTO race_meetings (id, date, venue, track_condition, total_races) ` +
    `SELECT ${esc(meetingId)}, ${esc(a.date)}, ${esc(a.venue)}, ${esc(firstGoing)}, ${parsed.length} ` +
    `WHERE EXISTS (SELECT 1 FROM entries_upcoming WHERE race_date = ${esc(a.date)} AND venue = ${esc(a.venue)}) ` +
    `   OR EXISTS (SELECT 1 FROM race_meetings    WHERE date      = ${esc(a.date)} AND venue = ${esc(a.venue)}) ` +
    `ON CONFLICT(date, venue) DO UPDATE SET ` +
    `total_races = MAX(COALESCE(race_meetings.total_races, 0), excluded.total_races), ` +
    `track_condition = COALESCE(race_meetings.track_condition, excluded.track_condition);`
  );

  // Gate races INSERT on meeting row existence (race_meetings INSERT above is itself
  // guarded by WHERE EXISTS, so if the meeting was skipped as phantom, races are too).
  for (const p of parsed) {
    const raceId = `race_${a.date}_${a.venue}_${p.header.race_number}`;
    sql.push(
      `INSERT OR REPLACE INTO races (id, meeting_id, race_number, title, class, distance, going, track, course, prize) ` +
      `SELECT ${esc(raceId)}, ${esc(meetingId)}, ${p.header.race_number}, ${esc(p.header.title)}, ` +
      `${esc(p.header.klass)}, ${p.header.distance ?? 'NULL'}, ${esc(p.header.going)}, ` +
      `${esc(p.header.track)}, ${esc(p.header.course)}, ${esc(p.header.prize)} ` +
      `WHERE EXISTS (SELECT 1 FROM race_meetings WHERE id = ${esc(meetingId)});`
    );
  }

  for (const p of parsed) {
    const raceId = `race_${a.date}_${a.venue}_${p.header.race_number}`;
    for (const r of p.results) {
      if (!r.horse_id || r.horse_number === null) continue;
      const resultId = `result_${raceId}_${r.horse_number}`;
      sql.push(
        `INSERT OR REPLACE INTO race_results ` +
        `(id, race_id, horse_id, horse_number, finishing_position, draw, jockey_id, trainer_id, ` +
        `actual_weight, declared_weight, lbw, running_position, finish_time, win_odds) ` +
        `SELECT ${esc(resultId)}, ${esc(raceId)}, ${esc(r.horse_id)}, ${r.horse_number}, ` +
        `${r.finishing_position}, ${r.draw ?? 'NULL'}, ` +
        `${esc(r.jockey_name ? `jockey_${r.jockey_name}` : null)}, ` +
        `${esc(r.trainer_name ? `trainer_${r.trainer_name}` : null)}, ` +
        `${r.actual_weight ?? 'NULL'}, ${r.declared_weight ?? 'NULL'}, ` +
        `${esc(r.lbw)}, ${esc(r.running_position)}, ${r.finish_time ?? 'NULL'}, ${r.win_odds ?? 'NULL'} ` +
        `WHERE EXISTS (SELECT 1 FROM races WHERE id = ${esc(raceId)});`
      );
    }
  }

  writeFileSync(a.out, sql.join('\n') + '\n');
  console.error(`[results] wrote ${sql.length} statements to ${a.out}`);
  console.log(JSON.stringify({
    ok: true,
    date: a.date,
    venue: a.venue,
    races_parsed: parsed.length,
    horses: horses.size,
    jockeys: jockeys.size,
    trainers: trainers.size,
    output: a.out,
    statements: sql.length,
  }));
}

main().catch((e) => {
  console.error('[results] fatal:', e);
  process.exit(1);
});
