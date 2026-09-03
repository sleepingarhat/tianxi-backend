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
import { auditPredictionLock, freezeExplainPayload, freezeMeetingPayload, freezeTopPicksPayload } from './lib/prediction-lock-db';

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

async function overlayFrozenAnalyzeJson(
  c: any,
  next: () => Promise<void>,
  transform: (db: D1Database, data: any) => Promise<any>,
) {
  await next();
  if (c.res.status !== 200) return;
  const ct = c.res.headers.get('content-type') || '';
  if (!ct.includes('json')) return;
  const data = await c.res.clone().json().catch(() => null);
  if (!data || data.error) return;
  try {
    const out = await transform(c.env.DB, data);
    return c.json(out);
  } catch (err) {
    console.warn('[prediction-lock] overlay failed', err);
  }
}

app.get('/api/analyze/prediction-lock', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: '請提供 date' }, 400);
  const engine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
  const audit = await auditPredictionLock(c.env.DB, date, engine);
  return c.json(audit);
});

function analyzePathname(c: any): string {
  try {
    return new URL(c.req.url).pathname.replace(/\/+$/, '');
  } catch {
    return String(c.req.path || '').replace(/\/+$/, '');
  }
}

async function overlayFrozenAnalyzeByPath(c: any, next: () => Promise<void>) {
  await next();
  const path = analyzePathname(c);
  const db = c.env?.DB;
  if (!db) return;
  if (path.endsWith('/top-picks')) {
    return overlayFrozenAnalyzeJson(c, async () => {}, (d, data) => freezeTopPicksPayload(d, data));
  }
  if (path.endsWith('/today-picks') || path.endsWith('/picks-by-date')) {
    return overlayFrozenAnalyzeJson(c, async () => {}, (d, data) => freezeMeetingPayload(d, data));
  }
  if (path.endsWith('/explain')) {
    return overlayFrozenAnalyzeJson(c, async () => {}, (d, data) =>
      freezeExplainPayload(d, data, c.req.query('raceId'), c.req.query('horseId')),
    );
  }
}

analyzeRoutes.use('/top-picks', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeTopPicksPayload(db, data)),
);
analyzeRoutes.use('/today-picks', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeMeetingPayload(db, data)),
);
analyzeRoutes.use('/picks-by-date', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeMeetingPayload(db, data)),
);
analyzeRoutes.use('/explain', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) =>
    freezeExplainPayload(d, data, c.req.query('raceId'), c.req.query('horseId')),
  ),
);

app.use('/api/analyze/*', (c, next) => overlayFrozenAnalyzeByPath(c, next));

app.route('/api/analyze', analyzeRoutes);
