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
    { key: 'distance_fit', label: '途程適應', used: true, weight: 20,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × races.distance', note: '使用中 · 同途程 ±200m 歷史上位率 · 最大調整 ±20 ELO' },
    { key: 'going_fit', label: '場地適應', used: true, weight: 15,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × races.going', note: '使用中 · 該場地狀況歷史上位率 · 最大調整 ±15 ELO' },
    { key: 'draw_bias', label: '檔位偏差', used: true, weight: 10,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results × venue × distance × draw', note: '使用中 · 需 ≥20 樣本方啟效 · 最大調整 ±10 ELO' },
    { key: 'weight_delta', label: '負磅變化', used: true, weight: 8,
      history: getDs('results').history, auto: getDs('results').auto,
      sourceLabel: 'race_results.actual_weight', note: '使用中 · 與近4 5 戰均磅比較 · 最大調整 ±8 ELO' },
    { key: 'trackwork_fit', label: '晨操狀態', used: true, weight: 8,
      history: getDs('trackwork').history, auto: getDs('trackwork').auto,
      sourceLabel: 'horse_trackwork (14d window)', note: '使用中 · 甜區 4-6 課/14天 +8 · 過操減分 · 最大調整 ±8 ELO' },
    { key: 'injury', label: '傷患', used: true, weight: 15,
      history: getDs('injury').history, auto: getDs('injury').auto,
      sourceLabel: 'horse_injury (180d lookback)', note: '使用中 · 指數衰減 45 天半衰期 · 未復原最大 -15 ELO' },
    { key: 'jt_combo', label: '騎練配對', used: true, weight: 12,
      history: minOf(getDs('races').history, getDs('jockeys').history, getDs('trainers').history),
      auto: getDs('races').auto,
      sourceLabel: 'race_results × jockey_id × trainer_id', note: '使用中 · 需 ≥10 合作場次 · 最大調整 ±12 ELO' },
  ];

  return c.json({ datasets, factors, checkedAt: new Date().toISOString() });
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
    { key: 'distance_fit', label: '途程適應', used: true, weight: 20, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × races.distance', note: '使用中 · 同途程 ±200m 歷史上位率 · 最大調整 ±20 ELO' },
    { key: 'going_fit', label: '場地適應', used: true, weight: 15, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × races.going', note: '使用中 · 該場地狀況歷史上位率 · 最大調整 ±15 ELO' },
    { key: 'draw_bias', label: '檔位偏差', used: true, weight: 10, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results × venue × distance × draw', note: '使用中 · 需 ≥20 樣本方啟效 · 最大調整 ±10 ELO' },
    { key: 'weight_delta', label: '負磅變化', used: true, weight: 8, history: getDs('results').history, auto: getDs('results').auto, sourceLabel: 'race_results.actual_weight', note: '使用中 · 與近 5 戰均磅比較 · 最大調整 ±8 ELO' },
    { key: 'trackwork_fit', label: '晨操狀態', used: true, weight: 8, history: getDs('trackwork').history, auto: getDs('trackwork').auto, sourceLabel: 'horse_trackwork (14d window)', note: '使用中 · 甜區 4-6 課/14天 +8 · 過操減分 · 最大調整 ±8 ELO' },
    { key: 'injury', label: '傷患', used: true, weight: 15, history: getDs('injury').history, auto: getDs('injury').auto, sourceLabel: 'horse_injury (180d lookback)', note: '使用中 · 指數衰減 45 天半衰期 · 未復原最大 -15 ELO' },
    { key: 'jt_combo', label: '騎練配對', used: true, weight: 12, history: minOf(getDs('races').history, getDs('jockeys').history, getDs('trainers').history), auto: getDs('races').auto, sourceLabel: 'race_results × jockey_id × trainer_id', note: '使用中 · 需 ≥10 合作場次 · 最大調整 ±12 ELO' },
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


    // Next/current race day: races + live WIN odds
    const todayStr = now.toISOString().split('T')[0];
    let nextRaceDay: any = null;
    try {
      const tm: any = await db.prepare(
        `SELECT * FROM race_meetings WHERE date >= ? ORDER BY date ASC LIMIT 1`
      ).bind(todayStr).first<any>().catch(() => null)
      ?? await db.prepare(`SELECT * FROM race_meetings ORDER BY date DESC LIMIT 1`).first<any>().catch(() => null);
      if (tm) {
        const [racesRes, euRes, oddsRes] = await Promise.all([
          db.prepare(`SELECT id, race_number, title, class, distance, start_time FROM races WHERE meeting_id = ? ORDER BY race_number`).bind(tm.id).all<any>().catch(() => ({ results: [] as any[] })),
          db.prepare(`SELECT DISTINCT e.horse_code, h.name_ch, h.name_en FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id WHERE e.race_date = ? ORDER BY e.horse_code`).bind(tm.date).all<any>().catch(() => ({ results: [] as any[] })),
          db.prepare(`SELECT o.race_number, o.combination, o.odds FROM odds_snapshots o INNER JOIN (SELECT race_number, MAX(snapshot_at) AS ls FROM odds_snapshots WHERE race_date = ? AND venue = ? AND pool_type = 'WIN' GROUP BY race_number) lt ON o.race_number = lt.race_number AND o.snapshot_at = lt.ls WHERE o.race_date = ? AND o.venue = ? AND o.pool_type = 'WIN' ORDER BY o.race_number, CAST(o.combination AS INTEGER)`).bind(tm.date, tm.venue, tm.date, tm.venue).all<any>().catch(() => ({ results: [] as any[] })),
        ]);
        const oddsMap: Record<number, Record<string, number>> = {};
        for (const o of (oddsRes.results ?? [])) {
          const oo = o as any;
          if (!oddsMap[oo.race_number]) oddsMap[oo.race_number] = {};
          oddsMap[oo.race_number][oo.combination] = oo.odds;
        }
        nextRaceDay = {
          date: tm.date, venue: tm.venue, trackCondition: tm.track_condition,
          isUpcoming: tm.date >= todayStr,
          races: (racesRes.results ?? []).map((r: any) => ({
            id: r.id, raceNumber: r.race_number, title: r.title, class: r.class,
            distance: r.distance, startTime: r.start_time, odds: oddsMap[r.race_number] ?? {},
          })),
          horses: euRes.results ?? [],
        };
      }
    } catch {}
  
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
    nextRaceDay,
  };
}

function renderPanel(token: string, preloaded: Record<string, any>): string {
    return `<!doctype html>
  <html lang="zh-Hant"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>天璣 · 控制台</title>
  <style>
  :root {
    --bg:#08090e; --bg2:#0d1020; --bg3:#111827;
    --fg:#e2e8f0; --mut:#64748b; --border:rgba(148,163,184,0.1);
    --card:rgba(255,255,255,0.035);
    --purple:#8b5cf6; --cyan:#22d3ee; --amber:#f59e0b;
    --green:#4ade80; --red:#f87171; --blue:#60a5fa;
    --gradient:linear-gradient(135deg,#7c3aed,#06b6d4,#7c3aed);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font:14px/1.55 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:var(--bg);color:var(--fg);padding:28px 32px;max-width:1480px;margin:0 auto;min-height:100vh}

  /* ── Aurora gradient text ── */
  @keyframes aurora{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  .aurora-text{background:linear-gradient(270deg,#7c3aed,#22d3ee,#60a5fa,#8b5cf6,#22d3ee,#7c3aed);background-size:400% 400%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:aurora 12s ease infinite}

  /* ── Gradient text (section headers) ── */
  @keyframes grad-shift{0%{background-position:0%}100%{background-position:200%}}
  .grad-text{background:linear-gradient(90deg,var(--mut),var(--cyan),var(--purple),var(--mut));background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:grad-shift 6s linear infinite}

  /* ── Reveal animation ── */
  @keyframes reveal-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .reveal{animation:reveal-up .5s ease both}
  .reveal-d1{animation-delay:.05s}.reveal-d2{animation-delay:.1s}.reveal-d3{animation-delay:.15s}
  .reveal-d4{animation-delay:.2s}.reveal-d5{animation-delay:.25s}.reveal-d6{animation-delay:.3s}

  /* ── Header ── */
  .hdr{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--border)}
  .hdr-left h1{font-size:22px;font-weight:700;letter-spacing:-.01em}
  .hdr-left .sub{font-size:12px;color:var(--mut);margin-top:4px;letter-spacing:.06em}
  .hdr-right{font-size:11px;color:var(--mut);text-align:right}
  #refreshClock{display:block;margin-top:2px}

  /* ── Pulse dot ── */
  @keyframes pulse-ring{0%{transform:scale(.8);opacity:.8}70%{transform:scale(1.4);opacity:0}100%{transform:scale(1.4);opacity:0}}
  .pulse-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;vertical-align:middle;margin-left:8px}
  .pulse-dot{width:8px;height:8px;border-radius:50%;background:var(--green);position:relative;z-index:1;box-shadow:0 0 8px var(--green)}
  .pulse-ring{position:absolute;width:14px;height:14px;border-radius:50%;background:var(--green);opacity:.6;animation:pulse-ring 2s ease-out infinite}

  /* ── Alert bar ── */
  #alertbar{margin-bottom:20px;border-radius:10px;overflow:hidden;border:1px solid var(--border)}
  #alertbar .alert{padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:10px;border-left:3px solid transparent}
  #alertbar .alert-icon{font-size:14px;flex-shrink:0}
  #alertbar .alert.red{background:rgba(239,68,68,.08);border-left-color:var(--red);color:#fca5a5}
  #alertbar .alert.yellow{background:rgba(245,158,11,.08);border-left-color:var(--amber);color:#fcd34d}
  #alertbar .alert.ok{background:rgba(74,222,128,.08);border-left-color:var(--green);color:var(--green)}
  #alertbar .alert+.alert{border-top:1px solid var(--border)}

  /* ── Marquee ── */
  @keyframes marquee-scroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
  .marquee-wrap{overflow:hidden;white-space:nowrap}
  .marquee-inner{display:inline-block;animation:marquee-scroll 22s linear infinite}
  .marquee-inner:hover{animation-play-state:paused}

  /* ── Section headings ── */
  h2{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin:28px 0 12px;display:flex;align-items:center;gap:8px}
  h2 .h2-line{flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent)}

  /* ── Glass card / panel ── */
  .glass{background:var(--card);border:1px solid var(--border);border-radius:10px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);position:relative;overflow:hidden}

  /* ── Border beam ── */
  @keyframes beam-rotate{0%{--beam-angle:0deg}100%{--beam-angle:360deg}}
  @property --beam-angle{syntax:"<angle>";inherits:false;initial-value:0deg}
  .beam{animation:beam-rotate 4s linear infinite}
  .beam::before{content:"";position:absolute;inset:-1px;border-radius:inherit;background:conic-gradient(from var(--beam-angle),transparent 70%,rgba(139,92,246,.6) 80%,rgba(34,211,238,.8) 90%,rgba(139,92,246,.6) 95%,transparent 100%);z-index:0;pointer-events:none}
  .beam>*{position:relative;z-index:1}

  /* ── Shine border ── */
  @keyframes shine-border{0%{background-position:0% 50%}100%{background-position:200% 50%}}
  .shine-border{border:1px solid transparent;border-radius:10px;background:linear-gradient(var(--bg3),var(--bg3)) padding-box,linear-gradient(270deg,#7c3aed,#22d3ee,#60a5fa,#7c3aed) border-box;background-size:300% 300%;animation:shine-border 5s linear infinite}

  /* ── Grid tiles (stats) ── */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:8px}
  .tile{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 14px;transition:border-color .25s,background .25s;cursor:default}
  .tile:hover{border-color:rgba(139,92,246,.35);background:rgba(139,92,246,.06)}
  .tile .t-label{font-size:11px;color:var(--mut);letter-spacing:.04em;margin-bottom:6px}
  .tile .t-val{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--fg);line-height:1}
  .tile .t-sub{font-size:10px;color:var(--mut);margin-top:5px}
  .tile.bad{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.05)}
  .tile.bad .t-val{color:var(--red)}
  .tile.warn{border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.05)}

  /* ── Tables ── */
  .tbl-wrap{border-radius:10px;overflow:hidden;border:1px solid var(--border)}
  table{border-collapse:collapse;width:100%;font-size:12.5px}
  th{background:rgba(255,255,255,.04);color:var(--mut);font-weight:600;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding:9px 12px;text-align:left;border-bottom:1px solid var(--border)}
  td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(255,255,255,.025)}

  /* ── Status chips ── */
  .chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em;border:1px solid transparent;white-space:nowrap}
  .chip.ok{background:rgba(74,222,128,.12);color:#4ade80;border-color:rgba(74,222,128,.25)}
  .chip.warn{background:rgba(245,158,11,.12);color:#fbbf24;border-color:rgba(245,158,11,.25)}
  .chip.bad{background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.25)}

  /* ── Workflow run pills ── */
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
  .pill.success,.pill.completed{background:rgba(74,222,128,.12);color:#4ade80}
  .pill.failure{background:rgba(239,68,68,.12);color:#f87171}
  .pill.in_progress{background:rgba(245,158,11,.12);color:#fbbf24}
  .pill.queued{background:rgba(148,163,184,.1);color:var(--mut)}

  /* ── Shiny button ── */
  @keyframes shimmer{0%{background-position:-200% center}100%{background-position:200% center}}
  .btn{position:relative;display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border:0;border-radius:6px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .2s,transform .1s;overflow:hidden;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;box-shadow:0 2px 12px rgba(124,58,237,.35)}
  .btn::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.25) 50%,transparent 60%);background-size:200% auto;animation:shimmer 3.5s linear infinite}
  .btn:hover{opacity:.9;transform:translateY(-1px)}
  .btn:active{transform:translateY(0);opacity:1}
  .btn.ghost{background:var(--card);border:1px solid var(--border);color:var(--fg);box-shadow:none;font-weight:500}
  .btn.ghost::after{background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.1) 50%,transparent 60%);background-size:200% auto;animation:shimmer 4s linear infinite}
  .btn.sm{padding:4px 10px;font-size:11px;font-weight:500}

  /* ── Form controls ── */
  select,input{font:inherit;font-size:13px;padding:7px 10px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--fg);outline:none;transition:border-color .2s}
  select:focus,input:focus{border-color:rgba(139,92,246,.5)}
  select option{background:#1a1a2e}

  /* ── Actions row ── */
  .actions-row{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}

  /* ── Log ── */
  .log{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#050507;color:#94a3b8;padding:12px;border-radius:6px;max-height:240px;overflow:auto;white-space:pre-wrap;margin-top:8px;border:1px solid var(--border)}

  /* ── Misc ── */
  .muted-cell{color:var(--mut);font-size:11.5px}
  .used-yes{color:var(--green);font-weight:600;font-size:12px}
  .used-no{color:var(--mut);font-size:12px}
  .weight{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--cyan)}
  td a{color:var(--cyan);text-decoration:none}
  td a:hover{text-decoration:underline}
  td strong{color:var(--fg)}
  td em{font-style:normal;color:var(--mut)}
  .rank-gold{color:#f59e0b;font-weight:700}
  .rank-silver{color:#94a3b8;font-weight:600}
  .rank-bronze{color:#b45309;font-weight:600}
  .nrd-race-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;transition:border-color .2s}
  .nrd-race-card:hover{border-color:rgba(139,92,246,.3)}
  .nrd-race-title{font-size:13px;font-weight:600;margin-bottom:8px;color:var(--fg)}
  .nrd-odds{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px}
  .nrd-odds-item{font-size:12px;color:var(--mut)}
  .nrd-odds-item strong{color:var(--fg)}
  .nrd-odds-item.hot strong,.nrd-odds-item.hot span{color:var(--green);font-weight:700}
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:rgba(148,163,184,.2);border-radius:2px}
  </style>
  </head>
  <body>

  <!-- Header -->
  <div class="hdr reveal">
    <div class="hdr-left">
      <h1><span class="aurora-text">天璣 · 控制台</span><span class="pulse-wrap"><span class="pulse-ring"></span><span class="pulse-dot"></span></span></h1>
      <div class="sub">TIANXI RACING INTELLIGENCE SYSTEM &nbsp;·&nbsp; INTERNAL DASHBOARD</div>
    </div>
    <div class="hdr-right">
      <span id="refreshClock"></span>
    </div>
  </div>

  <!-- Alert bar -->
  <div id="alertbar"></div>

  <!-- Dataset coverage -->
  <h2 class="reveal reveal-d1"><span class="grad-text">資料來源覆蓋</span><span style="color:var(--mut);font-size:10px"> 14 個核心表</span><span class="h2-line"></span></h2>
  <div class="tbl-wrap reveal reveal-d2">
    <table id="coverDS"><thead><tr>
      <th>資料源</th><th>歷史齊全</th><th>自動更新</th><th>最新運行</th><th>最後成功</th><th>數量 / 最新</th><th>工作流</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <!-- Factor coverage -->
  <h2 class="reveal reveal-d2"><span class="grad-text">預測因子覆蓋</span><span id="factorCovPct" style="color:var(--cyan);font-size:11px;font-weight:600;margin-left:8px"></span><span class="h2-line"></span></h2>
  <div class="tbl-wrap reveal reveal-d3">
    <table id="coverFac"><thead><tr>
      <th>因子</th><th>使用</th><th>權重</th><th>歷史齊全</th><th>自動更新</th><th>資料來源</th><th>備註</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <!-- D1 counts -->
  <h2 class="reveal reveal-d3"><span class="grad-text">D1 即時計數</span><span class="h2-line"></span></h2>
  <div id="status" class="grid reveal reveal-d4"></div>

  <!-- Workflow runs -->
  <h2 class="reveal reveal-d4"><span class="grad-text">最近工作流運行</span><span class="h2-line"></span></h2>
  <div class="tbl-wrap reveal reveal-d5">
    <table id="runs"><thead><tr><th>ID</th><th>名稱</th><th>狀態</th><th>結果</th><th>更新時間</th></tr></thead><tbody></tbody></table>
  </div>

  <!-- Recent meetings -->
  <h2 class="reveal reveal-d5"><span class="grad-text">最近賽事</span><span class="h2-line"></span></h2>
  <div class="tbl-wrap reveal reveal-d6">
    <table id="recentMeetings"><thead><tr>
      <th>日期</th><th>場地</th><th>場地狀況</th><th>場數</th><th>操作</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <!-- Prediction tool -->
  <h2 class="reveal reveal-d6"><span class="grad-text">即時預測工具</span><span class="h2-line"></span></h2>
  <div class="actions-row reveal">
    <select id="predictRaceId" style="min-width:320px">
      <option value="">← 先從「最近賽事」選一場賽事</option>
    </select>
    <button class="btn" onclick="runPredict()">運算預測</button>
    <span id="predictStatus" style="font-size:12px;color:var(--mut)"></span>
  </div>
  <div class="tbl-wrap" style="display:none" id="predictTableWrap">
    <table id="predictTable"><thead><tr>
      <th>排名</th><th>馬號</th><th>馬名</th><th>騎師 / 練馬師</th>
      <th>馬匹ELO</th><th>騎師ELO</th><th>練馬師ELO</th>
      <th>綜合ELO</th><th>調整</th><th>最終分</th><th>勝率</th><th>前三</th><th>賠率</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <!-- Next race day -->
  <h2><span class="grad-text">即日賽事排位表 + 即時賠率</span> <span id="nrdLabel" style="font-size:11px;font-weight:400;color:var(--mut);text-transform:none;letter-spacing:0"></span><span class="h2-line"></span></h2>
  <div id="nrdRaces"></div>
  <div id="nrdHorses"></div>

  <script>
  const D = ${JSON.stringify(preloaded)};
  const TOKEN = ${JSON.stringify(token)};

  /* ── Helpers ── */
  function fmtNum(n){return n==null?'—':Number(n).toLocaleString()}
  function fmtDate(s){return s||'—'}
  function fmtTs(s){
    if(!s)return '<span class="muted-cell">—</span>';
    const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    return m?m[2]+'-'+m[3]+' '+m[4]+':'+m[5]:s;
  }
  function chip(level,okLabel,warnLabel,badLabel){
    const label=level==='ok'?(okLabel||'齊全'):level==='warn'?(warnLabel||'部分'):(badLabel||'未達標');
    return '<span class="chip '+level+'">'+label+'</span>';
  }
  function fmtSuccess(s,ageH){
    if(!s)return '<span class="chip bad">從未成功</span>';
    const label=fmtTs(s);
    const level=ageH==null?'bad':ageH<=26?'ok':ageH<=72?'warn':'bad';
    const suffix=ageH==null?'':' ('+(ageH<24?ageH.toFixed(1)+'h':Math.floor(ageH/24)+'d')+')';
    return '<span class="chip '+level+'">'+label+suffix+'</span>';
  }

  /* ── Number ticker ── */
  function ticker(el,target){
    if(!el||target==null)return;
    const n=Number(target);
    if(!Number.isFinite(n)||n<100){el.textContent=fmtNum(n);return;}
    const dur=1400,start=performance.now();
    (function step(now){
      const t=Math.min((now-start)/dur,1),ease=1-Math.pow(1-t,3);
      el.textContent=Number(Math.round(n*ease)).toLocaleString();
      if(t<1)requestAnimationFrame(step);
      else el.textContent=fmtNum(n);
    })(start);
  }

  /* ── Render coverage ── */
  function renderCoverage(){
    const c=D.coverage||{};
    const ds=document.querySelector('#coverDS tbody');
    if(!ds)return;
    if(!c.datasets){ds.innerHTML='<tr><td colspan="7" style="color:var(--red)">資料載入失敗</td></tr>';return;}
    ds.innerHTML=(c.datasets||[]).map(d=>
      '<tr>'+
      '<td><strong>'+d.label+'</strong><div class="muted-cell">'+d.key+'</div></td>'+
      '<td>'+chip(d.history,'歷史齊全',null,'未達標')+'</td>'+
      '<td>'+chip(d.auto,'自動更新',null,'停止更新')+'</td>'+
      '<td class="muted-cell">'+fmtTs(d.lastRunAt)+'</td>'+
      '<td>'+fmtSuccess(d.lastSuccessAt,d.lastSuccessAgeH)+'</td>'+
      '<td class="muted-cell">'+d.detail+'</td>'+
      '<td class="muted-cell">'+(d.workflows||[]).join(' · ')+'</td>'+
      '</tr>'
    ).join('');
    const fc=document.querySelector('#coverFac tbody');
    if(!fc)return;
    fc.innerHTML=(c.factors||[]).map(f=>
      '<tr>'+
      '<td><strong>'+f.label+'</strong><div class="muted-cell">'+f.key+'</div></td>'+
      '<td>'+(f.used?'<span class="used-yes">使用中</span>':'<span class="chip bad" style="font-size:11px">停用</span>')+'</td>'+
      '<td class="weight">'+(f.weight!=null?f.weight:'—')+'</td>'+
      '<td>'+chip(f.history,'歷史齊全',null,'未達標')+'</td>'+
      '<td>'+chip(f.auto,'自動更新',null,'停止更新')+'</td>'+
      '<td class="muted-cell">'+f.sourceLabel+'</td>'+
      '<td class="muted-cell">'+f.note+'</td>'+
      '</tr>'
    ).join('');
    // Show coverage % in section heading
    const usedCount=(c.factors||[]).filter(f=>f.used).length;
    const totalCount=(c.factors||[]).length;
    const pct=totalCount>0?Math.round(usedCount/totalCount*100):0;
    const pctEl=document.getElementById('factorCovPct');
    if(pctEl)pctEl.textContent=usedCount+'/'+totalCount+' 因子使用中 · '+pct+'% 覆蓋率';
  }

  /* ── Render status tiles ── */
  function renderStatus(){
    const s=D.status||{};
    const el=document.getElementById('status');
    if(!el||!s.counts){if(el)el.innerHTML='<div class="tile bad">資料載入失敗</div>';return;}
    const tiles=[
      ['賽馬日',s.counts.meetings,(s.dates.earliestMeeting||'?')+' → '+(s.dates.latestMeeting||'?'),''],
      ['場次',s.counts.races,'',''],
      ['賽果',s.counts.results,'',''],
      ['馬匹',s.counts.horses,'',''],
      ['騎師',s.counts.jockeys,'',''],
      ['練馬師',s.counts.trainers,'',''],
      ['晨操',s.counts.trackwork,'最新：'+fmtDate(s.dates.latestTrackwork),s.counts.trackwork<500?'warn':''],
      ['傷患',s.counts.injury,'',''],
      ['往績',s.counts.form,'',''],
      ['排位表',s.counts.entries,'最新：'+fmtDate(s.dates.latestEntry),''],
      ['賠率快照',s.counts.odds,'最新：'+fmtDate(s.dates.latestOdds),s.counts.odds===0?'bad':''],
      ['馬匹 ELO',s.counts.horseElo,'最新：'+fmtDate(s.dates.latestElo),''],
      ['騎師 ELO',s.counts.jockeyElo,'',''],
      ['練馬師 ELO',s.counts.trainerElo,'',''],
    ];
    el.innerHTML=tiles.map(([l,v,sub,cls])=>
      '<div class="tile '+cls+'" data-ticker="'+v+'">'+
      '<div class="t-label">'+l+'</div>'+
      '<div class="t-val">'+fmtNum(v)+'</div>'+
      (sub?'<div class="t-sub">'+sub+'</div>':'')+
      '</div>'
    ).join('');
    // Run number tickers
    el.querySelectorAll('[data-ticker]').forEach(t=>{
      ticker(t.querySelector('.t-val'),Number(t.dataset.ticker));
    });
  }

  /* ── Render alerts ── */
  function renderAlerts(){
    const a=D.alerts||{};
    const bar=document.getElementById('alertbar');
    if(!bar)return;
    if(!a.alerts||!a.alerts.length){
      bar.innerHTML='<div class="alert ok"><span class="alert-icon">●</span> 系統正常 · 無告警</div>';
      return;
    }
    const icon={'red':'⬥','yellow':'◆'};
    if(a.alerts.length>2){
      const inner=a.alerts.map(x=>'<span style="margin-right:40px"><span style="margin-right:8px;opacity:.7">'+(icon[x.level]||'·')+'</span>'+x.msg+'</span>').join('');
      bar.innerHTML='<div class="alert '+(a.alerts[0].level==='red'?'red':'yellow')+'"><span class="alert-icon">'+(icon[a.alerts[0].level]||'·')+'</span><div class="marquee-wrap" style="flex:1"><div class="marquee-inner">'+inner+inner+'</div></div></div>';
    } else {
      bar.innerHTML=a.alerts.map(x=>'<div class="alert '+x.level+'"><span class="alert-icon">'+(icon[x.level]||'·')+'</span>'+x.msg+'</div>').join('');
    }
  }

  /* ── Render workflow runs ── */
  function renderRuns(){
    const r=D.runs||{};
    const tb=document.querySelector('#runs tbody');
    if(!tb)return;
    if(!r.runs||!r.runs.length){tb.innerHTML='<tr><td colspan="5" style="color:var(--mut)">無運行記錄</td></tr>';return;}
    tb.innerHTML=r.runs.map(x=>{
      const st='<span class="pill '+x.status+'">'+x.status+'</span>';
      const cc=x.conclusion?'<span class="pill '+x.conclusion+'">'+x.conclusion+'</span>':'—';
      return '<tr><td><a href="'+x.htmlUrl+'" target="_blank">'+x.id+'</a></td>'+
        '<td>'+(x.name||'').slice(0,42)+'</td><td>'+st+'</td><td>'+cc+'</td>'+
        '<td class="muted-cell">'+(x.updatedAt||'').slice(5,16).replace('T',' ')+'</td></tr>';
    }).join('');
  }

  /* ── Render meetings ── */
  function renderMeetings(){
    const data=D.meetings||{};
    const tb=document.querySelector('#recentMeetings tbody');
    if(!tb)return;
    if(!data.meetings||!data.meetings.length){tb.innerHTML='<tr><td colspan="5" style="color:var(--mut)">無賽事資料</td></tr>';return;}
    window._meetingList=data.meetings;
    const today=(D.status&&D.status.serverTime?D.status.serverTime:new Date().toISOString()).substring(0,10);
    tb.innerHTML=data.meetings.map((m,i)=>{
      const venue=m.venue==='ST'?'沙田':m.venue==='HV'?'跑馬地':(m.venue||'—');
      const isUpcoming=m.date>=today&&m.entry_count>0;
      const cnt=m.race_count>0?m.race_count+' 場':m.total_races?m.total_races+' 場':m.entry_count>0?'待賽':'0 場';
      return '<tr>'+
        '<td><strong>'+m.date+'</strong></td>'+
        '<td>'+venue+'</td>'+
        '<td class="muted-cell">'+(m.track_condition||'—')+'</td>'+
        '<td>'+cnt+'</td>'+
        '<td>'+(isUpcoming?'<button class="btn ghost sm" onclick="loadRacesForPredictByIndex('+i+')">預測此日</button>':'')+'</td>'+
        '</tr>';
    }).join('');
  }

  /* ── Load races for predict ── */
  function loadRacesForPredictByIndex(i){
    const m=window._meetingList&&window._meetingList[i];
    if(!m)return;
    loadRacesForPredict(m.id||'',m.date||'',m.race_count||m.total_races||0);
  }
  async function loadRacesForPredict(meetingId,date,raceCount){
    const sel=document.getElementById('predictRaceId');
    sel.innerHTML='<option value="">載入中…</option>';
    document.getElementById('predictStatus').textContent='';
    const wrap=document.getElementById('predictTableWrap');
    if(wrap)wrap.style.display='none';
    try{
      const res=await fetch('/api/meetings/'+encodeURIComponent(date));
      const data=await res.json();
      let races=data.races||[];
      if(!races.length&&data.upcomingRaces)races=data.upcomingRaces;
      if(!races.length){sel.innerHTML='<option value="">此日無已入 D1 的場次</option>';return;}
      sel.innerHTML='<option value="">選擇場次…</option>'+races.map(r=>{
        const raceId=r.id||('race_'+date+'_'+(data.venue||'ST')+'_'+r.raceNumber);
        return '<option value="'+raceId+'">第'+(r.raceNumber||r.race_number)+'場 · '+(r.title||r.raceName||'')+(r.distance?' · '+r.distance+'m':'')+(r.class?' · '+r.class:'')+'</option>';
      }).join('');
    }catch(e){sel.innerHTML='<option value="">載入失敗：'+e.message+'</option>';}
  }

  /* ── Run prediction ── */
  async function runPredict(){
    const raceId=document.getElementById('predictRaceId').value;
    if(!raceId){alert('請先選擇場次');return;}
    const statusEl=document.getElementById('predictStatus');
    const wrap=document.getElementById('predictTableWrap');
    const table=document.getElementById('predictTable');
    statusEl.textContent='運算中…';
    if(wrap)wrap.style.display='none';
    try{
      const res=await fetch('/api/analyze/top-picks?raceId='+encodeURIComponent(raceId));
      const data=await res.json();
      if(data.error){statusEl.textContent='錯誤: '+data.error;return;}
      const picks=data.allPicks||data.picks||[];
      if(!picks.length){statusEl.textContent='無預測資料';return;}
      const engineTag=data.eloEngine==='v12'?'v1.2':(data.eloEngine||'—');
      statusEl.textContent=(data.date||'')+' 第'+(data.raceNumber||'')+'場 · ELO '+engineTag+' · '+picks.length+' 匹';
      const tb=table.querySelector('tbody');
      tb.innerHTML=picks.map(p=>{
        const fmtElo=v=>v!=null?Math.round(v):'<span class="muted-cell">—</span>';
        const fmtPct=v=>v!=null?(v*100).toFixed(1)+'%':'—';
        const fmtScore=v=>v!=null?Math.round(v*10)/10:'—';
        const rankCls=p.rank===1?'rank-gold':p.rank===2?'rank-silver':p.rank===3?'rank-bronze':'';
        return '<tr>'+
          '<td class="'+rankCls+'"><strong>'+p.rank+'</strong></td>'+
          '<td>'+(p.horseNumber||'—')+'</td>'+
          '<td><strong>'+(p.nameCh||p.nameEn||'—')+'</strong>'+(p.horseFrozen?' <span class="pill queued">停賽</span>':'')+(p.horseRetired?' <span class="pill failure">退役</span>':'')+'</td>'+
          '<td class="muted-cell">'+(p.jockeyCh||'—')+' / '+(p.trainerCh||'—')+'</td>'+
          '<td>'+fmtElo(p.horseElo)+'</td>'+
          '<td>'+fmtElo(p.jockeyElo)+'</td>'+
          '<td>'+fmtElo(p.trainerElo)+'</td>'+
          '<td><strong>'+fmtElo(p.eloComposite)+'</strong></td>'+
          '<td style="color:'+(p.factorBonus>0?'var(--green)':p.factorBonus<0?'var(--red)':'var(--mut)')+'">'+(p.factorBonus!=null?(p.factorBonus>=0?'+':'')+Math.round(p.factorBonus*10)/10:'—')+'</td>'+
          '<td><strong>'+fmtScore(p.finalScore)+'</strong></td>'+
          '<td style="color:'+(p.rank<=2?'var(--green)':'var(--fg)')+'">'+fmtPct(p.pWin)+'</td>'+
          '<td class="muted-cell">'+fmtPct(p.pTop3)+'</td>'+
          '<td class="muted-cell">'+(p.winOdds!=null?p.winOdds:'—')+'</td>'+
          '</tr>';
      }).join('');
      if(wrap)wrap.style.display='block';
    }catch(e){statusEl.textContent='錯誤: '+e.message;}
  }

  /* ── Next race day ── */
  function renderNextRaceDay(){
    const nd=D.nextRaceDay;
    const labelEl=document.getElementById('nrdLabel');
    const racesEl=document.getElementById('nrdRaces');
    const horsesEl=document.getElementById('nrdHorses');
    if(!racesEl)return;
    if(!nd){
      if(labelEl)labelEl.textContent='';
      racesEl.innerHTML='<p style="color:var(--mut);font-size:13px;padding:8px 0">暫無即日賽事資料</p>';
      if(horsesEl)horsesEl.innerHTML='';
      return;
    }
    const venueLabel=nd.venue==='ST'?'沙田':nd.venue==='HV'?'跑馬地':(nd.venue||'');
    if(labelEl)labelEl.textContent=nd.date+' · '+venueLabel+(nd.trackCondition?' · '+nd.trackCondition:'')+(nd.isUpcoming?' · 待賽':' · 已賽');
    if(!nd.races||!nd.races.length){
      racesEl.innerHTML='<p style="color:var(--mut);font-size:13px;padding:8px 0">排位表資料暫未同步</p>';
    } else {
      racesEl.innerHTML=nd.races.map(function(r){
        const oddsEntries=r.odds?Object.entries(r.odds):[];
        const hasOdds=oddsEntries.length>0;
        let oddsHtml='';
        if(hasOdds){
          oddsHtml='<div class="nrd-odds">'+
            oddsEntries.map(function(e){
              const hn=e[0],o=Number(e[1]),low=o>0&&o<5;
              return '<span class="nrd-odds-item'+(low?' hot':'')+'"><strong>'+hn+'</strong> <span>'+o+'</span></span>';
            }).join('')+'</div>';
        } else {
          oddsHtml='<div style="font-size:11px;color:var(--mut);margin-top:4px">暫無即時賠率</div>';
        }
        return '<div class="nrd-race-card">'+
          '<div class="nrd-race-title">第'+r.raceNumber+'場'+(r.title?' · '+r.title:'')+(r.distance?' · '+r.distance+'m':'')+(r.class?' <span style="color:var(--mut);font-weight:400">'+r.class+'</span>':'')+(r.startTime?' <span style="font-size:11px;color:var(--mut);font-weight:400">'+r.startTime+'</span>':'')+'</div>'+
          oddsHtml+'</div>';
      }).join('');
    }
    if(horsesEl&&nd.horses&&nd.horses.length){
      horsesEl.innerHTML='<div style="font-size:11px;color:var(--mut);margin-top:4px;margin-bottom:16px">'+nd.horses.length+' 匹馬已登記排位</div>';
    }
  }

  /* ── Init ── */
  function safeRender(name,fn){try{fn();}catch(e){console.error('[admin] '+name+' 渲染失敗:',e.message,e);}}
  safeRender('renderAlerts',renderAlerts);
  safeRender('renderCoverage',renderCoverage);
  safeRender('renderStatus',renderStatus);
  safeRender('renderRuns',renderRuns);
  safeRender('renderMeetings',renderMeetings);
  safeRender('renderNextRaceDay',renderNextRaceDay);
  if(D.nextRaceDay&&D.nextRaceDay.isUpcoming&&D.nextRaceDay.races&&D.nextRaceDay.races.length){
    loadRacesForPredict('',D.nextRaceDay.date,D.nextRaceDay.races.length);
  }
  document.getElementById('refreshClock').textContent='載入：'+new Date().toLocaleTimeString('zh-HK')+' · 每60秒自動刷新';
  setTimeout(()=>window.location.reload(),60000);
  </script>
  </body></html>`;
  }
  