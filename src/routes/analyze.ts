import { Hono } from 'hono';
import type { Env, AnalyzeRequest } from '../types';
import { runTimesFMAnalysis } from '../services/timesfm';
import { generateAnalysisSummary } from '../services/ai';

export const analyzeRoutes = new Hono<{ Bindings: Env }>();

// POST /api/analyze — 因子分析（TimesFM + AI 綜合建議）
analyzeRoutes.post('/', async (c) => {
  const body = await c.req.json<AnalyzeRequest>();
  const { raceId, factors } = body;

  if (!raceId || !factors || factors.length === 0) {
    return c.json({ error: '請提供賽事 ID 和至少一個分析因子' }, 400);
  }

  try {
    // Step 1: 獲取賽事和出賽馬匹數據
    const race = await c.env.DB.prepare(`
      SELECT r.*, rm.date, rm.venue, rm.track_condition, rm.weather
      FROM races r
      JOIN race_meetings rm ON rm.id = r.meeting_id
      WHERE r.id = ?
    `).bind(raceId).first<any>();

    if (!race) {
      return c.json({ error: '找不到該場賽事' }, 404);
    }

    const { results: entries } = await c.env.DB.prepare(`
      SELECT rr.horse_id, rr.horse_number, rr.draw, rr.win_odds, rr.gear,
        h.name_en, h.name_ch, h.code, h.sire, h.dam, h.current_rating,
        j.name_ch AS jockey_ch, t.name_ch AS trainer_ch
      FROM race_results rr
      JOIN horses h ON h.id = rr.horse_id
      LEFT JOIN jockeys j ON j.id = rr.jockey_id
      LEFT JOIN trainers t ON t.id = rr.trainer_id
      WHERE rr.race_id = ?
      ORDER BY rr.horse_number
    `).bind(raceId).all();

    const horseIds = (entries ?? []).map((e: any) => e.horse_id);

    // Step 2: 運行 TimesFM 趨勢預測
    const timesfmResults = await runTimesFMAnalysis(
      c.env,
      c.env.DB,
      horseIds,
      factors
    );

    // Step 3: 構建賽事 context 並調用 AI 綜合分析
    const raceData = {
      date: race.date,
      venue: race.venue,
      trackCondition: race.track_condition,
      races: [{
        raceNumber: race.race_number,
        title: race.title,
        distance: race.distance,
        class: race.class,
        going: race.going,
        track: race.track,
        horses: (entries ?? []).map((e: any) => ({
          horseNumber: e.horse_number,
          nameCh: e.name_ch,
          name: e.name_en,
          draw: e.draw,
          jockeyCh: e.jockey_ch,
          trainerCh: e.trainer_ch,
          winOdds: e.win_odds,
          gear: e.gear,
          rating: e.current_rating,
          sire: e.sire,
          dam: e.dam,
        })),
      }],
    };

    const { aiSummary, recommendations } = await generateAnalysisSummary(
      c.env,
      raceData,
      timesfmResults,
      factors
    );

    // 計算整體信心度
    const avgConfidence = timesfmResults.length > 0
      ? timesfmResults.reduce((sum, r) => sum + r.confidence, 0) / timesfmResults.length
      : 0.7;

    return c.json({
      raceId,
      raceNumber: race.race_number,
      raceTitle: race.title,
      selectedFactors: factors,
      timesfmResults,
      aiSummary,
      recommendations,
      overallConfidence: Math.round(avgConfidence * 100) / 100,
    });
  } catch (err: any) {
    console.error('Analysis error:', err);
    return c.json({
      error: '分析時發生錯誤',
      details: err.message,
    }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Composite-score helpers (Phase B · ELO 0.7/0.2/0.1 + factor adjustments)
// ──────────────────────────────────────────────────────────────────────────

// Weight split confirmed by user 2026-04-28.
const ELO_WEIGHTS = { horse: 0.7, jockey: 0.2, trainer: 0.1 } as const;

// ELO engine version selector (v1.2 = time-weighted multi-axis, user-endorsed 2026-04-28).
// Rows in snapshot tables co-exist; v1.2 rows have id prefix 'v12:', v1.1 rows don't.
// Defaults to v12; reads can opt into v11 via ?engine=v11 query param or env override.
type EloEngine = 'v11' | 'v12';

type EloReading = {
  rating: number;
  confidence: number | null;
  isFrozen: boolean;
  isRetired: boolean;
  isProvisional: boolean;
  engine: EloEngine;
};

async function fetchAxisEloReading(
  db: D1Database,
  entityTable: 'horse' | 'jockey' | 'trainer',
  entityId: string | number,
  asOf: string,
  engine: EloEngine,
): Promise<EloReading | null> {
  const table = `${entityTable}_elo_snapshots`;
  const col = `${entityTable}_id`;
  // v1.2 snapshots carry extra columns (confidence / is_frozen / is_retired / is_provisional);
  // v1.1 rows don't have them. Try the richer query for v12; if schema lacks columns (e.g. D1
  // hasn't had v12 migration applied yet) or no v12 rows exist, fall back to v11.
  if (engine === 'v12') {
    try {
      const row = await db.prepare(
        `SELECT rating, confidence, is_frozen, is_retired, is_provisional
           FROM ${table}
          WHERE ${col} = ? AND axis_key = 'overall' AND as_of_date < ?
            AND id LIKE 'v12:%'
          ORDER BY as_of_date DESC LIMIT 1`
      ).bind(entityId, asOf).first<any>();
      if (row?.rating != null) {
        return {
          rating: row.rating,
          confidence: row.confidence ?? null,
          isFrozen: !!row.is_frozen,
          isRetired: !!row.is_retired,
          isProvisional: !!row.is_provisional,
          engine: 'v12',
        };
      }
    } catch {
      // v12 columns missing (pre-migration D1) — fall through to v11
    }
  }
  try {
    const row = await db.prepare(
      `SELECT rating FROM ${table}
        WHERE ${col} = ? AND axis_key = 'overall' AND as_of_date < ?
          AND id NOT LIKE 'v12:%'
        ORDER BY as_of_date DESC LIMIT 1`
    ).bind(entityId, asOf).first<any>();
    return row?.rating != null
      ? { rating: row.rating, confidence: null, isFrozen: false, isRetired: false, isProvisional: false, engine: 'v11' }
      : null;
  } catch {
    return null;
  }
}

// Thin compat shim: legacy callers that only need the raw rating.
async function fetchAxisElo(
  db: D1Database,
  entityTable: 'horse' | 'jockey' | 'trainer',
  entityId: string | number,
  asOf: string,
  engine: EloEngine = 'v12',
): Promise<number | null> {
  const reading = await fetchAxisEloReading(db, entityTable, entityId, asOf, engine);
  return reading?.rating ?? null;
}

// Recency factor: peak fitness 14-28 days post-race, decay outside.
// Returns value roughly in -20..+15 range (unitless score points).
function recencyBonus(daysSinceLast: number | null): number {
  if (daysSinceLast == null) return 0;
  if (daysSinceLast < 7) return -10;  // too soon
  if (daysSinceLast <= 28) return 10; // sweet spot
  if (daysSinceLast <= 60) return 0;  // neutral
  if (daysSinceLast <= 120) return -5;
  return -15; // long layoff
}

// ──────────────────────────────────────────────────────────────────────────
// Per-race adjustment factors (constitutional spec 2026-04-28)
//   — score = ELO_composite + Σ(factor × weight)
//   — weights chosen so each factor caps around ±10-20 ELO-equivalent points
//   — returns {bonus, conf, note} so `/explain` can render dual-line breakdown
// ──────────────────────────────────────────────────────────────────────────

type FactorResult = { bonus: number; conf: number; note: string };

// Distance bucket: round to nearest 200m; "fit" = same bucket, "near" = ±200m.
function distBucket(d: number | null | undefined): number | null {
  if (!d || d <= 0) return null;
  return Math.round(d / 200) * 200;
}

async function distanceFit(
  db: D1Database,
  horseId: string,
  raceDistance: number | null,
  asOf: string,
): Promise<FactorResult> {
  const bucket = distBucket(raceDistance);
  if (!bucket) return { bonus: 0, conf: 0, note: '途程資料不全' };
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
      COUNT(*) AS starts
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rr.horse_id = ?
      AND rm.date < ?
      AND r.distance BETWEEN ? AND ?
      AND rr.finishing_position > 0 AND rr.finishing_position < 99
  `).bind(horseId, asOf, bucket - 200, bucket + 200).first<any>();
  const starts = row?.starts ?? 0;
  if (starts < 2) return { bonus: 0, conf: 0, note: `${bucket}m 無足夠往績` };
  const winRate = (row.wins ?? 0) / starts;
  const top3Rate = (row.top3 ?? 0) / starts;
  // Map: 30% top-3 → 0 bonus; each 10pp = ±5 points; cap ±20
  const bonus = Math.max(-20, Math.min(20, (top3Rate - 0.3) * 50));
  return {
    bonus,
    conf: Math.min(1, starts / 5),
    note: `${bucket}m 歷往 ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)`,
  };
}

async function goingFit(
  db: D1Database,
  horseId: string,
  going: string | null,
  asOf: string,
): Promise<FactorResult> {
  if (!going) return { bonus: 0, conf: 0, note: '場地狀況未定' };
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
      COUNT(*) AS starts
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rr.horse_id = ?
      AND rm.date < ?
      AND r.going = ?
      AND rr.finishing_position > 0 AND rr.finishing_position < 99
  `).bind(horseId, asOf, going).first<any>();
  const starts = row?.starts ?? 0;
  if (starts < 2) return { bonus: 0, conf: 0, note: `${going} 場無足夠往績` };
  const top3Rate = (row.top3 ?? 0) / starts;
  const bonus = Math.max(-15, Math.min(15, (top3Rate - 0.3) * 40));
  return {
    bonus,
    conf: Math.min(1, starts / 4),
    note: `${going} ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)`,
  };
}

async function drawBias(
  db: D1Database,
  draw: number | null,
  venue: string | null,
  raceDistance: number | null,
  asOf: string,
): Promise<FactorResult> {
  if (!draw || !venue || !raceDistance) return { bonus: 0, conf: 0, note: '檔位/場地不全' };
  const bucket = distBucket(raceDistance)!;
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
      COUNT(*) AS starts
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rm.venue = ?
      AND rm.date < ?
      AND r.distance BETWEEN ? AND ?
      AND rr.draw = ?
      AND rr.finishing_position > 0 AND rr.finishing_position < 99
  `).bind(venue, asOf, bucket - 100, bucket + 100, draw).first<any>();
  const starts = row?.starts ?? 0;
  if (starts < 20) return { bonus: 0, conf: 0, note: `檔 ${draw} 樣本不足` };
  const top3Rate = (row.top3 ?? 0) / starts;
  // Baseline top-3 rate ≈ 3/field-size; use 0.25 as reference.
  const bonus = Math.max(-10, Math.min(10, (top3Rate - 0.25) * 60));
  return {
    bonus,
    conf: Math.min(1, starts / 80),
    note: `檔${draw} ${venue}/${bucket}m 歷年 ${Math.round(top3Rate * 100)}% 上位率`,
  };
}

// Condition (晨操強度) — trackwork 14d window; 4-6 sessions = sweet spot.
async function conditionFit(
  db: D1Database,
  horseId: string,
  asOf: string,
): Promise<FactorResult> {
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS sessions
      FROM horse_trackwork
      WHERE horse_id = ?
        AND trackwork_date >= date(?, '-14 days')
        AND trackwork_date < ?
    `).bind(horseId, asOf, asOf).first<any>();
    const n = row?.sessions ?? 0;
    if (n === 0) return { bonus: 0, conf: 0, note: '無晨操記錄' };
    // Sweet spot: 4-6 sessions in 14 days.
    let bonus = 0;
    if (n >= 4 && n <= 6) bonus = 8;
    else if (n >= 2 && n <= 8) bonus = 3;
    else if (n === 1) bonus = -3;
    else if (n > 8) bonus = -5; // over-training
    return {
      bonus,
      conf: Math.min(1, n / 4),
      note: `14 天 ${n} 課晨操`,
    };
  } catch {
    return { bonus: 0, conf: 0, note: '晨操資料不全' };
  }
}

// Injury flag — recent (90d) injury penalty with decay.
async function injuryFlag(
  db: D1Database,
  horseId: string,
  asOf: string,
): Promise<FactorResult> {
  try {
    const row = await db.prepare(`
      SELECT injury_date, resolution_date, days_out, injury_type
      FROM horse_injury
      WHERE horse_id = ?
        AND injury_date < ?
        AND injury_date >= date(?, '-180 days')
      ORDER BY injury_date DESC
      LIMIT 1
    `).bind(horseId, asOf, asOf).first<any>();
    if (!row) return { bonus: 0, conf: 0, note: '無近期傷病' };
    const ms = new Date(asOf).getTime() - new Date(row.injury_date).getTime();
    const daysAgo = Math.max(1, Math.round(ms / 86400000));
    // Unresolved (no resolution_date) = stronger penalty
    const unresolved = !row.resolution_date;
    const base = unresolved ? -15 : -10;
    // Exponential decay over 45 days
    const decayed = base * Math.exp(-daysAgo / 45);
    return {
      bonus: Math.max(-15, Math.min(0, decayed)),
      conf: Math.min(1, 1 - daysAgo / 180),
      note: `${daysAgo} 天前${row.injury_type ?? '傷病'}${unresolved ? ' (未復原)' : ''}`,
    };
  } catch {
    return { bonus: 0, conf: 0, note: '傷病資料不全' };
  }
}

// Jockey-trainer combo — historical top-3 rate when paired; baseline 25%.
async function jtComboFit(
  db: D1Database,
  jockeyId: string | number | null,
  trainerId: string | number | null,
  asOf: string,
): Promise<FactorResult> {
  if (!jockeyId || !trainerId) return { bonus: 0, conf: 0, note: '騎練配對不全' };
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS starts,
        SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      WHERE rr.jockey_id = ?
        AND rr.trainer_id = ?
        AND rm.date < ?
        AND rr.finishing_position > 0 AND rr.finishing_position < 99
    `).bind(jockeyId, trainerId, asOf).first<any>();
    const starts = row?.starts ?? 0;
    if (starts < 10) return { bonus: 0, conf: 0, note: `配對 ${starts} 戰樣本不足` };
    const top3Rate = (row.top3 ?? 0) / starts;
    // Baseline top-3 rate ~0.25; each 10pp = ±4; cap ±12
    const bonus = Math.max(-12, Math.min(12, (top3Rate - 0.25) * 40));
    return {
      bonus,
      conf: Math.min(1, starts / 30),
      note: `配對 ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)`,
    };
  } catch {
    return { bonus: 0, conf: 0, note: '配對資料不全' };
  }
}

async function weightDelta(
  db: D1Database,
  horseId: string,
  currentWeight: number | null,
  asOf: string,
): Promise<FactorResult> {
  if (!currentWeight) return { bonus: 0, conf: 0, note: '負磅資料不全' };
  const row = await db.prepare(`
    SELECT AVG(rr.actual_weight) AS avg_w, COUNT(*) AS n
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rr.horse_id = ?
      AND rm.date < ?
      AND rr.actual_weight IS NOT NULL
    ORDER BY rm.date DESC LIMIT 5
  `).bind(horseId, asOf).first<any>();
  const n = row?.n ?? 0;
  const avgW = row?.avg_w;
  if (n < 2 || avgW == null) return { bonus: 0, conf: 0, note: '負磅樣本不足' };
  const delta = currentWeight - avgW;
  // Heavier than historical = slight penalty; -2 ELO per kg over, capped ±8.
  const bonus = Math.max(-8, Math.min(8, -delta * 2));
  return {
    bonus,
    conf: Math.min(1, n / 5),
    note: `負磅 ${currentWeight}磅 vs 近 ${n} 戰均 ${avgW.toFixed(1)}磅 (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`,
  };
}

async function computeComposite(
  db: D1Database,
  raceId: string,
  raceDate: string,
  engine: EloEngine = 'v12',
): Promise<Array<any>> {
  // Load race context once so factor helpers can read distance/going/venue.
  const raceCtx = await db.prepare(`
    SELECT r.distance, r.going, rm.venue
    FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE r.id = ?
  `).bind(raceId).first<any>();
  const raceDistance: number | null = raceCtx?.distance ?? null;
  const raceGoing: string | null = raceCtx?.going ?? null;
  const raceVenue: string | null = raceCtx?.venue ?? null;

  const { results } = await db.prepare(`
    SELECT rr.horse_id, rr.jockey_id, rr.trainer_id, rr.horse_number, rr.draw, rr.win_odds,
           rr.actual_weight,
           h.name_ch, h.name_en, h.total_wins, h.total_starts,
           j.name_ch AS jockey_ch, t.name_ch AS trainer_ch,
           (SELECT MAX(rm2.date) FROM race_results rr2
             JOIN races r2 ON r2.id = rr2.race_id
             JOIN race_meetings rm2 ON rm2.id = r2.meeting_id
            WHERE rr2.horse_id = rr.horse_id AND rm2.date < ?) AS last_race_date
    FROM race_results rr
    JOIN horses h ON h.id = rr.horse_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
    WHERE rr.race_id = ?
    ORDER BY rr.horse_number
  `).bind(raceDate, raceId).all<any>();

  const enriched = await Promise.all((results ?? []).map(async (r: any) => {
    const hRead = await fetchAxisEloReading(db, 'horse', r.horse_id, raceDate, engine);
    const jRead = r.jockey_id ? await fetchAxisEloReading(db, 'jockey', r.jockey_id, raceDate, engine) : null;
    const tRead = r.trainer_id ? await fetchAxisEloReading(db, 'trainer', r.trainer_id, raceDate, engine) : null;
    const hElo = hRead?.rating ?? null;
    const jElo = jRead?.rating ?? null;
    const tElo = tRead?.rating ?? null;

    const parts: number[] = [];
    if (hElo != null) parts.push(hElo * ELO_WEIGHTS.horse);
    if (jElo != null) parts.push(jElo * ELO_WEIGHTS.jockey);
    if (tElo != null) parts.push(tElo * ELO_WEIGHTS.trainer);
    // Fallback to horse-only if jockey/trainer missing
    const weightSum = (hElo != null ? ELO_WEIGHTS.horse : 0)
                    + (jElo != null ? ELO_WEIGHTS.jockey : 0)
                    + (tElo != null ? ELO_WEIGHTS.trainer : 0);
    const eloComposite = weightSum > 0
      ? parts.reduce((a, b) => a + b, 0) / weightSum
      : null;

    // v1.2 only: weight the final score by horse confidence (reduce softmax weight when provisional)
    const horseConfidence = hRead?.confidence ?? null;
    const horseFrozen = hRead?.isFrozen ?? false;
    const horseRetired = hRead?.isRetired ?? false;
    const eloEngineUsed: EloEngine = hRead?.engine ?? engine;

    // Recency factor
    let daysSince: number | null = null;
    if (r.last_race_date) {
      const ms = new Date(raceDate).getTime() - new Date(r.last_race_date).getTime();
      daysSince = Math.round(ms / 86400000);
    }
    const recency = recencyBonus(daysSince);

    // Per-race adjustment factors (constitutional spec 2026-04-28)
    const [fDist, fGoing, fDraw, fWeight, fCond, fInjury, fJT] = await Promise.all([
      distanceFit(db, r.horse_id, raceDistance, raceDate),
      goingFit(db, r.horse_id, raceGoing, raceDate),
      drawBias(db, r.draw, raceVenue, raceDistance, raceDate),
      weightDelta(db, r.horse_id, r.actual_weight, raceDate),
      conditionFit(db, r.horse_id, raceDate),
      injuryFlag(db, r.horse_id, raceDate),
      jtComboFit(db, r.jockey_id, r.trainer_id, raceDate),
    ]);

    const factorBreakdown = {
      recency: { bonus: recency, conf: daysSince != null ? 1 : 0,
                 note: daysSince != null ? `距上次 ${daysSince} 天` : '無上次紀錄' },
      distance: fDist,
      going: fGoing,
      draw: fDraw,
      weight: fWeight,
      condition: fCond,
      injury: fInjury,
      jtCombo: fJT,
    };
    const factorBonus = recency + fDist.bonus + fGoing.bonus + fDraw.bonus
                      + fWeight.bonus + fCond.bonus + fInjury.bonus + fJT.bonus;

    const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
    const winRate = r.total_starts > 0 ? r.total_wins / r.total_starts : 0;
    const score = base + winRate * 1.2 + factorBonus / 100;
    const finalScore = eloComposite != null ? eloComposite + factorBonus : null;

    return {
      horse_id: r.horse_id,
      horse_number: r.horse_number,
      name_ch: r.name_ch,
      name_en: r.name_en,
      jockey_ch: r.jockey_ch,
      trainer_ch: r.trainer_ch,
      draw: r.draw,
      win_odds: r.win_odds,
      horseElo: hElo,
      jockeyElo: jElo,
      trainerElo: tElo,
      eloComposite,
      eloEngine: eloEngineUsed,
      horseConfidence,
      horseFrozen,
      horseRetired,
      factorBonus,
      factorBreakdown,
      finalScore,
      daysSinceLast: daysSince,
      _score: score,
    };
  }));

  // Plackett-Luce-ish softmax
  const expScores = enriched.map((s) => Math.exp(s._score));
  const Z = expScores.reduce((a, b) => a + b, 0) || 1;
  const withProb = enriched.map((s, i) => {
    const pWin = expScores[i] / Z;
    const pTop3 = Math.min(pWin * 3, 0.99);
    const mkt = s.win_odds && s.win_odds > 1 ? 1 / s.win_odds : null;
    const valueDelta = mkt != null ? pWin - mkt : null;
    return {
      horseId: s.horse_id,
      horseNumber: s.horse_number,
      nameCh: s.name_ch,
      nameEn: s.name_en,
      jockeyCh: s.jockey_ch,
      trainerCh: s.trainer_ch,
      draw: s.draw,
      winOdds: s.win_odds,
      horseElo: s.horseElo,
      jockeyElo: s.jockeyElo,
      trainerElo: s.trainerElo,
      eloComposite: s.eloComposite != null ? Math.round(s.eloComposite * 10) / 10 : null,
      eloEngine: s.eloEngine,
      horseConfidence: s.horseConfidence != null ? Math.round(s.horseConfidence * 100) / 100 : null,
      horseFrozen: s.horseFrozen,
      horseRetired: s.horseRetired,
      factorBonus: Math.round(s.factorBonus * 10) / 10,
      factorBreakdown: s.factorBreakdown,
      finalScore: s.finalScore != null ? Math.round(s.finalScore * 10) / 10 : null,
      daysSinceLast: s.daysSinceLast,
      pWin: Math.round(pWin * 1000) / 1000,
      pTop3: Math.round(pTop3 * 1000) / 1000,
      valueDelta: valueDelta != null ? Math.round(valueDelta * 1000) / 1000 : null,
    };
  });
  withProb.sort((a, b) => b.pWin - a.pWin);
  // Assign rank
  withProb.forEach((p: any, i: number) => { p.rank = i + 1; });
  return withProb;
}

// GET /api/analyze/top-picks?raceId=:id&engine=v11|v12 — composite ELO + 7 factors
// engine defaults to v12 (time-weighted multi-axis, user-endorsed 2026-04-28)
analyzeRoutes.get('/top-picks', async (c) => {
  const raceId = c.req.query('raceId');
  if (!raceId) return c.json({ error: '請提供 raceId' }, 400);
  const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';

  const race = await c.env.DB.prepare(`
    SELECT r.*, rm.date, rm.venue, rm.track_condition
    FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE r.id = ?
  `).bind(raceId).first<any>();
  if (!race) return c.json({ error: '找不到該場賽事' }, 404);

  let picks: any[] = [];
  try {
    picks = await computeComposite(c.env.DB, raceId, race.date, engine);
  } catch (err: any) {
    // Legacy fallback
    const { results } = await c.env.DB.prepare(`
      SELECT rr.horse_id, rr.horse_number, rr.draw, rr.win_odds,
             h.name_ch, h.name_en, h.total_wins, h.total_starts
      FROM race_results rr JOIN horses h ON h.id = rr.horse_id
      WHERE rr.race_id = ? ORDER BY rr.horse_number
    `).bind(raceId).all<any>();
    picks = (results ?? []).map((r: any, i: number) => ({
      horseId: r.horse_id, horseNumber: r.horse_number,
      nameCh: r.name_ch, nameEn: r.name_en, draw: r.draw, winOdds: r.win_odds,
      horseElo: null, jockeyElo: null, trainerElo: null,
      eloComposite: null, factorBonus: 0, finalScore: null,
      pWin: null, pTop3: null, valueDelta: null, rank: i + 1,
    }));
  }

  const eloReady = picks.some((p: any) => p.eloComposite != null);
  const engineInUse = picks.find((p: any) => p.eloEngine)?.eloEngine ?? engine;
  return c.json({
    raceId,
    raceNumber: race.race_number,
    date: race.date,
    venue: race.venue,
    eloReady,
    eloEngine: engineInUse,
    eloWeights: ELO_WEIGHTS,
    picks: picks.slice(0, 5),
    allPicks: picks, // full field for race page if needed
    note: eloReady ? null : 'Elo 資料整備中 · 排名暫以勝率+賠率估算',
  });
});

// GET /api/analyze/explain?raceId=X&horseId=Y — breakdown for one horse
analyzeRoutes.get('/explain', async (c) => {
  const raceId = c.req.query('raceId');
  const horseId = c.req.query('horseId');
  if (!raceId || !horseId) return c.json({ error: '請提供 raceId + horseId' }, 400);

  const race = await c.env.DB.prepare(`
    SELECT r.*, rm.date FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id WHERE r.id = ?
  `).bind(raceId).first<any>();
  if (!race) return c.json({ error: '找不到該場賽事' }, 404);

  const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
  let picks: any[] = [];
  try {
    picks = await computeComposite(c.env.DB, raceId, race.date, engine);
  } catch {
    return c.json({ error: '無法計算 composite score' }, 500);
  }

  const pick = picks.find((p: any) => String(p.horseId) === String(horseId));
  if (!pick) return c.json({ error: '該馬匹不在此場賽事' }, 404);

  // Build human-readable comment with full factor breakdown
  const lines: string[] = [];
  if (pick.eloComposite != null) {
    const engineTag = pick.eloEngine === 'v12' ? 'v1.2' : 'v1.1';
    const confTag = pick.horseConfidence != null ? ` · 信心 ${Math.round(pick.horseConfidence * 100)}%` : '';
    const stateTag = pick.horseFrozen ? ' · 馬匹停賽中' : (pick.horseRetired ? ' · 馬匹退役' : '');
    lines.push(`綜合 ELO ${pick.eloComposite} (${engineTag}${confTag}${stateTag})（馬匹 ${pick.horseElo ?? '—'} × 0.7 + 騎師 ${pick.jockeyElo ?? '—'} × 0.2 + 練馬師 ${pick.trainerElo ?? '—'} × 0.1）`);
  }
  const fb = pick.factorBreakdown;
  if (fb) {
    const fmtF = (label: string, f: any) => {
      if (!f || f.conf === 0) return `${label}：${f?.note ?? '—'}`;
      const sign = f.bonus >= 0 ? '+' : '';
      return `${label} ${sign}${f.bonus.toFixed(1)}（${f.note}）`;
    };
    lines.push(fmtF('途程', fb.distance));
    lines.push(fmtF('場地', fb.going));
    lines.push(fmtF('檔位', fb.draw));
    lines.push(fmtF('負磅', fb.weight));
    lines.push(fmtF('狀態', fb.condition));
    lines.push(fmtF('傷患', fb.injury));
    lines.push(fmtF('騎練配對', fb.jtCombo));
    lines.push(fmtF('恢復', fb.recency));
  }
  if (pick.finalScore != null && pick.eloComposite != null) {
    lines.push(`最終預測分 ${pick.finalScore}（綜合 ELO ${pick.eloComposite} ${pick.factorBonus >= 0 ? '+' : ''}${pick.factorBonus} 場次調整）`);
  }

  return c.json({
    raceId,
    horseId,
    rank: pick.rank,
    horseElo: pick.horseElo,
    jockeyElo: pick.jockeyElo,
    trainerElo: pick.trainerElo,
    eloEngine: pick.eloEngine,
    horseConfidence: pick.horseConfidence,
    horseFrozen: pick.horseFrozen,
    horseRetired: pick.horseRetired,
    eloWeights: ELO_WEIGHTS,
    eloComposite: pick.eloComposite,
    factorBonus: pick.factorBonus,
    factorBreakdown: pick.factorBreakdown,
    finalScore: pick.finalScore,
    pWin: pick.pWin,
    pTop3: pick.pTop3,
    valueDelta: pick.valueDelta,
    daysSinceLast: pick.daysSinceLast,
    comment: lines.join(' · '),
  });
});

// GET /api/analyze/factors — 可用因子列表
analyzeRoutes.get('/factors', (c) => {
  return c.json({
    factors: [
      {
        category: '檔位與賽道',
        items: [
          { id: 'draw', name: '檔位優勢', description: '分析各檔位對不同途程的勝率影響', icon: 'grid-3x3' },
          { id: 'course', name: '場地', description: '沙田/跑馬地場地特性與適應度', icon: 'map-pin' },
          { id: 'going', name: '場地狀況', description: '好地、黏地、軟地等場地狀態評估', icon: 'cloud-rain' },
        ],
      },
      {
        category: '速度與節奏',
        items: [
          { id: 'pace', name: '分段時間趨勢', description: '預測全場步速節奏與受惠馬匹', icon: 'timer' },
          { id: 'sectional', name: '分段時間詳細', description: '每段200米用時拆解與比較', icon: 'bar-chart-3' },
          { id: 'running_position', name: '沿途走位', description: '分析沿途位置與最終名次關係', icon: 'route' },
        ],
      },
      {
        category: '近期狀態與表現',
        items: [
          { id: 'form', name: '近期近績', description: '最近6至10場表現走勢分析', icon: 'trending-up' },
          { id: 'finish_time', name: '完成時間趨勢', description: '歷次完成時間對比與進步幅度', icon: 'clock' },
          { id: 'placing', name: '名次表現', description: '歷史名次分佈與穩定性評估', icon: 'award' },
        ],
      },
      {
        category: '血統與馬匹背景',
        items: [
          { id: 'bloodline', name: '血統適應度', description: '父系母系對場地途程的適應性', icon: 'dna' },
        ],
      },
      {
        category: '晨操與試閘',
        items: [
          { id: 'trackwork', name: '晨操資料', description: '晨操時間與狀態追蹤', icon: 'sunrise' },
          { id: 'trial', name: '試閘結果', description: '試閘出閘反應與實戰狀態評估', icon: 'flag' },
        ],
      },
      {
        category: '騎師與練馬師',
        items: [
          { id: 'jockey', name: '騎師近期狀態', description: '騎師近期勝率與場地配合度', icon: 'user' },
          { id: 'trainer', name: '練馬師/馬房狀態', description: '練馬師近期成績與馬房整體表現', icon: 'home' },
          { id: 'jockey_trainer', name: '騎練配對', description: '騎師與練馬師歷史配對勝率分析', icon: 'users' },
        ],
      },
      {
        category: '配備與健康',
        items: [
          { id: 'equipment', name: '配備變化', description: '眼罩、舌繫帶等配備變更影響', icon: 'shield' },
        ],
      },
      {
        category: '資金與賠率',
        items: [
          { id: 'odds_flow', name: '即時賠率與資金流向', description: '追蹤賠率變動與大額資金動向', icon: 'dollar-sign' },
        ],
      },
    ],
  });
});
