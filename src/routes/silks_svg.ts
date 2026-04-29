import { Hono } from 'hono';
import type { Env } from '../types';

/**
 * GET /api/silks-svg/:code.svg
 *
 * Renders a resolution-independent SVG jockey silk for owner code (e.g. K059).
 * Two sources:
 *   1. D1 `owner_silks` table (if entry exists) — actual HKJC colors + pattern
 *   2. Deterministic fallback — hash-derived palette + pattern. Scales to any size.
 *
 * Query params:
 *   size=<px>           optional integer width/height (default 256)
 *   variant=square|shield  optional shape (default square for race cards, shield for hero)
 */
export const silksSvgRoutes = new Hono<{ Bindings: Env }>();

const PALETTE = [
  '#C8102E', // HKJC red
  '#00843D', // HKJC green
  '#1E3A8A', // royal blue
  '#F59E0B', // amber
  '#7C2D12', // brown
  '#111827', // ink black
  '#FFFFFF', // white
  '#F8E7A3', // cream
  '#B91C1C', // deep red
  '#0F766E', // teal
  '#6D28D9', // violet
  '#EA580C', // orange
  '#D4A11E', // HKJC gold
  '#64748B', // slate
];

const PATTERNS = [
  'solid',
  'hstripe',
  'vstripe',
  'hoops',
  'quarters',
  'chevron',
  'cross',
  'diamonds',
  'star',
  'sash',
] as const;

type Pattern = typeof PATTERNS[number];

// ---- deterministic hash (FNV-1a 32-bit) ----
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pickPalette(code: string): { body: string; accent: string; trim: string; pattern: Pattern } {
  const h1 = hash(code);
  const h2 = hash(code + '/2');
  const h3 = hash(code + '/3');
  const body = PALETTE[h1 % PALETTE.length];
  let accent = PALETTE[h2 % PALETTE.length];
  if (accent === body) accent = PALETTE[(h2 + 7) % PALETTE.length];
  let trim = PALETTE[(h3 + 3) % PALETTE.length];
  if (trim === body || trim === accent) trim = PALETTE[(h3 + 11) % PALETTE.length];
  const pattern: Pattern = PATTERNS[h1 % PATTERNS.length];
  return { body, accent, trim, pattern };
}

// ---- SVG render ----
interface SilkColors { body: string; accent: string; trim: string; pattern: Pattern }
interface DbSilk { body: string; accent: string; trim: string; pattern: string | null }

function renderSvg(code: string, c: SilkColors, size: number, variant: 'square' | 'shield'): string {
  const patternDef = getPatternDef(c);
  const shape = variant === 'shield' ? shieldMask() : squareMask();
  const maskId = `m-${code}`;
  const patId = `p-${code}`;
  const safeCode = code.replace(/[^A-Z0-9]/gi, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Silks ${safeCode}">
  <title>${safeCode}</title>
  <defs>
    ${patternDef.defs ?? ''}
    <clipPath id="${maskId}">${shape}</clipPath>
  </defs>
  <g clip-path="url(#${maskId})">
    <rect x="0" y="0" width="64" height="64" fill="${c.body}"/>
    ${patternDef.body}
  </g>
  <g clip-path="url(#${maskId})" fill="none" stroke="${c.trim}" stroke-width="1.25" stroke-linejoin="round">
    ${variant === 'shield' ? shieldOutline() : squareOutline()}
  </g>
</svg>`;
}

function squareMask(): string {
  return `<rect x="2" y="2" width="60" height="60" rx="6" ry="6"/>`;
}
function squareOutline(): string {
  return `<rect x="2.5" y="2.5" width="59" height="59" rx="6" ry="6"/>`;
}
function shieldMask(): string {
  // rounded-top shield for hero placements
  return `<path d="M8 4 H56 A4 4 0 0 1 60 8 V36 C60 52 48 60 32 62 C16 60 4 52 4 36 V8 A4 4 0 0 1 8 4 Z"/>`;
}
function shieldOutline(): string {
  return `<path d="M8 4 H56 A4 4 0 0 1 60 8 V36 C60 52 48 60 32 62 C16 60 4 52 4 36 V8 A4 4 0 0 1 8 4 Z"/>`;
}

function getPatternDef(c: SilkColors): { defs?: string; body: string } {
  const a = c.accent;
  switch (c.pattern) {
    case 'solid':
      return { body: '' };
    case 'hstripe':
      return {
        body: Array.from({ length: 4 }, (_, i) =>
          `<rect x="0" y="${8 + i * 14}" width="64" height="6" fill="${a}"/>`
        ).join(''),
      };
    case 'vstripe':
      return {
        body: Array.from({ length: 4 }, (_, i) =>
          `<rect x="${8 + i * 14}" y="0" width="6" height="64" fill="${a}"/>`
        ).join(''),
      };
    case 'hoops':
      return {
        body: Array.from({ length: 3 }, (_, i) =>
          `<rect x="0" y="${10 + i * 16}" width="64" height="8" fill="${a}"/>`
        ).join(''),
      };
    case 'quarters':
      return {
        body: `<rect x="32" y="0" width="32" height="32" fill="${a}"/><rect x="0" y="32" width="32" height="32" fill="${a}"/>`,
      };
    case 'chevron':
      return {
        body: `<path d="M0 16 L32 32 L64 16 L64 28 L32 44 L0 28 Z" fill="${a}"/>`,
      };
    case 'cross':
      return {
        body: `<rect x="0" y="28" width="64" height="8" fill="${a}"/><rect x="28" y="0" width="8" height="64" fill="${a}"/>`,
      };
    case 'diamonds': {
      const pts: string[] = [];
      for (let y = 8; y < 64; y += 16)
        for (let x = 8; x < 64; x += 16)
          pts.push(`<polygon points="${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}" fill="${a}"/>`);
      return { body: pts.join('') };
    }
    case 'star':
      return {
        body: `<polygon fill="${a}" points="32,12 36,24 49,24 39,32 42,45 32,37 22,45 25,32 15,24 28,24"/>`,
      };
    case 'sash':
      return {
        body: `<polygon fill="${a}" points="0,16 20,0 64,44 64,56 44,64 0,32"/>`,
      };
    default:
      return { body: '' };
  }
}

// ---- Route ----
silksSvgRoutes.get('/:code{.+\\.svg}', async (c) => {
  const raw = c.req.param('code').replace(/\.svg$/i, '').toUpperCase();
  const code = raw.replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]\d{2,4}$/.test(code)) {
    return c.text('invalid code', 400);
  }
  const size = Math.min(1024, Math.max(32, parseInt(c.req.query('size') ?? '256', 10) || 256));
  const variant = c.req.query('variant') === 'shield' ? 'shield' : 'square';

  // Try D1 override (owner_silks table) — optional, fall through if absent
  let colors: SilkColors = pickPalette(code);
  try {
    const row = await c.env.DB.prepare(
      'SELECT body, accent, trim, pattern FROM owner_silks WHERE code = ?'
    ).bind(code).first<DbSilk>();
    if (row?.body) {
      const p = (PATTERNS as readonly string[]).includes(row.pattern ?? '')
        ? (row.pattern as Pattern)
        : colors.pattern;
      colors = {
        body: row.body,
        accent: row.accent ?? colors.accent,
        trim: row.trim ?? colors.trim,
        pattern: p,
      };
    }
  } catch {
    // owner_silks table not migrated — fallback to deterministic
  }

  const svg = renderSvg(code, colors, size, variant);
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=2592000, immutable',
      'X-Silks-Source': 'svg-render',
      'X-Silks-Pattern': colors.pattern,
    },
  });
});
