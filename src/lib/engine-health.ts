/** Shared TX-Oracle health payload. Served at GET /api/analyze/engine-health */
import type { Env } from '../types';
import { getSeasonStatus, type SeasonStatus } from './season';

export type CheckStatus = 'PASS' | 'WATCH' | 'FAIL';
export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** 結構約束（人手審核，改動時更新 constraintsAuditedHKT） */
export const ENGINE_CONSTRAINTS = {
  objective: 'lambdarank',
  earlyStopMetric: 'race_logloss',
  numLeaves: 8,
  learningRate: 0.01,
  minDataInLeaf: 80,
  maxDepth: 4,
  featureFraction: 0.7,
  baggingFraction: 0.7,
  lambdaL2: 1,
  liveOddsInLgb: false,
  frameLabel: true,
} as const;

const CONSTRAINTS_AUDITED_HKT = '2026-09-02 18:20 HKT';

/** 已批鎖點規格 vs 程式實際落地（唔一致就寫明，唔准當一致） */
export const LOCK_POLICY = {
  specified: 'T−1.5h（第一場開跑前 1.5 小時鎖死全日四擇）',
  implemented: '該賽日第一場賽果入庫後凍結（dateHasSettledResults）',
  aligned: false,
  publicRule: '未凍結一律標「初版」；只有 frozen=true 先算最終版，戰績只計最終版。',
} as const;

function hktStamp(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  return `${t.substring(0, 10)} ${t.substring(11, 16)} HKT`;
}

function baseChecks(): HealthCheck[] {
  return [
    { id: 'ltr', label: '排序學習 LambdaRank', status: 'PASS', detail: '整場 listwise，唔預測完賽時間。' },
    { id: 'labels', label: 'Frame 名次標籤（頭四）', status: 'PASS', detail: '頭四有分級權重，唔再只放大冠軍。' },
    { id: 'noleak_odds', label: '臨場盤不入 LGB', status: 'PASS', detail: '只 overlay 選馬頁右欄。' },
    { id: 'asof', label: '特徵 as-of／無洩漏', status: 'PASS', detail: 'τ／α 每次 refit 前鎖定 as-of 特徵。' },
    { id: 'gate_alpha', label: 'α 自癒健康閘', status: 'PASS', detail: 'FAIL → α=0 純 Elo。' },
    { id: 'fail_closed', label: '異常 fail-closed', status: 'PASS', detail: 'diagnostics 壞唔 crash。' },
    { id: 'season', label: '季節自動感應', status: 'PASS', detail: '' },
    { id: 'elo_v12', label: 'Elo v12 獨立後備', status: 'PASS', detail: '馬 0.7／騎 0.2／練 0.1。' },
    { id: 'public_record', label: '公開戰績可核對', status: 'PASS', detail: 'hit-rate API。只對最終版四擇。' },
    { id: 'public_freeze', label: '公開預測凍結', status: 'WATCH', detail: '' },
    { id: 'reg_leaf', label: '每葉最少樣本', status: 'PASS', detail: 'min_data_in_leaf=80。' },
    { id: 'reg_bag', label: '樹深／抽特徵／抽樣本', status: 'PASS', detail: 'max_depth=4 · feature/bagging 0.7 · λ2=1。' },
    { id: 'backfill_metric', label: '回填與直播同一約束', status: 'PASS', detail: `leaves/lr/min_leaf/early_stop/depth/bagging 對齊（人手審核 ${CONSTRAINTS_AUDITED_HKT}）。` },
    { id: 'diag_persist', label: '健康檔公開落地', status: 'WATCH', detail: '' },
    { id: 'live_curve', label: '當日 live 曲線', status: 'WATCH', detail: '' },
  ];
}

interface LatestLog {
  date: string | null;
  rows: number;
  lgbRows: number;
  alpha: number | null;
}

async function latestPredictionLog(db: Env['DB']): Promise<LatestLog> {
  const empty: LatestLog = { date: null, rows: 0, lgbRows: 0, alpha: null };
  try {
    const last = await db
      .prepare(`SELECT MAX(date) AS d FROM prediction_log WHERE engine = 'v12' AND variant = 'baseline'`)
      .first<{ d: string | null }>();
    const date = last?.d ?? null;
    if (!date) return empty;
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS rows_n,
                SUM(CASE WHEN lgb_score IS NOT NULL THEN 1 ELSE 0 END) AS lgb_n,
                MAX(score_source) AS src
           FROM prediction_log
          WHERE date = ? AND engine = 'v12' AND variant = 'baseline'`,
      )
      .bind(date)
      .first<{ rows_n: number; lgb_n: number; src: string | null }>();
    const m = String(agg?.src ?? '').match(/(?:alpha|α)\s*[=:]?\s*([0-9]*\.?[0-9]+)/i);
    return {
      date,
      rows: Number(agg?.rows_n ?? 0),
      lgbRows: Number(agg?.lgb_n ?? 0),
      alpha: m ? Number(m[1]) : null,
    };
  } catch {
    return empty;
  }
}

export interface EngineHealth {
  schemaVersion: number;
  generatedHKT: string;
  engine: string;
  season: SeasonStatus & { label: string };
  overall: CheckStatus;
  summary: string;
  counts: { pass: number; watch: number; fail: number };
  constraintsLive: typeof ENGINE_CONSTRAINTS;
  constraintsAuditedHKT: string;
  lockPolicy: typeof LOCK_POLICY;
  latestFrozenDay: LatestLog;
  checks: HealthCheck[];
}

/** 即時組健康 payload：季節讀 getSeasonStatus，live 曲線／健康檔讀最近凍結日，唔用寫死常數。 */
export async function buildEngineHealth(db: Env['DB']): Promise<EngineHealth> {
  const season = await getSeasonStatus(db).catch(() => null);
  const log = await latestPredictionLog(db);
  const checks = baseChecks();
  const set = (id: string, status: CheckStatus, detail: string) => {
    const c = checks.find((x) => x.id === id);
    if (c) {
      c.status = status;
      c.detail = detail;
    }
  };

  if (season) {
    set(
      'season',
      'PASS',
      `${season.status === 'in_season' ? '賽季進行中' : '休季中'}（mode=${season.mode}）· 上仗 ${season.lastMeeting ?? '—'} · 下場 ${season.nextMeeting ?? '—'}${season.gapDays != null ? ` · gap ${season.gapDays} 日` : ''}。`,
    );
  } else {
    set('season', 'WATCH', '季節感應查詢失敗，fail-closed 當休季處理。');
  }

  if (log.date && log.lgbRows > 0) {
    set(
      'live_curve',
      'PASS',
      `最近凍結賽日 ${log.date}：${log.rows} 匹入帳、${log.lgbRows} 匹有 LGB 分${log.alpha != null ? `、α=${log.alpha}` : ''}。`,
    );
    set('diag_persist', 'PASS', `健康檔即時由 DB 組成（季節 + ${log.date} 凍結日診斷），唔再讀寫死常數。`);
  } else if (log.date) {
    set('live_curve', 'WATCH', `最近凍結賽日 ${log.date} 只有 Elo 分，未見當日 LGB 曲線。`);
    set('diag_persist', 'WATCH', `健康檔即時組成，但 ${log.date} 缺 LGB 診斷欄。`);
  } else {
    set('live_curve', 'WATCH', '未見任何凍結賽日紀錄（prediction_log 空或查詢失敗）。');
    set('diag_persist', 'WATCH', '健康檔即時組成，但未讀到凍結日診斷。');
  }

  set(
    'public_freeze',
    LOCK_POLICY.aligned ? 'PASS' : 'WATCH',
    `規格 ${LOCK_POLICY.specified}；程式現時 ${LOCK_POLICY.implemented}。兩者未對齊，開跑到入庫呢段公開四擇仍會跟 live 漂移，故公開頁一律標「初版」直到 frozen=true。`,
  );

  const counts = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    watch: checks.filter((c) => c.status === 'WATCH').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
  };
  const overall: CheckStatus = counts.fail ? 'FAIL' : counts.watch ? 'WATCH' : 'PASS';

  return {
    schemaVersion: 3,
    generatedHKT: hktStamp(),
    engine: 'TX-Oracle v3.2',
    season: {
      ...(season ?? {
        status: 'off_season',
        mode: 'auto',
        today: new Date().toISOString().substring(0, 10),
        lastMeeting: null,
        nextMeeting: null,
        gapDays: null,
        reason: 'season query failed',
      }),
      label: season?.status === 'in_season' ? '賽季進行中' : '休季中',
    },
    overall,
    summary:
      '結構閘通過，臨場盤不入 LGB。季節、live 曲線、健康檔三項即時讀 DB。' +
      (LOCK_POLICY.aligned ? '' : ' 鎖點規格（T−1.5h）同程式落地（第一場賽果入庫）未對齊，未凍結一律標初版。'),
    counts,
    constraintsLive: ENGINE_CONSTRAINTS,
    constraintsAuditedHKT: CONSTRAINTS_AUDITED_HKT,
    lockPolicy: LOCK_POLICY,
    latestFrozenDay: log,
    checks,
  };
}

export function engineHealthHtml(d: EngineHealth): string {
  const rows = d.checks
    .map((c) => `<tr><td class="${c.status}">${c.status}</td><td>${c.label}</td><td>${c.detail}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TX-Oracle 引擎健康</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC",sans-serif;background:#111;color:#eee;margin:0;padding:24px}
h1{font-size:22px;margin:0 0 8px}
.sub{color:#aaa;font-size:13px;line-height:1.5;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid #333;padding:8px 6px;text-align:left;vertical-align:top}
.PASS{color:#3dd68c;font-weight:700}
.WATCH{color:#e6b325;font-weight:700}
.FAIL{color:#ef6b6b;font-weight:700}
a{color:#e6b325}
.ed{display:inline-block;font-weight:800;font-size:11px;letter-spacing:.08em;padding:2px 8px;border-radius:99px;border:1px solid #555;margin-right:6px}
.ed.final{color:#2E2108;border-color:#A07A1F;background:linear-gradient(180deg,#FFF4C2,#EBC964)}
.ed.draft{color:#aaa}
ol{margin:8px 0 16px;padding-left:20px;color:#ccc;font-size:13px;line-height:1.65}
</style></head><body>
<h1>TX-Oracle v3.2 健康守門</h1>
<p class="sub">總評 <b>${d.overall}</b> · PASS ${d.counts.pass} · WATCH ${d.counts.watch} · FAIL ${d.counts.fail} · ${d.generatedHKT}<br>${d.summary}</p>
<p class="sub">季節：<b>${d.season.label}</b> · 上仗 ${d.season.lastMeeting ?? '—'} · 下場 ${d.season.nextMeeting ?? '—'} · mode ${d.season.mode}</p>
<h2 style="font-size:16px;margin:18px 0 6px">運作模式 · 初版／最終版</h2>
<p class="sub"><span class="ed draft">初版</span>未鎖，刷新可改四擇　　<span class="ed final">最終版</span>已鎖，對賬同卡同一套</p>
<ol>
<li>公開四擇只有一套帳：已完場一律讀 prediction_log／hit-rate，唔用 live 重算。</li>
<li>已批規格：${d.lockPolicy.specified}。</li>
<li>程式現時落地：${d.lockPolicy.implemented}。</li>
<li>兩者${d.lockPolicy.aligned ? '已對齊' : '未對齊'}——${d.lockPolicy.publicRule}</li>
<li>命中率、賽果頁、監控、賽後卡必須顯示同一套最終版；live LGB 只留研究路徑。</li>
</ol>
<table><thead><tr><th>狀態</th><th>檢查</th><th>說明</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub">JSON：<a href="/api/analyze/engine-health">/api/analyze/engine-health</a> · 公開說明：<a href="https://www.tianxi.racing/engine/">/engine/</a></p>
</body></html>`;
}
