/** Shared TX-Oracle health payload. Served at GET /api/analyze/engine-health */
export const ENGINE_HEALTH = {
  schemaVersion: 2,
  generatedHKT: '2026-09-02 18:20 HKT',
  engine: 'TX-Oracle v3.2',
  season: {
    status: 'off_season',
    lastMeeting: '2026-07-15',
    nextMeeting: null,
    label: '休季中',
  },
  overall: 'WATCH',
  summary:
    '結構閘通過。已對齊 live／backfill 正規化參數與 frame label。休季無當日 live 曲線，故總評仍係 WATCH。臨場盤不入 LGB。',
  counts: { pass: 13, watch: 2, fail: 0 },
  constraintsLive: {
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
  },
  checks: [
    { id: 'ltr', label: '排序學習 LambdaRank', status: 'PASS', detail: '整場 listwise，唔預測完賽時間。' },
    { id: 'labels', label: 'Frame 名次標籤（頭四）', status: 'PASS', detail: '頭四有分級權重，唔再只放大冠軍。' },
    { id: 'noleak_odds', label: '臨場盤不入 LGB', status: 'PASS', detail: '只 overlay 選馬頁右欄。' },
    { id: 'asof', label: '特徵 as-of／無洩漏', status: 'PASS', detail: 'τ／α 嗚 refit 前鎖定。' },
    { id: 'gate_alpha', label: 'α 自癒健康閘', status: 'PASS', detail: 'FAIL → α=0 純 Elo。' },
    { id: 'fail_closed', label: '異常 fail-closed', status: 'PASS', detail: 'diagnostics 壞唔 crash。' },
    { id: 'season', label: '休季自動暫停', status: 'PASS', detail: '上仗 2026-07-15。' },
    { id: 'elo_v12', label: 'Elo v12 獨立後備', status: 'PASS', detail: '馬 0.7／騎 0.2／練 0.1。' },
    { id: 'public_record', label: '公開戰績可核對', status: 'PASS', detail: 'hit-rate API。只對最終版四擇。' },
    { id: 'public_freeze', label: '公開預測凍結', status: 'PASS', detail: '完場後日用 prediction_log；賽果／卡／監控同一套最終版。T−1.5h 鎖係已批規格。' },
    { id: 'reg_leaf', label: '每葉最少樣本', status: 'PASS', detail: 'min_data_in_leaf=80。' },
    { id: 'reg_bag', label: '樹深／抽特徵／抽樣本', status: 'PASS', detail: 'max_depth=4 · feature/bagging 0.7 · λ2=1。' },
    { id: 'backfill_metric', label: '回填與直播同一約束', status: 'PASS', detail: 'leaves/lr/min_leaf/early_stop/depth/bagging 對齊。' },
    { id: 'diag_persist', label: '健康檔公開落地', status: 'WATCH', detail: '本 API + README 清單已落地；開季後寫入當日 best_iter／τ／α。' },
    { id: 'offseason_live', label: '當日 live 曲線', status: 'WATCH', detail: '休季無新賽日重訓。' },
  ],
} as const;

export function engineHealthHtml(): string {
  const d = ENGINE_HEALTH;
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
<h2 style="font-size:16px;margin:18px 0 6px">運作模式 · 初版／最終版</h2>
<p class="sub"><span class="ed draft">初版</span>未鎖，刷新可改四擇　　<span class="ed final">最終版</span>已鎖，對賬同卡同一套</p>
<ol>
<li>公開四擇只有一套帳：已完場一律讀 prediction_log／hit-rate，唔用 live 重算。</li>
<li>鎖係全日跟第一場。規格：第一場開跑前 1.5 小時鎖死整日四擇。</li>
<li>出卡跟鎖：T−1.5h 鎖完先出卡，目標 T−1h 發佈最終版。</li>
<li>而家程式已落地嘅鎖點：該賽日第一場賽果入庫後凍結。T−1.5h 鎖係已批規格。</li>
<li>命中率、賽果頁、監控、賽後卡必須顯示同一套最終版；live LGB 只留研究路徑。</li>
</ol>
<table><thead><tr><th>狀態</th><th>檢查</th><th>說明</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub">JSON：<a href="/api/analyze/engine-health">/api/analyze/engine-health</a> · 公開說明：<a href="https://www.tianxi.racing/engine/">/engine/</a></p>
</body></html>`;
}
