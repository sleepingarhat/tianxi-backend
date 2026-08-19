export interface HorseCareerStats {
  horseId: string;
  totalWins: number;
  totalSeconds: number;
  totalThirds: number;
  totalStarts: number;
  source: 'profile' | 'horse_form_records' | 'race_results';
}

/**
 * Canonical, verified career snapshot used by every public horse endpoint.
 *
 * Source priority is deliberately whole-record rather than field-by-field:
 * 1. HKJC profile record when all four values are present and internally valid.
 * 2. Deduplicated horse_form_records (one row per horse/date/venue).
 * 3. Normalized race_results.
 *
 * The final CTE exposed to callers is `career_stats`.
 *
 * `buildHorseCareerStatsCTE(scoped)`:
 *  - unscoped (default) — used by index/search/leaderboard queries that need
 *    stats for arbitrary rows discovered by the outer query.
 *  - scoped — every source scan is limited to the horse ids supplied as a
 *    JSON-array bound parameter (`json_each`), so per-race / per-horse lookups
 *    do not aggregate the whole table on D1.
 */
function buildHorseCareerStatsCTE(scoped: boolean): string {
  const idFilter = scoped
    ? 'horse_id IN (SELECT value FROM scoped_ids)'
    : '1 = 1';
  return `
WITH
${scoped ? 'scoped_ids AS (SELECT value FROM json_each(?)),' : ''}
profile_stats AS (
  SELECT
    horse_id,
    CAST(record_wins AS INTEGER) AS total_wins,
    CAST(record_seconds AS INTEGER) AS total_seconds,
    CAST(record_thirds AS INTEGER) AS total_thirds,
    CAST(record_total_starts AS INTEGER) AS total_starts,
    'profile' AS source
  FROM horse_profile_extra
  WHERE ${idFilter}
    AND record_total_starts IS NOT NULL
    AND record_wins IS NOT NULL
    AND record_seconds IS NOT NULL
    AND record_thirds IS NOT NULL
    AND record_total_starts = CAST(record_total_starts AS INTEGER)
    AND record_wins = CAST(record_wins AS INTEGER)
    AND record_seconds = CAST(record_seconds AS INTEGER)
    AND record_thirds = CAST(record_thirds AS INTEGER)
    AND record_total_starts > 0
    AND record_wins >= 0
    AND record_seconds >= 0
    AND record_thirds >= 0
    AND record_wins <= record_total_starts
    AND record_seconds <= record_total_starts
    AND record_thirds <= record_total_starts
    AND record_wins + record_seconds + record_thirds <= record_total_starts
),
hfr_normalized AS (
  SELECT
    id,
    horse_id,
    race_date,
    UPPER(TRIM(COALESCE(venue, ''))) AS venue,
    race_number,
    race_id,
    match_confidence,
    ingested_at,
    UPPER(TRIM(COALESCE(finishing_position, ''))) AS raw_position,
    CAST(finishing_position_num AS INTEGER) AS numeric_position
  FROM horse_form_records
  WHERE ${idFilter}
),
hfr_ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY horse_id, race_date, venue
      ORDER BY
        CASE WHEN race_id IS NOT NULL AND race_id <> '' THEN 0 ELSE 1 END,
        CASE WHEN race_number BETWEEN 1 AND 20 THEN 0 ELSE 1 END,
        COALESCE(match_confidence, -1) DESC,
        COALESCE(ingested_at, '') DESC,
        id DESC
    ) AS duplicate_rank
  FROM hfr_normalized
),
hfr_outcomes AS (
  SELECT
    horse_id,
    COALESCE(
      CASE WHEN numeric_position > 0 THEN numeric_position END,
      CASE
        WHEN raw_position GLOB '[0-9]*' AND CAST(raw_position AS INTEGER) > 0
          THEN CAST(raw_position AS INTEGER)
      END
    ) AS placing,
    CASE
      WHEN raw_position LIKE 'WV%'
        OR raw_position LIKE 'WD%'
        OR raw_position LIKE 'SCR%'
        OR raw_position LIKE 'WITHDRAW%'
        THEN 0
      WHEN numeric_position > 0 THEN 1
      WHEN raw_position <> '' AND NOT (raw_position GLOB '[0-9]*') THEN 1
      WHEN raw_position GLOB '[0-9]*' AND CAST(raw_position AS INTEGER) > 0 THEN 1
      ELSE 0
    END AS is_start
  FROM hfr_ranked
  WHERE duplicate_rank = 1
),
hfr_stats AS (
  SELECT
    horse_id,
    SUM(CASE WHEN is_start = 1 AND placing = 1 THEN 1 ELSE 0 END) AS total_wins,
    SUM(CASE WHEN is_start = 1 AND placing = 2 THEN 1 ELSE 0 END) AS total_seconds,
    SUM(CASE WHEN is_start = 1 AND placing = 3 THEN 1 ELSE 0 END) AS total_thirds,
    SUM(is_start) AS total_starts,
    'horse_form_records' AS source
  FROM hfr_outcomes
  GROUP BY horse_id
  HAVING SUM(is_start) > 0
),
rr_stats AS (
  SELECT
    horse_id,
    SUM(CASE WHEN finishing_position = 1 THEN 1 ELSE 0 END) AS total_wins,
    SUM(CASE WHEN finishing_position = 2 THEN 1 ELSE 0 END) AS total_seconds,
    SUM(CASE WHEN finishing_position = 3 THEN 1 ELSE 0 END) AS total_thirds,
    COUNT(*) AS total_starts,
    'race_results' AS source
  FROM race_results
  WHERE ${idFilter}
    AND finishing_position IS NOT NULL
    AND finishing_position > 0
  GROUP BY horse_id
),
career_stats AS (
  SELECT * FROM profile_stats
  UNION ALL
  SELECT hfr.*
  FROM hfr_stats hfr
  WHERE NOT EXISTS (
    SELECT 1 FROM profile_stats profile WHERE profile.horse_id = hfr.horse_id
  )
  UNION ALL
  SELECT rr.*
  FROM rr_stats rr
  WHERE NOT EXISTS (
    SELECT 1 FROM profile_stats profile WHERE profile.horse_id = rr.horse_id
  )
    AND NOT EXISTS (
      SELECT 1 FROM hfr_stats hfr WHERE hfr.horse_id = rr.horse_id
    )
)
`;
}

export const HORSE_CAREER_STATS_CTE = buildHorseCareerStatsCTE(false);
const HORSE_CAREER_STATS_CTE_SCOPED = buildHorseCareerStatsCTE(true);

export async function getHorseCareerStats(
  db: D1Database,
  horseIds: string[],
): Promise<Map<string, HorseCareerStats>> {
  const ids = Array.from(new Set(horseIds.filter(Boolean)));
  if (ids.length === 0) return new Map();

  const { results } = await db.prepare(`
    ${HORSE_CAREER_STATS_CTE_SCOPED}
    SELECT horse_id, total_wins, total_seconds, total_thirds, total_starts, source
    FROM career_stats
  `).bind(JSON.stringify(ids)).all<any>();

  return new Map((results ?? []).map((row: any) => [
    row.horse_id,
    {
      horseId: row.horse_id,
      totalWins: Number(row.total_wins),
      totalSeconds: Number(row.total_seconds),
      totalThirds: Number(row.total_thirds),
      totalStarts: Number(row.total_starts),
      source: row.source,
    } satisfies HorseCareerStats,
  ]));
}