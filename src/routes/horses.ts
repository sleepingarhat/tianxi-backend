import { Hono } from 'hono';
import type { Env } from '../types';
import {
  HORSE_CAREER_STATS_CTE,
  getHorseCareerStats,
  type HorseCareerStats,
} from '../lib/horse-career-stats';
import {
  computeRunningStyles,
  dateFromRaceId,
  validateDate,
  validateHorseIds,
  validateRaceId,
} from '../lib/running-style';

export const horsesRoutes = new Hono<{ Bindings: Env }>();

// GET /api/horses/leaderboard?by=elo&limit=10
horsesRoutes.get('/leaderboard', async (c) => {
  const by = c.req.query('by') || 'elo';
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
  const status = c.req.query('status') || 'active';
  const statusClause = status === 'all' ? '' : "AND h.status = 'active'";

  let sql: string;
  if (by === 'wins') {
    sql = `${HORSE_CAREER_STATS_CTE}
           SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  cs.total_wins, cs.total_seconds, cs.total_thirds, cs.total_starts,
                  h.status, NULL AS elo
           FROM horses h
           JOIN career_stats cs ON cs.horse_id = h.id
           WHERE cs.total_starts > 0 ${statusClause}
           ORDER BY cs.total_wins DESC, cs.total_starts ASC
           LIMIT ?`;
  } else if (by === 'rating') {
    sql = `${HORSE_CAREER_STATS_CTE}
           SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  cs.total_wins, cs.total_seconds, cs.total_thirds, cs.total_starts,
                  h.status, NULL AS elo
           FROM horses h
           LEFT JOIN career_stats cs ON cs.horse_id = h.id
           WHERE h.current_rating IS NOT NULL ${statusClause}
           ORDER BY h.current_rating DESC
           LIMIT ?`;
  } else {
    // by=elo (default) — join latest overall snapshot
    sql = `${HORSE_CAREER_STATS_CTE}
           SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
                  cs.total_wins, cs.total_seconds, cs.total_thirds, cs.total_starts,
                  h.status, vle.overall_elo AS elo, vle.overall_as_of AS elo_date
           FROM horses h
           LEFT JOIN v_horse_latest_elo vle ON vle.horse_id = h.id
           LEFT JOIN career_stats cs ON cs.horse_id = h.id
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
        totalWins: h.total_wins, totalSeconds: h.total_seconds,
        totalThirds: h.total_thirds, totalStarts: h.total_starts,
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

  let orderBy = 'cs.total_starts IS NULL, cs.total_starts DESC';
  if (sort === 'wins') orderBy = 'cs.total_wins IS NULL, cs.total_wins DESC, cs.total_starts ASC';
  else if (sort === 'rating') orderBy = 'h.current_rating DESC';
  else if (sort === 'elo') orderBy = 'vle.overall_elo IS NULL, vle.overall_elo DESC';

  try {
    const { results } = await c.env.DB.prepare(
      `${HORSE_CAREER_STATS_CTE}
       SELECT h.id, h.name_ch, h.name_en, h.code, h.age, h.sex, h.current_rating,
              cs.total_wins, cs.total_seconds, cs.total_thirds, cs.total_starts,
              h.status, vle.overall_elo AS elo
       FROM horses h
       LEFT JOIN v_horse_latest_elo vle ON vle.horse_id = h.id
       LEFT JOIN career_stats cs ON cs.horse_id = h.id
       ${statusClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all();
    return c.json({
      horses: (results ?? []).map((h: any) => ({
        id: h.id, nameEn: h.name_en, nameCh: h.name_ch, code: h.code,
        age: h.age, sex: h.sex, currentRating: h.current_rating,
        totalWins: h.total_wins, totalSeconds: h.total_seconds,
        totalThirds: h.total_thirds, totalStarts: h.total_starts,
        status: h.status, elo: h.elo ?? null,
      })),
      limit, offset, sort, status,
    });
  } catch (err: any) {
    return c.json({ horses: [], note: 'Elo 資料整備中', error: err?.message }, 200);
  }
});

// GET /api/horses/running-styles — public batch running-style labels
horsesRoutes.get('/running-styles', async (c) => {
  const rawIds = (c.req.query('horseIds') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const horseIds = [...new Set(rawIds)];
  if (!horseIds.length) {
    return c.json({ error: 'horseIds is required' }, 400);
  }
  if (horseIds.length > 50) {
    return c.json({ error: 'horseIds: max 50 IDs per request' }, 400);
  }
  if (!validateHorseIds(horseIds)) {
    return c.json({
      error: 'horseIds: all IDs must be canonical horse_ identifiers',
    }, 400);
  }

  const raceId = c.req.query('raceId') ?? null;
  const beforeDate = c.req.query('beforeDate') ?? null;
  let cutoffDate: string;
  if (raceId !== null) {
    if (!validateRaceId(raceId)) {
      return c.json({
        error: 'raceId must match race_YYYY-MM-DD_ST|HV_N with a real date',
      }, 400);
    }
    cutoffDate = dateFromRaceId(raceId);
  } else if (beforeDate !== null) {
    if (!validateDate(beforeDate)) {
      return c.json({ error: 'beforeDate must be a real YYYY-MM-DD date' }, 400);
    }
    cutoffDate = beforeDate;
  } else {
    cutoffDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  const placeholders = horseIds.map(() => '?').join(',');
  let formRows: any[] = [];
  let resultRows: any[] = [];

  try {
    const response = await c.env.DB.prepare(`
      SELECT horse_id, race_date, venue, race_number,
             running_position, total_runners
      FROM horse_form_records
      WHERE horse_id IN (${placeholders})
        AND race_date < ?
        AND running_position IS NOT NULL
        AND running_position != ''
      ORDER BY race_date DESC, race_number DESC
    `).bind(...horseIds, cutoffDate).all<any>();
    formRows = response.results ?? [];
  } catch {
    formRows = [];
  }

  try {
    const response = await c.env.DB.prepare(`
      SELECT rr.horse_id,
             rm.date AS race_date,
             rm.venue,
             r.race_number,
             rr.running_position,
             (
               SELECT COUNT(*)
               FROM race_results field
               WHERE field.race_id = rr.race_id
             ) AS total_runners
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      WHERE rr.horse_id IN (${placeholders})
        AND rm.date < ?
        AND rr.running_position IS NOT NULL
        AND rr.running_position != ''
      ORDER BY rm.date DESC, r.race_number DESC
    `).bind(...horseIds, cutoffDate).all<any>();
    resultRows = response.results ?? [];
  } catch {
    resultRows = [];
  }

  const styles = computeRunningStyles([
    ...formRows.map((row) => ({ ...row, source_priority: 0 })),
    ...resultRows.map((row) => ({ ...row, source_priority: 1 })),
  ]);
  return c.json({ cutoffDate, styles });
});

// GET /api/horses/:id — 馬匹詳細資料
horsesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const horse = await c.env.DB.prepare(`
    ${HORSE_CAREER_STATS_CTE}
    SELECT h.*, cs.total_wins AS verified_wins,
           cs.total_seconds AS verified_seconds,
           cs.total_thirds AS verified_thirds,
           cs.total_starts AS verified_starts
    FROM horses h
    LEFT JOIN career_stats cs ON cs.horse_id = h.id
    WHERE h.id = ? OR h.code = ?
  `).bind(id, id).first<any>();

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
    totalWins: horse.verified_wins ?? null,
    totalSeconds: horse.verified_seconds ?? null,
    totalThirds: horse.verified_thirds ?? null,
    totalStarts: horse.verified_starts ?? null,
    status: horse.status,
    elo,
    eloDate,
  });
});

// GET /api/horses/:id/detail — 舊版馬匹詳情（保留作部署期間 fallback）
// Race-specific fields are returned only when a matching raceId is supplied.
horsesRoutes.get('/:id/detail', async (c) => {
  const id = c.req.param('id');
  const raceId = c.req.query('raceId'); // optional: bias best-time to this race's distance

  const horse = await c.env.DB.prepare(`
    ${HORSE_CAREER_STATS_CTE}
    SELECT h.*, cs.total_wins AS verified_wins,
           cs.total_seconds AS verified_seconds,
           cs.total_thirds AS verified_thirds,
           cs.total_starts AS verified_starts
    FROM horses h
    LEFT JOIN career_stats cs ON cs.horse_id = h.id
    WHERE h.id = ? OR h.code = ?
  `).bind(id, id).first<any>();
  if (!horse) return c.json({ error: '找不到該馬匹' }, 404);

  // Race-specific result context. Never use the latest race as fixed profile data.
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
  // 6-race form string
  const { results: form6 } = await c.env.DB.prepare(`
    SELECT rr.finishing_position, rm.date FROM race_results rr
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
    totalWins: horse.verified_wins ?? null,
    totalSeconds: horse.verified_seconds ?? null,
    totalThirds: horse.verified_thirds ?? null,
    totalStarts: horse.verified_starts ?? null,
    status: horse.status,
    // Latest-entry fields (populate Level-3 KV)
    horseNumber: latest?.horse_number,
    jockey: latest?.jockey_ch || latest?.jockey_en,
    trainer: latest?.trainer_ch || latest?.trainer_en,
    draw: latest?.draw,
    weight: latest?.actual_weight,
    gear: latest?.gear,
    ageAllowance: latest?.age_allowance ?? null,
    trumpCard: latest?.trump_card ?? null,
    priority: latest?.priority_entry ?? null,
    trainerPriority: latest?.trainer_priority ?? null,
    last6: last6 || null,
    bestTime,
    lastRaceDate: (form6 ?? [])[0]?.date ?? latest?.date ?? null,
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

  const [statsMap, formResult] = await Promise.all([
    getHorseCareerStats(c.env.DB, [horse.id]),
    c.env.DB.prepare(`
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
    `).bind(horse.id, limit).all(),
  ]);
  const form = formResult.results;
  const careerStats = statsMap.get(horse.id);

  // 試閘記錄 (v2: trial_runners + trial_sessions)
  const { results: trials } = await c.env.DB.prepare(`
    SELECT tr.id, tr.horse_id, tr.jockey, tr.draw, tr.finish_time_text AS time,
           tr.finishing_position, tr.running_pos, tr.lbw, tr.gear, tr.commentary AS comment,
           ts.trial_date, ts.venue, ts.distance_m AS distance, ts.going
    FROM trial_runners tr
    JOIN trial_sessions ts ON ts.id = tr.session_id
    WHERE tr.horse_id = ?
    ORDER BY ts.trial_date DESC
    LIMIT 5
  `).bind(horse.id).all().catch(() => ({ results: [] }));

  // 晨操記錄 (v2: horse_trackwork)
  const { results: trackwork } = await c.env.DB.prepare(`
    SELECT id, horse_id, trackwork_date, venue, batch, distance, time_text AS time, partner, comment
    FROM horse_trackwork
    WHERE horse_id = ?
    ORDER BY trackwork_date DESC
    LIMIT 10
  `).bind(horse.id).all().catch(() => ({ results: [] }));

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
      totalWins: careerStats?.totalWins ?? null,
      totalSeconds: careerStats?.totalSeconds ?? null,
      totalThirds: careerStats?.totalThirds ?? null,
      totalStarts: careerStats?.totalStarts ?? null,
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
      date: tw.trackwork_date ?? tw.date,
      venue: tw.venue,
      batch: tw.batch,
      distance: tw.distance,
      time: tw.time,
      partner: tw.partner,
      comment: tw.comment,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/horses/:id/research — 全方位馬匹研究檔案
// Query params:
//   limit   – recentForm count, default 30, clamp 1..50
//   raceId  – optional; enables raceContext section
// ─────────────────────────────────────────────────────────────────────────────
horsesRoutes.get('/:id/research', async (c) => {
  const id = c.req.param('id');
  // Robust limit: parse then clamp 1..50, default 30 on NaN/missing
  const rawLimit = parseInt(c.req.query('limit') ?? '', 10);
  const formLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 30;
  const raceId = c.req.query('raceId') || null;

  // ── 1. Resolve horse identity ─────────────────────────────────────────────
  const horse = await c.env.DB.prepare(
    'SELECT * FROM horses WHERE id = ? OR code = ?'
  ).bind(id, id).first<any>();
  if (!horse) return c.json({ error: '找不到該馬匹' }, 404);
  const horseId: string = horse.id;

  // ── 2. Parallel data fetches (avoid N+1) ─────────────────────────────────
  // All queries are independent; fire them in parallel via Promise.allSettled.
  // horse_form_records is preferred for recentForm; race_results is the fallback.

  const [
    profileExtraResult,
    pedigreeResult,
    careerStatsResult,
    trainerNameResult,
    hfrFormResult,      // preferred: horse_form_records (horse-centric, has total_runners, raw pos, finish_time_sec)
    rrFormResult,       // fallback:  race_results join
    commentsResult,     // running_comments for the form window race_ids
    eloLatestResult,
    eloHistoryResult,
    careerPerfResult,   // full career starts from horse_form_records
    rrCareerPerfResult, // full career fallback from race_results
    trackworkResult,
    trialsResult,
    injuryResult,
    horseSectionalsResult,
    raceContextResult,
  ] = await Promise.allSettled([
    // 2a. horse_profile_extra (v2 enrichment) — also pulls country_of_origin, import_type, last_rating
    c.env.DB.prepare(
      `SELECT last_race_date, current_trainer, owner, half_siblings, colour_sex_raw,
              season_stakes_int, total_stakes_int,
              record_wins, record_seconds, record_thirds, record_total_starts,
              sire, dam, dam_sire,
              country_of_origin, import_type, last_rating, status AS profile_status,
              profile_last_scraped, profile_checked_at, source_commit
       FROM horse_profile_extra
       WHERE horse_id = ? OR horse_id = ?
       ORDER BY CASE WHEN horse_id = ? THEN 0 ELSE 1 END
       LIMIT 1`
    ).bind(horseId, horse.code, horseId).first<any>(),

    // 2b. Canonical pedigree table is a compatibility fallback when an older
    // profile ingestion missed horse_profile_extra because of id-prefix drift.
    c.env.DB.prepare(
      `SELECT sire, dam, dam_sire
       FROM horse_pedigree
       WHERE horse_id = ? OR code = ?
       ORDER BY CASE WHEN horse_id = ? THEN 0 ELSE 1 END
       LIMIT 1`
    ).bind(horseId, horse.code, horseId).first<any>(),

    // 2c. Canonical career snapshot shared by list/search/leaderboards/details.
    getHorseCareerStats(c.env.DB, [horseId]),

    // 2d. current trainer name (via current_trainer_id on horses table)
    horse.current_trainer_id
      ? c.env.DB.prepare(
          `SELECT name_ch, name_en FROM trainers WHERE id = ?`
        ).bind(horse.current_trainer_id).first<any>()
      : Promise.resolve(null),

    // 2c. Preferred: horse_form_records — horse-centric, has total_runners, raw pos text, finish_time_sec, rating
    //     finishing_position = TEXT (raw: '1', 'PU', 'WV-A', '999')
    //     finishing_position_num = INTEGER (normalized; 999 = DNF)
    c.env.DB.prepare(`
      SELECT
        hfr.race_date AS date, hfr.venue,
        hfr.race_id, hfr.race_number, hfr.race_class, hfr.distance,
        hfr.going, hfr.track, hfr.course,
        hfr.horse_number, hfr.draw,
        hfr.finishing_position_num AS position_num,
        hfr.finishing_position     AS finishing_position,
        hfr.total_runners,
        hfr.actual_weight, hfr.declared_weight,
        hfr.jockey_name, hfr.trainer_name,
        hfr.lbw, hfr.running_position,
        hfr.finish_time AS finish_time_text, hfr.finish_time_sec,
        hfr.win_odds, hfr.gear, hfr.rating
      FROM horse_form_records hfr
      WHERE hfr.horse_id = ?
      ORDER BY hfr.race_date DESC, hfr.race_number DESC
      LIMIT ?
    `).bind(horseId, formLimit * 3).all<any>(),

    // 2d. Fallback: race_results join (used if horse_form_records unavailable/empty)
    c.env.DB.prepare(`
      SELECT
        rm.date, rm.venue,
        r.id AS race_id, r.race_number, r.class AS race_class, r.distance,
        r.going, r.track, r.course,
        rr.horse_number, rr.draw,
        rr.finishing_position AS position_num, rr.finishing_position AS position,
        NULL AS total_runners,
        rr.actual_weight, rr.declared_weight,
        j.name_ch AS jockey_name, t.name_ch AS trainer_name,
        rr.lbw, rr.running_position,
        NULL AS finish_time_text, rr.finish_time AS finish_time_sec,
        rr.win_odds, rr.gear, rr.race_class_rating AS rating
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      LEFT JOIN jockeys j ON j.id = rr.jockey_id
      LEFT JOIN trainers t ON t.id = rr.trainer_id
      WHERE rr.horse_id = ?
      ORDER BY rm.date DESC, r.race_number DESC
      LIMIT ?
    `).bind(horseId, formLimit).all<any>(),

    // 2e. running_comments for this horse — fetched by horse_id; matched to races via race_id
    c.env.DB.prepare(`
      SELECT race_id, comment_text, language
      FROM running_comments
      WHERE horse_id = ?
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2f. latest overall Elo
    c.env.DB.prepare(
      `SELECT rating, as_of_date, games_played
       FROM horse_elo_snapshots
       WHERE horse_id = ? AND axis_key = 'overall'
       ORDER BY as_of_date DESC LIMIT 1`
    ).bind(horseId).first<any>(),

    // 2g. Elo history (overall axis, chronological)
    c.env.DB.prepare(
      `SELECT as_of_date, rating, games_played
       FROM horse_elo_snapshots
       WHERE horse_id = ? AND axis_key = 'overall'
       ORDER BY as_of_date ASC`
    ).bind(horseId).all<any>(),

    // 2h. Date-unbounded career starts from horse_form_records (preferred).
    //     Includes non-finishers so record and performance can apply separate
    //     truthful boundaries from one authoritative snapshot.
    c.env.DB.prepare(`
      SELECT
        race_date AS date, venue, race_id, race_number, horse_number,
        distance, going, track, draw,
        jockey_name,
        finishing_position,
        finishing_position_num AS pos
      FROM horse_form_records
      WHERE horse_id = ?
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2i. Date-unbounded full-career fallback from race_results.
    c.env.DB.prepare(`
      SELECT
        rm.date, rm.venue, rr.race_id, r.race_number, rr.horse_number,
        r.distance, r.going, r.track, rr.draw,
        COALESCE(j.name_ch, j.name_en) AS jockey_name,
        CAST(rr.finishing_position AS TEXT) AS finishing_position,
        rr.finishing_position AS pos
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
      LEFT JOIN jockeys j ON j.id = rr.jockey_id
      WHERE rr.horse_id = ?
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2j. trackwork (v2: horse_trackwork, most recent 15)
    c.env.DB.prepare(`
      SELECT trackwork_date, venue, batch, distance, time_text, time_sec, partner, comment
      FROM horse_trackwork
      WHERE horse_id = ?
      ORDER BY trackwork_date DESC
      LIMIT 15
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2k. barrier trials (v2: trial_runners + trial_sessions, most recent 8)
    c.env.DB.prepare(`
      SELECT
        ts.trial_date, ts.venue, ts.distance, ts.going, ts.track,
        tr.finishing_position, tr.time_text, tr.time_sec,
        tr.jockey_name, tr.lbw, tr.gear, tr.comment
      FROM trial_runners tr
      JOIN trial_sessions ts ON ts.id = tr.session_id
      WHERE tr.horse_id = ?
      ORDER BY ts.trial_date DESC
      LIMIT 8
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2l. injury history (horse_injury)
    c.env.DB.prepare(`
      SELECT injury_date, injury_type, resolution_date, days_out, description
      FROM horse_injury
      WHERE horse_id = ?
      ORDER BY injury_date DESC
    `).bind(horseId).all<any>().catch(() => ({ results: [] as any[] })),

    // 2m. per-horse sectional times — bulk fetch for the form window
    c.env.DB.prepare(`
      SELECT hst.race_id, hst.section_number, hst.section_time, hst.position_at_section
      FROM horse_sectional_times hst
      WHERE hst.horse_id = ?
        AND hst.race_id IN (
          SELECT rr2.race_id FROM race_results rr2
          JOIN races r2 ON r2.id = rr2.race_id
          JOIN race_meetings rm2 ON rm2.id = r2.meeting_id
          WHERE rr2.horse_id = ?
          ORDER BY rm2.date DESC, r2.race_number DESC
          LIMIT ?
        )
      ORDER BY hst.race_id, hst.section_number
    `).bind(horseId, horseId, formLimit).all<any>().catch(() => ({ results: [] as any[] })),

    // 2n. raceContext — only if raceId given; upcoming entry preferred, then past result
    raceId
      ? (async () => {
          // Try upcoming entry first: derive race_date/venue/race_number from the races table
          const entry = await c.env.DB.prepare(`
            SELECT eu.draw, eu.jockey_name, eu.trainer_name, eu.actual_weight,
                   eu.declared_weight, eu.gear, eu.rating,
                   eu.race_date, eu.venue, eu.race_number, eu.distance, eu.race_class, eu.horse_number
            FROM entries_upcoming eu
            WHERE eu.horse_id = ?
              AND eu.race_date = (
                SELECT rm3.date FROM races r3
                JOIN race_meetings rm3 ON rm3.id = r3.meeting_id WHERE r3.id = ?
              )
              AND eu.venue = (
                SELECT rm3.venue FROM races r3
                JOIN race_meetings rm3 ON rm3.id = r3.meeting_id WHERE r3.id = ?
              )
              AND eu.race_number = (SELECT r3.race_number FROM races r3 WHERE r3.id = ?)
            LIMIT 1
          `).bind(horseId, raceId, raceId, raceId).first<any>().catch(() => null);
          if (entry) return { source: 'upcoming' as const, entry };

          // Try past race result — only if the raceId actually corresponds to a past race
          const result = await c.env.DB.prepare(`
            SELECT rr.draw, rr.actual_weight, rr.declared_weight, rr.gear,
                   rr.race_class_rating AS rating, rr.horse_number,
                   j.name_ch AS jockey_name,
                   t.name_ch AS trainer_name,
                   rm4.date AS race_date, rm4.venue,
                   r4.race_number, r4.distance, r4.class AS race_class
            FROM race_results rr
            JOIN races r4 ON r4.id = rr.race_id
            JOIN race_meetings rm4 ON rm4.id = r4.meeting_id
            LEFT JOIN jockeys j ON j.id = rr.jockey_id
            LEFT JOIN trainers t ON t.id = rr.trainer_id
            WHERE rr.horse_id = ? AND rr.race_id = ?
          `).bind(horseId, raceId).first<any>().catch(() => null);
          if (result) return { source: 'result' as const, entry: result };
          return null;
        })()
      : Promise.resolve(null),
  ]);

  // ── 3. Unpack settled results ─────────────────────────────────────────────
  const profileExtra: any  = profileExtraResult.status === 'fulfilled'      ? profileExtraResult.value              : null;
  const pedigree: any      = pedigreeResult.status === 'fulfilled'           ? pedigreeResult.value                  : null;
  const careerStats: HorseCareerStats | null = careerStatsResult.status === 'fulfilled'
    ? (careerStatsResult.value.get(horseId) ?? null)
    : null;
  const trainerRow: any    = trainerNameResult.status === 'fulfilled'        ? trainerNameResult.value               : null;
  // Prefer horse_form_records; fall back to race_results join if empty/failed
  const hfrRows: any[]     = hfrFormResult.status === 'fulfilled'            ? (hfrFormResult.value?.results ?? [])  : [];
  const rrRows: any[]      = rrFormResult.status === 'fulfilled'             ? (rrFormResult.value?.results ?? [])   : [];
  const useHfr             = hfrRows.length > 0;
  const rowKey = (row: any): string => `${row.date ?? ''}|${row.venue ?? ''}`;
  const firstPresent = (rows: any[], key: string): any => {
    const row = rows.find((candidate) => candidate?.[key] != null && candidate[key] !== '');
    return row ? row[key] : null;
  };
  const validMeetingNumber = (value: any): boolean => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 20;
  };
  const carryingWeight = (value: any): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 80 && n <= 180 ? n : null;
  };
  const rrByDateVenue = new Map<string, any>();
  for (const row of rrRows) rrByDateVenue.set(rowKey(row), row);

  // horse_form_records may contain both a raw race-index row (e.g. race 791,
  // horse 368) and a normalized matched row for the same horse/date. Collapse
  // each date+venue to one start, taking race linkage/horse number/carry weight
  // from normalized race_results and richer class/distance/time from HFR.
  const mergedHfrRows: any[] = [];
  if (useHfr) {
    const grouped = new Map<string, any[]>();
    for (const row of hfrRows) {
      const key = rowKey(row);
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
    for (const [key, group] of grouped) {
      const rr = rrByDateVenue.get(key);
      const linked = group.find((row) => row.race_id)
        ?? group.find((row) => validMeetingNumber(row.race_number) && validMeetingNumber(row.horse_number))
        ?? null;
      mergedHfrRows.push({
        date: firstPresent(group, 'date'),
        venue: firstPresent(group, 'venue'),
        race_id: rr?.race_id ?? linked?.race_id ?? null,
        race_number: rr?.race_number
          ?? (validMeetingNumber(linked?.race_number) ? linked.race_number : null),
        horse_number: rr?.horse_number
          ?? (validMeetingNumber(linked?.horse_number) ? linked.horse_number : null),
        race_class: firstPresent(group, 'race_class') ?? rr?.race_class ?? null,
        distance: firstPresent(group, 'distance') ?? rr?.distance ?? null,
        going: firstPresent(group, 'going') ?? rr?.going ?? null,
        track: firstPresent(group, 'track') ?? rr?.track ?? null,
        course: firstPresent(group, 'course') ?? rr?.course ?? null,
        draw: rr?.draw ?? firstPresent(group, 'draw'),
        position_num: firstPresent(group, 'position_num'),
        finishing_position: firstPresent(group, 'finishing_position'),
        total_runners: firstPresent(group, 'total_runners'),
        actual_weight: rr?.actual_weight ?? firstPresent(group, 'actual_weight'),
        jockey_name: rr?.jockey_name ?? firstPresent(group, 'jockey_name'),
        trainer_name: rr?.trainer_name ?? firstPresent(group, 'trainer_name'),
        lbw: firstPresent(group, 'lbw') ?? rr?.lbw ?? null,
        running_position: firstPresent(group, 'running_position') ?? rr?.running_position ?? null,
        finish_time_text: firstPresent(group, 'finish_time_text'),
        finish_time_sec: firstPresent(group, 'finish_time_sec') ?? rr?.finish_time_sec ?? null,
        win_odds: firstPresent(group, 'win_odds') ?? rr?.win_odds ?? null,
        gear: firstPresent(group, 'gear') ?? rr?.gear ?? null,
        rating: firstPresent(group, 'rating') ?? rr?.rating ?? null,
      });
    }
  }
  const formRows: any[] = (useHfr ? mergedHfrRows : rrRows).slice(0, formLimit);
  const formSource         = useHfr ? '完整馬匹歷史賽績' : '標準化賽果紀錄';
  const commentsRows: any[] = commentsResult.status === 'fulfilled'          ? (commentsResult.value?.results ?? []) : [];
  const eloLatest: any     = eloLatestResult.status === 'fulfilled'          ? eloLatestResult.value                 : null;
  const eloHistoryRows: any[] = eloHistoryResult.status === 'fulfilled'      ? (eloHistoryResult.value?.results ?? []) : [];
  const hfrCareerPerfRawRows: any[] = careerPerfResult.status === 'fulfilled' ? (careerPerfResult.value?.results ?? []) : [];
  const rrCareerPerfRawRows: any[] = rrCareerPerfResult.status === 'fulfilled' ? (rrCareerPerfResult.value?.results ?? []) : [];
  const rrCareerByDateVenue = new Map<string, any>();
  for (const row of rrCareerPerfRawRows) rrCareerByDateVenue.set(rowKey(row), row);
  const rrCareerPerfRows: any[] = Array.from(rrCareerByDateVenue.values());
  const hfrCareerPerfRows: any[] = [];
  if (hfrCareerPerfRawRows.length > 0) {
    const grouped = new Map<string, any[]>();
    for (const row of hfrCareerPerfRawRows) {
      const key = rowKey(row);
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
    for (const [key, group] of grouped) {
      const rr = rrCareerByDateVenue.get(key);
      hfrCareerPerfRows.push({
        date: firstPresent(group, 'date'),
        venue: firstPresent(group, 'venue'),
        distance: firstPresent(group, 'distance') ?? rr?.distance ?? null,
        going: firstPresent(group, 'going') ?? rr?.going ?? null,
        track: firstPresent(group, 'track') ?? rr?.track ?? null,
        draw: rr?.draw ?? firstPresent(group, 'draw'),
        jockey_name: rr?.jockey_name ?? firstPresent(group, 'jockey_name'),
        finishing_position: firstPresent(group, 'finishing_position') ?? rr?.finishing_position ?? null,
        pos: firstPresent(group, 'pos') ?? rr?.pos ?? null,
      });
    }
  }
  const useHfrCareerPerf = hfrCareerPerfRows.length > 0;
  const careerPerfRows: any[] = useHfrCareerPerf ? hfrCareerPerfRows : rrCareerPerfRows;
  const trackworkRows: any[] = trackworkResult.status === 'fulfilled'        ? (trackworkResult.value?.results ?? [])  : [];
  const trialRows: any[]   = trialsResult.status === 'fulfilled'             ? (trialsResult.value?.results ?? [])   : [];
  const injuryRows: any[]  = injuryResult.status === 'fulfilled'             ? (injuryResult.value?.results ?? [])   : [];
  const sectionalsRows: any[] = horseSectionalsResult.status === 'fulfilled' ? (horseSectionalsResult.value?.results ?? []) : [];
  const raceCtxRaw: any    = raceContextResult.status === 'fulfilled'        ? raceContextResult.value               : null;

  // ── 4. Build sectionals lookup keyed by race_id ───────────────────────────
  const sectionalsMap = new Map<string, { sectionNumber: number; sectionTime: number | null; positionAtSection: number | null }[]>();
  for (const s of sectionalsRows) {
    const arr = sectionalsMap.get(s.race_id) ?? [];
    arr.push({
      sectionNumber: s.section_number,
      sectionTime: s.section_time ?? null,
      positionAtSection: s.position_at_section ?? null,
    });
    sectionalsMap.set(s.race_id, arr);
  }

  // Build running_comments lookup keyed by race_id
  const commentsMap = new Map<string, { text: string; language: string }[]>();
  for (const rc of commentsRows) {
    if (!rc.race_id) continue;
    const arr = commentsMap.get(rc.race_id) ?? [];
    arr.push({ text: rc.comment_text, language: rc.language });
    commentsMap.set(rc.race_id, arr);
  }

  // ── 5. horse section ──────────────────────────────────────────────────────
  // Merge base horses row + profile_extra. profile_extra wins on enriched fields.
  const sire    = profileExtra?.sire     ?? pedigree?.sire     ?? horse.sire     ?? null;
  const dam     = profileExtra?.dam      ?? pedigree?.dam      ?? horse.dam      ?? null;
  const damSire = profileExtra?.dam_sire ?? pedigree?.dam_sire ?? horse.dam_sire ?? null;
  // country_of_origin: profile_extra has explicit column, horses table also has it; coalesce truthfully
  const countryOfOrigin = profileExtra?.country_of_origin ?? horse.country_of_origin ?? null;
  // import_type: profile_extra may have human-readable version
  const importType = profileExtra?.import_type ?? horse.import_type ?? null;
  const [profileColour, profileSex] = String(profileExtra?.colour_sex_raw ?? '')
    .split('/')
    .map((value) => value.trim());
  const colour = horse.colour ?? (profileColour || null);
  const sex = horse.sex ?? (profileSex || null);
  // last_race_date: prefer profile_extra explicit date
  const lastRaceDate = profileExtra?.last_race_date ?? (formRows.length > 0 ? formRows[0].date : null);
  // HKJC fixed profile is authoritative; trainer relation is a display fallback.
  // Never infer current trainer from the latest ride.
  const currentTrainer = profileExtra?.current_trainer
    ?? (trainerRow ? (trainerRow.name_ch || trainerRow.name_en || null) : null);

  const recordSource = careerStats?.source === 'profile'
    ? '補充馬匹檔案'
    : careerStats?.source === 'horse_form_records'
      ? '完整馬匹歷史賽績'
      : careerStats?.source === 'race_results'
        ? '標準化賽果紀錄'
        : null;
  const record = careerStats ? {
    wins: careerStats.totalWins,
    seconds: careerStats.totalSeconds,
    thirds: careerStats.totalThirds,
    totalStarts: careerStats.totalStarts,
  } : {
    wins: null,
    seconds: null,
    thirds: null,
    totalStarts: null,
  };

  const halfSiblingsRaw = profileExtra?.half_siblings ?? null;
  let halfSiblings: unknown = halfSiblingsRaw;
  if (typeof halfSiblingsRaw === 'string') {
    try {
      const parsed = JSON.parse(halfSiblingsRaw);
      halfSiblings = Array.isArray(parsed) ? parsed : halfSiblingsRaw;
    } catch {
      halfSiblings = halfSiblingsRaw;
    }
  }

  const horseSection = {
    id:              horse.id,
    code:            horse.code       ?? null,
    silksCode:       (horse as any).silks_code ?? horse.code ?? null,
    nameEn:          horse.name_en,
    nameCh:          horse.name_ch    ?? null,
    status:          profileExtra?.profile_status ?? horse.status,
    countryOfOrigin,
    colour,
    sex,
    importType,
    currentTrainer,
    owner:           profileExtra?.owner ?? null,
    // Flat pedigree fields AND nested object for consumers that prefer either
    sire,
    dam,
    damSire,
    pedigree:        { sire, dam, damSire },
    halfSiblings,
    currentRating:   horse.current_rating ?? profileExtra?.last_rating ?? null,
    lastRating:      profileExtra?.last_rating   ?? null,
    seasonStakes:    profileExtra?.season_stakes_int
      ?? (Number(horse.season_stakes) > 0 ? horse.season_stakes : null),
    totalStakes:     profileExtra?.total_stakes_int ?? null,
    record,
    lastRaceDate,
    updatedAt:       horse.updated_at ?? null,
  };

  // ── 6. recentForm section ─────────────────────────────────────────────────
  // Canonical camelCase contract — never exposes bodyWeight.
  const recentForm = formRows.map((f: any) => {
    const raceIdVal: string | null = f.race_id ?? null;
    return {
      date:            f.date            ?? null,
      raceId:          raceIdVal,
      venue:           f.venue           ?? null,
      raceNumber:      f.race_number     ?? null,
      raceClass:       f.race_class      ?? null,
      distance:        f.distance        ?? null,
      going:           f.going           ?? null,
      track:           f.track           ?? null,
      course:          f.course          ?? null,
      // position: normalized integer (null for non-finishers)
      position:        f.position_num    != null && (f.position_num as number) < 999 ? f.position_num : null,
      // positionText: raw text (may be 'PU', 'WV-A', '999', or numeric string) from hfr; null in fallback
      positionText:    String(f.finishing_position ?? f.position_num ?? '') === '999'
        ? null
        : (f.finishing_position ?? (f.position_num != null ? String(f.position_num) : null)),
      totalRunners:    f.total_runners   ?? null,
      horseNumber:     f.horse_number    ?? null,
      draw:            f.draw            ?? null,
      actualWeight:    carryingWeight(f.actual_weight),
      jockey:          f.jockey_name     ?? null,
      trainer:         f.trainer_name    ?? null,
      lbw:             f.lbw             ?? null,
      runningPosition: f.running_position ?? null,
      finishTime:      f.finish_time_text ?? null,
      finishTimeSec:   f.finish_time_sec  ?? null,
      winOdds:         f.win_odds        ?? null,
      gear:            f.gear            ?? null,
      rating:          f.rating          ?? null,
      comment:         raceIdVal
        ? (
            commentsMap.get(raceIdVal)?.find((comment) => comment.language === 'ch')?.text
            ?? commentsMap.get(raceIdVal)?.[0]?.text
            ?? null
          )
        : null,
      sectionals:      raceIdVal ? (sectionalsMap.get(raceIdVal) ?? []) : [],
    };
  });

  // ── 7. elo section ────────────────────────────────────────────────────────
  const eloSection = {
    latest: eloLatest
      ? {
          rating:      eloLatest.rating,
          asOfDate:    eloLatest.as_of_date,
          gamesPlayed: eloLatest.games_played ?? null,
        }
      : null,
    history: eloHistoryRows.map((e: any) => ({
      rating:      e.rating,
      asOfDate:    e.as_of_date,
      gamesPlayed: e.games_played ?? null,
    })),
  };

  // ── 8. performance aggregates (full career from horse_form_records) ────────
  // Use full-career rows only. horse_form_records is preferred; race_results is
  // the date-unbounded fallback. If both are unavailable, suppress aggregates.
  // Each row: distance, going, track, draw, jockey_name, pos (1-998).

  function distanceBucket(d: number | null | undefined): string | null {
    if (d == null) return null;
    if (d <= 1400) return '衝刺 ≤1400m';
    if (d <= 1800) return '一英里 1401-1800m';
    if (d <= 2000) return '中距離 1801-2000m';
    return '長途 >2000m';
  }

  function drawBand(draw: number | null | undefined): string | null {
    if (draw == null) return null;
    if (draw <= 4)  return '1-4';
    if (draw <= 8)  return '5-8';
    if (draw <= 12) return '9-12';
    return '13+';
  }

  interface PerfRow { starts: number; wins: number; top3: number }

  // careerPerfRows column names: distance, going, track, draw, jockey_name, pos
  const perfRows: any[] = careerPerfRows.filter((row: any) => {
    const position = Number(row.pos);
    return Number.isFinite(position) && position > 0 && position < 999;
  });
  const hasCareerData = perfRows.length > 0;
  const perfSource = hasCareerData
    ? (useHfrCareerPerf ? '完整馬匹歷史賽績（全生涯）' : '標準化賽果紀錄（全生涯）')
    : null;
  const perfPos = (r: any): number => r.pos;
  const perfTotal = perfRows.length;

  function aggregatePerf(
    keyFn: (r: any) => string | null,
    labelFn: (k: string) => string,
  ): { key: string; label: string; starts: number; wins: number; top3: number; winRate: number; top3Rate: number }[] {
    const map = new Map<string, PerfRow>();
    for (const r of perfRows) {
      const k = keyFn(r);
      if (k == null) continue;
      const cur = map.get(k) ?? { starts: 0, wins: 0, top3: 0 };
      cur.starts++;
      const p = perfPos(r);
      if (p === 1) cur.wins++;
      if (p <= 3)  cur.top3++;
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].starts - a[1].starts)
      .map(([key, stats]) => ({
        key,
        label: labelFn(key),
        starts:   stats.starts,
        wins:     stats.wins,
        top3:     stats.top3,
        winRate:  stats.starts > 0 ? Math.round((stats.wins / stats.starts) * 1000) / 10 : 0,
        top3Rate: stats.starts > 0 ? Math.round((stats.top3 / stats.starts) * 1000) / 10 : 0,
      }));
  }

  const performanceSection = {
    note:          perfSource ? `來源：${perfSource}。僅計算有效完成名次（1-998）。` : null,
    totalStarts:   perfTotal,
    validStarts:   perfTotal,
    distance:      aggregatePerf(
      (r) => r.distance != null ? `${r.distance}m` : null,
      (k) => `距離 ${k}`,
    ),
    distanceBucket: aggregatePerf(
      (r) => distanceBucket(r.distance),
      (k) => k,
    ),
    track:         aggregatePerf(
      (r) => r.track ?? null,
      (k) => `跑道 ${k}`,
    ),
    going:         aggregatePerf(
      (r) => r.going ?? null,
      (k) => `場地 ${k}`,
    ),
    draw:          aggregatePerf(
      (r) => drawBand(r.draw),
      (k) => `檔位 ${k}`,
    ),
    jockey:        aggregatePerf(
      (r) => r.jockey_name ?? null,
      (k) => `騎師 ${k}`,
    ),
  };

  // ── 9. training section ───────────────────────────────────────────────────
  const trainingSection = {
    trackwork: trackworkRows.map((tw: any) => ({
      date:     tw.trackwork_date,
      venue:    tw.venue    ?? null,
      batch:    tw.batch    ?? null,
      distance: tw.distance ?? null,
      // display-friendly: timeText is the raw string; timeSec is normalized
      time:     tw.time_text ?? (tw.time_sec != null ? String(tw.time_sec) : null),
      timeText: tw.time_text ?? null,
      timeSec:  tw.time_sec  ?? null,
      partner:  tw.partner  ?? null,
      comment:  tw.comment  ?? null,
    })),
    barrierTrials: trialRows.map((tr: any) => ({
      date:     tr.trial_date,
      venue:    tr.venue    ?? null,
      distance: tr.distance ?? null,
      going:    tr.going    ?? null,
      track:    tr.track    ?? null,
      // position (not finishingPosition) per spec
      position: tr.finishing_position ?? null,
      time:     tr.time_text ?? (tr.time_sec != null ? String(tr.time_sec) : null),
      timeText: tr.time_text ?? null,
      timeSec:  tr.time_sec  ?? null,
      jockey:   tr.jockey_name ?? null,
      lbw:      tr.lbw  ?? null,
      gear:     tr.gear ?? null,
      comment:  tr.comment ?? null,
    })),
  };

  // ── 10. health section ────────────────────────────────────────────────────
  const healthSection = {
    coverageNote: '傷病記錄來自現有資料來源，較早期或未公開的傷患紀錄可能未被收錄，覆蓋範圍不保證完整。',
    injuries: injuryRows.map((inj: any) => {
      const resolved = inj.resolution_date != null;
      const status   = resolved ? 'resolved' : 'ongoing';
      return {
        date:           inj.injury_date,
        type:           inj.injury_type     ?? null,
        resolutionDate: inj.resolution_date ?? null,
        daysOut:        inj.days_out        ?? null,
        description:    inj.description     ?? null,
        status,
      };
    }),
  };

  // ── 11. researchSignals section (zh-HK labels, allow-list only) ───────────
  type Signal = {
    key: string;
    label: string;
    value: number | string | null;
    unit?: string;
    asOf: string | null;
    sampleSize: number | null;
    source: string;
    explanation: string;
  };
  const signals: Signal[] = [];

  // Signal: overall Elo
  if (eloLatest?.rating != null) {
    signals.push({
      key:         'overallElo',
      label:       '綜合 Elo 評分',
      value:       Math.round((eloLatest.rating as number) * 10) / 10,
      asOf:        eloLatest.as_of_date ?? null,
      sampleSize:  eloLatest.games_played ?? null,
      source:      '天喜 Elo 歷史評分',
      explanation: '根據歷次賽事完成名次計算，反映馬匹相對競爭實力。評分越高代表越強，長期休賽會令評分隨時間遞減。',
    });
  }

  // Signal: official rating
  if (horse.current_rating != null) {
    signals.push({
      key:         'officialRating',
      label:       '官方讓磅評分',
      value:       horse.current_rating,
      asOf:        horse.updated_at ? (horse.updated_at as string).substring(0, 10) : null,
      sampleSize:  record.totalStarts ?? null,
      source:      '香港賽馬會官方評分',
      explanation: '香港賽馬會官方讓磅評分，評分越高代表被評估為越強，用作分配出賽組別。',
    });
  }

  // Signal: career win rate
  const totalStarts = record.totalStarts ?? 0;
  const totalWins   = record.wins        ?? 0;
  if (totalStarts > 0) {
    signals.push({
      key:         'careerWinRate',
      label:       '生涯勝率',
      value:       Math.round((totalWins / totalStarts) * 1000) / 10,
      unit:        '%',
      asOf:        null,
      sampleSize:  totalStarts,
      source:      '馬匹生涯戰績',
      explanation: '生涯出賽中頭名次數佔總出賽場數的百分比（%）。',
    });
  }

  // Signal: career top-3 rate (only when record_seconds/thirds available)
  if (totalStarts > 0 && record.seconds != null && record.thirds != null) {
    const top3    = totalWins + (record.seconds as number) + (record.thirds as number);
    const top3Pct = Math.round((top3 / totalStarts) * 1000) / 10;
    signals.push({
      key:         'careerTop3Rate',
      label:       '生涯三甲率',
      value:       top3Pct,
      unit:        '%',
      asOf:        null,
      sampleSize:  totalStarts,
      source:      '馬匹生涯戰績',
      explanation: '生涯出賽中完成前三名次數佔總出賽場數的百分比（%）。',
    });
  }

  // Signal: recent form top-3 rate (display window)
  const validRecentRows = formRows.filter((f: any) => {
    const p = f.position_num;
    return p != null && p > 0 && p < 999;
  });
  if (validRecentRows.length > 0) {
    const recentTop3  = validRecentRows.filter((f: any) => (f.position_num as number) <= 3).length;
    const recentPct   = Math.round((recentTop3 / validRecentRows.length) * 1000) / 10;
    signals.push({
      key:         'recentTop3Rate',
      label:       `近期三甲率（最近 ${validRecentRows.length} 場）`,
      value:       recentPct,
      unit:        '%',
      asOf:        formRows.length > 0 ? formRows[0].date : null,
      sampleSize:  validRecentRows.length,
      source:      '馬匹近期賽績',
      explanation: `過去 ${validRecentRows.length} 場有效出賽中三甲完成的百分比（%），屬歷史數據。`,
    });
  }

  // Signal: best distance bucket from full career data
  if (performanceSection.distanceBucket.length > 0) {
    const bestDist = performanceSection.distanceBucket
      .filter((b) => b.starts >= 3)
      .sort((a, b) => b.top3Rate - a.top3Rate)[0] ?? null;
    if (bestDist) {
      signals.push({
        key:         'bestDistanceBucket',
        label:       '最佳距離區間（≥3 場）',
        value:       bestDist.key,
        asOf:        null,
        sampleSize:  bestDist.starts,
        source:      '馬匹歷史賽績',
        explanation: `三甲率最高的距離區間，僅在該區間出賽達 3 場或以上時顯示（三甲率 ${bestDist.top3Rate}%）。`,
      });
    }
  }

  // Signal: best track/surface from full career data
  if (performanceSection.track.length > 0) {
    const bestTrack = performanceSection.track
      .filter((t) => t.starts >= 3)
      .sort((a, b) => b.top3Rate - a.top3Rate)[0] ?? null;
    if (bestTrack) {
      signals.push({
        key:         'bestSurface',
        label:       '最佳場地類型（≥3 場）',
        value:       bestTrack.key,
        asOf:        null,
        sampleSize:  bestTrack.starts,
        source:      '馬匹歷史賽績',
        explanation: `三甲率最高的場地類型，僅在該場地出賽達 3 場或以上時顯示（三甲率 ${bestTrack.top3Rate}%）。`,
      });
    }
  }

  // ── 12. raceContext section ───────────────────────────────────────────────
  // Flat object; null when raceId not supplied or not matched.
  let raceContextSection: {
    raceId: string;
    raceDate: string | null;
    venue: string | null;
    raceNumber: number | null;
    distance: number | null;
    raceClass: string | null;
    horseNumber: number | null;
    draw: number | null;
    jockey: string | null;
    trainer: string | null;
    actualWeight: number | null;
    gear: string | null;
    rating: number | null;
  } | null = null;

  if (raceId && raceCtxRaw) {
    const e = raceCtxRaw.entry;
    raceContextSection = {
      raceId,
      raceDate:      e.race_date    ?? null,
      venue:         e.venue        ?? null,
      raceNumber:    e.race_number  ?? null,
      distance:      e.distance     ?? null,
      raceClass:     e.race_class   ?? null,
      horseNumber:   e.horse_number ?? null,
      draw:          e.draw         ?? null,
      jockey:        e.jockey_name  ?? null,
      trainer:       e.trainer_name ?? null,
      // entries_upcoming stores carrying weight in declared_weight, while
      // race_results stores it in actual_weight. Normalize both to one public
      // carrying-weight field and reject body-weight-scale values.
      actualWeight:  raceCtxRaw.source === 'upcoming'
        ? carryingWeight(e.declared_weight)
        : carryingWeight(e.actual_weight),
      gear:          e.gear         ?? null,
      rating:        e.rating       ?? null,
    };
  }

  // ── 13. meta section ──────────────────────────────────────────────────────
  // dataAsOf = freshest real date across form / trackwork / trials / injury / Elo / profile
  const allDates: string[] = [];
  if (formRows.length > 0 && formRows[0].date) allDates.push(formRows[0].date as string);
  if (trackworkRows.length > 0 && trackworkRows[0].trackwork_date) allDates.push(trackworkRows[0].trackwork_date as string);
  if (trialRows.length > 0 && trialRows[0].trial_date) allDates.push(trialRows[0].trial_date as string);
  if (injuryRows.length > 0 && injuryRows[0].injury_date) allDates.push(injuryRows[0].injury_date as string);
  if (eloLatest?.as_of_date) allDates.push(eloLatest.as_of_date as string);
  if (profileExtra?.last_race_date) allDates.push(profileExtra.last_race_date as string);
  if (profileExtra?.profile_last_scraped) allDates.push(profileExtra.profile_last_scraped as string);
  const dataAsOf = allDates.length > 0 ? allDates.sort().reverse()[0] : null;

  const sources: string[] = ['馬匹基本資料'];
  if (profileExtra)                   sources.push('香港賽馬會公開馬匹資料');
  if (!profileExtra && pedigree)      sources.push('香港賽馬會公開血統資料');
  if (eloLatest)                      sources.push('天喜 Elo 歷史評分');
  if (formRows.length > 0)            sources.push(formSource);
  if (useHfrCareerPerf)               sources.push('完整馬匹歷史賽績');
  if (!useHfrCareerPerf && rrCareerPerfRows.length > 0) sources.push('標準化賽果紀錄');
  if (commentsRows.length > 0)        sources.push('賽後評語');
  if (trackworkRows.length > 0)       sources.push('晨操紀錄');
  if (trialRows.length > 0)           sources.push('試閘紀錄');
  if (injuryRows.length > 0)          sources.push('公開傷患紀錄');
  if (sectionalsRows.length > 0)      sources.push('賽後分段時間');
  if (raceContextSection && raceId)   sources.push('指定場次排位／賽果');
  if (currentTrainer)                 sources.push('練馬師資料');

  const coverageNotes: string[] = [
    `recentForm 顯示最多 ${formLimit} 場（查詢參數 limit，上限 50）。`,
    `近績來源：${formSource}${useHfr ? '' : '（完整歷史檔案未有可用資料，已使用標準化賽果）'}。`,
    '每場個別騎師／練馬師／馬鞍位／磅重僅在資料存在時顯示。',
    '馬匹分段時間僅在公開賽後分段資料有對應記錄時納入。',
    '傷病記錄可能不完整，不涵蓋所有歷史或未公開傷患。',
    '試閘騎師資料為公開文字記錄，不保證與人物資料完全對應。',
    ...(perfSource ? [
      `performance 統計來源：${perfSource}。`,
      `performance 邊界：recentForm 顯示視窗最多 ${formLimit} 場；表現統計使用獨立、日期不設限的全生涯查詢。`,
    ] : []),
    `生涯冠亞季／出賽來源：${recordSource ?? '無可核實資料'}；所有欄位採用同一資料快照。`,
  ];

  const metaSection = {
    generatedAt: new Date().toISOString(),
    dataAsOf,
    sources: Array.from(new Set(sources)),
    profile: profileExtra ? {
      source: '香港賽馬會公開馬匹資料',
      sourceUrl: `https://racing.hkjc.com/racing/information/Chinese/Horse/Horse.aspx?HorseNo=${encodeURIComponent(horse.code ?? id)}`,
      dataAsOf: profileExtra.profile_last_scraped ?? null,
      checkedAt: profileExtra.profile_checked_at ?? null,
      sourceCommit: profileExtra.source_commit ?? null,
      availableFields: [
        countryOfOrigin ? 'countryOfOrigin' : null,
        colour ? 'colour' : null,
        sex ? 'sex' : null,
        importType ? 'importType' : null,
        currentTrainer ? 'currentTrainer' : null,
        profileExtra.owner ? 'owner' : null,
        sire ? 'sire' : null,
        dam ? 'dam' : null,
        damSire ? 'damSire' : null,
        profileExtra.season_stakes_int != null || Number(horse.season_stakes) > 0 ? 'seasonStakes' : null,
        profileExtra.total_stakes_int != null ? 'totalStakes' : null,
      ].filter(Boolean),
    } : null,
    coverageNotes,
    counts: {
      formStarts:       formRows.length,
      commentsRows:     commentsRows.length,
      eloHistoryPoints: eloHistoryRows.length,
      careerPerfStarts: perfRows.length,
      trackworkSessions: trackworkRows.length,
      barrierTrials:    trialRows.length,
      injuryRecords:    injuryRows.length,
      sectionalsRows:   sectionalsRows.length,
    },
    postRaceHistoryBoundary: perfSource
      ? `recentForm 最多返回 ${formLimit} 場歷史出賽；performance 使用日期不設限的全生涯資料。`
      : `recentForm 最多返回 ${formLimit} 場歷史出賽；沒有完整生涯來源時不提供 performance 統計。`,
  };

  // ── 14. Assemble response ─────────────────────────────────────────────────
  return c.json({
    horse:           horseSection,
    recentForm,
    elo:             eloSection,
    performance:     performanceSection,
    training:        trainingSection,
    health:          healthSection,
    researchSignals: signals,
    raceContext:     raceContextSection,
    meta:            metaSection,
  });
});

// GET /api/horses/search?q=金 — 搜索馬匹
horsesRoutes.get('/search/query', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json({ error: '請提供搜索關鍵字' }, 400);
  }

  const { results } = await c.env.DB.prepare(`
    ${HORSE_CAREER_STATS_CTE}
    SELECT h.*, cs.total_wins AS verified_wins,
           cs.total_seconds AS verified_seconds,
           cs.total_thirds AS verified_thirds,
           cs.total_starts AS verified_starts
    FROM horses h
    LEFT JOIN career_stats cs ON cs.horse_id = h.id
    WHERE h.name_ch LIKE ? OR h.name_en LIKE ? OR h.code LIKE ?
    ORDER BY cs.total_starts IS NULL, cs.total_starts DESC
    LIMIT 20
  `).bind(`%${q}%`, `%${q}%`, `%${q}%`).all();

  return c.json({
    horses: (results ?? []).map((h: any) => ({
      id: h.id,
      nameEn: h.name_en,
      nameCh: h.name_ch,
      code: h.code,
      currentRating: h.current_rating,
      totalWins: h.verified_wins ?? null,
      totalSeconds: h.verified_seconds ?? null,
      totalThirds: h.verified_thirds ?? null,
      totalStarts: h.verified_starts ?? null,
      status: h.status,
    })),
  });
});
