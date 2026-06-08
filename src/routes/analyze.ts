import { Hono } from 'hono';
import type { Env, AnalyzeRequest } from '../types';
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

  // P0 architect fix 2026-05-21: cache version tag invalidates pre-ensemble
  // rows so admin doesn't serve stale ELO-only payloads as if they were
  // TX-Oracle v3 ensemble results. Bumping this constant is a one-shot evict.
  const HIT_RATE_CACHE_VERSION = 'tx3';
  function _engineKey(engine: string): string {
    return `${engine}-${HIT_RATE_CACHE_VERSION}`;
  }

  export async function readHitRateCache(db: D1Database, date: string, engine: string): Promise<any | null> {
    try {
      const row = await db.prepare(
        `SELECT payload_json, computed_at FROM meeting_hit_rate_cache WHERE date=? AND engine=?`
      ).bind(date, _engineKey(engine)).first<{ payload_json: string; computed_at: string }>();
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
      date, _engineKey(engine), payload.meeting?.venue ?? null,
      s.racesEvaluated ?? null, s.top1Hits ?? null, s.top3AnyHits ?? null, s.top3SumIntersect ?? null,
      s.top1HitRate ?? null, s.top3AnyHitRate ?? null, s.top3AvgIntersect ?? null,
      JSON.stringify({ summary: s, races: payload.races, meeting: payload.meeting }),
      new Date().toISOString(),
    ).run();
  }

  // === Per-α hit-rate cache (P3-C+ tuner accelerator) ====================
  // /api/analyze/hit-rate?alpha=N bypasses the default cache so the offline
  // tuner can probe arbitrary α values, but rapid sweeps across many dates
  // were tripping Cloudflare 503s. This dedicated table caches results keyed
  // by (date, engine_versioned, alpha_x100) so each (date, α) is computed at
  // most once. Cleared automatically when HIT_RATE_CACHE_VERSION bumps.
  export async function ensureHitRateAlphaCacheTable(db: D1Database): Promise<void> {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meeting_hit_rate_alpha_cache (
         date TEXT NOT NULL,
         engine TEXT NOT NULL,
         alpha_x100 INTEGER NOT NULL,
         payload_json TEXT NOT NULL,
         computed_at TEXT NOT NULL,
         PRIMARY KEY (date, engine, alpha_x100)
       )`
    ).run();
  }
  function _alphaKey(alpha: number): number { return Math.round(alpha * 100); }
  export async function readHitRateAlphaCache(db: D1Database, date: string, engine: string, alpha: number): Promise<any | null> {
    try {
      const row = await db.prepare(
        `SELECT payload_json, computed_at FROM meeting_hit_rate_alpha_cache WHERE date=? AND engine=? AND alpha_x100=?`
      ).bind(date, _engineKey(engine), _alphaKey(alpha)).first<{ payload_json: string; computed_at: string }>();
      if (!row?.payload_json) return null;
      const parsed = JSON.parse(row.payload_json);
      parsed.cachedAt = row.computed_at;
      return parsed;
    } catch { return null; }
  }
  export async function writeHitRateAlphaCache(db: D1Database, date: string, engine: string, alpha: number, payload: any): Promise<void> {
    await db.prepare(
      `INSERT OR REPLACE INTO meeting_hit_rate_alpha_cache (date, engine, alpha_x100, payload_json, computed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      date, _engineKey(engine), _alphaKey(alpha),
      JSON.stringify({ summary: payload.summary, races: payload.races, meeting: payload.meeting }),
      new Date().toISOString(),
    ).run();
  }

  // === Race-day report cache (Stage 8: scheduled pre-compute) ===========
  // Avoids running the full today-picks compute on every admin page hit.
  // Rebuilt by cron triggers in src/index.ts at HKT 06:00 / 11:00 / 18:00.
  export async function ensureRaceDayReportCacheTable(db: D1Database): Promise<void> {
    await db.prepare(`CREATE TABLE IF NOT EXISTS race_day_report_cache (
      date TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'v12',
      venue TEXT,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      compute_ms INTEGER,
      PRIMARY KEY (date, engine)
    )`).run();
  }

  export async function readRaceDayReportCache(db: D1Database, date: string, engine: string): Promise<any | null> {
    try {
      await ensureRaceDayReportCacheTable(db);
      const r = await db.prepare(
        `SELECT payload_json, generated_at, compute_ms FROM race_day_report_cache WHERE date = ? AND engine = ?`
      ).bind(date, engine).first<any>().catch(() => null);
      if (!r?.payload_json) return null;
      const p = JSON.parse(r.payload_json);
      p.cachedGeneratedAt = r.generated_at;
      p.cachedComputeMs = r.compute_ms;
      p.fromCache = true;
      return p;
    } catch { return null; }
  }

  export async function writeRaceDayReportCache(db: D1Database, date: string, engine: string, venue: string | null, payload: any, computeMs: number): Promise<void> {
    await ensureRaceDayReportCacheTable(db);
    await db.prepare(
      `INSERT INTO race_day_report_cache (date, engine, venue, payload_json, generated_at, compute_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, engine) DO UPDATE SET
         venue = excluded.venue,
         payload_json = excluded.payload_json,
         generated_at = excluded.generated_at,
         compute_ms = excluded.compute_ms`
    ).bind(date, engine, venue, JSON.stringify(payload), new Date().toISOString(), computeMs).run();
  }

  // === Prediction log (Phase A · 回測底盤) ==============================
  // Stores every per-horse prediction so we can compare against actual results.
  // variant: 'baseline' (TX-Oracle v3 ensemble) | future...
  // Composite key (date, race_number, horse_id, engine, variant) → INSERT OR REPLACE on re-run.
  export async function ensurePredictionLogTable(db: D1Database): Promise<void> {
    await db.prepare(`CREATE TABLE IF NOT EXISTS prediction_log (
      date TEXT NOT NULL,
      race_number INTEGER NOT NULL,
      horse_id TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'v12',
      variant TEXT NOT NULL DEFAULT 'baseline',
      horse_number INTEGER,
      draw INTEGER,
      horse_elo REAL,
      elo_source TEXT,
      elo_confidence REAL,
      elo_composite REAL,
      factor_bonus REAL,
      final_score REAL,
      p_win REAL,
      p_top3 REAL,
      predicted_rank INTEGER,
      actual_finish INTEGER,
      actual_win_odds REAL,
      is_hit_top1 INTEGER,
      is_hit_top3 INTEGER,
      is_hit_top4 INTEGER,
      generated_at TEXT NOT NULL,
      joined_at TEXT,
      lgb_score REAL,
      lgb_model_version TEXT,
      score_source TEXT,
      PRIMARY KEY (date, race_number, horse_id, engine, variant)
    )`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_prediction_log_date ON prediction_log(date)`).run().catch(() => {});
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_prediction_log_join ON prediction_log(date, joined_at)`).run().catch(() => {});
  }

  // Write all per-horse rows for a single race-day report payload. Idempotent.
  export async function writePredictionLog(db: D1Database, payload: any, variant: string = 'baseline'): Promise<{ rows: number }> {
    if (!payload?.date || !Array.isArray(payload?.races)) return { rows: 0 };
    await ensurePredictionLogTable(db);
    const engine = payload.eloEngine ?? 'v12';
    const generatedAt = payload.generatedAt ?? new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];
    for (const race of payload.races) {
      if (!race?.picks?.length || race.raceNumber == null || race.raceNumber === 0) continue;
      for (const p of race.picks) {
        if (!p.horseId) continue;
        stmts.push(
          db.prepare(`INSERT OR REPLACE INTO prediction_log
            (date, race_number, horse_id, engine, variant, horse_number, draw,
             horse_elo, elo_source, elo_confidence, elo_composite, factor_bonus, final_score,
             p_win, p_top3, predicted_rank, generated_at,
             lgb_score, lgb_model_version, score_source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            payload.date, race.raceNumber, p.horseId, engine, variant,
            p.horseNumber ?? null, p.draw ?? null,
            p.horseElo ?? null, p.eloSource ?? null, p.horseConfidence ?? null,
            p.eloComposite ?? null, p.factorBonus ?? null, p.finalScore ?? null,
            p.pWin ?? null, p.pTop3 ?? null, p.rank ?? null,
            generatedAt,
            p.lgbScore ?? null,
            // Only attribute a model version when this pick was actually rescored by LGB.
            // Without this gate, payload-level lgbModelVersion would leak onto
            // partial-coverage rows whose scoreSource is not 'lgb', contaminating
            // future engine-split reporting (architect review of c4b0fd1).
            (p.scoreSource === 'lgb' || p.lgbScore != null)
              ? (p.lgbModelVersion ?? payload.lgbModelVersion ?? null)
              : null,
            p.scoreSource ?? null
          )
        );
      }
    }
    if (!stmts.length) return { rows: 0 };
    // batch in chunks of 50 (D1 batch limit ~100)
    for (let i = 0; i < stmts.length; i += 50) {
      await db.batch(stmts.slice(i, i + 50));
    }
    return { rows: stmts.length };
  }

  // Join predictions with actual race_results. Idempotent — only updates rows whose actual_finish IS NULL.
  export async function joinPredictionResults(db: D1Database, date: string): Promise<{ updated: number; races: number }> {
    await ensurePredictionLogTable(db);
    // Pull all results for this date
    const { results: actuals } = await db.prepare(
      `SELECT r.race_number, rr.horse_id, rr.finishing_position, rr.win_odds
       FROM race_meetings m
       JOIN races r ON r.meeting_id = m.id
       JOIN race_results rr ON rr.race_id = r.id
       WHERE m.date = ? AND m.venue IN ('ST','HV') AND rr.finishing_position > 0`
    ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
    if (!actuals?.length) return { updated: 0, races: 0 };
    const stmts: D1PreparedStatement[] = [];
    const seenRaces = new Set<number>();
    for (const a of actuals) {
      seenRaces.add(a.race_number);
      const finish = Number(a.finishing_position);
      const top1 = finish === 1 ? 1 : 0;
      const top3 = finish >= 1 && finish <= 3 ? 1 : 0;
      const top4 = finish >= 1 && finish <= 4 ? 1 : 0;
      stmts.push(
        db.prepare(`UPDATE prediction_log
          SET actual_finish = ?, actual_win_odds = ?, is_hit_top1 = ?, is_hit_top3 = ?, is_hit_top4 = ?, joined_at = ?
          WHERE date = ? AND race_number = ? AND horse_id = ? AND actual_finish IS NULL`)
          .bind(finish, a.win_odds ?? null, top1, top3, top4, new Date().toISOString(), date, a.race_number, a.horse_id)
      );
    }
    let updated = 0;
    for (let i = 0; i < stmts.length; i += 50) {
      const res = await db.batch(stmts.slice(i, i + 50));
      for (const r of res) updated += (r.meta?.changes ?? 0);
    }
    return { updated, races: seenRaces.size };
  }

  // Rolling N-day hit-rate / Brier / log-loss summary by variant.
  export async function summarizePredictionAccuracy(db: D1Database, days: number = 30): Promise<any> {
    await ensurePredictionLogTable(db);
    const sinceDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
    const { results } = await db.prepare(
      `SELECT date, race_number, variant, horse_id, p_win, p_top3, predicted_rank,
              actual_finish, is_hit_top1, is_hit_top3, is_hit_top4
       FROM prediction_log
       WHERE date >= ? AND actual_finish IS NOT NULL
       ORDER BY date DESC, race_number ASC`
    ).bind(sinceDate).all<any>().catch(() => ({ results: [] as any[] }));
    const byVariant: Record<string, any> = {};
    const seenRaces = new Set<string>();
    for (const r of (results ?? [])) {
      const v = r.variant ?? 'baseline';
      if (!byVariant[v]) byVariant[v] = { variant: v, races: 0, horses: 0, top1Picks: 0, top1Hits: 0, top3Picks3: 0, top3Hits: 0, brierWin: 0, brierWinN: 0, logLossWin: 0 };
      const b = byVariant[v];
      const raceKey = `${r.date}|${r.race_number}|${v}`;
      if (!seenRaces.has(raceKey)) { seenRaces.add(raceKey); b.races++; }
      b.horses++;
      if (r.predicted_rank === 1) { b.top1Picks++; if (r.is_hit_top1) b.top1Hits++; }
      if (r.predicted_rank != null && r.predicted_rank <= 3) { b.top3Picks3++; if (r.is_hit_top3) b.top3Hits++; }
      if (r.p_win != null && r.is_hit_top1 != null) {
        const y = r.is_hit_top1 ? 1 : 0;
        const p = Math.min(0.999, Math.max(0.001, r.p_win));
        b.brierWin += (p - y) * (p - y);
        b.brierWinN++;
        b.logLossWin += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      }
    }
    const summary = Object.values(byVariant).map((b: any) => ({
      variant: b.variant,
      races: b.races,
      horses: b.horses,
      bankerHitRate: b.top1Picks ? Math.round((b.top1Hits / b.top1Picks) * 1000) / 10 : null,
      top3PickHitRate: b.top3Picks3 ? Math.round((b.top3Hits / b.top3Picks3) * 1000) / 10 : null,
      brierWin: b.brierWinN ? Math.round((b.brierWin / b.brierWinN) * 10000) / 10000 : null,
      logLossWin: b.brierWinN ? Math.round((b.logLossWin / b.brierWinN) * 10000) / 10000 : null,
    }));
    return { sinceDate, days, summary };
  }

  

  // === New-horse ELO seed (Stage 8 data-completeness fix) ==============
  // When horse_elo_snapshots has no row (first-time runner / newly-imported),
  // derive a baseline ELO from HKJC handicap rating, or class median if none.
  // Marked with eloSource='rating-seed'|'class-seed' and lower confidence.
  export function classBaselineRating(raceClass: string | null | undefined): number {
    if (!raceClass) return 52;
    const s = String(raceClass);
    if (/Group\s*1|G1|一級|第一班/i.test(s)) return 105;
    if (/Group\s*2|G2|二級|第二班/i.test(s)) return 95;
    if (/Group\s*3|G3|三級|第三班/i.test(s)) return 85;
    if (/Griffin|新馬/i.test(s)) return 52;
    if (/第四班|Class\s*4/i.test(s)) return 55;
    if (/第五班|Class\s*5/i.test(s)) return 45;
    const m = s.match(/[1-5]/);
    if (m) {
      return ({ '1': 85, '2': 75, '3': 65, '4': 55, '5': 45 } as Record<string, number>)[m[0]] ?? 52;
    }
    return 52;
  }

  export function seedHorseElo(rating: number | string | null | undefined, raceClass: string | null | undefined): { rating: number; source: 'rating-seed' | 'class-seed'; confidence: number } {
    let r: number | null = null;
    if (typeof rating === 'string') { const p = parseInt(rating.trim(), 10); r = Number.isFinite(p) ? p : null; }
    else if (typeof rating === 'number' && Number.isFinite(rating)) r = rating;
    if (r != null && r > 0) {
      return { rating: 1500 + (r - 60) * 8, source: 'rating-seed', confidence: 0.4 };
    }
    return { rating: 1500 + (classBaselineRating(raceClass) - 60) * 8, source: 'class-seed', confidence: 0.2 };
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

  function buildPickNarrative(
    p: any,
    ctx: { distance?: number | null; going?: string | null; raceClass?: string | null; fieldSize?: number | null } = {},
  ): string {
    if (!p) return '';
    const rankWord = p.rank === 1 ? '本場首選' : p.rank === 2 ? '次選' : p.rank === 3 ? '三選' : p.rank === 4 ? '四選' : `第 ${p.rank} 選`;
    const pct = p.pWin != null ? `${(p.pWin * 100).toFixed(0)}%` : null;
    const seg: string[] = [];

    const hasLgb = typeof p.scoreSource === 'string' && p.scoreSource.indexOf('ensemble') >= 0 && p.lgbScore != null;
    const aiGood = hasLgb && p.lgbScore > -2.2;
    let lead = `系統將佢列為${rankWord}`;
    if (pct) lead += `，綜合勝算約 ${pct}`;
    if (hasLgb) lead += aiGood ? '；AI 機器學習與評分引擎雙雙看好' : '；評分引擎看好，AI 模型訊號偏弱';
    else lead += '；以實力評分引擎為主';
    seg.push(lead + '。');

    const fb = p.factorBreakdown || {};
    const bn = (k: string): number => (fb[k] && typeof fb[k].bonus === 'number') ? fb[k].bonus : 0;
    const pos: string[] = [];
    const neg: string[] = [];

    if (bn('draw') >= 2) pos.push(`今仗檔位${p.draw != null ? `（${p.draw} 檔）` : ''}佔優`);
    else if (bn('draw') <= -2) neg.push(`檔位${p.draw != null ? `（${p.draw} 檔）` : ''}稍為不利`);
    if (bn('weight') >= 2) pos.push('磅位有利');
    else if (bn('weight') <= -2) neg.push('負磅偏重');
    if (bn('distance') >= 2) pos.push(`往績適合今仗${ctx.distance ? ` ${ctx.distance} 米` : ''}途程`);
    else if (bn('distance') <= -2) neg.push('今仗距離未必最啱');
    if (bn('going') >= 2) pos.push(`往績適應今日${ctx.going || ''}場地`);
    else if (bn('going') <= -2) neg.push(`今日${ctx.going || ''}場地未必合適`);
    if (bn('condition') >= 2) pos.push('近期晨操狀態理想');
    if (bn('jtCombo') >= 2) pos.push('騎練配搭往績出色');
    if (bn('injury') <= -2) neg.push('近期有傷患記錄需留意');

    if (p.eloSource && p.eloSource !== 'snapshot') {
      pos.push('新馬登場，評分屬潛力估算');
    } else if (typeof p.daysSinceLast === 'number') {
      const d = p.daysSinceLast;
      if (d >= 14 && d <= 45) pos.push(`休息 ${d} 日復出，調整充分`);
      else if (d > 90) neg.push(`久休 ${d} 日復出，臨場狀態待觀察`);
      else if (d < 14 && d >= 0) pos.push(`${d} 日內再戰，狀態延續`);
    }

    if (p.eloComposite != null && p.eloComposite >= 1520) pos.push('實力評分高於全場平均');

    if (pos.length) seg.push(`支持理由：${pos.slice(0, 4).join('、')}。`);
    if (neg.length) seg.push(`需留意：${neg.slice(0, 2).join('、')}。`);

    return seg.join('');
  }

// 共用 helper：批量載入指定賽事日所有場次的 LGB 預測分數
// 被 computePicksFromEntries (hit-rate) 與 runRaceDayReportCompute (today-picks) 共用，
// 防止兩條路徑 drift（曾經 hit-rate 冇 LGB 路徑 → admin 面板顯示純 ELO）。
export async function loadLgbScoresForMeeting(
  db: any,
  raceNumbers: number[],
  racesDBMap: Map<number, any>,
  targetDate: string,
  venue: string,
): Promise<{ map: Map<string, { score: number; pWin: number | null; modelVersion: string | null }>; modelVersion: string | null }> {
  const map = new Map<string, { score: number; pWin: number | null; modelVersion: string | null }>();
  let modelVersion: string | null = null;
  try {
    const synthRaceIds = raceNumbers
      .filter(rn => rn > 0)
      .map(rn => racesDBMap.get(rn)?.id ?? `race_${targetDate}_${venue}_${rn}`);
    if (synthRaceIds.length) {
      const ph = synthRaceIds.map(() => '?').join(',');
      const { results: lgbRows } = await db.prepare(
        `SELECT race_id, horse_id, lgb_score, p_win, model_version
           FROM lgb_predictions WHERE race_id IN (${ph})`
      ).bind(...synthRaceIds).all<any>().catch(() => ({ results: [] as any[] }));
      for (const r of (lgbRows ?? [])) {
        map.set(`${r.race_id}::${r.horse_id}`, {
          score: Number(r.lgb_score),
          pWin: r.p_win != null ? Number(r.p_win) : null,
          modelVersion: r.model_version ?? null,
        });
        if (!modelVersion && r.model_version) modelVersion = r.model_version;
      }
    }
  } catch { /* table may not exist on cold envs */ }
  return { map, modelVersion };
}

// 共用 helper：計算指定賽事日的命中率統計（被 /hit-rate 與 /hit-rate-rollup 共用）
// alphaOverride: 用於 /admin/api/ensemble-tune α grid search (P4 backtest)。
export async function computeHitRateStats(db: any, date: string, engine: EloEngine, alphaOverride?: number): Promise<
  | { error: string; status: number }
  | { meeting: any; races: any[]; summary: any }
> {
  const meeting = await db.prepare(`SELECT m.* FROM race_meetings m WHERE m.date = ? AND m.venue IN ('ST','HV') ORDER BY (SELECT COUNT(*) FROM races r WHERE r.meeting_id = m.id) DESC, m.id LIMIT 1`).bind(date).first<any>().catch(() => null);
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
     WHERE rm.date = ? AND rm.venue IN ('ST','HV')
     ORDER BY r.race_number, rr.horse_number`
  ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
  if (!entries?.length) return { error: `${date} 賽果無資料 — 可能為未來賽事或結果未同步`, status: 404 };
  const { results: actual } = await db.prepare(
    `SELECT r.race_number, rr.horse_number, rr.horse_id, rr.finishing_position, rr.win_odds, h.name_ch
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     JOIN race_meetings rm ON rm.id = r.meeting_id
     LEFT JOIN horses h ON h.id = rr.horse_id
     WHERE rm.date = ? AND rm.venue IN ('ST','HV') AND rr.finishing_position IS NOT NULL AND rr.finishing_position > 0
     ORDER BY r.race_number, rr.finishing_position`
  ).bind(date).all<any>().catch(() => ({ results: [] as any[] }));
  const actualByRace = new Map<number, any[]>();
  for (const r of (actual ?? [])) {
    if (!actualByRace.has(r.race_number)) actualByRace.set(r.race_number, []);
    actualByRace.get(r.race_number)!.push(r);
  }
  const picksData = await computePicksFromEntries(db, date, meeting, entries, engine, alphaOverride);
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
        // odds lookup by horse_id (covers ALL runners in race_results, not just top 4)
        const oddsById = new Map<string, number | null>(
          (actualByRace.get(race.raceNumber) ?? []).map((a: any) => [a.horse_id, a.win_odds ?? null])
        );

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
          lgbScore: p.lgbScore ?? null, lgbModelVersion: p.lgbModelVersion ?? null,
          scoreSource: p.scoreSource ?? null,
        })),
        scoreSource: (race as any).scoreSource ?? null,
        lgbModelVersion: (race as any).lgbModelVersion ?? null,
        lgbCoverage: (race as any).lgbCoverage ?? null,
        // New: top-4 picks (rank 1-4) with per-pick reason text + hit flag
        predictedTop4: predictedTop4.map((p: any) => ({
          rank: p.rank, horseNumber: p.horseNumber, horseId: p.horseId,
          nameCh: p.nameCh, jockeyCh: p.jockeyCh, trainerCh: p.trainerCh,
          horseElo: p.horseElo, jockeyElo: p.jockeyElo, trainerElo: p.trainerElo,
          eloComposite: p.eloComposite, finalScore: p.finalScore, pWin: p.pWin,
          lgbScore: p.lgbScore ?? null, lgbModelVersion: p.lgbModelVersion ?? null,
          scoreSource: p.scoreSource ?? null,
          factorBonus: p.factorBonus,
          reason: buildPickReason(p),
          hit: actualTop4Ids.has(p.horseId),
          winOdds: oddsById.get(p.horseId) ?? null,
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
    // P0 architect fix 2026-05-21: surface ensemble availability so admin/UI
    // can distinguish meetings actually scored by TX-Oracle v3 from those
    // that silently fell back to pure ELO+factor (lgb_predictions empty for
    // past dates). Aggregates per-race scoreSource into meeting-level counts.
    let ensembleRaces = 0, eloOnlyRaces = 0, lgbHitsTotal = 0, lgbSlotsTotal = 0;
    for (const r of races) {
      const src = (r as any).scoreSource || 'unknown';
      if (src.includes('tx-oracle')) ensembleRaces++; else if (src.startsWith('elo')) eloOnlyRaces++;
      const cov = (r as any).lgbCoverage;
      if (cov) { lgbHitsTotal += cov.hits || 0; lgbSlotsTotal += cov.total || 0; }
    }
    const ensembleCoveragePct = races.length ? Math.round(ensembleRaces / races.length * 1000) / 10 : null;
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
        // P0 fix: ensemble availability transparency
        ensembleAvailable: ensembleRaces > 0,
        ensembleCoveragePct,
        scoreSourceBreakdown: { ensemble: ensembleRaces, eloOnly: eloOnlyRaces, total: races.length },
        lgbRunnerCoverage: lgbSlotsTotal ? { hits: lgbHitsTotal, slots: lgbSlotsTotal, pct: Math.round(lgbHitsTotal / lgbSlotsTotal * 1000) / 10 } : null,
        fallbackReason: ensembleRaces === 0 && races.length > 0 ? 'LGB_PREDICTIONS_MISSING' : null,
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
      WHERE r.id = ? AND rm.venue IN ('ST','HV')
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

    // TimesFM trend prediction removed 2026-05-25 (exploration not productionized)
    const timesfmResults: any[] = [];

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
    WHERE r.id = ? AND rm.venue IN ('ST','HV')
  `).bind(raceId).first<any>();
  const raceDistance: number | null = raceCtx?.distance ?? null;
  const raceGoing: string | null = raceCtx?.going ?? null;
  const raceVenue: string | null = raceCtx?.venue ?? null;

  // ── Stage 7 (2026-05-19): LGB pre-computed score lookup ─────────────────
  // Nightly GH workflow trains LightGBM lambdarank and writes per-runner
  // scores to lgb_predictions. When present, lgb_score overrides _score
  // (the softmax ranking input). ELO breakdown stays in the response for
  // transparency. Backtest: 21.65% Top1 vs 17.0% ELO baseline (+27% rel).
  const lgbScoreByHorse: Record<string, number> = {};
  let lgbModelVersion: string | null = null;
  try {
    const { results: lgbRows } = await db.prepare(
      `SELECT horse_id, lgb_score, model_version FROM lgb_predictions WHERE race_id = ?`
    ).bind(raceId).all<any>();
    for (const r of (lgbRows || [])) {
      lgbScoreByHorse[r.horse_id] = Number(r.lgb_score);
      if (!lgbModelVersion) lgbModelVersion = r.model_version;
    }
  } catch { /* table may not exist on stale workers */ }
  const hasLgb = Object.keys(lgbScoreByHorse).length > 0;

  // Leakage fix (2026-04-30): use date-filtered subqueries instead of
  // h.total_wins/h.total_starts (which are recomputed post-ingest to include
  // the same-day race being predicted). wins_pre/starts_pre count results
  // from meetings strictly before raceDate.
  const { results } = await db.prepare(`
    SELECT rr.horse_id, rr.jockey_id, rr.trainer_id,
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
    // R5 ablation (88d / 853 races, 2026-05-10): production keeps only draw + weight.
      // Other factors retained in factorBreakdown for telemetry but excluded from finalScore.
      // Reference: reports/decision-log.md "2026-05-10 · R5 88-day ablation".
      const factorBonus = fDraw.bonus + fWeight.bonus;

    const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
    // winRate computed from pre-race wins/starts only (no same-day leakage).
    const winRate = r.starts_pre > 0 ? r.wins_pre / r.starts_pre : 0;
    // Stage 7: prefer LGB score when present, fall back to ELO+factor composite.
    const lgbScore = lgbScoreByHorse[r.horse_id];
    const useLgb = lgbScore != null && Number.isFinite(lgbScore);
    const score = useLgb ? lgbScore : (base + winRate * 1.2 + factorBonus / 100);
    const finalScore = useLgb
      ? Math.round(lgbScore * 1000) / 1000
      : (eloComposite != null ? eloComposite + factorBonus : null);

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
      lgbScore: useLgb ? Math.round(lgbScore * 1000) / 1000 : null,
      scoreSource: useLgb ? 'lgb' : 'elo',
      lgbModelVersion: useLgb ? lgbModelVersion : null,
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
      lgbScore: (s as any).lgbScore ?? null,
      scoreSource: (s as any).scoreSource ?? 'elo',
      lgbModelVersion: (s as any).lgbModelVersion ?? null,
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
    WHERE r.id = ? AND rm.venue IN ('ST','HV')
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
        WHERE e.race_date = ? AND e.venue = ? AND e.venue IN ('ST','HV') AND (e.race_number = ? OR e.race_number IS NULL)
        ORDER BY e.horse_number
      `).bind(race.date, race.venue, race.race_number).all<any>().catch(() => ({ results: [] as any[] }));
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
    SELECT r.*, rm.date FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id WHERE r.id = ? AND rm.venue IN ('ST','HV')
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

    // ── TX-Oracle v3 (2026-05-21) ────────────────────────────────────────
    // Ensemble α (LGB weight) loader. Default 0.62 (LGB-leaning but ELO
    // retains meaningful say). Override via app_settings (key='ensemble_alpha')
    // — written by /admin/api/ensemble-tune after backtest grid search.
    export async function getEnsembleAlpha(db: D1Database): Promise<number> {
      try {
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS app_settings (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
           )`
        ).run().catch(() => {});
        const row = await db.prepare(
          `SELECT value FROM app_settings WHERE key = 'ensemble_alpha'`
        ).first<{ value: string }>().catch(() => null);
        if (row?.value) {
          const n = Number(row.value);
          if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
        }
      } catch { /* ignore */ }
      return 0.62;
    }

    // Apply TX-Oracle v3 ensemble in-place on enriched picks (P0 + P1).
    // - When ANY runner has LGB: z-blend (α·lgb_z + (1-α)·elo_z) for the
    //   whole race. Missing-LGB runners impute lgb_z = 0 (race mean →
    //   neutral). Preserves softmax pWin coherence.
    // - When NO runner has LGB: leave _score/finalScore from elo+factor.
    export function applyEnsembleBlend(
      enriched: any[],
      alpha: number,
      lgbScoreByRaceHorse: Map<string, { score: number; pWin: number | null; modelVersion: string | null }>,
      lgbLookupRaceId: string,
    ): { raceHasLgb: boolean; lgbHits: number; lgbModelVerForRace: string | null } {
      let lgbHits = 0;
      let lgbModelVerForRace: string | null = null;
      const lgbVals: number[] = [];
      const eloVals: number[] = [];
      for (const s of enriched) {
        const lgb = s.horseId ? lgbScoreByRaceHorse.get(`${lgbLookupRaceId}::${s.horseId}`) : undefined;
        if (lgb && Number.isFinite(lgb.score)) {
          (s as any).__lgb = lgb;
          lgbVals.push(lgb.score);
          lgbHits++;
          if (!lgbModelVerForRace) lgbModelVerForRace = lgb.modelVersion;
        }
        if (s.eloComposite != null && Number.isFinite(s.eloComposite)) eloVals.push(s.eloComposite as number);
      }
      const raceHasLgb = lgbHits > 0;
      if (!raceHasLgb) {
        for (const s of enriched) s.scoreSource = 'elo+factor';
        return { raceHasLgb, lgbHits, lgbModelVerForRace };
      }
      const ms = (arr: number[]) => {
        if (arr.length < 2) return { m: arr[0] ?? 0, s: 1 };
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
        return { m, s: Math.sqrt(v) || 1 };
      };
      const { m: lgbMean, s: lgbStd } = ms(lgbVals);
      const { m: eloMean, s: eloStd } = ms(eloVals);
      const aStr = alpha.toFixed(2);
      for (const s of enriched) {
        const lgb = (s as any).__lgb;
        delete (s as any).__lgb;
        const eloZ = (s.eloComposite != null && Number.isFinite(s.eloComposite))
          ? (s.eloComposite - eloMean) / eloStd : 0;
        const lgbZ = lgb ? (lgb.score - lgbMean) / lgbStd : 0; // impute race mean
        const blendZ = alpha * lgbZ + (1 - alpha) * eloZ;
        // factorTilt kept at 0.5× weight: empirical A/B (2026-05-21 5-20 backtest)
        // showed removing it dropped top-1 from 55.6%→33.3%. LGB *should* subsume
        // draw/weight but in practice factorBonus provides complementary recent
        // draw-bias signal LGB's training data missed. DO NOT REMOVE without rerunning backtest.
        const factorTilt = (s.factorBonus || 0) / 100;
        s._score = blendZ + factorTilt * 0.5;
        s.lgbScore = lgb ? Math.round(lgb.score * 1000) / 1000 : null;
        s.lgbModelVersion = lgb ? lgb.modelVersion : null;
        s.ensembleAlpha = alpha;
        s.scoreSource = lgb
          ? `tx-oracle-v3 (ensemble α=${aStr})`
          : `tx-oracle-v3 (lgb-imputed α=${aStr})`;
        s.finalScore = Math.round((1500 + blendZ * 100) * 10) / 10;
      }
      return { raceHasLgb, lgbHits, lgbModelVerForRace };
    }

    // ── computePicksFromEntries: shared helper for today-picks / picks-by-date / hit-rate ──
      async function computePicksFromEntries(
        db: D1Database,
        targetDate: string,
        meeting: any,
        entries: any[],
        engine: EloEngine,
        alphaOverride?: number,
      ): Promise<any> {
        const effectiveAlpha = (typeof alphaOverride === 'number' && Number.isFinite(alphaOverride) && alphaOverride >= 0 && alphaOverride <= 1)
          ? alphaOverride : await getEnsembleAlpha(db);
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
        // ── Stage 7 (2026-05-21): batch-load LGB pre-computed scores via shared helper ──
        const { map: lgbScoreByRaceHorse, modelVersion: helperLgbModelVersion } =
          await loadLgbScoresForMeeting(db, raceNumbers, racesDBMap, targetDate, meeting.venue);

        const racePredictions = raceNumbers.map(raceNum => {
          const raceEntries = raceMap.get(raceNum)!;
          const firstE = raceEntries[0];
          const raceDB = racesDBMap.get(raceNum);
          const raceId = raceDB?.id ?? null;
          const lgbLookupRaceId: string = raceDB?.id ?? `race_${targetDate}_${meeting.venue}_${raceNum}`;
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
            // R5 ablation (88d): production keeps only draw + weight (see reports/decision-log.md).
            const factorBonus = fDraw.bonus + fWeight.bonus;
            const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
            const finalScore = eloComposite != null ? eloComposite + factorBonus : null;
            return { horseId, horseNumber: e.horse_number, nameCh: e.name_ch, nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: hElo != null ? Math.round(hElo*10)/10 : null, jockeyElo: jElo != null ? Math.round(jElo*10)/10 : null, trainerElo: tElo != null ? Math.round(tElo*10)/10 : null, eloComposite: eloComposite != null ? Math.round(eloComposite*10)/10 : null, eloEngine: hRead?.engine ?? engine, horseConfidence: hRead?.confidence != null ? Math.round(hRead.confidence*100)/100 : null, horseFrozen: hRead?.isFrozen ?? false, horseRetired: hRead?.isRetired ?? false, factorBonus: Math.round(factorBonus*10)/10, factorBreakdown, finalScore: finalScore != null ? Math.round(finalScore*10)/10 : null, daysSinceLast: daysSince, _score: base + factorBonus / 100 };
          });
          // ── TX-Oracle v3 (2026-05-21): ensemble blend via shared helper ──
          // P0 stacking: α·lgb_z + (1-α)·elo_z (default α=0.62, KV-tunable).
          // P1 partial coverage: missing-LGB runners impute lgb_z = 0.
          const { raceHasLgb, lgbHits, lgbModelVerForRace } = applyEnsembleBlend(
            enriched as any[], effectiveAlpha, lgbScoreByRaceHorse, lgbLookupRaceId,
          );
          const expScores = enriched.map((s) => Math.exp(s._score));
          const Z = expScores.reduce((a, b) => a + b, 0) || 1;
          const picks = enriched.map((s, i) => { const { _score, ...rest } = s as any; return { ...rest, pWin: Math.round((expScores[i]/Z)*1000)/1000, pTop3: Math.round(Math.min((expScores[i]/Z)*3,0.99)*1000)/1000 }; });
          picks.sort((a: any, b: any) => b.pWin - a.pWin);
          picks.forEach((p: any, i: number) => { p.rank = i + 1; });
          const _txTotal = (enriched as any[]).length;
          return { raceId, lgbLookupRaceId, raceNumber: raceNum, title: raceTitle, class: raceClass, distance: raceDistance, going: raceGoing, track: raceTrack, course: raceCourse, picks, scoreSource: raceHasLgb ? `tx-oracle-v3 (lgb=${lgbHits}/${_txTotal}, α=${effectiveAlpha.toFixed(2)})` : 'elo+factor', lgbCoverage: { hits: lgbHits, total: _txTotal, applied: raceHasLgb }, lgbModelVersion: lgbModelVerForRace, ensembleAlpha: effectiveAlpha };
        });
        const eloReady = racePredictions.some((r) => r.picks?.some((p: any) => p.eloComposite != null));
        return { date: targetDate, venue: meeting.venue, trackCondition: meeting.track_condition, eloEngine: engine, eloWeights: ELO_WEIGHTS, eloReady, races: racePredictions, lgbModelVersion: helperLgbModelVersion, lgbCoverage: { rows: lgbScoreByRaceHorse.size }, generatedAt: new Date().toISOString() };
      }

      // GET /api/analyze/today-picks — 即日排位全因子預測 (batch-query version; ~20 D1 queries)
    // === Race-day report compute (Stage 8) ============================
      // Extracted so cron + admin manual trigger can re-use the same logic.
      // Cache-first by default; pass { fresh: true } to force recompute + cache write.

      // GET /api/analyze/today-picks — 即日排位全因子預測 (batch-query version; ~20 D1 queries)
    // === Race-day report compute (Stage 8) ============================
      // Extracted so cron + admin manual trigger can re-use the same logic.
      // Cache-first by default; pass { fresh: true } to force recompute + cache write.
      // ── Market-blend (additive; does NOT change model ranking) ──────────────
      // Backtest verdict (2026-06, 520 races, 4 disjoint splits): LOG-blending the
      // market win-prob into model pWin lifts top1 20→32% — but it leans FAVOURITE
      // (high hit-rate); it does NOT catch 冷馬. Exposed as a SEPARATE "市場穩陣" column
      // beside the unchanged "模型搏冷" ranking. β from the sweep.
      const MARKET_BLEND_BETA = 0.4;

      // Latest WIN-pool odds snapshot per race for a meeting. Odds firm up race-day;
      // empty before then → market column shows "等臨場盤口". combination = horse_number.
      async function fetchLatestWinOddsByRace(
        db: D1Database, date: string, venue: string
      ): Promise<Map<number, { odds: Map<string, number>; snapshotAt: string }>> {
        const out = new Map<number, { odds: Map<string, number>; snapshotAt: string }>();
        // Single query, ordered by snapshot_at ASC → per-horse last-write is its latest odds
        // (deterministic; robust to horses scratched/added across snapshots & to dup rows).
        const { results: rows } = await db.prepare(
          `SELECT race_number, combination, odds, snapshot_at
             FROM odds_snapshots
            WHERE race_date = ? AND venue = ? AND pool_type = 'WIN'
            ORDER BY snapshot_at ASC`
        ).bind(date, venue).all<any>().catch(() => ({ results: [] as any[] }));
        const perHorse = new Map<number, Map<string, { odds: number; at: string }>>();
        for (const row of (rows ?? [])) {
          const o = Number(row.odds);
          if (!(o > 1)) continue;
          const rn = Number(row.race_number);
          if (!perHorse.has(rn)) perHorse.set(rn, new Map());
          perHorse.get(rn)!.set(String(row.combination), { odds: o, at: String(row.snapshot_at) });
        }
        for (const [rn, hm] of perHorse) {
          const odds = new Map<string, number>();
          let at = '';
          for (const [k, v] of hm) { odds.set(k, v.odds); if (v.at > at) at = v.at; }
          if (odds.size) out.set(rn, { odds, snapshotAt: at });
        }
        return out;
      }

      // Attach an additive market-blend ranking to a race's picks. Mutates each pick
      // with liveWinOdds / marketProb / blendProb / marketRank. Model rank & pWin are
      // LEFT UNTOUCHED. Returns { marketReady }.
      function attachMarketBlend(
        picks: any[], oddsByHorseNo: Map<string, number> | null
      ): { marketReady: boolean } {
        if (!oddsByHorseNo || oddsByHorseNo.size === 0) return { marketReady: false };
        const withOdds = picks.filter(
          (p) => p.pWin != null && oddsByHorseNo.has(String(p.horseNumber))
        );
        if (withOdds.length < 2) return { marketReady: false };
        // Explicitly null market fields on ALL picks first so non-covered runners
        // (scratched / no odds) are unambiguous for downstream consumers.
        for (const p of picks) {
          p.liveWinOdds = null; p.marketProb = null; p.blendProb = null; p.marketRank = null;
        }
        const invSum = withOdds.reduce(
          (a, p) => a + 1 / oddsByHorseNo.get(String(p.horseNumber))!, 0
        );
        const modelSum = withOdds.reduce((a, p) => a + p.pWin, 0) || 1;
        const eps = 1e-9;
        const scored = withOdds.map((p) => {
          const o = oddsByHorseNo.get(String(p.horseNumber))!;
          const mktP = 1 / o / invSum;
          const modelP = p.pWin / modelSum;
          const blendScore =
            (1 - MARKET_BLEND_BETA) * Math.log(modelP + eps) +
            MARKET_BLEND_BETA * Math.log(mktP + eps);
          return { p, o, mktP, blendScore };
        });
        const mx = Math.max(...scored.map((s) => s.blendScore));
        const exps = scored.map((s) => Math.exp(s.blendScore - mx));
        const Z = exps.reduce((a, b) => a + b, 0) || 1;
        scored.forEach((s, i) => {
          s.p.liveWinOdds = Math.round(s.o * 10) / 10;
          s.p.marketProb = Math.round(s.mktP * 1000) / 1000;
          s.p.blendProb = Math.round((exps[i] / Z) * 1000) / 1000;
        });
        [...scored]
          .sort((a, b) => b.blendScore - a.blendScore)
          .forEach((s, i) => { s.p.marketRank = i + 1; });
        return { marketReady: true };
      }

      async function runRaceDayReportCompute(db: D1Database, engine: EloEngine, opts: { fresh?: boolean; venue?: string } = {}): Promise<any> {
        const fresh = opts.fresh === true;
        const forceVenue = opts.venue;
        const todayStr = new Date().toISOString().split('T')[0];
        // Date picker: use race_meetings (persisted by Capy D1 Sync immediately) as
        // the authoritative source, NOT entries_upcoming (lags Capy Racecard
        // enrichment by minutes-to-hours). Previously picked MAX(entries_upcoming)
        // = latest PAST race day when next meeting's entries weren't enriched yet,
        // causing "排位表無資料" for already-raced dates. Now picks next upcoming
        // meeting and lets the entries-empty fallback below give a clearer message.
        let targetDate: string | null = await db.prepare(
          `SELECT MIN(date) FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV')`
        ).bind(todayStr).first<string>('MIN(date)').catch(() => null);
        if (!targetDate) {
          targetDate = await db.prepare(`SELECT MAX(date) FROM race_meetings WHERE venue IN ('ST','HV')`).first<string>('MAX(date)').catch(() => null);
        }
        if (!targetDate) return { error: '賽馬日記錄不存在', status: 404 };

        // NOTE: early non-venue cache read removed (architect 2026-05-25). Writes use
        // venue-scoped key (cacheKey = `${engine}::${venue}`) at the bottom of this fn,
        // so bare-`engine` reads were dead code at best, and could return stale
        // wrong-venue payloads at worst if pre-venue-scoping cache rows survived.
        // Venue-scoped cache read happens after meeting resolution below.
        const t0 = Date.now();

        // Pick meeting: prefer one with entries_upcoming rows for that date
          // (today-picks is about racecards we'll predict, not historic results).
          // Falls back to most-races meeting. ?venue=HV forces a specific venue.
          let meeting: any = null;
          if (forceVenue) {
            meeting = await db.prepare(`SELECT m.* FROM race_meetings m WHERE m.date = ? AND m.venue = ? AND m.venue IN ('ST','HV') LIMIT 1`).bind(targetDate, forceVenue).first<any>().catch(() => null);
          }
          if (!meeting) {
            meeting = await db.prepare(
              `SELECT m.* FROM race_meetings m
                WHERE m.date = ?
                  AND m.venue IN ('ST','HV')
                  AND EXISTS (SELECT 1 FROM entries_upcoming e WHERE e.race_date = m.date AND e.venue = m.venue AND e.race_number > 0)
                ORDER BY m.id LIMIT 1`
            ).bind(targetDate).first<any>().catch(() => null);
          }
          if (!meeting) {
            meeting = await db.prepare(`SELECT m.* FROM race_meetings m WHERE m.date = ? AND m.venue IN ('ST','HV') ORDER BY (SELECT COUNT(*) FROM races r WHERE r.meeting_id = m.id) DESC, m.id LIMIT 1`).bind(targetDate).first<any>().catch(() => null);
          }
          if (!meeting) return { error: `${targetDate} 賽馬日記錄不存在`, status: 404 };

          // Architect fix: venue-scoped cache key so HV/ST don't collide; ?venue= bypasses.
          const cacheKey = `${engine}::${meeting.venue}`;
          if (!fresh && !forceVenue) {
            const cached = await readRaceDayReportCache(db, targetDate, cacheKey);
            if (cached) return cached;
          }
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
               WHERE e.race_date = ? AND e.venue IN ('ST','HV') AND e.race_number > 0
               ORDER BY e.race_number, e.horse_number`;
          const stmt = withVenue ? db.prepare(q).bind(targetDate, meeting.venue) : db.prepare(q).bind(targetDate);
          const { results } = await stmt.all<any>().catch(() => ({ results: [] as any[] }));
          return results ?? [];
        };
        let entries = await loadEntries(true);
        if (!entries.length) entries = await loadEntries(false);
        if (!entries.length) return { error: `${targetDate} ${meeting.venue} 排位表更新中，請稍候`, status: 404, targetDate, venue: meeting.venue };
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
        let seedRatingCount = 0, seedClassCount = 0;

        // ── Stage 7 (2026-05-21): batch-load LGB pre-computed scores via shared helper ──
        // Synth race_id matches scripts/import-csv.ts raceId():
        //   race_<YYYY-MM-DD>_<VENUE>_<raceNo>
        // For upcoming races (no races row yet) the dump-features synth uses
        // the same key, so lookup works before & after results are imported.
        const { map: lgbScoreByRaceHorse, modelVersion: todayPicksLgbModelVersion } =
          await loadLgbScoresForMeeting(db, raceNumbers, racesDBMap, targetDate, meeting.venue);
        const todayPicksAlpha = await getEnsembleAlpha(db);
        const liveWinOddsByRace = await fetchLatestWinOddsByRace(db, targetDate, meeting.venue).catch(() => new Map<number, { odds: Map<string, number>; snapshotAt: string }>());

        const racePredictions = raceNumbers.map(raceNum => {
          const raceEntries = raceMap.get(raceNum)!;
          const firstE = raceEntries[0];
          const raceDB = racesDBMap.get(raceNum);
          const raceId = raceDB?.id ?? null;
          const lgbLookupRaceId: string = raceDB?.id ?? `race_${targetDate}_${meeting.venue}_${raceNum}`;
          const raceTitle = raceDB?.title ?? (raceNum > 0 ? `第 ${raceNum} 場` : `${targetDate} 排位`);
          const raceDistance: number | null = firstE.distance ?? null;
          const raceGoing: string | null = raceDB?.going ?? meeting.track_condition ?? null;
          const raceTrack: string | null = firstE.track ?? null;
          const raceCourse: string | null = firstE.course ?? null;
          const raceClass: string | null = firstE.race_class ?? null;
          const enriched = raceEntries.map((e: any) => {
            const horseId: string | null = e.horse_id ?? e.horse_code ?? null;
            if (!horseId) return { horseId: null, horseNumber: e.horse_number, nameCh: e.name_ch ?? String(e.horse_number), nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: null, jockeyElo: null, trainerElo: null, eloComposite: null, eloEngine: engine, eloSource: 'none', horseConfidence: null, horseFrozen: false, horseRetired: false, factorBonus: 0, factorBreakdown: null, finalScore: null, daysSinceLast: null, _score: 0 };
            const horseEloId = horseId;
            const jSnapshotId: string | null = prefixId(e.jockey_id ?? e.jockey_name, 'jockey');
            const tSnapshotId: string | null = prefixId(e.trainer_id ?? e.trainer_name, 'trainer');
            const hRead = horseEloMap.get(horseEloId) ?? null;
            const jRead = jSnapshotId ? (jockeyEloMap.get(jSnapshotId) ?? null) : null;
            const tRead = tSnapshotId ? (trainerEloMap.get(tSnapshotId) ?? null) : null;
            let hElo: number | null = hRead?.rating ?? null;
            let eloSource: 'snapshot' | 'rating-seed' | 'class-seed' | 'none' = hRead ? 'snapshot' : 'none';
            let seedConfidence: number | null = null;
            if (hElo == null) {
              const seed = seedHorseElo(e.rating, raceClass);
              hElo = seed.rating;
              eloSource = seed.source;
              seedConfidence = seed.confidence;
              if (seed.source === 'rating-seed') seedRatingCount++; else seedClassCount++;
            }
            const jElo = jRead?.rating ?? null; const tElo = tRead?.rating ?? null;
            // Phase A: down-weight horse ELO when low-confidence (seed) so jockey+trainer carry more.
            // snapshot w/o explicit conf → 1.0; rating-seed → 0.4; class-seed → 0.2.
            const horseConfFactor = eloSource === 'snapshot' ? (hRead?.confidence ?? 1) : (seedConfidence ?? 0);
            const effHorseW = ELO_WEIGHTS.horse * horseConfFactor;
            const parts: number[] = [];
            if (hElo != null) parts.push(hElo * effHorseW);
            if (jElo != null) parts.push(jElo * ELO_WEIGHTS.jockey);
            if (tElo != null) parts.push(tElo * ELO_WEIGHTS.trainer);
            const wSum = (hElo != null ? effHorseW : 0) + (jElo != null ? ELO_WEIGHTS.jockey : 0) + (tElo != null ? ELO_WEIGHTS.trainer : 0);
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
            const factorBreakdown = { recency: { bonus: recency, conf: daysSince != null ? 1 : 0, note: daysSince != null ? `距上次 ${daysSince} 天` : (eloSource !== 'snapshot' ? '新馬未曾出賽' : '無上次紀錄') }, distance: fDist, going: fGoing, draw: fDraw, weight: fWeight, condition: fCond, injury: fInjury, jtCombo: fJT };
            // R5 ablation (88d): production keeps only draw + weight (see reports/decision-log.md).
            const factorBonus = fDraw.bonus + fWeight.bonus;
            const base = eloComposite != null ? (eloComposite - 1500) / 200 : 0;
            const finalScore = eloComposite != null ? eloComposite + factorBonus : null;
            const computedConf = hRead?.confidence != null ? Math.round(hRead.confidence*100)/100 : (seedConfidence != null ? seedConfidence : null);
            return { horseId, horseNumber: e.horse_number, nameCh: e.name_ch, nameEn: e.name_en, jockeyCh: e.jockey_name, trainerCh: e.trainer_name, draw: e.draw, declaredWeight: e.declared_weight, rating: e.rating, horseElo: hElo != null ? Math.round(hElo*10)/10 : null, jockeyElo: jElo != null ? Math.round(jElo*10)/10 : null, trainerElo: tElo != null ? Math.round(tElo*10)/10 : null, eloComposite: eloComposite != null ? Math.round(eloComposite*10)/10 : null, eloEngine: hRead?.engine ?? engine, eloSource, horseConfidence: computedConf, horseConfWeightFactor: Math.round(horseConfFactor*100)/100, horseFrozen: hRead?.isFrozen ?? false, horseRetired: hRead?.isRetired ?? false, factorBonus: Math.round(factorBonus*10)/10, factorBreakdown, finalScore: finalScore != null ? Math.round(finalScore*10)/10 : null, daysSinceLast: daysSince, _score: base + factorBonus / 100 };
          });
          // ── TX-Oracle v3 (2026-05-21): ensemble blend via shared helper ──
            const { raceHasLgb, lgbHits, lgbModelVerForRace } = applyEnsembleBlend(
              enriched as any[], todayPicksAlpha, lgbScoreByRaceHorse, lgbLookupRaceId,
            );
            const expScores = enriched.map((s) => Math.exp(s._score));
          const Z = expScores.reduce((a, b) => a + b, 0) || 1;
          const picks = enriched.map((s, i) => { const { _score, ...rest } = s as any; return { ...rest, pWin: Math.round((expScores[i]/Z)*1000)/1000, pTop3: Math.round(Math.min((expScores[i]/Z)*3,0.99)*1000)/1000 }; });
          picks.sort((a: any, b: any) => b.pWin - a.pWin);
          picks.forEach((p: any, i: number) => { p.rank = i + 1; });
          const _mbOdds = liveWinOddsByRace.get(raceNum) ?? null;
          const _mb = attachMarketBlend(picks, _mbOdds?.odds ?? null);
          const _txTotal2 = (enriched as any[]).length;
          return { raceId, lgbLookupRaceId, raceNumber: raceNum, title: raceTitle, class: raceClass, distance: raceDistance, going: raceGoing, track: raceTrack, course: raceCourse, picks, scoreSource: raceHasLgb ? `tx-oracle-v3 (lgb=${lgbHits}/${_txTotal2}, α=${todayPicksAlpha.toFixed(2)})` : 'elo+factor', lgbCoverage: { hits: lgbHits, total: _txTotal2, applied: raceHasLgb }, lgbModelVersion: lgbModelVerForRace, ensembleAlpha: todayPicksAlpha, marketReady: _mb.marketReady, oddsSnapshotAt: _mbOdds?.snapshotAt ?? null, marketBeta: MARKET_BLEND_BETA };
        });
        const eloReady = racePredictions.some((r) => r.picks?.some((p: any) => p.eloComposite != null));
        const computeMs = Date.now() - t0;
        const payload = {
          date: targetDate, venue: meeting.venue, trackCondition: meeting.track_condition,
          eloEngine: engine, eloWeights: ELO_WEIGHTS, eloReady, races: racePredictions,
          seedSummary: { ratingSeeded: seedRatingCount, classSeeded: seedClassCount, totalSeeded: seedRatingCount + seedClassCount },
          lgbModelVersion: todayPicksLgbModelVersion,
          lgbCoverage: { rows: lgbScoreByRaceHorse.size },
          computeMs, generatedAt: new Date().toISOString(),
        };
        // Phase A: write each prediction to prediction_log for back-test (idempotent).
        const logResult = await writePredictionLog(db, payload, 'baseline').catch((e) => ({ rows: 0, error: String(e?.message ?? e) }));
        payload.predictionLog = logResult;

        await writeRaceDayReportCache(db, targetDate, cacheKey, meeting.venue, payload, computeMs).catch(() => {});
        return payload;
      }

      analyzeRoutes.get('/today-picks', async (c) => {
        try {
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const fresh = c.req.query('fresh') === '1';
          const venue = c.req.query('venue') || undefined;
          const result = await runRaceDayReportCompute(c.env.DB, engine, { fresh, venue });
          if (result?.error) return c.json({ error: result.error }, (result.status ?? 500) as any);
          return c.json(result);
        } catch (err: any) {
          return c.json({ error: 'today-picks failed', detail: err?.message ?? String(err) }, 500);
        }
      });

      // POST /admin/api/refresh-race-day-report — manual rebuild trigger (admin only via token gate upstream)
      analyzeRoutes.post('/refresh-race-day-report', async (c) => {
        try {
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const result = await runRaceDayReportCompute(c.env.DB, engine, { fresh: true });
          if (result?.error) return c.json({ error: result.error }, (result.status ?? 500) as any);
          return c.json({ ok: true, date: result.date, venue: result.venue, races: result.races?.length ?? 0, computeMs: result.computeMs, seedSummary: result.seedSummary, predictionLog: result.predictionLog, generatedAt: result.generatedAt });
        } catch (err: any) {
          return c.json({ error: 'refresh failed', detail: err?.message ?? String(err) }, 500);
        }
      });



          // GET /api/analyze/roi?days=60 — actual ROI backtest using captured win odds
          // Strategies (all bet a flat $1 stake on rank-1 of each variant unless noted):
          //   A. ALWAYS:        always bet rank-1
          //   B. SP_3_8:        only bet when actual SP odds in [3, 8] (skip heavy faves + longshots)
          //   C. EV_GT_5:       only bet when (pWin × SP_odds) > 1.05  (positive expected value by model)
          // Returns per-variant × per-strategy: bets, hits, hitRate, avgPayout, totalPnL, roiPct
          analyzeRoutes.get('/roi', async (c) => {
            try {
              const days = Math.max(1, Math.min(365, Number(c.req.query('days') ?? '60')));
              const sinceDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
              const { results } = await c.env.DB.prepare(
                `SELECT variant, date, race_number, p_win, predicted_rank,
                        actual_finish, actual_win_odds, is_hit_top1
                   FROM prediction_log
                   WHERE date >= ? AND actual_finish IS NOT NULL
                     AND predicted_rank = 1`
              ).bind(sinceDate).all<any>().catch(() => ({ results: [] as any[] }));

              const strategies = ['ALWAYS', 'SP_3_8', 'EV_GT_5'] as const;
              const acc: Record<string, Record<string, { bets: number; hits: number; payoutSum: number }>> = {};

              for (const r of (results ?? [])) {
                const v = r.variant ?? 'baseline';
                const odds = r.actual_win_odds == null ? null : Number(r.actual_win_odds);
                const pWin = r.p_win == null ? null : Number(r.p_win);
                const isHit = r.is_hit_top1 ? 1 : 0;
                if (odds == null || odds <= 1) continue;

                const inRange = odds >= 3 && odds <= 8;
                const evPositive = pWin != null && (pWin * odds) > 1.05;

                const filters: Record<string, boolean> = {
                  ALWAYS: true,
                  SP_3_8: inRange,
                  EV_GT_5: evPositive,
                };
                if (!acc[v]) acc[v] = {};
                for (const s of strategies) {
                  if (!filters[s]) continue;
                  if (!acc[v][s]) acc[v][s] = { bets: 0, hits: 0, payoutSum: 0 };
                  acc[v][s].bets++;
                  if (isHit) {
                    acc[v][s].hits++;
                    acc[v][s].payoutSum += odds; // flat $1 stake → return = odds (incl. stake)
                  }
                }
              }

              const summary: any[] = [];
              for (const [variant, byStrat] of Object.entries(acc)) {
                for (const s of strategies) {
                  const row = byStrat[s];
                  if (!row || row.bets === 0) {
                    summary.push({ variant, strategy: s, bets: 0, hits: 0, hitRatePct: null, avgWinPayout: null, totalPnL: null, roiPct: null });
                    continue;
                  }
                  const hitRate = row.hits / row.bets;
                  const totalReturn = row.payoutSum;            // sum of odds when won (stake $1 each)
                  const totalStake = row.bets;                  // 1 per bet
                  const pnl = totalReturn - totalStake;
                  const roiPct = (pnl / totalStake) * 100;
                  const avgWinPayout = row.hits ? row.payoutSum / row.hits : null;
                  summary.push({
                    variant,
                    strategy: s,
                    bets: row.bets,
                    hits: row.hits,
                    hitRatePct: Math.round(hitRate * 1000) / 10,
                    avgWinPayout: avgWinPayout != null ? Math.round(avgWinPayout * 100) / 100 : null,
                    totalPnL: Math.round(pnl * 100) / 100,
                    roiPct: Math.round(roiPct * 100) / 100,
                  });
                }
              }
              summary.sort((x, y) => x.variant.localeCompare(y.variant) || strategies.indexOf(x.strategy as any) - strategies.indexOf(y.strategy as any));

              return c.json({
                sinceDate,
                days,
                note: 'Flat $1 stake on rank-1 pick. ROI%=(totalReturn-totalStake)/totalStake. avgWinPayout includes stake (HK SP convention).',
                strategies: {
                  ALWAYS: 'Bet on every rank-1 pick',
                  SP_3_8: 'Only bet when SP odds in [3, 8]',
                  EV_GT_5: 'Only bet when (pWin × SP_odds) > 1.05',
                },
                summary,
              });
            } catch (e: any) {
              return c.json({ error: String(e?.message ?? e) }, 500);
            }
          });

        // GET /api/analyze/value-picks?date=YYYY-MM-DD&min=3&max=8
        // For each race, returns the R5 rank-1 pick if its latest WIN odds fall in [min, max].
        // Default [3, 8] follows SP_3_8 strategy proven +19% ROI on baseline 60d backtest.
        analyzeRoutes.get('/value-picks', async (c) => {
          try {
            const dateParam = c.req.query('date') ?? null;
            const minOdds = Math.max(1.01, Number(c.req.query('min') ?? '3'));
            const maxOdds = Math.max(minOdds, Number(c.req.query('max') ?? '8'));
            const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
            const report = await runRaceDayReportCompute(c.env.DB, engine, { fresh: false });
            if (report?.error) return c.json({ error: report.error }, (report.status ?? 500) as any);
            const date = dateParam ?? report.date;
            const venue = report.venue;
            if (!date || !venue) return c.json({ error: 'no race day available' }, 404);
            const { results: oddsRows } = await c.env.DB.prepare(
              `SELECT race_number, horse_no, odds, snapshot_at FROM (
                 SELECT race_number, combination AS horse_no, odds, snapshot_at,
                        ROW_NUMBER() OVER (PARTITION BY race_number, combination ORDER BY snapshot_at DESC) AS rn
                   FROM odds_snapshots
                   WHERE race_date = ? AND venue = ? AND pool_type = 'WIN'
               ) WHERE rn = 1`
            ).bind(date, venue).all<any>().catch(() => ({ results: [] as any[] }));
            const oddsMap = new Map<string, { odds: number | null; snapshotAt: string | null }>();
            for (const r of (oddsRows ?? [])) {
              oddsMap.set(`${r.race_number}:${r.horse_no}`, {
                odds: r.odds == null ? null : Number(r.odds),
                snapshotAt: r.snapshot_at ?? null,
              });
            }
            const picks: any[] = [];
            let oddsAvailable = 0;
            let oddsTotal = 0;
            for (const race of (report.races ?? [])) {
              const top = (race.picks ?? []).find((p: any) => p.rank === 1);
              if (!top) continue;
              const o = oddsMap.get(`${race.raceNumber}:${top.horseNumber}`);
              oddsTotal++;
              if (o?.odds != null) oddsAvailable++;
              const inRange = o?.odds != null && o.odds >= minOdds && o.odds <= maxOdds;
              if (inRange) {
                picks.push({
                  raceNumber: race.raceNumber, raceTitle: race.title,
                  distance: race.distance, going: race.going,
                  horseNumber: top.horseNumber, nameCh: top.nameCh, nameEn: top.nameEn,
                  jockey: top.jockeyCh, trainer: top.trainerCh, draw: top.draw,
                  pWin: top.pWin, pTop3: top.pTop3,
                  eloComposite: top.eloComposite, finalScore: top.finalScore,
                  liveOdds: o!.odds, oddsSnapshotAt: o!.snapshotAt,
                  impliedP: o!.odds ? Math.round((1 / o!.odds) * 1000) / 1000 : null,
                  modelEdgePp: (top.pWin != null && o!.odds) ? Math.round((top.pWin - 1 / o!.odds) * 1000) / 10 : null,
                });
              }
            }
            return c.json({
              date, venue, oddsRange: { min: minOdds, max: maxOdds },
              note: 'Filter follows SP_3_8 strategy (+19% ROI on baseline 60d). Live odds = latest WIN snapshot. Production SP may differ.',
              races: report.races?.length ?? 0, oddsAvailable, oddsTotal,
              valuePicks: picks, generatedAt: new Date().toISOString(),
            });
          } catch (err: any) {
            return c.json({ error: 'value-picks failed', detail: err?.message ?? String(err) }, 500);
          }
        });






      // GET /api/analyze/backtest-dates?days=90 — list dates with race_results in window
      analyzeRoutes.get('/backtest-dates', async (c) => {
        try {
          const days = Math.max(1, Math.min(365, Number(c.req.query('days') ?? '90')));
          const since = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
          // No upper-date bound: EXISTS(race_results.finishing_position>0) already limits to
          // settled (past) meetings, so today's results appear as soon as they are in D1.
          // (Previously the strict upper bound used a UTC-derived 'today', which hid the
          // current race day until the UTC date rolled over ~08:00 HKT the next morning.)
          const { results } = await c.env.DB.prepare(
            `SELECT DISTINCT m.date FROM race_meetings m
               WHERE m.date >= ?
                 AND m.venue IN ('ST','HV')
                 AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
               ORDER BY m.date ASC`
          ).bind(since).all<{ date: string }>();
          return c.json({ ok: true, days, dates: (results ?? []).map(r => r.date) });
        } catch (err: any) {
          return c.json({ error: 'list failed', detail: err?.message ?? String(err) }, 500);
        }
      });


      // POST /api/analyze/join-prediction-results?date=YYYY-MM-DD — backfill actuals into prediction_log
      analyzeRoutes.post('/join-prediction-results', async (c) => {
        try {
          const date = c.req.query('date');
          if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date=YYYY-MM-DD required' }, 400);
          const r = await joinPredictionResults(c.env.DB, date);
          return c.json({ ok: true, date, ...r });
        } catch (err: any) {
          return c.json({ error: 'join failed', detail: err?.message ?? String(err) }, 500);
        }
      });
    

      // GET /api/analyze/picks-by-date?date=YYYY-MM-DD — 指定賽事日全因子預測（支援未來/過去日期）
      analyzeRoutes.get('/picks-by-date', async (c) => {
        try {
          const db = c.env.DB;
          const date = c.req.query('date');
          if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '請提供 YYYY-MM-DD 格式日期' }, 400);
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const meeting = await db.prepare(`SELECT m.* FROM race_meetings m WHERE m.date = ? AND m.venue IN ('ST','HV') ORDER BY (SELECT COUNT(*) FROM races r WHERE r.meeting_id = m.id) DESC, m.id LIMIT 1`).bind(date).first<any>().catch(() => null);
          if (!meeting) return c.json({ error: `${date} 賽馬日記錄不存在` }, 404);
          // Try entries_upcoming first (works for upcoming dates)
          const { results: euRows } = await db.prepare(
            `SELECT e.race_number, e.horse_number, e.horse_id, e.horse_code,
                    e.draw, e.declared_weight, e.actual_weight, e.jockey_name, e.jockey_id,
                    e.trainer_name, e.trainer_id, e.rating, e.priority_order,
                    e.distance, e.track, e.course, e.race_class,
                    h.name_ch, h.name_en
             FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id
             WHERE e.race_date = ? AND e.venue IN ('ST','HV') AND e.race_number > 0
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
               WHERE rm.date = ? AND rm.venue IN ('ST','HV')
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
            // P3-C: ?alpha=0.62 lets offline tuner sweep candidates without
            // mutating production α. When provided, bypass cache (read+write)
            // so each α gets a fresh per-race blend.
            const alphaRaw = c.req.query('alpha');
            const alphaOverride = alphaRaw != null && alphaRaw !== ''
              ? Number(alphaRaw) : undefined;
            const hasAlpha = typeof alphaOverride === 'number'
              && Number.isFinite(alphaOverride) && alphaOverride >= 0 && alphaOverride <= 1;

            if (!refresh) {
              if (hasAlpha) {
                const cachedA = await readHitRateAlphaCache(c.env.DB, date, engine, alphaOverride as number);
                if (cachedA) {
                  return c.json({
                    date,
                    venue: cachedA.meeting?.venue,
                    trackCondition: cachedA.meeting?.track_condition,
                    engine,
                    alphaUsed: alphaOverride,
                    summary: cachedA.summary,
                    races: cachedA.races,
                    generatedAt: cachedA.cachedAt,
                    fromCache: true,
                  });
                }
              } else {
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
            }

            await ensureHitRateCacheTable(c.env.DB).catch(() => {});
            if (hasAlpha) await ensureHitRateAlphaCacheTable(c.env.DB).catch(() => {});
            const result = await computeHitRateStats(c.env.DB, date, engine, hasAlpha ? alphaOverride : undefined);
            if ('error' in result) return c.json({ error: result.error }, result.status as any);
            if (hasAlpha) {
              await writeHitRateAlphaCache(c.env.DB, date, engine, alphaOverride as number, result).catch(() => {});
            } else {
              await writeHitRateCache(c.env.DB, date, engine, result).catch(() => {});
            }
            return c.json({
              date,
              venue: result.meeting.venue,
              trackCondition: result.meeting.track_condition,
              engine,
              alphaUsed: hasAlpha ? alphaOverride : undefined,
              summary: result.summary,
              races: result.races,
              generatedAt: new Date().toISOString(),
              fromCache: false,
            });
          } catch (err: any) {
            return c.json({ error: 'hit-rate failed', detail: err?.message ?? String(err) }, 500);
          }
        });

        // POST /api/analyze/ensemble-alpha {alpha}
        // P3-C: admin-gated endpoint for offline α tuner to apply a chosen α
        // after running the sweep outside CF Worker wall-time. Separates write
        // from the heavy compute path.
        analyzeRoutes.post('/ensemble-alpha', async (c) => {
          try {
            const expected = (c.env as any).ADMIN_TOKEN as string | undefined;
            const header = c.req.header('authorization') || '';
            const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
            const queryTok = c.req.query('token') || '';
            const ok = !!expected && (bearer === expected || queryTok === expected);
            if (!ok) return c.json({ error: 'unauthorized' }, 401);

            const body = await c.req.json().catch(() => ({} as any));
            const alpha = Number((body as any)?.alpha);
            if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
              return c.json({ error: 'alpha must be a number in [0,1]' }, 400);
            }
            await c.env.DB.prepare(
              `INSERT INTO app_settings (key, value, updated_at) VALUES ('ensemble_alpha', ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind(String(alpha)).run();
            const currentAlpha = await getEnsembleAlpha(c.env.DB);
            return c.json({ applied: true, alpha, currentAlpha, appliedAt: new Date().toISOString() });
          } catch (err: any) {
            return c.json({ error: 'ensemble-alpha failed', detail: err?.message ?? String(err) }, 500);
          }
        });

        // GET /api/analyze/d1-inspect?table=horse_elo_snapshots&horseId=horse_K152&limit=5
        // P4-debug: admin-gated read-only D1 sample for diagnosing query
        // mismatches (e.g. /top-picks returning null while leaderboard works).
        // Whitelisted tables only; no arbitrary SQL.
        analyzeRoutes.get('/d1-inspect', async (c) => {
          try {
            const expected = (c.env as any).ADMIN_TOKEN as string | undefined;
            const header = c.req.header('authorization') || '';
            const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
            const queryTok = c.req.query('token') || '';
            const ok = !!expected && (bearer === expected || queryTok === expected);
            if (!ok) return c.json({ error: 'unauthorized' }, 401);

            const ALLOWED: Record<string, { entityCol?: string; dateCol?: string }> = {
              horse_elo_snapshots:   { entityCol: 'horse_id',   dateCol: 'as_of_date' },
              jockey_elo_snapshots:  { entityCol: 'jockey_id',  dateCol: 'as_of_date' },
              trainer_elo_snapshots: { entityCol: 'trainer_id', dateCol: 'as_of_date' },
              race_meetings:         { dateCol: 'date' },
              races:                 {},
              app_settings:          {},
              lgb_predictions:       { dateCol: 'race_date' },
            };
            const table = c.req.query('table') || '';
            const spec = ALLOWED[table];
            if (!spec) {
              return c.json({ error: 'table not whitelisted', allowed: Object.keys(ALLOWED) }, 400);
            }
            const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '5', 10) || 5, 1), 50);

            const wheres: string[] = [];
            const binds: any[] = [];
            const entityId = c.req.query('entityId') || c.req.query('horseId') || c.req.query('jockeyId') || c.req.query('trainerId');
            if (entityId && spec.entityCol) {
              wheres.push(`${spec.entityCol} = ?`); binds.push(entityId);
            }
            const since = c.req.query('since');
            if (since && spec.dateCol) { wheres.push(`${spec.dateCol} >= ?`); binds.push(since); }
            const until = c.req.query('until');
            if (until && spec.dateCol) { wheres.push(`${spec.dateCol} <= ?`); binds.push(until); }
            const idLike = c.req.query('idLike');
            if (idLike) { wheres.push(`id LIKE ?`); binds.push(idLike); }
            const axisKey = c.req.query('axisKey');
            if (axisKey) { wheres.push(`axis_key = ?`); binds.push(axisKey); }

            const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
            const orderSql = spec.dateCol ? `ORDER BY ${spec.dateCol} DESC` : '';

            const { results: schema } = await c.env.DB.prepare(
              `SELECT name, type, [notnull] AS not_null, dflt_value FROM pragma_table_info(?)`
            ).bind(table).all<any>();

            const { results: rows } = await c.env.DB.prepare(
              `SELECT * FROM ${table} ${whereSql} ${orderSql} LIMIT ?`
            ).bind(...binds, limit).all<any>();

            const facts: any = { rowCount: rows?.length ?? 0 };
            if (spec.dateCol) {
              const { results: dr } = await c.env.DB.prepare(
                `SELECT MIN(${spec.dateCol}) AS minDate, MAX(${spec.dateCol}) AS maxDate, COUNT(*) AS total FROM ${table} ${whereSql}`
              ).bind(...binds).all<any>();
              facts.dateRange = dr?.[0] ?? null;
            }
            const colNames = new Set((schema ?? []).map((r: any) => r.name));
            if (colNames.has('axis_key')) {
              const { results: ak } = await c.env.DB.prepare(
                `SELECT axis_key, COUNT(*) AS n FROM ${table} ${whereSql} GROUP BY axis_key ORDER BY n DESC LIMIT 10`
              ).bind(...binds).all<any>();
              facts.axisKeyDistribution = ak;
            }
            if (colNames.has('id')) {
              const { results: ip } = await c.env.DB.prepare(
                `SELECT SUBSTR(id, 1, 8) AS idPrefix, COUNT(*) AS n FROM ${table} ${whereSql} GROUP BY idPrefix ORDER BY n DESC LIMIT 10`
              ).bind(...binds).all<any>();
              facts.idPrefixDistribution = ip;
            }

            return c.json({ table, filters: { entityId, since, until, idLike, axisKey, limit }, schema, facts, rows });
          } catch (err: any) {
            return c.json({ error: 'd1-inspect failed', detail: err?.message ?? String(err) }, 500);
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
            "WHERE rm.date >= ? AND rm.date < ? AND rm.venue IN ('ST','HV') AND rr.finishing_position IS NOT NULL " +
            "ORDER BY rm.date DESC"
          ).bind(cutoff, today).all<any>().catch(() => ({ results: [] as any[] }));
          const meetingDates: any[] = (datesQ.results as any[]) || [];
                  let totalRaces = 0, totalTop1Hits = 0, totalTop3AnyHits = 0, totalTop3Intersect = 0;
            let totalQuinella = 0, totalQp = 0, totalTrio = 0, totalTierce = 0;
            let totalFirst4 = 0, totalFirst4Eligible = 0;
            let totalTop4Intersect = 0, totalTop4Eligible = 0;
            const perMeeting: any[] = [];
            const errors: any[] = [];
            for (const m of meetingDates) {
              try {
                // Cache-first: avoid Worker timeout when iterating many meetings.
                // Falls back to live compute (and back-fills cache) when row missing
                // or has stale Stage-4a shape (no quinellaHits field).
                let r: any = await readHitRateCache(db, m.date, engine);
                if (!r?.summary || r.summary.quinellaHits === undefined || r.summary.top4SumIntersect === undefined) {
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
                totalTop4Intersect += s.top4SumIntersect ?? 0;
                totalTop4Eligible += s.top4Eligible ?? 0;
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
              top4AvgIntersect: totalTop4Eligible ? Math.round(totalTop4Intersect / totalTop4Eligible * 100) / 100 : null,
              top4Eligible: totalTop4Eligible,
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

      // GET /api/analyze/ensemble-tune?days=30&apply=0
      // P4: TX-Oracle v3 α grid search. Runs computeHitRateStats for α ∈
      // {0.40, 0.50, 0.62, 0.75, 0.85} over last N days of meetings with
      // results, aggregates top-1 / top-4 intersect, picks winner.
      // ?apply=1 writes winner α into app_settings (key='ensemble_alpha').
      analyzeRoutes.get('/ensemble-tune', async (c) => {
        try {
          const db = c.env.DB;
          const days = Math.max(7, Math.min(180, parseInt(c.req.query('days') || '30', 10) || 30));
          const apply = c.req.query('apply') === '1';
          const engine: EloEngine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
          const today = new Date().toISOString().substring(0, 10);
          const cutoff = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
          const datesQ = await db.prepare(
            "SELECT DISTINCT rm.date AS date FROM race_meetings rm " +
            "JOIN races r ON r.meeting_id = rm.id JOIN race_results rr ON rr.race_id = r.id " +
            "WHERE rm.date >= ? AND rm.date < ? AND rm.venue IN ('ST','HV') AND rr.finishing_position IS NOT NULL " +
            "ORDER BY rm.date DESC"
          ).bind(cutoff, today).all<any>().catch(() => ({ results: [] as any[] }));
          const dates: string[] = ((datesQ.results as any[]) || []).map((m: any) => m.date as string);
          const alphas = [0.40, 0.50, 0.62, 0.75, 0.85];
          const perAlpha: Record<string, any> = {};
          for (const a of alphas) {
            let races = 0, top1 = 0, top4Int = 0, top4Elig = 0;
            for (const d of dates) {
              try {
                const r = await computeHitRateStats(db, d, engine, a);
                if ('error' in r) continue;
                const s = r.summary;
                if (!s.racesEvaluated) continue;
                races += s.racesEvaluated;
                top1 += s.top1Hits || 0;
                top4Int += s.top4SumIntersect || 0;
                top4Elig += s.top4Eligible || 0;
              } catch { /* skip */ }
            }
            perAlpha[a.toFixed(2)] = {
              alpha: a,
              races,
              top1Hits: top1,
              top1HitRate: races ? Math.round(top1 / races * 1000) / 10 : null,
              top4SumIntersect: top4Int,
              top4Eligible: top4Elig,
              top4AvgIntersect: top4Elig ? Math.round(top4Int / top4Elig * 100) / 100 : null,
            };
          }
          // Pick winner: rank by (top1 hit rate * 0.6 + top4 avg intersect * 0.4)
          let winner: { alpha: number; score: number } | null = null;
          for (const k of Object.keys(perAlpha)) {
            const r = perAlpha[k];
            const t1 = (r.top1HitRate || 0) / 100;
            const t4 = (r.top4AvgIntersect || 0) / 4;
            const score = t1 * 0.6 + t4 * 0.4;
            r.compositeScore = Math.round(score * 1000) / 1000;
            if (!winner || score > winner.score) winner = { alpha: r.alpha, score };
          }
          let applied = false;
          let applyDenied = false;
          if (apply && winner) {
            // P1 fix: gate write behind ADMIN_TOKEN (Bearer header or ?token=).
            // Route is mounted under public /api/analyze, so the apply path
            // would otherwise allow unauthenticated model-parameter mutation.
            const expected = (c.env as any).ADMIN_TOKEN as string | undefined;
            const header = c.req.header('authorization') || '';
            const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
            const queryTok = c.req.query('token') || '';
            const ok = !!expected && (bearer === expected || queryTok === expected);
            if (!ok) {
              applyDenied = true;
            } else {
              await db.prepare(
                `INSERT INTO app_settings (key, value, updated_at) VALUES ('ensemble_alpha', ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
              ).bind(String(winner.alpha)).run().catch(() => {});
              applied = true;
            }
          }
          const currentAlpha = await getEnsembleAlpha(db);
          return c.json({
            windowDays: days, from: cutoff, to: today,
            meetingsEvaluated: dates.length,
            alphas, perAlpha,
            winner: winner ? { alpha: winner.alpha, compositeScore: Math.round(winner.score * 1000) / 1000 } : null,
            currentAlpha,
            applied,
            applyDenied,
            generatedAt: new Date().toISOString(),
          });
        } catch (err: any) {
          return c.json({ error: 'ensemble-tune failed', detail: err?.message ?? String(err) }, 500);
        }
      });
  


