/**
 * Internal admin panel (Priority 3 · 2026-05-01 v3).
 * v3: 資料來源覆蓋面板 + 預測因子覆蓋面板。每個條目 2 欄狀態：
 *     歷史齊全 / 自動更新  → ✓ 綠 · ▲ 黃 · ✗ 紅
 */
import { Hono } from 'hono';
import {
  SESSION_COOKIE,
  buildAuthorizeUrl,
  buildSessionCookie,
  clearSessionCookie,
  exchangeCodeForToken,
  fetchGithubLogin,
  newSessionPayload,
  readCookie,
  signSession,
  verifySession,
} from '../lib/admin-auth';

interface AdminEnv {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  // OAuth + session
  SESSION_HMAC_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  ADMIN_GITHUB_USER?: string; // comma-separated allowlist of GitHub logins
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

function isAdminAllowlisted(env: AdminEnv, login: string): boolean {
  const list = (env.ADMIN_GITHUB_USER || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(login);
}

function loginRedirectHtml(loginPath: string, reason: string): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>天喜 · 需要登入</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC",sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#181818;border:1px solid #333;border-radius:12px;padding:36px 44px;max-width:420px;text-align:center}
h1{margin:0 0 14px;font-size:22px}p{color:#aaa;font-size:14px;margin:0 0 22px}
a.btn{display:inline-block;background:#fff;color:#000;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}</style>
</head><body><div class="box"><h1>天喜 · 內部控制台</h1><p>${reason}</p>
<a class="btn" href="${loginPath}">用 GitHub 登入</a></div></body></html>`;
}

// === Public OAuth routes (no auth required) ===
// /login → redirect to GitHub
adminRoutes.get('/login', (c) => {
  const env = c.env;
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.SESSION_HMAC_SECRET) {
    return c.json({ error: 'oauth disabled: missing GITHUB_OAUTH_CLIENT_ID or SESSION_HMAC_SECRET' }, 503);
  }
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/admin/callback`;
  const state = crypto.randomUUID();
  const authorize = buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, redirectUri, state });
  // Store state in a short-lived cookie so /callback can verify it.
  const stateCookie = `admin_oauth_state=${state}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return new Response(null, { status: 302, headers: { Location: authorize, 'Set-Cookie': stateCookie } });
});

// /callback → exchange code, verify allowlist, set session cookie
adminRoutes.get('/callback', async (c) => {
  const env = c.env;
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET || !env.SESSION_HMAC_SECRET) {
    return c.json({ error: 'oauth disabled' }, 503);
  }
  const code = c.req.query('code');
  const state = c.req.query('state');
  const stateCookie = readCookie(c.req.header('cookie'), 'admin_oauth_state');
  if (!code || !state || state !== stateCookie) {
    return c.json({ error: 'oauth state mismatch' }, 400);
  }
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/admin/callback`;
  try {
    const accessToken = await exchangeCodeForToken({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirectUri,
    });
    const login = await fetchGithubLogin(accessToken);
    if (!isAdminAllowlisted(env, login)) {
      return c.json({ error: `user ${login} not in admin allowlist` }, 403);
    }
    const session = await signSession(newSessionPayload(login), env.SESSION_HMAC_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/admin/',
        'Set-Cookie': [buildSessionCookie(session), 'admin_oauth_state=; Path=/admin; Max-Age=0'].join(', '),
      },
    });
  } catch (err: any) {
    return c.json({ error: 'oauth_failed', message: String(err?.message ?? err) }, 500);
  }
});

// /logout
adminRoutes.get('/logout', (c) => {
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login', 'Set-Cookie': clearSessionCookie() },
  });
});

// === Auth middleware for everything else ===
adminRoutes.use('*', async (c, next) => {
  // Skip OAuth public endpoints (login flow + logout).
  const path = new URL(c.req.url).pathname;
  if (path === '/admin/login' || path === '/admin/callback' || path === '/admin/logout') {
    await next();
    return;
  }
  // 1. Session cookie (preferred for browser users)
  const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE);
  if (cookie && c.env.SESSION_HMAC_SECRET) {
    const payload = await verifySession(cookie, c.env.SESSION_HMAC_SECRET);
    if (payload && isAdminAllowlisted(c.env, payload.user)) {
      c.set('adminUser' as any, payload.user);
      await next();
      return;
    }
  }
  // 2. Legacy bearer/query token (scripts, emergency access)
  const expected = c.env.ADMIN_TOKEN;
  if (expected) {
    const header = c.req.header('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const queryTok = c.req.query('token') || '';
    if (bearer === expected || queryTok === expected) {
      await next();
      return;
    }
  }
  // 3. Not authenticated — render login page for browser, JSON for API
  const accept = c.req.header('accept') || '';
  if (accept.includes('text/html')) {
    return c.html(loginRedirectHtml('/admin/login', '請用 GitHub 登入後再使用內部控制台。'), 401);
  }
  return c.json({ error: 'unauthorized' }, 401);
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
  if (!latest) return count >= minCount ? 'ok' : 'warn';
  const ageDays = (Date.now() - new Date(latest).getTime()) / 86400000;
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
    scalar<string>(db, `SELECT m.date FROM race_results rr JOIN races r ON rr.race_id = r.id JOIN race_meetings m ON r.meeting_id = m.id ORDER BY m.date DESC LIMIT 1`),
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
      sourceLabel: 'race_results.actual_weight', note: '使用中 · 與近 5 戰均磅比較 · 最大調整 ±8 ELO' },
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

  // ── /api/feature-audit ─ Coverage stats for the 5 candidate ML features
  adminRoutes.get('/api/feature-audit', async (c) => {
    const db = c.env.DB;
    const [
      rrTotal, rrRunPos, rrFinTime, rrClass,
      twTotal, twTimeSec, twTimeText,
      racesTotal, racesClass,
      formTotal, formClass, formRunPos, formFinTime, formPos, formDate,
      classChangeHorses, classChangeRecords,
      paceCoverage90d,
    ] = await Promise.all([
      scalar<number>(db, `SELECT COUNT(*) FROM race_results`),
      scalar<number>(db, `SELECT COUNT(*) FROM race_results WHERE running_position IS NOT NULL AND running_position != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM race_results WHERE finish_time IS NOT NULL`),
      scalar<number>(db, `SELECT COUNT(*) FROM race_results rr JOIN races r ON r.id=rr.race_id WHERE r.class IS NOT NULL AND r.class != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_trackwork`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_trackwork WHERE time_sec IS NOT NULL`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_trackwork WHERE time_text IS NOT NULL AND time_text != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM races`),
      scalar<number>(db, `SELECT COUNT(*) FROM races WHERE class IS NOT NULL AND class != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE race_class IS NOT NULL AND race_class != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE running_position IS NOT NULL AND running_position != ''`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE finish_time_sec IS NOT NULL`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE finishing_position_num IS NOT NULL AND finishing_position_num > 0 AND finishing_position_num < 99`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE race_date IS NOT NULL`),
      // horses that have ≥2 distinct race_class values in form_records → class-change feature feasible
      scalar<number>(db, `SELECT COUNT(*) FROM (SELECT horse_id FROM horse_form_records WHERE race_class IS NOT NULL AND race_class != '' GROUP BY horse_id HAVING COUNT(DISTINCT race_class) >= 2)`),
      scalar<number>(db, `SELECT COUNT(*) FROM horse_form_records WHERE race_class IS NOT NULL AND race_class != ''`),
      // pace coverage on recent 90 days of race_results
      scalar<number>(db, `SELECT COUNT(*) FROM race_results rr JOIN races r ON r.id=rr.race_id JOIN race_meetings m ON m.id=r.meeting_id WHERE m.date >= date('now','-90 day') AND rr.running_position IS NOT NULL AND rr.running_position != ''`),
    ]);

    const pct = (n: number, d: number) => d > 0 ? Math.round((n/d)*1000)/10 : 0;

    return c.json({
      generatedAt: new Date().toISOString(),
      feature_data_availability: {
        '1_pace_running_position': {
          source: 'race_results.running_position',
          total_rows: rrTotal,
          populated_rows: rrRunPos,
          coverage_pct: pct(rrRunPos, rrTotal),
          recent_90d_populated: paceCoverage90d,
          also_in_horse_form_records: formRunPos,
          notes: 'Format: "2-2-1-1" (sectional positions). HK fields max 14 → strong pace-clash signal.',
        },
        '2_trackwork_time': {
          source: 'horse_trackwork.time_sec',
          total_rows: twTotal,
          normalized_sec_rows: twTimeSec,
          any_time_text_rows: twTimeText,
          sec_coverage_pct: pct(twTimeSec, twTotal),
          text_coverage_pct: pct(twTimeText, twTotal),
          notes: 'time_sec is normalized from "0.36.8" style; rows w/ "slow"/"easy" text remain NULL.',
        },
        '3_top4_anti_cannibalization': {
          source: 'selection-time algorithm (not data dependent)',
          feasible: true,
          notes: 'Pure post-ranking diversification — needs (1) pace style + (5) trainer/jockey to penalize duplicates.',
        },
        '4_class_change': {
          source: 'races.class + horse_form_records.race_class',
          races_total: racesTotal,
          races_with_class: racesClass,
          races_class_pct: pct(racesClass, racesTotal),
          form_records_total: formTotal,
          form_records_with_class: formClass,
          form_class_pct: pct(formClass, formTotal),
          horses_with_class_change: classChangeHorses,
          notes: 'Needs current race class (races.class) + horse last race class (form_records.race_class) → delta.',
        },
        '5_ml_ensemble_lgbm': {
          source: 'LGB Stage 3 walkforward already implemented',
          feasible: true,
          notes: 'scripts/backtest/lgb_walkforward.py + dump-features.ts exist. Last run 2026-05-08: Top1 21.6% vs ELO 17.0% on 1299 races.',
        },
      },
      raw: {
        race_results: { total: rrTotal, with_running_position: rrRunPos, with_finish_time: rrFinTime, joined_with_class: rrClass },
        horse_trackwork: { total: twTotal, with_time_sec: twTimeSec, with_time_text: twTimeText },
        races: { total: racesTotal, with_class: racesClass },
        horse_form_records: {
          total: formTotal, with_class: formClass, with_running_position: formRunPos,
          with_finish_time_sec: formFinTime, with_finishing_position: formPos, with_date: formDate,
        },
      },
    });
  });

// ── /api/lgb-predictions ─ Stage 7: pre-computed LGB scores ───────────────
// POST: batch upsert from the nightly LGB predict-upcoming GH workflow.
// GET:  inspect coverage (count + latest model version) or a single race.
// analyze.ts (computeComposite) reads these scores and uses lgb_score as
// the primary ranking signal when present; absence → falls back to ELO+factor.
adminRoutes.post('/api/lgb-predictions', async (c) => {
  const body = await c.req.json<{
    predictions?: Array<{ raceId: string; horseId: string; lgbScore: number; pWin?: number }>;
    modelVersion?: string;
  }>().catch(() => null);
  if (!body || !Array.isArray(body.predictions) || body.predictions.length === 0) {
    return c.json({ error: 'predictions array required' }, 400);
  }
  const modelVersion = body.modelVersion || 'lgb-v1';
  const now = new Date().toISOString();
  // Defensive: create table if migration not yet applied
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS lgb_predictions (
       race_id TEXT NOT NULL, horse_id TEXT NOT NULL,
       lgb_score REAL NOT NULL, p_win REAL,
       model_version TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (race_id, horse_id))`
  ).run().catch(() => {});
  let upserted = 0;
  const races = new Set<string>();
  for (let i = 0; i < body.predictions.length; i += 100) {
    const batch = body.predictions.slice(i, i + 100);
    const stmts = batch.map((p) => {
      races.add(p.raceId);
      return c.env.DB.prepare(
        `INSERT INTO lgb_predictions (race_id, horse_id, lgb_score, p_win, model_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(race_id, horse_id) DO UPDATE SET
           lgb_score = excluded.lgb_score,
           p_win = excluded.p_win,
           model_version = excluded.model_version,
           created_at = excluded.created_at`
      ).bind(p.raceId, p.horseId, p.lgbScore, p.pWin ?? null, modelVersion, now);
    });
    await c.env.DB.batch(stmts);
    upserted += batch.length;
  }
  // Architect fix: invalidate race-day-report cache so today-picks re-reads new LGB.
    try {
      const dateSet = new Set<string>();
      for (const p of body.predictions) {
        const m = /^race_(\d{4}-\d{2}-\d{2})_/.exec(p.raceId);
        if (m) dateSet.add(m[1]);
      }
      for (const d of dateSet) {
        await c.env.DB.prepare(`DELETE FROM race_day_report_cache WHERE date = ?`).bind(d).run().catch(() => {});
      }
    } catch { /* best-effort */ }
    return c.json({ ok: true, upserted, races: races.size, modelVersion, at: now });
});

adminRoutes.get('/api/lgb-predictions', async (c) => {
  const raceId = c.req.query('raceId');
  if (raceId) {
    const { results } = await c.env.DB.prepare(
      `SELECT race_id, horse_id, lgb_score, p_win, model_version, created_at
         FROM lgb_predictions WHERE race_id = ? ORDER BY lgb_score DESC`
    ).bind(raceId).all<any>().catch(() => ({ results: [] as any[] }));
    return c.json({ raceId, predictions: results || [] });
  }
  const cnt = await c.env.DB.prepare(
    `SELECT COUNT(*) AS rows_n, COUNT(DISTINCT race_id) AS races_n,
            MAX(created_at) AS latest, MIN(created_at) AS earliest
       FROM lgb_predictions`
  ).first<any>().catch(() => null);
  const ver = await c.env.DB.prepare(
    `SELECT model_version, COUNT(*) AS n FROM lgb_predictions
      GROUP BY model_version ORDER BY n DESC LIMIT 5`
  ).all<any>().catch(() => ({ results: [] as any[] }));
  return c.json({ summary: cnt || {}, byModelVersion: ver.results || [] });
});

// ── /api/entries-upcoming-export ─ feed for GH Actions predict pipeline ──
adminRoutes.get('/api/entries-upcoming-export', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = c.req.query('from') || today;
  const to = c.req.query('to') || from;
  const { results } = await c.env.DB.prepare(`
    SELECT e.race_date, e.venue, e.race_number, e.race_class, e.distance, e.track, e.course,
           e.horse_id, e.horse_number, e.horse_code, e.draw, e.jockey_name, e.jockey_id,
           e.trainer_name, e.trainer_id, e.actual_weight, e.declared_weight, e.rating,
           e.priority_order, m.id AS meeting_id, m.track_condition AS going,
           r.id AS race_id
      FROM entries_upcoming e
      LEFT JOIN race_meetings m ON m.date = e.race_date AND m.venue = e.venue
      LEFT JOIN races r ON r.meeting_id = m.id AND r.race_number = e.race_number
     WHERE e.race_date BETWEEN ? AND ?
       AND (e.priority_order IS NULL OR e.priority_order = '' OR e.priority_order = '正選')
     ORDER BY e.race_date, e.venue, e.race_number, e.horse_number
  `).bind(from, to).all<any>().catch(() => ({ results: [] as any[] }));
  return c.json({ from, to, count: (results || []).length, entries: results || [] });
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
    'capy_fixture_weekly.yml', 'capy_integrity_audit.yml', 'capy_racecard.yml',
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
    WHERE m.venue IN ('ST','HV')
    GROUP BY m.id
    ORDER BY m.date DESC
    LIMIT ?
  `).bind(limit).all();
  return c.json({ meetings: results ?? [] });
});

// ── /api/jockey-elo-debug?name=布浩榮 — diagnose jockey ELO snapshot lookup ──
// Auth handled by mount-layer middleware (Bearer header or ?token=).

// Seed missing jockey/trainer ELO snapshots in production D1.
// Inserts a 1500-rating snapshot for every (jockey|trainer) without any snapshot,
// using the prefixed master-table id (jockeys.id / trainers.id) so the analyze
// reader's WHERE jockey_id = ? lookup matches. Idempotent (INSERT OR IGNORE).
adminRoutes.post('/api/seed-missing-jockey-elo', async (c) => {
  const seedDate = c.req.query('date') || new Date().toISOString().slice(0, 10);
  try {
    const jBefore = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM jockeys WHERE id NOT IN (SELECT DISTINCT jockey_id FROM jockey_elo_snapshots)`);
    const tBefore = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM trainers WHERE id NOT IN (SELECT DISTINCT trainer_id FROM trainer_elo_snapshots)`);
    const jRes = await c.env.DB.prepare(`
      INSERT OR IGNORE INTO jockey_elo_snapshots (id, jockey_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
      SELECT 'seed|' || id, id, NULL, ?, 1500, 0, datetime('now')
        FROM jockeys
       WHERE id NOT IN (SELECT DISTINCT jockey_id FROM jockey_elo_snapshots)
    `).bind(seedDate).run();
    const tRes = await c.env.DB.prepare(`
      INSERT OR IGNORE INTO trainer_elo_snapshots (id, trainer_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
      SELECT 'seed|' || id, id, NULL, ?, 1500, 0, datetime('now')
        FROM trainers
       WHERE id NOT IN (SELECT DISTINCT trainer_id FROM trainer_elo_snapshots)
    `).bind(seedDate).run();
    return c.json({
      ok: true,
      seedDate,
      jockeys: { missingBefore: jBefore, seeded: jRes.meta.changes ?? 0 },
      trainers: { missingBefore: tBefore, seeded: tRes.meta.changes ?? 0 },
    });
  } catch (err: any) {
    return c.json({ error: 'seed_failed', message: String(err?.message ?? err) }, 500);
  }
});

// Counterpart probe to verify coverage post-seed.
adminRoutes.get('/api/seed-missing-jockey-elo', async (c) => {
  const jMissing = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM jockeys WHERE id NOT IN (SELECT DISTINCT jockey_id FROM jockey_elo_snapshots)`);
  const tMissing = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM trainers WHERE id NOT IN (SELECT DISTINCT trainer_id FROM trainer_elo_snapshots)`);
  const jTotal = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM jockeys`);
  const tTotal = await scalar<number>(c.env.DB, `SELECT COUNT(*) AS n FROM trainers`);
  return c.json({
    jockeys: { total: jTotal, withoutSnapshot: jMissing },
    trainers: { total: tTotal, withoutSnapshot: tMissing },
  });
});
// ── /api/elo-backfill-from-results — bypass broken v12 pipeline ─────────
  // Computes ELO snapshots directly from D1's race_results table using the
  // proven v1 pairwise multi-runner engine (engine.ts in tianxi-database).
  // Useful when the workflow's bulk-local.db ingest is broken (e.g. capy
  // scrape didn't produce form CSVs since 5/9, so v12 had nothing to compute).
  //
  // POST  /admin/api/elo-backfill-from-results?since=YYYY-MM-DD&k=40
  // Reads each race since 'since', for each horse/jockey/trainer:
  //   1. Look up their latest known rating (or 1500 default)
  //   2. Apply pairwise multi-runner deltas (K/(N-1) * (actual - expected))
  //   3. INSERT OR REPLACE a new snapshot with as_of_date = race_date
  function expectedScore(rA: number, rB: number): number {
    return 1 / (1 + Math.pow(10, (rB - rA) / 400));
  }
  function computeRaceDeltas(
    runners: Array<{ id: string; finish: number; rating: number }>,
    k: number,
  ): Map<string, number> {
    const deltas = new Map<string, number>();
    const valid = runners.filter((r) => r.finish !== 999 && r.finish > 0);
    for (const r of runners) deltas.set(r.id, 0);
    if (valid.length < 2) return deltas;
    const scale = k / (valid.length - 1);
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = valid[i], b = valid[j];
        let sA: number, sB: number;
        if (a.finish < b.finish) { sA = 1; sB = 0; }
        else if (a.finish > b.finish) { sA = 0; sB = 1; }
        else { sA = 0.5; sB = 0.5; }
        const eA = expectedScore(a.rating, b.rating);
        deltas.set(a.id, (deltas.get(a.id) ?? 0) + scale * (sA - eA));
        deltas.set(b.id, (deltas.get(b.id) ?? 0) + scale * (sB - (1 - eA)));
      }
    }
    return deltas;
  }

  adminRoutes.post('/api/elo-backfill-from-results', async (c) => {
    const since = c.req.query('since') || new Date(Date.now() - 30*86400_000).toISOString().slice(0,10);
    const k = parseFloat(c.req.query('k') || '40');
    const db = c.env.DB;
    try {
      const { results: races } = await db.prepare(`
        SELECT r.id AS race_id, rm.date AS race_date, r.race_number
          FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rm.date >= ?
         ORDER BY rm.date ASC, rm.venue ASC, r.race_number ASC, r.id ASC
      `).bind(since).all<{ race_id: string; race_date: string; race_number: number }>();
      const raceList = races ?? [];
      if (raceList.length === 0) return c.json({ ok: true, since, racesProcessed: 0, writtenSnapshots: 0 });

      const raceIds = raceList.map((r) => r.race_id);
      // D1 has ~100 bound-param limit per statement; chunk the IN list.
      type EntryRow = { race_id: string; horse_id: string; jockey_id: string|null; trainer_id: string|null; finishing_position: number };
      const entryList: EntryRow[] = [];
      for (let i = 0; i < raceIds.length; i += 80) {
        const chunk = raceIds.slice(i, i + 80);
        const ph = chunk.map(() => '?').join(',');
        const { results } = await db.prepare(`
          SELECT race_id, horse_id, jockey_id, trainer_id, finishing_position
            FROM race_results
           WHERE race_id IN (${ph}) AND finishing_position IS NOT NULL
        `).bind(...chunk).all<EntryRow>();
        for (const r of (results ?? [])) entryList.push(r);
      }

      const horseIds = [...new Set(entryList.map((e) => e.horse_id))];
      const jockeyIds = [...new Set(entryList.map((e) => e.jockey_id).filter(Boolean))] as string[];
      const trainerIds = [...new Set(entryList.map((e) => e.trainer_id).filter(Boolean))] as string[];

      async function loadLatest(table: string, idCol: string, ids: string[]): Promise<Map<string, { rating: number; games: number }>> {
        const map = new Map<string, { rating: number; games: number }>();
        if (ids.length === 0) return map;
        for (let i = 0; i < ids.length; i += 40) {
          const chunk = ids.slice(i, i + 40);
          const ph = chunk.map(() => '?').join(',');
          const { results } = await db.prepare(`
            SELECT ${idCol} AS eid, rating, games_played
              FROM ${table}
             WHERE ${idCol} IN (${ph}) AND as_of_date < ?
               AND (${idCol}, as_of_date) IN (
                 SELECT ${idCol}, MAX(as_of_date)
                   FROM ${table}
                  WHERE ${idCol} IN (${ph}) AND as_of_date < ?
                  GROUP BY ${idCol}
               )
          `).bind(...chunk, since, ...chunk, since).all<{ eid: string; rating: number; games_played: number }>();
          for (const r of (results ?? [])) map.set(r.eid, { rating: r.rating, games: r.games_played });
        }
        return map;
      }

      const [horseSeed, jockeySeed, trainerSeed] = await Promise.all([
        loadLatest('horse_elo_snapshots', 'horse_id', horseIds),
        loadLatest('jockey_elo_snapshots', 'jockey_id', jockeyIds),
        loadLatest('trainer_elo_snapshots', 'trainer_id', trainerIds),
      ]);

      const horseR = new Map<string, number>(); const horseG = new Map<string, number>();
      const jockeyR = new Map<string, number>(); const jockeyG = new Map<string, number>();
      const trainerR = new Map<string, number>(); const trainerG = new Map<string, number>();
      function getR(map: Map<string, number>, seedMap: Map<string, {rating:number;games:number}>, gMap: Map<string, number>, id: string): number {
        if (map.has(id)) return map.get(id)!;
        const seed = seedMap.get(id);
        map.set(id, seed?.rating ?? 1500);
        gMap.set(id, seed?.games ?? 0);
        return map.get(id)!;
      }

      const entriesByRace = new Map<string, typeof entryList>();
      for (const e of entryList) {
        const arr = entriesByRace.get(e.race_id) ?? [];
        arr.push(e);
        entriesByRace.set(e.race_id, arr);
      }

      const horseStmts: any[] = [];
      const jockeyStmts: any[] = [];
      const trainerStmts: any[] = [];
      let processedRaces = 0;

      for (const race of raceList) {
        const rows = entriesByRace.get(race.race_id) ?? [];
        if (rows.length < 2) continue;

        const hRunners = rows.map((r) => ({
          id: r.horse_id, finish: r.finishing_position,
          rating: getR(horseR, horseSeed, horseG, r.horse_id),
        }));
        const hD = computeRaceDeltas(hRunners, k);
        for (const [id, d] of hD) {
          const newR = (horseR.get(id) ?? 1500) + d;
          horseR.set(id, newR);
          horseG.set(id, (horseG.get(id) ?? 0) + 1);
          horseStmts.push(db.prepare(`
            INSERT OR REPLACE INTO horse_elo_snapshots
              (id, horse_id, axis_key, surface, distance_bucket, as_of_race_id, as_of_date, rating, games_played, computed_at)
            VALUES (?, ?, 'overall', NULL, NULL, ?, ?, ?, ?, datetime('now'))
          `).bind(`${id}|overall|${race.race_id}`, id, race.race_id, race.race_date, newR, horseG.get(id)));
        }

        const jRows = rows.filter((r) => r.jockey_id);
        if (jRows.length >= 2) {
          const jR = jRows.map((r) => ({
            id: r.jockey_id!, finish: r.finishing_position,
            rating: getR(jockeyR, jockeySeed, jockeyG, r.jockey_id!),
          }));
          const jD = computeRaceDeltas(jR, k);
          for (const [id, d] of jD) {
            const newR = (jockeyR.get(id) ?? 1500) + d;
            jockeyR.set(id, newR);
            jockeyG.set(id, (jockeyG.get(id) ?? 0) + 1);
            jockeyStmts.push(db.prepare(`
              INSERT OR REPLACE INTO jockey_elo_snapshots
                (id, jockey_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `).bind(`${id}|${race.race_id}`, id, race.race_id, race.race_date, newR, jockeyG.get(id)));
          }
        }

        const tRows = rows.filter((r) => r.trainer_id);
        if (tRows.length >= 2) {
          const tR = tRows.map((r) => ({
            id: r.trainer_id!, finish: r.finishing_position,
            rating: getR(trainerR, trainerSeed, trainerG, r.trainer_id!),
          }));
          const tD = computeRaceDeltas(tR, k);
          for (const [id, d] of tD) {
            const newR = (trainerR.get(id) ?? 1500) + d;
            trainerR.set(id, newR);
            trainerG.set(id, (trainerG.get(id) ?? 0) + 1);
            trainerStmts.push(db.prepare(`
              INSERT OR REPLACE INTO trainer_elo_snapshots
                (id, trainer_id, as_of_race_id, as_of_date, rating, games_played, computed_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `).bind(`${id}|${race.race_id}`, id, race.race_id, race.race_date, newR, trainerG.get(id)));
          }
        }
        processedRaces++;
      }

      let written = 0;
      async function flush(stmts: any[]): Promise<void> {
        for (let i = 0; i < stmts.length; i += 80) {
          const slice = stmts.slice(i, i + 80);
          await db.batch(slice);
          written += slice.length;
        }
      }
      await flush(horseStmts);
      await flush(jockeyStmts);
      await flush(trainerStmts);

      return c.json({
        ok: true, since, k,
        racesScanned: raceList.length,
        racesProcessed: processedRaces,
        writtenSnapshots: written,
        uniqueHorses: horseR.size,
        uniqueJockeys: jockeyR.size,
        uniqueTrainers: trainerR.size,
      });
    } catch (err: any) {
      return c.json({ error: 'backfill_failed', message: String(err?.message ?? err) }, 500);
    }
  });



  // ── /api/sql-read — read-only SELECT for diagnostics ────────────────────
  // Body: { sql: 'SELECT ...' }  (single SELECT, no semicolons in middle)
  // Returns: { rows: [...], rowCount }
  // ── /api/migrate-prediction-log-lgb — one-shot schema + backfill ──────────
// Adds lgb_score (REAL), lgb_model_version (TEXT), score_source (TEXT) and
// backfills score_source + lgb_model_version on existing rows so the
// PREDICTION VS RESULT panel can separate LGB vs ELO history. lgb_score raw
// cannot be recovered for historical rows (only blended final_score was
// persisted) — stays NULL; new writes from now on populate it.
// Backfill mapping (variant × era):
//   baseline + generated_at >= 2026-05-19T00:00:00Z → score_source='lgb',
//                                                     lgb_model_version='lgb-lambdarank-20260519'
//   baseline + generated_at <  2026-05-19T00:00:00Z → score_source='elo'
//   variant != 'baseline' (qimen, *-bt) → score_source = variant verbatim
// Idempotent.
// ── /api/migrate-prediction-log-lgb — RETIRED 2026-05-19 ─────────────────
// One-shot schema + backfill. Executed against prod on 2026-05-19:
//   ALTER: lgb_score / lgb_model_version / score_source added.
//   Backfill: 108 baseline-post-lgb, 322 baseline-pre-lgb, 10310 non-baseline.
//   score_source NULL rows after: 0.
// 410 stub keeps URL routable for audit log searches.
adminRoutes.post('/api/migrate-prediction-log-lgb', async (c) => {
    return c.json({
      error: 'retired',
      message: 'one-shot endpoint already executed on 2026-05-19; see reports/decision-log.md',
    }, 410);
  });

  adminRoutes.post('/api/sql-read', async (c) => {
    try {
      const body = await c.req.json<{ sql?: string }>();
      const sql = (body?.sql ?? '').trim();
      if (!sql) return c.json({ error: 'sql body required' }, 400);
      if (!/^select\s/i.test(sql)) return c.json({ error: 'SELECT only' }, 400);
      // disallow multi-statement (allow only optional trailing semicolon)
      const stripped = sql.replace(/;+\s*$/, '');
      if (stripped.includes(';')) return c.json({ error: 'single statement only' }, 400);
      const { results } = await c.env.DB.prepare(stripped).all<any>();
      const rows = results ?? [];
      return c.json({ rows: rows.slice(0, 500), rowCount: rows.length, truncated: rows.length > 500 });
    } catch (err: any) {
      return c.json({ error: 'sql_read_failed', message: String(err?.message ?? err) }, 500);
    }
  });

  // ── /api/cleanup-duplicate-meetings — delete stale race_meetings rows ──
  // For each date with multiple race_meetings rows, keeps the one with the most
  // linked races (canonical) and deletes the rest. Cascades to remove orphan
  // races/race_results via the FK (assumed ON DELETE CASCADE). Idempotent.
  // ── /api/cleanup-2026-05-20-phantom — one-shot phantom row scrub ───────────
  // Deletes the dirty 2026-05-20_ST meeting row (HKJC sent a stray 1-race ST event
  // for a date where only HV was racing), its 1 orphan races row, and the
  // race_number=0 "reserve pool" in entries_upcoming for 2026-05-20 HV (125 horses
  // that aren't real race entries — inflated COUNT(DISTINCT race_number) from 9 to 10).
  // Idempotent: re-running just returns 0 deleted on each table.
  // ── /api/cleanup-2026-05-20-phantom — RETIRED 2026-05-19 ───────────────────
// One-shot phantom-row scrub. Executed successfully against prod on 2026-05-19
// (cleaned 14 race_results + 9 dividends + 1 races + 1 race_meetings + 125
// reserve-pool entries_upcoming for 2026-05-20_ST). Endpoint kept as a 410
// Gone stub to shrink admin attack surface; remove entirely in a later cleanup.
adminRoutes.post('/api/cleanup-2026-05-20-phantom', async (c) => {
    return c.json({
      error: 'retired',
      message: 'one-shot endpoint already executed on 2026-05-19; see reports/decision-log.md',
    }, 410);
  });

  adminRoutes.post('/api/cleanup-duplicate-meetings', async (c) => {
    const dryRun = c.req.query('dry') === '1';
    try {
      const { results: stale } = await c.env.DB.prepare(`
        WITH ranked AS (
          SELECT
            m.id, m.date, m.venue,
            COUNT(r.id) AS race_count,
            ROW_NUMBER() OVER (
              PARTITION BY m.date
              ORDER BY COUNT(r.id) DESC, m.id DESC
            ) AS rn
          FROM race_meetings m
          LEFT JOIN races r ON r.meeting_id = m.id
          GROUP BY m.id
        )
        SELECT id, date, venue, race_count FROM ranked WHERE rn > 1
      `).all<any>();

      const staleRows = stale ?? [];
      if (staleRows.length === 0) {
        return c.json({ ok: true, message: 'no duplicates found', stale: [] });
      }
      if (dryRun) {
        return c.json({ ok: true, dryRun: true, wouldDelete: staleRows });
      }

      // Cascade: collect race ids first, then delete from every child table,
      // then races, then race_meetings. Nullable FKs (horse_form_records.race_id,
      // *_elo_snapshots.as_of_race_id) are NULL'd instead of deleted.
      const ids = staleRows.map((r: any) => r.id);
      const inList = ids.map(() => '?').join(',');
      const { results: raceIdRows } = await c.env.DB.prepare(
        `SELECT id FROM races WHERE meeting_id IN (${inList})`
      ).bind(...ids).all<{ id: string }>();
      const raceIds = (raceIdRows ?? []).map((r) => r.id);

      const counts: Record<string, number> = {};
      if (raceIds.length > 0) {
        const rIn = raceIds.map(() => '?').join(',');
        // Hard-delete child rows (non-nullable race_id FK)
        const childTables = [
          'race_results', 'sectional_times', 'horse_sectional_times',
          'running_comments', 'dividends', 'odds_snapshots_legacy', 'race_videos',
        ];
        for (const t of childTables) {
          const r = await c.env.DB.prepare(
            `DELETE FROM ${t} WHERE race_id IN (${rIn})`
          ).bind(...raceIds).run();
          counts[t] = r.meta.changes ?? 0;
        }
        // Null-out nullable race_id FKs (preserve data)
        const nullable = [
          { tbl: 'horse_form_records', col: 'race_id' },
          { tbl: 'horse_elo_snapshots', col: 'as_of_race_id' },
          { tbl: 'jockey_elo_snapshots', col: 'as_of_race_id' },
          { tbl: 'trainer_elo_snapshots', col: 'as_of_race_id' },
        ];
        for (const { tbl, col } of nullable) {
          const r = await c.env.DB.prepare(
            `UPDATE ${tbl} SET ${col} = NULL WHERE ${col} IN (${rIn})`
          ).bind(...raceIds).run();
          counts[`${tbl}_nulled`] = r.meta.changes ?? 0;
        }
      }

      const deletedRaces = await c.env.DB.prepare(
        `DELETE FROM races WHERE meeting_id IN (${inList})`
      ).bind(...ids).run();
      const deletedMeetings = await c.env.DB.prepare(
        `DELETE FROM race_meetings WHERE id IN (${inList})`
      ).bind(...ids).run();

      return c.json({
        ok: true,
        deletedMeetings: deletedMeetings.meta.changes ?? 0,
        deletedRaces: deletedRaces.meta.changes ?? 0,
        cascadeCounts: counts,
        stale: staleRows,
      });
    } catch (err: any) {
      return c.json({ error: 'cleanup_failed', message: String(err?.message ?? err) }, 500);
    }
  });

  // ── /api/data-housekeeping — one-shot DB cleanup ──────────────────
  // 1) Drop stale hit-rate cache rows so cron recomputes
  // 2) Backfill race_meetings.total_races where NULL but races exist
  // 3) Cascade-delete non-race-venue meetings (S1 etc)
  adminRoutes.post('/api/data-housekeeping', async (c) => {
    const dryRun = c.req.query('dry') === '1';
    const dropCacheDates = (c.req.query('drop_cache_dates') || '2026-05-09')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const out: Record<string, any> = { dryRun, ranAt: new Date().toISOString() };
    try {
      if (dropCacheDates.length > 0) {
        const inL = dropCacheDates.map(() => '?').join(',');
        if (dryRun) {
          const { results } = await c.env.DB.prepare(`SELECT date, engine, races_evaluated, computed_at FROM meeting_hit_rate_cache WHERE date IN (${inL})`).bind(...dropCacheDates).all();
          out.staleCacheRowsWouldDelete = results ?? [];
        } else {
          const r = await c.env.DB.prepare(`DELETE FROM meeting_hit_rate_cache WHERE date IN (${inL})`).bind(...dropCacheDates).run();
          out.staleCacheRowsDeleted = r.meta.changes ?? 0;
        }
      }
      if (dryRun) {
        const { results } = await c.env.DB.prepare(`SELECT m.id, m.date, m.venue, m.total_races, (SELECT COUNT(*) FROM races WHERE meeting_id = m.id) AS actual_races FROM race_meetings m WHERE m.total_races IS NULL AND (SELECT COUNT(*) FROM races WHERE meeting_id = m.id) > 0`).all();
        out.totalRacesWouldBackfill = results ?? [];
      } else {
        const r = await c.env.DB.prepare(`UPDATE race_meetings SET total_races = (SELECT COUNT(*) FROM races WHERE meeting_id = race_meetings.id) WHERE total_races IS NULL AND (SELECT COUNT(*) FROM races WHERE meeting_id = race_meetings.id) > 0`).run();
        out.totalRacesBackfilled = r.meta.changes ?? 0;
      }
      const { results: ghosts } = await c.env.DB.prepare(`SELECT id, date, venue, track_condition FROM race_meetings WHERE venue NOT IN ('ST','HV')`).all<any>();
      const ghostRows = ghosts ?? [];
      if (dryRun) {
        out.nonRaceVenuesWouldDelete = ghostRows;
      } else if (ghostRows.length > 0) {
        const ids = ghostRows.map((r: any) => r.id);
        const inL = ids.map(() => '?').join(',');
        const { results: rIds } = await c.env.DB.prepare(`SELECT id FROM races WHERE meeting_id IN (${inL})`).bind(...ids).all<{ id: string }>();
        const raceIds = (rIds ?? []).map((r) => r.id);
        const counts: Record<string, number | string> = {};
        if (raceIds.length > 0) {
          const rIn = raceIds.map(() => '?').join(',');
          for (const t of ['race_results','sectional_times','horse_sectional_times','running_comments','dividends','race_videos']) {
            try { const r = await c.env.DB.prepare(`DELETE FROM ${t} WHERE race_id IN (${rIn})`).bind(...raceIds).run(); counts[t] = r.meta.changes ?? 0; }
            catch (e: any) { counts[t + '_err'] = String(e?.message ?? e); }
          }
          for (const nb of [{tbl:'horse_form_records',col:'race_id'},{tbl:'horse_elo_snapshots',col:'as_of_race_id'},{tbl:'jockey_elo_snapshots',col:'as_of_race_id'},{tbl:'trainer_elo_snapshots',col:'as_of_race_id'}]) {
            try { const r = await c.env.DB.prepare(`UPDATE ${nb.tbl} SET ${nb.col} = NULL WHERE ${nb.col} IN (${rIn})`).bind(...raceIds).run(); counts[`${nb.tbl}_nulled`] = r.meta.changes ?? 0; }
            catch (e: any) { counts[`${nb.tbl}_err`] = String(e?.message ?? e); }
          }
        }
        try { const eu = await c.env.DB.prepare(`DELETE FROM entries_upcoming WHERE (race_date || '|' || venue) IN (SELECT (date || '|' || venue) FROM race_meetings WHERE id IN (${inL}))`).bind(...ids).run(); counts.entries_upcoming = eu.meta.changes ?? 0; } catch (e: any) { counts.entries_err = String(e?.message ?? e); }
        const dR = await c.env.DB.prepare(`DELETE FROM races WHERE meeting_id IN (${inL})`).bind(...ids).run();
        const dM = await c.env.DB.prepare(`DELETE FROM race_meetings WHERE id IN (${inL})`).bind(...ids).run();
        out.nonRaceVenuesDeleted = ghostRows;
        out.deletedRaces = dR.meta.changes ?? 0;
        out.deletedMeetings = dM.meta.changes ?? 0;
        out.cascadeCounts = counts;
      } else {
        out.nonRaceVenuesDeleted = [];
      }
      return c.json({ ok: true, ...out });
    } catch (err: any) {
      return c.json({ error: 'housekeeping_failed', message: String(err?.message ?? err), partial: out }, 500);
    }
  });

  adminRoutes.get('/api/jockey-elo-debug', async (c) => {
  const name = c.req.query('name');
  if (!name) return c.json({ error: 'name query param required' }, 400);
  const db = c.env.DB;
  const [jockeyRows, snapshotByName, snapshotByPrefix, snapshotByLike, recentRR] = await Promise.all([
    db.prepare("SELECT id, name_ch, name_en FROM jockeys WHERE name_ch = ? OR name_en = ? OR id LIKE ? LIMIT 20").bind(name, name, '%' + name + '%').all().catch((e: any) => ({ results: [], error: e?.message })),
    db.prepare("SELECT id, jockey_id, axis_key, rating, as_of_date FROM jockey_elo_snapshots WHERE jockey_id = ? ORDER BY as_of_date DESC LIMIT 10").bind(name).all().catch((e: any) => ({ results: [], error: e?.message })),
    db.prepare("SELECT id, jockey_id, axis_key, rating, as_of_date FROM jockey_elo_snapshots WHERE jockey_id = ? ORDER BY as_of_date DESC LIMIT 10").bind('jockey_' + name).all().catch((e: any) => ({ results: [], error: e?.message })),
    db.prepare("SELECT DISTINCT jockey_id FROM jockey_elo_snapshots WHERE jockey_id LIKE ? LIMIT 20").bind('%' + name + '%').all().catch((e: any) => ({ results: [], error: e?.message })),
    db.prepare("SELECT rr.jockey_id, rr.jockey_name, COUNT(*) AS n, MAX(rm.date) AS last_date FROM race_results rr JOIN races r ON r.id = rr.race_id JOIN race_meetings rm ON rm.id = r.meeting_id WHERE rr.jockey_name = ? GROUP BY rr.jockey_id, rr.jockey_name ORDER BY last_date DESC LIMIT 20").bind(name).all().catch((e: any) => ({ results: [], error: e?.message })),
  ]);
  return c.json({
    name,
    jockeysTable: jockeyRows.results,
    snapshotsByExactName: snapshotByName.results,
    snapshotsByJockeyPrefix: snapshotByPrefix.results,
    snapshotsLikeName: snapshotByLike.results,
    recentRaceResults: recentRR.results,
    note: 'Compare jockey_id values across the 4 snapshot lookups to find the keying mismatch.',
  });
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
  // Ensure cache table exists so the LEFT JOIN below never throws on a fresh deploy
    await db.prepare(`CREATE TABLE IF NOT EXISTS meeting_hit_rate_cache (
      date TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'v12', venue TEXT,
      races_evaluated INTEGER, top1_hits INTEGER, top3_any_hits INTEGER, top3_sum_intersect INTEGER,
      top1_hit_rate REAL, top3_any_hit_rate REAL, top3_avg_intersect REAL,
      payload_json TEXT NOT NULL, computed_at TEXT NOT NULL,
      PRIMARY KEY (date, engine)
    )`).run().catch(() => {});
    const { results: meetRows } = await db.prepare(`
      SELECT m.id, m.date, m.venue, m.track_condition, m.total_races, COUNT(r.id) AS race_count,
             (SELECT COUNT(*) FROM entries_upcoming e WHERE e.race_date = m.date) AS entry_count,
             c.top1_hit_rate AS cached_top1_hit_rate,
             c.top3_any_hit_rate AS cached_top3_any_hit_rate,
             c.races_evaluated AS cached_races_evaluated,
             c.computed_at AS cached_at
      FROM race_meetings m
      LEFT JOIN races r ON r.meeting_id = m.id
      LEFT JOIN meeting_hit_rate_cache c ON c.date = m.date AND c.engine = 'v12'
      WHERE m.venue IN ('ST','HV')
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
        const [racesRes, euRes, oddsRes, formRes] = await Promise.all([
            db.prepare(`SELECT id, race_number, title, class, distance, start_time, track, course, going FROM races WHERE meeting_id = ? ORDER BY race_number`).bind(tm.id).all<any>().catch(() => ({ results: [] as any[] })),
            db.prepare(`SELECT e.race_number, e.horse_number, e.horse_code, e.horse_id, e.draw, e.declared_weight, e.actual_weight, e.jockey_name, e.trainer_name, e.gear, e.rating, e.priority_order, h.name_ch, h.name_en, h.age, h.sex, h.current_rating FROM entries_upcoming e LEFT JOIN horses h ON h.id = e.horse_id WHERE e.race_date = ? AND e.venue = ? ORDER BY e.race_number, e.horse_number`).bind(tm.date, tm.venue).all<any>().catch(() => ({ results: [] as any[] })),
            db.prepare(`SELECT o.race_number, o.combination, o.odds FROM odds_snapshots o INNER JOIN (SELECT race_number, MAX(snapshot_at) AS ls FROM odds_snapshots WHERE race_date = ? AND venue = ? AND pool_type = 'WIN' GROUP BY race_number) lt ON o.race_number = lt.race_number AND o.snapshot_at = lt.ls WHERE o.race_date = ? AND o.venue = ? AND o.pool_type = 'WIN' ORDER BY o.race_number, CAST(o.combination AS INTEGER)`).bind(tm.date, tm.venue, tm.date, tm.venue).all<any>().catch(() => ({ results: [] as any[] })),
            db.prepare(`SELECT rr.horse_id, rr.finishing_position FROM race_results rr INNER JOIN races ra ON ra.id = rr.race_id WHERE rr.horse_id IN (SELECT horse_id FROM entries_upcoming WHERE race_date = ? AND venue = ? AND horse_id IS NOT NULL) AND ra.date < ? ORDER BY rr.horse_id, ra.date DESC LIMIT 600`).bind(tm.date, tm.venue, tm.date).all<any>().catch(() => ({ results: [] as any[] })),
          ]);
          const oddsMap: Record<number, Record<string, number>> = {};
          for (const o of (oddsRes.results ?? [])) {
            const oo = o as any;
            if (!oddsMap[oo.race_number]) oddsMap[oo.race_number] = {};
            oddsMap[oo.race_number][oo.combination] = oo.odds;
          }
          const formMap: Record<string, number[]> = {};
          for (const f of (formRes.results ?? [])) {
            const ff = f as any;
            if (!formMap[ff.horse_id]) formMap[ff.horse_id] = [];
            if (formMap[ff.horse_id].length < 6) formMap[ff.horse_id].push(ff.finishing_position);
          }
          const entriesByRace: Record<number, any[]> = {};
          for (const e of (euRes.results ?? [])) {
            const en = e as any;
            if (!entriesByRace[en.race_number]) entriesByRace[en.race_number] = [];
            entriesByRace[en.race_number].push({ ...en, recentForm: formMap[en.horse_id] ?? [] });
          }
          nextRaceDay = {
            date: tm.date, venue: tm.venue, trackCondition: tm.track_condition,
            isUpcoming: tm.date >= todayStr,
            races: (racesRes.results ?? []).map((r: any) => ({
              id: r.id, raceNumber: r.race_number, title: r.title, class: r.class,
              distance: r.distance, startTime: r.start_time, track: r.track, course: r.course,
              going: r.going, odds: oddsMap[r.race_number] ?? {},
              entries: entriesByRace[r.race_number] ?? [],
            })),
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
<html lang="zh-Hant"><head><meta charset="utf-8"><title>天喜 · 內部控制台</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
  :root {
    --bg:#f5f5f4; --fg:#1c1c1c; --mut:#6b6760; --rule:#d8d4cb;
    --green:#18a355; --red:#c8102e; --blue:#1d5dca; --warn:#d9a40b;
  }
  * { box-sizing: border-box }
  body { font: 14px/1.5 "Inter", "PingFang TC", "Noto Sans TC", sans-serif; font-feature-settings:"cv02","cv03","cv04","tnum"; background:var(--bg); color:var(--fg); margin:0; padding:24px; max-width:1400px; margin-left:auto; margin-right:auto }
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
  .log { font-family: "JetBrains Mono", ui-monospace, monospace; font-size:12px; background:#1c1c1c; color:#eee; padding:10px; border-radius:4px; max-height:240px; overflow:auto; white-space:pre-wrap; margin-top:8px }
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
  .weight { font-family: "JetBrains Mono", ui-monospace, monospace; font-size:12px }
    /* ── 即日排位表 ── */
    .nrd-race { margin-bottom:10px; border:1px solid var(--rule); border-radius:6px; background:#fff; overflow:hidden }
    .nrd-race-hd { display:flex; align-items:center; gap:12px; padding:10px 14px; background:#fafaf8; cursor:pointer; user-select:none }
    .nrd-race-hd:hover { background:#f2ede6 }
    .nrd-rnum { width:34px; height:34px; border-radius:50%; background:var(--blue); color:#fff; font-size:15px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0 }
    .nrd-race-meta { flex:1 }
    .nrd-race-title { font-size:13px; font-weight:600; margin:0 0 1px }
    .nrd-race-sub { font-size:11px; color:var(--mut) }
    .nrd-race-time { margin-left:auto; font-size:12px; color:var(--mut); font-variant-numeric:tabular-nums; white-space:nowrap }
    .nrd-chevron { color:var(--mut); font-size:12px; margin-left:6px; transition:transform .2s }
    .nrd-race.open .nrd-chevron { transform:rotate(90deg) }
    .nrd-table-wrap { display:none }
    .nrd-race.open .nrd-table-wrap { display:block }
    .nrd-table { width:100%; border-collapse:collapse; font-size:12px }
    .nrd-table th { background:#f0ede8; font-size:11px; font-weight:500; letter-spacing:.04em; padding:5px 8px; text-align:left; border-bottom:1px solid var(--rule); white-space:nowrap }
    .nrd-table td { padding:6px 8px; border-bottom:1px solid var(--rule); vertical-align:middle }
    .nrd-table tr:last-child td { border-bottom:0 }
    .nrd-hname { font-size:13px; font-weight:700 }
    .nrd-jt { font-size:11px; color:var(--mut); margin-top:1px }
    .nrd-odds-fav  { display:inline-block; padding:2px 7px; border-radius:4px; font-weight:700; font-size:13px; background:#c8102e; color:#fff; font-variant-numeric:tabular-nums }
    .nrd-odds-low  { display:inline-block; padding:2px 7px; border-radius:4px; font-weight:700; font-size:13px; background:#18a355; color:#fff; font-variant-numeric:tabular-nums }
    .nrd-odds-norm { font-size:13px; font-weight:500; font-variant-numeric:tabular-nums }
    .nrd-odds-none { font-size:11px; color:var(--mut) }
    .nrd-form { font-size:11px; font-family:"JetBrains Mono",ui-monospace,monospace; white-space:nowrap; letter-spacing:.01em }
    .nrd-form .p1 { color:#18a355; font-weight:700 } .nrd-form .p2 { color:#1d5dca; font-weight:600 }
    .nrd-form .p3 { color:#d9a40b; font-weight:600 } .nrd-form .pdnf { color:#c8102e } .nrd-form .pmut { color:var(--mut) }
    .nrd-badge { display:inline-block; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:600; margin-right:3px }
    .nrd-badge.trump { background:#fff0c6; color:#7a5900 }
    .nrd-badge.pri { background:#e8f5ec; color:#186e2e }
    .nrd-badge.rsv { background:#e4e0d6; color:var(--mut) }
    /* ── 即日預測結果面板 ── */
      .tp-race { margin-bottom:10px; border:1px solid var(--rule); border-radius:6px; background:#fff; overflow:hidden }
      .tp-race-hd { display:flex; align-items:center; gap:12px; padding:10px 14px; background:#fafaf8; cursor:pointer; user-select:none }
      .tp-race-hd:hover { background:#f2ede6 }
      .tp-rnum { width:34px; height:34px; border-radius:50%; background:var(--blue); color:#fff; font-size:15px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0 }
      .tp-race-meta { flex:1 }
      .tp-race-title { font-size:13px; font-weight:600; margin:0 0 1px }
      .tp-race-sub { font-size:11px; color:var(--mut) }
      .tp-chevron { color:var(--mut); font-size:12px; margin-left:6px; transition:transform .2s }
      .tp-race.open .tp-chevron { transform:rotate(90deg) }
      .tp-table-wrap { display:none }
      .tp-race.open .tp-table-wrap { display:block }
      .tp-table { width:100%; border-collapse:collapse; font-size:12px }
      .tp-table th { background:#f0ede8; font-size:11px; font-weight:500; letter-spacing:.04em; padding:5px 8px; text-align:left; border-bottom:1px solid var(--rule); white-space:nowrap }
      .tp-table td { padding:6px 8px; border-bottom:1px solid var(--rule); vertical-align:top }
      .tp-table tr:last-child td { border-bottom:0 }
      .tp-rank-1 { color:var(--green); font-weight:700; font-size:15px }
      .tp-rank-2, .tp-rank-3 { color:var(--warn); font-weight:600 }
      .tp-hname { font-size:13px; font-weight:600 }
      .tp-sub { font-size:11px; color:var(--mut); margin-top:1px }
      .tp-elo { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12px }
      .tp-bonus-pos { color:var(--green); font-weight:600 }
      .tp-bonus-neg { color:var(--red); font-weight:600 }
      .tp-prob { font-weight:600; font-variant-numeric:tabular-nums }
      .tp-prob-hi { color:var(--green) }
      .tp-factor-detail { font-size:10px; line-height:1.8; margin-top:4px }
      button.tp-run { background:var(--blue); font-size:13px; padding:7px 16px }
      button.tp-run:hover { opacity:.9 }
      button.tp-run:disabled { opacity:.5; cursor:wait }
    </style></head>
<body>
  <h1>天喜 · 內部控制台 <span class="pulse" title="實時監控"></span></h1>
  <div style="margin:-8px 0 14px;font-size:12px;color:var(--mut);line-height:1.5">
    生產模型：<strong style="color:var(--fg)">天喜預測模型 TX-Oracle v3</strong>
    · <span style="font-family:monospace">LightGBM ensemble + ELO complementary stacking</span>
    · α=0.62 (LGB lean, P4 auto-tunable)
    · <a href="/api/analyze/ensemble-tune?days=30" target="_blank" style="color:var(--accent)">[P4 α grid search]</a>
    <a href="/api/analyze/ensemble-tune?days=30&apply=1" target="_blank" style="color:var(--accent);margin-left:6px">[grid search + apply]</a>
  </div>
  <div class="bar">伺服器端渲染 · 每 60 秒自動刷新<span class="refresh" id="refreshClock"></span></div>

  <div id="alertbar"></div>

    <style>
      .cmp-wrap{margin:14px 0 22px;padding:14px 16px;background:#fff;border:1px solid var(--rule);border-radius:6px}
      .cmp-wrap h2{margin:0 0 4px;font-size:16px;font-weight:600;letter-spacing:.3px}
      .cmp-sub{color:var(--mut);font-size:12px;margin-bottom:10px;line-height:1.55}
      .cmp-ctrl{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;font-size:13px}
      .cmp-ctrl select{padding:4px 8px;border:1px solid var(--rule);border-radius:4px;background:#fff;font:inherit;min-width:140px}
      .cmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .cmp-col{border:1px solid var(--rule);border-radius:5px;padding:0;display:flex;flex-direction:column;aspect-ratio:1/1;overflow:hidden}
      .cmp-col h3{margin:0;padding:8px 12px;font-size:13px;font-weight:600;background:#fafafa;border-bottom:1px solid var(--rule);text-transform:uppercase;letter-spacing:.5px;color:var(--mut)}
      .cmp-list{flex:1;display:grid;grid-template-rows:repeat(4,1fr)}
      .cmp-cell{padding:8px 12px;border-bottom:1px solid #eee;display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;font-size:13px;line-height:1.35;transition:background .15s}
      .cmp-cell:last-child{border-bottom:none}
      .cmp-cell.match{background:#fff7d6}
      .cmp-cell.match .cmp-name::before{content:"✓ ";color:#7A5A20;font-weight:700}
      .cmp-cell.empty{color:var(--mut);font-style:italic;justify-content:center;align-items:center;display:flex;grid-template-columns:none}
      .cmp-rank{font-weight:700;color:var(--mut);font-variant-numeric:tabular-nums;text-align:center}
      .cmp-name{font-weight:600}
      .cmp-name .num{color:var(--mut);font-weight:500;margin-right:4px}
      .cmp-odds,.cmp-draw{font-size:11px;color:var(--mut);background:#f3f1ec;padding:2px 6px;border-radius:3px;white-space:nowrap}
      .cmp-cell.match .cmp-draw{background:#f7e9b5;color:#7A5A20}
      .cmp-empty-box{padding:18px;text-align:center;color:var(--mut);font-size:12px}
      .cmp-status{font-size:11px;color:var(--mut);margin-left:auto}
      @media (max-width:520px){
        .cmp-grid{grid-template-columns:1fr;gap:8px}
        .cmp-col{aspect-ratio:auto;min-height:280px}
      }
    </style>

    <section class="cmp-wrap" id="cmpSection">
      <h2>預測與賽果 <span style="font-size:11px;font-weight:400;color:var(--mut);margin-left:6px">PREDICTION VS RESULT</span></h2>
      <div class="cmp-sub">揀賽事日期同場次，比對天喜預測首 4 名同實際賽果首 4 名。左右兩邊同時出現嘅馬匹會用<span style="background:#fff7d6;padding:1px 4px;border-radius:2px">金黃底</span>標記。</div>
      <div class="cmp-ctrl">
        <label>日期 <select id="cmpDate" aria-label="賽事日期"></select></label>
        <label>場次 <select id="cmpRace" aria-label="場次" disabled><option>—</option></select></label>
        <span id="cmpStatus" class="cmp-status" aria-live="polite"></span>
      </div>
      <div class="cmp-grid">
        <div class="cmp-col"><h3>天喜預測 首 4 名</h3><div class="cmp-list" id="cmpLeft" aria-live="polite"><div class="cmp-empty-box">揀日期同場次以載入</div></div></div>
        <div class="cmp-col"><h3>實際賽果 首 4 名</h3><div class="cmp-list" id="cmpRight" aria-live="polite"><div class="cmp-empty-box">揀日期同場次以載入</div></div></div>
      </div>
    </section>

  <h2>資料來源覆蓋（14 個核心表）</h2>
  <table id="coverDS"><thead><tr>
    <th>資料源</th><th>歷史齊全</th><th>自動更新</th><th>最新運行</th><th>最後成功</th><th>數量 / 最新</th><th>負責工作流</th>
  </tr></thead><tbody></tbody></table>

  <h2>預測因子覆蓋（資料源監控 · 天喜預測模型 TX-Oracle v3：LightGBM ensemble + ELO complementary stacking）<span id="factorCovPct" style="font-size:11px;font-weight:600;color:var(--green);margin-left:6px"></span></h2>
  <table id="coverFac"><thead><tr>
    <th>因子</th><th>目前使用</th><th>權重</th><th>歷史齊全</th><th>自動更新</th><th>資料來源</th><th>備註</th>
  </tr></thead><tbody></tbody></table>

  <h2>D1 即時計數</h2>
  <div id="status" class="grid"></div>


  <h2>最近工作流運行</h2>
  <table id="runs"><thead><tr><th>ID</th><th>名稱</th><th>狀態</th><th>結果</th><th>更新時間</th></tr></thead><tbody></tbody></table>

  <h2>最近賽事</h2>
  <table id="recentMeetings"><thead><tr>
  <th>日期</th><th>場地</th><th>場地狀況</th><th>場數</th>
  </tr></thead><tbody></tbody></table>
  <div id="meetingPanel" style="margin-top:14px"></div>

    <h2>即日 天喜預測模型 TX-Oracle v3 預測 <span style="font-size:11px;font-weight:500;color:var(--mut);margin-left:8px">LightGBM ensemble + ELO complementary stacking · α=0.62 (P4 tunable)</span></h2>
    <div class="actions-row">
      <button class="tp-run" id="btnTodayPredict" onclick="loadTodayPredictions(false)">▶ 載入即日 TX-Oracle v3 預測（ensemble: LGB lambdarank ⊕ ELO + 檔位/負磅）</button>
      <span id="todayPredictStatus" style="font-size:12px;color:var(--mut)"></span>
    </div>
    <div id="todayPredictResults"></div>


  <script>
  // ── 伺服器端預載資料 (SSR) — 無需任何 fetch 呼叫 ──
  const D = ${JSON.stringify(preloaded).replace(/</g, "\\u003c")};
  const TOKEN = ${JSON.stringify(token).replace(/</g, "\\u003c")};
  console.log('[admin] SSR D loaded:', { has_coverage: !!(D && D.coverage), has_meetings: !!(D && D.meetings), has_status: !!(D && D.status), keys: D ? Object.keys(D) : null });
  function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString() }
  function fmtDate(s) { return s || '—' }

  function chip(level, okLabel, warnLabel, badLabel) {
    const label = level === 'ok' ? (okLabel || '齊全') : level === 'warn' ? (warnLabel || '部分') : (badLabel || '未達標');
    return '<span class="chip ' + level + '">' + label + '</span>';
  }

  function fmtTs(s) {
    if (!s) return '<span class="muted-cell">—</span>';
    // Format YYYY-MM-DDTHH:MM:SSZ → MM-DD HH:MM
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) return s;
    return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }
  function fmtSuccess(s, ageH) {
    if (!s) return '<span class="chip bad">從未成功</span>';
    const label = fmtTs(s);
    // ageH thresholds: ≤26h ok, ≤72h warn, >72h bad
    const level = ageH == null ? 'bad' : ageH <= 26 ? 'ok' : ageH <= 72 ? 'warn' : 'bad';
    const suffix = ageH == null ? '' : ' (' + (ageH < 24 ? ageH.toFixed(1) + 'h' : Math.floor(ageH/24) + 'd') + ')';
    return '<span class="chip ' + level + '">' + label + suffix + '</span>';
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
      '<td>' + chip(d.history, '歷史齊全', null, '未達標') + '</td>' +
      '<td>' + chip(d.auto, '自動更新', null, '停止更新') + '</td>' +
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
      '<td>' + chip(f.history, '歷史齊全', null, '未達標') + '</td>' +
      '<td>' + chip(f.auto, '自動更新', null, '停止更新') + '</td>' +
      '<td class="muted-cell">' + f.sourceLabel + '</td>' +
      '<td class="muted-cell">' + f.note + '</td>' +
      '</tr>'
    ).join('');
    const usedCount=(D.coverage?.factors||[]).filter(f=>f.used).length;
    const totalCount=(D.coverage?.factors||[]).length;
    const pct=totalCount>0?Math.round(usedCount/totalCount*100):0;
    const pctEl=document.getElementById('factorCovPct');
    if(pctEl)pctEl.textContent='TX-Oracle v3 因子層 · '+usedCount+'/'+totalCount+' 監控項就緒 · '+pct+'% 資料齊備';
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
      bar.innerHTML = '<div class="alert ok">系統正常 · 無告警</div>'; return;
    }
    bar.innerHTML = a.alerts.map(x =>
      '<div class="alert ' + x.level + '">' + x.msg + '</div>'
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
        tb.innerHTML = '<tr><td colspan="4" class="warn">無賽事資料</td></tr>'; return;
      }
      window._meetingList = data.meetings;
      tb.innerHTML = data.meetings.map((m, i) => {
        const venue = m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : (m.venue || '—');
        const raceCountTxt = m.race_count > 0 ? m.race_count + ' 場' : m.total_races ? m.total_races + ' 場' : m.entry_count > 0 ? '<span class="muted-cell">排位 ' + m.entry_count + ' 匹</span>' : '<span class="muted-cell">—</span>';
        return '<tr style="cursor:pointer" onclick="cmpJumpTo(&quot;' + m.date + '&quot;)" title="點擊跳到頂部「預測與賽果」比對">' +
          '<td><strong>' + (m.date || '—') + '</strong></td>' +
          '<td>' + venue + '</td>' +
          '<td class="muted-cell">' + (m.track_condition || '—') + '</td>' +
          '<td>' + raceCountTxt + '</td>' +
          '</tr>';
      }).join('');
      // No client-side auto-load chain; SSR already has the numbers.
    }

    function renderMeetingRow(i) {
      if (!window._meetingList) return;
      renderMeetings();
    }

    // Legacy shim: older inline onclick may still call this — route through runHitReport
    function autoLoadHitForMeeting(i) {
      runHitReport(i);
    }

      async function loadHitRateRollup() {
    const days = (document.getElementById('rollupDays') || {}).value || '30';
    const stat = document.getElementById('rollupStatus');
    const body = document.getElementById('rollupContent');
    if (!stat || !body) return;
    stat.textContent = '運算中…（首次需評估每場）';
    body.innerHTML = '';
    try {
      const r = await fetch('/api/analyze/hit-rate-rollup?days=' + days);
      const d = await r.json();
      if (d.error) { stat.innerHTML = '<span class="bad">錯誤：' + d.error + '</span>'; return; }
      stat.innerHTML = '<span class="muted-cell">' + d.from + ' → ' + d.to + ' · ' + d.meetingsEvaluated + ' 場日 · ' + d.racesEvaluated + ' 場已評</span>';
      const t1cls = d.top1HitRate != null && d.top1HitRate >= 25 ? 'ok' : d.top1HitRate != null && d.top1HitRate < 12 ? 'bad' : '';
      const t3cls = d.top3AnyHitRate != null && d.top3AnyHitRate >= 70 ? 'ok' : d.top3AnyHitRate != null && d.top3AnyHitRate < 50 ? 'bad' : '';
      const fmtPct = (v) => v != null ? v.toFixed(1) + '%' : '—';
      // Compact metric tile builder — value + denom + colour-coded thresholds
        const tile = (label, val, n, denom, hi, lo) => {
          const cls = val == null ? '' : val >= hi ? 'ok' : val < lo ? 'bad' : '';
          return '<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px">' + label + '</div>'
            + '<div class="' + cls + '" style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + fmtPct(val) + '</div>'
            + '<div style="font-size:10px;color:var(--mut)">' + (n != null ? n : '—') + ' / ' + (denom != null ? denom : '—') + '</div></div>';
        };
        body.innerHTML =
          '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">'
          + tile('Top 1 (獨贏)', d.top1HitRate, d.top1Hits, d.racesEvaluated, 25, 12)
          + tile('Top 3 任一', d.top3AnyHitRate, d.top3AnyHits, d.racesEvaluated, 70, 50)
          + tile('Quinella (Q)', d.quinellaHitRate, d.quinellaHits, d.racesEvaluated, 8, 3)
          + tile('Quinella Place', d.qpHitRate, d.qpHits, d.racesEvaluated, 25, 10)
          + tile('Trio 三重彩', d.trioHitRate, d.trioHits, d.racesEvaluated, 5, 1)
          + tile('Tierce 3T', d.tierceHitRate, d.tierceHits, d.racesEvaluated, 1.5, 0.3)
          + tile('First 4', d.first4HitRate, d.first4Hits, d.first4Eligible, 1, 0.2)
          + '<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px">首/次/三/四選平均命中</div>'
            + '<div style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + (d.top4AvgIntersect != null ? d.top4AvgIntersect.toFixed(2) : '—') + '<span style="font-size:12px;color:var(--mut)"> / 4</span></div>'
            + '<div style="font-size:10px;color:var(--mut)">' + (d.top4Eligible || 0) + ' 場可評</div></div>'
          + '<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px">Top 3 平均交集</div>'
            + '<div style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + (d.top3AvgIntersect != null ? d.top3AvgIntersect.toFixed(2) : '—') + '<span style="font-size:12px;color:var(--mut)"> / 3</span></div></div>'
        + (d.perMeeting && d.perMeeting.length ? '<div style="margin-left:auto;flex:1;min-width:280px"><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">逐場日 (Top1% / Top3任一%)</div>'
          + '<div style="display:flex;gap:3px;flex-wrap:wrap;font-variant-numeric:tabular-nums">'
          + d.perMeeting.slice().reverse().map(m => {
              const cls = m.top1HitRate >= 25 ? 'ok' : m.top1HitRate < 12 ? 'bad' : '';
              return '<span title="' + m.date + ' ' + m.venue + ' · Top1 ' + (m.top1HitRate != null ? m.top1HitRate.toFixed(1) : '—') + '% · Top3 ' + (m.top3AnyHitRate != null ? m.top3AnyHitRate.toFixed(1) : '—') + '%" style="font-size:10px;padding:1px 5px;border:1px solid var(--rule);border-radius:3px" class="' + cls + '">' + m.date.substring(5) + ' ' + (m.top1HitRate != null ? m.top1HitRate.toFixed(0) : '—') + '/' + (m.top3AnyHitRate != null ? m.top3AnyHitRate.toFixed(0) : '—') + '</span>';
            }).join('')
          + '</div></div>' : '')
        + '</div>';
    } catch (e) {
      stat.innerHTML = '<span class="bad">錯誤：' + e.message + '</span>';
    }
  }


  // ── 賽事日預測 / 比對報告 ──────────────────────────────────────────
  async function runPicksForDate(i) {
    const m = window._meetingList && window._meetingList[i];
    if (!m) return;
    const panel = document.getElementById('meetingPanel');
    panel.innerHTML = '<div style="padding:10px;color:var(--mut);font-size:12px">運算 ' + m.date + ' 預測中（每場約 5-10 秒）…</div>';
    try {
      const res = await fetch('/api/analyze/picks-by-date?date=' + encodeURIComponent(m.date));
      const data = await res.json();
      if (data.error) { panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + data.error + '</div>'; return; }
      renderMeetingPicksPanel(panel, data, m);
    } catch (e) {
      panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + e.message + '</div>';
    }
  }

  async function runHitReport(i) {
    const m = window._meetingList && window._meetingList[i];
    if (!m) return;
    const panel = document.getElementById('meetingPanel');
    panel.innerHTML = '<div style="padding:10px;color:var(--mut);font-size:12px">運算 ' + m.date + ' 比對報告中…</div>';
    window._meetingHits[m.date] = 'loading';
    renderMeetings();
    try {
      // 用 server cache（已包含 top-4 + reason fields；過期 cache 已由 housekeeping 清咗）
        const res = await fetch('/api/analyze/hit-rate?date=' + encodeURIComponent(m.date));
      const data = await res.json();
      if (data.error) {
        panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + data.error + '</div>';
        return;
      }
      window._meetingHits[m.date] = data;
      renderMeetings();
      renderHitReportPanel(panel, data, m);
    } catch (e) {
      panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + e.message + '</div>';

    }
  }

  function renderMeetingPicksPanel(el, data, m) {
    var venueLabel = m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : m.venue;
    var srcTag = data.source === 'historical' ? '<span class="pill queued">歷史重算</span>' : '<span class="pill success">即時排位</span>';
    var engineTag = data.eloEngine === 'v12' ? 'v1.2' : (data.eloEngine || '—');
    var fmtElo = function(v) { return v != null ? '<span class="tp-elo">' + Math.round(v) + '</span>' : '<span class="muted-cell">—</span>'; };
    var fmtPct = function(v) { return v != null ? (v*100).toFixed(1) + '%' : '—'; };
    var fmtBonus = function(v) { if (v == null) return '—'; var c = v > 0 ? 'tp-bonus-pos' : v < 0 ? 'tp-bonus-neg' : ''; return '<span class="' + c + '">' + (v >= 0 ? '+' : '') + v + '</span>'; };
    var raceBlocks = (data.races || []).map(function(race, ri) {
      var picks = race.picks || [];
      var topHorse = picks[0] ? '<strong>' + (picks[0].nameCh || picks[0].nameEn || '—') + '</strong> ' + fmtPct(picks[0].pWin) : '無資料';
      var rows = picks.map(function(p) {
        var rc = p.rank === 1 ? 'tp-rank-1' : p.rank <= 3 ? 'tp-rank-2' : '';
        return '<tr>'
          + '<td class="' + rc + '">' + p.rank + '</td>'
          + '<td>' + (p.horseNumber || '—') + '</td>'
          + '<td><div class="tp-hname">' + (p.nameCh || p.nameEn || '—') + '</div><div class="tp-sub">' + (p.jockeyCh || '—') + ' / ' + (p.trainerCh || '—') + '</div></td>'
          + '<td style="text-align:center">' + (p.draw != null ? p.draw : '—') + '</td>'
          + '<td>' + fmtElo(p.horseElo) + '</td>'
          + '<td>' + fmtElo(p.jockeyElo) + '</td>'
          + '<td>' + fmtElo(p.trainerElo) + '</td>'
          + '<td><strong>' + fmtElo(p.eloComposite) + '</strong></td>'
          + '<td>' + fmtBonus(p.factorBonus) + '</td>'
          + '<td><strong>' + fmtElo(p.finalScore) + '</strong></td>'
          + '<td class="' + (p.rank === 1 ? 'ok' : '') + '">' + fmtPct(p.pWin) + '</td>'
          + '<td>' + fmtPct(p.pTop3) + '</td>'
          + '</tr>';
      }).join('');
      var isOpen = ri < 2 ? ' open' : '';
      return '<div class="tp-race' + isOpen + '" id="mp-r' + race.raceNumber + '">'
        + '<div class="tp-race-hd" onclick="document.getElementById(&quot;mp-r' + race.raceNumber + '&quot;).classList.toggle(&quot;open&quot;)">'
          + '<div class="tp-rnum">' + race.raceNumber + '</div>'
          + '<div class="tp-race-meta"><div class="tp-race-title">' + (race.title || '第' + race.raceNumber + '場') + '</div>'
            + '<div class="tp-race-sub">' + (race.distance ? race.distance + 'm' : '') + (race.going ? ' · ' + race.going : '') + (race.class ? ' · ' + race.class : '') + ' · ' + picks.length + ' 匹</div></div>'
          + '<div style="margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap">' + topHorse + '</div>'
          + '<span class="tp-chevron">▶</span></div>'
        + '<div class="tp-table-wrap"><table class="tp-table"><thead><tr>'
          + '<th>排名</th><th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>檔</th>'
          + '<th>馬ELO</th><th>騎ELO</th><th>練ELO</th><th>綜合ELO</th>'
          + '<th>因子</th><th>最終分</th><th>勝率</th><th>前三</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }).join('');
    el.innerHTML = '<div style="padding:10px 12px;background:#fff;border:1px solid var(--rule);border-radius:4px;margin-bottom:8px;font-size:12px">'
      + '<strong>' + data.date + '</strong> · ' + venueLabel + ' · ' + (data.races || []).length + ' 場 · ' + srcTag + ' · ELO引擎 ' + engineTag
      + (data.eloReady ? ' · <span class="ok">✓ ELO就緒</span>' : ' · <span class="warn">⚠ ELO資料不全</span>')
      + ' <button class="ghost" style="float:right;font-size:11px;padding:2px 8px" onclick="document.getElementById(&quot;meetingPanel&quot;).innerHTML=&quot;&quot;">關閉</button>'
      + '</div>' + raceBlocks;
  }

  function renderHitReportPanel(el, data, m) {
    var venueLabel = m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : m.venue;
    var s = data.summary || {};
    var t1cls = s.top1HitRate != null && s.top1HitRate >= 30 ? 'ok' : s.top1HitRate != null && s.top1HitRate < 15 ? 'bad' : '';
    var t3cls = s.top3AnyHitRate != null && s.top3AnyHitRate >= 60 ? 'ok' : s.top3AnyHitRate != null && s.top3AnyHitRate < 40 ? 'bad' : '';
    var fmtElo = function(v) { return v != null ? '<span class="tp-elo">' + Math.round(v) + '</span>' : '<span class="muted-cell">—</span>'; };
    var rankLabel = ['首選', '次選', '三選', '四選'];
    var hitStyle = 'color:#d12;font-weight:700';
    var missStyle = 'color:#666';
    var esc = function(x) { return (x == null ? '' : String(x)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var rows = (data.races || []).map(function(race) {
      // Prefer new top-4 fields (post-Stage7); fall back to top-3 for cached old payloads.
      var pred4 = race.predictedTop4;
      var act4  = race.actualTop4;
      var hasTop4 = Array.isArray(pred4) && Array.isArray(act4) && (pred4.length || act4.length);
      var pred = hasTop4 ? pred4 : (race.predictedTop3 || []);
      var act  = hasTop4 ? act4  : (race.actualTop3   || []);
      var nLab = hasTop4 ? 4 : 3;
      var predIds = pred.map(function(p) { return p.horseId; });
      var actIds  = act.map(function(a)  { return a.horseId; });
      var predHtml = pred.map(function(p, i) {
        var hit = (typeof p.hit === 'boolean') ? p.hit : actIds.indexOf(p.horseId) >= 0;
        var label = rankLabel[i] || ('第' + (i + 1) + '選');
        var horseLine = '<div style="' + (hit ? hitStyle : missStyle) + ';font-size:12px;line-height:1.45">'
          + (hit ? '🎯 ' : '') + '<strong>' + label + '</strong> · '
          + esc(p.nameCh || '—') + ' (#' + esc(p.horseNumber || '?') + ') '
          + fmtElo(p.eloComposite)
          + '</div>';
        var reasonLine = p.reason
          ? '<div style="font-size:10.5px;color:var(--mut);padding-left:18px;line-height:1.4">▸ ' + esc(p.reason) + '</div>'
          : '';
        return horseLine + reasonLine;
      }).join('') || '<div class="muted-cell">—</div>';
      var actHtml = act.map(function(a) {
        var hit = (typeof a.hit === 'boolean') ? a.hit : predIds.indexOf(a.horseId) >= 0;
        return '<div style="' + (hit ? hitStyle : missStyle) + ';font-size:12px;line-height:1.45">'
          + (hit ? '🎯 ' : '') + esc(a.position) + '. ' + esc(a.nameCh || '—') + ' (#' + esc(a.horseNumber || '?') + ')'
          + (a.winOdds != null ? ' <span class="muted-cell">$' + esc(a.winOdds) + '</span>' : '')
          + '</div>';
      }).join('') || '<div class="muted-cell">未開賽</div>';
      var t1 = race.top1Hit ? '<span class="pill success">命中</span>' : '<span class="pill failure">未中</span>';
      var ti = (race.top4IntersectCount != null) ? race.top4IntersectCount : race.top3IntersectCount;
      var tiDen = (race.top4IntersectCount != null) ? 4 : 3;
      var trcls = ti != null && ti >= (tiDen - 1) ? 'ok' : ti === 0 ? 'bad' : '';
      var dot = function(hit) { return hit ? '<span class="ok" style="font-weight:700">●</span>' : '<span class="muted-cell">○</span>'; };
      return '<tr>'
        + '<td><strong>' + race.raceNumber + '</strong></td>'
        + '<td class="muted-cell" style="font-size:11px">' + (race.distance ? race.distance + 'm' : '') + (race.going ? ' / ' + race.going : '') + '</td>'
        + '<td style="vertical-align:top;min-width:280px">' + predHtml + '</td>'
        + '<td style="vertical-align:top;min-width:200px">' + actHtml + '</td>'
        + '<td>' + t1 + '</td>'
        + '<td style="text-align:center">' + dot(race.quinellaHit) + '</td>'
        + '<td style="text-align:center">' + dot(race.trioHit) + '</td>'
        + '<td style="text-align:center">' + dot(race.tierceHit) + '</td>'
        + '<td style="text-align:center">' + dot(race.first4Hit) + '</td>'
        + '<td class="' + trcls + '" style="text-align:center;font-weight:600">' + (ti != null ? ti : '—') + '/' + tiDen + '</td>'
        + '</tr>';
    }).join('');
    var fmtP = function(v) { return v != null ? v.toFixed(1) + '%' : '—'; };
    var pool = function(label, n, d) { return '<span style="margin-right:14px;white-space:nowrap"><span style="color:var(--mut);font-size:11px">' + label + '</span> <strong style="font-variant-numeric:tabular-nums">' + fmtP(d) + '</strong> <span class="muted-cell" style="font-size:11px">(' + (n != null ? n : 0) + ')</span></span>'; };
    var hasTop4Sum = s.top4AvgIntersect != null;
    var avgLabel = hasTop4Sum
      ? '首/次/三/四選平均命中 <strong>' + s.top4AvgIntersect.toFixed(2) + '/4</strong> (' + (s.top4Eligible || 0) + ' 場可評)'
      : '平均交集 <strong>' + (s.top3AvgIntersect != null ? s.top3AvgIntersect.toFixed(2) : '—') + '/3</strong>';
    el.innerHTML = '<div style="padding:10px 12px;background:#fff;border:1px solid var(--rule);border-radius:4px;margin-bottom:8px;font-size:12px">'
      + '<strong>' + data.date + ' 比對報告</strong> · ' + venueLabel + ' · ' + s.racesEvaluated + ' 場已評 · '
      + 'Top1 <span class="' + t1cls + '" style="font-weight:600">' + (s.top1HitRate != null ? s.top1HitRate.toFixed(1) + '%' : '—') + '</span> (' + s.top1Hits + '/' + s.racesEvaluated + ') · '
      + 'Top3任一 <span class="' + t3cls + '" style="font-weight:600">' + (s.top3AnyHitRate != null ? s.top3AnyHitRate.toFixed(1) + '%' : '—') + '</span> (' + s.top3AnyHits + '/' + s.racesEvaluated + ') · '
      + avgLabel
      + ' <button class="ghost" style="float:right;font-size:11px;padding:2px 8px" onclick="document.getElementById(&quot;meetingPanel&quot;).innerHTML=&quot;&quot;">關閉</button>'
      + '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--rule);font-size:12px;line-height:1.7">'
        + '<span style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-right:10px">HK 彩池命中率</span>'
        + pool('Quinella', s.quinellaHits, s.quinellaHitRate)
        + pool('Q.Place', s.qpHits, s.qpHitRate)
        + pool('Trio', s.trioHits, s.trioHitRate)
        + pool('Tierce 3T', s.tierceHits, s.tierceHitRate)
        + pool('First 4', s.first4Hits, s.first4HitRate)
      + '</div>'
      + '<div style="margin-top:6px;font-size:10.5px;color:var(--mut)">命中嘅馬以 <span style="' + hitStyle + '">紅色 🎯</span> 標示。每隻預測下方 ▸ 為揀佢嘅原因（綜合 ELO + 主要因子調整 + 估算勝率）。</div>'
      + '</div>'
      + '<table style="margin-top:6px;border-collapse:collapse" cellspacing="0"><thead><tr>'
      + '<th>場</th><th>賽事</th><th>預測 首/次/三/四選 (含原因)</th><th>實際前 4</th><th>Top1</th><th title="Quinella: 預測 top2 = 實際 top2 任順序">Q</th><th title="Trio: 預測 top3 = 實際 top3 任順序">Trio</th><th title="Tierce: 預測 top3 = 實際 top3 完全順序">3T</th><th title="First 4: 預測 top4 = 實際 top4 任順序">F4</th><th title="預測 top-4 之中跑入實際 top-4 嘅隻數">命中數</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

    function renderNextRaceDay() {
        var nd = D.nextRaceDay;
        var labelEl = document.getElementById('nrdLabel');
        var racesEl = document.getElementById('nrdRaces');
        var horsesEl = document.getElementById('nrdHorses');
        if (!racesEl) return;
        if (!nd) {
          if (labelEl) labelEl.textContent = '';
          racesEl.innerHTML = '<p style="color:var(--mut);font-size:13px">暫無即日賽事資料</p>';
          if (horsesEl) horsesEl.innerHTML = '';
          return;
        }
        var venueLabel = nd.venue === 'ST' ? '沙田' : nd.venue === 'HV' ? '跑馬地' : (nd.venue || '');
        if (labelEl) labelEl.textContent = nd.date + ' · ' + venueLabel + (nd.trackCondition ? ' · ' + nd.trackCondition : '') + (nd.isUpcoming ? ' · 待賽' : ' · 已賽');

        function fmtForm(arr) {
          if (!arr || !arr.length) return '<span class="pmut">—</span>';
          return arr.map(function(p) {
            if (p === 999 || p === null) return '<span class="pdnf">U</span>';
            if (p === 1) return '<span class="p1">1</span>';
            if (p === 2) return '<span class="p2">2</span>';
            if (p === 3) return '<span class="p3">3</span>';
            return '<span class="pmut">' + p + '</span>';
          }).join('<span class="pmut">/</span>');
        }

        function fmtOdds(oddsObj, horseNum) {
          var o = oddsObj ? oddsObj[String(horseNum)] : null;
          if (o == null) return '<span class="nrd-odds-none">—</span>';
          var n = Number(o);
          var vals = Object.keys(oddsObj).map(function(k) { return Number(oddsObj[k]); }).filter(function(x) { return x > 0; });
          var minOdds = vals.length ? Math.min.apply(null, vals) : 999;
          if (n === minOdds && n < 10) return '<span class="nrd-odds-fav">' + n + '</span>';
          if (n < 5) return '<span class="nrd-odds-low">' + n + '</span>';
          return '<span class="nrd-odds-norm">' + n + '</span>';
        }

        function buildRaceHtml(r) {
          var parts = [];
          if (r.class) parts.push(r.class);
          if (r.distance) parts.push(r.distance + '米');
          var trackStr = [r.track, r.course].filter(Boolean).join(', ');
          if (trackStr) parts.push(trackStr);
          var subStr = parts.join(' · ');
          var timeStr = r.startTime ? r.startTime.substring(0, 5) : '';
          var entries = r.entries || [];
          var entriesHtml;
          if (entries.length > 0) {
            var rows = entries.map(function(e) {
              var name = e.name_ch || e.horse_code || '—';
              var jt = [e.jockey_name, e.trainer_name].filter(Boolean).join(' / ');
              var draw = e.draw != null ? e.draw : '—';
              var wt = e.declared_weight || e.actual_weight;
              var wtStr = wt != null ? wt : '—';
              var rating = e.rating || e.current_rating;
              var ratingStr = rating != null ? rating : '—';
              var badge = (e.priority_order && e.priority_order !== '正選') ? '<span class="nrd-badge rsv">' + e.priority_order + '</span>' : '';
              return '<tr>' +
                '<td style="color:var(--mut);font-size:11px">' + (e.horse_number || '—') + '</td>' +
                '<td><div class="nrd-hname">' + badge + name + '</div><div class="nrd-jt">' + (jt || '—') + '</div></td>' +
                '<td style="text-align:center">' + fmtOdds(r.odds, e.horse_number) + '</td>' +
                '<td style="text-align:center;color:var(--mut)">' + draw + '</td>' +
                '<td style="text-align:right;color:var(--mut)">' + wtStr + '</td>' +
                '<td style="text-align:right;color:var(--mut)">' + ratingStr + '</td>' +
                '<td><div class="nrd-form">' + fmtForm(e.recentForm) + '</div></td>' +
                '</tr>';
            }).join('');
            entriesHtml = '<div class="nrd-table-wrap"><table class="nrd-table"><thead><tr>' +
              '<th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>獨贏</th><th>檔</th>' +
              '<th style="text-align:right">負磅</th><th style="text-align:right">評分</th><th>近績</th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table></div>';
          } else {
            entriesHtml = '<div class="nrd-table-wrap" style="padding:8px 14px;font-size:12px;color:var(--mut)">排位表資料暫未同步</div>';
          }
          return '<div class="nrd-race" id="nrd-r' + r.raceNumber + '">' +
            '<div class="nrd-race-hd" onclick="toggleNrdRace(' + r.raceNumber + ')">' +
            '<div class="nrd-rnum">' + r.raceNumber + '</div>' +
            '<div class="nrd-race-meta">' +
            '<div class="nrd-race-title">' + (r.title || '第' + r.raceNumber + '場') + '</div>' +
            '<div class="nrd-race-sub">' + subStr + '</div>' +
            '</div>' +
            '<span class="nrd-race-time">' + timeStr + '</span>' +
            '<span class="nrd-chevron">&#x203A;</span>' +
            '</div>' + entriesHtml + '</div>';
        }

        if (!nd.races || !nd.races.length) {
          racesEl.innerHTML = '<p style="color:var(--mut);font-size:13px">排位表資料暫未同步</p>';
        } else {
          racesEl.innerHTML = nd.races.map(buildRaceHtml).join('');
          var firstRace = nd.races[0];
          if (firstRace) {
            var firstEl = document.getElementById('nrd-r' + firstRace.raceNumber);
            if (firstEl) firstEl.classList.add('open');
          }
        }
        if (horsesEl) horsesEl.innerHTML = '';
      }

      function toggleNrdRace(raceNum) {
        var el = document.getElementById('nrd-r' + raceNum);
        if (el) el.classList.toggle('open');
      }
      function toggleTpRace(raceNum) {
        var el = document.getElementById('tp-r' + raceNum);
        if (el) el.classList.toggle('open');
      }

  
    // ── 即日 R5 預測 ──
    // Cache-first: cron pre-builds the report at HKT 06:00/11:00/12:00/18:00 so this is instant.
      async function loadTodayPredictions(force) {
        var btn = document.getElementById('btnTodayPredict');
        var btnForce = document.getElementById('btnTodayPredictForce');
        var statusEl = document.getElementById('todayPredictStatus');
        var resultsEl = document.getElementById('todayPredictResults');
        if (btn) btn.disabled = true;
        if (btnForce) btnForce.disabled = true;
        statusEl.textContent = force ? '強制重新運算中（每場約 5-10 秒）…' : '載入快取報告中…';
        try {
          var url = force ? '/api/analyze/today-picks?fresh=1' : '/api/analyze/today-picks';
          var res = await fetch(url);
          var data = await res.json();
          if (data.error) { statusEl.textContent = '錯誤：' + data.error; return; }
          var engTag = data.eloEngine === 'v12' ? 'v1.2' : (data.eloEngine || '—');
          var stampSrc = data.fromCache ? '快取' : '即時運算';
          var stampTime = data.cachedGeneratedAt || data.generatedAt;
          var stampLocal = stampTime ? new Date(stampTime).toLocaleString('zh-HK', { hour12: false }) : '—';
          var seedNote = '';
          if (data.seedSummary && data.seedSummary.totalSeeded > 0) {
            seedNote = ' · 新馬 seed ' + data.seedSummary.totalSeeded + ' 隻 (評分 ' + (data.seedSummary.ratingSeeded||0) + ' / 班次 ' + (data.seedSummary.classSeeded||0) + ')';
          }
          statusEl.innerHTML = (data.date||'') + ' ' + (data.venue||'') + ' · '
            + (data.races ? data.races.length : 0) + ' 場 · ELO引擎 ' + engTag
            + (data.eloReady ? ' · <span style="color:#0a0">✓ ELO就緒</span>' : ' · <span style="color:#f80">⚠ ELO未就緒</span>')
            + seedNote
            + ' · 報告產生 <strong>' + stampLocal + '</strong> (' + stampSrc + (data.computeMs ? ' ' + data.computeMs + 'ms' : '') + ')';
          renderTodayPredictions(data);
        } catch (e) {
          statusEl.textContent = '錯誤：' + e.message;
        } finally {
          if (btn) btn.disabled = false;
          if (btnForce) btnForce.disabled = false;
        }
      }
      async function runTodayPredictions() { return loadTodayPredictions(false); }
      async function forceRebuildTodayPredictions() {
        if (!confirm('將忽略快取重新運算（約 30-60 秒），確定？')) return;
        return loadTodayPredictions(true);
      }

    // === Phase A · prediction accuracy panel ===
    async function loadRoi() {
      var statusEl = document.getElementById('roiStatus');
      var resultsEl = document.getElementById('roiResults');
      var days = document.getElementById('roiDays').value || '60';
      statusEl.textContent = '載入中…'; resultsEl.innerHTML = '';
      try {
        var res = await fetch('/api/analyze/roi?days=' + days);
        var data = await res.json();
        if (data.error) { statusEl.textContent = '錯誤：' + data.error; return; }
        if (!data.summary || !data.summary.length) { statusEl.textContent = '尚無已結算資料'; return; }
        statusEl.textContent = '視窗起 ' + data.sinceDate + ' · 平注 $1 · 派彩含本金';
        var rows = data.summary.filter(function(r){ return r.variant !== 'qimen-bt'; });
        var stratLabel = { ALWAYS:'永遠膽 #1', SP_3_8:'SP ∈ [3,8]', EV_GT_5:'pWin×odds > 1.05' };
        var html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#222;color:#fff">'
          + '<th style="padding:6px;text-align:left">變體</th>'
          + '<th style="padding:6px;text-align:left">策略</th>'
          + '<th style="padding:6px;text-align:right">下注</th>'
          + '<th style="padding:6px;text-align:right">命中</th>'
          + '<th style="padding:6px;text-align:right">命中率</th>'
          + '<th style="padding:6px;text-align:right">平均派彩</th>'
          + '<th style="padding:6px;text-align:right">總 P&amp;L</th>'
          + '<th style="padding:6px;text-align:right">ROI%</th>'
          + '</tr></thead><tbody>';
        for (var i=0;i<rows.length;i++) {
          var r = rows[i];
          var roi = r.roiPct;
          var roiColor = roi == null ? 'var(--mut)' : (roi >= 0 ? '#0a0' : '#c00');
          var roiTxt = roi == null ? '—' : (roi >= 0 ? '+' : '') + roi + '%';
          var pnl = r.totalPnL;
          var pnlTxt = pnl == null ? '—' : (pnl >= 0 ? '+$' : '$') + pnl;
          var label = (r.variant === 'r5-bt' ? 'R5' : 'baseline');
          html += '<tr style="border-bottom:1px solid #ddd">'
            + '<td style="padding:6px"><strong>' + label + '</strong></td>'
            + '<td style="padding:6px;color:var(--mut);font-size:12px">' + (stratLabel[r.strategy] || r.strategy) + '</td>'
            + '<td style="padding:6px;text-align:right">' + (r.bets || 0) + '</td>'
            + '<td style="padding:6px;text-align:right">' + (r.hits || 0) + '</td>'
            + '<td style="padding:6px;text-align:right">' + (r.hitRatePct != null ? r.hitRatePct + "%" : "—") + '</td>'
            + '<td style="padding:6px;text-align:right">' + (r.avgWinPayout != null ? "$" + r.avgWinPayout : "—") + '</td>'
            + '<td style="padding:6px;text-align:right">' + pnlTxt + '</td>'
            + '<td style="padding:6px;text-align:right;color:' + roiColor + ';font-weight:600">' + roiTxt + '</td>'
            + '</tr>';
        }
        html += '</tbody></table>';
        html += '<div style="margin-top:6px;font-size:11px;color:var(--mut)">平均派彩含本金（HK SP 慣例）。ROI = (總派彩 − 總投注) / 總投注。EV_GT_5 喺現時未校正 pWin 上 0% 命中（已證偽）。樣本太細時 CI 闊。</div>';
        resultsEl.innerHTML = html;
      } catch (e) { statusEl.textContent = '錯誤：' + e.message; }
    }

    async function loadValuePicks() {
      var statusEl = document.getElementById('vpStatus');
      var resultsEl = document.getElementById('vpResults');
      var minV = document.getElementById('vpMin').value || '3';
      var maxV = document.getElementById('vpMax').value || '8';
      statusEl.textContent = '計算中…'; resultsEl.innerHTML = '';
      try {
        var res = await fetch('/api/analyze/value-picks?min=' + minV + '&max=' + maxV);
        var data = await res.json();
        if (data.error) { statusEl.textContent = '錯誤：' + data.error; return; }
        statusEl.textContent = data.date + ' · ' + data.venue + ' · 排位 ' + data.races + ' 場 · ' + data.oddsAvailable + '/' + data.oddsTotal + ' 場有 odds';
        if (!data.valuePicks || !data.valuePicks.length) {
          resultsEl.innerHTML = '<div style="padding:12px;color:var(--mut);font-size:13px">無 R5 排第 1 馬落入 odds [' + minV + ', ' + maxV + ']。可能：(a) 仍未到開閘前 odds 穩定區間；(b) 今日 R5 全部偏熱門 / 冷門。</div>';
          return;
        }
        var html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#222;color:#fff">'
          + '<th style="padding:6px;text-align:left">場次</th>'
          + '<th style="padding:6px;text-align:left">馬號·名</th>'
          + '<th style="padding:6px;text-align:left">騎師 / 練馬師</th>'
          + '<th style="padding:6px;text-align:right">檔</th>'
          + '<th style="padding:6px;text-align:right">R5 pWin</th>'
          + '<th style="padding:6px;text-align:right">市場 odds</th>'
          + '<th style="padding:6px;text-align:right">市場 implied p</th>'
          + '<th style="padding:6px;text-align:right">R5 edge</th>'
          + '</tr></thead><tbody>';
        for (var i=0;i<data.valuePicks.length;i++) {
          var p = data.valuePicks[i];
          var edge = p.modelEdgePp;
          var edgeColor = edge == null ? 'var(--mut)' : (edge >= 0 ? '#0a0' : '#c00');
          var edgeTxt = edge == null ? "—" : (edge >= 0 ? "+" : "") + edge + "pp";
          html += '<tr style="border-bottom:1px solid #ddd">'
            + '<td style="padding:6px"><strong>R' + p.raceNumber + '</strong><div style="font-size:11px;color:var(--mut)">' + (p.distance || "—") + 'm · ' + (p.going || "—") + '</div></td>'
            + '<td style="padding:6px"><strong>' + p.horseNumber + ' ' + (p.nameCh || p.nameEn || "—") + '</strong></td>'
            + '<td style="padding:6px;font-size:12px">' + (p.jockey || "—") + '<div style="color:var(--mut)">' + (p.trainer || "—") + '</div></td>'
            + '<td style="padding:6px;text-align:right">' + (p.draw || "—") + '</td>'
            + '<td style="padding:6px;text-align:right">' + (p.pWin != null ? (p.pWin*100).toFixed(1) + "%" : "—") + '</td>'
            + '<td style="padding:6px;text-align:right;font-weight:600">$' + p.liveOdds + '</td>'
            + '<td style="padding:6px;text-align:right">' + (p.impliedP != null ? (p.impliedP*100).toFixed(1) + "%" : "—") + '</td>'
            + '<td style="padding:6px;text-align:right;color:' + edgeColor + ';font-weight:600">' + edgeTxt + '</td>'
            + '</tr>';
        }
        html += '</tbody></table>';
        html += '<div style="margin-top:6px;font-size:11px;color:var(--mut)">⚠ 警告：呢個過濾喺 baseline 60 日 +19% ROI，但 R5 變體只 −0.15%（draw+weight bonus 推 picks 偏熱門）。即係呢個 panel 用 R5 揀 + SP_3_8 過濾，係過渡方案，未真正 +EV。R5 edge = pWin − 市場 implied p。</div>';
        resultsEl.innerHTML = html;
      } catch (e) { statusEl.textContent = '錯誤：' + e.message; }
    }

    async function loadPredictionAccuracy() {
      var statusEl = document.getElementById('accStatus');
      var resultsEl = document.getElementById('predAccuracyResults');
      var days = document.getElementById('accDays').value || '30';
      statusEl.textContent = '載入中…';
      try {
        var res = await fetch('/api/analyze/prediction-accuracy?days=' + days);
        var data = await res.json();
        if (data.error) { statusEl.textContent = '錯誤：' + data.error; return; }
        if (!data.summary || !data.summary.length) {
          statusEl.textContent = '尚未有完成回填的歷史預測資料';
          resultsEl.innerHTML = '<div style="padding:12px;color:var(--mut);font-size:13px">系統會在每日 03:00 HKT 自動回填過去 7 日的賽果到 prediction_log。第一份回測報告需累積 ≥1 個賽日資料。</div>';
          return;
        }
        statusEl.textContent = '視窗起 ' + data.sinceDate + ' · R5 生產引擎';
        var html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#222;color:#fff">'
          + '<th style="padding:6px;text-align:left">變體</th>'
          + '<th style="padding:6px;text-align:right">場次</th>'
          + '<th style="padding:6px;text-align:right">總馬數</th>'
          + '<th style="padding:6px;text-align:right">膽馬命中率</th>'
          + '<th style="padding:6px;text-align:right">前三貼士命中率</th>'
          + '<th style="padding:6px;text-align:right">Brier 分數</th>'
          + '<th style="padding:6px;text-align:right">Log Loss</th>'
          + '</tr></thead><tbody>';
        var prodRows = data.summary.filter(function(s){ return s.variant === 'r5-bt'; });
          if (!prodRows.length) {
            resultsEl.innerHTML = '<div style="padding:12px;color:var(--mut);font-size:13px">R5 (生產引擎) 尚未有 walk-forward 樣本，需待 /run-backtest 跑入 prediction_log。</div>';
            return;
          }
          for (var i=0;i<prodRows.length;i++) {
            var s = prodRows[i];
            html += '<tr style="border-bottom:1px solid #ddd">'
              + '<td style="padding:6px"><strong>R5 (ELO + 檔位 + 負磅)</strong></td>'
              + '<td style="padding:6px;text-align:right">' + s.races + '</td>'
              + '<td style="padding:6px;text-align:right">' + s.horses + '</td>'
              + '<td style="padding:6px;text-align:right">' + (s.bankerHitRate != null ? s.bankerHitRate + '%' : '—') + '</td>'
              + '<td style="padding:6px;text-align:right">' + (s.top3PickHitRate != null ? s.top3PickHitRate + '%' : '—') + '</td>'
              + '<td style="padding:6px;text-align:right">' + (s.brierWin != null ? s.brierWin : '—') + '</td>'
              + '<td style="padding:6px;text-align:right">' + (s.logLossWin != null ? s.logLossWin : '—') + '</td>'
              + '</tr>';
          }
        html += '</tbody></table>';
        html += '<div style="margin-top:6px;font-size:11px;color:var(--mut)">膽馬 = 預測排名第 1 的馬實際入第 1。前三貼士命中率 = 預測排名 1-3 的馬實際入前 3 的比率。Brier 越低越好（隨機 = 0.25），Log Loss 越低越好。</div>';
        resultsEl.innerHTML = html;
      } catch (e) {
        statusEl.textContent = '錯誤：' + e.message;
      }
    }
    async function triggerBackfill() {
      var statusEl = document.getElementById('accStatus');
      statusEl.textContent = '回填中…';
      try {
        var res = await fetch('/admin/api/backfill-prediction-results', { method: 'POST' });
        var data = await res.json();
        statusEl.textContent = '回填完成：處理 ' + (data.daysProcessed||0) + ' 日，更新 ' + (data.totalUpdated||0) + ' 筆';
      } catch (e) {
        statusEl.textContent = '錯誤：' + e.message;
      }
    }

    function renderTodayPredictions(data) {
      var el = document.getElementById('todayPredictResults');
      if (!el) return;
      // Model badge — surfaces the actual engine version + LGB coverage so it is
      // visible at a glance which model produced the predictions.
      var statusEl = document.getElementById('todayPredictStatus');
      if (statusEl) {
        var mv = data.lgbModelVersion || '(none)';
        var cov = data.lgbCoverage || {};
        var covTxt = (cov.rows != null) ? (cov.rows + ' rows') : 'no coverage';
        var anyLgb = (data.races || []).some(function(r){ return r.scoreSource === 'lgb'; });
        var allLgb = (data.races || []).length > 0 && (data.races || []).every(function(r){ return r.scoreSource === 'lgb'; });
        var badge = allLgb ? '✓ LGB applied to ALL races'
                : anyLgb ? '◑ LGB applied to SOME races (fallback elsewhere)'
                : '○ LGB fallback — using ELO + factor only';
        var color = allLgb ? 'var(--green)' : anyLgb ? '#c80' : 'var(--mut)';
        statusEl.innerHTML = '<span style="color:var(--ink)">model:</span> <code>' + mv + '</code> · ' + covTxt + ' · <span style="color:' + color + '">' + badge + '</span>';
      }
      function fmtElo(v) { return v != null ? '<span class="tp-elo">' + Math.round(v) + '</span>' : '<span style="color:var(--mut)">—</span>'; }
      function fmtBonus(v, fb) {
        if (v == null) return '—';
        var cls = v > 0 ? 'tp-bonus-pos' : v < 0 ? 'tp-bonus-neg' : '';
        var s = '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v + '</span>';
        if (fb) {
          var lines = ['recency','distance','going','draw','weight','condition','injury','jtCombo'].map(function(k){
            var f = fb[k]; if (!f) return null;
            var col = f.bonus > 0 ? 'var(--green)' : f.bonus < 0 ? 'var(--red)' : 'var(--mut)';
            var sign = f.bonus >= 0 ? '+' : '';
            return '<span style="color:' + col + '">' + sign + f.bonus.toFixed(1) + '</span>'
                 + '<span style="color:var(--mut);font-size:10px"> ' + f.note + '</span>';
          }).filter(Boolean);
          if (lines.length) {
            s += '<details><summary style="font-size:10px;color:var(--mut);cursor:pointer">明細</summary>'
               + '<div class="tp-factor-detail">' + lines.join('<br>') + '</div></details>';
          }
        }
        return s;
      }
      function fmtPct(v) { return v != null ? (v*100).toFixed(1)+'%' : '—'; }
      el.innerHTML = (data.races || []).map(function(race, ri) {
        var picks = race.picks || [];
        var isOpen = ri < 3 ? ' open' : '';
        var topHorse = picks[0] ? ('<strong>' + (picks[0].nameCh || picks[0].nameEn || '—') + '</strong> ' + fmtPct(picks[0].pWin)) : '無資料';
        var rows = !picks.length
          ? '<tr><td colspan="12" style="padding:12px;color:var(--mut)">無排位資料</td></tr>'
          : picks.map(function(p) {
            var rc = p.rank===1 ? 'tp-rank-1' : p.rank<=3 ? 'tp-rank-2' : '';
            var probCls = 'tp-prob' + (p.rank===1 ? ' tp-prob-hi' : '');
            return '<tr>'
              + '<td class="' + rc + '">' + p.rank + '</td>'
              + '<td style="font-variant-numeric:tabular-nums">' + (p.horseNumber||'—') + '</td>'
              + '<td><div class="tp-hname">' + (p.nameCh||p.nameEn||'—') + '</div>'
                + '<div class="tp-sub">' + (p.jockeyCh||'—') + ' / ' + (p.trainerCh||'—') + '</div></td>'
              + '<td style="text-align:center">' + (p.draw!=null?p.draw:'—') + '</td>'
              + '<td>' + fmtElo(p.horseElo) + '</td>'
              + '<td>' + fmtElo(p.jockeyElo) + '</td>'
              + '<td>' + fmtElo(p.trainerElo) + '</td>'
              + '<td><strong>' + fmtElo(p.eloComposite) + '</strong></td>'
              + '<td>' + fmtBonus(p.factorBonus, p.factorBreakdown) + '</td>'
              + '<td><strong>' + fmtElo(p.finalScore) + '</strong></td>'
              + '<td class="' + probCls + (p.rank<=2?' ok':'') + '">' + fmtPct(p.pWin) + '</td>'
              + '<td>' + fmtPct(p.pTop3) + '</td>'
              + '</tr>';
          }).join('');
        return '<div class="tp-race' + isOpen + '" id="tp-r' + race.raceNumber + '">'
          + '<div class="tp-race-hd" onclick="toggleTpRace(' + race.raceNumber + ')">'
            + '<div class="tp-rnum">' + race.raceNumber + '</div>'
            + '<div class="tp-race-meta">'
              + '<div class="tp-race-title">' + (race.title||'第'+race.raceNumber+'場') + '</div>'
              + '<div class="tp-race-sub">'
                + (race.distance?race.distance+'m':'') + (race.going?' · '+race.going:'')
                + (race.class?' · '+race.class:'') + ' · ' + picks.length + ' 匹'
              + '</div>'
            + '</div>'
            + '<div style="margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap">' + topHorse + '</div>'
            + '<span class="tp-chevron">▶</span>'
          + '</div>'
          + '<div class="tp-table-wrap">'
            + '<table class="tp-table"><thead><tr>'
              + '<th>排名</th><th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>檔</th>'
              + '<th>馬ELO</th><th>騎ELO</th><th>練ELO</th><th>綜合ELO</th>'
              + '<th>因子調整</th><th>最終分</th><th>勝率</th><th>前三</th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table>'
          + '</div>'
        + '</div>';
      }).join('');
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
        safeRender('loadTodayPredictions', () => loadTodayPredictions(false));
      safeRender('renderNextRaceDay', renderNextRaceDay);
  document.getElementById('refreshClock').textContent = '載入時間：' + new Date().toLocaleTimeString('zh-HK') + ' · 每 60 秒自動刷新';
  // Auto-reload page every 60s for fresh data — but skip while autoLoadHitChain is running
  // (chain takes ~4min serial for ~10 past meetings @ ~25s each; reload would interrupt it)
  function scheduleReload() {
    setTimeout(() => {
      if (window._hitChainActive) {
        // chain still running — defer reload by 30s, check again
        scheduleReload();
      } else {
        window.location.reload();
      }
    }, 60000);
  }
  scheduleReload();
        // ── 預測與賽果 (PREDICTION VS RESULT) ──────────────────────────────
        var _cmpToken = 0, _cmpCache = {};
          // 2026-05-21 (Stage 7 LGB rollout to hit-rate): bump key v2→v3 to
          // one-shot evict pre-LGB ELO-only cached payloads from user browsers.
          // Also add 60-min TTL so future model upgrades don't require key bump.
          var _CMP_LS_KEY = 'tx_cmp_cache_v3';
          var _CMP_LS_MAX = 3; // 保留近 3 個賽事日比對資料
          var _CMP_LS_TTL_MS = 60 * 60 * 1000; // 1 hour
          try {
            // Best-effort: clear old v2 cache so storage doesn't bloat
            try { localStorage.removeItem('tx_cmp_cache_v2'); } catch(_) {}
            var _raw = localStorage.getItem(_CMP_LS_KEY);
            if (_raw) {
              var _parsed = JSON.parse(_raw);
              if (_parsed && typeof _parsed === 'object') {
                var _now = Date.now();
                Object.keys(_parsed).forEach(function(k){
                  var v = _parsed[k];
                  if (v && v.data && v.ts && (_now - v.ts) < _CMP_LS_TTL_MS) {
                    _cmpCache[k] = v.data;
                  }
                });
              }
            }
          } catch (_e) { /* ignore */ }
          function _cmpPersist(date, data){
            try {
              var raw = localStorage.getItem(_CMP_LS_KEY);
              var obj = raw ? JSON.parse(raw) : {};
              if (!obj || typeof obj !== 'object') obj = {};
              obj[date] = { data: data, ts: Date.now() };
              // LRU: keep newest _CMP_LS_MAX by ts
              var keys = Object.keys(obj).sort(function(a,b){ return (obj[b].ts||0) - (obj[a].ts||0); });
              if (keys.length > _CMP_LS_MAX) {
                keys.slice(_CMP_LS_MAX).forEach(function(k){ delete obj[k]; });
              }
              localStorage.setItem(_CMP_LS_KEY, JSON.stringify(obj));
            } catch (_e) { /* quota/privacy errors ignored */ }
          }
        function cmpEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
        function cmpNorm(s){ return String(s==null?'':s).trim().toLowerCase(); }
        function cmpKey(h){
          if (!h) return null;
          if (h.horseId) return 'h:'+h.horseId;
          var no = h.horseNumber!=null?h.horseNumber:h.no;
          var nm = h.nameCh||h.name;
          if (no!=null && no!=='' && nm) return 'no:'+no+'|nm:'+cmpNorm(nm);
          return null;
        }
        function cmpCell(rank, h, isMatch){
            if (!h) return '<div class="cmp-cell empty">—</div>';
            var no = h.horseNumber!=null?h.horseNumber:h.no;
            var nm = h.nameCh||h.name;
            if (!nm) nm = h.horseId ? ('馬 '+String(h.horseId).slice(0,8)) : '—';
            var od = (h.winOdds!=null && !isNaN(Number(h.winOdds))) ? Number(h.winOdds) : null;
            var odTxt = od!=null ? (od>=100 ? od.toFixed(0) : od.toFixed(1)) : null;
            return '<div class="cmp-cell'+(isMatch?' match':'')+'">'
              + '<div class="cmp-rank">'+rank+'</div>'
              + '<div class="cmp-name">'+(no!=null?'<span class="num">#'+cmpEsc(no)+'</span>':'')+cmpEsc(nm)+'</div>'
              + (odTxt!=null ? '<div class="cmp-odds">賠率 '+cmpEsc(odTxt)+'</div>' : '<div class="cmp-odds" style="opacity:.4">賠率 —</div>')
              + '</div>';
          }
        function cmpRender(left, right){
          var L = (left||[]).filter(Boolean).slice(0,4);
          var R = (right||[]).filter(Boolean).slice(0,4);
          var ls = {}, rs = {};
          L.forEach(function(h){ var k=cmpKey(h); if(k) ls[k]=true; });
          R.forEach(function(h){ var k=cmpKey(h); if(k) rs[k]=true; });
          var leftEl = document.getElementById('cmpLeft');
          var rightEl = document.getElementById('cmpRight');
          if (!L.length) { leftEl.innerHTML = '<div class="cmp-empty-box">未有預測（此場暫未產生天喜預測）</div>'; }
          else { leftEl.innerHTML = [0,1,2,3].map(function(i){ var h=L[i]; var k=h&&cmpKey(h); return cmpCell(i+1, h, !!(k&&rs[k])); }).join(''); }
          if (!R.length) { rightEl.innerHTML = '<div class="cmp-empty-box">賽果未出（此場未完賽或未同步）</div>'; }
          else { rightEl.innerHTML = [0,1,2,3].map(function(i){ var h=R[i]; var k=h&&cmpKey(h); return cmpCell(i+1, h, !!(k&&ls[k])); }).join(''); }
        }
        async function cmpLoadDate(date){
          var raceSel = document.getElementById('cmpRace');
          var status = document.getElementById('cmpStatus');
          raceSel.innerHTML = '<option>載入中…</option>'; raceSel.disabled = true;
          status.textContent = '載入 '+date+' 比對資料中…';
          var myToken = ++_cmpToken;
          try {
            var data;
            if (_cmpCache[date]) { data = _cmpCache[date]; }
            else {
              // 用 server-side cache (meeting_hit_rate_cache)；唔再加 refresh=1
                var res = await fetch('/api/analyze/hit-rate?date='+encodeURIComponent(date));
                data = await res.json();
                if (!data || data.error) { throw new Error(data && data.error || 'fetch failed'); }
                _cmpCache[date] = data;
                _cmpPersist(date, data);
            }
            if (myToken !== _cmpToken) return;
            var races = (data.races||[]).slice().sort(function(a,b){ return (a.raceNumber||0)-(b.raceNumber||0); });
            if (!races.length) {
              raceSel.innerHTML = '<option>無場次</option>';
              status.textContent = date+' · 無比對資料';
              cmpRender([],[]);
              return;
            }
            raceSel.innerHTML = races.map(function(r){
              var lbl = 'R'+(r.raceNumber||'?')+(r.distance? ' · '+r.distance+'m':'')+(r.going? ' · '+r.going:'');
              return '<option value="'+(r.raceNumber||'')+'">'+cmpEsc(lbl)+'</option>';
            }).join('');
            raceSel.disabled = false;
            status.textContent = date+' · '+races.length+' 場';
            cmpRenderRace(date, races[0].raceNumber);
          } catch(e){
            if (myToken !== _cmpToken) return;
            raceSel.innerHTML = '<option>錯誤</option>';
            status.textContent = '錯誤：'+e.message;
            cmpRender([],[]);
          }
        }
        function cmpRenderRace(date, raceNum){
          var data = _cmpCache[date]; if (!data) return;
          var race = (data.races||[]).find(function(r){ return String(r.raceNumber)===String(raceNum); });
          if (!race) { cmpRender([],[]); return; }
          cmpRender(race.predictedTop4||race.predictedTop3||[], race.actualTop4||race.actualTop3||[]);
        }
        function cmpInit(){
          var dateSel = document.getElementById('cmpDate');
          var raceSel = document.getElementById('cmpRace');
          if (!dateSel || !raceSel) return;
          var meets = (D && D.meetings && D.meetings.meetings) || [];
          var today = (D.status && D.status.serverTime ? D.status.serverTime : new Date().toISOString()).substring(0,10);
          var eligible = meets.filter(function(m){ return m.date < today && m.race_count > 0; });
          if (!eligible.length) {
            dateSel.innerHTML = '<option>無已完賽資料</option>';
            return;
          }
          dateSel.innerHTML = eligible.map(function(m){
            var v = m.venue==='ST'?'沙田':m.venue==='HV'?'跑馬地':(m.venue||'');
            return '<option value="'+m.date+'">'+m.date+(v?' · '+v:'')+'</option>';
          }).join('');
          dateSel.onchange = function(){ cmpLoadDate(dateSel.value); };
          raceSel.onchange = function(){ cmpRenderRace(dateSel.value, raceSel.value); };
          cmpLoadDate(eligible[0].date);
        }
        window.cmpJumpTo = function(date){
          var dateSel = document.getElementById('cmpDate');
          if (!dateSel) return;
          var found = Array.from(dateSel.options).some(function(o){ if (o.value===date){ dateSel.value=date; return true; } return false; });
          if (found) { cmpLoadDate(date); var sec=document.getElementById('cmpSection'); if(sec) sec.scrollIntoView({behavior:'smooth',block:'start'}); }
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cmpInit);
        else setTimeout(cmpInit, 0);

  
</script>
</body></html>`;
}
