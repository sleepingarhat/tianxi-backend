# TX-Oracle 引擎健康 · passing 列表

_Generated 2026-09-02 18:20 HKT_

呢份報告放喺倉庫**根目錄**，對齊 [tianxi-database/reports/SANITY.md](https://github.com/sleepingarhat/tianxi-database/blob/main/reports/SANITY.md)。

**總評：WATCH** — 13 PASS · 2 WATCH · 0 FAIL · 休季（上仗 2026-07-15）

| 狀態 | 檢查 | 說明 |
|---|---|---|
| PASS | LambdaRank listwise | 唔預測完賽時間 |
| PASS | Frame 名次標籤（頭四） | 頭四有分級權重 |
| PASS | 臨場盤不入 LGB | 只 overlay UI |
| PASS | 特徵 as-of／無洩漏 | τ／α refit 前鎖定 |
| PASS | α 自癒閘 | FAIL → 純 Elo |
| PASS | 異常 fail-closed | 唔 crash |
| PASS | 休季自動暫停 | `/api/season` |
| PASS | Elo v12 後備 | 馬 0.7／騎 0.2／練 0.1 |
| PASS | 公開戰績 | hit-rate API |
| PASS | 公開預測凍結 | 完場後日用 prediction_log；HTTP overlay + hit-rate SSOT |
| PASS | min_data_in_leaf=80 | 已改生產預設 |
| PASS | max_depth=4 · bagging 0.7 | 已改生產預設 |
| PASS | live／backfill 約束對齊 | 同一套正規化 |
| WATCH | 當日 diagnostics | 開季後寫 best_iter／τ／α |
| WATCH | live 訓練曲線 | 休季無新曲線 |

公開 API：`GET https://tianxi.racing/api/analyze/engine-health`  
監控頁：`/admin/engine-health`  
用戶端：https://tianxi.racing/engine/ · 儀表板 · 選馬頁
