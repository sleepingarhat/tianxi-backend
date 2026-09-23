# Hit-rate stale cache — remaining splice

New helper already on this branch:
`src/lib/hit-rate-coverage-stale.ts`

`race_results` has **no usable updated_at**. Stale signal is coverage only:
`summary.racesEvaluated < COUNT(DISTINCT races with finishing_position > 0)`.
`computeHitRateStats` already skips races without actual top-3/4; do not change that.
Never rewrite frozen picks.

## 1) `src/routes/analyze.ts` GET `/hit-rate` (~line 3722)

Add import:

```ts
import { hitRateCacheNeedsCoverageRecompute } from '../lib/hit-rate-coverage-stale';
```

Change the cache-hit guard from:

```ts
if (cached && !hitRateCacheNeedsBoxRecompute(cached) && !hitRateCacheNeedsSourceRecompute(cached)) {
```

to:

```ts
if (
  cached &&
  !hitRateCacheNeedsBoxRecompute(cached) &&
  !hitRateCacheNeedsSourceRecompute(cached) &&
  !(await hitRateCacheNeedsCoverageRecompute(c.env.DB, date, cached))
) {
```

On next public read, a 4-race cache self-heals to 9. Cron is no longer the only path.

## 2) `src/index.ts` `refreshHitRateCache` (03:00 HKT job)

Same helper, optional belt-and-braces so admin page is warm without a GET:

```ts
import { hitRateCacheNeedsCoverageRecompute } from './lib/hit-rate-coverage-stale';
```

After selecting candidate dates (keep existing NULL / missing-quinellaHits query), skip write when helper is false. Or replace the SQL filter with:

```sql
OR IFNULL(c.races_evaluated, 0) < (
  SELECT COUNT(DISTINCT r.id)
    FROM races r
    JOIN race_results rr ON rr.race_id = r.id
   WHERE r.meeting_id = m.id AND rr.finishing_position > 0
)
```

and bind HKT today (`Date.now()+8h`) with `m.date <= ?` so a live meeting can refresh before UTC midnight.

## Verify item 2 (scraper skip)

Already on tianxi-database main. Next GHA results run should log:
`[skip-check] 2026-09-23 complete: races [1..9] == HKJC set -> skip`
If it re-scrapes, the R10 probe is not treating HKJC's R1 fallback as empty.

## Not this PR

`/explain/2026-09-23`, dev-log, roadmap.md — frontend. Live hit-rate already has 9 races after the manual recompute (`generatedAt=2026-09-23T20:17:36Z`).
