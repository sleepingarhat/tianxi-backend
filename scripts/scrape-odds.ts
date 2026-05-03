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
   * hkjc-api v1.0.5 response shapes (confirmed from library source):
   *   getAllRaces()   → RaceMeeting[]  (array, NOT a single object)
   *   getRaceOdds()  → pmPool[]       each: { oddsType, oddsNodes: [{combString, oddsValue}] }
   *   getRacePools() → poolInv[]      each: { oddsType, investment }
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
   * Flatten a single pmPool object (from getRaceOdds response) into
   * { combination, odds }[] rows for one pool type.
   *
   * hkjc-api pmPool shape:
   *   { oddsType: 'WIN', oddsNodes: [{ combString, oddsValue, ... }], ... }
   */
  function flattenOddsPayload(_pool: string, pmPool: any): Array<{ combination: string; odds: number | null }> {
    if (!pmPool) return [];
    // Primary: oddsNodes (confirmed from horseOddsQuery GraphQL fragment)
    const nodes: any[] = pmPool.oddsNodes ?? pmPool.oddsEntries ?? pmPool.entries ?? pmPool.runners ?? [];
    if (!Array.isArray(nodes) || !nodes.length) return [];
    return nodes.map((e) => {
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

  function flattenPoolTotal(poolInv: any): number | null {
    if (!poolInv) return null;
    // poolInv from getRacePools: { oddsType, investment, ... }
    const raw = poolInv.investment ?? poolInv.totalInvestment ?? poolInv.poolTotal ?? poolInv.total ?? null;
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

    // getAllRaces() returns RaceMeeting[] (array), not a single object.
    // Use the first meeting as the current/active meeting.
    const meetings: any[] = await api.getAllRaces().catch(() => null as any);
    if (!meetings) {
      console.error('[odds] getAllRaces threw — network or API error');
      process.exit(1);
    }
    if (!Array.isArray(meetings) || !meetings.length) {
      console.error('[odds] getAllRaces returned empty array — no active meeting');
      process.exit(0);
    }

    // Prefer a meeting that matches --date/--venue filters; else take first
    let meeting: any = meetings[0];
    if (dateFilter || venueFilter) {
      const matched = meetings.find((m: any) => {
        const dOk = !dateFilter || (m.date ?? '') === dateFilter;
        const vOk = !venueFilter || (m.venueCode ?? '').toUpperCase() === venueFilter;
        return dOk && vOk;
      });
      if (!matched) {
        const available = meetings.map((m: any) => `${m.date}@${m.venueCode}`).join(', ');
        console.error(`[odds] no meeting matches date=${dateFilter} venue=${venueFilter}. Available: ${available}`);
        process.exit(0);
      }
      meeting = matched;
    }

    const meetingDate: string = meeting.date ?? meeting.raceDate ?? '';
    const venueCode: string = (meeting.venueCode ?? meeting.venue ?? '').toUpperCase();
    // Race.no is the race sequence number (string "1"–"10")
    const races: any[] = meeting.races ?? meeting.raceList ?? [];

    if (!meetingDate || !venueCode) {
      console.error('[odds] meeting missing date or venueCode:', JSON.stringify(meeting).substring(0, 200));
      process.exit(0);
    }
    if (!races.length) {
      console.error(`[odds] no races in meeting ${meetingDate}@${venueCode}; nothing to snapshot`);
      process.exit(0);
    }

    console.error(`[odds] meeting ${meetingDate}@${venueCode} · ${races.length} races · pools: ${wantPools.join(',')}`);

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const insertOdds = db.prepare(
      `INSERT OR IGNORE INTO odds_snapshots
         (id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit)
       VALUES (@id, @race_date, @venue, @race_number, @pool_type, @combination, @odds, @snapshot_at, @source_commit)`,
    );
    const insertPool = db.prepare(
      `INSERT OR IGNORE INTO pool_totals
         (id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit)
       VALUES (@id, @race_date, @venue, @race_number, @pool_type, @total_investment, @snapshot_at, @source_commit)`,
    );

    const snapshotAt = new Date().toISOString();
    let oddsWritten = 0;
    let poolsWritten = 0;

    for (const race of races) {
      // Race.no is a string like "1", "2", ... "10"
      const raceNo: number = Number(race.no ?? race.raceNo ?? race.raceNumber ?? race.number ?? 0);
      if (!raceNo) {
        console.error(`[odds] skipping race with no raceNo: ${JSON.stringify(race).substring(0, 80)}`);
        continue;
      }

      // getRaceOdds() returns pmPool[] where each has: { oddsType, oddsNodes: [{combString, oddsValue}] }
      // Fan out in chunks of 4 to stay within HKJC downstream limit.
      for (let i = 0; i < wantPools.length; i += 4) {
        const chunk = wantPools.slice(i, i + 4);

        const pmPools: any[] = await api.getRaceOdds(raceNo, chunk as any).catch((e: any) => {
          console.error(`[odds] race ${raceNo} getRaceOdds ${chunk.join(',')} failed:`, e?.message ?? e);
          return [];
        });

        if (!Array.isArray(pmPools)) {
          console.error(`[odds] getRaceOdds race ${raceNo} returned non-array:`, JSON.stringify(pmPools).substring(0, 80));
          continue;
        }

        for (const pmPool of pmPools) {
          const pool = (pmPool.oddsType ?? '') as PoolType;
          if (!pool) continue;
          const entries = flattenOddsPayload(pool, pmPool);
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

        // getRacePools() returns poolInv[] where each has: { oddsType, investment, ... }
        const poolInvs: any[] = await api.getRacePools(raceNo, chunk as any).catch(() => []);
        if (!Array.isArray(poolInvs)) continue;
        for (const poolInv of poolInvs) {
          const pool = (poolInv.oddsType ?? '') as PoolType;
          if (!pool) continue;
          const total = flattenPoolTotal(poolInv);
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
  