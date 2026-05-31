#!/usr/bin/env tsx
/**
 * Delta push to D1 — only push rows for race dates >= --since=YYYY-MM-DD.
 * Avoids re-sending 100k historical rows when syncing recent ingests.
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROWS_PER_CHUNK = 200;

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (fallback ?? '');
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Buffer) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function main() {
  const dbPath = resolve(arg('db', 'bulk-local.db'));
  const outDir = resolve(arg('out', '/tmp/d1-delta'));
  const since = arg('since', '2026-04-16');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  const manifest: string[] = [];

  // --include selector: 'race' (default, fast post-race-day sync), 'pool-a' (trackwork/injury/form),
  // 'elo' (ELO snapshots only, for post-compute sync), 'entries' (forward-looking racecard
  // upcoming meetings), or 'all' for everything.
  const include = (arg('include', 'race') || 'race').toLowerCase();
  const wantRace    = include === 'race'    || include === 'all';
  const wantPoolA   = include === 'pool-a'  || include === 'all';
  const wantElo     = include === 'elo'     || include === 'all';
  const wantEntries = include === 'entries' || include === 'all';
  const wantOdds    = include === 'odds'    || include === 'all';

  // Table definitions with date-scoping filters
  // ORDER MATTERS: FK parents first (horses/jockeys/trainers) → meetings → races → dependents

  // Anti-ghost source guard (mirrors the tianxi-backend display + cleanup rule):
  // a real HK race day ALWAYS has >=8 races. A meeting in this POST-race-day
  // delta with fewer than MIN_RACES_PER_MEETING races is a phantom — typically
  // one day's results misattributed under another date+venue (the 2026-05-31
  // ghost HV carried a single 5/27 race). Excluding it HERE stops the ghost (and
  // its cascading races/results/comments/dividends) from ever being written to
  // D1 in the first place — the source fix, vs. cleaning it up after the fact.
  // Applies ONLY to the post-race `race` include path; the forward-looking
  // `entries` racecard path legitimately has 0 races and is filtered by date
  // alone (see the wantEntries block below).
  const MIN_RACES_PER_MEETING = 4;
  const validRaceMeetingIds = `SELECT id FROM race_meetings WHERE date >= '${since}' AND (SELECT COUNT(*) FROM races r2 WHERE r2.meeting_id = race_meetings.id) >= ${MIN_RACES_PER_MEETING}`;
  const recentRaceIds = `SELECT id FROM races WHERE meeting_id IN (${validRaceMeetingIds})`;

  if (wantRace) {
    const skipped = db.prepare(
      `SELECT id, date, venue, (SELECT COUNT(*) FROM races r2 WHERE r2.meeting_id = m.id) AS race_count
         FROM race_meetings m
        WHERE m.date >= ? AND (SELECT COUNT(*) FROM races r2 WHERE r2.meeting_id = m.id) < ?`,
    ).all(since, MIN_RACES_PER_MEETING) as Array<Record<string, unknown>>;
    if (skipped.length) {
      console.error(`[anti-ghost] excluding ${skipped.length} low-race phantom meeting(s) from race delta: ${JSON.stringify(skipped)}`);
    }
  }

  // Horses/jockeys/trainers need to union refs from race_results AND pool-a tables
  // (otherwise FK fails when a trackwork row references a horse not in recent races)
  const horseRefs: string[] = [];
  if (wantRace)  horseRefs.push(`SELECT DISTINCT horse_id FROM race_results WHERE race_id IN (${recentRaceIds})`);
  if (wantPoolA) {
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_trackwork WHERE trackwork_date >= '${since}'`);
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_injury WHERE injury_date >= '${since}'`);
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_form_records WHERE race_date >= '${since}'`);
  }
  if (wantElo) {
    // ELO snapshots store bare codes (K059). Prefix to 'horse_K059' to match horses.id.
    horseRefs.push(`SELECT DISTINCT ('horse_' || horse_id) FROM horse_elo_snapshots WHERE as_of_date >= '${since}'`);
  }
  if (wantEntries) {
    // Entries seed horses.id as prefixed 'horse_<code>' via entries ingest stub.
    // Reference by that id directly so the horses push captures debut entrants.
    horseRefs.push(`SELECT DISTINCT ('horse_' || horse_id) FROM entries_upcoming WHERE race_date >= '${since}'`);
  }
  const horseRefUnion = horseRefs.length ? horseRefs.join(' UNION ') : `SELECT NULL WHERE 0`;

  const plan: Array<{ table: string; where: string }> = [];

  // FK parents — always pushed first in their own chunk
  // Skip for elo-only mode: horses exist in D1 already, and .elo-pipeline's
  // bulk-local.db has bare-code horses.id which won't match prefixed refs.
  if (wantRace || wantPoolA || wantEntries) {
    plan.push({ table: 'horses',   where: `id IN (${horseRefUnion})` });
  }
  if (wantRace) {
    plan.push({ table: 'jockeys',  where: `id IN (SELECT DISTINCT jockey_id FROM race_results WHERE race_id IN (${recentRaceIds}))` });
    plan.push({ table: 'trainers', where: `id IN (SELECT DISTINCT trainer_id FROM race_results WHERE race_id IN (${recentRaceIds}))` });
  }
  if (wantElo && !wantRace) {
    // ELO-only path: skip horses/jockeys/trainers re-push (they already exist in D1).
    // .elo-pipeline's bulk-local.db stores horses.id as bare code "K059" rather than
    // prefixed "horse_K059" used by tianxi-backend ingest. The FK parent subquery
    // `('horse_' || horse_id) IN (SELECT id FROM horses)` would always miss here,
    // producing 0 rows. Trust D1 to have the horses/jockeys/trainers already.
    plan.push({ table: 'horse_elo_snapshots',   where: `as_of_date >= '${since}'` });
    plan.push({ table: 'jockey_elo_snapshots',  where: `as_of_date >= '${since}'` });
    plan.push({ table: 'trainer_elo_snapshots', where: `as_of_date >= '${since}'` });
  }

  if (wantRace) {
    plan.push({ table: 'race_meetings',         where: `id IN (${validRaceMeetingIds})` });
    plan.push({ table: 'races',                 where: `meeting_id IN (${validRaceMeetingIds})` });
    plan.push({ table: 'race_results',          where: `race_id IN (${recentRaceIds})` });
    plan.push({ table: 'running_comments',      where: `race_id IN (${recentRaceIds})` });
    plan.push({ table: 'dividends',             where: `race_id IN (${recentRaceIds})` });
    plan.push({ table: 'horse_elo_snapshots',   where: `as_of_date >= '${since}' AND ('horse_' || horse_id) IN (SELECT id FROM horses)` });
    plan.push({ table: 'jockey_elo_snapshots',  where: `as_of_date >= '${since}' AND ('jockey_' || jockey_id) IN (SELECT id FROM jockeys)` });
    plan.push({ table: 'trainer_elo_snapshots', where: `as_of_date >= '${since}' AND ('trainer_' || trainer_id) IN (SELECT id FROM trainers)` });
  }

  if (wantPoolA) {
    plan.push({ table: 'horse_trackwork',    where: `trackwork_date >= '${since}'` });
    plan.push({ table: 'horse_injury',       where: `injury_date    >= '${since}'` });
    plan.push({ table: 'horse_form_records', where: `race_date      >= '${since}'` });
  }

  if (wantEntries) {
    // Forward-looking racecards — `race_date >= since` works because entries are
    // future-dated meetings. Caller typically passes since=today or a near-past date
    // to include both tomorrow's card and any recent cards still in transition.
    // race_meetings FK: push meeting placeholders first (entries ingest seeds them
    // via `INSERT ... ON CONFLICT(date, venue) DO NOTHING`). Avoid double-push when
    // --include=race already added it above.
    if (!wantRace) {
      plan.push({ table: 'race_meetings', where: `date >= '${since}'` });
    }
    plan.push({ table: 'entries_upcoming', where: `race_date >= '${since}'` });
  }

  if (wantOdds) {
    // Odds snapshots + pool totals are append-only time series. No FK on
    // horse/jockey/trainer — combination encodes the bet selection as free text.
    // race_date filter keeps the push small (current-meeting snapshot window).
    plan.push({ table: 'odds_snapshots', where: `race_date >= '${since}'` });
    plan.push({ table: 'pool_totals',    where: `race_date >= '${since}'` });
  }

  const COLUMN_PREFIX: Record<string, Record<string, string>> = {
    horse_elo_snapshots: { horse_id: 'horse_' },
    jockey_elo_snapshots: { jockey_id: 'jockey_' },
    trainer_elo_snapshots: { trainer_id: 'trainer_' },
    // Pool A ingest stores bare codes (K059) in horse_id; D1 horses.id uses
    // the prefixed form (horse_K059). Map on push so FK resolves.
    horse_trackwork: { horse_id: 'horse_' },
    horse_injury: { horse_id: 'horse_' },
    horse_form_records: { horse_id: 'horse_' },
    // Entries ingest writes bare code (E436) into horse_id; prefix for FK.
    entries_upcoming: { horse_id: 'horse_' },
  };

  // Tables whose natural conflict key is a secondary UNIQUE index (not the PK).
  // For these, `ON CONFLICT(pk)` never fires when the same logical row arrives
  // with a fresh surrogate id; we hit the UNIQUE constraint instead and the
  // whole chunk fails. Target the composite UNIQUE columns explicitly.
  const UNIQUE_CONFLICT: Record<string, string[]> = {
    horse_form_records: ['horse_id', 'race_date', 'venue', 'race_number'],
  };

  for (const { table, where } of plan) {
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const cols = tableInfo.map((r) => r.name);
    if (!cols.length) {
      console.error(`skip ${table}: no schema`);
      continue;
    }
    // Collect PK column names (in declaration order) so we can emit a proper
    // upsert. Cloudflare D1 rejects both BEGIN/COMMIT and `PRAGMA defer_foreign_keys`,
    // and `INSERT OR REPLACE` on a table referenced by FK runs DELETE+INSERT
    // which transiently orphans child rows (→ SQLITE_CONSTRAINT_FOREIGNKEY).
    // `ON CONFLICT(pk) DO UPDATE SET col=excluded.col` performs an in-place
    // UPDATE without DELETE, preserving FK integrity for inbound refs.
    const pkCols = tableInfo
      .filter((r) => r.pk && r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);

    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all() as Record<string, unknown>[];
    console.error(`${table}: ${rows.length} rows`);
    if (!rows.length) continue;

    const prefixMap = COLUMN_PREFIX[table] || {};
    // Resolve conflict target: prefer explicit UNIQUE mapping, else PK cols.
    const uniqueCols = UNIQUE_CONFLICT[table];
    const conflictCols = uniqueCols && uniqueCols.length ? uniqueCols : pkCols;
    // Everything that isn't part of the conflict key is eligible for update.
    const nonConflictCols = cols.filter((c) => !conflictCols.includes(c));
    // Tables with secondary UNIQUE constraints (beyond PK) can fail UPSERT when
    // the new row would violate the secondary constraint on a different PK.
    // For FK-parent tables (horses/jockeys/trainers) where we mainly care that
    // the row exists for child FK resolution, fall back to INSERT OR IGNORE:
    // if a row with the same code already exists (even under a different id),
    // skip silently — children reference by id which matches our local id.
    const FK_PARENT_SKIP_UPDATE = new Set(['horses', 'jockeys', 'trainers']);
    const skipUpdate = FK_PARENT_SKIP_UPDATE.has(table);
    const updateSetClause = skipUpdate
      ? ''
      : nonConflictCols.length
      ? nonConflictCols.map((c) => `${c}=excluded.${c}`).join(', ')
      : '';
    // D1 multi-row VALUES + ON CONFLICT DO UPDATE triggers D1_RESET_DO on some
    // tables (observed on `horses`, where the SET clause over 22 columns crashes
    // the Durable Object). Emit one INSERT statement per row when UPSERT is in
    // play. For INSERT-only tables we can still batch.
    const oneStatementPerRow = conflictCols.length > 0 && updateSetClause !== '';
    const rowsPerStatement = oneStatementPerRow ? 1 : ROWS_PER_CHUNK;
    const statementsPerChunk = oneStatementPerRow ? ROWS_PER_CHUNK : 1;

    let chunkIdx = 0;
    for (let i = 0; i < rows.length; i += rowsPerStatement * statementsPerChunk) {
      const chunkRows = rows.slice(i, i + rowsPerStatement * statementsPerChunk);
      const stmts: string[] = [];
      for (let j = 0; j < chunkRows.length; j += rowsPerStatement) {
        const batch = chunkRows.slice(j, j + rowsPerStatement);
        const valuesSql = batch.map(r => {
          const vals = cols.map(c => {
            const v = r[c];
            if (prefixMap[c] && v !== null && v !== undefined) {
              return esc(`${prefixMap[c]}${v}`);
            }
            return esc(v);
          });
          return `(${vals.join(',')})`;
        }).join(',');
        let sql: string;
        if (conflictCols.length && updateSetClause) {
          sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${valuesSql} ON CONFLICT(${conflictCols.join(',')}) DO UPDATE SET ${updateSetClause};`;
        } else if (skipUpdate) {
          // INSERT OR IGNORE skips row on ANY uniqueness failure (PK or secondary UNIQUE)
          // — correct for FK-parent tables where existence is all that matters.
          sql = `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES\n${valuesSql};`;
        } else if (conflictCols.length) {
          sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES\n${valuesSql}\nON CONFLICT(${conflictCols.join(',')}) DO NOTHING;`;
        } else {
          sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES\n${valuesSql};`;
        }
        stmts.push(sql);
      }
      const fn = join(outDir, `${table}-${String(chunkIdx).padStart(4, '0')}.sql`);
      writeFileSync(fn, stmts.join('\n') + '\n');
      manifest.push(fn);
      chunkIdx++;
    }
  }

  console.log(manifest.join('\n'));
}

main();

