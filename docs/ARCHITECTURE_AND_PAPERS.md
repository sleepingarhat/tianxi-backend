# TX-Oracle 架構與論證

公開頁：https://tianxi.racing/engine/ · https://tianxi.racing/engine/monitor.html

## 架構（文字）

香港賽馬會公開賽果與排位進入 tianxi-database。
`dump-features` 只計賽前可得因子。
LightGBM 用 LambdaRank 學同場相對名次。
Elo v12 用馬／騎／練長期實力做獨立後備。
兩套分數各自場內校正後，按 α 混合。
每個賽馬日自動跑健康閘：通過先用混合，失敗只出 Elo。
臨場獨贏賠率只出現在選馬頁右欄，永不進入排序模型。

```
p_LGB = softmax(LGB / τ_lgb)
p_Elo = softmax(z(Elo+factor) / τ_elo)
p     = α · p_LGB + (1-α) · p_Elo
閘 FAIL ⇒ α = 0
```

## 採納同拒絕

| 文獻／主張 | 採納 | 拒絕 |
|---|---|---|
| 2025 韓馬事會 Learning-to-Rank | listwise LambdaRank | 以為 CatBoost NDCG 高就要換產線 |
| 2024–25 集成＋自動投注 | 戰績對準框中同賠率 | 117 特徵 + TabNet 一次堆疊 |
| 2026 場地／環境非線性 | 分場、欄位、走地 | 無 as-of 溫濕就上氣候模型 |
| 2025 特徵四梯隊 | 近況、分段、負磅、間隔、血統 | 無覆蓋的傷患／操練直接入模 |
| LGB 高雜訊調參 | 樹深、min_leaf、bagging、early-stop | Dropout／圖像增強 |
| 市場欄獨贏最強 | 賠率只做 UI；比較用頭四框 | 用獨贏命中吹模型 |

## Replica 核實（2026-09-01，1485 場，唔係產線權重）

- 舊參數 train NDCG@1 0.65 vs valid 0.24
- 只收緊參數：top1 .195→.204，兩季同向
- EC + trip + frame：頭四框 2.08 隻／場，兩季 top1 .220 / .217
- 未批准前唔 merge
