/**
 * 凍結對帳表 (freeze ledger) — MEASURE ONLY.
 *
 * Approved scope:
 *   • reads ONLY locked `prediction_log` rows (variant=baseline). No backtest,
 *     no live recompute, no α/τ refit, no feature work.
 *   • primary ruler = Top-4 selection (per-race intersect / coverage / mean),
 *     Top-3 as a side note.
 *   • secondary = place hits (top-4 landing in the place slots).
 *   • market columns (win favourite hit, WIN/PLA take-out implied log-loss,
 *     flat-stake simulated EV) are SIDE NOTES ONLY — they exist to show how hard
 *     the market is, never to steer the tree or the version fingerprint.
 *   • no conclusion ("edge / no edge") is drawn here; the caller renders the
 *     table and the sample size next to it.
 */
import { dateIsLocked } from './prediction-lock-db';

export type LedgerRace = {
  raceNumber: number;
  runners: number;
  predictedTop4: number[];
  actualTop4: number[];
  top4Intersect: number | null;
  top3Intersect: number | null;
  top3AnyHit: boolean | null;
  placeSlots: number;
  placeHits: number | null;
  winnerHit: boolean | null;
  modelWinLogloss: number | null;
  marketWinLogloss: number | null;
  marketOverround: number | null;
  favouriteHit: boolean | null;
  flatWinPnl: number | null; // $10 flat on model rank 1, final WIN odds
  plaCoverage: number | null; // fraction of runners with a PLA implied price
};

export type LedgerMeeting = {
  date: string;
  venue: string | null;
  locked: boolean;
  source: 'prediction_log' | 'not-locked' | 'missing-log' | 'no-results';
  racesEvaluated: number;
  top4AvgIntersect: number | null;
  top4CoveragePct: number | null;
  top4FullHits: number;
  top3AvgIntersect: number | null;
  top3AnyHitPct: number | null;
  placeHitPct: number | null;
  winnerHitPct: number | null;
  modelWinLogloss: number | null;
  marketWinLogloss: number | null;
  favouriteHitPct: number | null;
  flatWinRoiPct: number | null;
  races: LedgerRace[];
};

const ln = (x: number) => Math.log(Math.max(x, 1e-12));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

async function loadPlaImplied(
  db: D1Database,
  date: string,
): Promise<Map<string, number>> {
  // Latest PLA snapshot per race/horse. odds_snapshots keeps the newest day,
  // odds_archive keeps sampled history — read both, newest snapshot wins.
  const out = new Map<string, number>();
  const sql = (table: string) =>
    `SELECT race_number, combination, odds, snapshot_at FROM ${table}
      WHERE race_date = ? AND pool_type = 'PLA' AND odds IS NOT NULL AND odds > 0
      ORDER BY snapshot_at ASC`;
  for (const table of ['odds_archive', 'odds_snapshots']) {
    try {
      const res = await db.prepare(sql(table)).bind(date).all<any>();
      for (const r of res?.results ?? []) {
        out.set(`${r.race_number}:${String(r.combination).trim()}`, Number(r.odds));
      }
    } catch { /* table may not exist on this env */ }
  }
  return out;
}

export async function computeFreezeLedgerForDate(
  db: D1Database,
  date: string,
  engine: string = 'v12',
): Promise<LedgerMeeting> {
  const meeting = await db
    .prepare(
      `SELECT m.date AS date, m.venue AS venue FROM race_meetings m
        WHERE m.date = ? AND m.venue IN ('ST','HV')
        ORDER BY (SELECT COUNT(*) FROM races r WHERE r.meeting_id = m.id) DESC, m.id LIMIT 1`,
    )
    .bind(date)
    .first<{ date: string; venue: string }>()
    .catch(() => null);
  const venue = meeting?.venue ?? null;
  const base: LedgerMeeting = {
    date,
    venue,
    locked: false,
    source: 'no-results',
    racesEvaluated: 0,
    top4AvgIntersect: null,
    top4CoveragePct: null,
    top4FullHits: 0,
    top3AvgIntersect: null,
    top3AnyHitPct: null,
    placeHitPct: null,
    winnerHitPct: null,
    modelWinLogloss: null,
    marketWinLogloss: null,
    favouriteHitPct: null,
    flatWinRoiPct: null,
    races: [],
  };

  const locked = await dateIsLocked(db, date, venue);
  base.locked = locked;
  if (!locked) {
    base.source = 'not-locked';
    return base; // 未鎖一律唔入表：呢張表只讀已鎖凍結
  }

  const frozen = await db
    .prepare(
      `SELECT race_number, horse_number, predicted_rank, p_win
         FROM prediction_log
        WHERE date = ? AND engine = ? AND variant = 'baseline' AND predicted_rank IS NOT NULL
        ORDER BY race_number ASC, predicted_rank ASC`,
    )
    .bind(date, engine)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  const frozenByRace = new Map<number, any[]>();
  for (const r of frozen?.results ?? []) {
    if (!frozenByRace.has(r.race_number)) frozenByRace.set(r.race_number, []);
    frozenByRace.get(r.race_number)!.push(r);
  }
  if (!frozenByRace.size) {
    base.source = 'missing-log';
    return base;
  }

  const results = await db
    .prepare(
      `SELECT r.race_number AS race_number, rr.horse_number AS horse_number,
              rr.finishing_position AS pos, rr.win_odds AS win_odds
         FROM race_results rr
         JOIN races r ON r.id = rr.race_id
         JOIN race_meetings rm ON rm.id = r.meeting_id
        WHERE rm.date = ? AND rm.venue IN ('ST','HV')
        ORDER BY r.race_number, rr.finishing_position`,
    )
    .bind(date)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  const resByRace = new Map<number, any[]>();
  for (const r of results?.results ?? []) {
    if (!resByRace.has(r.race_number)) resByRace.set(r.race_number, []);
    resByRace.get(r.race_number)!.push(r);
  }
  if (!resByRace.size) {
    base.source = 'missing-log';
    base.races = [...frozenByRace.keys()].sort((a, b) => a - b).map((rn) => ({
      raceNumber: rn,
      runners: 0,
      predictedTop4: (frozenByRace.get(rn) ?? []).slice(0, 4).map((p) => Number(p.horse_number)),
      actualTop4: [],
      top4Intersect: null,
      top3Intersect: null,
      top3AnyHit: null,
      placeSlots: 0,
      placeHits: null,
      winnerHit: null,
      modelWinLogloss: null,
      marketWinLogloss: null,
      marketOverround: null,
      favouriteHit: null,
      flatWinPnl: null,
      plaCoverage: null,
    }));
    base.source = 'prediction_log';
    return base; // 已鎖但未完場：出殼、指標留空
  }

  const plaImplied = await loadPlaImplied(db, date);
  const races: LedgerRace[] = [];
  for (const rn of [...frozenByRace.keys()].sort((a, b) => a - b)) {
    const picks = frozenByRace.get(rn) ?? [];
    const actual = (resByRace.get(rn) ?? []).filter((r) => Number(r.pos) > 0);
    const predictedTop4 = picks.slice(0, 4).map((p) => Number(p.horse_number));
    const predictedTop3 = predictedTop4.slice(0, 3);
    const finished = actual.slice().sort((a, b) => Number(a.pos) - Number(b.pos));
    const actualTop4 = finished.slice(0, 4).map((r) => Number(r.horse_number));
    const actualTop3 = actualTop4.slice(0, 3);
    const runners = actual.length;
    const placeSlots = runners >= 7 ? 3 : 2;
    const placedSet = new Set(finished.slice(0, placeSlots).map((r) => Number(r.horse_number)));

    if (!runners || predictedTop4.length < 4) {
      races.push({
        raceNumber: rn, runners, predictedTop4, actualTop4,
        top4Intersect: null, top3Intersect: null, top3AnyHit: null,
        placeSlots, placeHits: null, winnerHit: null,
        modelWinLogloss: null, marketWinLogloss: null, marketOverround: null,
        favouriteHit: null, flatWinPnl: null, plaCoverage: null,
      });
      continue;
    }

    const top4Intersect = predictedTop4.filter((h) => actualTop4.includes(h)).length;
    const top3Intersect = predictedTop3.filter((h) => actualTop3.includes(h)).length;
    const placeHits = predictedTop4.filter((h) => placedSet.has(h)).length;
    const winnerNo = Number(finished[0]?.horse_number);
    const winnerHit = predictedTop4[0] === winnerNo;

    // Model WIN log-loss on the frozen p_win, renormalised over the runners
    // that actually started (scratchings must not shift the frozen ranking).
    const pwByHorse = new Map<number, number>();
    for (const p of picks) {
      const v = Number(p.p_win);
      if (Number.isFinite(v) && v > 0) pwByHorse.set(Number(p.horse_number), v);
    }
    let modelWinLogloss: number | null = null;
    const pwSum = actual.reduce((s, r) => s + (pwByHorse.get(Number(r.horse_number)) ?? 0), 0);
    if (pwSum > 0 && pwByHorse.has(winnerNo)) {
      modelWinLogloss = -ln((pwByHorse.get(winnerNo) as number) / pwSum);
    }

    // Market side note: final WIN odds carry the take-out. Report both the raw
    // overround and the renormalised (take-out removed) log-loss.
    let marketWinLogloss: number | null = null;
    let marketOverround: number | null = null;
    let favouriteHit: boolean | null = null;
    let flatWinPnl: number | null = null;
    const oddsByHorse = new Map<number, number>();
    for (const r of actual) {
      const o = Number(r.win_odds);
      if (Number.isFinite(o) && o > 1) oddsByHorse.set(Number(r.horse_number), o);
    }
    if (oddsByHorse.size >= 2) {
      let sum = 0;
      for (const o of oddsByHorse.values()) sum += 1 / o;
      marketOverround = sum;
      const qWinner = oddsByHorse.has(winnerNo) ? (1 / (oddsByHorse.get(winnerNo) as number)) / sum : null;
      if (qWinner != null) marketWinLogloss = -ln(qWinner);
      let favNo: number | null = null;
      let best = Infinity;
      for (const [h, o] of oddsByHorse) if (o < best) { best = o; favNo = h; }
      favouriteHit = favNo != null ? favNo === winnerNo : null;
      const myOdds = oddsByHorse.get(predictedTop4[0]);
      if (myOdds != null) flatWinPnl = winnerHit ? (myOdds - 1) * 10 : -10;
    }
    const plaKnown = actual.filter((r) => plaImplied.has(`${rn}:${String(r.horse_number)}`)).length;

    races.push({
      raceNumber: rn, runners, predictedTop4, actualTop4,
      top4Intersect, top3Intersect, top3AnyHit: top3Intersect > 0,
      placeSlots, placeHits, winnerHit,
      modelWinLogloss: r3(modelWinLogloss), marketWinLogloss: r3(marketWinLogloss),
      marketOverround: r3(marketOverround), favouriteHit,
      flatWinPnl: r3(flatWinPnl),
      plaCoverage: runners ? r3(plaKnown / runners) : null,
    });
  }

  const scored = races.filter((r) => r.top4Intersect != null);
  const bets = races.filter((r) => r.flatWinPnl != null);
  base.source = 'prediction_log';
  base.races = races;
  base.racesEvaluated = scored.length;
  base.top4AvgIntersect = r3(avg(scored.map((r) => r.top4Intersect as number)));
  base.top4CoveragePct = r1(scored.length ? (avg(scored.map((r) => (r.top4Intersect as number) / 4)) as number) * 100 : null);
  base.top4FullHits = scored.filter((r) => r.top4Intersect === 4).length;
  base.top3AvgIntersect = r3(avg(scored.map((r) => r.top3Intersect as number)));
  base.top3AnyHitPct = r1(scored.length ? (scored.filter((r) => r.top3AnyHit).length / scored.length) * 100 : null);
  base.placeHitPct = r1(scored.length ? (avg(scored.map((r) => (r.placeHits as number) / 4)) as number) * 100 : null);
  base.winnerHitPct = r1(scored.length ? (scored.filter((r) => r.winnerHit).length / scored.length) * 100 : null);
  base.modelWinLogloss = r3(avg(races.filter((r) => r.modelWinLogloss != null).map((r) => r.modelWinLogloss as number)));
  base.marketWinLogloss = r3(avg(races.filter((r) => r.marketWinLogloss != null).map((r) => r.marketWinLogloss as number)));
  base.favouriteHitPct = r1(
    races.filter((r) => r.favouriteHit != null).length
      ? (races.filter((r) => r.favouriteHit).length / races.filter((r) => r.favouriteHit != null).length) * 100
      : null,
  );
  base.flatWinRoiPct = r1(bets.length ? (bets.reduce((s, r) => s + (r.flatWinPnl as number), 0) / (bets.length * 10)) * 100 : null);
  return base;
}

export async function computeFreezeLedger(
  db: D1Database,
  opts?: { dates?: string[]; since?: string; engine?: string; limit?: number },
): Promise<{
  engine: string;
  generatedAt: string;
  policy: string;
  meetings: LedgerMeeting[];
  season: {
    meetings: number;
    racesEvaluated: number;
    top4AvgIntersect: number | null;
    top4CoveragePct: number | null;
    top4FullHits: number;
    top3AvgIntersect: number | null;
    top3AnyHitPct: number | null;
    placeHitPct: number | null;
    winnerHitPct: number | null;
    modelWinLogloss: number | null;
    marketWinLogloss: number | null;
    favouriteHitPct: number | null;
    flatWinRoiPct: number | null;
  };
}> {
  const engine = opts?.engine ?? 'v12';
  let dates = opts?.dates?.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ?? [];
  if (!dates.length) {
    const since = opts?.since ?? '2026-09-01';
    const res = await db
      .prepare(
        `SELECT DISTINCT date FROM prediction_log
          WHERE date >= ? AND engine = ? AND variant = 'baseline'
          ORDER BY date ASC LIMIT ?`,
      )
      .bind(since, engine, Math.max(1, Math.min(opts?.limit ?? 40, 200)))
      .all<{ date: string }>()
      .catch(() => ({ results: [] as { date: string }[] }));
    dates = (res?.results ?? []).map((r) => r.date);
  }

  const meetings: LedgerMeeting[] = [];
  for (const d of dates) {
    meetings.push(await computeFreezeLedgerForDate(db, d, engine));
  }
  const graded = meetings.filter((m) => m.racesEvaluated > 0);
  const allRaces = graded.flatMap((m) => m.races).filter((r) => r.top4Intersect != null);
  const bets = graded.flatMap((m) => m.races).filter((r) => r.flatWinPnl != null);
  return {
    engine,
    generatedAt: new Date().toISOString(),
    policy:
      '只讀已鎖 prediction_log（T−1.5h 或賽果入庫後）；禁回測、禁 live 重算。主尺＝四揀（入圍／覆蓋／平均相交），Top3 旁註；副尺＝位置命中；獨贏同市場隱含 logloss／模擬 EV 只旁註，永不回寫模型或指紋。',
    meetings,
    season: {
      meetings: graded.length,
      racesEvaluated: allRaces.length,
      top4AvgIntersect: r3(avg(allRaces.map((r) => r.top4Intersect as number))),
      top4CoveragePct: r1(allRaces.length ? (avg(allRaces.map((r) => (r.top4Intersect as number) / 4)) as number) * 100 : null),
      top4FullHits: allRaces.filter((r) => r.top4Intersect === 4).length,
      top3AvgIntersect: r3(avg(allRaces.map((r) => r.top3Intersect as number))),
      top3AnyHitPct: r1(allRaces.length ? (allRaces.filter((r) => r.top3AnyHit).length / allRaces.length) * 100 : null),
      placeHitPct: r1(allRaces.length ? (avg(allRaces.map((r) => (r.placeHits as number) / 4)) as number) * 100 : null),
      winnerHitPct: r1(allRaces.length ? (allRaces.filter((r) => r.winnerHit).length / allRaces.length) * 100 : null),
      modelWinLogloss: r3(avg(allRaces.filter((r) => r.modelWinLogloss != null).map((r) => r.modelWinLogloss as number))),
      marketWinLogloss: r3(avg(allRaces.filter((r) => r.marketWinLogloss != null).map((r) => r.marketWinLogloss as number))),
      favouriteHitPct: r1(
        allRaces.filter((r) => r.favouriteHit != null).length
          ? (allRaces.filter((r) => r.favouriteHit).length / allRaces.filter((r) => r.favouriteHit != null).length) * 100
          : null,
      ),
      flatWinRoiPct: r1(bets.length ? (bets.reduce((s, r) => s + (r.flatWinPnl as number), 0) / (bets.length * 10)) * 100 : null),
    },
  };
}
