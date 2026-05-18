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
 *     [--out=/tmp/results-{date}-{venue}.sql] [--max-races=14]
 *
 * Output schema mirrors existing data conventions:
 *   horses.id  = 'horse_' + last token of HKJC horseid (e.g. HK_2023_J182 → horse_J182)
 *   jockeys.id = 'jockey_' + name_ch
 *   trainers.id = 'trainer_' + name_ch
 *   races.id = 'race_{date}_{venue}_{race_number}'
 *   race_meetings.id = '{date}_{venue}'
 *   race_results.id = 'result_{race_id}_{horse_number}'
 *
 * Idempotent: INSERT OR IGNORE for FK parents, INSERT OR REPLACE for
 * race_meetings / races / race_results.
 */
import { writeFileSync } from 'node:fs';

interface Args {
  date: string;
  venue: string;
  out: string;
  maxRaces: number;
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
  };
}

function esc(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

interface RaceHeader {
  race_number: number;
  klass: string | null;
  distance: number | null;
  going: string | null;
  track_course: string | null;
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
  finish_time: string | null;
}

interface ParsedRace {
  header: RaceHeader;
  results: RaceResultRow[];
}

function parseRaceHeader(html: string, raceNumber: number): RaceHeader | null {
  // Race header block contains "第 N 場" and the race meta rows.
  const re = new RegExp(`第\\s*${raceNumber}\\s*場[\\s\\S]{0,5000}`);
  const m = html.match(re);
  if (!m) return null;
  const ctx = m[0];

  // First detail row: "第五班 - 1800米 - (40-0)" + "場地狀況 : 好地至黏地"
  const detailM = ctx.match(/<td[^>]*>\s*([^<\s][^<]*?)\s*-\s*(\d+)米[^<]*<\/td>[\s\S]*?場地狀況[\s\S]*?<td[^>]*colspan="\d+">([^<]+)<\/td>/);
  // Track + course row: "草地 - "C+3" 賽道" (race title in first td of same row)
  const trackM = ctx.match(/<tr>\s*<td[^>]*>\s*([^<]+?)<\/td>[\s\S]*?賽道[\s\S]*?<td[^>]*colspan="\d+">\s*([^<]+?)\s*<\/td>/);
  // Prize row
  const prizeM = ctx.match(/HK\$\s*([\d,]+)/);

  return {
    race_number: raceNumber,
    klass: detailM ? detailM[1].trim() : null,
    distance: detailM ? Number(detailM[2]) : null,
    going: detailM ? stripHtml(detailM[3]).trim() : null,
    track_course: trackM ? stripHtml(trackM[2]).trim().replace(/&quot;/g, '"') : null,
    title: trackM ? stripHtml(trackM[1]).trim() : null,
    prize: prizeM ? prizeM[1].replace(/,/g, '') : null,
  };
}

function parseResultsTable(html: string): RaceResultRow[] {
  // First table_bd is the results table (per inspection).
  const tableM = html.match(/<table[^>]*class="[^"]*table_bd[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) return [];
  const tbodyM = tableM[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbodyM) return [];
  const tbody = tbodyM[1];
  const rows: RaceResultRow[] = [];
  // Each result row is a top-level <tr>...</tr> in tbody.
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let tm: RegExpExecArray | null;
  while ((tm = trRe.exec(tbody)) !== null) {
    const cells = [...tm[1].matchAll(/<td[\s\S]*?<\/td>/g)].map((c) => c[0]);
    if (cells.length < 8) continue; // header rows / footers have fewer cells

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
    // cells[8] = head margin, [9] = running pos, [10] = finish_time, [11] = win odds
    const finish_time = cells.length > 10 ? stripHtml(cells[10]) || null : null;

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
      finish_time,
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
  // HKJC returns 200 with boilerplate-only page (~119k) when no race
  if (t.length < 150000) return null;
  // Sanity: needs results table with 名次 column
  if (!t.includes('名次') || !/\d:\d{2}\.\d{2}/.test(t)) return null;
  return t;
}

async function main() {
  const a = parseArgs();
  console.error(`[results] scraping ${a.date} @ ${a.venue} (max ${a.maxRaces} races)`);

  const meetingId = `${a.date}_${a.venue}`;
  const parsed: ParsedRace[] = [];

  for (let n = 1; n <= a.maxRaces; n++) {
    const html = await fetchRace(a.date, a.venue, n);
    if (!html) {
      console.error(`[results] race ${n}: no page / no results — stopping`);
      break;
    }
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
    console.error(`[results] race ${n}: ${results.length} rows · ${header.klass} ${header.distance}m ${header.going}`);
    parsed.push({ header, results });
  }

  if (parsed.length === 0) {
    console.error('[results] NO races parsed — no SQL written, exit 0');
    process.exit(0);
  }

  // Aggregate FK parents
  const horses = new Map<string, { name_ch: string; code: string | null }>();
  const jockeys = new Map<string, string>();   // id -> name_ch
  const trainers = new Map<string, string>();  // id -> name_ch

  for (const p of parsed) {
    for (const r of p.results) {
      if (r.horse_id && r.horse_name_ch) horses.set(r.horse_id, { name_ch: r.horse_name_ch, code: r.horse_code });
      if (r.jockey_name) jockeys.set(`jockey_${r.jockey_name}`, r.jockey_name);
      if (r.trainer_name) trainers.set(`trainer_${r.trainer_name}`, r.trainer_name);
    }
  }

  // Build SQL
  const sql: string[] = [];
  sql.push(`-- HKJC race results · ${a.date} @ ${a.venue} · ${parsed.length} races · generated ${new Date().toISOString()}`);

  // FK parents (INSERT OR IGNORE — minimal fields)
  for (const [id, h] of horses) {
    sql.push(`INSERT OR IGNORE INTO horses (id, name_en, name_ch, code) VALUES (${esc(id)}, ${esc(h.name_ch)}, ${esc(h.name_ch)}, ${esc(h.code)});`);
  }
  for (const [id, name] of jockeys) {
    sql.push(`INSERT OR IGNORE INTO jockeys (id, name_en, name_ch) VALUES (${esc(id)}, ${esc(name)}, ${esc(name)});`);
  }
  for (const [id, name] of trainers) {
    sql.push(`INSERT OR IGNORE INTO trainers (id, name_en, name_ch) VALUES (${esc(id)}, ${esc(name)}, ${esc(name)});`);
  }

  // race_meetings: UPSERT total_races + track_condition (going of first race as proxy)
  const firstGoing = parsed[0].header.going;
  sql.push(
    `INSERT INTO race_meetings (id, date, venue, track_condition, total_races) ` +
    `VALUES (${esc(meetingId)}, ${esc(a.date)}, ${esc(a.venue)}, ${esc(firstGoing)}, ${parsed.length}) ` +
    `ON CONFLICT(date, venue) DO UPDATE SET total_races = excluded.total_races, ` +
    `track_condition = COALESCE(race_meetings.track_condition, excluded.track_condition);`
  );

  // races (INSERT OR REPLACE)
  for (const p of parsed) {
    const raceId = `race_${a.date}_${a.venue}_${p.header.race_number}`;
    sql.push(
      `INSERT OR REPLACE INTO races (id, meeting_id, race_number, title, class, distance, going, course, prize) ` +
      `VALUES (${esc(raceId)}, ${esc(meetingId)}, ${p.header.race_number}, ${esc(p.header.title)}, ` +
      `${esc(p.header.klass)}, ${p.header.distance ?? 'NULL'}, ${esc(p.header.going)}, ` +
      `${esc(p.header.track_course)}, ${esc(p.header.prize)});`
    );
  }

  // race_results (INSERT OR REPLACE)
  for (const p of parsed) {
    const raceId = `race_${a.date}_${a.venue}_${p.header.race_number}`;
    for (const r of p.results) {
      if (!r.horse_id || r.horse_number === null) continue;
      const resultId = `result_${raceId}_${r.horse_number}`;
      sql.push(
        `INSERT OR REPLACE INTO race_results (id, race_id, horse_id, horse_number, finishing_position, draw, jockey_id, trainer_id, actual_weight, declared_weight) ` +
        `VALUES (${esc(resultId)}, ${esc(raceId)}, ${esc(r.horse_id)}, ${r.horse_number}, ` +
        `${r.finishing_position}, ${r.draw ?? 'NULL'}, ` +
        `${esc(r.jockey_name ? `jockey_${r.jockey_name}` : null)}, ` +
        `${esc(r.trainer_name ? `trainer_${r.trainer_name}` : null)}, ` +
        `${r.actual_weight ?? 'NULL'}, ${r.declared_weight ?? 'NULL'});`
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
