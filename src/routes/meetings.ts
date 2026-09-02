import { Hono } from 'hono';
import type { Env, RaceMeetingRow } from '../types';
import { hhmmFromPostTime, fetchPostTimeMap } from '../lib/race-time';
import { fetchLatestWinOddsByRace, normHorseKey } from '../lib/market-blend';

export const meetingsRoutes = new Hono<{ Bindings: Env }>();

function venueName(v: string | null | undefined) {
  return v === 'ST' ? '沙田' : v === 'HV' ? '跑馬地' : v;
}

function toMeetingDto(m: RaceMeetingRow) {
  return {
    id: m.id,
    date: m.date,
    venue: m.venue,
    venueName: venueName(m.venue),
    trackCondition: m.track_condition,
    weather: m.weather,
    totalRaces: m.total_races,
  };
}

function isGhost(m: RaceMeetingRow) {
  const n = Number(m.total_races);
  return Number.isFinite(n) && n > 0 && n < 4;
}

async function declaredRaceCount(db: Env['DB'], date: string, venue: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        'SELECT COUNT(DISTINCT race_number) AS n FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number > 0'
      )
      .bind(date, venue)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

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

// GET /api/meetings — list. Keep the query cheap: no per-row subquery on
// entries_upcoming. That correlated COUNT + EXISTS 500'd D1 at limit=80.
meetingsRoutes.get('/', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const venue = c.req.query('venue');
  const month = c.req.query('month');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

  const run = async (heavy: boolean) => {
    let sql =
      'SELECT m.id, m.date, m.venue, m.track_condition, m.weather, m.total_races ' +
      "FROM race_meetings m WHERE m.venue IN ('ST','HV') ";
    const params: unknown[] = [];
    if (heavy) {
      sql += 'AND (m.total_races IS NULL OR m.total_races >= 4) ';
    }
    if (from) { sql += ' AND m.date >= ?'; params.push(from); }
    if (to) { sql += ' AND m.date <= ?'; params.push(to); }
    if (venue) { sql += ' AND m.venue = ?'; params.push(venue.toUpperCase()); }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      sql += ' AND substr(m.date, 1, 7) = ?';
      params.push(month);
    }
    sql += ' ORDER BY m.date DESC LIMIT ? OFFSET ?';
    params.push(limit + 16, offset);
    const { results } = await c.env.DB.prepare(sql).bind(...params).all<RaceMeetingRow>();
    return (results ?? []).filter((m) => !isGhost(m)).slice(0, limit).map(toMeetingDto);
  };

  try {
    const meetings = await run(true);
    return c.json({ meetings, total: meetings.length });
  } catch (err) {
    console.error('[meetings.list]', err);
    try {
      const meetings = await run(false);
      return c.json({ meetings, total: meetings.length, degraded: true });
    } catch (err2) {
      console.error('[meetings.list.fallback]', err2);
      return c.json({ meetings: [], total: 0, error: 'meetings_unavailable' }, 200);
    }
  }
});

meetingsRoutes.get('/next', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
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
      venueName: venueName(meeting.venue),
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
  } catch (err) {
    console.error('[meetings.next]', err);
    return c.json({ error: 'meetings_unavailable' }, 200);
  }
});

meetingsRoutes.get('/:date', async (c) => {
    const date = c.req.param('date');
    try {
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
      venueName: venueName(meeting.venue),
      trackCondition: meeting.track_condition,
      weather: meeting.weather,
      totalRaces,
      races: racesOut,
    });
    } catch (err) {
      console.error('[meetings.date]', err);
      return c.json({ error: '找不到該日期的賽事' }, 404);
    }
  });

meetingsRoutes.get('/next/upcoming', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
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
    venueName: venueName(meeting.venue),
    trackCondition: meeting.track_condition,
    weather: meeting.weather,
    totalRaces,
  });
  } catch (err) {
    console.error('[meetings.upcoming]', err);
    return c.json({ error: '暫時冇即將舉行的賽事' }, 404);
  }
});

meetingsRoutes.get('/smart/current', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
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
    venueName: venueName(pick.venue),
    trackCondition: pick.track_condition,
    weather: pick.weather,
    totalRaces,
    mode: isFuture ? 'upcoming' : 'historical',
    isEntryListOnly: isFuture,
  });
  } catch (err) {
    console.error('[meetings.smart]', err);
    return c.json({ error: '資料庫冇賽事紀錄' }, 404);
  }
});
