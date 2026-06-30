#!/usr/bin/env tsx
  /**
   * Replay test for the market-blend odds-key contract (regression guard).
   *
   * The 市場穩陣 column once silently broke because an offline backtest fed
   * attachMarketBlend an odds map keyed by a DIFFERENT format than how the LIVE
   * odds_snapshots rows are stored: the scraper writes a ZERO-PADDED combination
   * ("01".."12") while picks carry an UNPADDED numeric horseNumber. This test
   * replays the REAL prod path — real padded DB rows -> fetchLatestWinOddsByRace ->
   * attachMarketBlend — and fails loudly if the two sides ever stop matching.
   *
   * Pure in-memory D1 shim (no better-sqlite3 / no DB file) so it runs anywhere,
   * including CI before deploy. Run: tsx scripts/test-market-blend.ts
   */
  import {
    fetchLatestWinOddsByRace,
    attachMarketBlend,
    normHorseKey,
  } from '../src/lib/market-blend';

  let failures = 0;
  function assert(cond: boolean, msg: string) {
    if (cond) { console.log('  PASS  ' + msg); }
    else { console.error('  FAIL  ' + msg); failures++; }
  }

  type OddsRow = { race_number: number; combination: string; odds: number; snapshot_at: string };

  // REAL stored format: the scraper zero-pads single-digit horse numbers, so a
  // 12-runner WIN pool is stored as combination "01".."12" (two-digit horses
  // "10".."12" pass through unchanged). Plus a stale earlier snapshot for horse 1.
  const WIN_ODDS: OddsRow[] = [
    { race_number: 1, combination: '01', odds: 3.5, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '02', odds: 5.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '03', odds: 8.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '04', odds: 12.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '05', odds: 15.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '06', odds: 21.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '07', odds: 26.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '08', odds: 34.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '09', odds: 41.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '10', odds: 51.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '11', odds: 67.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '12', odds: 99.0, snapshot_at: '2026-06-10T06:00:00Z' },
    { race_number: 1, combination: '01', odds: 9.9, snapshot_at: '2026-06-10T05:00:00Z' },
  ];

  // Minimal D1Database shim: hand back the WIN rows for the analyze query. No real
  // SQL — fetchLatestWinOddsByRace does its own filter (odds>1) / ORDER (ASC) /
  // per-horse dedup / normalize, which is exactly what we want to exercise.
  function makeShim(rows: OddsRow[]): any {
    return {
      prepare(_sql: string) {
        return {
          bind(_date: string, _venue: string) {
            return {
              async all<T = any>(): Promise<{ results: T[] }> {
                const sorted = [...rows].sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at));
                return { results: sorted as unknown as T[] };
              },
            };
          },
        };
      },
    };
  }

  async function main() {
    console.log('[replay] market-blend odds-key contract');

    // 0) normHorseKey is the single normalizer — padded & unpadded collapse.
    assert(normHorseKey('01') === '1', 'normHorseKey("01") -> "1" (padded single digit)');
    assert(normHorseKey('5') === '5', 'normHorseKey("5") -> "5" (unpadded)');
    assert(normHorseKey(7) === '7', 'normHorseKey(7) -> "7" (numeric)');
    assert(normHorseKey('12') === '12', 'normHorseKey("12") -> "12" (two digit)');

    // 1) Real prod path: padded DB rows -> fetchLatestWinOddsByRace.
    const byRace = await fetchLatestWinOddsByRace(makeShim(WIN_ODDS), '2026-06-10', 'ST');
    const r1 = byRace.get(1);
    assert(!!r1, 'race 1 present in odds map');
    assert(!!r1 && r1.odds.size === 12, '12 horses keyed (got ' + (r1 ? r1.odds.size : 0) + ')');
    assert(!!r1 && r1.odds.has('1'), 'padded "01" normalized to key "1"');
    assert(!!r1 && !r1.odds.has('01'), 'raw padded key "01" is NOT present (normalized away)');
    assert(!!r1 && r1.odds.get('1') === 3.5, 'latest snapshot wins for horse 1 (3.5, not stale 9.9)');

    // 2) Picks carry UNPADDED horseNumber (as the live model produces them).
    const live = WIN_ODDS.filter((r) => r.snapshot_at === '2026-06-10T06:00:00Z');
    // picks carry model-side fields (rank / finalScore) that the additive blend must NOT move.
  const picks: any[] = live.map((r, i) => ({ horseNumber: Number(r.combination), pWin: 1 / r.odds, rank: i + 1, finalScore: 1500 - i * 10 }));
    const z = picks.reduce((a, p) => a + p.pWin, 0);
    picks.forEach((p) => (p.pWin = p.pWin / z));
  // snapshot model-side invariant BEFORE the additive blend.
  const modelBefore = JSON.stringify(picks.map((p) => ({ h: p.horseNumber, rank: p.rank, pWin: p.pWin, finalScore: p.finalScore })));

    const res = attachMarketBlend(picks, r1 ? r1.odds : null);
  const modelAfter = JSON.stringify(picks.map((p) => ({ h: p.horseNumber, rank: p.rank, pWin: p.pWin, finalScore: p.finalScore })));
  assert(modelBefore === modelAfter, 'attachMarketBlend leaves model rank/pWin/finalScore UNTOUCHED (additive contract: 模型搏冷 never moves)');
    assert(res.marketReady === true, 'marketReady true (padded odds matched unpadded picks)');
    const covered = picks.filter((p) => p.liveWinOdds != null);
    assert(covered.length === 12, 'all 12 picks got market fields (got ' + covered.length + ')');
    // ADDITIVE overlay/值博 signal — every covered pick gets a numeric valueEdge
    // (modelP - marketProb over the covered set) and a value flag of 'overlay'|null.
    // The model snapshot asserted above must STILL be unchanged (purely additive).
    assert(covered.every((p) => typeof p.valueEdge === 'number'), 'every covered pick has a numeric valueEdge (modelP - marketProb)');
    assert(picks.every((p) => p.value === 'overlay' || p.value === null), 'value flag is "overlay" or null on every pick');
    const _edgeSum = covered.reduce((a, p) => a + p.valueEdge, 0);
    assert(Math.abs(_edgeSum) < 0.02, 'valueEdge ~sums to 0 across covered set (both sides renormalized; got ' + _edgeSum.toFixed(4) + ')');
    assert(picks.every((p) => p.marketRank != null && p.marketRank >= 1 && p.marketRank <= 12),
      'every pick has a marketRank in 1..12');
    const fav = picks.find((p) => p.horseNumber === 1);
    assert(!!fav && fav.marketRank === 1, 'lowest-odds horse (no.1) is market rank #1');
    const h10 = picks.find((p) => p.horseNumber === 10);
    assert(!!h10 && h10.liveWinOdds === 51.0, 'two-digit horse no.10 also matched (odds 51)');

    // 3) REGRESSION GUARD — reproduce the original divergence. An all-single-digit
    // field keyed with RAW padded combos ("01".."08") must NOT silently work:
    // attachMarketBlend normalizes the pick side to "1".."8", so a raw-padded map
    // yields ZERO matches -> marketReady false. The SAME field keyed through
    // normHorseKey matches all 8 -> marketReady true. This is the exact test/prod
    // divergence that hid the bug, now locked down.
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const oddsVals = [2.5, 4, 6, 9, 13, 18, 25, 40];
    const picksRaw = eight.map((n, i) => ({ horseNumber: n, pWin: (1 / oddsVals[i]) }));
    const picksNorm = eight.map((n, i) => ({ horseNumber: n, pWin: (1 / oddsVals[i]) }));

    const rawPadded = new Map<string, number>(eight.map((n, i) => [String(n).padStart(2, '0'), oddsVals[i]]));
    const normalized = new Map<string, number>(eight.map((n, i) => [normHorseKey(n), oddsVals[i]]));

    const resRaw = attachMarketBlend(picksRaw, rawPadded);
    assert(resRaw.marketReady === false,
      'raw-padded odds map (the old backtest format) yields NO single-digit match -> marketReady false');
    const resNorm = attachMarketBlend(picksNorm, normalized);
    assert(resNorm.marketReady === true,
      'same field keyed via normHorseKey -> marketReady true (contract holds)');

    console.log('[replay] ' + (failures === 0 ? 'ALL PASS' : failures + ' ASSERTION(S) FAILED'));
    if (failures > 0) process.exit(1);
  }

  main().catch((e) => { console.error(e); process.exit(1); });
  