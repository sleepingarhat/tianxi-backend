/**
 * DB connection helper for ingestion CLI
 * Uses better-sqlite3 on bulk-local.db (shared with import-csv.ts)
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type DB = Database.Database;

export function openDb(path?: string): DB {
  const dbPath = path ?? resolve(process.cwd(), 'bulk-local.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF'); // horses rows may not yet exist during first ingest
  return db;
}

export function ensureSchema(db: DB, schemaPaths: string[]): void {
  for (const p of schemaPaths) {
    if (!existsSync(p)) {
      throw new Error(`Schema file not found: ${p}`);
    }
    const sql = readFileSync(p, 'utf-8');
    // SQLite has no ADD COLUMN IF NOT EXISTS; tolerate re-runs by running
    // each statement independently and swallowing the two known idempotency errors.
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));
    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/duplicate column name/i.test(msg) || /already exists/i.test(msg)) continue;
        throw err;
      }
    }
  }
}

export function startIngestionRun(
  db: DB,
  runType: string,
  sourceCommit: string | null,
): string {
  const id = `${runType}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  db.prepare(
    `INSERT INTO ingestion_runs (id, run_type, source_commit, started_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(id, runType, sourceCommit);
  return id;
}

export function finishIngestionRun(
  db: DB,
  runId: string,
  stats: { inserted: number; updated: number; skipped: number; failed: number; notes?: string },
  success: boolean,
): void {
  db.prepare(
    `UPDATE ingestion_runs
     SET rows_inserted = ?, rows_updated = ?, rows_skipped = ?, rows_failed = ?,
         finished_at = datetime('now'), success = ?, notes = ?
     WHERE id = ?`,
  ).run(
    stats.inserted,
    stats.updated,
    stats.skipped,
    stats.failed,
    success ? 1 : 0,
    stats.notes ?? null,
    runId,
  );
}

export function upsertSyncState(
  db: DB,
  key: string,
  value: number | string,
  sourceCommit: string | null,
): void {
  const intVal = typeof value === 'number' ? value : null;
  const textVal = typeof value === 'string' ? value : null;
  db.prepare(
    `INSERT INTO sync_state (key, value_int, value_text, updated_at, source_commit)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value_int = excluded.value_int,
       value_text = excluded.value_text,
       updated_at = excluded.updated_at,
       source_commit = excluded.source_commit`,
  ).run(key, intVal, textVal, sourceCommit);
}
