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
  import { computeHitRateStats, ensureHitRateCacheTable, writeHitRateCache, readHitRateCache } from './routes/analyze';

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
          AND c.date IS NULL
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

  export default {
    fetch: app.fetch,
    async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
      ctx.waitUntil(
        refreshHitRateCache(env).then((r) => console.log('[cron] hit-rate refresh', r)),
      );
    },
  };
