import { Hono } from 'hono';
import type { Env } from '../types';

export const jockeysRoutes = new Hono<{ Bindings: Env }>();

// GET /api/jockeys — 騎師列表
jockeysRoutes.get('/', async (c) => {
  const active = c.req.query('active');

  let sql = 'SELECT * FROM v_jockey_stats';
  const params: unknown[] = [];

  if (active === '1') {
    sql = `SELECT vs.* FROM v_jockey_stats vs
           JOIN jockeys j ON j.id = vs.id
           WHERE j.is_active = 1`;
  }

  sql += ' ORDER BY wins DESC';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({
    jockeys: (results ?? []).map((j: any) => ({
      id: j.id,
      nameEn: j.name_en,
      nameCh: j.name_ch,
      totalRides: j.total_rides,
      wins: j.wins,
      top3: j.top3,
      winRate: j.win_rate,
      top3Rate: j.top3_rate,
    })),
  });
});

// GET /api/jockeys/:id/stats — 騎師統計（含場地/途程分析）
jockeysRoutes.get('/:id/stats', async (c) => {
  const id = c.req.param('id');
  const season = c.req.query('season'); // e.g. '2025-2026'

  const jockey = await c.env.DB.prepare(
    'SELECT * FROM jockeys WHERE id = ?'
  ).bind(id).first();

  if (!jockey) {
    return c.json({ error: '找不到該騎師' }, 404);
  }

  // 整體統計
  const overall = await c.env.DB.prepare(
    'SELECT * FROM v_jockey_stats WHERE id = ?'
  ).bind(id).first<any>();

  // 按場地統計
  const { results: byVenue } = await c.env.DB.prepare(`
    SELECT
      rm.venue,
      COUNT(rr.id) AS rides,
      SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(CAST(SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS win_rate
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rr.jockey_id = ?
    GROUP BY rm.venue
  `).bind(id).all();

  // 按途程統計
  const { results: byDistance } = await c.env.DB.prepare(`
    SELECT
      r.distance,
      COUNT(rr.id) AS rides,
      SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(CAST(SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS win_rate
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    WHERE rr.jockey_id = ?
    GROUP BY r.distance
    ORDER BY r.distance
  `).bind(id).all();

  // 近 30 場表現
  const { results: recentForm } = await c.env.DB.prepare(`
    SELECT
      rm.date, r.race_number, r.distance,
      rr.finishing_position, h.name_ch AS horse_name
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    JOIN horses h ON h.id = rr.horse_id
    WHERE rr.jockey_id = ?
    ORDER BY rm.date DESC
    LIMIT 30
  `).bind(id).all();

  return c.json({
    jockey: {
      id: jockey.id,
      nameEn: jockey.name_en,
      nameCh: jockey.name_ch,
      nationality: jockey.nationality,
      licenceType: jockey.licence_type,
    },
    overall: overall ? {
      totalRides: overall.total_rides,
      wins: overall.wins,
      top3: overall.top3,
      winRate: overall.win_rate,
      top3Rate: overall.top3_rate,
    } : null,
    byVenue: (byVenue ?? []).map((v: any) => ({
      venue: v.venue,
      venueName: v.venue === 'ST' ? '沙田' : '跑馬地',
      rides: v.rides,
      wins: v.wins,
      winRate: v.win_rate,
    })),
    byDistance: (byDistance ?? []).map((d: any) => ({
      distance: d.distance,
      rides: d.rides,
      wins: d.wins,
      winRate: d.win_rate,
    })),
    recentForm: (recentForm ?? []).map((f: any) => ({
      date: f.date,
      raceNumber: f.race_number,
      distance: f.distance,
      position: f.finishing_position,
      horseName: f.horse_name,
    })),
  });
});
