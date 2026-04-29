import { Hono } from 'hono';
import type { Env } from '../types';

export const trainersRoutes = new Hono<{ Bindings: Env }>();

// GET /api/trainers — 練馬師列表
trainersRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM v_trainer_stats ORDER BY wins DESC'
  ).all();

  return c.json({
    trainers: (results ?? []).map((t: any) => ({
      id: t.id,
      nameEn: t.name_en,
      nameCh: t.name_ch,
      totalRunners: t.total_runners,
      wins: t.wins,
      top3: t.top3,
      winRate: t.win_rate,
    })),
  });
});

// GET /api/trainers/:id/stats — 練馬師統計
trainersRoutes.get('/:id/stats', async (c) => {
  const id = c.req.param('id');

  const trainer = await c.env.DB.prepare(
    'SELECT * FROM trainers WHERE id = ?'
  ).bind(id).first();

  if (!trainer) {
    return c.json({ error: '找不到該練馬師' }, 404);
  }

  const overall = await c.env.DB.prepare(
    'SELECT * FROM v_trainer_stats WHERE id = ?'
  ).bind(id).first<any>();

  // 騎練配對統計
  const { results: combos } = await c.env.DB.prepare(
    'SELECT * FROM v_jockey_trainer_combo WHERE trainer_id = ? ORDER BY wins DESC'
  ).bind(id).all();

  // 近 30 場
  const { results: recentForm } = await c.env.DB.prepare(`
    SELECT
      rm.date, r.race_number, r.distance,
      rr.finishing_position, h.name_ch AS horse_name,
      j.name_ch AS jockey_name
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    JOIN horses h ON h.id = rr.horse_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    WHERE rr.trainer_id = ?
    ORDER BY rm.date DESC
    LIMIT 30
  `).bind(id).all();

  return c.json({
    trainer: {
      id: trainer.id,
      nameEn: trainer.name_en,
      nameCh: trainer.name_ch,
      nationality: trainer.nationality,
      location: trainer.location,
    },
    overall: overall ? {
      totalRunners: overall.total_runners,
      wins: overall.wins,
      top3: overall.top3,
      winRate: overall.win_rate,
    } : null,
    jockeyCombo: (combos ?? []).map((cb: any) => ({
      jockeyName: cb.jockey_name,
      jockeyId: cb.jockey_id,
      totalRides: cb.total_rides,
      wins: cb.wins,
      winRate: cb.win_rate,
    })),
    recentForm: (recentForm ?? []).map((f: any) => ({
      date: f.date,
      raceNumber: f.race_number,
      distance: f.distance,
      position: f.finishing_position,
      horseName: f.horse_name,
      jockeyName: f.jockey_name,
    })),
  });
});
