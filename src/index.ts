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
        const r = await computeHitRateStats(env.DB, row.date, 'v12');
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

  export default {
    fetch: app.fetch,
    async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
      ctx.waitUntil(
        refreshHitRateCache(env).then((r) => console.log('[cron] hit-rate refresh', r)),
      );
      ctx.waitUntil(
        refreshRaceDayReport(env).then((r) => console.log('[cron] race-day report refresh', r)),
      );
      ctx.waitUntil(
        backfillPredictionResults(env).then((r) => console.log('[cron] prediction backfill', r)),
      );
      ctx.waitUntil(
          (async () => {
            try {
              const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM prediction_log WHERE variant IN ('baseline-bt','qimen-bt')`).first<{ c: number }>();
              if ((existing?.c ?? 0) === 0) {
                const r = await runBacktestRange(env.DB, 90, 'v12');
                console.log('[cron] auto-backtest first run', { days: r.days, races: r.totalRaces, baseline: r.totalBaselineRows, qimen: r.totalQimenRows, ms: r.elapsedMs });
              }
            } catch (e: any) {
              console.error('[cron] auto-backtest error', e?.message ?? e);
            }
          })()
        );
    },
  };

