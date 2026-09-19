// ── T−1.5h LOCK WINDOW (approved freeze spec) ───────────────────────────────
// Approved spec: the whole race day's public Top-4 is LOCKED 90 minutes before
// the FIRST race's post time. Before that moment the picks are a draft (初版)
// and may be recomputed; from that moment on the published payload is the
// prediction_log snapshot and NOTHING may rewrite the prediction columns —
// settlement only joins finishing positions.
//
// The previous implementation only froze after the first result landed
// (dateHasSettledResults), which left races 2–10 mutable while race 1 was
// already running. Time-based locking replaces that; settlement stays as a
// second, stricter backstop.

import type { Env } from '../types';

export const LOCK_LEAD_MINUTES = 90;

// Officially cancelled HK race days must never enter the lock or prediction ledger.
const CANCELLED_MEETING_DATES = new Set(['2026-09-19']);

export function isCancelledMeeting(date: string | null | undefined): boolean {
  return !!date && CANCELLED_MEETING_DATES.has(date);
}

export type LockState = {
  date: string | null;
  venue: string | null;
  /** ISO post time of the first race of the meeting (HKT offset preserved). */
  firstPostAt: string | null;
  /** ISO instant when the day locks = firstPostAt − 90min. */
  lockAt: string | null;
  /** true once now ≥ lockAt, or once results are in. */
  locked: boolean;
  /** why we consider it locked / unlocked */
  source: 'time' | 'settled' | 'pre-lock' | 'no-fixture';
  /** minutes remaining until lock (negative once passed); null when unknown. */
  minutesToLock: number | null;
};

/** MIN(post_time) for a meeting, from entries_upcoming (persists post-race). */
export async function fetchFirstPostTime(
  db: Env['DB'],
  date: string,
  venue?: string | null,
): Promise<string | null> {
  const hk = venue === 'ST' || venue === 'HV' ? venue : null;
  try {
    const row = hk
      ? await db.prepare(
          `SELECT MIN(post_time) AS pt FROM entries_upcoming
            WHERE race_date = ? AND venue = ? AND race_number > 0 AND post_time IS NOT NULL`,
        ).bind(date, hk).first<{ pt: string | null }>()
      : await db.prepare(
          `SELECT MIN(post_time) AS pt FROM entries_upcoming
            WHERE race_date = ? AND race_number > 0 AND post_time IS NOT NULL`,
        ).bind(date).first<{ pt: string | null }>();
    return row?.pt ?? null;
  } catch {
    return null;
  }
}

/** How many frozen prediction rows already exist for a date. */
export async function countPredictionLogRows(
  db: Env['DB'],
  date: string,
  engine: string = 'v12',
  variant: string = 'baseline',
): Promise<number> {
  if (isCancelledMeeting(date)) return 1;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM prediction_log
        WHERE date = ? AND engine = ? AND variant = ?`,
    ).bind(date, engine, variant).first<{ n: number | null }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Time-based lock state for a meeting. `settled` short-circuits to locked so a
 * finished day can never reopen even if fixtures are missing.
 */
export async function getMeetingLockState(
  db: Env['DB'],
  date: string | null | undefined,
  venue?: string | null,
  opts: { settled?: boolean; now?: number } = {},
): Promise<LockState> {
  const now = opts.now ?? Date.now();
  if (isCancelledMeeting(date)) {
    return { date: date ?? null, venue: venue ?? null, firstPostAt: null, lockAt: null, locked: true, source: 'no-fixture', minutesToLock: null };
  }
  if (!date) {
    return { date: null, venue: venue ?? null, firstPostAt: null, lockAt: null, locked: !!opts.settled, source: opts.settled ? 'settled' : 'no-fixture', minutesToLock: null };
  }
  const firstPostAt = await fetchFirstPostTime(db, date, venue);
  const firstMs = firstPostAt ? Date.parse(firstPostAt) : NaN;
  if (!Number.isFinite(firstMs)) {
    return { date, venue: venue ?? null, firstPostAt: null, lockAt: null, locked: !!opts.settled, source: opts.settled ? 'settled' : 'no-fixture', minutesToLock: null };
  }
  const lockMs = firstMs - LOCK_LEAD_MINUTES * 60_000;
  const minutesToLock = Math.round((lockMs - now) / 60_000);
  const timeLocked = now >= lockMs;
  return {
    date,
    venue: venue ?? null,
    firstPostAt,
    lockAt: new Date(lockMs).toISOString(),
    locked: timeLocked || !!opts.settled,
    source: timeLocked ? 'time' : opts.settled ? 'settled' : 'pre-lock',
    minutesToLock,
  };
}

/**
 * The next (or currently running) HK meeting we may have to lock, taken from
 * fixtures — never from results. Returns the meeting whose first post time is
 * the closest one not older than 8 hours.
 */
export async function findMeetingForLockTick(
  db: Env['DB'],
  now: number = Date.now(),
): Promise<{ date: string; venue: string | null; firstPostAt: string } | null> {
  const cutoff = new Date(now - 8 * 3600_000).toISOString();
  try {
    const row = await db.prepare(
      `SELECT race_date AS date, venue, MIN(post_time) AS pt
         FROM entries_upcoming
        WHERE post_time IS NOT NULL AND race_number > 0 AND post_time >= ?
          AND race_date NOT IN ('2026-09-19')
        GROUP BY race_date, venue
        ORDER BY pt ASC
        LIMIT 1`,
    ).bind(cutoff).first<{ date: string; venue: string | null; pt: string }>();
    if (!row?.date || !row?.pt) return null;
    return { date: row.date, venue: row.venue ?? null, firstPostAt: row.pt };
  } catch {
    return null;
  }
}
