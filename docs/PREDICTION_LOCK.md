# 預測凍結 SSOT

Live LGB／ensemble 可以因後續賽果重算而漂移。呢個係研究路徑，唔係對外公布嘅預測。

已完場（`race_results.finishing_position > 0`）嘅香港賽日，公開四擁只准來自 `prediction_log`（variant=`baseline`）。戰績、卡、賽果頁、today-picks、top-picks、explain 必須同一套。

## 三層，缺一不可

1. **寫入凍結** — 賽日前／當日 `writePredictionLog` 把當日排名寫入 `prediction_log`。賽後只 join 名次，唔改 predicted_rank。
2. **HTTP 邊界 overlay** — `src/index.ts` 喺 `/top-picks` `/today-picks` `/picks-by-date` `/explain` 回應後，若該日已完場就用 `prediction_log` 覆蓋排名。即使 `analyze.ts` 再 computeComposite，對外都唔會洩漏 live 漂移。
3. **公開 UI 單一讀口** — 已完場頁面（賽果對賬、戰績卡、coverage）只讀 `/hit-rate` 嘅 `predictedTop4`。禁止為完場日再打 N 次 `/top-picks`。

| 入口 | 完場後 |
|---|---|
| `/api/analyze/hit-rate` | 讀凍結 log；cache 同 log 四擁唔符就重算覆蓋 cache |
| `/api/analyze/top-picks` | overlay `prediction_log`，禁止 live `computeComposite` 排名外洩 |
| `/api/analyze/today-picks` | 讀／重算後 overlay 凍結 |
| `/api/analyze/picks-by-date` | 同上 |
| `/api/analyze/explain` | 公開 rank／pWin／pTop3／pTop4 用凍結值 |
| 賽果頁／Telegram 卡 | 只用 hit-rate `predictedTop4` |

對賬：`GET /api/analyze/prediction-lock?date=YYYY-MM-DD`  
Cron 每日核對最近一個已完場賽日；mismatch 寫 worker log `[prediction-lock] MISMATCH`。

回歸：`npm run test:prediction-lock`（CI deploy 必跑）。
