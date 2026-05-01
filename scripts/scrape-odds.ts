#!/usr/bin/env tsx
/**
 * Odds snapshot scraper — uses hkjc-api GraphQL wrapper to fetch live odds
 * + pool totals for the current race meeting and append rows into local
 * SQLite (bulk-local.db). push-delta --include=odds then ships the new
 * snapshot rows to D1.
 *
 * Usage:
 *   tsx scripts/scrape-odds.ts --db=bulk-local.db \
 *     [--pools=WIN,PLA,QIN,QPL,FCT,TRI,FF] \
 *     [--date=YYYY-MM-DD] [--venue=ST|HV]
 *
 * If --date is omitted the script picks the first active meeting from
 * horseRacingAPI.getActiveMeetings(). Single-run; wire GHA to cron.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore - hkjc-api ships d.ts; no package-json `types` guard needed
import { HorseRacingAPI } from 'hkjc-api';

type PoolType =
  | 'WIN' | 'PLA'
  | 'QIN' | 'QPL'
  | 'FCT' | 'TCE' | 'TRI'
  | 'FF'  | 'QTT'
  | 'DBL' | 'TBL' | 'DT' | 'TT' | 'SixUP'
  | 'CWA' | 'CWB' | 'CWC' | 'IWN';

const DEFAULT_POOLS: PoolType[] = ['WIN', 'PLA', 'QIN', 'QPL', 'FCT', 'TRI'];

function arg(name: string, fallback = ''): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

interface OddsRow {
  id: string;
  race_date: string;
  venue: string;
  race_number: number;
  pool_type: string;
  combination: string;
  odds: number | null;
  snapshot_at: string;
  source_commit: string | null;
}

interface PoolTotalRow {
  id: string;
  race_date: string;
  venue: string;
  race_number: number;
  pool_type: string;
  total_investment: number | null;
  snapshot_at: string;
  source_commit: string | null;
}

/**
 * hkjc-api getRaceOdds returns a heterogeneous shape per pool. Flatten to
 * {combination, odds}[]. Defensive: the library's TS types are loose and
 * HKJC occasionally reshapes payloads during the season.
 */
function flattenOddsPayload(pool: string, payload: any): Array<{ combination: string; odds: number | null }> {
  if (!payload) return [];
  // Shape A: { entries: [{ combString | runners, oddsValue }] }
  const entries: any[] = payload.entries ?? payload.oddsEntries ?? payload.runners ?? [];
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => {
    const combination: string =
      e.combString ??
      e.combinationString ??
      e.combination ??
      (Array.isArray(e.runners) ? e.runners.join('-') : String(e.no ?? e.horseNo ?? e.runner ?? ''));
    const oddsRaw = e.oddsValue ?? e.odds ?? e.win ?? e.place ?? null;
    const odds = oddsRaw == null || oddsRaw === '' || oddsRaw === 'SCR' ? null : Number(oddsRaw);
    return { combination: String(combination), odds: Number.isFinite(odds as number) ? (odds as number) : null };
  }).filter((r) => r.combination);
}

function flattenPoolTotal(payload: any): number | null {
  if (!payload) return null;
  const raw = payload.totalInvestment ?? payload.poolTotal ?? payload.total ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const dbPath = resolve(arg('db', 'bulk-local.db'));
  const wantPools = (arg('pools', DEFAULT_POOLS.join(',')) || DEFAULT_POOLS.join(','))
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) as PoolType[];
  const dateFilter = arg('date', '');
  const venueFilter = arg('venue', '').toUpperCase();
  const sourceCommit = process.env.GITHUB_SHA ?? null;

  const api = new HorseRacingAPI();

  // Discover meetings. If --date/--venue provided, scope; else use active.
  const allRaces: any = await api.getAllRaces().catch(() => null);
  if (!allRaces) {
    console.error('[odds] getAllRaces returned null — aborting');
    process.exit(1);
  }

  // hkjc-api returns { date, venueCode, races: [...] } or similar; tolerate shape drift.
  const meetingDate: string = allRaces.date ?? allRaces.raceDate ?? '';
  const venueCode: string = (allRaces.venueCode ?? allRaces.venue ?? '').toUpperCase();
  const races: any[] = allRaces.races ?? allRaces.raceList ?? [];

  if (dateFilter && meetingDate && meetingDate !== dateFilter) {
    console.error(`[odds] active meeting ${meetingDate} ≠ --date=${dateFilter}, skipping`);
    return;
  }
  if (venueFilter && venueCode && venueCode !== venueFilter) {
    console.error(`[odds] active venue ${venueCode} ≠ --venue=${venueFilter}, skipping`);
    return;
  }
  if (!races.length) {
    console.error('[odds] no races in active meeting; nothing to snapshot');
    return;
  }

  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const insertOdds = db.prepare(
    `INSERT INTO odds_snapshots
       (id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit)
     VALUES (@id, @race_date, @venue, @race_number, @pool_type, @combination, @odds, @snapshot_at, @source_commit)`,
  );
  const insertPool = db.prepare(
    `INSERT INTO pool_totals
       (id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit)
     VALUES (@id, @race_date, @venue, @race_number, @pool_type, @total_investment, @snapshot_at, @source_commit)`,
  );

  const snapshotAt = new Date().toISOString();
  let oddsWritten = 0;
  let poolsWritten = 0;

  for (const race of races) {
    const raceNo: number = race.raceNo ?? race.raceNumber ?? race.number ?? 0;
    if (!raceNo) continue;

    // getRaceOdds accepts up to ~4 pool types per HKJC downstream limit.
    // Fan out in chunks of 4 to cover larger `wantPools` lists.
    for (let i = 0; i < wantPools.length; i += 4) {
      const chunk = wantPools.slice(i, i + 4);
      const oddsResp: any = await api.getRaceOdds(raceNo, chunk as any).catch((e: any) => {
        console.error(`[odds] race ${raceNo} odds ${chunk.join(',')} failed:`, e?.message ?? e);
        return null;
      });
      if (!oddsResp) continue;

      // getRaceOdds returns { pools: { WIN: {...}, PLA: {...}, ... } } or array shape.
      const poolsObj = oddsResp.pools ?? oddsResp;
      for (const pool of chunk) {
        const entries = flattenOddsPayload(pool, poolsObj[pool] ?? poolsObj[pool.toLowerCase()]);
        for (const { combination, odds } of entries) {
          insertOdds.run({
            id: randomUUID(),
            race_date: meetingDate,
            venue: venueCode,
            race_number: raceNo,
            pool_type: pool,
            combination,
            odds,
            snapshot_at: snapshotAt,
            source_commit: sourceCommit,
          });
          oddsWritten++;
        }
      }

      const poolsResp: any = await api.getRacePools(raceNo, chunk as any).catch(() => null);
      if (!poolsResp) continue;
      const totalsObj = poolsResp.pools ?? poolsResp;
      for (const pool of chunk) {
        const total = flattenPoolTotal(totalsObj[pool] ?? totalsObj[pool.toLowerCase()]);
        if (total === null) continue;
        insertPool.run({
          id: randomUUID(),
          race_date: meetingDate,
          venue: venueCode,
          race_number: raceNo,
          pool_type: pool,
          total_investment: total,
          snapshot_at: snapshotAt,
          source_commit: sourceCommit,
        });
        poolsWritten++;
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    meeting: { date: meetingDate, venue: venueCode },
    races: races.length,
    pools: wantPools,
    oddsRowsWritten: oddsWritten,
    poolTotalRowsWritten: poolsWritten,
    snapshotAt,
  }, null, 2));
}

main().catch((e) => {
  console.error('[odds] fatal:', e);
  process.exit(1);
});
