// ── 休季自動化 Season status (2026-08-18) ───────────────────────────
// Single source of truth for "is the HK racing season active?", consumed by:
//   - GET /api/season (public; frontend banner + GH Actions season gate)
//   - admin panel masthead badge
//
// Detection (mode = auto):
//   in_season  ⇐ any future ST/HV meeting is known (race_meetings date>=today
//                OR entries_upcoming race_date>=today), or the last meeting
//                was recent (gap <= GAP_DAYS).
//   off_season ⇐ no future HK meeting AND (today − last meeting) > GAP_DAYS.
//
// Rationale: in-season gaps between HK meetings are ≤ ~7 days; the summer
// break is ~6-7 weeks. GAP_DAYS=12 cleanly separates the two. Auto-resume:
// the ungated sensor workflows (capy_fixture_weekly, capy_racecard,
// capy_d1_sync_entries) keep running during the break; the moment HKJC
// publishes the new season's first racecard, entries_upcoming gains a
// future row and status flips back to in_season with zero manual action.
//
// Admin override: app_settings key 'season_mode' ∈ 'auto' | 'in' | 'off'
// (set via POST /admin/api/set-season-mode). 'in'/'off' force the status.
// All dates are computed in HKT (UTC+8) — HK racing is an HKT phenomenon.

import type { Env } from '../types';

export const SEASON_GAP_DAYS = 12;

export interface SeasonStatus {
  status: 'in_season' | 'off_season';
  mode: 'auto' | 'in' | 'off';
  today: string;
  lastMeeting: string | null;
  nextMeeting: string | null;
  gapDays: number | null;
  reason: string;
}

function hktToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().substring(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export async function getSeasonStatus(db: Env['DB']): Promise<SeasonStatus> {
  const today = hktToday();

  const modeRow = await db
    .prepare(`SELECT value FROM app_settings WHERE key = 'season_mode'`)
    .first<{ value: string }>()
    .catch(() => null);
  const mode: SeasonStatus['mode'] =
    modeRow?.value === 'in' ? 'in' : modeRow?.value === 'off' ? 'off' : 'auto';

  const [nextM, nextE, lastM] = await Promise.all([
    db.prepare(
      `SELECT MIN(date) AS d FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV')`
    ).bind(today).first<{ d: string | null }>().catch(() => null),
    db.prepare(
      `SELECT MIN(race_date) AS d FROM entries_upcoming WHERE race_date >= ? AND venue IN ('ST','HV')`
    ).bind(today).first<{ d: string | null }>().catch(() => null),
    db.prepare(
      `SELECT MAX(date) AS d FROM race_meetings WHERE date < ? AND venue IN ('ST','HV')`
    ).bind(today).first<{ d: string | null }>().catch(() => null),
  ]);

  const candidates = [nextM?.d, nextE?.d].filter((d): d is string => !!d);
  const nextMeeting = candidates.length ? candidates.sort()[0] : null;
  const lastMeeting = lastM?.d ?? null;
  const gapDays = lastMeeting ? daysBetween(lastMeeting, today) : null;

  if (mode === 'in') {
    return { status: 'in_season', mode, today, lastMeeting, nextMeeting, gapDays, reason: 'admin override: forced in-season' };
  }
  if (mode === 'off') {
    return { status: 'off_season', mode, today, lastMeeting, nextMeeting, gapDays, reason: 'admin override: forced off-season' };
  }
  if (nextMeeting) {
    return { status: 'in_season', mode, today, lastMeeting, nextMeeting, gapDays, reason: `next HK meeting known (${nextMeeting})` };
  }
  if (gapDays != null && gapDays > SEASON_GAP_DAYS) {
    return { status: 'off_season', mode, today, lastMeeting, nextMeeting, gapDays, reason: `no future HK meeting and last meeting ${gapDays}d ago (> ${SEASON_GAP_DAYS}d)` };
  }
  return { status: 'in_season', mode, today, lastMeeting, nextMeeting, gapDays, reason: 'no future meeting yet but gap within normal in-season range (fail-open)' };
}
