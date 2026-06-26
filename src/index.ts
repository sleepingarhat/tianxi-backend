import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types';
import { meetingsRoutes } from './routes/meetings';
import { racesRoutes } from './routes/races';
import { horsesRoutes } from './routes/horses';
import { jockeysRoutes } from './routes/jockeys';
import { trainersRoutes } from './routes/trainers';
import { chatRoutes } from './routes/chat';
import { analyzeRoutes } from './routes/analyze';
import { oddsRoutes } from './routes/odds';
import { loungeRoutes } from './routes/lounge';
import { silksRoutes } from './routes/silks';
import { silksSvgRoutes } from './routes/silks_svg';
import { adminRoutes } from './routes/admin';
  import { computeHitRateStats, ensureHitRateCacheTable, writeHitRateCache, readHitRateCache, ensureRaceDayReportCacheTable, joinPredictionResults, ensurePredictionLogTable } from './routes/analyze';

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Health check
app.get('/', (c) => {
  return c.json({
    name: '天喜娛樂 Tianxi Entertainment API',
    version: '1.0.0',
    status: 'ok',
  });
});

// API Routes
app.route('/api/meetings', meetingsRoutes);
app.route('/api/races', racesRoutes);
app.route('/api/horses', horsesRoutes);
app.route('/api/jockeys', jockeysRoutes);
app.route('/api/trainers', trainersRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/analyze', analyzeRoutes);
app.route('/api/odds', oddsRoutes);
app.route('/api/lounge', loungeRoutes);
app.route('/api/silks', silksRoutes);
app.route('/api/silks-svg', silksSvgRoutes);
app.route('/admin', adminRoutes);

// 404
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ── Scheduled cron: refresh past-meeting hit-rate cache ─────────────
  // Runs daily 03:00 HKT. Backfills up to 12 oldest past meetings per tick;
  // once caught up, only newly-finalised meetings need (re)computing.
  async function refreshHitRateCache(env: Env): Promise<{ refreshed: number; errors: number }> {
    await ensureHitRateCacheTable(env.DB);
    const today = new Date().toISOString().substring(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT m.date FROM race_meetings m
         LEFT JOIN meeting_hit_rate_cache c ON c.date = m.date AND c.engine = 'v12'
        WHERE m.date < ?
          AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
                       WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
          AND (c.date IS NULL OR c.payload_json NOT LIKE '%quinellaHits%')
        ORDER BY m.date DESC LIMIT 12`
    ).bind(today).all<{ date: string }>();
    let refreshed = 0, errors = 0;
    for (const row of (results ?? [])) {
      try {
        const r = await computeHitRateStats(env.DB, row.date, 'v12', undefined, { boxPayouts: true });
        if ('error' in r) { errors++; continue; }
        await writeHitRateCache(env.DB, row.date, 'v12', r);
        refreshed++;
      } catch { errors++; }
    }
    return { refreshed, errors };
  }

  // Manual trigger endpoint for admin: POST /admin/api/refresh-hit-cache
  app.post('/admin/api/refresh-hit-cache', async (c) => {
    const out = await refreshHitRateCache(c.env);
    return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
  });
  // Surface cached lookup so admin can display "cache populated" without a DB hit elsewhere
  void readHitRateCache;

  // Backfill prediction_log with actual results for recent past meetings (last 7 days).
    async function backfillPredictionResults(env: Env): Promise<{ daysProcessed: number; totalUpdated: number }> {
      try {
        await ensurePredictionLogTable(env.DB);
        const today = new Date().toISOString().substring(0, 10);
        const { results } = await env.DB.prepare(
          `SELECT m.date FROM race_meetings m
             WHERE m.date < ?
               AND m.date >= date(?, '-7 days')
               AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
             ORDER BY m.date DESC`
        ).bind(today, today).all<{ date: string }>().catch(() => ({ results: [] as { date: string }[] }));
        let totalUpdated = 0;
        for (const row of (results ?? [])) {
          try { const r = await joinPredictionResults(env.DB, row.date); totalUpdated += r.updated; } catch {}
        }
        return { daysProcessed: results?.length ?? 0, totalUpdated };
      } catch (e: any) { return { daysProcessed: 0, totalUpdated: 0 }; }
    }

    // Manual trigger: POST /admin/api/backfill-prediction-results
    app.post('/admin/api/backfill-prediction-results', async (c) => {
      const out = await backfillPredictionResults(c.env);
      return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
    });

    // Pre-compute today's race-day report so admin page renders instantly.
  async function refreshRaceDayReport(env: Env): Promise<{ ok: boolean; date?: string; venue?: string; races?: number; computeMs?: number; seedSummary?: any; error?: string }> {
    try {
      await ensureRaceDayReportCacheTable(env.DB);
      const url = new URL('https://internal/api/analyze/today-picks?fresh=1');
      const req = new Request(url.toString(), { method: 'GET' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, error: data.error };
      return { ok: true, date: data.date, venue: data.venue, races: data.races?.length ?? 0, computeMs: data.computeMs, seedSummary: data.seedSummary };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  app.post('/admin/api/refresh-race-day-report', async (c) => {
    const out = await refreshRaceDayReport(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  // ── Odds retention (2026-05-27): keep ONLY the latest race day ──────
  // Engine does NOT use odds; they are reference/record-only. After each
  // race day's predictions + results are persisted, older odds are
  // expendable. Runs daily via cron AFTER hit-rate + prediction backfill,
  // so any same-day join is already done.
  // Policy: DELETE odds_snapshots / pool_totals rows WHERE race_date <
  // (SELECT MAX(race_date) ...). Single-day retention prevents D1 from
  // re-hitting the 10GB cap that wedged 5/27.
  async function pruneOddsToLatestDay(env: Env): Promise<{
    ok: boolean;
    keptDate: string | null;
    snapshotsDeleted: number;
    poolTotalsDeleted: number;
    error?: string;
  }> {
    try {
      const latest = await env.DB.prepare(
        `SELECT MAX(race_date) AS d FROM odds_snapshots`
      ).first<{ d: string | null }>();
      const keptDate = latest?.d ?? null;
      if (!keptDate) {
        return { ok: true, keptDate: null, snapshotsDeleted: 0, poolTotalsDeleted: 0 };
      }
      const r1 = await env.DB.prepare(
        `DELETE FROM odds_snapshots WHERE race_date < ?`
      ).bind(keptDate).run();
      const r2 = await env.DB.prepare(
        `DELETE FROM pool_totals WHERE race_date < ?`
      ).bind(keptDate).run().catch(() => ({ meta: { changes: 0 } } as any));
      return {
        ok: true,
        keptDate,
        snapshotsDeleted: (r1 as any)?.meta?.changes ?? 0,
        poolTotalsDeleted: (r2 as any)?.meta?.changes ?? 0,
      };
    } catch (e: any) {
      return { ok: false, keptDate: null, snapshotsDeleted: 0, poolTotalsDeleted: 0, error: e?.message ?? String(e) };
    }
  }

  // ── Downsampled odds ARCHIVE (2026-06-16) ──────────────────────────
  // Before the latest-day prune deletes the retention window, copy a thin
  // slice of WIN/PLA odds + pool_totals (first + last 6 snapshots per series
  // ≈ 7 timepoints) into permanent *_archive tables. Self-migrating
  // (CREATE TABLE IF NOT EXISTS) so no manual D1 migration is needed.
  // ~47MB/yr vs ~37GB/yr for full retention. The engine still ignores odds;
  // this is groundwork for a future market-drift signal. MUST run BEFORE prune.
  async function archiveOddsBeforePrune(env: Env): Promise<{
    ok: boolean;
    oddsArchived: number;
    poolTotalsArchived: number;
    error?: string;
  }> {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS odds_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, combination TEXT NOT NULL, odds REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_odds_archive_lookup ON odds_archive (race_date, venue, race_number, pool_type, combination, snapshot_at)`
      ).run();
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS pool_totals_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, total_investment REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pool_totals_archive_lookup ON pool_totals_archive (race_date, venue, race_number, pool_type, snapshot_at)`
      ).run();

      // WIN/PLA odds: keep first + last 6 snapshots per series for the days the
      // prune is about to delete (race_date < MAX). INSERT OR IGNORE on the
      // shared id → idempotent across cron ticks.
      const a1 = await env.DB.prepare(
        `INSERT OR IGNORE INTO odds_archive (id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at DESC) AS rn_desc
           FROM odds_snapshots
           WHERE pool_type IN ('WIN','PLA') AND race_date < (SELECT MAX(race_date) FROM odds_snapshots)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`
      ).run();

      // pool_totals (all pools — small money-flow signal): same downsample.
      const a2 = await env.DB.prepare(
        `INSERT OR IGNORE INTO pool_totals_archive (id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at DESC) AS rn_desc
           FROM pool_totals
           WHERE race_date < (SELECT MAX(race_date) FROM pool_totals)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`
      ).run();

      return {
        ok: true,
        oddsArchived: (a1 as any)?.meta?.changes ?? 0,
        poolTotalsArchived: (a2 as any)?.meta?.changes ?? 0,
      };
    } catch (e: any) {
      return { ok: false, oddsArchived: 0, poolTotalsArchived: 0, error: e?.message ?? String(e) };
    }
  }

  // Manual trigger for admin verification.
  app.post('/admin/api/prune-odds', async (c) => {
    const out = await pruneOddsToLatestDay(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  // Manual trigger for the downsampled odds archive (idempotent; safe anytime).
  app.post('/admin/api/archive-odds', async (c) => {
    const out = await archiveOddsBeforePrune(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  // ── Strategy-P&L aggregate warmup (2026-06-26) ─────────────────────
  // The /strategy-pnl per-day aggregate (synthetic key `__strategy_pnl_<from>`)
  // is only built lazily on the first visit after each new race day, and only
  // cached when pending===0 with to===today. After a race day's results land —
  // or once the UTC calendar day rolls over — that cache goes stale (to!==today),
  // so the next first-visitor eats a slow recompute. This warmup acts as a
  // synthetic daily visitor from the cron so a real cold load returns the cached
  // line instantly (全自動, no first-visitor penalty).
  //
  // Runs AFTER refreshHitRateCache so each newly-settled day's per-meeting
  // boxPayouts cache is fresh first; a single endpoint hit then re-aggregates
  // off those per-day caches and writes the synthetic aggregate row when
  // pending===0. A warm same-UTC-day cache short-circuits to `cached:true` (zero
  // work); a stale cache is rebuilt. We deliberately do ONE call (not a fill
  // loop) — the endpoint self-heals at most one pending day per request, so the
  // warmup never turns into a heavy backlog drain (any long historical backlog
  // is filled gradually by refreshHitRateCache + per-request self-heal, not here).
  async function warmStrategyPnl(env: Env): Promise<{ ok: boolean; pending: number; cached?: boolean; error?: string }> {
    try {
      const req = new Request('https://internal/api/analyze/strategy-pnl?refresh=1', { method: 'GET' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, pending: -1, error: data.error };
      return { ok: true, pending: Number(data?.pending ?? 0), cached: data?.cached === true };
    } catch (e: any) { return { ok: false, pending: -1, error: e?.message ?? String(e) }; }
  }

  // Manual trigger for the strategy-pnl warmup (idempotent; safe anytime).
  app.post('/admin/api/warm-strategy-pnl', async (c) => {
    const out = await warmStrategyPnl(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  export default {
    fetch: app.fetch,
    async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
      // Refresh per-meeting boxPayouts caches first, THEN warm the strategy-pnl
      // aggregate off those fresh per-day caches (chained, not a separate
      // waitUntil) so the aggregate never reads a half-filled day.
      ctx.waitUntil(
        refreshHitRateCache(env)
          .then((r) => console.log('[cron] hit-rate refresh', r))
          .then(() => warmStrategyPnl(env))
          .then((r) => console.log('[cron] strategy-pnl warmup', r)),
      );
      ctx.waitUntil(
        refreshRaceDayReport(env).then((r) => console.log('[cron] race-day report refresh', r)),
      );
      ctx.waitUntil(
        backfillPredictionResults(env).then((r) => console.log('[cron] prediction backfill', r)),
      );
      // Archive a thin WIN/PLA + pool_totals slice, THEN prune. Chained (not a
      // separate waitUntil) so the archive copy always finishes before the
      // prune deletes those rows. Archive is non-fatal (returns {ok:false}
      // instead of throwing) → prune still runs even if archiving fails.
      ctx.waitUntil(
        archiveOddsBeforePrune(env)
          .then((a) => console.log('[cron] odds archive', a))
          .then(() => pruneOddsToLatestDay(env))
          .then((r) => console.log('[cron] odds prune', r)),
      );
    },
  };


