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

// 404
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;
