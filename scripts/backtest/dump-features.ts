// scripts/backtest/dump-features.ts
  //
  // Export per-runner feature CSV for LightGBM walk-forward training.
  // Mirrors the SQL queries in composite-backtest.ts verbatim so features
  // match what analyze.ts uses at inference time.
  //
  // Usage:
  //   pnpm tsx scripts/backtest/dump-features.ts \
  //     --db=bulk-local.db \
  //     --from=2024-09-01 --to=2026-04-30 \
  //     --out=features.csv
  //
  // One row per (race, runner). Columns:
  //   race_id, race_date, venue, race_no, distance, going, field_size,
  //   horse_id, jockey_id, trainer_id, draw, actual_weight, win_odds,
  //   h_elo, j_elo, t_elo, days_since_last,
  //   dist_starts, dist_top3, going_starts, going_top3,
  //   draw_starts, draw_top3, combo_starts, combo_top3, weight_avg5,
  //   elo_composite, factor_bonus, baseline_score,
  //   finishing_position, is_top1, is_top3
  //
  // 'baseline_score' = elo_composite + factor_bonus, identical to analyze.ts
  // finalScore — included so the LGB script can compute the ELO baseline
  // hit-rate over the SAME race set for an apples-to-apples comparison.

  import Database from 'better-sqlite3';
  import { writeFileSync, appendFileSync } from 'node:fs';

  function arg(name: string, fallback?: string): string {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const ix = process.argv.indexOf(`--${name}`);
    if (ix >= 0 && ix + 1 < process.argv.length) return process.argv[ix + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  function argNum(name: string, fallback: number): number {
    const v = arg(name, String(fallback));
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  const DB_PATH = arg('db', 'bulk-local.db');
  const FROM = arg('from', '2024-09-01');
  const TO = arg('to', '2026-04-30');
  const ENGINE = (arg('engine', 'v12') === 'v11' ? 'v11' : 'v12') as 'v11' | 'v12';
  const W_HORSE = argNum('w-horse', 0.7);
  const W_JOCKEY = argNum('w-jockey', 0.2);
  const W_TRAINER = argNum('w-trainer', 0.1);
  const OUT = arg('out', 'features.csv');

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('cache_size = -200000'); // 200MB cache

  // ── ELO readers (verbatim mirror of composite-backtest.ts L121-L147) ────
  const eloStmtCache = new Map<string, Database.Statement>();
  function eloStmt(entity: 'horse' | 'jockey' | 'trainer', engine: 'v11' | 'v12'): Database.Statement {
    const k = `${entity}|${engine}`;
    let s = eloStmtCache.get(k);
    if (s) return s;
    const table = `${entity}_elo_snapshots`;
    const col = `${entity}_id`;
    const sql = engine === 'v12'
      ? `SELECT rating FROM ${table} WHERE ${col}=? AND axis_key='overall' AND as_of_date<? AND id LIKE 'v12:%' ORDER BY as_of_date DESC LIMIT 1`
      : `SELECT rating FROM ${table} WHERE ${col}=? AND axis_key='overall' AND as_of_date<? AND id NOT LIKE 'v12:%' ORDER BY as_of_date DESC LIMIT 1`;
    s = db.prepare(sql);
    eloStmtCache.set(k, s);
    return s;
  }
  function readElo(entity: 'horse' | 'jockey' | 'trainer', id: string | null, asOf: string): number | null {
    if (!id) return null;
    try {
      const row = eloStmt(entity, ENGINE).get(id, asOf) as { rating: number } | undefined;
      if (row?.rating != null) return row.rating;
      if (ENGINE === 'v12') {
        const fb = eloStmt(entity, 'v11').get(id, asOf) as { rating: number } | undefined;
        return fb?.rating ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Factor queries (verbatim from composite-backtest.ts) ────────────────
  const qDistFit = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ?
       AND rm.date < ?
       AND r.distance BETWEEN ? AND ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qGoingFit = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ?
       AND rm.date < ?
       AND r.going = ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qDrawBias = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rm.venue = ?
       AND rm.date < ?
       AND r.distance BETWEEN ? AND ?
       AND rr.draw = ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qWeightDelta = db.prepare(`
    SELECT AVG(rr.actual_weight) AS avg_w
      FROM (
        SELECT rr.actual_weight
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id = ?
           AND rm.date < ?
           AND rr.actual_weight IS NOT NULL
         ORDER BY rm.date DESC LIMIT 5
      ) rr`);

  const qLastRaceDate = db.prepare(`
    SELECT MAX(rm.date) AS last_date
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ? AND rm.date < ?`);

  const qCombo = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.jockey_id = ?
       AND rr.trainer_id = ?
       AND rm.date < ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  // ── Bonus helpers (verbatim) ────────────────────────────────────────────
  function daysBetween(a: string, b: string): number {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
  }
  function recencyBonus(d: number | null): number {
    if (d == null) return 0;
    if (d < 7) return -10;
    if (d <= 28) return 10;
    if (d <= 60) return 0;
    if (d <= 120) return -5;
    return -15;
  }
  function rateBonus(starts: number, top3: number, scale = 15): number {
    if (!starts) return 0;
    return ((top3 + 0.30 * 5) / (starts + 5) - 0.30) * scale;
  }
  function weightBonus(curr: number | null, avg: number | null): number {
    if (curr == null || avg == null) return 0;
    return -(curr - avg) * 0.5;
  }

  // ── Race iteration ──────────────────────────────────────────────────────
  type RaceMeta = { id: string; date: string; venue: string; race_number: number; distance: number; going: string };
  type RunnerRow = {
    race_id: string; horse_id: string; jockey_id: string | null; trainer_id: string | null;
    finishing_position: number; draw: number | null; actual_weight: number | null; win_odds: number | null;
  };

  const races = db.prepare(`
    SELECT r.id AS id, rm.date AS date, rm.venue AS venue, r.race_number AS race_number,
           r.distance AS distance, r.going AS going
      FROM races r
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rm.date BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_id = r.id AND rr.finishing_position BETWEEN 1 AND 98)
     ORDER BY rm.date ASC, r.id ASC`).all(FROM, TO) as RaceMeta[];

  const qRunners = db.prepare(`
    SELECT race_id, horse_id, jockey_id, trainer_id, finishing_position,
           draw, actual_weight, win_odds
      FROM race_results
     WHERE race_id = ?
       AND finishing_position BETWEEN 1 AND 98`);

  console.error(`[dump-features] ${FROM}..${TO} → ${races.length} races · ELO=${ENGINE} · W=H${W_HORSE}/J${W_JOCKEY}/T${W_TRAINER}`);
  console.error(`[dump-features] writing → ${OUT}`);

  const HEADER = [
    'race_id','race_date','venue','race_no','distance','going','field_size',
    'horse_id','jockey_id','trainer_id','draw','actual_weight','win_odds',
    'h_elo','j_elo','t_elo','days_since_last',
    'dist_starts','dist_top3','going_starts','going_top3',
    'draw_starts','draw_top3','combo_starts','combo_top3','weight_avg5',
    'elo_composite','factor_bonus','baseline_score',
    'finishing_position','is_top1','is_top3',
  ];
  writeFileSync(OUT, HEADER.join(',') + '\n');

  function csv(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  let buf: string[] = [];
  let written = 0;
  function flush() { if (buf.length) { appendFileSync(OUT, buf.join('')); buf = []; } }

  for (let i = 0; i < races.length; i++) {
    const meta = races[i];
    const runners = qRunners.all(meta.id) as RunnerRow[];
    if (runners.length < 4) continue;

    // sort by finish position to identify top1/top3 horse_ids for label
    const sorted = [...runners].sort((a, b) => a.finishing_position - b.finishing_position);
    const top1Id = sorted[0].horse_id;
    const top3Set = new Set(sorted.slice(0, 3).map(r => r.horse_id));
    const fieldSize = runners.length;

    for (const r of runners) {
      const hElo = readElo('horse', r.horse_id, meta.date);
      const jElo = readElo('jockey', r.jockey_id, meta.date);
      const tElo = readElo('trainer', r.trainer_id, meta.date);
      const eloParts = [hElo, jElo, tElo].map((e, ix) => e == null ? null : e * [W_HORSE, W_JOCKEY, W_TRAINER][ix]);
      const eloComposite = eloParts.some(p => p == null) ? null : (eloParts as number[]).reduce((a, b) => a + b, 0);

      const lr = qLastRaceDate.get(r.horse_id, meta.date) as { last_date: string | null } | undefined;
      const daysSince = lr?.last_date ? daysBetween(lr.last_date, meta.date) : null;

      const dF = qDistFit.get(r.horse_id, meta.date, meta.distance - 200, meta.distance + 200) as { starts: number; top3: number } | undefined;
      const gF = meta.going ? qGoingFit.get(r.horse_id, meta.date, meta.going) as { starts: number; top3: number } | undefined : undefined;
      const drawF = (r.draw != null) ? qDrawBias.get(meta.venue, meta.date, meta.distance - 100, meta.distance + 100, r.draw) as { starts: number; top3: number } | undefined : undefined;
      const wF = qWeightDelta.get(r.horse_id, meta.date) as { avg_w: number | null } | undefined;
      const cF = (r.jockey_id && r.trainer_id) ? qCombo.get(r.jockey_id, r.trainer_id, meta.date) as { starts: number; top3: number } | undefined : undefined;

      const fRecency = recencyBonus(daysSince);
      const fDist = rateBonus(dF?.starts ?? 0, dF?.top3 ?? 0, 15);
      const fGoing = rateBonus(gF?.starts ?? 0, gF?.top3 ?? 0, 12);
      const fDraw = rateBonus(drawF?.starts ?? 0, drawF?.top3 ?? 0, 10);
      const fWeight = weightBonus(r.actual_weight, wF?.avg_w ?? null);
      const fCombo = rateBonus(cF?.starts ?? 0, cF?.top3 ?? 0, 8);
      const factorBonus = fRecency + fDist + fGoing + fDraw + fWeight + fCombo;
      const baselineScore = eloComposite != null ? eloComposite + factorBonus : null;

      const row = [
        meta.id, meta.date, meta.venue, meta.race_number, meta.distance, meta.going, fieldSize,
        r.horse_id, r.jockey_id, r.trainer_id, r.draw, r.actual_weight, r.win_odds,
        hElo, jElo, tElo, daysSince,
        dF?.starts ?? 0, dF?.top3 ?? 0, gF?.starts ?? 0, gF?.top3 ?? 0,
        drawF?.starts ?? 0, drawF?.top3 ?? 0, cF?.starts ?? 0, cF?.top3 ?? 0, wF?.avg_w ?? null,
        eloComposite, factorBonus, baselineScore,
        r.finishing_position,
        r.horse_id === top1Id ? 1 : 0,
        top3Set.has(r.horse_id) ? 1 : 0,
      ].map(csv).join(',');
      buf.push(row + '\n');
      written++;
      if (buf.length >= 5000) flush();
    }
    if ((i + 1) % 100 === 0) console.error(`  [${i + 1}/${races.length}] races processed, ${written} rows written`);
  }
  flush();
  console.error(`[dump-features] done: ${written} rows × ${HEADER.length} cols → ${OUT}`);
  db.close();
  