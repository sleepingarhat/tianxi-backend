import { Hono } from 'hono';
import type { Env } from '../types';
import { getSeasonStatus } from '../lib/season';

type Status = 'ok' | 'watch' | 'fail';

const DB_REPO = 'sleepingarhat/tianxi-database';
const BE_REPO = 'sleepingarhat/tianxi-backend';

const WF = {
  meetings: ['capy_race_daily.yml', 'capy_d1_sync.yml'],
  pool: ['capy_pool_a.yml', 'capy_d1_sync_pool_a.yml'],
  entries: ['capy_entries.yml', 'capy_d1_sync_entries.yml'],
  odds: ['capy_odds.yml'],
  elo: ['elo-post-race.yml'],
  engine: ['engine_sanity_daily.yml', 'deploy.yml'],
};

async function scalar(db: Env['DB'], sql: string): Promise<{ value: number | string | null; error?: string }> {
  try {
    const row = await db.prepare(sql).first<Record<string, number | string | null>>();
    return { value: row ? (Object.values(row)[0] ?? null) : null };
  } catch (e: any) {
    const msg = String(e?.message || e);
    return { value: null, error: /row read limit/i.test(msg) ? 'd1_quota' : 'd1_error' };
  }
}

async function lastRun(gh: string | undefined, repo: string, file: string) {
  if (!gh) return { file, repo, conclusion: null as string | null, at: null as string | null };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=1`, {
      headers: { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tianxi-ops' },
    });
    if (!r.ok) return { file, repo, conclusion: r.status === 404 ? 'missing' : 'error', at: null };
    const j: any = await r.json();
    const run = j.workflow_runs?.[0];
    return { file, repo, conclusion: run?.conclusion || run?.status || null, at: run?.updated_at || null };
  } catch {
    return { file, repo, conclusion: 'error', at: null };
  }
}

function grade(count: number | null, lastMeeting: string | null, err?: string): Status {
  if (err === 'd1_quota') return 'watch';
  if (count == null) return 'watch';
  if (count === 0) return lastMeeting ? 'watch' : 'fail';
  return 'ok';
}

function autoGrade(runs: { conclusion: string | null }[]): Status {
  const hit = runs.filter((r) => r.conclusion && r.conclusion !== 'missing' && r.conclusion !== 'error');
  if (!hit.length) return 'watch';
  if (hit.some((r) => r.conclusion === 'success')) return 'ok';
  if (hit.every((r) => r.conclusion === 'failure')) return 'fail';
  return 'watch';
}

export const opsRoutes = new Hono<{ Bindings: Env }>();

opsRoutes.get('/api/coverage', async (c) => {
  const db = c.env.DB;
  const gh = (c.env as any).GITHUB_TOKEN as string | undefined;
  const season = await getSeasonStatus(db).catch(() => null);
  const [
    meetings, races, results, horses, jockeys, trainers,
    trackwork, injury, form, entries, odds,
    latestMeeting, latestResult, latestForm, latestEntries,
  ] = await Promise.all([
    scalar(db, 'SELECT COUNT(*) FROM race_meetings'),
    scalar(db, 'SELECT COUNT(*) FROM races'),
    scalar(db, 'SELECT COUNT(*) FROM race_results'),
    scalar(db, 'SELECT COUNT(*) FROM horses'),
    scalar(db, 'SELECT COUNT(*) FROM jockeys'),
    scalar(db, 'SELECT COUNT(*) FROM trainers'),
    scalar(db, 'SELECT COUNT(*) FROM horse_trackwork'),
    scalar(db, 'SELECT COUNT(*) FROM horse_injury'),
    scalar(db, 'SELECT COUNT(*) FROM horse_form_records'),
    scalar(db, 'SELECT COUNT(*) FROM entries_upcoming'),
    scalar(db, 'SELECT COUNT(*) FROM odds_snapshots'),
    scalar(db, 'SELECT MAX(date) FROM race_meetings'),
    scalar(db, `SELECT m.date FROM race_results rr JOIN races r ON rr.race_id = r.id JOIN race_meetings m ON r.meeting_id = m.id ORDER BY m.date DESC LIMIT 1`),
    scalar(db, 'SELECT MAX(race_date) FROM horse_form_records'),
    scalar(db, 'SELECT MAX(race_date) FROM entries_upcoming'),
  ]);
  const lastMeet = (latestMeeting.value as string) || null;
  const files = [
    ...WF.meetings.map((f) => [DB_REPO, f] as const),
    ...WF.pool.map((f) => [DB_REPO, f] as const),
    ...WF.entries.map((f) => [DB_REPO, f] as const),
    ...WF.odds.map((f) => [DB_REPO, f] as const),
    ...WF.elo.map((f) => [BE_REPO, f] as const),
    ...WF.engine.map((f) => [BE_REPO, f] as const),
  ];
  const runs = await Promise.all(files.map(([repo, file]) => lastRun(gh, repo, file)));
  const byFile = Object.fromEntries(runs.map((r) => [`${r.repo}:${r.file}`, r]));
  const pick = (repo: string, names: string[]) => names.map((f) => byFile[`${repo}:${f}`]).filter(Boolean);
  const rows = [
    { key: 'meetings', label: '賽馬日', count: meetings.value, latest: latestMeeting.value, history: grade(meetings.value as number, lastMeet, meetings.error), auto: autoGrade(pick(DB_REPO, WF.meetings)), workflows: WF.meetings, error: meetings.error },
    { key: 'races', label: '場次', count: races.value, latest: lastMeet, history: grade(races.value as number, lastMeet, races.error), auto: autoGrade(pick(DB_REPO, WF.meetings)), workflows: WF.meetings, error: races.error },
    { key: 'results', label: '賽果', count: results.value, latest: latestResult.value, history: grade(results.value as number, lastMeet, results.error), auto: autoGrade(pick(DB_REPO, WF.meetings)), workflows: WF.meetings, error: results.error },
    { key: 'horses', label: '馬匹', count: horses.value, latest: null, history: grade(horses.value as number, lastMeet, horses.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: horses.error },
    { key: 'jockeys', label: '騎師', count: jockeys.value, latest: null, history: grade(jockeys.value as number, lastMeet, jockeys.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: jockeys.error },
    { key: 'trainers', label: '練馬師', count: trainers.value, latest: null, history: grade(trainers.value as number, lastMeet, trainers.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: trainers.error },
    { key: 'trackwork', label: '晨操', count: trackwork.value, latest: null, history: grade(trackwork.value as number, lastMeet, trackwork.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: trackwork.error },
    { key: 'injury', label: '傷患', count: injury.value, latest: null, history: grade(injury.value as number, lastMeet, injury.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: injury.error },
    { key: 'form', label: '往績', count: form.value, latest: latestForm.value, history: grade(form.value as number, lastMeet, form.error), auto: autoGrade(pick(DB_REPO, WF.pool)), workflows: WF.pool, error: form.error },
    { key: 'entries', label: '排位表', count: entries.value, latest: latestEntries.value, history: grade(entries.value as number, lastMeet, entries.error), auto: autoGrade(pick(DB_REPO, WF.entries)), workflows: WF.entries, error: entries.error },
    { key: 'odds', label: '賠率', count: odds.value, latest: null, history: grade(odds.value as number, lastMeet, odds.error), auto: autoGrade(pick(DB_REPO, WF.odds)), workflows: WF.odds, error: odds.error },
    { key: 'engine', label: '引擎 sanity', count: null, latest: null, history: 'ok' as Status, auto: autoGrade(pick(BE_REPO, WF.engine)), workflows: WF.engine },
  ];
  return c.json({
    generatedAt: new Date().toISOString(),
    season,
    lastMeeting: lastMeet,
    quota: rows.some((r) => r.error === 'd1_quota') ? 'd1_free_tier_exhausted' : 'ok',
    rows,
    runs,
  });
});

opsRoutes.get('/', (c) => c.html(`<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>天喜 · 監控</title>
<style>
:root{--bg:#0b0b0b;--card:#161616;--line:#2a2a2a;--ink:#eee;--mute:#9a9a9a;--ok:#3dd68c;--watch:#e6b84c;--fail:#e45757;--gold:#c9a227}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang TC",sans-serif}
header{padding:20px 16px 8px}h1{margin:0;font-size:20px}p.sub{color:var(--mute);margin:6px 0 0}
.nav{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 12px}
.nav a{color:var(--gold);text-decoration:none;border:1px solid #3a3014;background:#1a160c;padding:6px 10px;border-radius:999px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0 12px 16px}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.card h2{margin:0 0 8px;font-size:13px;color:var(--mute);font-weight:600;letter-spacing:.04em}
.k{font-size:22px;font-weight:700}.s{color:var(--mute);font-size:12px;margin-top:4px}
.wrap{margin:0 12px 24px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:auto}
table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;white-space:nowrap}
th{color:var(--mute);font-size:11px}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.ok{background:#123d2a;color:var(--ok)}.watch{background:#3d3412;color:var(--watch)}.fail{background:#3d1212;color:var(--fail)}
ol.picks{margin:0;padding-left:18px}ol.picks li{margin:4px 0}
</style></head><body>
<header><h1>天喜 · 監控</h1><p class="sub">只讀覆蓋台 · 唔使密鑰 · 舊控制台寫入仍在 /admin</p></header>
<div class="nav">
  <a href="https://www.tianxi.racing/dashboard/">儀表板</a>
  <a href="https://www.tianxi.racing/strategy-pnl/">策略盈虧</a>
  <a href="https://www.tianxi.racing/prediction-vs-result/">預測與賽果</a>
  <a href="https://www.tianxi.racing/engine/">引擎健康</a>
</div>
<div class="grid" id="kpis">
  <div class="card"><h2>賽季</h2><div class="k" id="season">…</div><div class="s" id="seasonSub"></div></div>
  <div class="card"><h2>最後賽日</h2><div class="k" id="lastMeet">…</div><div class="s" id="lastMeetSub"></div></div>
  <div class="card"><h2>策略累計淨盈虧</h2><div class="k" id="pnl">…</div><div class="s" id="pnlSub"></div></div>
  <div class="card"><h2>最後一日三甲命中</h2><div class="k" id="hit">…</div><div class="s" id="hitSub"></div></div>
</div>
<div class="card" style="margin:0 12px 16px"><h2>最後賽日 · 每場首選</h2><ol class="picks" id="picks"><li>載入中…</li></ol></div>
<div class="wrap"><table><thead><tr><th>項目</th><th>歷史</th><th>自動</th><th>行數</th><th>最新</th><th>workflow</th></tr></thead><tbody id="body"></tbody></table></div>
<script>
const S={ok:'PASS',watch:'WATCH',fail:'FAIL'};
const $ = id => document.getElementById(id);
function money(n){return (n<0?'-':'')+'$'+Math.abs(Math.round(n)).toLocaleString();}
Promise.all([
  fetch('/ops/api/coverage').then(r=>r.json()),
  fetch('/api/analyze/strategy-pnl').then(r=>r.json()).catch(()=>null),
  fetch('/api/analyze/today-picks').then(r=>r.json()).catch(()=>null),
]).then(([cov,pnl,picks])=>{
  const sea=cov.season||{};
  $('season').textContent = sea.status==='off_season'?'休季中':'賽季進行中';
  $('seasonSub').textContent = (sea.reason||'') + (cov.quota==='d1_free_tier_exhausted'?' · D1 額已滿':'');
  $('lastMeet').textContent = cov.lastMeeting || '—';
  $('lastMeetSub').textContent = 'gap '+(sea.gapDays??'—')+' 日';
  if(pnl && pnl.totalNet!=null){
    $('pnl').textContent = money(pnl.totalNet)+' · ROI '+(pnl.roiPct??0)+'%';
    $('pnlSub').textContent = (pnl.from||'')+' → '+(pnl.to||'')+' · '+(pnl.daysEvaluated||0)+'日 / '+(pnl.racesBet||0)+'場';
  } else $('pnl').textContent='—';
  const date = picks && picks.date ? picks.date : cov.lastMeeting;
  if(date){
    fetch('/api/analyze/hit-rate?date='+date).then(r=>r.json()).then(h=>{
      const s=h.summary||{};
      $('hit').textContent = (s.top3AnyHitRate??'—')+'%';
      $('hitSub').textContent = date+' · 獨贏 '+(s.top1HitRate??'—')+'% · 頭四平均 '+(s.top4AvgIntersect??'—');
    }).catch(()=>{});
  }
  if(picks && picks.races){
    $('picks').innerHTML = picks.races.map(r=>{
      const p=(r.picks||[])[0];
      return '<li>第'+r.raceNumber+'場 '+(p?(p.horseNumber+'. '+(p.nameCh||p.nameEn)):'—')+'</li>';
    }).join('');
  } else $('picks').innerHTML = '<li>休季無新賽日，顯示最後一場歷史精選</li>';
  $('body').innerHTML = (cov.rows||[]).map(r=>
    '<tr><td>'+r.label+'</td><td><span class="chip '+r.history+'">'+S[r.history]+'</span></td><td><span class="chip '+r.auto+'">'+S[r.auto]+'</span></td><td>'+(r.count??'—')+'</td><td>'+(r.latest||'—')+'</td><td>'+(r.workflows||[]).join(' · ')+'</td></tr>'
  ).join('');
}).catch(()=>{ $('season').textContent='讀唔到'; });
</script></body></html>`);
