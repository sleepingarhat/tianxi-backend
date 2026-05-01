/**
 * Internal admin panel (Priority 3 · 2026-05-01).
 * v2: 繁體中文 UI · 30 秒全頁自動刷新 · 實時告警列。
 *
 * Consumer-facing UI is frozen per 2026-04-30 directive. This module
 * ships a minimal operator dashboard for the project owner only.
 *
 *   GET  /admin/            → HTML panel (bearer-auth gate)
 *   GET  /admin/api/status  → D1 row counts, latest dates, schema health
 *   GET  /admin/api/gaps    → month-gap detector
 *   GET  /admin/api/alerts  → alert rules evaluator (odds stale, failed runs…)
 *   POST /admin/api/dispatch → Trigger a GitHub Actions workflow
 *   GET  /admin/api/runs    → Recent workflow runs from GH
 *
 * Auth: Bearer token matching `ADMIN_TOKEN` binding OR ?token=… query.
 * Internal only — do NOT expose via any marketing surface.
 */
import { Hono } from 'hono';

interface AdminEnv {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

// ── Auth middleware — bearer header OR ?token= query ──────────────────────
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

// ── GET /admin/api/status — D1 health snapshot ──────────────────────────
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
    latestEntry, latestTrackwork, latestElo, latestOdds,
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
    scalar<string>(`SELECT MAX(captured_at) AS t FROM odds_snapshots`),
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
      latestEntry, latestTrackwork, latestElo, latestOdds,
    },
    serverTime: new Date().toISOString(),
  });
});

// ── GET /admin/api/gaps — suspect month detector ──────────────────────────
adminRoutes.get('/api/gaps', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`
    SELECT substr(date, 1, 7) AS ym, COUNT(*) AS n
      FROM race_meetings
     GROUP BY ym
     HAVING n < 5
        AND substr(ym, 6, 2) NOT IN ('06', '07', '08')
     ORDER BY ym`).all();
  return c.json({ suspectMonths: rows.results });
});

// ── GET /admin/api/alerts — operational alert evaluator ──────────────────
adminRoutes.get('/api/alerts', async (c) => {
  const db = c.env.DB;
  const now = new Date();
  const nowMs = now.getTime();
  const alerts: { level: 'red' | 'yellow'; msg: string }[] = [];

  async function scalar<T = string>(sql: string): Promise<T | null> {
    try {
      const row = await db.prepare(sql).first<Record<string, T>>();
      return row ? (Object.values(row)[0] as T) : null;
    } catch { return null; }
  }

  // 1. Odds freshness
  const oddsLatest = await scalar<string>(`SELECT MAX(captured_at) AS t FROM odds_snapshots`);
  const oddsCount = await scalar<number>(`SELECT COUNT(*) AS n FROM odds_snapshots`);
  if (!oddsCount) {
    alerts.push({ level: 'red', msg: '賠率表 odds_snapshots 完全冇資料（有賽事進行時需核對爬取工作流）' });
  } else if (oddsLatest) {
    const hrs = (nowMs - new Date(oddsLatest).getTime()) / 3600000;
    if (hrs > 6) alerts.push({ level: 'red', msg: `賠率已停更新 ${hrs.toFixed(1)} 小時` });
  }

  // 2. Trackwork freshness
  const twLatest = await scalar<string>(`SELECT MAX(trackwork_date) AS d FROM horse_trackwork`);
  if (twLatest) {
    const days = Math.floor((nowMs - new Date(twLatest).getTime()) / 86400000);
    if (days > 3) alerts.push({ level: 'yellow', msg: `晨操資料落後 ${days} 日（最新：${twLatest}）` });
  } else {
    alerts.push({ level: 'yellow', msg: '晨操資料完全冇' });
  }

  // 3. Entries vs next meeting
  const nextMeet = await scalar<string>(
    `SELECT MIN(date) AS d FROM race_meetings WHERE date >= date('now','localtime')`
  );
  const entLatest = await scalar<string>(`SELECT MAX(race_date) AS d FROM entries_upcoming`);
  if (nextMeet && (!entLatest || entLatest < nextMeet)) {
    alerts.push({
      level: 'yellow',
      msg: `排位表未同步（entries 最新 ${entLatest || '—'} · 下場賽事 ${nextMeet}）`,
    });
  }

  // 4. Meetings latest drift
  const meetLatest = await scalar<string>(`SELECT MAX(date) AS d FROM race_meetings`);
  if (meetLatest) {
    const days = Math.floor((nowMs - new Date(meetLatest).getTime()) / 86400000);
    if (days > 14) alerts.push({ level: 'red', msg: `賽馬日最新已 ${days} 日冇更新（${meetLatest}）` });
  }

  // 5. Recent failed GHA runs (≤ 3 hours)
  const token = c.env.GITHUB_TOKEN;
  const repo = c.env.GITHUB_REPO;
  if (token && repo) {
    try {
      const r = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?per_page=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'tianxi-admin',
          },
        },
      );
      if (r.ok) {
        const j: any = await r.json();
        const cutoff = nowMs - 3 * 3600000;
        const failures = (j.workflow_runs || []).filter((x: any) =>
          x.conclusion === 'failure' && new Date(x.updated_at).getTime() > cutoff
        );
        for (const f of failures.slice(0, 3)) {
          alerts.push({ level: 'red', msg: `工作流失敗：${f.name}（#${f.id}）` });
        }
      }
    } catch { /* GH unreachable, silent */ }
  }

  return c.json({ alerts, checkedAt: now.toISOString() });
});

// ── POST /admin/api/dispatch — trigger a GHA workflow ───────────────────
adminRoutes.post('/api/dispatch', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  const repo = c.env.GITHUB_REPO;
  if (!token || !repo) {
    return c.json({ error: 'GITHUB_TOKEN / GITHUB_REPO 未設定' }, 503);
  }
  const body = await c.req.json<{
    workflow: string;
    ref?: string;
    inputs?: Record<string, string>;
  }>();
  if (!body.workflow) return c.json({ error: 'workflow required' }, 400);
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
      body: JSON.stringify({ ref: body.ref || 'main', inputs: body.inputs || {} }),
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
  if (!token || !repo) return c.json({ error: 'GITHUB_TOKEN / GITHUB_REPO 未設定' }, 503);
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
  if (!res.ok) return c.json({ error: 'github api failed', status: res.status }, 502);
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

// ── GET /admin/ — single-page dashboard (inline HTML, 繁體) ───────────
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
  body { font: 14px/1.45 -apple-system, "PingFang TC", "Noto Sans TC", Helvetica, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:24px }
  h1 { font-size: 18px; margin:0 0 6px; letter-spacing:.02em }
  h2 { font-size: 13px; margin:20px 0 8px; letter-spacing:.08em; color:var(--mut) }
  .bar { color:var(--mut); margin-bottom:16px; font-size:12px }
  .refresh { color:var(--mut); font-size:11px; margin-left:8px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px }
  .tile { background:#fff; padding:10px 12px; border:1px solid var(--rule); border-radius:4px }
  .tile .label { font-size:11px; color:var(--mut); letter-spacing:.04em }
  .tile .val { font-size:18px; font-weight:600; margin-top:2px }
  .tile .sub { font-size:11px; color:var(--mut); margin-top:2px }
  .tile.warn { border-color:var(--warn); background:#fffaec }
  .tile.bad  { border-color:var(--red); background:#fdf0f2 }
  table { border-collapse:collapse; width:100%; font-size:13px; background:#fff; border:1px solid var(--rule) }
  th,td { padding:6px 10px; text-align:left; border-bottom:1px solid var(--rule) }
  th { background:#ede8dc; font-weight:500; font-size:11px; letter-spacing:.04em }
  td.ok { color:var(--green) } td.bad { color:var(--red) } td.warn { color:var(--warn) }
  button { background:var(--fg); color:#fff; border:0; padding:6px 12px; font-family:inherit; font-size:13px; cursor:pointer; border-radius:3px }
  button:hover { opacity:.85 }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--rule) }
  input, select { font-family:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--rule); border-radius:3px; background:#fff }
  .actions-row { display:flex; gap:6px; align-items:center; margin-bottom:8px; flex-wrap:wrap }
  .log { font-family: ui-monospace, Menlo, monospace; font-size:12px; background:#1c1c1c; color:#eee; padding:10px; border-radius:4px; max-height:240px; overflow:auto; white-space:pre-wrap; margin-top:8px }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500 }
  .pill.success { background:#d8efdd; color:#186e2e }
  .pill.failure { background:#f7d4d9; color:#8a0e24 }
  .pill.in_progress { background:#ffecc9; color:#8a6a0a }
  .pill.queued { background:#e4e0d6; color:var(--mut) }
  .pill.completed { background:#dfe6ef; color:#1d5dca }
  /* Alert bar */
  #alertbar { margin-bottom:16px; border-radius:4px; overflow:hidden }
  #alertbar .alert { padding:8px 12px; font-size:13px; border-left:4px solid var(--rule) }
  #alertbar .alert.red { background:#fdf0f2; border-left-color:var(--red); color:#7a0b1e }
  #alertbar .alert.yellow { background:#fffaec; border-left-color:var(--warn); color:#6a4d05 }
  #alertbar .alert.ok { background:#e8f5ec; border-left-color:var(--green); color:#186e2e }
  #alertbar .alert + .alert { border-top:1px solid rgba(0,0,0,0.06) }
  .pulse { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--green); animation: p 1.8s infinite }
  @keyframes p { 0%{opacity:.3} 50%{opacity:1} 100%{opacity:.3} }
</style></head>
<body>
  <h1>天喜 · 內部控制台 <span class="pulse" title="實時監控"></span></h1>
  <div class="bar">
    內部運營監控 · 每 30 秒自動刷新全頁
    <span class="refresh" id="refreshClock">初始化中…</span>
  </div>

  <div id="alertbar"><div class="alert ok">讀取告警中…</div></div>

  <h2>D1 資料狀態</h2>
  <div id="status" class="grid">載入中…</div>

  <h2>可疑月份（香港賽季內但場次不足 5 場）</h2>
  <table id="gaps"><thead><tr><th>年-月</th><th>場次</th></tr></thead><tbody><tr><td colspan="2">載入中…</td></tr></tbody></table>

  <h2>觸發工作流</h2>
  <div class="actions-row">
    <select id="wf">
      <option value="capy_race_daily.yml">capy_race_daily（指定日期或每日）</option>
      <option value="capy_pool_a.yml">capy_pool_a（馬匹資料＋晨操＋傷患）</option>
      <option value="capy_odds.yml">capy_odds（即時賠率快照）</option>
      <option value="capy_d1_sync.yml">capy_d1_sync（賽事）</option>
      <option value="capy_d1_sync_entries.yml">capy_d1_sync_entries（排位表）</option>
      <option value="capy_d1_sync_pool_a.yml">capy_d1_sync_pool_a（晨操／傷患）</option>
      <option value="capy_d1_bulk_backfill.yml">capy_d1_bulk_backfill（整年補數）</option>
      <option value="capy_entries.yml">capy_entries（明日排位）</option>
      <option value="capy_fixture_weekly.yml">capy_fixture_weekly（每週賽期）</option>
      <option value="capy_integrity_audit.yml">capy_integrity_audit（完整性審計）</option>
    </select>
    <input id="inputs" style="flex:1;min-width:240px" placeholder='inputs JSON，例：{"force":"true","date":"2017-06-14"}'>
    <button onclick="dispatch()">觸發</button>
  </div>
  <div id="dispatchLog" class="log" style="display:none"></div>

  <h2>最近工作流運行</h2>
  <table id="runs"><thead><tr><th>ID</th><th>名稱</th><th>狀態</th><th>結果</th><th>更新時間</th></tr></thead><tbody><tr><td colspan="5">載入中…</td></tr></tbody></table>

  <h2>ELO 權重（預覽 · 未寫入後端）</h2>
  <div style="font-size:12px;color:var(--mut);margin-bottom:4px">目前 <code>analyze.ts</code> 寫死 H=0.7 / J=0.2 / T=0.1 · 下一版會用 <code>admin_config</code> 表熱更新</div>
  <div class="actions-row">
    <label>馬匹 H <input id="wH" type="number" step="0.05" value="0.7" style="width:70px"></label>
    <label>騎師 J <input id="wJ" type="number" step="0.05" value="0.2" style="width:70px"></label>
    <label>練馬師 T <input id="wT" type="number" step="0.05" value="0.1" style="width:70px"></label>
    <button class="ghost" onclick="document.getElementById('weightHint').style.display='block'">顯示說明</button>
  </div>
  <div id="weightHint" style="display:none;font-size:12px;color:var(--mut);margin-top:6px">
    目前修改此處數字尚未真正生效 · 下一版會加 POST /admin/api/config 寫入 D1 · 然後 analyze.ts 每次查詢時讀最新權重。
  </div>

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
    if (s.error) { document.getElementById('status').innerHTML = '<div class="tile bad">讀取失敗：' + s.error + '</div>'; return; }
    const el = document.getElementById('status');
    el.innerHTML = '';
    const tiles = [
      ['賽馬日', s.counts.meetings, s.dates.earliestMeeting + ' → ' + s.dates.latestMeeting, ''],
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
    for (const [label, val, sub, cls] of tiles) {
      el.insertAdjacentHTML('beforeend',
        '<div class="tile ' + cls + '"><div class="label">' + label + '</div>' +
        '<div class="val">' + fmtNum(val) + '</div>' +
        (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>');
    }
  }

  async function loadGaps() {
    const g = await json('/admin/api/gaps');
    const tb = document.querySelector('#gaps tbody');
    if (g.error) { tb.innerHTML = '<tr><td colspan="2" class="bad">' + g.error + '</td></tr>'; return; }
    if (!g.suspectMonths || !g.suspectMonths.length) {
      tb.innerHTML = '<tr><td colspan="2" class="ok">✓ 所有月份正常</td></tr>';
    } else {
      tb.innerHTML = g.suspectMonths.map(r => '<tr><td>' + r.ym + '</td><td class="warn">' + r.n + '</td></tr>').join('');
    }
  }

  async function loadAlerts() {
    const a = await json('/admin/api/alerts');
    const bar = document.getElementById('alertbar');
    if (a.error) {
      bar.innerHTML = '<div class="alert red">告警系統失敗：' + a.error + '</div>';
      return;
    }
    if (!a.alerts || !a.alerts.length) {
      bar.innerHTML = '<div class="alert ok">✓ 系統正常 · 無告警</div>';
      return;
    }
    bar.innerHTML = a.alerts.map(x =>
      '<div class="alert ' + x.level + '">' + (x.level === 'red' ? '⚠ ' : '▲ ') + x.msg + '</div>'
    ).join('');
  }

  async function loadRuns() {
    const r = await json('/admin/api/runs?limit=20');
    const tb = document.querySelector('#runs tbody');
    if (r.error) { tb.innerHTML = '<tr><td colspan="5" class="bad">' + r.error + '</td></tr>'; return; }
    tb.innerHTML = r.runs.map(x => {
      const st = '<span class="pill ' + x.status + '">' + x.status + '</span>';
      const cc = x.conclusion ? '<span class="pill ' + x.conclusion + '">' + x.conclusion + '</span>' : '—';
      return '<tr><td><a href="' + x.htmlUrl + '" target="_blank">' + x.id + '</a></td>' +
        '<td>' + (x.name || '').slice(0, 40) + '</td>' +
        '<td>' + st + '</td><td>' + cc + '</td>' +
        '<td>' + (x.updatedAt || '').slice(5, 16).replace('T', ' ') + '</td></tr>';
    }).join('');
  }

  async function dispatch() {
    const wf = document.getElementById('wf').value;
    const inputsRaw = document.getElementById('inputs').value.trim();
    let inputs = {};
    if (inputsRaw) {
      try { inputs = JSON.parse(inputsRaw); } catch (e) { alert('inputs JSON 格式錯誤'); return; }
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
    setTimeout(() => { loadRuns(); loadAlerts(); }, 2500);
  }

  function refreshAll() {
    loadAlerts(); loadStatus(); loadGaps(); loadRuns();
    document.getElementById('refreshClock').textContent = '最近刷新：' + new Date().toLocaleTimeString('zh-HK');
  }

  refreshAll();
  setInterval(refreshAll, 30000);
</script>
</body></html>`;
}
