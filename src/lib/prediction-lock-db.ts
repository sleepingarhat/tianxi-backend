import { applyFrozenOrder, auditTop4Pairs } from './prediction-lock';

type EloEngine = 'v11' | 'v12';

export async function dateHasSettledResults(
  db: D1Database,
  date: string | null | undefined,
  venue?: string | null,
): Promise<boolean> {
  if (!date) return false;
  const hk = (venue === 'ST' || venue === 'HV') ? venue : null;
  try {
    const row = hk
      ? await db.prepare(
          `SELECT 1 AS x FROM race_meetings m
             JOIN races r ON r.meeting_id = m.id
             JOIN race_results rr ON rr.race_id = r.id
            WHERE m.date = ? AND m.venue = ? AND rr.finishing_position > 0
            LIMIT 1`,
        ).bind(date, hk).first().catch(() => null)
      : await db.prepare(
          `SELECT 1 AS x FROM race_meetings m
             JOIN races r ON r.meeting_id = m.id
             JOIN race_results rr ON rr.race_id = r.id
            WHERE m.date = ? AND m.venue IN ('ST','HV') AND rr.finishing_position > 0
            LIMIT 1`,
        ).bind(date).first().catch(() => null);
    return !!row;
  } catch {
    return false;
  }
}

export async function loadFrozenPicksForDate(
  db: D1Database,
  date: string,
  engine: string,
): Promise<Map<number, any[]>> {
  const byRace = new Map<number, any[]>();
  try {
    const res = await db.prepare(
      `SELECT pl.race_number, pl.horse_id, pl.horse_number, pl.draw, pl.horse_elo,
              pl.elo_composite, pl.factor_bonus, pl.final_score, pl.p_win, pl.p_top3,
              pl.predicted_rank, pl.lgb_score, pl.lgb_model_version, pl.score_source,
              h.name_ch AS name_ch
         FROM prediction_log pl
         LEFT JOIN horses h ON h.id = pl.horse_id
        WHERE pl.date = ? AND pl.engine = ? AND pl.variant = 'baseline'
          AND pl.predicted_rank IS NOT NULL
        ORDER BY pl.race_number ASC, pl.predicted_rank ASC`,
    ).bind(date, engine).all<any>();
    for (const r of res?.results ?? []) {
      if (!byRace.has(r.race_number)) byRace.set(r.race_number, []);
      byRace.get(r.race_number)!.push({
        horseId: r.horse_id,
        horseNumber: r.horse_number,
        draw: r.draw,
        nameCh: r.name_ch ?? null,
        horseElo: r.horse_elo,
        eloComposite: r.elo_composite,
        factorBonus: r.factor_bonus,
        finalScore: r.final_score,
        pWin: r.p_win,
        pTop3: r.p_top3,
        rank: r.predicted_rank,
        lgbScore: r.lgb_score,
        lgbModelVersion: r.lgb_model_version,
        scoreSource: r.score_source,
      });
    }
  } catch {
    return byRace;
  }
  return byRace;
}

export async function freezeTopPicksPayload(
  db: D1Database,
  payload: any,
  engine: string = 'v12',
): Promise<any> {
  if (!payload?.date) return payload;
  if (!(await dateHasSettledResults(db, payload.date, payload.venue))) {
    payload.frozen = false;
    payload.freezeSource = 'live-recompute';
    return payload;
  }
  const frozen = await loadFrozenPicksForDate(db, payload.date, engine);
  const raceNo = Number(payload.raceNumber);
  const fr = frozen.get(raceNo);
  if (!fr || fr.length < 4) {
    payload.frozen = false;
    payload.freezeSource = 'missing-log';
    return payload;
  }
  const merged = applyFrozenOrder(payload.allPicks || payload.picks, fr);
  payload.picks = merged.picks.slice(0, 5);
  payload.allPicks = merged.picks;
  payload.frozen = true;
  payload.freezeSource = 'prediction_log';
  return payload;
}

export async function freezeMeetingPayload(
  db: D1Database,
  payload: any,
  engine: string = 'v12',
): Promise<any> {
  if (!payload?.date || !Array.isArray(payload?.races)) return payload;
  if (!(await dateHasSettledResults(db, payload.date, payload.venue))) {
    payload.frozen = false;
    return payload;
  }
  const frozen = await loadFrozenPicksForDate(db, payload.date, engine);
  let applied = 0;
  for (const r of payload.races) {
    const fr = frozen.get(Number(r.raceNumber));
    if (!fr || fr.length < 4) continue;
    const merged = applyFrozenOrder(r.picks, fr);
    if (!merged.applied) continue;
    r.picks = merged.picks;
    applied++;
  }
  payload.frozen = applied > 0;
  payload.freezeAppliedRaces = applied;
  return payload;
}

export async function auditPredictionLock(
  db: D1Database,
  date: string,
  engine: EloEngine = 'v12',
): Promise<{
  date: string;
  engine: string;
  settled: boolean;
  ok: boolean;
  source: string;
  races: any[];
  mismatches: any[];
}> {
  const settled = await dateHasSettledResults(db, date);
  if (!settled) {
    return { date, engine, settled: false, ok: true, source: 'unsettled', races: [], mismatches: [] };
  }
  const frozen = await loadFrozenPicksForDate(db, date, engine);
  if (!frozen.size) {
    return { date, engine, settled: true, ok: false, source: 'missing-log', races: [], mismatches: [{ reason: 'prediction_log incomplete' }] };
  }
  let compared = new Map<number, any[]>();
  try {
    const row = await db.prepare(
      `SELECT payload_json FROM meeting_hit_rate_cache WHERE date=? AND engine LIKE ?`,
    ).bind(date, `${engine}-%`).first<{ payload_json: string }>();
    if (row?.payload_json) {
      const parsed = JSON.parse(row.payload_json);
      for (const r of parsed.races || []) {
        compared.set(Number(r.raceNumber), r.predictedTop4 || r.picks || []);
      }
    }
  } catch { /* cache miss is not a ranking leak by itself */ }
  const audit = auditTop4Pairs(frozen, compared);
  return {
    date,
    engine,
    settled: true,
    ok: audit.ok,
    source: 'prediction_log-vs-hit-rate',
    races: audit.races,
    mismatches: audit.mismatches,
  };
}
