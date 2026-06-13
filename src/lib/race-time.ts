import type { Env } from '../types';

// Extract "HH:MM" (HK local clock) from an HKJC postTime ISO string such as
// "2026-06-13T16:00:00+08:00". The time portion already carries the +08:00 HKT
// clock, so a substring is timezone-safe (no Date parsing -> no UTC drift).
export function hhmmFromPostTime(pt: string | null | undefined): string | null {
  if (!pt) return null;
  const m = String(pt).match(/T(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : null;
}

// race_number -> post_time (ISO) map from entries_upcoming for a meeting.
// entries_upcoming persists post-race, so it is the single source of start
// times for BOTH the pre-race racecard and the post-race results view.
// try/catch: if post_time hasn't been migrated yet the query throws and we
// degrade gracefully to an empty map (startTime stays null -> placeholder).
export async function fetchPostTimeMap(
  db: Env['DB'],
  date: string,
  venue: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const { results } = await db
      .prepare(
        "SELECT race_number, post_time FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number > 0 AND post_time IS NOT NULL",
      )
      .bind(date, venue)
      .all<{ race_number: number; post_time: string }>();
    for (const r of results ?? []) {
      if (!out.has(r.race_number)) out.set(r.race_number, r.post_time);
    }
  } catch {
    // post_time column not present yet (pre-migration) — degrade gracefully.
  }
  return out;
}
