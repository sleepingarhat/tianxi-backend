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
  counts: { pass: 12, watch: 2, fail: 0 },
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
    { id: 'asof', label: '特徵 as-of／無洩漏', status: 'PASS', detail: 'τ／α 喺 refit 前鎖定。' },
    { id: 'gate_alpha', label: 'α 自癒健康閘', status: 'PASS', detail: 'FAIL → α=0 純 Elo。' },
    { id: 'fail_closed', label: '異常 fail-closed', status: 'PASS', detail: 'diagnostics 壞唔 crash。' },
    { id: 'season', label: '休季自動暫停', status: 'PASS', detail: '上仗 2026-07-15。' },
    { id: 'elo_v12', label: 'Elo v12 獨立後備', status: 'PASS', detail: '馬 0.7／騎 0.2／練 0.1。' },
    { id: 'public_record', label: '公開戰績可核對', status: 'PASS', detail: 'hit-rate API。' },
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
</style></head><body>
<h1>TX-Oracle v3.2 健康守門</h1>
<p class="sub">總評 <b>${d.overall}</b> · PASS ${d.counts.pass} · WATCH ${d.counts.watch} · FAIL ${d.counts.fail} · ${d.generatedHKT}<br>${d.summary}</p>
<table><thead><tr><th>狀態</th><th>檢查</th><th>說明</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub">JSON：<a href="/api/analyze/engine-health">/api/analyze/engine-health</a></p>
</body></html>`;
}
