import { Hono } from 'hono';
import type { Env } from '../types';

export const oddsRoutes = new Hono<{ Bindings: Env }>();

// GET /api/odds/:date/:venue/:raceNo — 最新賠率快照（按日期/場地/場次）
// Schema: odds_snapshots(race_date, venue, race_number, pool_type, combination, odds, snapshot_at)
oddsRoutes.get('/:date/:venue/:raceNo', async (c) => {
  const date    = c.req.param('date');    // YYYY-MM-DD
  const venue   = c.req.param('venue').toUpperCase();  // ST | HV
  const raceNo  = Number(c.req.param('raceNo'));

  if (!date || !venue || isNaN(raceNo)) {
    return c.json({ error: 'Invalid params. Use /api/odds/YYYY-MM-DD/ST|HV/1' }, 400);
  }

  // Get the latest snapshot timestamp for this race so we return a coherent set
  const { results: snapRows } = await c.env.DB.prepare(`
    SELECT MAX(snapshot_at) AS latest
    FROM odds_snapshots
    WHERE race_date = ? AND venue = ? AND race_number = ?
  `).bind(date, venue, raceNo).all();

  const latest = (snapRows?.[0] as any)?.latest ?? null;
  if (!latest) {
    return c.json({ error: '暫時冇賠率數據', date, venue, raceNo }, 404);
  }

  // Return all WIN-pool entries from latest snapshot (most useful for display)
  const { results } = await c.env.DB.prepare(`
    SELECT pool_type, combination, odds, snapshot_at
    FROM odds_snapshots
    WHERE race_date = ? AND venue = ? AND race_number = ?
      AND snapshot_at = ?
    ORDER BY pool_type, CAST(combination AS INTEGER)
  `).bind(date, venue, raceNo, latest).all();

  // Also fetch pool totals for same snapshot time (nearest available)
  const { results: poolResults } = await c.env.DB.prepare(`
    SELECT pool_type, total_investment, snapshot_at
    FROM pool_totals
    WHERE race_date = ? AND venue = ? AND race_number = ?
    ORDER BY snapshot_at DESC
    LIMIT 20
  `).bind(date, venue, raceNo).all();

  const poolTotals: Record<string, number | null> = {};
  for (const p of (poolResults ?? [])) {
    const r = p as any;
    if (!poolTotals[r.pool_type]) poolTotals[r.pool_type] = r.total_investment;
  }

  // Group WIN odds by combination (horse number) for easy rendering
  const winOdds: Record<string, number | null> = {};
  const plaOdds: Record<string, number | null> = {};
  for (const row of (results ?? [])) {
    const r = row as any;
    if (r.pool_type === 'WIN') winOdds[r.combination] = r.odds;
    if (r.pool_type === 'PLA') plaOdds[r.combination] = r.odds;
  }

  return c.json({
    date, venue, raceNo,
    live: false,
    snapshotAt: latest,
    winOdds,
    plaOdds,
    poolTotals,
    allEntries: (results ?? []).map((r: any) => ({
      pool: r.pool_type,
      combination: r.combination,
      odds: r.odds,
    })),
  });
});

// GET /api/odds/:date/:venue/:raceNo/history/:pool — 賠率走勢歷史（某彩池）
oddsRoutes.get('/:date/:venue/:raceNo/history/:pool', async (c) => {
  const date   = c.req.param('date');
  const venue  = c.req.param('venue').toUpperCase();
  const raceNo = Number(c.req.param('raceNo'));
  const pool   = c.req.param('pool').toUpperCase();

  const { results } = await c.env.DB.prepare(`
    SELECT combination, odds, snapshot_at
    FROM odds_snapshots
    WHERE race_date = ? AND venue = ? AND race_number = ? AND pool_type = ?
    ORDER BY snapshot_at ASC, CAST(combination AS INTEGER)
  `).bind(date, venue, raceNo, pool).all();

  return c.json({ date, venue, raceNo, pool, history: results ?? [] });
});

// GET /api/odds/:date/:venue/pools — Pool totals for all races on a day
oddsRoutes.get('/:date/:venue/pools', async (c) => {
  const date  = c.req.param('date');
  const venue = c.req.param('venue').toUpperCase();

  const { results } = await c.env.DB.prepare(`
    SELECT race_number, pool_type, total_investment, snapshot_at
    FROM pool_totals
    WHERE race_date = ? AND venue = ?
    ORDER BY race_number, pool_type, snapshot_at DESC
  `).bind(date, venue).all();

  return c.json({ date, venue, pools: results ?? [] });
});
