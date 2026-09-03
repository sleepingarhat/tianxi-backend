# 預測凍結 SSOT

Live LGB／ensemble 可以因後續賽果重算而漂移，呢個係研究路徑，唔係對外預測。

已完場（`race_results.finishing_position > 0`）嘅香港賽日，公開四撿只准來自 `prediction_log`（variant=`baseline`）。

| 入口 | 完場後 |
|---|---|
| `/api/analyze/hit-rate` | 讀凍結 log；cache 同 log 四撿唔符就重算覆蓋 cache |
| `/api/analyze/top-picks` | overlay `prediction_log`，禁止 live `computeComposite` 排名 |
| `/api/analyze/today-picks` | 讀／重算後 overlay 凍結 |
| `/api/analyze/picks-by-date` | 同上 |
| `/api/analyze/explain` | 公開 rank／pWin／pTop3／pTop4 用凍結值 |
| 賽果頁／Telegram 卡 | 只用 hit-rate `predictedTop4` |

對賬：`GET /api/analyze/prediction-lock?date=YYYY-MM-DD`  
Cron 每日核對最近一個已完場賽日；mismatch 寫 worker log `[prediction-lock] MISMATCH`。
