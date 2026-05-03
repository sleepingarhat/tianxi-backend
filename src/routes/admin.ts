/**
 * Internal admin panel (Priority 3 · 2026-05-01 v3).
 * v3: 資料來源覆蓋面板 + 預測因子覆蓋面板。每個條目 2 欄狀態：
 *     歷史齊全 / 自動更新  → ✓ 綠 · ▲ 黃 · ✗ 紅
 */
import { Hono } from 'hono';

interface AdminEnv {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

adminRoutes.use('*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return c.json({ error: 'admin disabled: ADMIN_TOKEN not set' }, 503);
  const header = c.req.header('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const queryTok = c.req.query('token') || '';
  if (bearer !== expected && queryTok !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

async function scalar<T = any>(db: D1Database, sql: string): Promise<T | null> {
  try {
    const row = await db.prepare(sql).first<Record<string, T>>();
    return row ? (Object.values(row)[0] as T) : null;
  } catch { return null; }
}

// ── /api/ping — no DB, just proves Worker + auth is alive ──
adminRoutes.get('/api/ping', (c) => {
  return c.json({ ok: true, time: new Date().toISOString(), token: 'accepted' });
});

// ── /api/status ──────────────────────────────────────────────────────────
adminRoutes.get('/api/status', async (c) => {
  const db = c.env.DB;
  const [mc, rc, rsc, hc, jc, tc, twc, ic, fc, ec, oc, heC, jeC, teC,
         latestM, earliestM, latestE, latestTW, latestElo, latestO] = await Promise.all([
    scalar<number>(db, `SELECT COUNT(*) AS n FROM race_meetings`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM races`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM race_results`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM horses`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM jockeys`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM trainers`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM horse_trackwork`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM horse_injury`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM horse_form_records`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM entries_upcoming`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM odds_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM horse_elo_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM jockey_elo_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) AS n FROM trainer_elo_snapshots`),
    scalar<string>(db, `SELECT MAX(date) FROM race_meetings`),
    scalar<string>(db, `SELECT MIN(date) FROM race_meetings`),
    scalar<string>(db, `SELECT MAX(race_date) FROM entries_upcoming`),
    scalar<string>(db, `SELECT MAX(trackwork_date) FROM horse_trackwork`),
    scalar<string>(db, `SELECT MAX(as_of_date) FROM horse_elo_snapshots`),
    scalar<string>(db, `SELECT MAX(snapshot_at) FROM odds_snapshots`),
  ]);
  return c.json({
    counts: { meetings: mc, races: rc, results: rsc, horses: hc, jockeys: jc, trainers: tc,
      trackwork: twc, injury: ic, form: fc, entries: ec, odds: oc,
      horseElo: heC, jockeyElo: jeC, trainerElo: teC },
    dates: { earliestMeeting: earliestM, latestMeeting: latestM,
      latestEntry: latestE, latestTrackwork: latestTW, latestElo, latestOdds: latestO },
    serverTime: new Date().toISOString(),
  });
});

// ── /api/gaps ──
adminRoutes.get('/api/gaps', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT substr(date, 1, 7) AS ym, COUNT(*) AS n FROM race_meetings
    GROUP BY ym HAVING n < 5
      AND substr(ym, 6, 2) NOT IN ('06', '07', '08')
      AND ym < strftime('%Y-%m', 'now')
    ORDER BY ym`).all();
  return c.json({ suspectMonths: rows.results });
});

// ── Shared: fetch GHA runs (used by /alerts + /coverage) ──
async function fetchRuns(env: AdminEnv, limit = 50): Promise<any[]> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return [];
  try {
    const r = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?per_page=${limit}`,
      { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json', 'User-Agent': 'tianxi-admin' } }
    );
    if (!r.ok) return [];
    const j: any = await r.json();
    return j.workflow_runs || [];
  } catch { return []; }
}

// Map workflow key (name + filename) → recent runs (array + lastSuccess).
// 2026-05-01 v4: keep full recent run list instead of only latest, so
// an in_progress / cancelled latest no longer false-triggers '無自動 ✗'.
interface WfInfo {
  recent: Array<{ conclusion: string; status: string; updatedAt: string }>;
  lastRunAt: string;
  lastSuccessAt: string | null;
}
function buildWorkflowMap(runs: any[]): Record<string, WfInfo> {
  const map: Record<string, WfInfo> = {};
  for (const r of runs) {
    const name = r.name || '';
    const path = (r.path || '').split('/').pop() || '';
    const keys = [name, path].filter(Boolean);
    for (const k of keys) {
      const info = (map[k] = map[k] || { recent: [], lastRunAt: '', lastSuccessAt: null });
      info.recent.push({ conclusion: r.conclusion || '', status: r.status, updatedAt: r.updated_at });
      if (r.updated_at > info.lastRunAt) info.lastRunAt = r.updated_at;
      if (r.conclusion === 'success' && (!info.lastSuccessAt || r.updated_at > info.lastSuccessAt)) {
        info.lastSuccessAt = r.updated_at;
      }
    }
  }
  for (const k of Object.keys(map)) {
    map[k].recent.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    map[k].recent = map[k].recent.slice(0, 10);
  }
  return map;
}

// Rule helpers
type Status = 'ok' | 'warn' | 'bad';
function assessHistory(count: number | null, latest: string | null, minCount: number, maxStaleDays: number): Status {
  if (count == null || count === 0) return 'bad';
  if (count < minCount * 0.3) return 'bad';
  const ageDays = latest ? (Date.now() - new Date(latest).getTime()) / 86400000 : 999;
  if (ageDays > maxStaleDays * 3) return 'bad';
  return 'ok';
}
// Scan last 5 runs per workflow — transient states (in_progress / cancelled
// in the latest slot) no longer mask a healthy stream of successes.
function assessAuto(wfMap: Record<string, WfInfo>, wfNames: string[]): Status {
  let anyFound = false, anySuccess = false, conclusiveCount = 0;
  for (const n of wfNames) {
    const m = wfMap[n];
    if (!m) continue;
    anyFound = true;
    for (const run of m.recent.slice(0, 5)) {
      if (run.conclusion === 'success') { anySuccess = true; conclusiveCount++; }
      else if (run.conclusion === 'failure') { conclusiveCount++; }
    }
  }
  if (!anyFound) return 'bad';
  if (!anySuccess && conclusiveCount >= 5) return 'bad';
  return 'ok';
}
// Pull lastRun/lastSuccess times + staleness for per-row dashboard badges.
function lastRunInfo(wfMap: Record<string, WfInfo>, wfNames: string[]):
  { lastRunAt: string | null; lastSuccessAt: string | null; lastSuccessAgeH: number | null } {
  let lastRunAt: string | null = null;
  let lastSuccessAt: string | null = null;
  for (const n of wfNames) {
    const m = wfMap[n];
    if (!m) continue;
    if (m.lastRunAt && (!lastRunAt || m.lastRunAt > lastRunAt)) lastRunAt = m.lastRunAt;
    if (m.lastSuccessAt && (!lastSuccessAt || m.lastSuccessAt > lastSuccessAt)) lastSuccessAt = m.lastSuccessAt;
  }
  const lastSuccessAgeH = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3600000 : null;
  return { lastRunAt, lastSuccessAt, lastSuccessAgeH };
}
// Combined: auto status + last-run timestamps — spread into dataset row.
function rowAuto(wfMap: Record<string, WfInfo>, wfNames: string[]) {
  return { auto: assessAuto(wfMap, wfNames), ...lastRunInfo(wfMap, wfNames) };
}

// ── /api/coverage ──────────────────────────────────────────────────────
adminRoutes.get('/api/coverage', async (c) => {
  const db = c.env.DB;
  const runs = await fetchRuns(c.env, 150);  // v4: 80→150 so each of 16 workflows has ≥5 recent
  const wf = buildWorkflowMap(runs);

  // Gather all counts + latest dates in parallel
  const [mc, rc, rsc, hc, jc, tc, twc, ic, fc, ec, oc, heC, jeC, teC,
         latestM, latestE, latestTW, latestElo, latestOdds, latestResult,
         latestInjury, latestForm] = await Promise.all([
    scalar<number>(db, `SELECT COUNT(*) FROM race_meetings`),
    scalar<number>(db, `SELECT COUNT(*) FROM races`),
    scalar<number>(db, `SELECT COUNT(*) FROM race_results`),
    scalar<number>(db, `SELECT COUNT(*) FROM horses`),
    scalar<number>(db, `SELECT COUNT(*) FROM jockeys`),
    scalar<number>(db, `SELECT COUNT(*) FROM trainers`),
    scalar<number>(db, `SELECT COUNT(*) FROM horse_trackwork`),
    scalar<number>(db, `SELECT COUNT(*) FROM horse_injury`),
    scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records`),
    scalar<number>(db, `SELECT COUNT(*) FROM entries_upcoming`),
    scalar<number>(db, `SELECT COUNT(*) FROM odds_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) FROM horse_elo_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) FROM jockey_elo_snapshots`),
    scalar<number>(db, `SELECT COUNT(*) FROM trainer_elo_snapshots`),
    scalar<string>(db, `SELECT MAX(date) FROM race_meetings`),
    scalar<string>(db, `SELECT MAX(race_date) FROM entries_upcoming`),
    scalar<string>(db, `SELECT MAX(trackwork_date) FROM horse_trackwork`),
    scalar<string>(db, `SELECT MAX(as_of_date) FROM horse_elo_snapshots`),
    scalar<string>(db, `SELECT MAX(snapshot_at) FROM odds_snapshots`),
    scalar<string>(db, `SELECT MAX(m.date) FROM race_results rr JOIN races r ON rr.race_id = r.id JOIN race_meetings m ON r.meeting_id = m.id`),
    scalar<string>(db, `SELECT MAX(injury_date) FROM horse_injury`),
    scalar<string>(db, `SELECT MAX(race_date) FROM horse_form_records`),
  ]);

  // Helper: format date or '—'
  const fd = (s: string | null) => s || '—';

  const datasets = [
    { key: 'meetings', label: '賽馬日', count: mc, latest: latestM,
      history: assessHistory(mc, latestM, 880, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results', 'capy_d1_sync.yml']),
      workflows: ['capy_race_daily', 'capy_d1_sync'], detail: `${mc} 場 · 最新 ${fd(latestM)}` },
    { key: 'races', label: '場次', count: rc, latest: latestM,
      history: assessHistory(rc, latestM, 8000, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results']),
      workflows: ['capy_race_daily'], detail: `${rc} 場次` },
    { key: 'results', label: '賽果', count: rsc, latest: latestResult,
      history: assessHistory(rsc, latestResult, 95000, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results', 'capy_d1_sync.yml']),
      workflows: ['capy_race_daily', 'capy_d1_sync'], detail: `${rsc} 行 · 最新 ${fd(latestResult)}` },
    { key: 'horses', label: '馬匹', count: hc, latest: latestM,
      history: assessHistory(hc, latestM, 5000, 21),
      ...rowAuto(wf, ['capy_race_daily.yml', 'capy_pool_a.yml']),
      workflows: ['capy_race_daily', 'capy_pool_a'], detail: `${hc} 匹` },
    { key: 'jockeys', label: '騎師', count: jc, latest: latestM,
      history: assessHistory(jc, latestM, 150, 21),
      ...rowAuto(wf, ['capy_race_daily.yml']),
      workflows: ['capy_race_daily'], detail: `${jc} 位` },
    { key: 'trainers', label: '練馬師', count: tc, latest: latestM,
      history: assessHistory(tc, latestM, 150, 21),
      ...rowAuto(wf, ['capy_race_daily.yml']),
      workflows: ['capy_race_daily'], detail: `${tc} 位` },
    { key: 'trackwork', label: '晨操', count: twc, latest: latestTW,
      history: assessHistory(twc, latestTW, 5000, 3),
      ...rowAuto(wf, ['capy_pool_a.yml', 'capy_d1_sync_pool_a.yml',
        'Capy Pool A — Horse Profiles + Trackwork + Injury', 'Capy D1 Sync Pool A — trackwork + injury + form']),
      workflows: ['capy_pool_a', 'capy_d1_sync_pool_a'], detail: `${twc} 行 · 最新 ${fd(latestTW)}` },
    { key: 'injury', label: '傷患', count: ic, latest: latestInjury,
      history: assessHistory(ic, latestInjury, 1200, 30),
      ...rowAuto(wf, ['capy_pool_a.yml', 'capy_d1_sync_pool_a.yml',
        'Capy Pool A — Horse Profiles + Trackwork + Injury']),
      workflows: ['capy_pool_a', 'capy_d1_sync_pool_a'], detail: `${ic} 行 · 最新 ${fd(latestInjury)}` },
    { key: 'form', label: '往績 (form records)', count: fc, latest: latestForm,
      history: assessHistory(fc, latestForm, 180000, 30),
      ...rowAuto(wf, ['capy_race_daily.yml', 'capy_pool_a.yml', 'capy_d1_sync_pool_a.yml']),
      workflows: ['capy_race_daily', 'capy_pool_a'], detail: `${fc} 行 · 最新 ${fd(latestForm)}` },
    { key: 'entries', label: '排位表 (upcoming)', count: ec, latest: latestE,
      history: assessHistory(ec, latestE, 50, 2),
      ...rowAuto(wf, ['capy_entries.yml', 'capy_d1_sync_entries.yml',
        'Capy Entries — Race Card (排位表)', 'Capy D1 Sync Entries — forward-looking racecards']),
      workflows: ['capy_entries', 'capy_d1_sync_entries'], detail: `${ec} 行 · 最新 ${fd(latestE)}` },
    { key: 'odds', label: '賠率', count: oc, latest: latestOdds,
      history: assessHistory(oc, latestOdds, 1000, 3),
      ...rowAuto(wf, ['capy_odds.yml', 'Capy Odds — live snapshot (hkjc-api GraphQL)']),
      workflows: ['capy_odds'], detail: `${oc} 行 · 最新 ${fd(latestOdds)}` },
    { key: 'horseElo', label: '馬匹 ELO', count: heC, latest: latestElo,
      history: assessHistory(heC, latestElo, 75000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml', 'capy_race_daily.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${heC} snapshots · 最新 ${fd(latestElo)}` },
    { key: 'jockeyElo', label: '騎師 ELO', count: jeC, latest: latestElo,
      history: assessHistory(jeC, latestElo, 45000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${jeC} snapshots` },
    { key: 'trainerElo', label: '練馬師 ELO', count: teC, latest: latestElo,
      history: assessHistory(teC, latestElo, 45000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${teC} snapshots` },
  ];

  // Factor assessment — each factor maps to underlying data source(s)
  function minOf(...s: Status[]): Status {
    if (s.includes('bad')) return 'bad';
    if (s.includes('warn')) return 'warn';
    return 'ok';
  }
  function getDs(key: string) { return datasets.find(d => d.key === key)!; }

  const factors = [
    { key: 'horse_elo', label: '馬匹 ELO', used: true, weight: 0.7,
      history: getDs('horseElo').history, auto: getDs('horseElo').auto,
      sourceLabel: 'horse_elo_snapshots', note: '使用中（composite baseline）' },
    { key: 'jockey_elo', label: '騎師 ELO', used: true, weight: 0.2,
      history: getDs('jockeyElo').history, auto: getDs('jockeyElo').auto,
      sourceLabel: 'jockey_elo_snapshots', note: '使用中' },
    { key: 'trainer_elo', label: '練馬師 ELO', used: true, weight: 0.1,
      history: getDs('trainerElo').history, auto: getDs('trainerElo').auto,
      sourceLabel: 'trainer_elo_snapshots', note: '使用中' },
    { key: 'recency', label: '近戰狀態', used: true, weight: null,
      history: minOf(getDs('races').history, getDs('results').history),
      auto: getDs('results').auto,
      sourceLabel: 'races + race_results', note: '使用中（days since last race sweet spot 14-28）' },
    { key: 'distance_fit', label: '途程適應', used: false, weight: 0,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × distance', note: 'stub 0 · 未寫入 analyze.ts' },
    { key: 'going_fit', label: '場地適應', used: false, weight: 0,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × going', note: 'stub 0' },
    { key: 'draw_bias', label: '檔位偏差', used: false, weight: 0,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × venue × distance × draw', note: 'stub 0' },
    { key: 'weight_delta', label: '負磅變化', used: false, weight: 0,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results.horse_weight', note: 'stub 0' },
    { key: 'trackwork_fit', label: '晨操狀態', used: false, weight: 0,
      history: getDs('trackwork').history, auto: getDs('trackwork').auto,
      sourceLabel: 'horse_trackwork', note: 'stub 0 · 資料本身亦未齊' },
    { key: 'injury', label: '傷患', used: false, weight: 0,
      history: getDs('injury').history, auto: getDs('injury').auto,
      sourceLabel: 'horse_injury', note: 'stub 0' },
    { key: 'jt_combo', label: '騎練配對', used: false, weight: 0,
      history: minOf(getDs('races').history, getDs('jockeys').history, getDs('trainers').history),
      auto: getDs('races').auto,
      sourceLabel: 'races × jockeys × trainers', note: 'stub 0' },
  ];

  return c.json({ datasets, factors: factors.filter((f: any) => f.used), checkedAt: new Date().toISOString() });
});

// ── /api/alerts (unchanged) ──
adminRoutes.get('/api/alerts', async (c) => {
  const db = c.env.DB;
  const now = new Date();
  const alerts: { level: 'red' | 'yellow'; msg: string }[] = [];

  const oddsLatest = await scalar<string>(db, `SELECT MAX(snapshot_at) FROM odds_snapshots`);
  const oddsCount = await scalar<number>(db, `SELECT COUNT(*) FROM odds_snapshots`);
  if (!oddsCount) alerts.push({ level: 'yellow', msg: '賠率表 odds_snapshots 未有資料（賽事期間自動填充）' });
  else if (oddsLatest) {
    const hrs = (now.getTime() - new Date(oddsLatest).getTime()) / 3600000;
    if (hrs > 6) alerts.push({ level: 'red', msg: `賠率已停更新 ${hrs.toFixed(1)} 小時` });
  }

  const twLatest = await scalar<string>(db, `SELECT MAX(trackwork_date) FROM horse_trackwork`);
  if (twLatest) {
    const days = Math.floor((now.getTime() - new Date(twLatest).getTime()) / 86400000);
    if (days > 3) alerts.push({ level: 'yellow', msg: `晨操資料落後 ${days} 日（最新：${twLatest}）` });
  } else alerts.push({ level: 'yellow', msg: '晨操資料完全冇' });

  const nextMeet = await scalar<string>(db, `SELECT MIN(date) FROM race_meetings WHERE date >= date('now','localtime')`);
  const entLatest = await scalar<string>(db, `SELECT MAX(race_date) FROM entries_upcoming`);
  if (nextMeet && (!entLatest || entLatest < nextMeet)) {
    alerts.push({ level: 'yellow', msg: `排位表未同步（最新 ${entLatest || '—'} · 下場 ${nextMeet}）` });
  }

  const meetLatest = await scalar<string>(db, `SELECT MAX(date) FROM race_meetings`);
  if (meetLatest) {
    const days = Math.floor((now.getTime() - new Date(meetLatest).getTime()) / 86400000);
    if (days > 14) alerts.push({ level: 'red', msg: `賽馬日已 ${days} 日冇更新（${meetLatest}）` });
  }

  const runs = await fetchRuns(c.env, 20);
  const cutoff = now.getTime() - 3 * 3600000;
  const failures = runs.filter((x: any) => x.conclusion === 'failure' && new Date(x.updated_at).getTime() > cutoff);
  for (const f of failures.slice(0, 3)) {
    alerts.push({ level: 'red', msg: `工作流失敗：${f.name}（#${f.id}）` });
  }
  return c.json({ alerts, checkedAt: now.toISOString() });
});

// ── /api/dispatch + /api/runs ──
adminRoutes.post('/api/dispatch', async (c) => {
  const token = c.env.GITHUB_TOKEN; const repo = c.env.GITHUB_REPO;
  if (!token || !repo) return c.json({ error: 'GITHUB_TOKEN / GITHUB_REPO 未設定' }, 503);
  const body = await c.req.json<{ workflow: string; ref?: string; inputs?: Record<string, string> }>();
  if (!body.workflow) return c.json({ error: 'workflow required' }, 400);
  const ALLOWED = new Set([
    'capy_race_daily.yml', 'capy_pool_a.yml', 'capy_odds.yml',
    'capy_d1_sync.yml', 'capy_d1_sync_entries.yml', 'capy_d1_sync_pool_a.yml',
    'capy_d1_bulk_backfill.yml', 'capy_entries.yml',
    'capy_fixture_weekly.yml', 'capy_integrity_audit.yml',
  ]);
  if (!ALLOWED.has(body.workflow)) return c.json({ error: `workflow ${body.workflow} not whitelisted` }, 400);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${body.workflow}/dispatches`,
    { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tianxi-admin' },
      body: JSON.stringify({ ref: body.ref || 'main', inputs: body.inputs || {} }) }
  );
  if (res.status !== 204) {
    const text = await res.text();
    return c.json({ error: 'dispatch failed', status: res.status, detail: text }, 502);
  }
  return c.json({ ok: true, workflow: body.workflow, inputs: body.inputs || {} });
});

adminRoutes.get('/api/runs', async (c) => {
  const limit = Number(c.req.query('limit') || '15');
  const runs = await fetchRuns(c.env, limit);
  return c.json({
    runs: runs.map((r: any) => ({
      id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
      createdAt: r.created_at, updatedAt: r.updated_at, htmlUrl: r.html_url,
    })),
  });
});


// ── /api/meetings — recent meetings for admin panel ──────────────────────
adminRoutes.get('/api/meetings', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || '10'), 30);
  const { results } = await c.env.DB.prepare(`
    SELECT m.id, m.date, m.venue, m.track_condition, m.total_races,
           COUNT(r.id) AS race_count,
           (SELECT COUNT(*) FROM entries_upcoming e WHERE e.race_date = m.date) AS entry_count
    FROM race_meetings m
    LEFT JOIN races r ON r.meeting_id = m.id
    GROUP BY m.id
    ORDER BY m.date DESC
    LIMIT ?
  `).bind(limit).all();
  return c.json({ meetings: results ?? [] });
});

// ── GET / — HTML dashboard (SSR: all data fetched server-side) ──
adminRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  const token = c.req.query('token') || '';
  const data = await fetchAdminPageData(c.env);
  return c.html(renderPanel(token, data));
});

// ── Server-side data aggregation for admin panel ──────────────────────────
async function fetchAdminPageData(env: AdminEnv): Promise<Record<string, any>> {
  const db = env.DB;
  // All D1 queries in one parallel batch
  const [
    mc, rc, rsc, hc, jc, tc, twc, ic, fc, ec, oc, heC, jeC, teC,
    latestM, earliestM, latestE, latestTW, latestElo, latestO,
    latestResult, latestInjury, latestForm,
    oddsLatest, oddsCount, nextMeet, entLatest, meetLatest,
  ] = await Promise.all([
    scalar<number>(db, 'SELECT COUNT(*) FROM race_meetings'),
    scalar<number>(db, 'SELECT COUNT(*) FROM races'),
    scalar<number>(db, 'SELECT COUNT(*) FROM race_results'),
    scalar<number>(db, 'SELECT COUNT(*) FROM horses'),
    scalar<number>(db, 'SELECT COUNT(*) FROM jockeys'),
    scalar<number>(db, 'SELECT COUNT(*) FROM trainers'),
    scalar<number>(db, 'SELECT COUNT(*) FROM horse_trackwork'),
    scalar<number>(db, 'SELECT COUNT(*) FROM horse_injury'),
    scalar<number>(db, 'SELECT COUNT(*) FROM horse_form_records'),
    scalar<number>(db, 'SELECT COUNT(*) FROM entries_upcoming'),
    scalar<number>(db, 'SELECT COUNT(*) FROM odds_snapshots'),
    scalar<number>(db, 'SELECT COUNT(*) FROM horse_elo_snapshots'),
    scalar<number>(db, 'SELECT COUNT(*) FROM jockey_elo_snapshots'),
    scalar<number>(db, 'SELECT COUNT(*) FROM trainer_elo_snapshots'),
    scalar<string>(db, 'SELECT MAX(date) FROM race_meetings'),
    scalar<string>(db, 'SELECT MIN(date) FROM race_meetings'),
    scalar<string>(db, 'SELECT MAX(race_date) FROM entries_upcoming'),
    scalar<string>(db, 'SELECT MAX(trackwork_date) FROM horse_trackwork'),
    scalar<string>(db, 'SELECT MAX(as_of_date) FROM horse_elo_snapshots'),
    scalar<string>(db, 'SELECT MAX(snapshot_at) FROM odds_snapshots'),
    scalar<string>(db, 'SELECT MAX(race_date) FROM race_results'),
    scalar<string>(db, 'SELECT MAX(injury_date) FROM horse_injury'),
    scalar<string>(db, 'SELECT MAX(race_date) FROM horse_form_records'),
    scalar<string>(db, 'SELECT MAX(snapshot_at) FROM odds_snapshots'),
    scalar<number>(db, 'SELECT COUNT(*) FROM odds_snapshots'),
    scalar<string>(db, "SELECT MIN(date) FROM race_meetings WHERE date >= date('now','localtime')"),
    scalar<string>(db, 'SELECT MAX(race_date) FROM entries_upcoming'),
    scalar<string>(db, 'SELECT MAX(date) FROM race_meetings'),
  ]);

  const runs = await fetchRuns(env, 150);
  const wf = buildWorkflowMap(runs);
  const fd = (s: string | null) => s || '—';

  // Coverage datasets
  const datasets = [
    { key: 'meetings', label: '賽馬日', history: assessHistory(mc, latestM, 880, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results', 'capy_d1_sync.yml']),
      workflows: ['capy_race_daily', 'capy_d1_sync'], detail: `${mc} 場 · 最新 ${fd(latestM)}` },
    { key: 'races', label: '場次', history: assessHistory(rc, latestM, 8000, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results']),
      workflows: ['capy_race_daily'], detail: `${rc} 場次` },
    { key: 'results', label: '賽果', history: assessHistory(rsc, latestResult, 95000, 14),
      ...rowAuto(wf, ['capy_race_daily.yml', 'Capy Race Day — RacingData Results', 'capy_d1_sync.yml']),
      workflows: ['capy_race_daily', 'capy_d1_sync'], detail: `${rsc} 行 · 最新 ${fd(latestResult)}` },
    { key: 'horses', label: '馬匹', history: assessHistory(hc, null, 5000, 365),
      ...rowAuto(wf, ['capy_race_daily.yml', 'capy_pool_a.yml']),
      workflows: ['capy_race_daily', 'capy_pool_a'], detail: `${hc} 匹` },
    { key: 'jockeys', label: '騎師', history: assessHistory(jc, null, 150, 365),
      ...rowAuto(wf, ['capy_race_daily.yml']),
      workflows: ['capy_race_daily'], detail: `${jc} 位` },
    { key: 'trainers', label: '練馬師', history: assessHistory(tc, null, 150, 365),
      ...rowAuto(wf, ['capy_race_daily.yml']),
      workflows: ['capy_race_daily'], detail: `${tc} 位` },
    { key: 'trackwork', label: '晨操', history: assessHistory(twc, latestTW, 5000, 3),
      ...rowAuto(wf, ['capy_pool_a.yml', 'capy_d1_sync_pool_a.yml', 'Capy Pool A — Horse Profiles + Trackwork + Injury', 'Capy D1 Sync Pool A — trackwork + injury + form']),
      workflows: ['capy_pool_a', 'capy_d1_sync_pool_a'], detail: `${twc} 行 · 最新 ${fd(latestTW)}` },
    { key: 'injury', label: '傷患', history: assessHistory(ic, latestInjury, 1200, 30),
      ...rowAuto(wf, ['capy_pool_a.yml', 'capy_d1_sync_pool_a.yml', 'Capy Pool A — Horse Profiles + Trackwork + Injury']),
      workflows: ['capy_pool_a', 'capy_d1_sync_pool_a'], detail: `${ic} 行 · 最新 ${fd(latestInjury)}` },
    { key: 'form', label: '往績', history: assessHistory(fc, latestForm, 180000, 30),
      ...rowAuto(wf, ['capy_race_daily.yml', 'capy_pool_a.yml', 'capy_d1_sync_pool_a.yml']),
      workflows: ['capy_race_daily', 'capy_pool_a'], detail: `${fc} 行 · 最新 ${fd(latestForm)}` },
    { key: 'entries', label: '排位表', history: assessHistory(ec, latestE, 50, 2),
      ...rowAuto(wf, ['capy_entries.yml', 'capy_d1_sync_entries.yml', 'Capy Entries — Race Card (排位表)', 'Capy D1 Sync Entries — forward-looking racecards']),
      workflows: ['capy_entries', 'capy_d1_sync_entries'], detail: `${ec} 行 · 最新 ${fd(latestE)}` },
    { key: 'odds', label: '賠率', history: assessHistory(oc, latestO, 1000, 1),
      ...rowAuto(wf, ['capy_odds.yml', 'Capy Odds — live snapshot (hkjc-api GraphQL)']),
      workflows: ['capy_odds'], detail: `${oc} 行 · 最新 ${fd(latestO)}` },
    { key: 'horseElo', label: '馬匹 ELO', history: assessHistory(heC, latestElo, 75000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml', 'capy_race_daily.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${heC} snapshots · 最新 ${fd(latestElo)}` },
    { key: 'jockeyElo', label: '騎師 ELO', history: assessHistory(jeC, latestElo, 45000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${jeC} snapshots` },
    { key: 'trainerElo', label: '練馬師 ELO', history: assessHistory(teC, latestElo, 45000, 7),
      ...rowAuto(wf, ['ELO Post-Race Auto-Update', 'elo-post-race.yml']),
      workflows: ['ELO Post-Race Auto-Update'], detail: `${teC} snapshots` },
  ];
  function minOf(...s: Status[]): Status {
    if (s.includes('bad')) return 'bad'; if (s.includes('warn')) return 'warn'; return 'ok';
  }
  function getDs(key: string) { return datasets.find(d => d.key === key) || datasets[0]; }
  const factors = [
    { key: 'horse_elo', label: '馬匹 ELO', used: true, weight: 0.7, history: getDs('horseElo').history, auto: getDs('horseElo').auto, sourceLabel: 'horse_elo_snapshots', note: '使用中（composite baseline）' },
    { key: 'jockey_elo', label: '騎師 ELO', used: true, weight: 0.2, history: getDs('jockeyElo').history, auto: getDs('jockeyElo').auto, sourceLabel: 'jockey_elo_snapshots', note: '使用中' },
    { key: 'trainer_elo', label: '練馬師 ELO', used: true, weight: 0.1, history: getDs('trainerElo').history, auto: getDs('trainerElo').auto, sourceLabel: 'trainer_elo_snapshots', note: '使用中' },
    { key: 'recency', label: '近戰狀態', used: true, weight: null, history: minOf(getDs('races').history, getDs('results').history), auto: getDs('results').auto, sourceLabel: 'races + race_results', note: '使用中（days since last race sweet spot 14-28）' },
    { key: 'distance_fit', label: '途程適應', used: false, weight: 0, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × distance', note: 'stub 0 · 未寫入 analyze.ts' },
    { key: 'going_fit', label: '場地適應', used: false, weight: 0, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × going', note: 'stub 0' },
    { key: 'draw_bias', label: '檔位偏差', used: false, weight: 0, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × venue × distance × draw', note: 'stub 0' },
    { key: 'weight_delta', label: '負磅變化', used: false, weight: 0, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results.horse_weight', note: 'stub 0' },
    { key: 'trackwork_fit', label: '晨操狀態', used: false, weight: 0, history: getDs('trackwork').history, auto: getDs('trackwork').auto, sourceLabel: 'horse_trackwork', note: 'stub 0 · 資料本身亦未齊' },
    { key: 'injury', label: '傷患', used: false, weight: 0, history: getDs('injury').history, auto: getDs('injury').auto, sourceLabel: 'horse_injury', note: 'stub 0' },
    { key: 'jt_combo', label: '騎練配對', used: false, weight: 0, history: minOf(getDs('races').history, getDs('jockeys').history, getDs('trainers').history), auto: getDs('races').auto, sourceLabel: 'races × jockeys × trainers', note: 'stub 0' },
  ];

  // Alerts
  const now = new Date();
  const alerts: { level: string; msg: string }[] = [];
  if (!oddsCount) alerts.push({ level: 'red', msg: '賠率表 odds_snapshots 完全冇資料' });
  else if (oddsLatest) {
    const hrs = (now.getTime() - new Date(oddsLatest).getTime()) / 3600000;
    if (hrs > 6) alerts.push({ level: 'red', msg: `賠率已停更新 ${hrs.toFixed(1)} 小時` });
  }
  if (latestTW) {
    const days = Math.floor((now.getTime() - new Date(latestTW).getTime()) / 86400000);
    if (days > 3) alerts.push({ level: 'yellow', msg: `晨操資料落後 ${days} 日（最新：${latestTW}）` });
  } else alerts.push({ level: 'yellow', msg: '晨操資料完全冇' });
  if (nextMeet && (!entLatest || entLatest < nextMeet)) {
    alerts.push({ level: 'yellow', msg: `排位表未同步（最新 ${entLatest || '—'} · 下場 ${nextMeet}）` });
  }
  if (meetLatest) {
    const days = Math.floor((now.getTime() - new Date(meetLatest).getTime()) / 86400000);
    if (days > 14) alerts.push({ level: 'red', msg: `賽馬日已 ${days} 日冇更新（${meetLatest}）` });
  }
  const cutoff = now.getTime() - 3 * 3600000;
  for (const f of runs.filter((x: any) => x.conclusion === 'failure' && new Date(x.updated_at).getTime() > cutoff).slice(0, 3)) {
    alerts.push({ level: 'red', msg: `工作流失敗：${f.name}（#${f.id}）` });
  }

  // Meetings
  const { results: meetRows } = await db.prepare(`
    SELECT m.id, m.date, m.venue, m.track_condition, m.total_races, COUNT(r.id) AS race_count,
           (SELECT COUNT(*) FROM entries_upcoming e WHERE e.race_date = m.date) AS entry_count
    FROM race_meetings m LEFT JOIN races r ON r.meeting_id = m.id
    GROUP BY m.id ORDER BY m.date DESC LIMIT 10
  `).all().catch(() => ({ results: [] as any[] }));

  return {
    coverage: { datasets, factors },
    status: {
      counts: { meetings: mc, races: rc, results: rsc, horses: hc, jockeys: jc, trainers: tc,
        trackwork: twc, injury: ic, form: fc, entries: ec, odds: oc,
        horseElo: heC, jockeyElo: jeC, trainerElo: teC },
      dates: { earliestMeeting: earliestM, latestMeeting: latestM,
        latestEntry: latestE, latestTrackwork: latestTW, latestElo, latestOdds: latestO },
      serverTime: now.toISOString(),
    },
    alerts: { alerts },
    runs: { runs: runs.slice(0, 20).map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, updatedAt: r.updated_at, htmlUrl: r.html_url })) },
    meetings: { meetings: meetRows ?? [] },
  };
}

function renderPanel(token: string, preloaded: Record<string, any>): string {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>天喜 · 內部控制台</title>
<style>
  :root {
    --bg:#f5f5f4; --fg:#1c1c1c; --mut:#6b6760; --rule:#d8d4cb;
    --green:#18a355; --red:#c8102e; --blue:#1d5dca; --warn:#d9a40b;
  }
  * { box-sizing: border-box }
  body { font: 14px/1.45 -apple-system, "PingFang TC", "Noto Sans TC", Helvetica, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:24px; max-width:1400px; margin-left:auto; margin-right:auto }
  h1 { font-size: 18px; margin:0 0 6px; letter-spacing:.02em }
  h2 { font-size: 13px; margin:24px 0 10px; letter-spacing:.08em; color:var(--mut) }
  .bar { color:var(--mut); margin-bottom:16px; font-size:12px }
  .refresh { color:var(--mut); font-size:11px; margin-left:8px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px }
  .tile { background:#fff; padding:10px 12px; border:1px solid var(--rule); border-radius:4px }
  .tile .label { font-size:11px; color:var(--mut) }
  .tile .val { font-size:18px; font-weight:600; margin-top:2px }
  .tile .sub { font-size:11px; color:var(--mut); margin-top:2px }
  .tile.warn { border-color:var(--warn); background:#fffaec }
  .tile.bad  { border-color:var(--red); background:#fdf0f2 }
  table { border-collapse:collapse; width:100%; font-size:13px; background:#fff; border:1px solid var(--rule) }
  th,td { padding:7px 10px; text-align:left; border-bottom:1px solid var(--rule) }
  th { background:#ede8dc; font-weight:500; font-size:11px; letter-spacing:.04em }
  td.ok { color:var(--green) } td.bad { color:var(--red) } td.warn { color:var(--warn) }
  button { background:var(--fg); color:#fff; border:0; padding:6px 12px; font-family:inherit; font-size:13px; cursor:pointer; border-radius:3px }
  button:hover { opacity:.85 }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--rule) }
  input, select { font-family:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--rule); border-radius:3px; background:#fff }
  .actions-row { display:flex; gap:6px; align-items:center; margin-bottom:8px; flex-wrap:wrap }
  .log { font-family: ui-monospace, Menlo, monospace; font-size:12px; background:#1c1c1c; color:#eee; padding:10px; border-radius:4px; max-height:240px; overflow:auto; white-space:pre-wrap; margin-top:8px }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500 }
  .pill.success, .pill.completed { background:#d8efdd; color:#186e2e }
  .pill.failure { background:#f7d4d9; color:#8a0e24 }
  .pill.in_progress { background:#ffecc9; color:#8a6a0a }
  .pill.queued { background:#e4e0d6; color:var(--mut) }
  /* Status chip (for coverage tables) */
  .chip { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600 }
  .chip.ok   { background:#d8efdd; color:#186e2e }
  .chip.warn { background:#fff0c6; color:#8a6a0a }
  .chip.bad  { background:#f7d4d9; color:#8a0e24 }
  .chip .icon { font-size:11px }
  #alertbar { margin-bottom:16px; border-radius:4px; overflow:hidden }
  #alertbar .alert { padding:8px 12px; font-size:13px; border-left:4px solid var(--rule) }
  #alertbar .alert.red { background:#fdf0f2; border-left-color:var(--red); color:#7a0b1e }
  #alertbar .alert.yellow { background:#fffaec; border-left-color:var(--warn); color:#6a4d05 }
  #alertbar .alert.ok { background:#e8f5ec; border-left-color:var(--green); color:#186e2e }
  #alertbar .alert + .alert { border-top:1px solid rgba(0,0,0,0.06) }
  .pulse { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--green); animation: p 1.8s infinite }
  @keyframes p { 0%{opacity:.3} 50%{opacity:1} 100%{opacity:.3} }
  .muted-cell { color:var(--mut); font-size:12px }
  .used-yes { color:var(--green); font-weight:600 }
  .used-no { color:var(--mut) }
  .weight { font-family: ui-monospace, Menlo, monospace; font-size:12px }
</style></head>
<body>
  <h1>天喜 · 內部控制台 <span class="pulse" title="實時監控"></span></h1>
  <div class="bar">伺服器端渲染 · 每 60 秒自動刷新<span class="refresh" id="refreshClock"></span></div>

  <div id="alertbar"></div>

  <h2>資料來源覆蓋（14 個核心表）</h2>
  <table id="coverDS"><thead><tr>
    <th>資料源</th><th>歷史齊全</th><th>自動更新</th><th>最新運行</th><th>最後成功</th><th>數量 / 最新</th><th>負責工作流</th>
  </tr></thead><tbody></tbody></table>

  <h2>預測因子覆蓋（11 個因子）</h2>
  <table id="coverFac"><thead><tr>
    <th>因子</th><th>目前使用</th><th>權重</th><th>歷史齊全</th><th>自動更新</th><th>資料來源</th><th>備註</th>
  </tr></thead><tbody></tbody></table>

  <h2>D1 即時計數</h2>
  <div id="status" class="grid"></div>


  <h2>最近工作流運行</h2>
  <table id="runs"><thead><tr><th>ID</th><th>名稱</th><th>狀態</th><th>結果</th><th>更新時間</th></tr></thead><tbody></tbody></table>

  <h2>最近賽事</h2>
  <table id="recentMeetings"><thead><tr>
    <th>日期</th><th>場地</th><th>場地狀況</th><th>場數</th><th>操作</th>
  </tr></thead><tbody></tbody></table>

  <h2>即時預測工具</h2>
  <div class="actions-row">
    <select id="predictRaceId" style="min-width:320px">
      <option value="">← 先從「最近賽事」選一場賽事</option>
    </select>
    <button onclick="runPredict()">運算預測</button>
    <span id="predictStatus" style="font-size:12px;color:var(--mut)"></span>
  </div>
  <table id="predictTable" style="display:none"><thead><tr>
    <th>排名</th><th>馬號</th><th>馬名</th><th>騎師 / 練馬師</th>
    <th>馬匹ELO</th><th>騎師ELO</th><th>練馬師ELO</th>
    <th>綜合ELO</th><th>調整</th><th>最終分</th><th>勝率</th><th>前三</th><th>賠率</th>
  </tr></thead><tbody></tbody></table>

<script>
  // ── 伺服器端預載資料 (SSR) — 無需任何 fetch 呼叫 ──
  const D = ${JSON.stringify(preloaded)};
  const TOKEN = ${JSON.stringify(token)};
  function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString() }
  function fmtDate(s) { return s || '—' }

  function chip(level, okLabel, warnLabel, badLabel) {
    const label = level === 'ok' ? (okLabel || '齊全 ✓') : level === 'warn' ? (warnLabel || '部分 ▲') : (badLabel || '未達標 ✗');
    return '<span class="chip ' + level + '"><span class="icon">' +
      (level === 'ok' ? '✓' : level === 'warn' ? '▲' : '✗') + '</span>' + label + '</span>';
  }

  function fmtTs(s) {
    if (!s) return '<span class="muted-cell">—</span>';
    // Format YYYY-MM-DDTHH:MM:SSZ → MM-DD HH:MM
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) return s;
    return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }
  function fmtSuccess(s, ageH) {
    if (!s) return '<span class="chip bad"><span class="icon">✗</span>從未成功</span>';
    const label = fmtTs(s);
    // ageH thresholds: ≤26h ok, ≤72h warn, >72h bad
    const level = ageH == null ? 'bad' : ageH <= 26 ? 'ok' : ageH <= 72 ? 'warn' : 'bad';
    const suffix = ageH == null ? '' : ' (' + (ageH < 24 ? ageH.toFixed(1) + 'h' : Math.floor(ageH/24) + 'd') + ')';
    return '<span class="chip ' + level + '"><span class="icon">' +
      (level === 'ok' ? '✓' : level === 'warn' ? '▲' : '✗') + '</span>' + label + suffix + '</span>';
  }

  // ── SSR render functions (read from D, no fetch needed) ──
  function renderCoverage() {
    const c = D.coverage || {};
    const ds = document.querySelector('#coverDS tbody');
    if (!ds) { console.error('[admin] #coverDS tbody not found'); return; }
    if (!c.datasets) { ds.innerHTML = '<tr><td colspan="7" class="bad">資料載入失敗</td></tr>'; return; }
    ds.innerHTML = (c.datasets || []).map(d =>
      '<tr>' +
      '<td><strong>' + d.label + '</strong><div class="muted-cell">' + d.key + '</div></td>' +
      '<td>' + chip(d.history, '歷史齊全 ✓', null, '未達標 ✗') + '</td>' +
      '<td>' + chip(d.auto, '自動更新 ✓', null, '停止更新 ✗') + '</td>' +
      '<td class="muted-cell">' + fmtTs(d.lastRunAt) + '</td>' +
      '<td>' + fmtSuccess(d.lastSuccessAt, d.lastSuccessAgeH) + '</td>' +
      '<td class="muted-cell">' + d.detail + '</td>' +
      '<td class="muted-cell">' + (d.workflows || []).join(' · ') + '</td>' +
      '</tr>'
    ).join('');
    const fc = document.querySelector('#coverFac tbody');
    if (!fc) { console.error('[admin] #coverFac tbody not found'); return; }
    fc.innerHTML = (c.factors || []).map(f =>
      '<tr>' +
      '<td><strong>' + f.label + '</strong><div class="muted-cell">' + f.key + '</div></td>' +
      '<td>' + (f.used ? '<span class="used-yes">使用中</span>' : '<span class="used-no">stub（未啟用）</span>') + '</td>' +
      '<td class="weight">' + (f.weight != null ? f.weight : '—') + '</td>' +
      '<td>' + chip(f.history, '歷史齊全 ✓', null, '未達標 ✗') + '</td>' +
      '<td>' + chip(f.auto, '自動更新 ✓', null, '停止更新 ✗') + '</td>' +
      '<td class="muted-cell">' + f.sourceLabel + '</td>' +
      '<td class="muted-cell">' + f.note + '</td>' +
      '</tr>'
    ).join('');
  }

  function renderStatus() {
    const s = D.status || {};
    const el = document.getElementById('status');
    if (!el) { console.error('[admin] #status not found'); return; }
    if (!s.counts) { el.innerHTML = '<div class="tile bad">資料載入失敗</div>'; return; }
    const tiles = [
      ['賽馬日', s.counts.meetings, (s.dates.earliestMeeting||'?') + ' → ' + (s.dates.latestMeeting||'?'), ''],
      ['場次', s.counts.races, '', ''],
      ['賽果', s.counts.results, '', ''],
      ['馬匹', s.counts.horses, '', ''],
      ['騎師', s.counts.jockeys, '', ''],
      ['練馬師', s.counts.trainers, '', ''],
      ['晨操', s.counts.trackwork, '最新：' + fmtDate(s.dates.latestTrackwork), s.counts.trackwork < 500 ? 'warn' : ''],
      ['傷患', s.counts.injury, '', ''],
      ['往績', s.counts.form, '', ''],
      ['排位表', s.counts.entries, '最新：' + fmtDate(s.dates.latestEntry), ''],
      ['賠率', s.counts.odds, '最新：' + fmtDate(s.dates.latestOdds), s.counts.odds === 0 ? 'bad' : ''],
      ['馬匹 ELO', s.counts.horseElo, '最新：' + fmtDate(s.dates.latestElo), ''],
      ['騎師 ELO', s.counts.jockeyElo, '', ''],
      ['練馬師 ELO', s.counts.trainerElo, '', ''],
    ];
    el.innerHTML = tiles.map(([l,v,sub,cls]) =>
      '<div class="tile ' + cls + '"><div class="label">' + l + '</div>' +
      '<div class="val">' + fmtNum(v) + '</div>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>').join('');
  }


  function renderAlerts() {
    const a = D.alerts || {};
    const bar = document.getElementById('alertbar');
    if (!bar) { console.error('[admin] #alertbar not found'); return; }
    if (!a.alerts || !a.alerts.length) {
      bar.innerHTML = '<div class="alert ok">✓ 系統正常 · 無告警</div>'; return;
    }
    bar.innerHTML = a.alerts.map(x =>
      '<div class="alert ' + x.level + '">' + (x.level === 'red' ? '⚠ ' : '▲ ') + x.msg + '</div>'
    ).join('');
  }

  function renderRuns() {
    const r = D.runs || {};
    const tb = document.querySelector('#runs tbody');
    if (!tb) { console.error('[admin] #runs tbody not found'); return; }
    if (!r.runs || !r.runs.length) { tb.innerHTML = '<tr><td colspan="5" class="warn">無運行記錄</td></tr>'; return; }
    tb.innerHTML = r.runs.map(x => {
      const st = '<span class="pill ' + x.status + '">' + x.status + '</span>';
      const cc = x.conclusion ? '<span class="pill ' + x.conclusion + '">' + x.conclusion + '</span>' : '—';
      return '<tr><td><a href="' + x.htmlUrl + '" target="_blank">' + x.id + '</a></td>' +
        '<td>' + (x.name || '').slice(0, 40) + '</td><td>' + st + '</td><td>' + cc + '</td>' +
        '<td>' + (x.updatedAt || '').slice(5, 16).replace('T', ' ') + '</td></tr>';
    }).join('');
  }

  function renderMeetings() {
    const data = D.meetings || {};
    const tb = document.querySelector('#recentMeetings tbody');
    if (!tb) { console.error('[admin] #recentMeetings tbody not found'); return; }
    if (!data.meetings || !data.meetings.length) {
      tb.innerHTML = '<tr><td colspan="5" class="warn">無賽事資料</td></tr>'; return;
    }
    window._meetingList = data.meetings;
    tb.innerHTML = data.meetings.map((m, i) => {
      const venue = m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : (m.venue || '—');
      return '<tr>' +
        '<td><strong>' + (m.date || '—') + '</strong></td>' +
        '<td>' + venue + '</td>' +
        '<td class="muted-cell">' + (m.track_condition || '—') + '</td>' +
        '<td>' + (m.race_count > 0 ? m.race_count + ' 場' : m.total_races ? m.total_races + ' 場' : m.entry_count > 0 ? '今日 (待賽)' : '0 場') + '</td>' +
        '<td><button class="ghost" style="font-size:11px;padding:3px 8px" onclick="loadRacesForPredictByIndex(' + i + ')">預測此日</button></td>' +
        '</tr>';
    }).join('');
  }


  function loadRacesForPredictByIndex(i) {
      const m = window._meetingList && window._meetingList[i];
      if (!m) return;
      loadRacesForPredict(m.id || '', m.date || '', m.race_count || m.total_races || 0);
    }

    async function loadRacesForPredict(meetingId, date, raceCount) {
    const sel = document.getElementById('predictRaceId');
    sel.innerHTML = '<option value="">載入中…</option>';
    document.getElementById('predictStatus').textContent = '';
    document.getElementById('predictTable').style.display = 'none';
    try {
      const res = await fetch('/api/meetings/' + encodeURIComponent(date));
      const data = await res.json();
      let races = data.races || [];
      if (!races.length && data.upcomingRaces) races = data.upcomingRaces;
      // If still no races, try smart/current for upcoming meetings
      if (!races.length) {
        sel.innerHTML = '<option value="">此日無已入 D1 的場次（可能為未來賽事）</option>'; return;
      }
      sel.innerHTML = '<option value="">選擇場次…</option>' + races.map(r => {
        const raceId = r.id || ('race_' + date + '_' + (data.venue||'ST') + '_' + r.raceNumber);
        const cls = r.class || r.raceClass || '';
        const dist = r.distance || r.dist || '';
        return '<option value="' + raceId + '">第' + (r.raceNumber||r.race_number) + '場 · ' + (r.title||r.raceName||'') + (dist?' · '+dist+'m':'') + (cls?' · '+cls:'') + '</option>';
      }).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">載入失敗：' + e.message + '</option>';
    }
  }

  // ── Prediction tool ──────────────────────────────────────────
  async function runPredict() {
    const raceId = document.getElementById('predictRaceId').value;
    if (!raceId) { alert('請先選擇場次'); return; }
    const statusEl = document.getElementById('predictStatus');
    const table = document.getElementById('predictTable');
    statusEl.textContent = '運算中…';
    table.style.display = 'none';
    try {
      // /api/analyze/top-picks is a public endpoint (no auth needed)
      const res = await fetch('/api/analyze/top-picks?raceId=' + encodeURIComponent(raceId));
      const data = await res.json();
      if (data.error) { statusEl.textContent = '錯誤: ' + data.error; return; }
      const picks = data.allPicks || data.picks || [];
      if (!picks.length) { statusEl.textContent = '無預測資料'; return; }
      const engineTag = data.eloEngine === 'v12' ? 'v1.2' : (data.eloEngine || '—');
      statusEl.textContent = '✓ ' + (data.date || '') + ' 第' + (data.raceNumber || '') + '場 · ELO引擎 ' + engineTag + ' · ' + picks.length + ' 匹';
      const tb = table.querySelector('tbody');
      tb.innerHTML = picks.map(p => {
        const fmtElo = v => v != null ? Math.round(v) : '<span class="muted-cell">—</span>';
        const fmtPct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
        const fmtScore = v => v != null ? Math.round(v * 10) / 10 : '—';
        const fmtOdds = v => v != null ? v : '—';
        const rankCls = p.rank === 1 ? 'style="color:var(--green);font-weight:700"' : p.rank <= 3 ? 'style="color:var(--warn);font-weight:600"' : '';
        return '<tr>' +
          '<td ' + rankCls + '>' + p.rank + '</td>' +
          '<td>' + (p.horseNumber || '—') + '</td>' +
          '<td><strong>' + (p.nameCh || p.nameEn || '—') + '</strong>' +
            (p.horseFrozen ? ' <span class="pill queued">停賽</span>' : '') +
            (p.horseRetired ? ' <span class="pill failure">退役</span>' : '') + '</td>' +
          '<td class="muted-cell">' + (p.jockeyCh || '—') + ' / ' + (p.trainerCh || '—') + '</td>' +
          '<td>' + fmtElo(p.horseElo) + '</td>' +
          '<td>' + fmtElo(p.jockeyElo) + '</td>' +
          '<td>' + fmtElo(p.trainerElo) + '</td>' +
          '<td><strong>' + fmtElo(p.eloComposite) + '</strong></td>' +
          '<td class="' + (p.factorBonus > 0 ? 'ok' : p.factorBonus < 0 ? 'bad' : '') + '">' +
            (p.factorBonus != null ? (p.factorBonus >= 0 ? '+' : '') + Math.round(p.factorBonus * 10) / 10 : '—') + '</td>' +
          '<td><strong>' + fmtScore(p.finalScore) + '</strong></td>' +
          '<td class="' + (p.rank <= 2 ? 'ok' : '') + '">' + fmtPct(p.pWin) + '</td>' +
          '<td>' + fmtPct(p.pTop3) + '</td>' +
          '<td class="muted-cell">' + fmtOdds(p.winOdds) + '</td>' +
          '</tr>';
      }).join('');
      table.style.display = 'table';
    } catch (e) {
      statusEl.textContent = '錯誤: ' + e.message;
    }
  }

  // ── 初始化：直接渲染伺服器端數據，無需 fetch ──
  function safeRender(name, fn) {
    try { fn(); } catch (e) { console.error('[admin] ' + name + ' 渲染失敗:', e.message, e); }
  }
  safeRender('renderAlerts', renderAlerts);
  safeRender('renderCoverage', renderCoverage);
  safeRender('renderStatus', renderStatus);
  safeRender('renderRuns', renderRuns);
  safeRender('renderMeetings', renderMeetings);
  document.getElementById('refreshClock').textContent = '載入時間：' + new Date().toLocaleTimeString('zh-HK') + ' · 每 60 秒自動刷新';
  // Auto-reload page every 60s for fresh data
  setTimeout(() => window.location.reload(), 60000);
</script>
</body></html>`;
}
