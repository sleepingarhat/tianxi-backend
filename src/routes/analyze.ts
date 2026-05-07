import { Hono } from 'hono';
import type { Env, AnalyzeRequest } from '../types';
import { runTimesFMAnalysis } from '../services/timesfm';
import { generateAnalysisSummary } from '../services/ai';

export const analyzeRoutes = new Hono<{ Bindings: Env }>();
  // ── Hit-rate cache (cron-driven) ────────────────────────────────────
  // Past-meeting hit-rate is computed once by the daily cron in src/index.ts
  // and stored here so the admin page can render instantly without hammering
  // the API on every visit. /api/analyze/hit-rate reads cache first; pass
  // ?refresh=1 to force a recompute.
  export async function ensureHitRateCacheTable(db: D1Database): Promise<void> {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meeting_hit_rate_cache (
         date TEXT NOT NULL,
         engine TEXT NOT NULL DEFAULT 'v12',
         venue TEXT,
         races_evaluated INTEGER,
         top1_hits INTEGER,
         top3_any_hits INTEGER,
         top3_sum_intersect INTEGER,
         top1_hit_rate REAL,
         top3_any_hit_rate REAL,
         top3_avg_intersect REAL,
         payload_json TEXT NOT NULL,
         computed_at TEXT NOT NULL,
         PRIMARY KEY (date, engine)
       )`
    ).run();
  }

  export async function readHitRateCache(db: D1Database, date: string, engine: string): Promise<any | null> {
    try {
      const row = await db.prepare(
        `SELECT payload_json, computed_at FROM meeting_hit_rate_cache WHERE date=? AND engine=?`
      ).bind(date, engine).first<{ payload_json: string; computed_at: string }>();
      if (!row?.payload_json) return null;
      const parsed = JSON.parse(row.payload_json);
      parsed.cachedAt = row.computed_at;
      return parsed;
    } catch { return null; }
  }

  export async function writeHitRateCache(db: D1Database, date: string, engine: string, payload: any): Promise<void> {
    const s = payload.summary || {};
    await db.prepare(
      `INSERT OR REPLACE INTO meeting_hit_rate_cache
         (date, engine, venue, races_evaluated, top1_hits, top3_any_hits, top3_sum_intersect,
          top1_hit_rate, top3_any_hit_rate, top3_avg_intersect, payload_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      date, engine, payload.meeting?.venue ?? null,
      s.racesEvaluated ?? null, s.top1Hits ?? null, s.top3AnyHits ?? null, s.top3SumIntersect ?? null,
      s.top1HitRate ?? null, s.top3AnyHitRate ?? null, s.top3AvgIntersect ?? null,
      JSON.stringify({ summary: s, races: payload.races, meeting: payload.meeting }),
      new Date().toISOString(),
    ).run();
  }
  
// 共用 helper：將一隻 pick 轉為一句中文「點解揀佢」原因
function buildPickReason(pick: any): string {
  if (!pick) return '資料不全';
  const parts: string[] = [];
  if (pick.eloComposite != null) {
    const elos: string[] = [];
    if (pick.horseElo != null) elos.push(`馬${Math.round(pick.horseElo)}`);
    if (pick.jockeyElo != null) elos.push(`騎${Math.round(pick.jockeyElo)}`);
    if (pick.trainerElo != null) elos.push(`練${Math.round(pick.trainerElo)}`);
    parts.push(`綜合ELO ${Math.round(pick.eloComposite)}` + (elos.length ? ` (${elos.join('·')})` : ''));
  }
  const fb = pick.factorBreakdown;
  if (fb) {
    const cand: { label: string; bonus: number }[] = [
      { label: '途程', bonus: fb.distance?.bonus ?? 0 },
      { label: '場地', bonus: fb.going?.bonus ?? 0 },
      { label: '檔位', bonus: fb.draw?.bonus ?? 0 },
      { label: '負磅', bonus: fb.weight?.bonus ?? 0 },
      { label: '狀態', bonus: fb.condition?.bonus ?? 0 },
      { label: '傷患', bonus: fb.injury?.bonus ?? 0 },
      { label: '騎練', bonus: fb.jtCombo?.bonus ?? 0 },
      { label: '恢復', bonus: fb.recency?.bonus ?? 0 },
    ].filter(x => Math.abs(x.bonus) >= 1);
    cand.sort((a, b) => Math.abs(b.bonus) - Math.abs(a.bonus));
    const top = cand.slice(0, 3).map(f => `${f.label}${f.bonus >= 0 ? '+' : ''}${f.bonus.toFixed(0)}`);
    if (top.length) parts.push(top.join(' '));
  }
  if (pick.pWin != null) parts.push(`勝率 ${(pick.pWin * 100).toFixed(1)}%`);
  return parts.join(' · ') || '無因子數據';
}

// 共用 helper：計算指定賽事日的命中率統計（被 /hit-rate 與 /hit-rate-rollup 共用）
export async function computeHitRateStats(db: any, date: string, engine: EloEngine): Promise<
  | { error: string; status: number }
  | { meeting: any; races: any[]; summary: any }
> {
  const meeting = await db.prepare(`SELECT * FROM race_meetings WHERE date = ? LIMIT 1`).bind(date).first<any>().catch(() => null);
  if (!meeting) return { error: `${date} 賽馬日記錄不存在`, status: 404 };
  const { results: entries } = await db.prepare(
    `SELECT r.race_number, rr.horse_number, rr.horse_id, rr.draw, rr.actual_weight,
            rr.actual_weight AS declared_weight, rr.jockey_id, rr.trainer_id,
            r.distance, r.going, r.class AS race_class,
            NULL AS track, NULL AS course,
            h.name_ch, h.name_en,
            j.name_ch AS jockey_name, t.name_ch AS trainer_name
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     JOIN race_meetings rm ON rm.id = r.meeting_id
     LEFT JOIN horses h ON h.id = rr.horse_id
     LEFT JOIN jockeys j ON j.id = rr.jockey_id
     LEFT JOIN trainers t ON t.id = rr.trainer_id
     WHERE rm.date = ?
     ORDER BY r.race_number, rr.horse_number`
  ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
  if (!entries?.length) return { error: `${date} 賽果無資料 — 可能為未來賽事或結果未同步`, status: 404 };
  const { results: actual } = await db.prepare(
    `SELECT r.race_number, rr.horse_number, rr.horse_id, rr.finishing_position, rr.win_odds, h.name_ch
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     JOIN race_meetings rm ON rm.id = r.meeting_id
     LEFT JOIN horses h ON h.id = rr.horse_id
     WHERE rm.date = ? AND rr.finishing_position IS NOT NULL AND rr.finishing_position > 0
     ORDER BY r.race_number, rr.finishing_position`
  ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
  const actualByRace = new Map<number, any[]>();
  for (const r of (actual ?? [])) {
    if (!actualByRace.has(r.race_number)) actualByRace.set(r.race_number, []);
    actualByRace.get(r.race_number)!.push(r);
  }
  const picksData = await computePicksFromEntries(db, date, meeting, entries, engine);
  // HK pool hit metrics — computed per race, aggregated into summary.
    // racesEvaluated = denom for top1/top3-any/Q/QP/Trio/Tierce (need actual top-3).
    // first4Eligible = denom for First 4 (need actual top-4).
    let top1Hits = 0, top3AnyHits = 0, top3SumIntersect = 0, racesEvaluated = 0;
    let quinellaHits = 0, qpHits = 0, trioHits = 0, tierceHits = 0;
    let first4Hits = 0, first4Eligible = 0;
    let top4SumIntersect = 0, top4Eligible = 0;
    const races = picksData.races.map((race: any) => {
      const actualSorted = (actualByRace.get(race.raceNumber) ?? []).sort((a: any, b: any) => a.finishing_position - b.finishing_position);
      const predictedTop3 = (race.picks ?? []).slice(0, 3);
      const predictedTop2 = predictedTop3.slice(0, 2);
      const predictedTop4 = (race.picks ?? []).slice(0, 4);
      const actualTop3 = actualSorted.slice(0, 3);
      const actualTop2 = actualSorted.slice(0, 2);
      const actualTop4 = actualSorted.slice(0, 4);
      const actualTop1Id = actualTop3[0]?.horse_id ?? null;
      const actualTop3Ids = new Set(actualTop3.map((a: any) => a.horse_id));
      const actualTop2Ids = new Set(actualTop2.map((a: any) => a.horse_id));
      const actualTop4Ids = new Set(actualTop4.map((a: any) => a.horse_id));

      const top1Hit = actualTop1Id != null && predictedTop3[0]?.horseId === actualTop1Id;
      const intersect = predictedTop3.filter((p: any) => actualTop3Ids.has(p.horseId)).length;
      const top3AnyHit = intersect > 0;

      // Quinella (Q): our top 2 == actual top 2 (any order)
      const quinellaHit = predictedTop2.length === 2 && actualTop2.length === 2
        && predictedTop2.every((p: any) => actualTop2Ids.has(p.horseId));
      // Quinella Place (QP): both our top 2 finish in actual top 3 (any order)
      const qpHit = predictedTop2.length === 2 && actualTop3.length >= 3
        && predictedTop2.every((p: any) => actualTop3Ids.has(p.horseId));
      // Trio: our top 3 == actual top 3 (any order, exact set)
      const trioHit = predictedTop3.length === 3 && actualTop3.length === 3
        && predictedTop3.every((p: any) => actualTop3Ids.has(p.horseId));
      // Tierce (3T): our top 3 == actual top 3 in EXACT order
      const tierceHit = predictedTop3.length === 3 && actualTop3.length === 3
        && predictedTop3[0]?.horseId === actualTop3[0]?.horse_id
        && predictedTop3[1]?.horseId === actualTop3[1]?.horse_id
        && predictedTop3[2]?.horseId === actualTop3[2]?.horse_id;
      // First 4 (F4): our top 4 == actual top 4 (any order)
      const first4Hit = predictedTop4.length === 4 && actualTop4.length === 4
        && predictedTop4.every((p: any) => actualTop4Ids.has(p.horseId));

      if (actualTop3.length >= 3) {
        racesEvaluated++;
        if (top1Hit) top1Hits++;
        if (top3AnyHit) top3AnyHits++;
        top3SumIntersect += intersect;
        if (quinellaHit) quinellaHits++;
        if (qpHit) qpHits++;
        if (trioHit) trioHits++;
        if (tierceHit) tierceHits++;
      }
      // ── New: 首選/次選/三選/四選 命中數（top-4 set overlap, 0..4） ──
      const top4IntersectCount = predictedTop4.filter((p: any) => actualTop4Ids.has(p.horseId)).length;
      if (actualTop4.length >= 4) {
        first4Eligible++;
        if (first4Hit) first4Hits++;
        top4Eligible++;
        top4SumIntersect += top4IntersectCount;
      }

      return {
        raceNumber: race.raceNumber, title: race.title, distance: race.distance, going: race.going,
        predictedTop3: predictedTop3.map((p: any) => ({
          rank: p.rank, horseNumber: p.horseNumber, horseId: p.horseId,
          nameCh: p.nameCh, jockeyCh: p.jockeyCh, trainerCh: p.trainerCh,
          horseElo: p.horseElo, jockeyElo: p.jockeyElo, trainerElo: p.trainerElo,
          eloComposite: p.eloComposite, finalScore: p.finalScore, pWin: p.pWin,
        })),
        // New: top-4 picks (rank 1-4) with per-pick reason text + hit flag
        predictedTop4: predictedTop4.map((p: any) => ({
          rank: p.rank, horseNumber: p.horseNumber, horseId: p.horseId,
          nameCh: p.nameCh, jockeyCh: p.jockeyCh, trainerCh: p.trainerCh,
          horseElo: p.horseElo, jockeyElo: p.jockeyElo, trainerElo: p.trainerElo,
          eloComposite: p.eloComposite, finalScore: p.finalScore, pWin: p.pWin,
          factorBonus: p.factorBonus,
          reason: buildPickReason(p),
          hit: actualTop4Ids.has(p.horseId),
        })),
        actualTop3: actualTop3.map((a: any) => ({
          position: a.finishing_position, horseNumber: a.horse_number, horseId: a.horse_id,
          nameCh: a.name_ch, winOdds: a.win_odds,
        })),
        // New: actual top-4 with hit flag (whether we picked it in our top-4)
        actualTop4: actualTop4.map((a: any) => ({
          position: a.finishing_position, horseNumber: a.horse_number, horseId: a.horse_id,
          nameCh: a.name_ch, winOdds: a.win_odds,
          hit: predictedTop4.some((p: any) => p.horseId === a.horse_id),
        })),
        top1Hit, top3IntersectCount: intersect, top3AnyHit,
        top4IntersectCount,
        quinellaHit, qpHit, trioHit, tierceHit, first4Hit,
      };
    });
    const rate = (n: number, d: number) => d ? Math.round(n / d * 1000) / 10 : null;
    return {
      meeting,
      races,
      summary: {
        racesEvaluated,
        top1HitRate: rate(top1Hits, racesEvaluated),
        top3AnyHitRate: rate(top3AnyHits, racesEvaluated),
        top3AvgIntersect: racesEvaluated ? Math.round(top3SumIntersect/racesEvaluated*100)/100 : null,
        quinellaHitRate: rate(quinellaHits, racesEvaluated),
        qpHitRate: rate(qpHits, racesEvaluated),
        trioHitRate: rate(trioHits, racesEvaluated),
        tierceHitRate: rate(tierceHits, racesEvaluated),
        first4HitRate: rate(first4Hits, first4Eligible),
        top1Hits, top3AnyHits, top3SumIntersect,
        quinellaHits, qpHits, trioHits, tierceHits,
        first4Hits, first4Eligible,
        // New: 首/次/三/四選平均命中數 (out of 4)
        top4SumIntersect, top4Eligible,
        top4AvgIntersect: top4Eligible ? Math.round(top4SumIntersect / top4Eligible * 100) / 100 : null,
      },
    };
  }

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

  // Leakage fix (2026-04-30): use date-filtered subqueries instead of
  // h.total_wins/h.total_starts (which are recomputed post-ingest to include
  // the same-day race being predicted). wins_pre/starts_pre count results
  // from meetings strictly before raceDate.
  const { results } = await db.prepare(`
    SELECT rr.horse_id, rr.jockey_id, rr.trainer_id, rr.jockey_name, rr.trainer_name,
           rr.horse_number, rr.draw, rr.win_odds, rr.actual_weight,
           h.name_ch, h.name_en,
           (SELECT COUNT(*) FROM race_results rr2
             JOIN races r2 ON r2.id = rr2.race_id
             JOIN race_meetings rm2 ON rm2.id = r2.meeting_id
            WHERE rr2.horse_id = rr.horse_id
              AND rm2.date < ?
              AND rr2.finishing_position = 1) AS wins_pre,
           (SELECT COUNT(*) FROM race_results rr3
             JOIN races r3 ON r3.id = rr3.race_id
             JOIN race_meetings rm3 ON rm3.id = r3.meeting_id
            WHERE rr3.horse_id = rr.horse_id
              AND rm3.date < ?) AS starts_pre,
           j.name_ch AS jockey_ch, t.name_ch AS trainer_ch,
           (SELECT MAX(rm4.date) FROM race_results rr4
             JOIN races r4 ON r4.id = rr4.race_id
             JOIN race_meetings rm4 ON rm4.id = r4.meeting_id
            WHERE rr4.horse_id = rr.horse_id AND rm4.date < ?) AS last_race_date
    FROM race_results rr
    JOIN horses h ON h.id = rr.horse_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
    WHERE rr.race_id = ?
    ORDER BY rr.horse_number
  `).bind(raceDate, raceDate, raceDate, raceId).all<any>();

  const enriched = await Promise.all((results ?? []).map(async (r: any) => {
    const hRead = await fetchAxisEloReading(db, 'horse', r.horse_id, raceDate, engine);
    // Fallback: if jockey_id FK is null, construct snapshot ID from jockey name
    // (race_results.jockey_name is populated from CSV; ELO snapshots use 'jockey_<name>')
    const jSnapshotId = r.jockey_id
      ?? (r.jockey_name ? `jockey_${r.jockey_name}` : null)
      ?? (r.jockey_ch   ? `jockey_${r.jockey_ch}`   : null);
    const tSnapshotId = r.trainer_id
      ?? (r.trainer_name ? `trainer_${r.trainer_name}` : null)
      ?? (r.trainer_ch   ? `trainer_${r.trainer_ch}`   : null);
    const jRead = jSnapshotId ? await fetchAxisEloReading(db, 'jockey', jSnapshotId, raceDate, engine) : null;
    const tRead = tSnapshotId ? await fetchAxisEloReading(db, 'trainer', tSnapshotId, raceDate, engine) : null;
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
    // winRate computed from pre-race wins/starts only (no same-day leakage).
    const winRate = r.starts_pre > 0 ? r.wins_pre / r.starts_pre : 0;
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
    // Legacy fallback (no ELO / factor engine available)
    const { results } = await c.env.DB.prepare(`
      SELECT rr.horse_id, rr.horse_number, rr.draw, rr.win_odds,
             h.name_ch, h.name_en
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

    // Upcoming race fallback: race_results empty → try entries_upcoming (ELO-only ranking)
    if (!picks.length) {
      const { results: euRows } = await c.env.DB.prepare(`
        SELECT e.horse_id, e.horse_number, h.name_ch, h.name_en
        FROM entries_upcoming e JOIN horses h ON h.id = e.horse_id
        WHERE e.race_date = ? AND (e.race_number = ? OR e.race_number IS NULL)
        ORDER BY e.horse_number
      `).bind(race.date, race.race_number).all<any>().catch(() => ({ results: [] as any[] }));
      if (euRows?.length) {
        const euEnriched = await Promise.all((euRows ?? []).map(async (r: any) => {
          const hRead = await fetchAxisEloReading(c.env.DB, 'horse', r.horse_id, race.date, engine).catch(() => null);
          return {
            horseId: r.horse_id, horseNumber: r.horse_number,
            nameCh: r.name_ch, nameEn: r.name_en, jockeyCh: null, trainerCh: null,
            draw: null, winOdds: null,
            horseElo: hRead?.rating != null ? Math.round(hRead.rating * 10) / 10 : null,
            jockeyElo: null, trainerElo: null,
            eloComposite: hRead?.rating != null ? Math.round(hRead.rating * 10) / 10 : null,
            eloEngine: engine, horseConfidence: hRead?.confidence ?? null,
            horseFrozen: hRead?.isFrozen ?? false, horseRetired: hRead?.isRetired ?? false,
            factorBonus: 0, factorBreakdown: null,
            finalScore: hRead?.rating != null ? Math.round(hRead.rating * 10) / 10 : null,
            daysSinceLast: null, pWin: null, pTop3: null, valueDelta: null, rank: 0,
          };
        }));
        euEnriched.sort((a, b) => (b.horseElo ?? 0) - (a.horseElo ?? 0));
        euEnriched.forEach((p, i) => { p.rank = i + 1; });
        picks = euEnriched;
      }
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


  // ──────────────────────────────────────────────────────────────────────────
  // Batch ELO / factor helpers for today-picks (single D1 query per dimension)
  // ──────────────────────────────────────────────────────────────────────────

  async function batchEloReadings(
    db: D1Database,
    entityTable: 'horse' | 'jockey' | 'trainer',
    ids: string[],
    asOf: string,
    engine: EloEngine,
  ): Promise<Map<string, EloReading>> {
    const map = new Map<string, EloReading>();
    if (!ids.length) return map;
    const col = `${entityTable}_id`;
    const table = `${entityTable}_elo_snapshots`;
    // D1 bind-param limit = 100 per statement; chunk IDs into batches of 80 (1 slot reserved for asOf)
    const CHUNK = 80;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    // Use ORDER BY + JS first-per-entity (avoids problematic INNER JOIN subquery in D1)
    if (engine === 'v12') {
      for (const chunk of chunks) {
        try {
          const ph = chunk.map(() => '?').join(', ');
          const { results } = await db.prepare(
            `SELECT ${col}, rating, confidence, is_frozen, is_retired, is_provisional
             FROM ${table}
             WHERE ${col} IN (${ph})${entityTable === 'horse' ? " AND axis_key = 'overall'" : ''} AND as_of_date <= ? AND id LIKE 'v12:%'
             ORDER BY ${col}, as_of_date DESC`
          ).bind(...chunk, asOf).all<any>();
          for (const row of (results ?? [])) {
            if (!map.has(row[col])) map.set(row[col], { rating: row.rating, confidence: row.confidence ?? null, isFrozen: !!row.is_frozen, isRetired: !!row.is_retired, isProvisional: !!row.is_provisional, engine: 'v12' });
          }
        } catch { /* v12 columns missing or query error — try v11 fallback below */ }
      }
    }
    const missing = ids.filter(id => !map.has(id));
    if (missing.length) {
      const chunks2: string[][] = [];
      for (let i = 0; i < missing.length; i += CHUNK) chunks2.push(missing.slice(i, i + CHUNK));
      for (const chunk of chunks2) {
        try {
          const ph2 = chunk.map(() => '?').join(', ');
          const { results } = await db.prepare(
            `SELECT ${col}, rating
             FROM ${table}
             WHERE ${col} IN (${ph2})${entityTable === 'horse' ? " AND axis_key = 'overall'" : ''} AND as_of_date <= ? AND id NOT LIKE 'v12:%'
             ORDER BY ${col}, as_of_date DESC`
          ).bind(...chunk, asOf).all<any>();
          for (const row of (results ?? [])) {
            if (!map.has(row[col])) map.set(row[col], { rating: row.rating, confidence: null, isFrozen: false, isRetired: false, isProvisional: false, engine: 'v11' });
          }
        } catch { /* skip */ }
      }
    }
    return map;
  }

  async function batchLastRaceDate(db: D1Database, horseIds: string[], asOf: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT rr.horse_id, MAX(rm.date) AS last_date
         FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id IN (${ph}) AND rm.date < ?
         GROUP BY rr.horse_id`
      ).bind(...chunk, asOf).all<any>();
      for (const row of (results ?? [])) map.set(row.horse_id, row.last_date);
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchDistanceFit(db: D1Database, horseIds: string[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT rr.horse_id, (ROUND(r.distance / 200.0) * 200) AS bucket,
                SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3, COUNT(*) AS starts
         FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id IN (${ph}) AND rm.date < ?
           AND rr.finishing_position > 0 AND rr.finishing_position < 99 AND r.distance > 0
         GROUP BY rr.horse_id, bucket`
      ).bind(...chunk, asOf).all<any>();
      for (const row of (results ?? [])) {
        const starts = row.starts ?? 0; if (starts < 2) continue;
        const top3Rate = (row.top3 ?? 0) / starts;
        map.set(`${row.horse_id}:${row.bucket}`, { bonus: Math.max(-20, Math.min(20, (top3Rate - 0.3) * 50)), conf: Math.min(1, starts / 5), note: `${row.bucket}m 歷往 ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)` });
      }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchGoingFit(db: D1Database, horseIds: string[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT rr.horse_id, r.going,
                SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3, COUNT(*) AS starts
         FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id IN (${ph}) AND rm.date < ?
           AND rr.finishing_position > 0 AND rr.finishing_position < 99
         GROUP BY rr.horse_id, r.going`
      ).bind(...chunk, asOf).all<any>();
      for (const row of (results ?? [])) {
        if (!row.going) continue; const starts = row.starts ?? 0; if (starts < 2) continue;
        const top3Rate = (row.top3 ?? 0) / starts;
        map.set(`${row.horse_id}:${row.going}`, { bonus: Math.max(-15, Math.min(15, (top3Rate - 0.3) * 40)), conf: Math.min(1, starts / 4), note: `${row.going} ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)` });
      }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchDrawBias(db: D1Database, entries: any[], venue: string, asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    const buckets = [...new Set(entries.map(e => distBucket(e.distance)).filter(Boolean) as number[])];
    for (const bucket of buckets) {
      try {
        const { results } = await db.prepare(
          `SELECT rr.draw,
                  SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3, COUNT(*) AS starts
           FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
           WHERE rm.venue = ? AND rm.date < ? AND r.distance BETWEEN ? AND ?
             AND rr.draw IS NOT NULL AND rr.draw > 0
             AND rr.finishing_position > 0 AND rr.finishing_position < 99
           GROUP BY rr.draw`
        ).bind(venue, asOf, bucket - 100, bucket + 100).all<any>();
        for (const row of (results ?? [])) {
          const starts = row.starts ?? 0; if (starts < 20) continue;
          const top3Rate = (row.top3 ?? 0) / starts;
          map.set(`${row.draw}:${venue}:${bucket}`, { bonus: Math.max(-10, Math.min(10, (top3Rate - 0.25) * 60)), conf: Math.min(1, starts / 80), note: `檔${row.draw} ${venue}/${bucket}m 歷年 ${Math.round(top3Rate * 100)}% 上位率` });
        }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchConditionFit(db: D1Database, horseIds: string[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT horse_id, COUNT(*) AS sessions
         FROM horse_trackwork
         WHERE horse_id IN (${ph}) AND trackwork_date >= date(?, '-14 days') AND trackwork_date < ?
         GROUP BY horse_id`
      ).bind(...chunk, asOf, asOf).all<any>();
      for (const row of (results ?? [])) {
        const n = row.sessions ?? 0; let bonus = 0;
        if (n >= 4 && n <= 6) bonus = 8; else if (n >= 2 && n <= 8) bonus = 3; else if (n === 1) bonus = -3; else if (n > 8) bonus = -5;
        map.set(row.horse_id, { bonus, conf: Math.min(1, n / 4), note: `14 天 ${n} 課晨操` });
      }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchInjuryFlag(db: D1Database, horseIds: string[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT horse_id, injury_date, resolution_date, injury_type
         FROM horse_injury
         WHERE horse_id IN (${ph}) AND injury_date < ? AND injury_date >= date(?, '-180 days')
         ORDER BY horse_id, injury_date DESC`
      ).bind(...chunk, asOf, asOf).all<any>();
      const seen = new Set<string>();
      for (const row of (results ?? [])) {
        if (seen.has(row.horse_id)) continue; seen.add(row.horse_id);
        const daysAgo = Math.max(1, Math.round((new Date(asOf).getTime() - new Date(row.injury_date).getTime()) / 86400000));
        const unresolved = !row.resolution_date;
        const decayed = (unresolved ? -15 : -10) * Math.exp(-daysAgo / 45);
        map.set(row.horse_id, { bonus: Math.max(-15, Math.min(0, decayed)), conf: Math.min(1, 1 - daysAgo / 180), note: `${daysAgo} 天前${row.injury_type ?? '傷病'}${unresolved ? ' (未復原)' : ''}` });
      }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchJtComboFit(db: D1Database, entries: any[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    const prefix = (raw: string, kind: 'jockey' | 'trainer') => raw.startsWith(`${kind}_`) ? raw : `${kind}_${raw}`;
      const pairs = [...new Set(entries.filter(e => (e.jockey_id || e.jockey_name) && (e.trainer_id || e.trainer_name)).map(e => `${prefix(e.jockey_id ?? e.jockey_name, 'jockey')}|${prefix(e.trainer_id ?? e.trainer_name, 'trainer')}`))].map(s => s.split('|') as [string, string]);
    for (const [jId, tId] of pairs) {
      try {
        const row = await db.prepare(
          `SELECT COUNT(*) AS starts, SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
           FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
           WHERE rr.jockey_id = ? AND rr.trainer_id = ? AND rm.date < ?
             AND rr.finishing_position > 0 AND rr.finishing_position < 99`
        ).bind(jId, tId, asOf).first<any>();
        const starts = row?.starts ?? 0;
        if (starts >= 10) { const top3Rate = (row?.top3 ?? 0) / starts; map.set(`${jId}:${tId}`, { bonus: Math.max(-12, Math.min(12, (top3Rate - 0.25) * 40)), conf: Math.min(1, starts / 30), note: `配對 ${starts} 戰 ${row.top3 ?? 0}上 (${Math.round(top3Rate * 100)}%)` }); }
        else { map.set(`${jId}:${tId}`, { bonus: 0, conf: 0, note: `配對 ${starts} 戰樣本不足` }); }
      } catch { /* skip */ }
    }
    return map;
  }

  async function batchWeightDelta(db: D1Database, horseIds: string[], entries: any[], asOf: string): Promise<Map<string, FactorResult>> {
    const map = new Map<string, FactorResult>();
    if (!horseIds.length) return map;
    const CHUNK = 80;
    for (let i = 0; i < horseIds.length; i += CHUNK) {
      const chunk = horseIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(', ');
      try {
      const { results } = await db.prepare(
        `SELECT rr.horse_id, rr.actual_weight
         FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id
         INNER JOIN (
           SELECT rr2.horse_id, MAX(rm2.date) AS max_date
           FROM race_results rr2 JOIN races r2 ON r2.id = rr2.race_id JOIN race_meetings rm2 ON rm2.id = r2.meeting_id
           WHERE rr2.horse_id IN (${ph}) AND rm2.date < ? GROUP BY rr2.horse_id
         ) latest ON rr.horse_id = latest.horse_id AND rm.date = latest.max_date
         WHERE rr.actual_weight IS NOT NULL`
      ).bind(...chunk, asOf).all<any>();
      const lastWtMap = new Map<string, number>();
      for (const row of (results ?? [])) lastWtMap.set(row.horse_id, row.actual_weight);
      const nowWtMap = new Map(entries.map(e => [e.horse_id ?? e.horse_code, e.declared_weight ?? e.actual_weight]));
      for (const horseId of horseIds) {
        const last = lastWtMap.get(horseId); const now = nowWtMap.get(horseId);
        if (!last || !now || Math.abs(now - last) < 1) continue;
        const delta = now - last;
        map.set(horseId, { bonus: Math.max(-10, Math.min(5, delta > 0 ? -delta * 2 : -delta * 1.5)), conf: 0.7, note: `體重 ${delta > 0 ? '+' : ''}${delta}磅 (${last}→${now})` });
      }
      } catch { /* skip */ }
    }
    return map;
  }

    // ── computePicksFromEntries: shared helper for today-picks / picks-by-date / hit-rate ──
      async function computePicksFromEntries(
        db: D1Database,
        targetDate: string,
        meeting: any,
        entries: any[],
        engine: EloEngine,
      ): Promise<any> {
        const prefixId = (raw: string | null | undefined, kind: 'horse' | 'jockey' | 'trainer'): string | null => {
          if (!raw) return null;
          const p = kind + '_';
          return raw.startsWith(p) ? raw : p + raw;
        };
        const allHorseIds = [...new Set(entries.map(e => prefixId(e.horse_id ?? e.horse_code, 'horse')).filter(Boolean) as string[])];
        const horseEloIds = allHorseIds;
        const allJockeyIds = [...new Set(entries.map(e => prefixId(e.jockey_id ?? e.jockey_name, 'jockey')).filter(Boolean) as string[])];
        const allTrainerIds = [...new Set(entries.map(e => prefixId(e.trainer_id ?? e.trainer_name, 'trainer')).filter(Boolean) as string[])];
        const [horseEloMap, jockeyEloMap, trainerEloMap, recencyMap, distMap, goingMap, drawMap, condMap, injMap, wtMap, jtMap] = await Promise.all([
          batchEloReadings(db, 'horse', horseEloIds, targetDate, engine),
          batchEloReadings(db, 'jockey', allJockeyIds, targetDate, engine),
          batchEloReadings(db, 'trainer', allTrainerIds, targetDate, engine),
          batchLastRaceDate(db, allHorseIds, targetDate),
          batchDistanceFit(db, allHorseIds, targetDate),
          batchGoingFit(db, allHorseIds, targetDate),
          batchDrawBias(db, entries, meeting.venue, targetDate),
          batchConditionFit(db, allHorseIds, targetDate),
          batchInjuryFlag(db, allHorseIds, targetDate),
          batchWeightDelta(db, allHorseIds, entries, targetDate),
          batchJtComboFit(db, entries, targetDate),
        ]);
        const { results: racesFromDB } = await db.prepare(
          `SELECT race_number, id, title, going FROM races WHERE meeting_id = ? ORDER BY race_number`
        ).bind(meeting.id).all<any>().catch(() => ({ results: [] as any[] }));
        const racesDBMap = new Map((racesFromDB ?? []).map((r: any) => [r.race_number, r]));
        const raceMap = new Map<number, any[]>();
        for (const e of entries) { const rn = e.race_number ?? 0; if (!raceMap.has(rn)) raceMap.set(rn, []); raceMap.get(rn)!.push(e); }
        const raceNumbers = Array.from(raceMap.keys()).sort((a, b) => a - b);
        const racePredictions = raceNumbers.map(raceNum => {
          const raceEntries = raceMap.get(raceNum)!;
          const firstE = raceEntries[0];
          const raceDB = racesDBMap.get(raceNum);
          const raceId = raceDB?.id ?? null;
          const raceTitle = raceDB?.title ?? (raceNum > 0 ? `第 ${raceNum} 場` : `${targetDate} 排位`);
          const raceDistance: number | null = firstE.distance ?? null;
          const raceGoing: string | null = raceDB?.going ?? meeting.track_condition ?? null;
          const raceTrack: string | null = firstE.track ?? null;
          const raceCourse: string | null = firstE.course ?? null;
          const raceClass: string | null = firstE.race_class ?? null;
          const enriched = raceEntries.map((e: any) => {
            const horseId: string | null = e.horse_id ?? e.horse_code ?? null;
            if (!horseId) return { horseId: null, horseNumber: e.horse_number, nameCh: e.name_ch ?? String(e.horse_number), nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: null, jockeyElo: null, trainerElo: null, eloComposite: null, eloEngine: engine, horseConfidence: null, horseFrozen: false, horseRetired: false, factorBonus: 0, factorBreakdown: null, finalScore: null, daysSinceLast: null, _score: 0 };
            const horseEloId = horseId;
            const jSnapshotId: string | null = prefixId(e.jockey_id ?? e.jockey_name, 'jockey');
            const tSnapshotId: string | null = prefixId(e.trainer_id ?? e.trainer_name, 'trainer');
            const hRead = horseEloMap.get(horseEloId) ?? null;
            const jRead = jSnapshotId ? (jockeyEloMap.get(jSnapshotId) ?? null) : null;
            const tRead = tSnapshotId ? (trainerEloMap.get(tSnapshotId) ?? null) : null;
            const hElo = hRead?.rating ?? null; const jElo = jRead?.rating ?? null; const tElo = tRead?.rating ?? null;
            const parts: number[] = [];
            if (hElo != null) parts.push(hElo * ELO_WEIGHTS.horse);
            if (jElo != null) parts.push(jElo * ELO_WEIGHTS.jockey);
            if (tElo != null) parts.push(tElo * ELO_WEIGHTS.trainer);
            const wSum = (hElo != null ? ELO_WEIGHTS.horse : 0) + (jElo != null ? ELO_WEIGHTS.jockey : 0) + (tElo != null ? ELO_WEIGHTS.trainer : 0);
            const eloComposite = wSum > 0 ? parts.reduce((a, b) => a + b, 0) / wSum : null;
            const lastDate = recencyMap.get(horseId) ?? null;
            const daysSince = lastDate ? Math.round((new Date(targetDate).getTime() - new Date(lastDate).getTime()) / 86400000) : null;
            const recency = recencyBonus(daysSince);
            const fDist = distMap.get(`${horseId}:${distBucket(raceDistance)}`) ?? { bonus: 0, conf: 0, note: '無距離往績' };
            const fGoing = goingMap.get(`${horseId}:${raceGoing ?? ''}`) ?? { bonus: 0, conf: 0, note: '無場地往績' };
            const fDraw = drawMap.get(`${e.draw}:${meeting.venue}:${distBucket(raceDistance)}`) ?? { bonus: 0, conf: 0, note: '檔位資料不全' };
            const fWeight = wtMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無體重往績' };
            const fCond = condMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無晨操記錄' };
            const fInjury = injMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無傷病記錄' };
            const fJT = jtMap.get(`${jSnapshotId ?? ''}:${tSnapshotId ?? ''}`) ?? { bonus: 0, conf: 0, note: '騎練配對資料不全' };
            const factorBreakdown = { recency: { bonus: recency, conf: daysSince != null ? 1 : 0, note: daysSince != null ? `距上次 ${daysSince} 天` : '無上次紀錄' }, distance: fDist, going: fGoing, draw: fDraw, weight: fWeight, condition: fCond, injury: fInjury, jtCombo: fJT };
            const factorBonus = recency + fDist.bonus + fGoing.bonus + fDraw.bonus + fWeight.bonus + fCond.bonus + fInjury.bonus + fJT.bonus;
            const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
            const finalScore = eloComposite != null ? eloComposite + factorBonus : null;
            return { horseId, horseNumber: e.horse_number, nameCh: e.name_ch, nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: hElo != null ? Math.round(hElo*10)/10 : null, jockeyElo: jElo != null ? Math.round(jElo*10)/10 : null, trainerElo: tElo != null ? Math.round(tElo*10)/10 : null, eloComposite: eloComposite != null ? Math.round(eloComposite*10)/10 : null, eloEngine: hRead?.engine ?? engine, horseConfidence: hRead?.confidence != null ? Math.round(hRead.confidence*100)/100 : null, horseFrozen: hRead?.isFrozen ?? false, horseRetired: hRead?.isRetired ?? false, factorBonus: Math.round(factorBonus*10)/10, factorBreakdown, finalScore: finalScore != null ? Math.round(finalScore*10)/10 : null, daysSinceLast: daysSince, _score: base + factorBonus / 100 };
          });
          const expScores = enriched.map((s) => Math.exp(s._score));
          const Z = expScores.reduce((a, b) => a + b, 0) || 1;
          const picks = enriched.map((s, i) => { const { _score, ...rest } = s as any; return { ...rest, pWin: Math.round((expScores[i]/Z)*1000)/1000, pTop3: Math.round(Math.min((expScores[i]/Z)*3,0.99)*1000)/1000 }; });
          picks.sort((a: any, b: any) => b.pWin - a.pWin);
          picks.forEach((p: any, i: number) => { p.rank = i + 1; });
          return { raceId, raceNumber: raceNum, title: raceTitle, class: raceClass, distance: raceDistance, going: raceGoing, track: raceTrack, course: raceCourse, picks };
        });
        const eloReady = racePredictions.some((r) => r.picks?.some((p: any) => p.eloComposite != null));
        return { date: targetDate, venue: meeting.venue, trackCondition: meeting.track_condition, eloEngine: engine, eloWeights: ELO_WEIGHTS, eloReady, races: racePredictions, generatedAt: new Date().toISOString() };
      }

      // GET /api/analyze/today-picks — 即日排位全因子預測 (batch-query version; ~20 D1 queries)
    analyzeRoutes.get('/today-picks', async (c) => {
      try {
        const db = c.env.DB;
        const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
        const todayStr = new Date().toISOString().split('T')[0];
        let targetDate: string | null = await db.prepare(
          `SELECT MIN(race_date) FROM entries_upcoming WHERE race_date >= ?`
        ).bind(todayStr).first<string>('MIN(race_date)').catch(() => null);
        if (!targetDate) {
          targetDate = await db.prepare(`SELECT MAX(race_date) FROM entries_upcoming`).first<string>('MAX(race_date)').catch(() => null);
        }
        if (!targetDate) return c.json({ error: '排位表未有資料' }, 404);
        const meeting = await db.prepare(`SELECT * FROM race_meetings WHERE date = ? LIMIT 1`).bind(targetDate).first<any>().catch(() => null);
        if (!meeting) return c.json({ error: `${targetDate} 賽馬日記錄不存在` }, 404);
        const loadEntries = async (withVenue: boolean) => {
          const q = withVenue
            ? `SELECT e.race_number, e.horse_number, e.horse_id, e.horse_code,
                     e.draw, e.declared_weight, e.actual_weight, e.jockey_name, e.jockey_id,
                     e.trainer_name, e.trainer_id, e.rating, e.priority_order,
                     e.distance, e.track, e.course, e.race_class,
                     h.name_ch, h.name_en
               FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id
               WHERE e.race_date = ? AND e.venue = ? AND e.race_number > 0
               ORDER BY e.race_number, e.horse_number`
            : `SELECT e.race_number, e.horse_number, e.horse_id, e.horse_code,
                     e.draw, e.declared_weight, e.actual_weight, e.jockey_name, e.jockey_id,
                     e.trainer_name, e.trainer_id, e.rating, e.priority_order,
                     e.distance, e.track, e.course, e.race_class,
                     h.name_ch, h.name_en
               FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id
               WHERE e.race_date = ? AND e.race_number > 0
               ORDER BY e.race_number, e.horse_number`;
          const stmt = withVenue ? db.prepare(q).bind(targetDate, meeting.venue) : db.prepare(q).bind(targetDate);
          const { results } = await stmt.all<any>().catch(() => ({ results: [] as any[] }));
          return results ?? [];
        };
        let entries = await loadEntries(true);
        if (!entries.length) entries = await loadEntries(false);
        if (!entries.length) return c.json({ error: `${targetDate} 排位表無資料` }, 404);
        const prefixId = (raw: string | null | undefined, kind: 'horse' | 'jockey' | 'trainer'): string | null => {
          if (!raw) return null;
          const p = kind + '_';
          return raw.startsWith(p) ? raw : p + raw;
        };
        const allHorseIds = [...new Set(entries.map(e => prefixId(e.horse_id ?? e.horse_code, 'horse')).filter(Boolean) as string[])];
        const horseEloIds = allHorseIds; // prefixed 'horse_J243' — matches D1 horse_elo_snapshots.horse_id
        const allJockeyIds = [...new Set(entries.map(e => prefixId(e.jockey_id ?? e.jockey_name, 'jockey')).filter(Boolean) as string[])];
        const allTrainerIds = [...new Set(entries.map(e => prefixId(e.trainer_id ?? e.trainer_name, 'trainer')).filter(Boolean) as string[])];
        const [horseEloMap, jockeyEloMap, trainerEloMap, recencyMap, distMap, goingMap, drawMap, condMap, injMap, wtMap, jtMap] = await Promise.all([
          batchEloReadings(db, 'horse', horseEloIds, targetDate, engine),
          batchEloReadings(db, 'jockey', allJockeyIds, targetDate, engine),
          batchEloReadings(db, 'trainer', allTrainerIds, targetDate, engine),
          batchLastRaceDate(db, allHorseIds, targetDate),
          batchDistanceFit(db, allHorseIds, targetDate),
          batchGoingFit(db, allHorseIds, targetDate),
          batchDrawBias(db, entries, meeting.venue, targetDate),
          batchConditionFit(db, allHorseIds, targetDate),
          batchInjuryFlag(db, allHorseIds, targetDate),
          batchWeightDelta(db, allHorseIds, entries, targetDate),
          batchJtComboFit(db, entries, targetDate),
        ]);
        const { results: racesFromDB } = await db.prepare(
          `SELECT race_number, id, title, going FROM races WHERE meeting_id = ? ORDER BY race_number`
        ).bind(meeting.id).all<any>().catch(() => ({ results: [] as any[] }));
        const racesDBMap = new Map((racesFromDB ?? []).map((r: any) => [r.race_number, r]));
        const raceMap = new Map<number, any[]>();
        for (const e of entries) { const rn = e.race_number ?? 0; if (!raceMap.has(rn)) raceMap.set(rn, []); raceMap.get(rn)!.push(e); }
        const raceNumbers = Array.from(raceMap.keys()).sort((a, b) => a - b);
        const racePredictions = raceNumbers.map(raceNum => {
          const raceEntries = raceMap.get(raceNum)!;
          const firstE = raceEntries[0];
          const raceDB = racesDBMap.get(raceNum);
          const raceId = raceDB?.id ?? null;
          const raceTitle = raceDB?.title ?? (raceNum > 0 ? `第 ${raceNum} 場` : `${targetDate} 排位`);
          const raceDistance: number | null = firstE.distance ?? null;
          const raceGoing: string | null = raceDB?.going ?? meeting.track_condition ?? null;
          const raceTrack: string | null = firstE.track ?? null;
          const raceCourse: string | null = firstE.course ?? null;
          const raceClass: string | null = firstE.race_class ?? null;
          const enriched = raceEntries.map((e: any) => {
            const horseId: string | null = e.horse_id ?? e.horse_code ?? null;
            if (!horseId) return { horseId: null, horseNumber: e.horse_number, nameCh: e.name_ch ?? String(e.horse_number), nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: null, jockeyElo: null, trainerElo: null, eloComposite: null, eloEngine: engine, horseConfidence: null, horseFrozen: false, horseRetired: false, factorBonus: 0, factorBreakdown: null, finalScore: null, daysSinceLast: null, _score: 0 };
            const horseEloId = horseId; // 'horse_J243' — matches D1 horse_elo_snapshots.horse_id
            const jSnapshotId: string | null = prefixId(e.jockey_id ?? e.jockey_name, 'jockey');
            const tSnapshotId: string | null = prefixId(e.trainer_id ?? e.trainer_name, 'trainer');
            const hRead = horseEloMap.get(horseEloId) ?? null;
            const jRead = jSnapshotId ? (jockeyEloMap.get(jSnapshotId) ?? null) : null;
            const tRead = tSnapshotId ? (trainerEloMap.get(tSnapshotId) ?? null) : null;
            const hElo = hRead?.rating ?? null; const jElo = jRead?.rating ?? null; const tElo = tRead?.rating ?? null;
            const parts: number[] = [];
            if (hElo != null) parts.push(hElo * ELO_WEIGHTS.horse);
            if (jElo != null) parts.push(jElo * ELO_WEIGHTS.jockey);
            if (tElo != null) parts.push(tElo * ELO_WEIGHTS.trainer);
            const wSum = (hElo != null ? ELO_WEIGHTS.horse : 0) + (jElo != null ? ELO_WEIGHTS.jockey : 0) + (tElo != null ? ELO_WEIGHTS.trainer : 0);
            const eloComposite = wSum > 0 ? parts.reduce((a, b) => a + b, 0) / wSum : null;
            const lastDate = recencyMap.get(horseId) ?? null;
            const daysSince = lastDate ? Math.round((new Date(targetDate!).getTime() - new Date(lastDate).getTime()) / 86400000) : null;
            const recency = recencyBonus(daysSince);
            const fDist = distMap.get(`${horseId}:${distBucket(raceDistance)}`) ?? { bonus: 0, conf: 0, note: '無距離往績' };
            const fGoing = goingMap.get(`${horseId}:${raceGoing ?? ''}`) ?? { bonus: 0, conf: 0, note: '無場地往績' };
            const fDraw = drawMap.get(`${e.draw}:${meeting.venue}:${distBucket(raceDistance)}`) ?? { bonus: 0, conf: 0, note: '檔位資料不全' };
            const fWeight = wtMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無體重往績' };
            const fCond = condMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無晨操記錄' };
            const fInjury = injMap.get(horseId) ?? { bonus: 0, conf: 0, note: '無傷病記錄' };
            const fJT = jtMap.get(`${jSnapshotId ?? ''}:${tSnapshotId ?? ''}`) ?? { bonus: 0, conf: 0, note: '騎練配對資料不全' };
            const factorBreakdown = { recency: { bonus: recency, conf: daysSince != null ? 1 : 0, note: daysSince != null ? `距上次 ${daysSince} 天` : '無上次紀錄' }, distance: fDist, going: fGoing, draw: fDraw, weight: fWeight, condition: fCond, injury: fInjury, jtCombo: fJT };
            const factorBonus = recency + fDist.bonus + fGoing.bonus + fDraw.bonus + fWeight.bonus + fCond.bonus + fInjury.bonus + fJT.bonus;
            const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
            const finalScore = eloComposite != null ? eloComposite + factorBonus : null;
            return { horseId, horseNumber: e.horse_number, nameCh: e.name_ch, nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: hElo != null ? Math.round(hElo*10)/10 : null, jockeyElo: jElo != null ? Math.round(jElo*10)/10 : null, trainerElo: tElo != null ? Math.round(tElo*10)/10 : null, eloComposite: eloComposite != null ? Math.round(eloComposite*10)/10 : null, eloEngine: hRead?.engine ?? engine, horseConfidence: hRead?.confidence != null ? Math.round(hRead.confidence*100)/100 : null, horseFrozen: hRead?.isFrozen ?? false, horseRetired: hRead?.isRetired ?? false, factorBonus: Math.round(factorBonus*10)/10, factorBreakdown, finalScore: finalScore != null ? Math.round(finalScore*10)/10 : null, daysSinceLast: daysSince, _score: base + factorBonus / 100 };
          });
          const expScores = enriched.map((s) => Math.exp(s._score));
          const Z = expScores.reduce((a, b) => a + b, 0) || 1;
          const picks = enriched.map((s, i) => { const { _score, ...rest } = s as any; return { ...rest, pWin: Math.round((expScores[i]/Z)*1000)/1000, pTop3: Math.round(Math.min((expScores[i]/Z)*3,0.99)*1000)/1000 }; });
          picks.sort((a: any, b: any) => b.pWin - a.pWin);
          picks.forEach((p: any, i: number) => { p.rank = i + 1; });
          return { raceId, raceNumber: raceNum, title: raceTitle, class: raceClass, distance: raceDistance, going: raceGoing, track: raceTrack, course: raceCourse, picks };
        });
        const eloReady = racePredictions.some((r) => r.picks?.some((p: any) => p.eloComposite != null));
        return c.json({ date: targetDate, venue: meeting.venue, trackCondition: meeting.track_condition, eloEngine: engine, eloWeights: ELO_WEIGHTS, eloReady, races: racePredictions, generatedAt: new Date().toISOString() });
      } catch (err: any) {
        return c.json({ error: 'today-picks failed', detail: err?.message ?? String(err) }, 500);
      }
    });
    

      // GET /api/analyze/picks-by-date?date=YYYY-MM-DD — 指定賽事日全因子預測（支援未來/過去日期）
      analyzeRoutes.get('/picks-by-date', async (c) => {
        try {
          const db = c.env.DB;
          const date = c.req.query('date');
          if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '請提供 YYYY-MM-DD 格式日期' }, 400);
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const meeting = await db.prepare(`SELECT * FROM race_meetings WHERE date = ? LIMIT 1`).bind(date).first<any>().catch(() => null);
          if (!meeting) return c.json({ error: `${date} 賽馬日記錄不存在` }, 404);
          // Try entries_upcoming first (works for upcoming dates)
          const { results: euRows } = await db.prepare(
            `SELECT e.race_number, e.horse_number, e.horse_id, e.horse_code,
                    e.draw, e.declared_weight, e.actual_weight, e.jockey_name, e.jockey_id,
                    e.trainer_name, e.trainer_id, e.rating, e.priority_order,
                    e.distance, e.track, e.course, e.race_class,
                    h.name_ch, h.name_en
             FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id
             WHERE e.race_date = ? AND e.race_number > 0
             ORDER BY e.race_number, e.horse_number`
          ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
          let entries = euRows ?? [];
          let source: 'upcoming' | 'historical' = 'upcoming';
          // Fallback to race_results for past meetings
          if (!entries.length) {
            const { results: rrRows } = await db.prepare(
              `SELECT r.race_number, rr.horse_number, rr.horse_id, rr.draw, rr.actual_weight,
                      rr.actual_weight AS declared_weight, rr.jockey_id, rr.trainer_id,
                      r.distance, r.going, r.class AS race_class,
                      NULL AS track, NULL AS course,
                      h.name_ch, h.name_en,
                      j.name_ch AS jockey_name, t.name_ch AS trainer_name
               FROM race_results rr
               JOIN races r ON r.id = rr.race_id
               JOIN race_meetings rm ON rm.id = r.meeting_id
               LEFT JOIN horses h ON h.id = rr.horse_id
               LEFT JOIN jockeys j ON j.id = rr.jockey_id
               LEFT JOIN trainers t ON t.id = rr.trainer_id
               WHERE rm.date = ?
               ORDER BY r.race_number, rr.horse_number`
            ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
            entries = rrRows ?? [];
            source = 'historical';
          }
          if (!entries.length) return c.json({ error: `${date} 排位/賽果無資料` }, 404);
          const result = await computePicksFromEntries(db, date, meeting, entries, engine);
          return c.json({ ...result, source });
        } catch (err: any) {
          return c.json({ error: 'picks-by-date failed', detail: err?.message ?? String(err) }, 500);
        }
      });

      // computeHitRateStats hoisted to module scope (see below) so cron handler can import it


      // GET /api/analyze/hit-rate?date=YYYY-MM-DD — 過去賽事日預測 vs 實際結果比對
        // Reads from meeting_hit_rate_cache (populated by daily cron). Pass ?refresh=1 to force recompute.
        analyzeRoutes.get('/hit-rate', async (c) => {
          try {
            const date = c.req.query('date');
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '請提供 YYYY-MM-DD 格式日期' }, 400);
            const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
            const refresh = c.req.query('refresh') === '1';

            if (!refresh) {
              const cached = await readHitRateCache(c.env.DB, date, engine);
              if (cached) {
                return c.json({
                  date,
                  venue: cached.meeting?.venue,
                  trackCondition: cached.meeting?.track_condition,
                  engine,
                  summary: cached.summary,
                  races: cached.races,
                  generatedAt: cached.cachedAt,
                  fromCache: true,
                });
              }
            }

            await ensureHitRateCacheTable(c.env.DB).catch(() => {});
            const result = await computeHitRateStats(c.env.DB, date, engine);
            if ('error' in result) return c.json({ error: result.error }, result.status as any);
            await writeHitRateCache(c.env.DB, date, engine, result).catch(() => {});
            return c.json({
              date,
              venue: result.meeting.venue,
              trackCondition: result.meeting.track_condition,
              engine,
              summary: result.summary,
              races: result.races,
              generatedAt: new Date().toISOString(),
              fromCache: false,
            });
          } catch (err: any) {
            return c.json({ error: 'hit-rate failed', detail: err?.message ?? String(err) }, 500);
          }
        });

        // GET /api/analyze/hit-rate-rollup?days=30 — 滾動窗口整體命中率彙總
      analyzeRoutes.get('/hit-rate-rollup', async (c) => {
        try {
          const db = c.env.DB;
          const daysParam = c.req.query('days');
          const days = Math.max(1, Math.min(180, parseInt(daysParam || '30', 10) || 30));
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const today = new Date().toISOString().substring(0, 10);
          const cutoff = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
          const datesQ = await db.prepare(
            "SELECT DISTINCT rm.date AS date, rm.venue AS venue " +
            "FROM race_meetings rm JOIN races r ON r.meeting_id = rm.id JOIN race_results rr ON rr.race_id = r.id " +
            "WHERE rm.date >= ? AND rm.date < ? AND rr.finishing_position IS NOT NULL " +
            "ORDER BY rm.date DESC"
          ).bind(cutoff, today).all<any>().catch(() => ({ results: [] as any[] }));
          const meetingDates: any[] = (datesQ.results as any[]) || [];
                  let totalRaces = 0, totalTop1Hits = 0, totalTop3AnyHits = 0, totalTop3Intersect = 0;
            let totalQuinella = 0, totalQp = 0, totalTrio = 0, totalTierce = 0;
            let totalFirst4 = 0, totalFirst4Eligible = 0;
            const perMeeting: any[] = [];
            const errors: any[] = [];
            for (const m of meetingDates) {
              try {
                // Cache-first: avoid Worker timeout when iterating many meetings.
                // Falls back to live compute (and back-fills cache) when row missing
                // or has stale Stage-4a shape (no quinellaHits field).
                let r: any = await readHitRateCache(db, m.date, engine);
                if (!r?.summary || r.summary.quinellaHits === undefined) {
                  const computed = await computeHitRateStats(db, m.date, engine);
                  if ('error' in computed) { errors.push({date: m.date, error: computed.error}); continue; }
                  await writeHitRateCache(db, m.date, engine, computed).catch(() => {});
                  r = computed;
                }
                const s = r.summary;
                if (!s.racesEvaluated) continue;
                perMeeting.push({ date: m.date, venue: m.venue, ...s });
                totalRaces += s.racesEvaluated;
                totalTop1Hits += s.top1Hits;
                totalTop3AnyHits += s.top3AnyHits;
                totalTop3Intersect += s.top3SumIntersect;
                totalQuinella += s.quinellaHits ?? 0;
                totalQp += s.qpHits ?? 0;
                totalTrio += s.trioHits ?? 0;
                totalTierce += s.tierceHits ?? 0;
                totalFirst4 += s.first4Hits ?? 0;
                totalFirst4Eligible += s.first4Eligible ?? 0;
              } catch (e: any) { errors.push({date: m.date, error: e?.message || String(e)}); }
            }
            const rRate = (n: number, d: number) => d ? Math.round(n / d * 1000) / 10 : null;
            return c.json({
              windowDays: days, from: cutoff, to: today,
              meetingsFound: meetingDates.length,
              meetingsEvaluated: perMeeting.length,
              racesEvaluated: totalRaces,
              top1HitRate: rRate(totalTop1Hits, totalRaces),
              top3AnyHitRate: rRate(totalTop3AnyHits, totalRaces),
              top3AvgIntersect: totalRaces ? Math.round(totalTop3Intersect/totalRaces*100)/100 : null,
              quinellaHitRate: rRate(totalQuinella, totalRaces),
              qpHitRate: rRate(totalQp, totalRaces),
              trioHitRate: rRate(totalTrio, totalRaces),
              tierceHitRate: rRate(totalTierce, totalRaces),
              first4HitRate: rRate(totalFirst4, totalFirst4Eligible),
              top1Hits: totalTop1Hits, top3AnyHits: totalTop3AnyHits,
              quinellaHits: totalQuinella, qpHits: totalQp,
              trioHits: totalTrio, tierceHits: totalTierce,
              first4Hits: totalFirst4, first4Eligible: totalFirst4Eligible,
              perMeeting, errors,
              generatedAt: new Date().toISOString(),
            });
        } catch (err: any) {
          return c.json({ error: 'hit-rate-rollup failed', detail: err?.message ?? String(err) }, 500);
        }
      });
