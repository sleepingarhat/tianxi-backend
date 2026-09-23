# Hit-rate stale cache patch

Apply in `src/index.ts` inside `refreshHitRateCache` only.
Does **not** rewrite `prediction_log` / frozen picks.

## Why

Cron only refreshed when cache row was missing `quinellaHits`.
A mid-card cache (09-23 R1–R4) therefore never recomputed after R5–R9 landed.
`m.date < utcToday` also skipped the live meeting until UTC midnight.

## Replace the query block with

```ts
const hktToday = new Date(Date.now() + 8 * 3600_000).toISOString().substring(0, 10);
const { results } = await env.DB.prepare(
  `SELECT m.date FROM race_meetings m
     LEFT JOIN meeting_hit_rate_cache c ON c.date = m.date AND c.engine = ?
    WHERE m.date <= ?
      AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
                   WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
      AND (
        c.date IS NULL
        OR c.payload_json NOT LIKE '%quinellaHits%'
        OR IFNULL(c.races_evaluated, 0) < (
          SELECT COUNT(DISTINCT r.id)
            FROM races r
            JOIN race_results rr ON rr.race_id = r.id
           WHERE r.meeting_id = m.id
             AND rr.finishing_position > 0
        )
      )
    ORDER BY m.date DESC LIMIT 12`
).bind(hitRateEngineKey('v12'), hktToday).all<{ date: string }>();
```

Drop the old `const today = new Date().toISOString().substring(0, 10)` in this function.

## After merge

Deploy Workers, then existing cron / `POST /admin/api/refresh-hit-cache` will pick 09-23 if `races_evaluated` still lags finished races.

## Do not merge

Branch `fix/hitrate-stale-partial-cache` — `src/index.ts` was overwritten by a failed push. Delete that branch.
