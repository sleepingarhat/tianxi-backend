import { Hono } from 'hono';
import type { Env } from '../types';

export const oddsRoutes = new Hono<{ Bindings: Env }>();

// GET /api/odds/live/:raceId — 即時賠率（Proxy HKJC GraphQL）
oddsRoutes.get('/live/:raceId', async (c) => {
  const raceId = c.req.param('raceId');

  // 首先嘗試從 HKJC GraphQL API 獲取即時賠率
  // 如果非賽馬日或 API 不可用，返回最新的 DB 快照
  try {
    const liveOdds = await fetchHKJCLiveOdds(raceId);
    if (liveOdds) {
      return c.json(liveOdds);
    }
  } catch {
    // fallback to DB
  }

  // Fallback: 從數據庫獲取最新賠率快照
  const { results } = await c.env.DB.prepare(`
    SELECT os.*, h.name_ch, h.name_en, h.code
    FROM odds_snapshots os
    JOIN horses h ON h.id = os.horse_id
    WHERE os.race_id = ?
    ORDER BY os.timestamp DESC
  `).bind(raceId).all();

  if (!results || results.length === 0) {
    return c.json({ error: '暫時冇賠率數據', live: false }, 404);
  }

  // 按馬匹分組，取最新一條
  const latestByHorse = new Map<string, any>();
  for (const row of results) {
    const r = row as any;
    if (!latestByHorse.has(r.horse_id)) {
      latestByHorse.set(r.horse_id, r);
    }
  }

  return c.json({
    raceId,
    live: false,
    lastUpdated: (results[0] as any).timestamp,
    odds: Array.from(latestByHorse.values()).map((o: any) => ({
      horseId: o.horse_id,
      horseName: o.name_ch || o.name_en,
      horseCode: o.code,
      winOdds: o.win_odds,
      placeOdds: o.place_odds,
      poolInvestment: o.pool_investment,
      type: o.odds_type,
    })),
  });
});

// GET /api/odds/history/:raceId/:horseId — 賠率走勢歷史
oddsRoutes.get('/history/:raceId/:horseId', async (c) => {
  const raceId = c.req.param('raceId');
  const horseId = c.req.param('horseId');

  const { results } = await c.env.DB.prepare(`
    SELECT timestamp, win_odds, place_odds, pool_investment, odds_type
    FROM odds_snapshots
    WHERE race_id = ? AND horse_id = ?
    ORDER BY timestamp ASC
  `).bind(raceId, horseId).all();

  return c.json({
    raceId,
    horseId,
    history: (results ?? []).map((o: any) => ({
      timestamp: o.timestamp,
      winOdds: o.win_odds,
      placeOdds: o.place_odds,
      poolInvestment: o.pool_investment,
      type: o.odds_type,
    })),
  });
});

// POST /api/odds/ingest — 批量導入賠率快照（供 scraper / 用戶本地推送）
// Body: { raceId, snapshots: [{ horseId, winOdds, placeOdds, poolInvestment, oddsType, timestamp }] }
oddsRoutes.post('/ingest', async (c) => {
  const body = await c.req.json<{
    raceId: string;
    snapshots: Array<{
      horseId: string;
      winOdds?: number;
      placeOdds?: number;
      poolInvestment?: number;
      oddsType?: string; // 'opening' | 'closing' | 'snapshot'
      timestamp?: string;
    }>;
  }>();

  if (!body?.raceId || !Array.isArray(body.snapshots) || body.snapshots.length === 0) {
    return c.json({ error: 'raceId + snapshots[] required' }, 400);
  }

  const stmts = body.snapshots.map((s) => {
    const ts = s.timestamp ?? new Date().toISOString();
    const id = `${body.raceId}_${s.horseId}_${ts}`;
    return c.env.DB.prepare(
      `INSERT OR REPLACE INTO odds_snapshots (id, race_id, horse_id, win_odds, place_odds, pool_investment, odds_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      body.raceId,
      s.horseId,
      s.winOdds ?? null,
      s.placeOdds ?? null,
      s.poolInvestment ?? null,
      s.oddsType ?? 'live',
      ts
    );
  });

  try {
    await c.env.DB.batch(stmts);
    return c.json({ ok: true, inserted: body.snapshots.length });
  } catch (err: any) {
    return c.json({ error: 'ingest failed', details: err.message }, 500);
  }
});

// HKJC GraphQL API proxy
// 此函數將在正式接入時完善
async function fetchHKJCLiveOdds(raceId: string): Promise<any | null> {
  // TODO: 接入 HKJC GraphQL API
  // Endpoint: https://info.cld.hkjc.com/graphql/base/
  // Query: racing odds by race number and date
  //
  // 範例 GraphQL query:
  // query {
  //   racing {
  //     meeting(date: "2026-04-16") {
  //       races {
  //         no
  //         runners {
  //           no
  //           winOdds
  //           placeOdds
  //         }
  //       }
  //     }
  //   }
  // }
  return null;
}
