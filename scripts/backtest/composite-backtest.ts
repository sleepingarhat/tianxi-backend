#!/usr/bin/env tsx
/**
 * Composite-score backtest harness (Priority 4 · 2026-05-01).
 *
 * Replays the `0.7/0.2/0.1 ELO + factor-bonus` ranking over historical
 * race_results and measures how often the predicted rank matches the
 * actual finishing order. Mirrors the scoring logic in
 * `src/routes/analyze.ts` but runs against bulk-local.db directly so
 * a single pass over a full season completes in <60s.
 *
 * Usage:
 *   tsx scripts/backtest/composite-backtest.ts \
 *       --db bulk-local.db \
 *       --from 2025-09-01 --to 2026-04-15 \
 *       --engine v12 \
 *       --w-horse 0.7 --w-jockey 0.2 --w-trainer 0.1 \
 *       --factors recency,distance,going,draw,weight,combo \
 *       --out /tmp/backtest.json \
 *       --ledger /tmp/backtest-ledger.csv
 *
 * Output JSON shape:
 *   {
 *     config: {...},
 *     raceCount, runnerCount,
 *     metrics: {
 *       top1HitRate,          // predicted#1 == actual#1
 *       top3HitRate,          // predicted#1 finished in actual top-3
 *       podiumIOU,             // |intersect(pred top3, actual top3)| / 3
 *       meanSpearman,         // rank correlation across runners
 *       brierTop1,            // Brier score of pred#1 win prob
 *       marketTop1HitRate,    // HKJC-favourite baseline (if odds available)
 *       byMonth: [...],
 *     }
 *   }
 *
 * Does NOT edit any flagged files. Factor queries replicate the exact
 * SQL already used in scripts/test-composite.ts.
 */
import Database from 'better-sqlite3';
import { distanceBucket } from '../ingest/lib/parsers.js';
import { writeFileSync } from 'node:fs';

// ── CLI parsing ─────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const ix = process.argv.indexOf(`--${name}`);
  if (ix >= 0 && ix + 1 < process.argv.length) return process.argv[ix + 1];
  return fallback ?? '';
}
function argNum(name: string, fallback: number): number {
  const v = arg(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function argBool(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DB_PATH = arg('db', 'bulk-local.db');
const FROM = arg('from', '2025-09-01');
const TO = arg('to', '2026-04-15');
const ENGINE = (arg('engine', 'v12') === 'v11' ? 'v11' : 'v12') as 'v11' | 'v12';
const W_HORSE = argNum('w-horse', 0.7);
const W_JOCKEY = argNum('w-jockey', 0.2);
const W_TRAINER = argNum('w-trainer', 0.1);
const FACTORS_RAW = arg('factors', 'recency,distance,going,draw,weight,combo');
const FACTORS = new Set(
  FACTORS_RAW === 'none' || FACTORS_RAW === '' ? [] :
  FACTORS_RAW.split(',').map(s => s.trim()).filter(Boolean)
);
// Multi-axis ELO mode (2026-05-12). Values:
//   overall  → current behaviour (single-axis 'overall' rating per horse)
//   axis     → use per-(surface, distance_bucket) rating; fall back to overall if cold-start
//   hybrid   → 0.6 × axis + 0.4 × overall (smoothed cold-start)
const HORSE_ELO_MODE = (arg('horse-elo-mode', 'overall') as 'overall' | 'axis' | 'hybrid');
if (!['overall','axis','hybrid'].includes(HORSE_ELO_MODE)) throw new Error('--horse-elo-mode must be overall|axis|hybrid');
const OUT = arg('out', '');
const LEDGER = arg('ledger', '');
const VERBOSE = argBool('verbose');

// ── Types ───────────────────────────────────────────────────────────────
interface RaceMeta {
  id: string;
  date: string;
  venue: string;
  distance: number;
  going: string | null;
}
interface RunnerRow {
  race_id: string;
  horse_id: string;
  jockey_id: string | null;
  trainer_id: string | null;
  jockey_name: string | null;
  trainer_name: string | null;
  finishing_position: number;
  draw: number | null;
  actual_weight: number | null;
  win_odds: number | null;
}
interface ScoredRunner extends RunnerRow {
  eloH: number | null;
  eloJ: number | null;
  eloT: number | null;
  eloComposite: number | null;
  factorBonus: number;
  finalScore: number | null;
  predictedRank: number;
  pWin: number;
}

// ── DB wrapper + prepared-query cache ───────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('synchronous = OFF');

// (qELO dead block removed 2026-05-12 — was throwing SqliteError: no such table __TBL__ at module load; readElo via eloStmtCache below is the live path)
// Reusable per-entity prepared statements keyed by (entity, engine).
const eloStmtCache = new Map<string, Database.Statement>();
function eloStmt(entity: 'horse' | 'jockey' | 'trainer', _engine: 'v11' | 'v12'): Database.Statement {
  // 2026-05-12 fix: drop axis_key for jockey/trainer (column doesn't exist on those
  // tables) and drop v12/v11 id-prefix split (compute_v11 wipes & rewrites all
  // snapshots, no prefix used). Previous code threw at prepare() and was silently
  // caught → eloJ/eloT always null → eloComposite null → 0 valid races.
  const k = entity;
  let s = eloStmtCache.get(k);
  if (s) return s;
  const table = entity + '_elo_snapshots';
  const col = entity + '_id';
  const axisFilter = entity === 'horse' ? "AND axis_key='overall'" : '';
  const sql = `SELECT rating FROM ${table} WHERE ${col}=? ${axisFilter} AND as_of_date<? ORDER BY as_of_date DESC LIMIT 1`;
  s = db.prepare(sql);
  eloStmtCache.set(k, s);
  return s;
}
// 2026-05-12: axis-keyed horse rating (multi-axis ELO from compute_v11).
// Query takes BOTH possible surfaces for the bucket and returns the most-recent.
const horseAxisStmt = db.prepare(
  `SELECT rating, axis_key FROM horse_elo_snapshots
     WHERE horse_id = ?
       AND axis_key IN (?, ?)
       AND as_of_date < ?
     ORDER BY as_of_date DESC LIMIT 1`
);
function readHorseAxisElo(horseId: string, asOf: string, bucket: string | null): { rating: number; axis: string } | null {
  if (!bucket) return null;
  try {
    const row = horseAxisStmt.get(horseId, `turf_${bucket}`, `awt_${bucket}`, asOf) as { rating: number; axis_key: string } | undefined;
    if (row?.rating != null) return { rating: row.rating, axis: row.axis_key };
  } catch { /* table missing axis rows */ }
  return null;
}
function readHorseEloByMode(horseId: string | null, asOf: string, distance: number | null): number | null {
  if (!horseId) return null;
  const overall = readElo('horse', horseId, asOf);
  if (HORSE_ELO_MODE === 'overall') return overall;
  const axis = readHorseAxisElo(horseId, asOf, distanceBucket(distance));
  if (HORSE_ELO_MODE === 'axis') return axis ? axis.rating : overall;
  if (axis && overall != null) return 0.6 * axis.rating + 0.4 * overall;
  return axis ? axis.rating : overall;
}

function readElo(entity: 'horse' | 'jockey' | 'trainer', id: string | null, asOf: string): number | null {
  if (!id) return null;
  try {
    const row = eloStmt(entity, ENGINE).get(id, asOf) as { rating: number } | undefined;
    return row?.rating ?? null;
  } catch (e) {
    if (!(globalThis as any).__readEloErrLogged) {
      console.error('[readElo] failed for entity=' + entity + ':', (e as Error).message);
      (globalThis as any).__readEloErrLogged = true;
    }
    return null;
  }
}

// ── Factor helpers (mirror analyze.ts semantics) ────────────────────────
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

function daysBetween(a: string, b: string): number {
  const ma = Date.parse(a + 'T00:00:00Z');
  const mb = Date.parse(b + 'T00:00:00Z');
  return Math.round((mb - ma) / 86_400_000);
}
function recencyBonus(daysSinceLast: number | null): number {
  if (daysSinceLast == null) return 0;
  if (daysSinceLast < 7) return -10;
  if (daysSinceLast <= 28) return 10;
  if (daysSinceLast <= 60) return 0;
  if (daysSinceLast <= 120) return -5;
  return -15;
}
function rateBonus(starts: number, top3: number, scale = 15): number {
  // Bayesian-ish shrink: prior 0.30 top3 rate with n=5 pseudo-starts.
  if (!starts) return 0;
  const rate = (top3 + 0.30 * 5) / (starts + 5);
  return (rate - 0.30) * scale;
}
function weightBonus(curr: number | null, avg: number | null): number {
  if (curr == null || avg == null) return 0;
  const delta = curr - avg;
  return -delta * 0.5; // every +1kg above avg → -0.5 score
}

function computeFactorBonus(
  runner: RunnerRow,
  meta: RaceMeta,
): { total: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  // Recency
  if (FACTORS.has('recency')) {
    const lr = qLastRaceDate.get(runner.horse_id, meta.date) as { last_date: string | null } | undefined;
    const days = lr?.last_date ? daysBetween(lr.last_date, meta.date) : null;
    parts.recency = recencyBonus(days);
  }
  // Distance fit (±200m bucket)
  if (FACTORS.has('distance')) {
    const r = qDistFit.get(
      runner.horse_id, meta.date, meta.distance - 200, meta.distance + 200,
    ) as { starts: number; top3: number } | undefined;
    parts.distance = rateBonus(r?.starts ?? 0, r?.top3 ?? 0, 15);
  }
  // Going fit
  if (FACTORS.has('going') && meta.going) {
    const r = qGoingFit.get(runner.horse_id, meta.date, meta.going) as { starts: number; top3: number } | undefined;
    parts.going = rateBonus(r?.starts ?? 0, r?.top3 ?? 0, 12);
  }
  // Draw bias (±100m bucket at venue)
  if (FACTORS.has('draw') && runner.draw) {
    const r = qDrawBias.get(
      meta.venue, meta.date, meta.distance - 100, meta.distance + 100, runner.draw,
    ) as { starts: number; top3: number } | undefined;
    parts.draw = rateBonus(r?.starts ?? 0, r?.top3 ?? 0, 10);
  }
  // Weight delta
  if (FACTORS.has('weight')) {
    const r = qWeightDelta.get(runner.horse_id, meta.date) as { avg_w: number | null } | undefined;
    parts.weight = weightBonus(runner.actual_weight, r?.avg_w ?? null);
  }
  // Jockey-trainer combo
  if (FACTORS.has('combo') && runner.jockey_id && runner.trainer_id) {
    const r = qCombo.get(runner.jockey_id, runner.trainer_id, meta.date) as { starts: number; top3: number } | undefined;
    parts.combo = rateBonus(r?.starts ?? 0, r?.top3 ?? 0, 8);
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts };
}

// ── Race iteration + metrics ────────────────────────────────────────────
const races = db.prepare(`
  SELECT r.id AS id, rm.date AS date, rm.venue AS venue,
         r.distance AS distance, r.going AS going
    FROM races r
    JOIN race_meetings rm ON rm.id = r.meeting_id
   WHERE rm.date BETWEEN ? AND ?
     AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_id = r.id AND rr.finishing_position BETWEEN 1 AND 98)
   ORDER BY rm.date ASC, r.id ASC`).all(FROM, TO) as RaceMeta[];

console.error(`[backtest] date range ${FROM}..${TO} → ${races.length} races`);
console.error(`[backtest] engine=${ENGINE} weights=H${W_HORSE}/J${W_JOCKEY}/T${W_TRAINER}`);
console.error(`[backtest] factors enabled: ${Array.from(FACTORS).join(',') || '(none — pure ELO)'}`);
console.error(`[backtest] horse-elo-mode=${HORSE_ELO_MODE}`);

// 2026-05-12 preflight: log snapshot row counts + a sample readElo call so any
// future regression is visible at the top of the run instead of after 30min.
try {
  const ph = db.prepare("SELECT COUNT(*) AS n FROM horse_elo_snapshots WHERE axis_key='overall'").get() as {n:number};
  const pj = db.prepare("SELECT COUNT(*) AS n FROM jockey_elo_snapshots").get() as {n:number};
  const pt = db.prepare("SELECT COUNT(*) AS n FROM trainer_elo_snapshots").get() as {n:number};
  console.error(`[preflight] snapshot rows: horse_overall=${ph.n} jockey=${pj.n} trainer=${pt.n}`);
  const sample = db.prepare(`SELECT rr.horse_id, rr.jockey_id, rr.trainer_id, j.name_en AS jn, t.name_en AS tn, rm.date FROM race_results rr JOIN races r ON r.id=rr.race_id JOIN race_meetings rm ON rm.id=r.meeting_id LEFT JOIN jockeys j ON j.id=rr.jockey_id LEFT JOIN trainers t ON t.id=rr.trainer_id WHERE rm.date BETWEEN ? AND ? AND rr.finishing_position BETWEEN 1 AND 98 LIMIT 1`).get(FROM, TO) as any;
  if (sample) {
    const eH = readElo('horse', sample.horse_id, sample.date);
    const eJ = readElo('jockey', sample.jn, sample.date);
    const eT = readElo('trainer', sample.tn, sample.date);
    console.error(`[preflight] sample h=${sample.horse_id} jn=${sample.jn} tn=${sample.tn} d=${sample.date} → eH=${eH} eJ=${eJ} eT=${eT}`);
  }
} catch (e) {
  console.error('[preflight] failed:', (e as Error).message);
}

const qRunners = db.prepare(`
  SELECT rr.race_id, rr.horse_id, rr.jockey_id, rr.trainer_id,
         j.name_en AS jockey_name, t.name_en AS trainer_name,
         rr.finishing_position, rr.draw, rr.actual_weight, rr.win_odds
    FROM race_results rr
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
   WHERE rr.race_id = ?
     AND rr.finishing_position BETWEEN 1 AND 98`);

type RaceLedgerRow = {
  date: string; venue: string; raceId: string; distance: number; going: string | null;
  fieldSize: number;
  predTop1Horse: string; actualTop1Horse: string;
  top1Hit: boolean; top3Hit: boolean; podiumIOU: number;
  marketTop1Hit: boolean | null;
  spearman: number | null;
};
const ledger: RaceLedgerRow[] = [];
const monthly: Record<string, { n: number; top1: number; top3: number; podium: number; market: number; marketN: number }> = {};

let raceCount = 0;
let runnerCount = 0;
let validRaces = 0;
let sumTop1 = 0, sumTop3 = 0, sumPodiumIOU = 0, sumSpearman = 0, sumSpearmanN = 0;
let marketHits = 0, marketTotal = 0;

function spearman(pred: number[], actual: number[]): number | null {
  if (pred.length !== actual.length || pred.length < 3) return null;
  const n = pred.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (pred[i] - actual[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

for (const meta of races) {
  raceCount++;
  const runners = qRunners.all(meta.id) as RunnerRow[];
  if (runners.length < 4) continue;
  runnerCount += runners.length;

  const scored: ScoredRunner[] = runners.map(r => {
    const eloH = readHorseEloByMode(r.horse_id, meta.date, meta.distance);
    // 2026-05-12 fix: compute_v11 stores jockey/trainer snapshots keyed by NAME (not id);
    // looking them up by id returned null → all races unscorable. Use *_name + rescale.
    const eloJ = readElo('jockey', r.jockey_name, meta.date);
    const eloT = readElo('trainer', r.trainer_name, meta.date);
    let eloComposite: number | null = null;
    if (eloH != null) {
      let num = eloH * W_HORSE;
      let den = W_HORSE;
      if (eloJ != null) { num += eloJ * W_JOCKEY; den += W_JOCKEY; }
      if (eloT != null) { num += eloT * W_TRAINER; den += W_TRAINER; }
      eloComposite = num / den;
    }
    const eloParts = [eloH, eloJ, eloT];
    const { total: factorBonus } = computeFactorBonus(r, meta);
    const finalScore = eloComposite != null ? eloComposite + factorBonus : null;
    return {
      ...r,
      eloH, eloJ, eloT, eloComposite, factorBonus,
      finalScore,
      predictedRank: 0,
      pWin: 0,
    };
  });

  // Skip races where we can't score any runners (no ELO — early season).
  const scorable = scored.filter(s => s.finalScore != null);
  if (scorable.length < 4) continue;
  validRaces++;

  // Rank by finalScore desc — higher = better.
  scorable.sort((a, b) => (b.finalScore! - a.finalScore!));
  scorable.forEach((s, i) => (s.predictedRank = i + 1));

  // Plackett-Luce-ish softmax for pWin (normalise around the race mean).
  const mean = scorable.reduce((a, s) => a + s.finalScore!, 0) / scorable.length;
  const exps = scorable.map(s => Math.exp((s.finalScore! - mean) / 50));
  const Z = exps.reduce((a, b) => a + b, 0);
  scorable.forEach((s, i) => (s.pWin = exps[i] / Z));

  // Actual top-1/top-3 in runners array (sorted by finishing position).
  const actualSorted = [...runners].sort((a, b) => a.finishing_position - b.finishing_position);
  const actualTop1 = actualSorted[0].horse_id;
  const actualTop3 = new Set(actualSorted.slice(0, 3).map(r => r.horse_id));

  const predTop1 = scorable[0].horse_id;
  const predTop3 = new Set(scorable.slice(0, Math.min(3, scorable.length)).map(s => s.horse_id));

  const top1Hit = predTop1 === actualTop1;
  const top3Hit = actualTop3.has(predTop1);
  const podiumIntersect = [...predTop3].filter(h => actualTop3.has(h)).length;
  const podiumIOU = podiumIntersect / 3;

  // Market baseline: lowest win_odds is the favourite.
  const oddsSet = scorable.filter(s => s.win_odds != null && s.win_odds > 0);
  let marketTop1Hit: boolean | null = null;
  if (oddsSet.length >= 3) {
    oddsSet.sort((a, b) => (a.win_odds! - b.win_odds!));
    marketTop1Hit = oddsSet[0].horse_id === actualTop1;
    marketHits += marketTop1Hit ? 1 : 0;
    marketTotal++;
  }

  // Spearman rank correlation (only over scorable runners present in both sides).
  const idToPred = new Map(scorable.map(s => [s.horse_id, s.predictedRank]));
  const predRanks: number[] = [];
  const actualRanks: number[] = [];
  for (let i = 0; i < actualSorted.length; i++) {
    const p = idToPred.get(actualSorted[i].horse_id);
    if (p != null) {
      actualRanks.push(i + 1);
      predRanks.push(p);
    }
  }
  const sp = spearman(predRanks, actualRanks);
  if (sp != null) {
    sumSpearman += sp;
    sumSpearmanN++;
  }

  sumTop1 += top1Hit ? 1 : 0;
  sumTop3 += top3Hit ? 1 : 0;
  sumPodiumIOU += podiumIOU;

  // Monthly bucket
  const ym = meta.date.slice(0, 7);
  const bucket = monthly[ym] ??= { n: 0, top1: 0, top3: 0, podium: 0, market: 0, marketN: 0 };
  bucket.n++;
  bucket.top1 += top1Hit ? 1 : 0;
  bucket.top3 += top3Hit ? 1 : 0;
  bucket.podium += podiumIOU;
  if (marketTop1Hit != null) {
    bucket.market += marketTop1Hit ? 1 : 0;
    bucket.marketN++;
  }

  ledger.push({
    date: meta.date, venue: meta.venue, raceId: meta.id,
    distance: meta.distance, going: meta.going,
    fieldSize: scorable.length,
    predTop1Horse: predTop1, actualTop1Horse: actualTop1,
    top1Hit, top3Hit, podiumIOU,
    marketTop1Hit,
    spearman: sp,
  });

  if (VERBOSE && raceCount % 200 === 0) {
    console.error(`  [${raceCount}/${races.length}] ${meta.date} ${meta.id} top1=${top1Hit?'✓':'✗'}`);
  }
}

// ── Aggregate + emit ────────────────────────────────────────────────────
const summary = {
  config: {
    dbPath: DB_PATH, from: FROM, to: TO,
    engine: ENGINE,
    weights: { horse: W_HORSE, jockey: W_JOCKEY, trainer: W_TRAINER },
    factors: Array.from(FACTORS),
  },
  raceCount,
  validRaces,
  runnerCount,
  metrics: {
    top1HitRate: validRaces ? sumTop1 / validRaces : 0,
    top3HitRate: validRaces ? sumTop3 / validRaces : 0,
    meanPodiumIOU: validRaces ? sumPodiumIOU / validRaces : 0,
    meanSpearman: sumSpearmanN ? sumSpearman / sumSpearmanN : null,
    marketTop1HitRate: marketTotal ? marketHits / marketTotal : null,
    marketTotal,
  },
  byMonth: Object.fromEntries(
    Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b)).map(([ym, b]) => [
      ym, {
        n: b.n,
        top1HitRate: b.n ? b.top1 / b.n : 0,
        top3HitRate: b.n ? b.top3 / b.n : 0,
        podiumIOU: b.n ? b.podium / b.n : 0,
        marketTop1HitRate: b.marketN ? b.market / b.marketN : null,
      },
    ]),
  ),
};

const json = JSON.stringify(summary, null, 2);
if (OUT) {
  writeFileSync(OUT, json + '\n');
  console.error(`[backtest] summary → ${OUT}`);
} else {
  console.log(json);
}

if (LEDGER) {
  const header = 'date,venue,raceId,distance,going,fieldSize,predTop1,actualTop1,top1Hit,top3Hit,podiumIOU,marketTop1Hit,spearman\n';
  const rows = ledger.map(r => [
    r.date, r.venue, r.raceId, r.distance, r.going ?? '',
    r.fieldSize, r.predTop1Horse, r.actualTop1Horse,
    r.top1Hit ? 1 : 0, r.top3Hit ? 1 : 0,
    r.podiumIOU.toFixed(3),
    r.marketTop1Hit == null ? '' : (r.marketTop1Hit ? 1 : 0),
    r.spearman == null ? '' : r.spearman.toFixed(3),
  ].join(',')).join('\n');
  writeFileSync(LEDGER, header + rows + '\n');
  console.error(`[backtest] ledger → ${LEDGER} (${ledger.length} races)`);
}

console.error(`[backtest] done.`);
console.error(`  raceCount=${raceCount} validRaces=${validRaces} runners=${runnerCount}`);
console.error(`  top1=${(summary.metrics.top1HitRate * 100).toFixed(1)}%  top3=${(summary.metrics.top3HitRate * 100).toFixed(1)}%  IoU=${summary.metrics.meanPodiumIOU.toFixed(3)}`);
if (summary.metrics.marketTop1HitRate != null) {
  console.error(`  market baseline top1=${(summary.metrics.marketTop1HitRate * 100).toFixed(1)}%  (n=${marketTotal})`);
}
if (summary.metrics.meanSpearman != null) {
  console.error(`  mean Spearman rank corr = ${summary.metrics.meanSpearman.toFixed(3)}`);
}

db.close();
