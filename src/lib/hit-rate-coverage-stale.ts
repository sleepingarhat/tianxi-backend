/**
 * True when cached hit-rate evaluated fewer races than D1 now has with a placing.
 * Used by GET /api/analyze/hit-rate and refreshHitRateCache. Never writes picks.
 *
 * race_results has no reliable updated_at; coverage count is the stale signal.
 * A race counts when at least one runner has finishing_position > 0.
 */
export async function countFinishedRaces(db: D1Database, date: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT r.id) AS n
       FROM race_meetings m
       JOIN races r ON r.meeting_id = m.id
       JOIN race_results rr ON rr.race_id = r.id
      WHERE m.date = ?
        AND rr.finishing_position > 0`,
  ).bind(date).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function hitRateCacheNeedsCoverageRecompute(
  db: D1Database,
  date: string,
  cached: any,
): Promise<boolean> {
  const evaluated = Number(cached?.summary?.racesEvaluated ?? cached?.races?.length ?? 0);
  const finished = await countFinishedRaces(db, date);
  return finished > 0 && evaluated < finished;
}
