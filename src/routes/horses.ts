import { Hono } from 'hono';
import type { Env } from '../types';

export const horsesRoutes = new Hono<{ Bindings: Env }>();

// GET /api/horses/leaderboard?by=elo&limit=10
horsesRoutes.get('/leaderboard', async (c) => {
  const by = c.req.query('by') || 'elo';
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
  const status = c.req.query('status') || 'active';
  const statusClause = status === 'all' ? '' : "AND h.status = 'active'";

  let sql: string;
  if (by === 'wins') {
    sql = `SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  h.total_wins, h.total_starts, h.status, NULL AS elo
           FROM horses h
           WHERE h.total_starts > 0 ${statusClause}
           ORDER BY h.total_wins DESC, h.total_starts ASC
           LIMIT ?`;
  } else if (by === 'rating') {
    sql = `SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  h.total_wins, h.total_starts, h.status, NULL AS elo
           FROM horses h
           WHERE h.current_rating IS NOT NULL ${statusClause}
           ORDER BY h.current_rating DESC
           LIMIT ?`;
  } else {
    // by=elo (default) — join latest overall snapshot
    sql = `SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  h.total_wins, h.total_starts, h.status, vle.overall_elo AS elo, vle.overall_as_of AS elo_date
           FROM horses h
           LEFT JOIN v_horse_latest_elo vle ON vle.horse_id = h.id
           WHERE vle.overall_elo IS NOT NULL ${statusClause}
           ORDER BY vle.overall_elo DESC
           LIMIT ?`;
  }

  try {
    const { results } = await c.env.DB.prepare(sql).bind(limit).all();
    return c.json({
      by,
      horses: (results ?? []).map((h: any) => ({
        id: h.id, nameEn: h.name_en, nameCh: h.name_ch, code: h.code,
        age: h.age, sex: h.sex, currentRating: h.current_rating,
        totalWins: h.total_wins, totalStarts: h.total_starts,
        status: h.status, elo: h.elo, eloDate: h.elo_date ?? null,
      })),
    });
  } catch (err: any) {
    // Graceful fallback if v_horse_latest_elo doesn't exist yet or is empty.
    return c.json({ by, horses: [], note: 'Elo 資料整備中', error: err?.message }, 200);
  }
});

// GET /api/horses?sort=elo|wins|starts&status=active|all&limit=20&offset=0
horsesRoutes.get('/', async (c) => {
  const sort = c.req.query('sort') || 'starts';
  const status = c.req.query('status') || 'active';
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
  const statusClause = status === 'all' ? '' : "WHERE h.status = 'active'";

  let orderBy = 'h.total_starts DESC';
  if (sort === 'wins') orderBy = 'h.total_wins DESC, h.total_starts ASC';
  else if (sort === 'rating') orderBy = 'h.current_rating DESC';
  else if (sort === 'elo') orderBy = 'vle.overall_elo IS NULL, vle.overall_elo DESC';

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
              h.total_wins, h.total_starts, h.status, vle.overall_elo AS elo
       FROM horses h
       LEFT JOIN v_horse_latest_elo vle ON vle.horse_id = h.id
       ${statusClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all();
    return c.json({
      horses: (results ?? []).map((h: any) => ({
        id: h.id, nameEn: h.name_en, nameCh: h.name_ch, code: h.code,
        age: h.age, sex: h.sex, currentRating: h.current_rating,
        totalWins: h.total_wins, totalStarts: h.total_starts,
        status: h.status, elo: h.elo ?? null,
      })),
      limit, offset, sort, status,
    });
  } catch (err: any) {
    return c.json({ horses: [], note: 'Elo 資料整備中', error: err?.message }, 200);
  }
});

// GET /api/horses/:id — 馬匹詳細資料
horsesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const horse = await c.env.DB.prepare(
    'SELECT * FROM horses WHERE id = ? OR code = ?'
  ).bind(id, id).first<any>();

  if (!horse) {
    return c.json({ error: '找不到該馬匹' }, 404);
  }

  let elo: number | null = null;
  let eloDate: string | null = null;
  try {
    const row = await c.env.DB.prepare(
      `SELECT overall_elo, overall_as_of FROM v_horse_latest_elo WHERE horse_id = ?`,
    ).bind(horse.id).first<any>();
    if (row) { elo = row.overall_elo; eloDate = row.overall_as_of; }
  } catch {}

  return c.json({
    id: horse.id,
    nameEn: horse.name_en,
    nameCh: horse.name_ch,
    code: horse.code,
    countryOfOrigin: horse.country_of_origin,
    colour: horse.colour,
    sex: horse.sex,
    age: horse.age,
    sire: horse.sire,
    dam: horse.dam,
    damSire: horse.dam_sire,
    importType: horse.import_type,
    currentRating: horse.current_rating,
    seasonStakes: horse.season_stakes,
    totalWins: horse.total_wins,
    totalStarts: horse.total_starts,
    status: horse.status,
    elo,
    eloDate,
  });
});

// GET /api/horses/:id/detail — 馬匹詳情全 KV（Phase B Level-3 頁面用）
// Pulls latest-race gear/weight/draw/jockey/trainer, 6-race form string, best-time by distance, priority flags.
horsesRoutes.get('/:id/detail', async (c) => {
  const id = c.req.param('id');
  const raceId = c.req.query('raceId'); // optional: bias best-time to this race's distance

  const horse = await c.env.DB.prepare(
    'SELECT * FROM horses WHERE id = ? OR code = ?'
  ).bind(id, id).first<any>();
  if (!horse) return c.json({ error: '找不到該馬匹' }, 404);

  // Latest entry (either current race if raceId given, or most recent)
  let latest: any = null;
  if (raceId) {
    latest = await c.env.DB.prepare(`
      SELECT rr.*, r.distance, rm.date,
             j.name_ch AS jockey_ch, j.name_en AS jockey_en,
             t.name_ch AS trainer_ch, t.name_en AS trainer_en
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      LEFT JOIN jockeys j ON j.id = rr.jockey_id
      LEFT JOIN trainers t ON t.id = rr.trainer_id
      WHERE rr.horse_id = ? AND rr.race_id = ?
    `).bind(horse.id, raceId).first<any>();
  }
  if (!latest) {
    latest = await c.env.DB.prepare(`
      SELECT rr.*, r.distance, rm.date,
             j.name_ch AS jockey_ch, j.name_en AS jockey_en,
             t.name_ch AS trainer_ch, t.name_en AS trainer_en
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      LEFT JOIN jockeys j ON j.id = rr.jockey_id
      LEFT JOIN trainers t ON t.id = rr.trainer_id
      WHERE rr.horse_id = ?
      ORDER BY rm.date DESC LIMIT 1
    `).bind(horse.id).first<any>();
  }

  // 6-race form string
  const { results: form6 } = await c.env.DB.prepare(`
    SELECT finishing_position FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    WHERE rr.horse_id = ? AND rr.finishing_position IS NOT NULL
    ORDER BY rm.date DESC LIMIT 6
  `).bind(horse.id).all<any>();
  const last6 = (form6 ?? []).map((f: any) => f.finishing_position).join('/');

  // Best time at this distance
  const distance = latest?.distance;
  let bestTime: string | null = null;
  if (distance) {
    try {
      const r = await c.env.DB.prepare(`
        SELECT MIN(finish_time) AS bt FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        WHERE rr.horse_id = ? AND r.distance = ? AND rr.finish_time IS NOT NULL
      `).bind(horse.id, distance).first<any>();
      bestTime = r?.bt ?? null;
    } catch {}
  }

  // ELO (optional)
  let elo: number | null = null;
  try {
    const row = await c.env.DB.prepare(
      `SELECT overall_elo FROM v_horse_latest_elo WHERE horse_id = ?`
    ).bind(horse.id).first<any>();
    elo = row?.overall_elo ?? null;
  } catch {}

  return c.json({
    horseId: horse.id,
    code: horse.code,
    silksCode: horse.silks_code ?? horse.code,
    nameCh: horse.name_ch,
    nameEn: horse.name_en,
    age: horse.age,
    sex: horse.sex,
    ageSex: horse.age != null && horse.sex ? `${horse.age} / ${horse.sex}` : null,
    sire: horse.sire,
    dam: horse.dam,
    damSire: horse.dam_sire,
    countryOfOrigin: horse.country_of_origin,
    colour: horse.colour,
    importType: horse.import_type,
    currentRating: horse.current_rating,
    rating: horse.current_rating,
    elo,
    totalWins: horse.total_wins,
    totalStarts: horse.total_starts,
    status: horse.status,
    // Latest-entry fields (populate Level-3 KV)
    horseNumber: latest?.horse_number,
    jockey: latest?.jockey_ch || latest?.jockey_en,
    trainer: latest?.trainer_ch || latest?.trainer_en,
    draw: latest?.draw,
    weight: latest?.actual_weight,
    bodyWeight: latest?.declared_weight ?? latest?.body_weight ?? null,
    gear: latest?.gear,
    ageAllowance: latest?.age_allowance ?? null,
    trumpCard: latest?.trump_card ?? null,
    priority: latest?.priority_entry ?? null,
    trainerPriority: latest?.trainer_priority ?? null,
    last6: last6 || null,
    bestTime,
    lastRaceDate: latest?.date ?? null,
  });
});

// GET /api/horses/:id/form — 馬匹近績（最近 N 場）
horsesRoutes.get('/:id/form', async (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '10');

  const horse = await c.env.DB.prepare(
    'SELECT * FROM horses WHERE id = ? OR code = ?'
  ).bind(id, id).first<any>();

  if (!horse) {
    return c.json({ error: '找不到該馬匹' }, 404);
  }

  const { results: form } = await c.env.DB.prepare(`
    SELECT
      rm.date, rm.venue,
      r.race_number, r.distance, r.class, r.going, r.track, r.course,
      rr.finishing_position, rr.draw, rr.finish_time, rr.win_odds,
      rr.running_position, rr.lbw, rr.gear, rr.actual_weight,
      j.name_ch AS jockey, t.name_ch AS trainer
    FROM race_results rr
    JOIN races r ON r.id = rr.race_id
    JOIN race_meetings rm ON rm.id = r.meeting_id
    LEFT JOIN jockeys j ON j.id = rr.jockey_id
    LEFT JOIN trainers t ON t.id = rr.trainer_id
    WHERE rr.horse_id = ?
    ORDER BY rm.date DESC
    LIMIT ?
  `).bind(horse.id, limit).all();

  // 試閘記錄
  const { results: trials } = await c.env.DB.prepare(`
    SELECT * FROM barrier_trials
    WHERE horse_id = ?
    ORDER BY trial_date DESC
    LIMIT 5
  `).bind(horse.id).all();

  // 晨操記錄
  const { results: trackwork } = await c.env.DB.prepare(`
    SELECT * FROM trackwork
    WHERE horse_id = ?
    ORDER BY date DESC
    LIMIT 10
  `).bind(horse.id).all();

  return c.json({
    horse: {
      id: horse.id,
      nameEn: horse.name_en,
      nameCh: horse.name_ch,
      code: horse.code,
      sire: horse.sire,
      dam: horse.dam,
      damSire: horse.dam_sire,
      age: horse.age,
      sex: horse.sex,
      currentRating: horse.current_rating,
      totalWins: horse.total_wins,
      totalStarts: horse.total_starts,
    },
    recentForm: (form ?? []).map((f: any) => ({
      date: f.date,
      venue: f.venue,
      raceNumber: f.race_number,
      distance: f.distance,
      class: f.class,
      going: f.going,
      track: f.track,
      course: f.course,
      position: f.finishing_position,
      draw: f.draw,
      finishTime: f.finish_time,
      winOdds: f.win_odds,
      runningPosition: f.running_position,
      lbw: f.lbw,
      gear: f.gear,
      weight: f.actual_weight,
      jockey: f.jockey,
      trainer: f.trainer,
    })),
    barrierTrials: (trials ?? []).map((t: any) => ({
      date: t.trial_date,
      venue: t.venue,
      distance: t.distance,
      going: t.going,
      position: t.finishing_position,
      totalRunners: t.total_runners,
      time: t.time,
      jockey: t.jockey,
      comment: t.comment,
    })),
    trackwork: (trackwork ?? []).map((tw: any) => ({
      date: tw.date,
      venue: tw.venue,
      batch: tw.batch,
      distance: tw.distance,
      time: tw.time,
      partner: tw.partner,
      comment: tw.comment,
    })),
  });
});

// GET /api/horses/search?q=金 — 搜索馬匹
horsesRoutes.get('/search/query', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json({ error: '請提供搜索關鍵字' }, 400);
  }

  const { results } = await c.env.DB.prepare(`
    SELECT * FROM horses
    WHERE name_ch LIKE ? OR name_en LIKE ? OR code LIKE ?
    ORDER BY total_starts DESC
    LIMIT 20
  `).bind(`%${q}%`, `%${q}%`, `%${q}%`).all();

  return c.json({
    horses: (results ?? []).map((h: any) => ({
      id: h.id,
      nameEn: h.name_en,
      nameCh: h.name_ch,
      code: h.code,
      currentRating: h.current_rating,
      totalWins: h.total_wins,
      totalStarts: h.total_starts,
      status: h.status,
    })),
  });
});
