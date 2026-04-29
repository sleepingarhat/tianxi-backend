#!/usr/bin/env tsx
/**
 * Elo v1.1 batch compute driver
 *
 * Upgrades over v1:
 *   1. 180-day idle decay per (horse × axis)
 *   2. Multi-axis ratings: overall + surface_distance_bucket
 *      (e.g. turf_sprint, turf_mile, turf_middle, turf_staying,
 *            awt_sprint, awt_mile, awt_middle, awt_staying)
 *   3. Burn-in window tracked in elo_runs.burn_in_from (informational — does NOT
 *      suppress snapshot writes; XGBoost train/validate split uses it later)
 *
 * Jockey/trainer layers remain single-axis (overall) — same as v1.
 *
 * Usage:
 *   tsx scripts/elo/compute_v11.ts [--db=<path>] [--run-label=<str>] [--k=<num>]
 *                                   [--from=<YYYY-MM-DD>] [--to=<YYYY-MM-DD>]
 *                                   [--burn-in-to=<YYYY-MM-DD>] [--reset]
 */
import { resolve } from 'node:path';
import { openDb, ensureSchema } from '../ingest/lib/db.js';
import { computeRaceDeltas, DEFAULT_CONFIG, type Runner } from './engine.js';
import {
  DEFAULT_V11_CONFIG,
  applyDecayIfIdle,
  buildAxisKey,
  getOrInitAxisState,
  type V11Config,
  type AxisState,
} from './engine_v11.js';
import { normalizeSurface, distanceBucket } from '../ingest/lib/parsers.js';

interface Args {
  db: string;
  runLabel: string;
  k: number;
  fromDate: string;
  toDate: string;
  burnInTo: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a: Args = {
    db: resolve(process.cwd(), 'bulk-local.db'),
    runLabel: `v11_${now}`,
    k: DEFAULT_CONFIG.k,
    fromDate: '2016-01-01',
    toDate: '9999-12-31',
    burnInTo: '2018-12-31',
    reset: false,
  };
  for (const x of argv.slice(2)) {
    if (x.startsWith('--db=')) a.db = resolve(x.slice('--db='.length));
    else if (x.startsWith('--run-label=')) a.runLabel = x.slice('--run-label='.length);
    else if (x.startsWith('--k=')) a.k = parseFloat(x.slice('--k='.length));
    else if (x.startsWith('--from=')) a.fromDate = x.slice('--from='.length);
    else if (x.startsWith('--to=')) a.toDate = x.slice('--to='.length);
    else if (x.startsWith('--burn-in-to=')) a.burnInTo = x.slice('--burn-in-to='.length);
    else if (x === '--reset') a.reset = true;
  }
  return a;
}

function log(section: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${section}] ${msg}`);
}

interface FormRow {
  horse_id: string;
  race_date: string;
  venue: string | null;
  race_number: number | null;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log('elo11', `db=${args.db}`);
  log('elo11', `run=${args.runLabel} k=${args.k} from=${args.fromDate} to=${args.toDate} burnInTo=${args.burnInTo} reset=${args.reset}`);

  const db = openDb(args.db);
  ensureSchema(db, [
    resolve(process.cwd(), 'src', 'db', 'schema.sql'),
    resolve(process.cwd(), 'src', 'db', 'schema_v2.sql'),
  ]);

  // Fast-write pragmas for batch compute (crash-unsafe but this run is idempotent).
  db.pragma('synchronous = OFF');
  db.pragma('journal_mode = MEMORY');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -262144'); // 256 MiB page cache

  if (args.reset) {
    db.prepare('DELETE FROM horse_elo_snapshots').run();
    db.prepare('DELETE FROM jockey_elo_snapshots').run();
    db.prepare('DELETE FROM trainer_elo_snapshots').run();
    log('elo11', 'reset all snapshot tables');
  }

  db.prepare(
    `INSERT INTO elo_runs (id, run_label, k_factor, initial_rating, burn_in_from, started_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(args.runLabel, args.runLabel, args.k, DEFAULT_CONFIG.initialRating, args.burnInTo);
  const runFinish = db.prepare(
    `UPDATE elo_runs SET finished_at = datetime('now'), races_processed = ?, results_processed = ?, success = ?, error_message = ? WHERE id = ?`,
  );

  const rows = db
    .prepare(
      `SELECT horse_id, race_date, venue, race_number, distance, track,
              jockey_name, trainer_name, finishing_position_num
         FROM horse_form_records
         WHERE race_date >= ? AND race_date <= ?
           AND venue IS NOT NULL AND race_number IS NOT NULL
         ORDER BY race_date ASC, venue ASC, race_number ASC`,
    )
    .all(args.fromDate, args.toDate) as FormRow[];
  log('elo11', `loaded ${rows.length} form rows`);

  // Group
  const races = new Map<string, { key: RaceKey; runners: FormRow[] }>();
  for (const r of rows) {
    if (!r.venue || r.race_number == null) continue;
    const k: RaceKey = { date: r.race_date, venue: r.venue, raceNo: r.race_number };
    const ks = `${k.date}|${k.venue}|${k.raceNo}`;
    if (!races.has(ks)) races.set(ks, { key: k, runners: [] });
    races.get(ks)!.runners.push(r);
  }
  const sortedRaces = Array.from(races.values()).sort((a, b) => {
    if (a.key.date !== b.key.date) return a.key.date < b.key.date ? -1 : 1;
    if (a.key.venue !== b.key.venue) return a.key.venue < b.key.venue ? -1 : 1;
    return a.key.raceNo - b.key.raceNo;
  });
  log('elo11', `reconstructed ${sortedRaces.length} races`);

  // Horse state: keyed by `${horseId}|${axisKey}` (axisKey in {'overall', 'turf_sprint', ...})
  const horseStore = new Map<string, AxisState>();
  // Jockey/Trainer remain single-axis (overall)
  const jockeyStore = new Map<string, AxisState>();
  const trainerStore = new Map<string, AxisState>();

  const cfg: V11Config = { ...DEFAULT_V11_CONFIG, k: args.k };

  const insertHorseSnap = db.prepare(
    `INSERT OR REPLACE INTO horse_elo_snapshots
       (id, horse_id, axis_key, surface, distance_bucket, as_of_race_id, as_of_date,
        rating, games_played, days_since_last_race, last_decay_applied_days, computed_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insertJockeySnap = db.prepare(
    `INSERT OR REPLACE INTO jockey_elo_snapshots
       (id, jockey_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))`,
  );
  const insertTrainerSnap = db.prepare(
    `INSERT OR REPLACE INTO trainer_elo_snapshots
       (id, trainer_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))`,
  );

  let processedRaces = 0;
  let processedResults = 0;
  let decayEvents = 0;

  const processLayer = (
    raceKey: RaceKey,
    layerRunners: Array<{ entityId: string; finish: number }>,
    store: Map<string, AxisState>,
    axisKey: string,
    insertSnap: (id: string, entityId: string, axisOrDate: unknown, ...rest: unknown[]) => void,
    isHorseLayer: boolean,
    surface: 'turf' | 'awt' | null,
    bucket: string | null,
  ): void => {
    if (layerRunners.length < 2) return;

    // 1) Apply decay + build Runner[] with pre-race rating
    const runners: Runner[] = [];
    const preSnapshot = new Map<string, { rating: number; decayDays: number | null; gapDays: number | null }>();
    for (const lr of layerRunners) {
      const state = getOrInitAxisState(store, lr.entityId, axisKey, cfg.initialRating);
      const decay = applyDecayIfIdle(state, raceKey.date, cfg);
      if (decay.decayAppliedDays != null) {
        state.rating = decay.rating;
        decayEvents++;
      }
      preSnapshot.set(lr.entityId, {
        rating: state.rating,
        decayDays: decay.decayAppliedDays,
        gapDays: decay.daysSinceLast,
      });
      runners.push({ entityId: lr.entityId, finish: lr.finish, currentRating: state.rating });
    }

    // 2) Compute pairwise deltas
    const deltas = computeRaceDeltas(runners, cfg);

    // 3) Apply + snapshot
    for (const [entityId, delta] of deltas) {
      const state = store.get(`${entityId}|${axisKey}`)!;
      state.rating += delta;
      state.gamesPlayed += 1;
      state.lastRaceDate = raceKey.date;
      const pre = preSnapshot.get(entityId)!;

      const snapId = `${entityId}|${axisKey}|${raceKey.date}|${raceKey.venue}|${raceKey.raceNo}`;
      if (isHorseLayer) {
        insertSnap(
          snapId,
          entityId,
          axisKey,
          surface,
          bucket,
          raceKey.date,
          state.rating,
          state.gamesPlayed,
          pre.gapDays,
          pre.decayDays,
        );
      } else {
        // jockey/trainer 6-arg signature (id, entity_id, as_of_date, rating, games_played)
        insertSnap(snapId, entityId, raceKey.date, state.rating, state.gamesPlayed);
      }
    }
  };

  const raceTx = db.transaction((runners: FormRow[], raceKey: RaceKey) => {
    const surface = normalizeSurface(runners[0]?.track ?? null);
    const bucket = distanceBucket(runners[0]?.distance ?? null);
    const axisKey = buildAxisKey(surface, bucket);

    // Layer A — horse OVERALL
    processLayer(
      raceKey,
      runners.map((r) => ({ entityId: r.horse_id, finish: r.finishing_position_num })),
      horseStore,
      'overall',
      (id, entityId, axis, s, b, d, rating, games, gap, decay) =>
        insertHorseSnap.run(id, entityId, axis, s, b, d, rating, games, gap, decay),
      true,
      null,
      null,
    );

    // Layer B — horse per-AXIS (if surface + bucket known)
    if (axisKey) {
      processLayer(
        raceKey,
        runners.map((r) => ({ entityId: r.horse_id, finish: r.finishing_position_num })),
        horseStore,
        axisKey,
        (id, entityId, axis, s, b, d, rating, games, gap, decay) =>
          insertHorseSnap.run(id, entityId, axis, s, b, d, rating, games, gap, decay),
        true,
        surface,
        bucket,
      );
    }

    // Layer C — jockey
    processLayer(
      raceKey,
      runners.filter((r) => r.jockey_name).map((r) => ({ entityId: r.jockey_name!, finish: r.finishing_position_num })),
      jockeyStore,
      'overall',
      (id, entityId, d, rating, games) =>
        insertJockeySnap.run(id, entityId, d, rating, games),
      false,
      null,
      null,
    );

    // Layer D — trainer
    processLayer(
      raceKey,
      runners.filter((r) => r.trainer_name).map((r) => ({ entityId: r.trainer_name!, finish: r.finishing_position_num })),
      trainerStore,
      'overall',
      (id, entityId, d, rating, games) =>
        insertTrainerSnap.run(id, entityId, d, rating, games),
      false,
      null,
      null,
    );

    processedResults += runners.length;
  });

  log('elo11', `starting race loop; first race = ${sortedRaces[0]?.key.date}|${sortedRaces[0]?.key.venue}|${sortedRaces[0]?.key.raceNo}`);
  const t0 = Date.now();
  for (const race of sortedRaces) {
    try {
      raceTx(race.runners, race.key);
      processedRaces++;
      if (processedRaces <= 3 || processedRaces % 100 === 0) {
        log('elo11', `progress ${processedRaces}/${sortedRaces.length} · ${processedResults} results · ${decayEvents} decays · ${Date.now() - t0}ms`);
      }
    } catch (err) {
      console.error(`[elo11] failed race ${race.key.date}|${race.key.venue}|${race.key.raceNo}:`, err);
    }
  }
  const ms = Date.now() - t0;
  log('elo11', `done: ${processedRaces} races · ${processedResults} results · ${decayEvents} decays · ${ms}ms`);
  log('elo11', `horse axes stored=${horseStore.size} jockeys=${jockeyStore.size} trainers=${trainerStore.size}`);

  runFinish.run(processedRaces, processedResults, 1, null, args.runLabel);
  db.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
