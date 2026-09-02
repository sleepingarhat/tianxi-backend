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
import { adminGateRoutes } from './routes/admin-gate';
import { opsRoutes } from './routes/ops';
import { membershipRoutes, proPage } from './routes/membership';
import { getSeasonStatus } from './lib/season';
import { ADMIN_AUTH_POLICY, buildAdminBearerHeaders, hasAdminAccess } from './lib/admin-auth';
  import { computeHitRateStats, ensureHitRateCacheTable, writeHitRateCache, readHitRateCache, ensureRaceDayReportCacheTable, joinPredictionResults, ensurePredictionLogTable, hitRateEngineKey } from './routes/analyze';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('*', logger((message, ...rest) => {
  const match = message.match(/^((?:<--|-->)\s+\S+\s+)(\S+)(.*)$/);
  const safeMessage = match
    ? `${match[1]}${match[2].split('?')[0]}${match[3]}`
    : message;
  console.log(safeMessage, ...rest);
}));

app.get('/', (c) => {
  return c.json({
    name: '天喜娛樂 Tianxi Entertainment API',
    version: '1.0.0',
    status: 'ok',
  });
});

app.get('/api/season', async (c) => {
  const s = await getSeasonStatus(c.env.DB);
  return c.json({
    ...s,
    label: s.status === 'off_season' ? '休季中' : '賽季進行中',
    checkedAt: new Date().toISOString(),
  });
});

app.post('/admin/api/set-season-mode', async (c) => {
  if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.BEARER_ONLY))) {
    return c.json({ error: 'unauthorized (Bearer required)' }, 401);
  }
  const mode = c.req.query('mode');
  if (mode !== 'auto' && mode !== 'in' && mode !== 'off') {
    return c.json({ error: "mode must be 'auto' | 'in' | 'off'", got: mode ?? null }, 400);
  }
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('season_mode', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(mode).run();
  const s = await getSeasonStatus(c.env.DB);
  return c.json({ ok: true, ...s, setAt: new Date().toISOString() });
});

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
app.route('/api/membership', membershipRoutes);
app.route('/ops', opsRoutes);
app.route('/admin', adminGateRoutes);
app.route('/admin', adminRoutes);

app.get('/pro', (c) => c.redirect('/pro/', 301));
app.get('/pro/', (c) => c.html(proPage(), 200, {
  'Cache-Control': 'no-store, private',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}));

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

  async function refreshHitRateCache(env: Env): Promise<{ refreshed: number; errors: number }> {
    await ensureHitRateCacheTable(env.DB);
    const today = new Date().toISOString().substring(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT m.date FROM race_meetings m
         LEFT JOIN meeting_hit_rate_cache c ON c.date = m.date AND c.engine = ?
        WHERE m.date < ?
          AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
                       WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
          AND (c.date IS NULL OR c.payload_json NOT LIKE '%quinellaHits%')
        ORDER BY m.date DESC LIMIT 12`
    ).bind(hitRateEngineKey('v12'), today).all<{ date: string }>();
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

  app.post('/admin/api/refresh-hit-cache', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await refreshHitRateCache(c.env);
    return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
  });
  void readHitRateCache;

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

    app.post('/admin/api/backfill-prediction-results', async (c) => {
      if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
      const out = await backfillPredictionResults(c.env);
      return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
    });

  async function refreshRaceDayReport(env: Env): Promise<{ ok: boolean; date?: string; venue?: string; races?: number; computeMs?: number; seedSummary?: any; error?: string }> {
    try {
      await ensureRaceDayReportCacheTable(env.DB);
      const url = new URL('https://internal/api/analyze/today-picks?fresh=1');
      const req = new Request(url.toString(), {
        method: 'GET',
        headers: buildAdminBearerHeaders(env),
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, error: data.error };
      return { ok: true, date: data.date, venue: data.venue, races: data.races?.length ?? 0, computeMs: data.computeMs, seedSummary: data.seedSummary };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  app.post('/admin/api/refresh-race-day-report', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await refreshRaceDayReport(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  async function pruneOddsToLatestDay(env: Env): Promise<{
    ok: boolean;
    keptDate: string | null;
    snapshotsDeleted: number;
    poolTotalsDeleted: number;
    error?: string;
  }> {
    try {
      const latest = await env.DB.prepare(`SELECT MAX(race_date) AS d FROM odds_snapshots`).first<{ d: string | null }>();
      const keptDate = latest?.d ?? null;
      if (!keptDate) {
        return { ok: true, keptDate: null, snapshotsDeleted: 0, poolTotalsDeleted: 0 };
      }
      const r1 = await env.DB.prepare(`DELETE FROM odds_snapshots WHERE race_date < ?`).bind(keptDate).run();
      const r2 = await env.DB.prepare(`DELETE FROM pool_totals WHERE race_date < ?`).bind(keptDate).run().catch(() => ({ meta: { changes: 0 } } as any));
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

  async function archiveOddsBeforePrune(env: Env): Promise<{
    ok: boolean;
    oddsArchived: number;
    poolTotalsArchived: number;
    error?: string;
  }> {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS odds_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, combination TEXT NOT NULL, odds REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_odds_archive_lookup ON odds_archive (race_date, venue, race_number, pool_type, combination, snapshot_at)`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pool_totals_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, total_investment REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pool_totals_archive_lookup ON pool_totals_archive (race_date, venue, race_number, pool_type, snapshot_at)`).run();
      const a1 = await env.DB.prepare(`INSERT OR IGNORE INTO odds_archive (id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at DESC) AS rn_desc
           FROM odds_snapshots
           WHERE pool_type IN ('WIN','PLA') AND race_date < (SELECT MAX(race_date) FROM odds_snapshots)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`).run();
      const a2 = await env.DB.prepare(`INSERT OR IGNORE INTO pool_totals_archive (id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at DESC) AS rn_desc
           FROM pool_totals
           WHERE race_date < (SELECT MAX(race_date) FROM pool_totals)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`).run();
      return { ok: true, oddsArchived: (a1 as any)?.meta?.changes ?? 0, poolTotalsArchived: (a2 as any)?.meta?.changes ?? 0 };
    } catch (e: any) {
      return { ok: false, oddsArchived: 0, poolTotalsArchived: 0, error: e?.message ?? String(e) };
    }
  }

  app.post('/admin/api/prune-odds', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await pruneOddsToLatestDay(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  app.post('/admin/api/archive-odds', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await archiveOddsBeforePrune(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  async function warmStrategyPnl(env: Env): Promise<{ ok: boolean; pending: number; cached?: boolean; error?: string }> {
    try {
      const req = new Request('https://internal/api/analyze/strategy-pnl?refresh=1', {
        method: 'GET',
        headers: buildAdminBearerHeaders(env),
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, pending: -1, error: data.error };
      return { ok: true, pending: Number(data?.pending ?? 0), cached: data?.cached === true };
    } catch (e: any) { return { ok: false, pending: -1, error: e?.message ?? String(e) }; }
  }

  app.post('/admin/api/warm-strategy-pnl', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await warmStrategyPnl(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  export default {
    fetch: app.fetch,
    async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
      ctx.waitUntil(
        refreshHitRateCache(env)
          .then((r) => console.log('[cron] hit-rate refresh', r))
          .then(() => warmStrategyPnl(env))
          .then((r) => console.log('[cron] strategy-pnl warmup', r)),
      );
      ctx.waitUntil(refreshRaceDayReport(env).then((r) => console.log('[cron] race-day report refresh', r)));
      ctx.waitUntil(backfillPredictionResults(env).then((r) => console.log('[cron] prediction backfill', r)));
      ctx.waitUntil(
        archiveOddsBeforePrune(env)
          .then((a) => console.log('[cron] odds archive', a))
          .then(() => pruneOddsToLatestDay(env))
          .then((r) => console.log('[cron] odds prune', r)),
      );
    },
  };
