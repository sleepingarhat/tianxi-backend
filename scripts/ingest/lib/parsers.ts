/**
 * Field parsers for HKJC Replit CSV data
 * Normalizes DD/MM/YYYY, finish times, positions, weights, stakes
 */

// '01/01/2019' → '2019-01-01' (ISO)
export function parseHKDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// '1.11.17' → 71.17 (秒). Format: MIN.SEC.HUND → MIN*60 + SEC.HUND
export function parseFinishTime(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)\.(\d{2})\.(\d{2})$/);
  if (m) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const hund = parseInt(m[3], 10);
    return min * 60 + sec + hund / 100;
  }
  // Plain seconds?
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// '11' → 11. 'PU' / 'WV-A' → 999 (DNF sentinel)
export function parsePosition(s: string | undefined | null): number {
  if (!s) return 999;
  const n = parseInt(s, 10);
  if (Number.isFinite(n)) return n;
  return 999;
}

// '$7,839,875' → 7839875
export function parseStakesInt(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9]/g, '');
  if (cleaned.length === 0) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

// '1086' (declared wt in lbs) → 1086 (整數)
export function parseInt10(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseFloat10(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// '0-2-1-15' → { wins, seconds, thirds, total }
export function parseRecordBreakdown(s: string | undefined | null): {
  wins: number | null;
  seconds: number | null;
  thirds: number | null;
  total: number | null;
} {
  const blank = { wins: null, seconds: null, thirds: null, total: null };
  if (!s) return blank;
  const m = s.match(/^(\d+)-(\d+)-(\d+)-(\d+)$/);
  if (!m) return blank;
  return {
    wins: parseInt(m[1], 10),
    seconds: parseInt(m[2], 10),
    thirds: parseInt(m[3], 10),
    total: parseInt(m[4], 10),
  };
}

// '沙田' → 'ST', '跑馬地' → 'HV'
export function normalizeVenue(s: string | undefined | null): string | null {
  if (!s) return null;
  if (s.includes('沙田')) return 'ST';
  if (s.includes('跑馬地')) return 'HV';
  return s;
}

// '已退役' → 'retired', '已離港' → 'departed', else 'active'
export function normalizeStatus(s: string | undefined | null): string {
  if (!s) return 'unknown';
  if (s.includes('退役')) return 'retired';
  if (s.includes('離港')) return 'departed';
  if (s.includes('死亡')) return 'deceased';
  if (s === 'active' || s === 'retired' || s === 'departed' || s === 'deceased') return s;
  return 'active';
}

// '棗 / 閹' → { colour: '棗', sex: '閹' }
export function parseColourSex(s: string | undefined | null): { colour: string | null; sex: string | null } {
  if (!s) return { colour: null, sex: null };
  const parts = s.split('/').map((p) => p.trim());
  return { colour: parts[0] || null, sex: parts[1] || null };
}

// Surface → 'turf' / 'awt'
export function normalizeSurface(track: string | undefined | null): 'turf' | 'awt' | null {
  if (!track) return null;
  if (track.includes('草地')) return 'turf';
  if (track.includes('全天候') || track.toLowerCase().includes('awt')) return 'awt';
  return null;
}

// distance int → bucket
export function distanceBucket(distance: number | null): string | null {
  if (distance == null) return null;
  if (distance <= 1400) return 'sprint';
  if (distance <= 1800) return 'mile';
  if (distance <= 2000) return 'middle';
  return 'staying';
}

// Trackwork time: '0.36.8' or '0.36.80' → 36.8s | '1.02.30' → 62.3s
// Also accepts plain '36.8' or text ('slow', '慢跑') → null
export function parseTrackworkTime(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.trim();
  // M.SS.HH or M.SS.H
  let m = t.match(/^(\d+)\.(\d{2})\.(\d{1,2})$/);
  if (m) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const hundRaw = m[3];
    const hund = hundRaw.length === 1 ? parseInt(hundRaw, 10) * 10 : parseInt(hundRaw, 10);
    return min * 60 + sec + hund / 100;
  }
  // SS.HH / SS.H
  m = t.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (m) {
    const sec = parseInt(m[1], 10);
    const hundRaw = m[2];
    const hund = hundRaw.length === 1 ? parseInt(hundRaw, 10) * 10 : parseInt(hundRaw, 10);
    return sec + hund / 100;
  }
  // Plain seconds
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// '2024-03-15' - '2024-01-10' → 65 (days)
export function daysBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const s = Date.parse(startIso + 'T00:00:00Z');
  const e = Date.parse(endIso + 'T00:00:00Z');
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.round((e - s) / 86_400_000);
}
