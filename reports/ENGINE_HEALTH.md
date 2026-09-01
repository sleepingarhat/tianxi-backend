# TX-Oracle 引擎健康報告

_Generated 2026-09-01 18:30 HKT · 對齊 tianxi-database `reports/SANITY.md` 格式：逐項 PASS / WATCH / FAIL。_

**總評：WATCH** — 結構閘 9 PASS · 5 WATCH · 0 FAIL。休季中（上仗 2026-07-15）。預測權重未改。

機器可讀：[`engine_health.json`](./engine_health.json)  
用戶端：https://tianxi.racing/engine/  
監控清單：https://tianxi.racing/engine/monitor.html  
論證：[`docs/ARCHITECTURE_AND_PAPERS.md`](../docs/ARCHITECTURE_AND_PAPERS.md)

## 總覽

| 項 | 值 |
|---|---|
| 引擎 | TX-Oracle v3.2 |
| 賽季閘 | off_season |
| 上仗 | 2026-07-15 |
| 臨場盤入 LGB | 否 |
| Live early-stop | race_logloss |
| Live `min_data_in_leaf` | 20（建議升 80，未 merge） |

## 逐項健康

| 狀態 | 檢查 | 說明 |
|---|---|---|
| PASS | 排序學習 LambdaRank | listwise，唔預測完賽時間 |
| PASS | 分級名次標籤（頭五） | 已修 1 棵樹飽和 |
| PASS | 臨場盤不入 LGB | 只 overlay UI |
| PASS | 特徵 as-of／無洩漏 | τ／α 喺 refit 前鎖定 |
| PASS | α 自癒健康閘 | FAIL → 純 Elo |
| PASS | 異常 fail-closed | diagnostics 壞唔 crash |
| PASS | 休季自動暫停 | `/api/season` |
| PASS | Elo v12 獨立後備 | `id LIKE 'v12:%'` |
| PASS | 公開戰績可核對 | hit-rate API |
| WATCH | 每葉最少樣本 | live=20，replica 證實 80 更穩 |
| WATCH | 抽特徵／抽樣本／樹深 | live 未開 |
| WATCH | 回填與直播同一評估 | backfill 仍用 NDCG |
| WATCH | 當日 diagnostics 公開落地 | 本檔為第一版公開落地 |
| WATCH | 當日 live 曲線 | 休季無新曲線 |

## 閘規則（生產 `evaluate_gates`）

1. `best_iteration >= 50`
2. race_logloss 由 iter1 到 best 至少改善 0.05
3. `corr(p_LGB, p_Elo) < 0.95`
4. `τ_lgb`、`τ_elo` ∈ (0.02, 50)
5. `α >= 0.05`
6. 每場預測覆蓋 ≥ 80% 宣佈出馬
7. 以上任一 FAIL → `ensemble_alpha = 0`

## 下一步（未批唔改產線權重）

1. live／backfill 參數指紋對齊
2. 正規化：`max_depth=4` · `min_data_in_leaf=80` · bagging 0.7
3. 開季後把當日 diagnostics 寫回本 JSON
