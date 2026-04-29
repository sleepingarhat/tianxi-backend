import { Hono } from 'hono';
import type { Env } from '../types';

export const silksRoutes = new Hono<{ Bindings: Env }>();

// 1×1 transparent GIF fallback
const EMPTY_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

const HKJC_SILKS_BASE = 'https://racing.hkjc.com/racing/content/Images/RaceColor/';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// GET /api/silks/:code.gif — proxy HKJC silks with D1 blob cache (if table exists)
silksRoutes.get('/:code{.+\\.gif}', async (c) => {
  const param = c.req.param('code');
  // Strip .gif suffix, validate K-code shape (e.g. K059, H123)
  const code = param.replace(/\.gif$/i, '').toUpperCase();
  if (!/^[A-Z]\d{2,4}$/.test(code)) {
    return new Response(EMPTY_GIF, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=300',
        'X-Silks-Source': 'fallback-invalid',
      },
    });
  }

  // Try D1 cache first (silks_cache table may not exist yet — tolerate)
  try {
    const cached = await c.env.DB.prepare(
      'SELECT blob, etag, fetched_at FROM silks_cache WHERE code = ?'
    ).bind(code).first<any>();
    if (cached?.blob) {
      const age = cached.fetched_at
        ? Math.floor((Date.now() - new Date(cached.fetched_at).getTime()) / 1000)
        : 0;
      if (age < CACHE_TTL_SECONDS) {
        const bytes = typeof cached.blob === 'string'
          ? Uint8Array.from(atob(cached.blob), (ch) => ch.charCodeAt(0))
          : new Uint8Array(cached.blob as ArrayBuffer);
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': 'image/gif',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS - age}, immutable`,
            'X-Silks-Source': 'd1-cache',
            ...(cached.etag ? { ETag: cached.etag } : {}),
          },
        });
      }
    }
  } catch {
    // silks_cache table not yet migrated — fall through to network
  }

  // Fetch upstream
  try {
    const upstream = await fetch(`${HKJC_SILKS_BASE}${code}.gif`, {
      headers: {
        'User-Agent': 'TianxiSilksProxy/1.0',
        Accept: 'image/gif,image/*;q=0.9,*/*;q=0.5',
      },
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);

    if (!upstream.ok) throw new Error(`HKJC ${upstream.status}`);
    const ab = await upstream.arrayBuffer();
    const bytes = new Uint8Array(ab);

    // Write-through to D1 cache (best-effort)
    try {
      const b64 = btoa(String.fromCharCode(...bytes));
      await c.env.DB.prepare(
        `INSERT INTO silks_cache (code, blob, etag, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET blob = excluded.blob, etag = excluded.etag, fetched_at = excluded.fetched_at`
      ).bind(code, b64, upstream.headers.get('etag') ?? null, new Date().toISOString()).run();
    } catch {}

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
        'X-Silks-Source': 'hkjc-live',
      },
    });
  } catch {
    return new Response(EMPTY_GIF, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=300',
        'X-Silks-Source': 'fallback-fetch-failed',
      },
    });
  }
});
