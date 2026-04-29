import { Hono } from 'hono';
import type { Env } from '../types';

export const loungeRoutes = new Hono<{ Bindings: Env }>();

// ---------- helpers ----------

function ulid(): string {
  // Simple ULID-like id (time-sortable, 26 chars).
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36)).join('');
  return (t + r).toUpperCase();
}

// Reject posts that look like HKJC bet-code shortcuts or are spammy URL dumps.
// Also reject obvious stake-advice phrases per constitutional platform scope.
const BET_CODE_RE = /\b[WPQTSFDCGHRKL]{1,2}[\s:\-]*\d{1,2}[\s,\-]+\d{1,2}\b/i;
const URL_RE = /https?:\/\/[^\s]+/gi;
const STAKE_RE = /(落|下注|買入|投注|買佢|買呢|買 ?\$)/;

function rejectContent(body: string): string | null {
  if (!body || !body.trim()) return '內容不能為空';
  if (body.length > 4000) return '內容過長（上限 4000 字）';
  if (BET_CODE_RE.test(body)) return '請勿分享投注碼（天喜為分析平台，不提供投注服務）';
  const urls = body.match(URL_RE) ?? [];
  if (urls.length > 3) return '外部連結過多（上限 3 條）';
  if (STAKE_RE.test(body)) return '請避免下注建議語句（用「睇好／分析／機率」代替）';
  return null;
}

function rejectHandle(handle: string): string | null {
  if (!handle || !handle.trim()) return '請提供顯示名稱';
  if (handle.length > 24) return '顯示名稱過長（上限 24 字）';
  return null;
}

// KV-backed per-IP rate limit. Gracefully no-op when KV binding missing.
async function rateLimit(
  env: Env,
  ip: string,
  kind: 'thread' | 'post',
): Promise<string | null> {
  const kv = (env as any).LOUNGE_RL as KVNamespace | undefined;
  if (!kv) return null;
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3600);
  const key = `rl:${kind}:${hour}:${ip}`;
  const limit = kind === 'thread' ? 5 : 30;
  const raw = await kv.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  if (n >= limit) return `速率限制：每小時最多 ${limit} 個${kind === 'thread' ? '主題' : '回覆'}`;
  await kv.put(key, String(n + 1), { expirationTtl: 3700 });
  return null;
}

function clientIp(c: any): string {
  return c.req.header('cf-connecting-ip')
    || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

// ---------- routes ----------

// GET /api/lounge/threads?category=&limit=20&offset=0
loungeRoutes.get('/threads', async (c) => {
  const category = c.req.query('category');
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);

  const where = category ? 'WHERE category = ?' : '';
  const binds: any[] = category ? [category] : [];

  const listStmt = c.env.DB.prepare(
    `SELECT id, title, category, race_date, horse_id, author_handle, reply_count,
            last_post_at, created_at, is_pinned, is_locked
     FROM lounge_threads
     ${where}
     ORDER BY is_pinned DESC, last_post_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset);

  const countStmt = c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lounge_threads ${where}`,
  ).bind(...binds);

  const [{ results }, total] = await Promise.all([
    listStmt.all(),
    countStmt.first<{ n: number }>(),
  ]);

  return c.json({
    threads: (results ?? []).map((r: any) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      raceDate: r.race_date,
      horseId: r.horse_id,
      authorHandle: r.author_handle,
      replyCount: r.reply_count,
      lastPostAt: r.last_post_at,
      createdAt: r.created_at,
      isPinned: !!r.is_pinned,
      isLocked: !!r.is_locked,
    })),
    total: total?.n ?? 0,
    limit,
    offset,
  });
});

// GET /api/lounge/threads/:id
loungeRoutes.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const thread = await c.env.DB.prepare(
    `SELECT * FROM lounge_threads WHERE id = ?`,
  ).bind(id).first<any>();
  if (!thread) return c.json({ error: '主題不存在' }, 404);

  const { results: posts } = await c.env.DB.prepare(
    `SELECT id, body, author_handle, author_id, created_at
     FROM lounge_posts
     WHERE thread_id = ? AND is_hidden = 0
     ORDER BY created_at ASC
     LIMIT 500`,
  ).bind(id).all();

  return c.json({
    thread: {
      id: thread.id,
      title: thread.title,
      category: thread.category,
      raceDate: thread.race_date,
      horseId: thread.horse_id,
      authorHandle: thread.author_handle,
      replyCount: thread.reply_count,
      lastPostAt: thread.last_post_at,
      createdAt: thread.created_at,
      isPinned: !!thread.is_pinned,
      isLocked: !!thread.is_locked,
    },
    posts: (posts ?? []).map((p: any) => ({
      id: p.id,
      body: p.body,
      authorHandle: p.author_handle,
      authorId: p.author_id,
      createdAt: p.created_at,
    })),
  });
});

// POST /api/lounge/threads
loungeRoutes.post('/threads', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { title, category, body: postBody, authorHandle, authorId, raceDate, horseId } = body ?? {};
  if (!title || typeof title !== 'string') return c.json({ error: '缺少 title' }, 400);
  if (title.length > 140) return c.json({ error: '標題過長（上限 140 字）' }, 400);
  if (!authorId) return c.json({ error: '缺少 authorId' }, 400);

  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);

  const ip = clientIp(c);
  const rlErr = await rateLimit(c.env, ip, 'thread');
  if (rlErr) return c.json({ error: rlErr }, 429);

  const threadId = ulid();
  const postId = ulid();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_threads (id, title, category, race_date, horse_id, author_handle, author_id, reply_count, last_post_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
    ).bind(threadId, title, category ?? 'general', raceDate ?? null, horseId ?? null, authorHandle, authorId),
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, threadId, postBody, authorHandle, authorId),
  ]);

  return c.json({ threadId, postId });
});

// ---------- Single global chatroom (simplified UX) ----------
// Uses a fixed thread id so existing schema is reused without migration.
const GLOBAL_ROOM_ID = 'GLOBAL_CHATROOM_0000000001';

async function ensureGlobalRoom(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lounge_threads
       (id, title, category, author_handle, author_id, reply_count, last_post_at)
     VALUES (?, '馬圈聊天室', 'general', '系統', 'system', 0, datetime('now'))`,
  ).bind(GLOBAL_ROOM_ID).run();
}

// GET /api/lounge/chat?since=<iso>&limit=100
loungeRoutes.get('/chat', async (c) => {
  await ensureGlobalRoom(c.env);
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 200);

  const stmt = since
    ? c.env.DB.prepare(
        `SELECT id, body, author_handle, author_id, created_at
         FROM lounge_posts
         WHERE thread_id = ? AND is_hidden = 0 AND created_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      ).bind(GLOBAL_ROOM_ID, since, limit)
    : c.env.DB.prepare(
        `SELECT id, body, author_handle, author_id, created_at
         FROM lounge_posts
         WHERE thread_id = ? AND is_hidden = 0
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(GLOBAL_ROOM_ID, limit);

  const { results } = await stmt.all();
  const posts = (results ?? []).map((p: any) => ({
    id: p.id,
    body: p.body,
    authorHandle: p.author_handle,
    authorId: p.author_id,
    createdAt: p.created_at,
  }));
  // When not using `since`, we fetched newest first — flip back to chronological.
  if (!since) posts.reverse();

  return c.json({ posts, roomId: GLOBAL_ROOM_ID });
});

// POST /api/lounge/chat
loungeRoutes.post('/chat', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { body: postBody, authorHandle, authorId } = body ?? {};
  if (!authorId) return c.json({ error: '請先設定暱稱' }, 400);

  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);

  const ip = clientIp(c);
  const rlErr = await rateLimit(c.env, ip, 'post');
  if (rlErr) return c.json({ error: rlErr }, 429);

  await ensureGlobalRoom(c.env);
  const postId = ulid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, GLOBAL_ROOM_ID, postBody, authorHandle, authorId),
    c.env.DB.prepare(
      `UPDATE lounge_threads SET reply_count = reply_count + 1, last_post_at = datetime('now')
       WHERE id = ?`,
    ).bind(GLOBAL_ROOM_ID),
  ]);

  return c.json({ postId });
});

// POST /api/lounge/threads/:id/posts
loungeRoutes.post('/threads/:id/posts', async (c) => {
  const threadId = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { body: postBody, authorHandle, authorId } = body ?? {};
  if (!authorId) return c.json({ error: '缺少 authorId' }, 400);

  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);

  const thread = await c.env.DB.prepare(
    `SELECT id, is_locked FROM lounge_threads WHERE id = ?`,
  ).bind(threadId).first<any>();
  if (!thread) return c.json({ error: '主題不存在' }, 404);
  if (thread.is_locked) return c.json({ error: '主題已鎖定' }, 403);

  const ip = clientIp(c);
  const rlErr = await rateLimit(c.env, ip, 'post');
  if (rlErr) return c.json({ error: rlErr }, 429);

  const postId = ulid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, threadId, postBody, authorHandle, authorId),
    c.env.DB.prepare(
      `UPDATE lounge_threads SET reply_count = reply_count + 1, last_post_at = datetime('now')
       WHERE id = ?`,
    ).bind(threadId),
  ]);

  return c.json({ postId });
});
