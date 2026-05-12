// (qELO dead block removed 2026-05-12 — was throwing SqliteError: no such table __TBL__)
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

const qRunners = db.prepare(`
  SELECT race_id, horse_id, jockey_id, trainer_id, finishing_position,
         draw, actual_weight, win_odds
    FROM race_results
   WHERE race_id = ?
     AND finishing_position BETWEEN 1 AND 98`);

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
    const eloJ = readElo('jockey', r.jockey_id, meta.date);
    const eloT = readElo('trainer', r.trainer_id, meta.date);
    const eloParts = [
      eloH != null ? eloH * W_HORSE : null,
      eloJ != null ? eloJ * W_JOCKEY : null,
      eloT != null ? eloT * W_TRAINER : null,
    ];
    const eloComposite = eloParts.some(p => p == null) ? null :
      (eloParts as number[]).reduce((a, b) => a + b, 0);
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
