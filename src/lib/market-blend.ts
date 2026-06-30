// Market-blend helpers — an ADDITIVE market reference. Does NOT change the model
  // ranking (finalScore / rank / pWin are left untouched); it only fills the
  // separate "市場穩陣" column beside the unchanged "模型搏冷" picks.
  //
  // Extracted from analyze.ts so the LIVE predictor path and the replay test share
  // ONE copy. The zero-pad bug that silently broke the 市場穩陣 column slipped through
  // because an offline backtest fed attachMarketBlend an odds map keyed DIFFERENTLY
  // from how live odds_snapshots rows are actually stored (test/prod divergence).
  // Single source of truth + scripts/test-market-blend.ts now guard that bug class.
  //
  // Backtest verdict (2026-06, 520 races, 4 disjoint splits): LOG-blending the market
  // win-prob into model pWin lifts top1 20→32% — but it leans FAVOURITE (high
  // hit-rate); it does NOT catch 冷馬. β from that sweep.
  export const MARKET_BLEND_BETA = 0.4;

  // Overlay / 值博 flag threshold. A runner is flagged value:'overlay' when the
  // model's (renormalized) win prob exceeds the market-implied win prob by at
  // least this many absolute probability points — i.e. the model rates it higher
  // than the market does (model≠market DIVERGENCE, the only open edge lever). It
  // is ADDITIVE only and NEVER touches model rank/pWin/finalScore. 3pp ≈ a
  // meaningful gap over a typical 8-14 horse field without flooding every race.
  export const VALUE_EDGE_MIN = 0.03;

  // odds_snapshots.combination is zero-padded ("01".."12") from the HKJC combString
  // while picks carry an unpadded numeric horseNumber. BOTH the odds-map side AND the
  // pick side MUST be normalized through THIS one function so a padded "01" matches an
  // unpadded 1. Never inline String(Number(...)) at the call sites again — that drift
  // is exactly what the replay test exists to catch.
  export function normHorseKey(combo: unknown): string {
    return String(Number(combo));
  }

  // Latest WIN-pool odds snapshot per race for a meeting. Odds firm up race-day;
  // empty before then → market column shows "等臨場盤口".
  export async function fetchLatestWinOddsByRace(
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
      perHorse.get(rn)!.set(normHorseKey(row.combination), { odds: o, at: String(row.snapshot_at) });
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
  export function attachMarketBlend(
    picks: any[], oddsByHorseNo: Map<string, number> | null
  ): { marketReady: boolean } {
    if (!oddsByHorseNo || oddsByHorseNo.size === 0) return { marketReady: false };
    const withOdds = picks.filter(
      (p) => p.pWin != null && oddsByHorseNo.has(normHorseKey(p.horseNumber))
    );
    if (withOdds.length < 2) return { marketReady: false };
    // Coverage guard: require odds for the BULK of the field before showing the
    // market column. Renormalizing 1/odds over only a few runners inflates their
    // implied prob (e.g. 3/12 covered → those 3 split 100%) and produces a
    // misleading 市場排名. NOT 100% on purpose: late scratches (SCR) and unbet
    // extreme-longshots legitimately lack live odds, so a full-field requirement
    // would almost never trigger even at post time. 80% keeps the renorm base ≈
    // the whole market while tolerating ~1-2 missing on a typical 12-14 horse card.
    const MARKET_COVER_MIN = 0.8;
    if (withOdds.length < Math.ceil(picks.length * MARKET_COVER_MIN)) {
      return { marketReady: false };
    }
    // Explicitly null market fields on ALL picks first so non-covered runners
    // (scratched / no odds) are unambiguous for downstream consumers.
    for (const p of picks) {
      p.liveWinOdds = null; p.marketProb = null; p.blendProb = null; p.marketRank = null;
      p.valueEdge = null; p.value = null;
    }
    const invSum = withOdds.reduce(
      (a, p) => a + 1 / oddsByHorseNo.get(normHorseKey(p.horseNumber))!, 0
    );
    const modelSum = withOdds.reduce((a, p) => a + p.pWin, 0) || 1;
    const eps = 1e-9;
    const scored = withOdds.map((p) => {
      const o = oddsByHorseNo.get(normHorseKey(p.horseNumber))!;
      const mktP = 1 / o / invSum;
      const modelP = p.pWin / modelSum;
      const blendScore =
        (1 - MARKET_BLEND_BETA) * Math.log(modelP + eps) +
        MARKET_BLEND_BETA * Math.log(mktP + eps);
      return { p, o, mktP, modelP, blendScore };
    });
    const mx = Math.max(...scored.map((s) => s.blendScore));
    const exps = scored.map((s) => Math.exp(s.blendScore - mx));
    const Z = exps.reduce((a, b) => a + b, 0) || 1;
    scored.forEach((s, i) => {
      s.p.liveWinOdds = Math.round(s.o * 10) / 10;
      s.p.marketProb = Math.round(s.mktP * 1000) / 1000;
      s.p.blendProb = Math.round((exps[i] / Z) * 1000) / 1000;
      // ADDITIVE overlay/值博 signal: model win-prob minus market-implied win-prob
      // (both renormalized over the SAME covered set → directly comparable). A
      // positive edge ≥ VALUE_EDGE_MIN means the model rates this runner higher
      // than the market does. Does NOT move model rank/pWin/finalScore.
      const _edge = s.modelP - s.mktP;
      s.p.valueEdge = Math.round(_edge * 1000) / 1000;
      s.p.value = _edge >= VALUE_EDGE_MIN ? 'overlay' : null;
    });
    [...scored]
      .sort((a, b) => b.blendScore - a.blendScore)
      .forEach((s, i) => { s.p.marketRank = i + 1; });
    return { marketReady: true };
  }
  