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

  // --include selector: 'race' (default, fast post-race-day sync) or 'pool-a' (trackwork/injury/form)
  // or 'all' for everything.
  const include = (arg('include', 'race') || 'race').toLowerCase();
  const wantRace  = include === 'race'  || include === 'all';
  const wantPoolA = include === 'pool-a' || include === 'all';

  // Table definitions with date-scoping filters
  // ORDER MATTERS: FK parents first (horses/jockeys/trainers) → meetings → races → dependents
  const recentRaceIds = `SELECT id FROM races WHERE meeting_id IN (SELECT id FROM race_meetings WHERE date >= '${since}')`;

  // Horses/jockeys/trainers need to union refs from race_results AND pool-a tables
  // (otherwise FK fails when a trackwork row references a horse not in recent races)
  const horseRefs: string[] = [];
  if (wantRace)  horseRefs.push(`SELECT DISTINCT horse_id FROM race_results WHERE race_id IN (${recentRaceIds})`);
  if (wantPoolA) {
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_trackwork WHERE trackwork_date >= '${since}'`);
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_injury WHERE injury_date >= '${since}'`);
    horseRefs.push(`SELECT DISTINCT horse_id FROM horse_form_records WHERE race_date >= '${since}'`);
  }
  const horseRefUnion = horseRefs.length ? horseRefs.join(' UNION ') : `SELECT NULL WHERE 0`;

  const plan: Array<{ table: string; where: string }> = [];

  // FK parents — always pushed first in their own chunk
  plan.push({ table: 'horses',   where: `id IN (${horseRefUnion})` });
  if (wantRace) {
    plan.push({ table: 'jockeys',  where: `id IN (SELECT DISTINCT jockey_id FROM race_results WHERE race_id IN (${recentRaceIds}))` });
    plan.push({ table: 'trainers', where: `id IN (SELECT DISTINCT trainer_id FROM race_results WHERE race_id IN (${recentRaceIds}))` });
  }

  if (wantRace) {
    plan.push({ table: 'race_meetings',         where: `date >= '${since}'` });
    plan.push({ table: 'races',                 where: `meeting_id IN (SELECT id FROM race_meetings WHERE date >= '${since}')` });
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

  const COLUMN_PREFIX: Record<string, Record<string, string>> = {
    horse_elo_snapshots: { horse_id: 'horse_' },
    jockey_elo_snapshots: { jockey_id: 'jockey_' },
    trainer_elo_snapshots: { trainer_id: 'trainer_' },
  };

  for (const { table, where } of plan) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name);
    if (!cols.length) {
      console.error(`skip ${table}: no schema`);
      continue;
    }
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all() as Record<string, unknown>[];
    console.error(`${table}: ${rows.length} rows`);
    if (!rows.length) continue;

    const prefixMap = COLUMN_PREFIX[table] || {};
    let chunkIdx = 0;
    for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
      const batch = rows.slice(i, i + ROWS_PER_CHUNK);
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
      // NOTE: no BEGIN/COMMIT wrapper — Cloudflare D1 rejects explicit SQL transactions
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES\n${valuesSql};\n`;
      const fn = join(outDir, `${table}-${String(chunkIdx).padStart(4, '0')}.sql`);
      writeFileSync(fn, sql);
      manifest.push(fn);
      chunkIdx++;
    }
  }

  console.log(manifest.join('\n'));
}

main();
