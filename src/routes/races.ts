import { Hono } from 'hono';
import type { Env } from '../types';
import { hhmmFromPostTime, fetchPostTimeMap } from '../lib/race-time';

export const racesRoutes = new Hono<{ Bindings: Env }>();

// GET /api/races/:id — 單場賽事完整數據
racesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const race = await c.env.DB.prepare(`
    SELECT r.*, rm.date, rm.venue, rm.track_condition, rm.weather
    FROM races r
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE r.id = ?
  `).bind(id).first<any>();

  if (!race) {
    return c.json({ error: '找不到該場賽事' }, 404);
  }

  const ptMap = await fetchPostTimeMap(c.env.DB, race.date, race.venue);

  // 出賽馬匹 + 賽果
  const { results: entries } = await c.env.DB.prepare(`
    SELECT
      rr.*,
      h.name_en, h.name_ch, h.code, h.sire, h.dam, h.dam_sire,
      h.current_rating, h.age, h.sex, h.total_wins, h.total_starts,
      j.name_en AS jockey_en, j.name_ch AS jockey_ch,
      t.name_en AS trainer_en, t.name_ch AS trainer_ch
    FROM race_results rr
    JOIN horses h ON h.id = rr.horse_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
    WHERE rr.race_id = ?
    ORDER BY COALESCE(rr.finishing_position, 999) ASC
  `).bind(id).all();

  // 分段時間
  const { results: sectionals } = await c.env.DB.prepare(
    'SELECT * FROM sectional_times WHERE race_id = ? ORDER BY section_number'
  ).bind(id).all();

  // 派彩
  const { results: divs } = await c.env.DB.prepare(
    'SELECT * FROM dividends WHERE race_id = ? ORDER BY pool_type'
  ).bind(id).all();

  // 沿途評述
  const { results: comments } = await c.env.DB.prepare(
    'SELECT * FROM running_comments WHERE race_id = ?'
  ).bind(id).all();

  return c.json({
    id: race.id,
    meetingDate: race.date,
    venue: race.venue,
    trackCondition: race.track_condition,
    weather: race.weather,
    raceNumber: race.race_number,
    title: race.title,
    class: race.class,
    distance: race.distance,
    going: race.going,
    track: race.track,
    course: race.course,
    prize: race.prize,
    startTime: hhmmFromPostTime(ptMap.get(race.race_number)) ?? race.start_time,
    videoUrl: race.video_url,
    horses: (entries ?? []).map((e: any) => ({
      id: e.horse_id,
      horseNumber: e.horse_number,
      name: e.name_en,
      nameCh: e.name_ch,
      code: e.code,
      draw: e.draw,
      jockey: e.jockey_en,
      jockeyCh: e.jockey_ch,
      trainer: e.trainer_en,
      trainerCh: e.trainer_ch,
      finishingPosition: e.finishing_position,
      finishTime: e.finish_time,
      winOdds: e.win_odds,
      runningPosition: e.running_position,
      lbw: e.lbw,
      gear: e.gear,
      weight: e.actual_weight,
      rating: e.current_rating,
      sire: e.sire,
      dam: e.dam,
      damSire: e.dam_sire,
      age: e.age,
      sex: e.sex,
      totalWins: e.total_wins,
      totalStarts: e.total_starts,
    })),
    sectionalTimes: (sectionals ?? []).map((s: any) => ({
      section: s.section_number,
      distance: s.section_distance,
      time: s.section_time,
      cumulative: s.cumulative_time,
    })),
    dividends: (divs ?? []).map((d: any) => ({
      poolType: d.pool_type,
      combination: d.combination,
      dividend: d.dividend,
    })),
    runningComments: (comments ?? []).map((rc: any) => ({
      horseId: rc.horse_id,
      comment: rc.comment_text,
      language: rc.language,
    })),
  });
});

// GET /api/races/:id/entries — Phase B · 排位表專用（含 siblings + silks code）
racesRoutes.get('/:id/entries', async (c) => {
  const id = c.req.param('id');

  const race = await c.env.DB.prepare(`
    SELECT r.*, rm.date, rm.venue, rm.track_condition, rm.weather, rm.id AS meeting_id
    FROM races r
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE r.id = ?
  `).bind(id).first<any>();

  if (!race) return c.json({ error: '找不到該場賽事' }, 404);

  const ptMap = await fetchPostTimeMap(c.env.DB, race.date, race.venue);

  // All races in the same meeting (for chip-row navigation)
  const { results: siblings } = await c.env.DB.prepare(
    'SELECT id, race_number, start_time FROM races WHERE meeting_id = ? ORDER BY race_number'
  ).bind(race.meeting_id).all<any>();

  // Entries, tolerant of either race_results (historical) or future entry list.
  // Include silks_code if the horses table carries one; otherwise null.
  const { results: entries } = await c.env.DB.prepare(`
    SELECT
      rr.*,
      h.name_en, h.name_ch, h.code,
      COALESCE(h.silks_code, h.code) AS silks_code,
      h.current_rating, h.age, h.sex,
      j.name_ch AS jockey_ch, j.name_en AS jockey_en,
      t.name_ch AS trainer_ch, t.name_en AS trainer_en
    FROM race_results rr
    JOIN horses h ON h.id = rr.horse_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
    WHERE rr.race_id = ?
    ORDER BY rr.horse_number ASC
  `).bind(id).all<any>();

  return c.json({
    race: {
      id: race.id,
      raceNumber: race.race_number,
      raceName: race.title,
      date: race.date,
      venue: race.venue,
      venueName: race.venue === 'ST' ? '沙田' : race.venue === 'HV' ? '跑馬地' : race.venue,
      className: race.class,
      distanceM: race.distance,
      going: race.going,
      track: race.track,
      course: race.course,
      startTime: hhmmFromPostTime(ptMap.get(race.race_number)) ?? race.start_time,
      handicapType: race.title,
    },
    meetingRaces: (siblings ?? []).map((r) => ({
      id: r.id,
      raceNumber: r.race_number,
      startTime: hhmmFromPostTime(ptMap.get(r.race_number)) ?? r.start_time,
    })),
    entries: (entries ?? []).map((e: any) => ({
      horseId: e.horse_id,
      horseNumber: e.horse_number,
      nameCh: e.name_ch,
      nameEn: e.name_en,
      silksCode: e.silks_code,
      jockey: e.jockey_ch || e.jockey_en,
      trainer: e.trainer_ch || e.trainer_en,
      draw: e.draw,
      weight: e.actual_weight,
      winOdds: e.win_odds,
      rating: e.current_rating,
      age: e.age,
      sex: e.sex,
      gear: e.gear,
    })),
  });
});

// GET /api/races/:id/sectionals — 分段時間詳細
racesRoutes.get('/:id/sectionals', async (c) => {
  const id = c.req.param('id');

  // 全場分段
  const { results: raceSectionals } = await c.env.DB.prepare(
    'SELECT * FROM sectional_times WHERE race_id = ? ORDER BY section_number'
  ).bind(id).all();

  // 個別馬匹分段
  const { results: horseSectionals } = await c.env.DB.prepare(`
    SELECT hst.*, h.name_en, h.name_ch
    FROM horse_sectional_times hst
    JOIN horses h ON h.id = hst.horse_id
    WHERE hst.race_id = ?
    ORDER BY hst.section_number, hst.position_at_section
  `).bind(id).all();

  return c.json({
    raceSectionals: (raceSectionals ?? []).map((s: any) => ({
      section: s.section_number,
      distance: s.section_distance,
      time: s.section_time,
      cumulative: s.cumulative_time,
    })),
    horseSectionals: (horseSectionals ?? []).map((hs: any) => ({
      horseId: hs.horse_id,
      horseName: hs.name_ch || hs.name_en,
      section: hs.section_number,
      time: hs.section_time,
      position: hs.position_at_section,
    })),
  });
});

// GET /api/races/:id/dividends — 派彩
racesRoutes.get('/:id/dividends', async (c) => {
  const id = c.req.param('id');

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM dividends WHERE race_id = ? ORDER BY pool_type'
  ).bind(id).all();

  return c.json({
    dividends: (results ?? []).map((d: any) => ({
      poolType: d.pool_type,
      poolName: getPoolName(d.pool_type),
      combination: d.combination,
      dividend: d.dividend,
    })),
  });
});

function getPoolName(type: string): string {
  const names: Record<string, string> = {
    WIN: '獨贏',
    PLA: '位置',
    QIN: '連贏',
    QPL: '位置Q',
    TRI: '三重彩',
    FF: '四連環',
    TCE: '三寶',
    QTT: '四重彩',
    DBL: '孖寶',
    TBL: '三串一',
    SIX: '六環彩',
  };
  return names[type] || type;
}
