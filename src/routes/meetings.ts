import { Hono } from 'hono';
import type { Env, RaceMeetingRow } from '../types';
import { hhmmFromPostTime, fetchPostTimeMap } from '../lib/race-time';
import { fetchLatestWinOddsByRace, normHorseKey } from '../lib/market-blend';

export const meetingsRoutes = new Hono<{ Bindings: Env }>();

// Declared race count from the upcoming entry list (racecard). Used when a
// meeting's races table isn't populated yet (pre-results) so single-meeting
// endpoints report the declared field size (e.g. 11 場) instead of 0/null,
// mirroring the COALESCE fallback already used by the list endpoint.
async function declaredRaceCount(db: Env['DB'], date: string, venue: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(DISTINCT race_number) AS n FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number > 0"
    )
    .bind(date, venue)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Pre-results racecard: the post-race `races` table is empty until results
// land, but the declared field (entries_upcoming) exists from the moment the
// racecard is published. Build race rows in the same shape as /:date so the
// dashboard RACE CARD + schedule featured meeting can show the day's races
// (field size, class, distance) BEFORE the meeting runs. Post times / going /
// prize are unknown pre-results and fill in once the races table is populated.
async function buildRacecardFromEntries(
  db: Env['DB'],
  date: string,
  venue: string,
  trackCondition: string | null,
): Promise<any[]> {
  const { results: rows } = await db.prepare(
    `SELECT
        e.race_number, e.race_class, e.distance, e.track, e.course,
        e.horse_id, e.horse_number, e.horse_code, e.draw,
        e.jockey_name, e.trainer_name, e.actual_weight, e.declared_weight,
        e.rating, e.gear, e.priority_order,
        h.name_en, h.name_ch, h.code, h.current_rating, h.sire, h.dam, h.dam_sire
       FROM entries_upcoming e
       LEFT JOIN horses h ON h.id = e.horse_id
      WHERE e.race_date = ? AND e.venue = ? AND e.race_number > 0
        AND (e.priority_order IS NULL OR e.priority_order NOT LIKE '後備%')
      ORDER BY e.race_number, e.horse_number`
  ).bind(date, venue).all<any>();

  const ptMap = await fetchPostTimeMap(db, date, venue);
  const oddsByRace = await fetchLatestWinOddsByRace(db, date, venue);

  const byRace = new Map<number, any[]>();
  for (const r of rows ?? []) {
    if (!byRace.has(r.race_number)) byRace.set(r.race_number, []);
    byRace.get(r.race_number)!.push(r);
  }

  return Array.from(byRace.keys()).sort((a, b) => a - b).map((rn) => {
    const entries = byRace.get(rn)!;
    const first = entries[0];
    return {
      id: `race_${date}_${venue}_${rn}`,
      raceNumber: rn,
      title: null,
      class: first.race_class ?? null,
      distance: first.distance ?? null,
      going: trackCondition ?? null,
      track: first.track ?? null,
      course: first.course ?? null,
      prize: null,
      startTime: hhmmFromPostTime(ptMap.get(rn)) ?? null,
      videoUrl: null,
      isDeclaredCard: true,
      horses: entries.map((e: any) => ({
        id: e.horse_id,
        horseNumber: e.horse_number,
        name: e.name_en,
        nameCh: e.name_ch,
        code: e.code ?? e.horse_code,
        draw: e.draw,
        jockey: e.jockey_name,
        jockeyCh: e.jockey_name,
        trainer: e.trainer_name,
        trainerCh: e.trainer_name,
        finishingPosition: null,
        finishTime: null,
        winOdds: oddsByRace.get(rn)?.odds.get(normHorseKey(e.horse_number)) ?? null,
        runningPosition: null,
        lbw: null,
        gear: e.gear,
        weight: e.declared_weight ?? e.actual_weight,
        rating: e.current_rating ?? e.rating,
        sire: e.sire,
        dam: e.dam,
        damSire: e.dam_sire,
      })),
    };
  });
}

// GET /api/meetings — 賽事日列表
// Query params: ?from=2026-01-01&to=2026-04-16&venue=ST&limit=20&offset=0
meetingsRoutes.get('/', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const venue = c.req.query('venue');
  const month = c.req.query('month'); // YYYY-MM
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  // FIX 2026-05-20 dup-row bug: (a) COALESCE total_races fallback to entries_upcoming
  // distinct race count for upcoming meetings whose races aren't populated yet;
  // (b) hide phantom meetings with neither races nor entries (legacy dirty data).
  let sql =
    'SELECT m.id, m.date, m.venue, m.track_condition, m.weather, ' +
    '  COALESCE(m.total_races, ' +
    '    (SELECT COUNT(DISTINCT race_number) FROM entries_upcoming ' +
    '     WHERE race_date = m.date AND venue = m.venue AND race_number > 0) ' +
    '  ) AS total_races ' +
    'FROM race_meetings m WHERE 1=1 ' +
    'AND ( ' +
    '  m.total_races IS NOT NULL ' +
    '  OR EXISTS (SELECT 1 FROM entries_upcoming WHERE race_date = m.date AND venue = m.venue AND race_number > 0) ' +
    ') ' +
    // Anti-ghost: a real HK race day ALWAYS has >=8 races, so a declared
    // total_races of 1-3 is always a phantom from a stale HKJC scrape (e.g.
    // 2026-05-31 ghost HV "1 場" carrying 2026-05-27's results). Hide it
    // unconditionally. (Old rule required a sibling meeting with MORE races,
    // which failed when the real same-date meeting was still upcoming with
    // total_races=NULL.)
    'AND NOT (m.total_races IS NOT NULL AND m.total_races > 0 AND m.total_races < 4) ' +
    // HK-only: never list overseas/simulcast venues (S1, S2, …). HK uses ST/HV.
    "AND m.venue IN ('ST','HV')";
  const params: unknown[] = [];

  if (from) {
    sql += ' AND date >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND date <= ?';
    params.push(to);
  }
  if (venue) {
    sql += ' AND venue = ?';
    params.push(venue.toUpperCase());
  }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    sql += " AND substr(date, 1, 7) = ?";
    params.push(month);
  }

  sql += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<RaceMeetingRow>();

  const meetings = (results ?? []).map((m) => ({
    id: m.id,
    date: m.date,
    venue: m.venue,
    venueName: m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : m.venue,
    trackCondition: m.track_condition,
    weather: m.weather,
    totalRaces: m.total_races,
  }));

  return c.json({ meetings, total: meetings.length });
});

// GET /api/meetings/next — Phase B · 下一個賽馬日（含每場概要）
// Returns next future-dated meeting with its races list (or latest past meeting if none upcoming).
meetingsRoutes.get('/next', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  let meeting = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  let fallback = false;
  if (!meeting) {
    meeting = await c.env.DB.prepare(
      "SELECT * FROM race_meetings WHERE venue IN ('ST','HV') ORDER BY date DESC LIMIT 1"
    ).first<RaceMeetingRow>();
    fallback = true;
  }

  if (!meeting) {
    return c.json({ error: '資料庫冇賽事紀錄' }, 404);
  }

  const { results: races } = await c.env.DB.prepare(
    'SELECT id, race_number, title, class, distance, going, track, course, start_time FROM races WHERE meeting_id = ? ORDER BY race_number'
  ).bind(meeting.id).all<any>();

  let totalRaces = (races ?? []).length || meeting.total_races;
  if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, meeting.date, meeting.venue);

  return c.json({
    id: meeting.id,
    date: meeting.date,
    venue: meeting.venue,
    venueName: meeting.venue === 'ST' ? '沙田' : meeting.venue === 'HV' ? '跑馬地' : meeting.venue,
    trackCondition: meeting.track_condition,
    weather: meeting.weather,
    totalRaces,
    fallback,
    races: (races ?? []).map((r) => ({
      id: r.id,
      raceNumber: r.race_number,
      title: r.title,
      className: r.class,
      distanceM: r.distance,
      going: r.going,
      track: r.track,
      course: r.course,
      startTime: r.start_time,
      handicapType: r.title || null,
    })),
  });
});

// GET /api/meetings/:date — 指定日期賽事詳情（含所有場次）
meetingsRoutes.get('/:date', async (c) => {
    const date = c.req.param('date');

    // Fix (2026-05-13): race_meetings has duplicate rows per date (legacy
    // ingestion bug). Naive .first() picks an arbitrary row whose id may not
    // match the new races. Pick the row with the highest race_count to
    // self-heal against duplicates.
    const { results: bestMeeting } = await c.env.DB.prepare(
      `SELECT rm.*, COUNT(r.id) AS _race_count
         FROM race_meetings rm
         LEFT JOIN races r ON r.meeting_id = rm.id
        WHERE rm.date = ? AND rm.venue IN ('ST','HV')
        GROUP BY rm.id
        ORDER BY _race_count DESC, rm.id DESC
        LIMIT 1`
    ).bind(date).all<RaceMeetingRow & { _race_count: number }>();
    const meeting = bestMeeting?.[0];

    if (!meeting) {
      return c.json({ error: '找不到該日期的賽事' }, 404);
    }

    const { results: races } = await c.env.DB.prepare(
      'SELECT * FROM races WHERE meeting_id = ? ORDER BY race_number'
    ).bind(meeting.id).all();

    // 每場賽事附帶出賽馬匹
    const ptMap = await fetchPostTimeMap(c.env.DB, meeting.date, meeting.venue);
    const racesWithHorses = await Promise.all(
      (races ?? []).map(async (race: any) => {
        const { results: entries } = await c.env.DB.prepare(`
          SELECT
            rr.*,
            h.name_en, h.name_ch, h.code, h.sire, h.dam, h.dam_sire,
            h.current_rating, h.age, h.sex,
            j.name_en AS jockey_en, j.name_ch AS jockey_ch,
            t.name_en AS trainer_en, t.name_ch AS trainer_ch
          FROM race_results rr
          JOIN horses h ON h.id = rr.horse_id
          LEFT JOIN jockeys j ON j.id = rr.jockey_id
          LEFT JOIN trainers t ON t.id = rr.trainer_id
          WHERE rr.race_id = ?
          ORDER BY rr.finishing_position ASC
        `).bind(race.id).all();

        return {
          id: race.id,
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
          })),
        };
      })
    );

    // Pre-results fallback: surface the declared racecard when the post-race
    // `races` table isn't populated yet, so upcoming meetings aren't blank.
    let racesOut: any[] = racesWithHorses;
    if (racesOut.length === 0) {
      racesOut = await buildRacecardFromEntries(
        c.env.DB, meeting.date, meeting.venue, meeting.track_condition,
      );
    }

    let totalRaces = racesOut.length || meeting.total_races;
    if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, meeting.date, meeting.venue);

    return c.json({
      id: meeting.id,
      date: meeting.date,
      venue: meeting.venue,
      venueName: meeting.venue === 'ST' ? '沙田' : meeting.venue === 'HV' ? '跑馬地' : meeting.venue,
      trackCondition: meeting.track_condition,
      weather: meeting.weather,
      totalRaces,
      races: racesOut,
    });
  });

// GET /api/meetings/next — 下一個賽馬日
meetingsRoutes.get('/next/upcoming', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  const meeting = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  if (!meeting) {
    return c.json({ error: '暫時冇即將舉行的賽事' }, 404);
  }

  let totalRaces = meeting.total_races;
  if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, meeting.date, meeting.venue);

  return c.json({
    id: meeting.id,
    date: meeting.date,
    venue: meeting.venue,
    venueName: meeting.venue === 'ST' ? '沙田' : meeting.venue === 'HV' ? '跑馬地' : meeting.venue,
    trackCondition: meeting.track_condition,
    weather: meeting.weather,
    totalRaces,
  });
});

// GET /api/meetings/smart/current — 智能優先級
// 優先返下一個未跑嘅賽馬日；如果冇，返最近一個已跑嘅
meetingsRoutes.get('/smart/current', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  const upcoming = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  const latest = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date < ? AND venue IN ('ST','HV') ORDER BY date DESC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  const pick = upcoming ?? latest;
  if (!pick) {
    return c.json({ error: '資料庫冇賽事紀錄' }, 404);
  }

  const isFuture = upcoming != null;
  let totalRaces = pick.total_races;
  if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, pick.date, pick.venue);
  return c.json({
    id: pick.id,
    date: pick.date,
    venue: pick.venue,
    venueName: pick.venue === 'ST' ? '沙田' : pick.venue === 'HV' ? '跑馬地' : pick.venue,
    trackCondition: pick.track_condition,
    weather: pick.weather,
    totalRaces,
    mode: isFuture ? 'upcoming' : 'historical',
    isEntryListOnly: isFuture, // 未開跑 = 只有排位表
  });
});
