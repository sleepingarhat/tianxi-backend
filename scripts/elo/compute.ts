#!/usr/bin/env tsx
/**
 * Elo v1 batch compute driver
 *
 * Reads horse_form_records chronologically, reconstructs races by
 * grouping on (race_date, venue, race_number), applies pairwise multi-runner
 * Elo deltas for horses/jockeys/trainers, and writes snapshots.
 *
 * Usage:
 *   tsx scripts/elo/compute.ts [--db=<path>] [--run-label=<str>] [--k=<num>] [--from=<YYYY-MM-DD>] [--to=<YYYY-MM-DD>] [--reset]
 *
 * Defaults:
 *   --db=bulk-local.db
 *   --run-label=v1_<timestamp>
 *   --k=40
 *   --from=2016-01-01
 *   --reset: wipe horse_elo_snapshots / jockey_elo_snapshots / trainer_elo_snapshots before run
 */
import { resolve } from 'node:path';
import { openDb, ensureSchema } from '../ingest/lib/db.js';
import { computeRaceDeltas, DEFAULT_CONFIG, type Runner } from './engine.js';

interface Args {
  db: string;
  runLabel: string;
  k: number;
  fromDate: string;
  toDate: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const args: Args = {
    db: resolve(process.cwd(), 'bulk-local.db'),
    runLabel: `v1_${now}`,
    k: DEFAULT_CONFIG.k,
    fromDate: '2016-01-01',
    toDate: '9999-12-31',
    reset: false,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--db=')) args.db = resolve(a.slice('--db='.length));
    else if (a.startsWith('--run-label=')) args.runLabel = a.slice('--run-label='.length);
    else if (a.startsWith('--k=')) args.k = parseFloat(a.slice('--k='.length));
    else if (a.startsWith('--from=')) args.fromDate = a.slice('--from='.length);
    else if (a.startsWith('--to=')) args.toDate = a.slice('--to='.length);
    else if (a === '--reset') args.reset = true;
  }
  return args;
}

function log(section: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${section}] ${msg}`);
}

interface FormRow {
  horse_id: string;
  race_date: string;
  venue: string | null;
  race_number: number | null;
  race_index_no: string | null;
  distance: number | null;
  track: string | null;
  jockey_name: string | null;
  trainer_name: string | null;
  finishing_position_num: number;
}

interface RaceKey {
  date: string;
  venue: string;
  raceNo: number;
}

function raceKeyStr(k: RaceKey): string {
  return `${k.date}|${k.venue}|${k.raceNo}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log('elo', `db=${args.db}`);
  log('elo', `run=${args.runLabel} k=${args.k} from=${args.fromDate} to=${args.toDate} reset=${args.reset}`);

  const db = openDb(args.db);
  ensureSchema(db, [
    resolve(process.cwd(), 'src', 'db', 'schema.sql'),
    resolve(process.cwd(), 'src', 'db', 'schema_v2.sql'),
  ]);

  if (args.reset) {
    db.prepare('DELETE FROM horse_elo_snapshots').run();
    db.prepare('DELETE FROM jockey_elo_snapshots').run();
    db.prepare('DELETE FROM trainer_elo_snapshots').run();
    log('elo', 'reset snapshot tables');
  }

  // Start run record
  const runInsert = db.prepare(
    `INSERT INTO elo_runs (id, run_label, k_factor, initial_rating, burn_in_from, started_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  const runFinish = db.prepare(
    `UPDATE elo_runs SET finished_at = datetime('now'), races_processed = ?, results_processed = ?, success = ?, error_message = ? WHERE id = ?`,
  );
  runInsert.run(args.runLabel, args.runLabel, args.k, DEFAULT_CONFIG.initialRating, args.fromDate);

  // Load all form records in date + race order
  const rows = db
    .prepare(
      `SELECT horse_id, race_date, venue, race_number, race_index_no, distance, track, jockey_name, trainer_name, finishing_position_num
       FROM horse_form_records
       WHERE race_date >= ? AND race_date <= ?
         AND venue IS NOT NULL AND race_number IS NOT NULL
       ORDER BY race_date ASC, venue ASC, race_number ASC`,
    )
    .all(args.fromDate, args.toDate) as FormRow[];
  log('elo', `loaded ${rows.length} form rows`);

  // Group by race
  const races = new Map<string, { key: RaceKey; runners: FormRow[] }>();
  for (const r of rows) {
    if (!r.venue || r.race_number == null) continue;
    const key: RaceKey = { date: r.race_date, venue: r.venue, raceNo: r.race_number };
    const ks = raceKeyStr(key);
    if (!races.has(ks)) races.set(ks, { key, runners: [] });
    races.get(ks)!.runners.push(r);
  }
  // Sort races chronologically
  const sortedRaces = Array.from(races.values()).sort((a, b) => {
    if (a.key.date !== b.key.date) return a.key.date < b.key.date ? -1 : 1;
    if (a.key.venue !== b.key.venue) return a.key.venue < b.key.venue ? -1 : 1;
    return a.key.raceNo - b.key.raceNo;
  });
  log('elo', `reconstructed ${sortedRaces.length} races`);

  // In-memory rating state
  const horseR = new Map<string, number>();
  const jockeyR = new Map<string, number>();
  const trainerR = new Map<string, number>();
  const horseGames = new Map<string, number>();
  const jockeyGames = new Map<string, number>();
  const trainerGames = new Map<string, number>();

  const getR = (m: Map<string, number>, id: string): number => {
    if (!m.has(id)) m.set(id, DEFAULT_CONFIG.initialRating);
    return m.get(id)!;
  };

  // Batch inserts for snapshots
  const insertHorseSnap = db.prepare(
    `INSERT OR REPLACE INTO horse_elo_snapshots (id, horse_id, axis_key, surface, distance_bucket, as_of_race_id, as_of_date, rating, games_played, computed_at)
     VALUES (?, ?, 'overall', NULL, NULL, NULL, ?, ?, ?, datetime('now'))`,
  );
  const insertJockeySnap = db.prepare(
    `INSERT OR REPLACE INTO jockey_elo_snapshots (id, jockey_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))`,
  );
  const insertTrainerSnap = db.prepare(
    `INSERT OR REPLACE INTO trainer_elo_snapshots (id, trainer_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))`,
  );

  const cfg = { ...DEFAULT_CONFIG, k: args.k };

  let processedRaces = 0;
  let processedResults = 0;

  const raceTx = db.transaction((raceRunners: FormRow[], raceKey: RaceKey) => {
    // Horse layer
    const horseRunners: Runner[] = raceRunners.map((r) => ({
      entityId: r.horse_id,
      finish: r.finishing_position_num,
      currentRating: getR(horseR, r.horse_id),
    }));
    const horseDeltas = computeRaceDeltas(horseRunners, cfg);
    for (const [id, d] of horseDeltas) {
      const newR = getR(horseR, id) + d;
      horseR.set(id, newR);
      horseGames.set(id, (horseGames.get(id) ?? 0) + 1);
      const snapId = `${id}|overall|${raceKey.date}|${raceKey.venue}|${raceKey.raceNo}`;
      insertHorseSnap.run(snapId, id, raceKey.date, newR, horseGames.get(id));
    }

    // Jockey layer (only runners with known jockey)
    const jockeyRunners: Runner[] = raceRunners
      .filter((r) => r.jockey_name)
      .map((r) => ({
        entityId: r.jockey_name!,
        finish: r.finishing_position_num,
        currentRating: getR(jockeyR, r.jockey_name!),
      }));
    if (jockeyRunners.length >= 2) {
      const jDeltas = computeRaceDeltas(jockeyRunners, cfg);
      for (const [id, d] of jDeltas) {
        const newR = getR(jockeyR, id) + d;
        jockeyR.set(id, newR);
        jockeyGames.set(id, (jockeyGames.get(id) ?? 0) + 1);
        const snapId = `${id}|${raceKey.date}|${raceKey.venue}|${raceKey.raceNo}`;
        insertJockeySnap.run(snapId, id, raceKey.date, newR, jockeyGames.get(id));
      }
    }

    // Trainer layer
    const trainerRunners: Runner[] = raceRunners
      .filter((r) => r.trainer_name)
      .map((r) => ({
        entityId: r.trainer_name!,
        finish: r.finishing_position_num,
        currentRating: getR(trainerR, r.trainer_name!),
      }));
    if (trainerRunners.length >= 2) {
      const tDeltas = computeRaceDeltas(trainerRunners, cfg);
      for (const [id, d] of tDeltas) {
        const newR = getR(trainerR, id) + d;
        trainerR.set(id, newR);
        trainerGames.set(id, (trainerGames.get(id) ?? 0) + 1);
        const snapId = `${id}|${raceKey.date}|${raceKey.venue}|${raceKey.raceNo}`;
        insertTrainerSnap.run(snapId, id, raceKey.date, newR, trainerGames.get(id));
      }
    }

    processedResults += raceRunners.length;
  });

  const t0 = Date.now();
  for (const race of sortedRaces) {
    try {
      raceTx(race.runners, race.key);
      processedRaces++;
      if (processedRaces % 500 === 0) {
        log('elo', `progress ${processedRaces}/${sortedRaces.length} races · ${processedResults} results · ${Date.now() - t0}ms`);
      }
    } catch (err) {
      console.error(`[elo] failed race ${raceKeyStr(race.key)}:`, err);
    }
  }
  const ms = Date.now() - t0;
  log('elo', `done: ${processedRaces} races · ${processedResults} results · ${ms}ms`);
  log('elo', `unique horses=${horseR.size} jockeys=${jockeyR.size} trainers=${trainerR.size}`);

  runFinish.run(processedRaces, processedResults, 1, null, args.runLabel);

  db.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
