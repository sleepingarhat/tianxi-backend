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
| WATCH | 公開預測凍結 | 規格 T−1.5h 鎖全日；程式現時係第一場賽果入庫後凍。未對齊，未凍結一律標初版 |
| PASS | min_data_in_leaf=80 | 已改生產預設 |
| PASS | max_depth=4 · bagging 0.7 | 已改生產預設 |
| PASS | live／backfill 約束對齊 | 同一套正規化 |
| 即時 | 當日 diagnostics | 由最近凍結賽日 prediction_log 讀 LGB 匹數／α |
| 即時 | live 訓練曲線 | 賽季旗同曲線一律讀 DB，唔再用寫死常數 |

公開 API：`GET https://tianxi-backend.tianxi-entertainment.workers.dev/api/analyze/engine-health`（主站代理：`GET https://tianxi.racing/api/public/engine-health`；`?format=html` 出人讀版）  
監控頁：`/admin/engine-health`  
用戶端：https://tianxi.racing/engine/ · 儀表板 · 選馬頁
