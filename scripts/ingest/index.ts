#!/usr/bin/env tsx
/**
 * Tianxi ingestion CLI
 *
 * Usage:
 *   tsx scripts/ingest/index.ts [sources...] [--data-dir=<path>] [--db=<path>] [--dry-run]
 *
 * Sources (any subset):
 *   profiles        — horses/profiles/horse_profiles.csv → horses + horse_profile_extra
 *   form            — horses/form_records/form_*.csv → horse_form_records
 *   trackwork       — horses/trackwork/trackwork_*.csv → horse_trackwork
 *   injury          — horses/injury/injury_*.csv → horse_injury
 *   trials          — trials/trial_sessions.csv + trial_results.csv → trial_sessions + trial_runners
 *   jockeys         — jockeys/records/jockey_*.csv → jockey_season_records
 *   entries         — entries/entries_*.txt → entries_upcoming
 *   sync            — update sync_state from hkjc-data/last_sync.json
 *   all             — run everything
 *
 * Defaults:
 *   --data-dir: ../hkjc-data (relative to tianxi-backend cwd)
 *   --db: bulk-local.db (in cwd)
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, startIngestionRun, finishIngestionRun, upsertSyncState, ensureSchema } from './lib/db.js';
import { getRepoHeadCommitShort } from './lib/git.js';
import { ingestHorseProfiles } from './sources/horse_profiles.js';
import { ingestHorseFormRecords } from './sources/horse_form.js';
import { ingestTrials } from './sources/trials.js';
import { ingestJockeyRecords } from './sources/jockey_records.js';
import { ingestEntries } from './sources/entries.js';
import { ingestHorseTrackwork } from './sources/horse_trackwork.js';
import { ingestHorseInjury } from './sources/horse_injury.js';

interface Args {
  sources: string[];
  dataDir: string;
  db: string;
  dryRun: boolean;
  schemaOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sources: [],
    dataDir: resolve(process.cwd(), '..', 'hkjc-data'),
    db: resolve(process.cwd(), 'bulk-local.db'),
    dryRun: false,
    schemaOnly: false,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--data-dir=')) args.dataDir = resolve(a.slice('--data-dir='.length));
    else if (a.startsWith('--db=')) args.db = resolve(a.slice('--db='.length));
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--schema-only') args.schemaOnly = true;
    else if (!a.startsWith('--')) args.sources.push(a);
  }
  if (args.sources.length === 0) args.sources = ['all'];
  return args;
}

function log(section: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${section}] ${msg}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log('cli', `data-dir: ${args.dataDir}`);
  log('cli', `db: ${args.db}`);
  log('cli', `sources: ${args.sources.join(', ')}`);
  log('cli', `dry-run: ${args.dryRun}`);

  if (!existsSync(args.dataDir)) {
    console.error(`Data dir not found: ${args.dataDir}`);
    process.exit(1);
  }

  const db = openDb(args.db);

  // Always ensure schema. schema_silks is tolerant of repeat ALTER TABLE
  // (ensureSchema wraps each statement in try/catch for "duplicate column").
  const schemaDir = resolve(process.cwd(), 'src', 'db');
  ensureSchema(db, [
    resolve(schemaDir, 'schema.sql'),
    resolve(schemaDir, 'schema_v2.sql'),
    resolve(schemaDir, 'schema_silks.sql'),
  ]);
  log('cli', 'schema ensured (v1 + v2 + silks)');

  if (args.schemaOnly) {
    db.close();
    return;
  }

  const sourceCommit = getRepoHeadCommitShort(args.dataDir);
  log('cli', `source_commit: ${sourceCommit ?? 'unknown'}`);

  const wants = (name: string): boolean => args.sources.includes(name) || args.sources.includes('all');

  // ---- sync_state from last_sync.json ----
  if (wants('sync')) {
    const syncPath = resolve(args.dataDir, 'last_sync.json');
    if (existsSync(syncPath)) {
      try {
        const j = JSON.parse(readFileSync(syncPath, 'utf-8')) as {
          synced_at?: string;
          stats?: Record<string, number>;
        };
        if (j.synced_at) upsertSyncState(db, 'last_synced_at', j.synced_at, sourceCommit);
        if (j.stats) {
          for (const [k, v] of Object.entries(j.stats)) {
            upsertSyncState(db, k, v, sourceCommit);
          }
        }
        log('sync', `updated sync_state from last_sync.json (${Object.keys(j.stats ?? {}).length} keys)`);
      } catch (err) {
        console.error('[sync] failed to parse last_sync.json:', err);
      }
    } else {
      log('sync', 'last_sync.json not found — skipping');
    }
  }

  // ---- horse_profiles ----
  if (wants('profiles')) {
    const csv = resolve(args.dataDir, 'horses', 'profiles', 'horse_profiles.csv');
    if (existsSync(csv)) {
      const runId = startIngestionRun(db, 'horses_profiles', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0 }
          : ingestHorseProfiles(db, csv, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${ms}ms` }, true);
        log('profiles', `ins=${stats.inserted} upd=${stats.updated} skip=${stats.skipped} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[profiles] fatal:', err);
      }
    } else {
      log('profiles', `CSV not found: ${csv}`);
    }
  }

  // ---- horse_form ----
  if (wants('form')) {
    const dir = resolve(args.dataDir, 'horses', 'form_records');
    if (existsSync(dir)) {
      const runId = startIngestionRun(db, 'form_records', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0, horsesProcessed: 0 }
          : ingestHorseFormRecords(db, dir, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${stats.horsesProcessed} horses, ${ms}ms` }, true);
        log('form', `horses=${stats.horsesProcessed} ins=${stats.inserted} skip=${stats.skipped} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[form] fatal:', err);
      }
    } else {
      log('form', `dir not found: ${dir}`);
    }
  }

  // ---- trials ----
  if (wants('trials')) {
    const sessionsCsv = resolve(args.dataDir, 'trials', 'trial_sessions.csv');
    const resultsCsv = resolve(args.dataDir, 'trials', 'trial_results.csv');
    if (existsSync(sessionsCsv) && existsSync(resultsCsv)) {
      const runId = startIngestionRun(db, 'trials', sourceCommit);
      const t0 = Date.now();
      try {
        const { sessions, runners } = args.dryRun
          ? { sessions: { inserted: 0, updated: 0, skipped: 0, failed: 0 }, runners: { inserted: 0, updated: 0, skipped: 0, failed: 0 } }
          : ingestTrials(db, sessionsCsv, resultsCsv, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(
          db,
          runId,
          {
            inserted: sessions.inserted + runners.inserted,
            updated: 0,
            skipped: sessions.skipped + runners.skipped,
            failed: sessions.failed + runners.failed,
            notes: `sessions=${sessions.inserted} runners=${runners.inserted} ${ms}ms`,
          },
          true,
        );
        log('trials', `sessions ins=${sessions.inserted} | runners ins=${runners.inserted} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[trials] fatal:', err);
      }
    } else {
      log('trials', 'trial_sessions.csv or trial_results.csv missing');
    }
  }

  // ---- jockey records ----
  if (wants('jockeys')) {
    const dir = resolve(args.dataDir, 'jockeys', 'records');
    if (existsSync(dir)) {
      const runId = startIngestionRun(db, 'jockey_records', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0, jockeysProcessed: 0 }
          : ingestJockeyRecords(db, dir, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${stats.jockeysProcessed} jockeys, ${ms}ms` }, true);
        log('jockeys', `jockeys=${stats.jockeysProcessed} ins=${stats.inserted} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[jockeys] fatal:', err);
      }
    } else {
      log('jockeys', `dir not found: ${dir}`);
    }
  }

  // ---- horse trackwork ----
  if (wants('trackwork')) {
    const dir = resolve(args.dataDir, 'horses', 'trackwork');
    if (existsSync(dir)) {
      const runId = startIngestionRun(db, 'horse_trackwork', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0, horsesProcessed: 0 }
          : ingestHorseTrackwork(db, dir, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${stats.horsesProcessed} horses, ${ms}ms` }, true);
        log('trackwork', `horses=${stats.horsesProcessed} ins=${stats.inserted} skip=${stats.skipped} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[trackwork] fatal:', err);
      }
    } else {
      log('trackwork', `dir not found: ${dir}`);
    }
  }

  // ---- horse injury ----
  if (wants('injury')) {
    const dir = resolve(args.dataDir, 'horses', 'injury');
    if (existsSync(dir)) {
      const runId = startIngestionRun(db, 'horse_injury', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0, horsesProcessed: 0 }
          : ingestHorseInjury(db, dir, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${stats.horsesProcessed} horses, ${ms}ms` }, true);
        log('injury', `horses=${stats.horsesProcessed} ins=${stats.inserted} skip=${stats.skipped} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[injury] fatal:', err);
      }
    } else {
      log('injury', `dir not found: ${dir}`);
    }
  }

  // ---- entries ----
  if (wants('entries')) {
    const dir = resolve(args.dataDir, 'entries');
    if (existsSync(dir)) {
      const runId = startIngestionRun(db, 'entries', sourceCommit);
      const t0 = Date.now();
      try {
        const stats = args.dryRun
          ? { inserted: 0, updated: 0, skipped: 0, failed: 0, filesProcessed: 0 }
          : ingestEntries(db, dir, sourceCommit);
        const ms = Date.now() - t0;
        finishIngestionRun(db, runId, { ...stats, notes: `${stats.filesProcessed} files, ${ms}ms` }, true);
        log('entries', `files=${stats.filesProcessed} ins=${stats.inserted} skip=${stats.skipped} fail=${stats.failed} ${ms}ms`);
      } catch (err) {
        finishIngestionRun(db, runId, { inserted: 0, updated: 0, skipped: 0, failed: 0, notes: String(err) }, false);
        console.error('[entries] fatal:', err);
      }
    } else {
      log('entries', `dir not found: ${dir}`);
    }
  }

  db.close();
  log('cli', 'done');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
