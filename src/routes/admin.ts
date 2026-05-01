/**
 * Internal admin panel (Priority 3 · 2026-05-01).
 *
 * Consumer-facing UI is frozen per 2026-04-30 directive. This module
 * ships a minimal operator dashboard for the project owner only:
 *
 *   GET  /admin/            → HTML panel (bearer-auth gate)
 *   GET  /admin/api/status  → D1 row counts, latest dates, schema health
 *   POST /admin/api/dispatch → Trigger a GitHub Actions workflow
 *   GET  /admin/api/runs    → Recent workflow runs from GH
 *
 * Auth: Bearer token matching `ADMIN_TOKEN` binding (set via `wrangler
 * secret put ADMIN_TOKEN`). Anything without it → 401. This is an
 * internal-only tool — do NOT expose via any marketing surface.
 */
import { Hono } from 'hono';

interface AdminEnv {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;      // PAT for `sleepingarhat/tianxi-database` dispatches
  GITHUB_REPO?: string;       // e.g. "sleepingarhat/tianxi-database"
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

// ── Auth middleware — bearer or ?token=… param ──────────────────────────
adminRoutes.use('*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    return c.json({ error: 'admin disabled: ADMIN_TOKEN not set' }, 503);
  }
  const header = c.req.header('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const queryTok = c.req.query('token') || '';
  if (bearer !== expected && queryTok !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// ── GET /admin/api/status — D1 health dashboard ─────────────────────────
adminRoutes.get('/api/status', async (c) => {
  const db = c.env.DB;
  async function scalar<T = number>(sql: string): Promise<T | null> {
    try {
      const row = await db.prepare(sql).first<Record<string, T>>();
      return row ? (Object.values(row)[0] as T) : null;
    } catch {
      return null;
    }
  }
  const [
    meetingsCount, racesCount, resultsCount,
    horsesCount, jockeysCount, trainersCount,
    trackworkCount, injuryCount, formCount,
    entriesCount, oddsCount,
    horseEloCount, jockeyEloCount, trainerEloCount,
    latestMeeting, earliestMeeting,
    latestEntry, latestTrackwork, latestElo,
  ] = await Promise.all([
    scalar<number>(`SELECT COUNT(*) AS n FROM race_meetings`),
    scalar<number>(`SELECT COUNT(*) AS n FROM races`),
    scalar<number>(`SELECT COUNT(*) AS n FROM race_results`),
    scalar<number>(`SELECT COUNT(*) AS n FROM horses`),
    scalar<number>(`SELECT COUNT(*) AS n FROM jockeys`),
    scalar<number>(`SELECT COUNT(*) AS n FROM trainers`),
    scalar<number>(`SELECT COUNT(*) AS n FROM horse_trackwork`),
    scalar<number>(`SELECT COUNT(*) AS n FROM horse_injury`),
    scalar<number>(`SELECT COUNT(*) AS n FROM horse_form_records`),
    scalar<number>(`SELECT COUNT(*) AS n FROM entries_upcoming`),
    scalar<number>(`SELECT COUNT(*) AS n FROM odds_snapshots`),
    scalar<number>(`SELECT COUNT(*) AS n FROM horse_elo_snapshots`),
    scalar<number>(`SELECT COUNT(*) AS n FROM jockey_elo_snapshots`),
    scalar<number>(`SELECT COUNT(*) AS n FROM trainer_elo_snapshots`),
    scalar<string>(`SELECT MAX(date) AS d FROM race_meetings`),
    scalar<string>(`SELECT MIN(date) AS d FROM race_meetings`),
    scalar<string>(`SELECT MAX(race_date) AS d FROM entries_upcoming`),
    scalar<string>(`SELECT MAX(trackwork_date) AS d FROM horse_trackwork`),
    scalar<string>(`SELECT MAX(as_of_date) AS d FROM horse_elo_snapshots`),
  ]);

  return c.json({
    counts: {
      meetings: meetingsCount, races: racesCount, results: resultsCount,
      horses: horsesCount, jockeys: jockeysCount, trainers: trainersCount,
      trackwork: trackworkCount, injury: injuryCount, form: formCount,
      entries: entriesCount, odds: oddsCount,
      horseElo: horseEloCount, jockeyElo: jockeyEloCount, trainerElo: trainerEloCount,
    },
    dates: {
      earliestMeeting, latestMeeting,
      latestEntry, latestTrackwork, latestElo,
    },
    serverTime: new Date().toISOString(),
  });
});

// ── GET /admin/api/gaps — meeting-date gap scan ──────────────────────────
// Finds months where D1 meetings < 5 (HK season has ~7-9 meetings/mo).
adminRoutes.get('/api/gaps', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`
    SELECT substr(date, 1, 7) AS ym, COUNT(*) AS n
      FROM race_meetings
     GROUP BY ym
     HAVING n < 5
        AND substr(ym, 6, 2) NOT IN ('06', '07', '08')   -- HK summer break
     ORDER BY ym`).all();
  return c.json({ suspectMonths: rows.results });
});

// ── POST /admin/api/dispatch — trigger a GHA workflow ───────────────────
adminRoutes.post('/api/dispatch', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  const repo = c.env.GITHUB_REPO;
  if (!token || !repo) {
    return c.json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' }, 503);
  }
  const body = await c.req.json<{
    workflow: string;        // e.g. "capy_race_daily.yml"
    ref?: string;            // default "main"
    inputs?: Record<string, string>;
  }>();
  if (!body.workflow) return c.json({ error: 'workflow required' }, 400);
  // Whitelist allowed workflows to prevent arbitrary dispatch.
  const ALLOWED = new Set([
    'capy_race_daily.yml',
    'capy_pool_a.yml',
    'capy_odds.yml',
    'capy_d1_sync.yml',
    'capy_d1_sync_entries.yml',
    'capy_d1_sync_pool_a.yml',
    'capy_d1_bulk_backfill.yml',
    'capy_entries.yml',
    'capy_fixture_weekly.yml',
    'capy_integrity_audit.yml',
  ]);
  if (!ALLOWED.has(body.workflow)) {
    return c.json({ error: `workflow ${body.workflow} not whitelisted` }, 400);
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${body.workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tianxi-admin',
      },
      body: JSON.stringify({
        ref: body.ref || 'main',
        inputs: body.inputs || {},
      }),
    },
  );
  if (res.status !== 204) {
    const text = await res.text();
    return c.json({ error: 'dispatch failed', status: res.status, detail: text }, 502);
  }
  return c.json({ ok: true, workflow: body.workflow, inputs: body.inputs || {} });
});

// ── GET /admin/api/runs — recent GHA runs ───────────────────────────────
adminRoutes.get('/api/runs', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  const repo = c.env.GITHUB_REPO;
  if (!token || !repo) return c.json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' }, 503);
  const limit = Number(c.req.query('limit') || '15');
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tianxi-admin',
      },
    },
  );
  if (!res.ok) {
    return c.json({ error: 'github api failed', status: res.status }, 502);
  }
  const json = await res.json() as any;
  return c.json({
    runs: (json.workflow_runs || []).map((r: any) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      htmlUrl: r.html_url,
    })),
  });
});

// ── GET /admin/ — single-page dashboard (inline HTML) ───────────────────
adminRoutes.get('/', (c) => {
  const token = c.req.query('token') || '';
  return c.html(renderPanel(token));
});

function renderPanel(token: string): string {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>天喜 · 內部控制台</title>
<style>
  :root {
    --bg:#f5f5f4; --fg:#1c1c1c; --mut:#6b6760; --rule:#d8d4cb;
    --green:#18a355; --red:#c8102e; --blue:#1d5dca; --warn:#d9a40b;
  }
  * { box-sizing: border-box }
  body { font: 14px/1.45 -apple-system, Helvetica, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:24px }
  h1 { font-size: 18px; margin:0 0 6px; letter-spacing:.02em }
  h2 { font-size: 13px; margin:20px 0 8px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut) }
  .bar { color:var(--mut); margin-bottom:16px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px }
  .tile { background:#fff; padding:10px 12px; border:1px solid var(--rule); border-radius:4px }
  .tile .label { font-size:11px; color:var(--mut); text-transform:uppercase; letter-spacing:.08em }
  .tile .val { font-size:18px; font-weight:600; margin-top:2px }
  .tile .sub { font-size:11px; color:var(--mut); margin-top:2px }
  table { border-collapse:collapse; width:100%; font-size:13px; background:#fff; border:1px solid var(--rule) }
  th,td { padding:6px 10px; text-align:left; border-bottom:1px solid var(--rule) }
  th { background:#ede8dc; font-weight:500; text-transform:uppercase; font-size:11px; letter-spacing:.05em }
  td.ok { color:var(--green) } td.bad { color:var(--red) } td.warn { color:var(--warn) }
  button { background:var(--fg); color:#fff; border:0; padding:6px 12px; font-family:inherit; font-size:13px; cursor:pointer; border-radius:3px }
  button:hover { opacity:.85 }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--rule) }
  input, select { font-family:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--rule); border-radius:3px; background:#fff }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px }
  .actions-row { display:flex; gap:6px; align-items:center; margin-bottom:8px; flex-wrap:wrap }
  .log { font-family: ui-monospace, Menlo, monospace; font-size:12px; background:#1c1c1c; color:#eee; padding:10px; border-radius:4px; max-height:240px; overflow:auto; white-space:pre-wrap; margin-top:8px }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; text-transform:uppercase }
  .pill.success { background:#d8efdd; color:#186e2e }
  .pill.failure { background:#f7d4d9; color:#8a0e24 }
  .pill.in_progress { background:#ffecc9; color:#8a6a0a }
  .pill.queued { background:#e4e0d6; color:var(--mut) }
</style></head>
<body>
  <h1>天喜 · 內部控制台</h1>
  <div class="bar">Internal operator dashboard · data completeness, scraper triggers, ELO weights</div>

  <h2>D1 狀態</h2>
  <div id="status" class="grid">載入中…</div>

  <h2>可疑月份 (HK 賽季內但 meetings &lt; 5)</h2>
  <table id="gaps"><thead><tr><th>Year-Month</th><th>Meetings</th></tr></thead><tbody><tr><td colspan="2">載入中…</td></tr></tbody></table>

  <h2>觸發工作流</h2>
  <div class="actions-row">
    <select id="wf">
      <option value="capy_race_daily.yml">capy_race_daily (--date 或 --daily)</option>
      <option value="capy_pool_a.yml">capy_pool_a (HorseData + Trackwork + Injury)</option>
      <option value="capy_odds.yml">capy_odds (live odds snapshot)</option>
      <option value="capy_d1_sync.yml">capy_d1_sync (race)</option>
      <option value="capy_d1_sync_entries.yml">capy_d1_sync_entries</option>
      <option value="capy_d1_sync_pool_a.yml">capy_d1_sync_pool_a</option>
      <option value="capy_d1_bulk_backfill.yml">capy_d1_bulk_backfill (one-shot year)</option>
      <option value="capy_entries.yml">capy_entries (upcoming racecards)</option>
      <option value="capy_fixture_weekly.yml">capy_fixture_weekly</option>
      <option value="capy_integrity_audit.yml">capy_integrity_audit</option>
    </select>
    <input id="inputs" style="flex:1;min-width:240px" placeholder='inputs JSON, e.g. {"force":"true","date":"2017-06-14"}'>
    <button onclick="dispatch()">Dispatch</button>
  </div>
  <div id="dispatchLog" class="log" style="display:none"></div>

  <h2>最近工作流運行</h2>
  <table id="runs"><thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Conclusion</th><th>Updated</th></tr></thead><tbody><tr><td colspan="5">載入中…</td></tr></tbody></table>

  <h2>ELO / Factor 權重 (預覽)</h2>
  <div style="font-size:12px;color:var(--mut);margin-bottom:4px">目前 analyze.ts 寫死 H=0.7 / J=0.2 / T=0.1 · 下一版會存入 <code>admin_config</code> 表並由呢度熱更新</div>
  <div class="actions-row">
    <label>H <input id="wH" type="number" step="0.05" value="0.7" style="width:70px"></label>
    <label>J <input id="wJ" type="number" step="0.05" value="0.2" style="width:70px"></label>
    <label>T <input id="wT" type="number" step="0.05" value="0.1" style="width:70px"></label>
    <button class="ghost" onclick="document.getElementById('weightHint').style.display='block'">預覽 composite 分</button>
  </div>
  <div id="weightHint" style="display:none;font-size:12px;color:var(--mut);margin-top:6px">編輯上面三個數字 → <code>ELO_WEIGHTS</code> 亦要同步改 src/routes/analyze.ts:116。呢個面板之後會支援直接寫入 <code>admin_config</code> 表。</div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  const H = { 'Authorization': 'Bearer ' + TOKEN };

  async function json(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...H } });
    return await res.json();
  }

  function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString() }
  function fmtDate(s) { return s || '—' }

  async function loadStatus() {
    const s = await json('/admin/api/status');
    const el = document.getElementById('status');
    el.innerHTML = '';
    const tiles = [
      ['Meetings', s.counts.meetings, s.dates.earliestMeeting + ' → ' + s.dates.latestMeeting],
      ['Races', s.counts.races, ''],
      ['Results', s.counts.results, ''],
      ['Horses', s.counts.horses, ''],
      ['Jockeys', s.counts.jockeys, ''],
      ['Trainers', s.counts.trainers, ''],
      ['Trackwork', s.counts.trackwork, 'latest: ' + fmtDate(s.dates.latestTrackwork)],
      ['Injury', s.counts.injury, ''],
      ['Form', s.counts.form, ''],
      ['Entries', s.counts.entries, 'latest: ' + fmtDate(s.dates.latestEntry)],
      ['Odds', s.counts.odds, ''],
      ['Horse ELO', s.counts.horseElo, 'latest: ' + fmtDate(s.dates.latestElo)],
      ['Jockey ELO', s.counts.jockeyElo, ''],
      ['Trainer ELO', s.counts.trainerElo, ''],
    ];
    for (const [label, val, sub] of tiles) {
      el.insertAdjacentHTML('beforeend', '<div class="tile"><div class="label">' + label + '</div><div class="val">' + fmtNum(val) + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>');
    }
  }

  async function loadGaps() {
    const g = await json('/admin/api/gaps');
    const tb = document.querySelector('#gaps tbody');
    if (!g.suspectMonths || !g.suspectMonths.length) {
      tb.innerHTML = '<tr><td colspan="2" class="ok">✓ 無異常月份</td></tr>';
    } else {
      tb.innerHTML = g.suspectMonths.map(r => '<tr><td>' + r.ym + '</td><td class="warn">' + r.n + '</td></tr>').join('');
    }
  }

  async function loadRuns() {
    const r = await json('/admin/api/runs?limit=20');
    const tb = document.querySelector('#runs tbody');
    if (r.error) { tb.innerHTML = '<tr><td colspan="5" class="bad">' + r.error + '</td></tr>'; return; }
    tb.innerHTML = r.runs.map(x => {
      const st = '<span class="pill ' + x.status + '">' + x.status + '</span>';
      const cc = x.conclusion ? '<span class="pill ' + x.conclusion + '">' + x.conclusion + '</span>' : '—';
      return '<tr><td><a href="' + x.htmlUrl + '" target="_blank">' + x.id + '</a></td><td>' + (x.name || '').slice(0, 40) + '</td><td>' + st + '</td><td>' + cc + '</td><td>' + (x.updatedAt || '').slice(11, 19) + '</td></tr>';
    }).join('');
  }

  async function dispatch() {
    const wf = document.getElementById('wf').value;
    const inputsRaw = document.getElementById('inputs').value.trim();
    let inputs = {};
    if (inputsRaw) {
      try { inputs = JSON.parse(inputsRaw); } catch (e) { alert('Invalid JSON in inputs'); return; }
    }
    const logEl = document.getElementById('dispatchLog');
    logEl.style.display = 'block';
    logEl.textContent = 'POST /admin/api/dispatch ' + wf + '\\n' + JSON.stringify(inputs, null, 2) + '\\n\\n';
    const res = await json('/admin/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: wf, inputs }),
    });
    logEl.textContent += JSON.stringify(res, null, 2);
    setTimeout(loadRuns, 2000);
  }

  loadStatus(); loadGaps(); loadRuns();
  setInterval(loadRuns, 15000);
</script>
</body></html>`;
}
