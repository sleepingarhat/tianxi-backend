import type { Env } from '../types';

// race_number -> (horse_number -> latest WIN odds) from odds_snapshots.
// The HKJC win pool opens well before post time (often the prior day), so this
// is the live source of win odds for the pre-results declared racecard
// (entries_upcoming carries no odds). Each race uses its MOST RECENT snapshot
// so the odds track the current market.
// try/catch: degrade to an empty map if odds_snapshots is missing or the query
// errors, so the meeting still renders (winOdds stays null).
export async function fetchWinOddsMap(
  db: Env['DB'],
  date: string,
  venue: string,
): Promise<Map<number, Map<number, number>>> {
  const out = new Map<number, Map<number, number>>();
  try {
    const { results } = await db
      .prepare(
        `SELECT o.race_number, o.combination, o.odds
           FROM odds_snapshots o
           JOIN (
             SELECT race_number, MAX(snapshot_at) AS mx
               FROM odds_snapshots
              WHERE race_date = ? AND venue = ? AND pool_type = 'WIN'
              GROUP BY race_number
           ) m ON m.race_number = o.race_number AND m.mx = o.snapshot_at
          WHERE o.race_date = ? AND o.venue = ? AND o.pool_type = 'WIN'`,
      )
      .bind(date, venue, date, venue)
      .all<{ race_number: number; combination: string; odds: number }>();
    for (const r of results ?? []) {
      const hn = parseInt(String(r.combination), 10);
      const od = Number(r.odds);
      if (!Number.isFinite(hn) || !Number.isFinite(od)) continue;
      if (!out.has(r.race_number)) out.set(r.race_number, new Map());
      out.get(r.race_number)!.set(hn, od);
    }
  } catch (err) {
    console.error('fetchWinOddsMap failed', { date, venue, err: String(err) });
  }
  return out;
}
