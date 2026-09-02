# TX-Oracle 架構與論證

公開頁：https://tianxi.racing/engine/

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

## 採納同拒絕（有來源）

| 文獻／主張 | 來源 | 採納 | 拒絕 |
|---|---|---|---|
| 2025 韓馬事會 LTR：listwise LambdaRank；CatBoost NDCG 高但實打 LightGBM/XGBoost 命中更高 | So / Woo / Lee, J. Korea Soc. Comput. Inf., 2025-11. [KCI ART003266151](https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART003266151) | listwise LambdaRank；用實打命中而不是單 NDCG 決產線 | 因 CatBoost NDCG 0.8895 就換產線 |
| 近況、平均名次、負磅、歲齡為重要因子 | 同上，feature importance | 作為下一輪 as-of 迴形的候選 | 無覆蓋傷患／晨操直接入模 |
| LGB 高雜訊要淺樹、大 leaf、bagging、early-stop | LightGBM 調參常規；replica 2026-09-01 | min_data_in_leaf=80、max_depth=4、bagging 0.7 已在產 | Dropout／圖像增強 |
| 市場欄獨贏強 | 賽馬會獨贏池反映公眾資訊 | 賠率只作 UI；比較用頭四框 | 用獨贏命中吹模型 |

CatBoost 換產、dump-features 重跑 EC 變體：**仍未批 merge**。

## Replica 核實（2026-09-01，1485 場，唔係產線權重）

- 舊參數 train NDCG@1 0.65 vs valid 0.24
- 只收緊參數：top1 .195→.204，兩季同向
- EC + trip + frame：頭四框 2.08 隻／場，兩季 top1 .220 / .217
- 未批准前唔 merge
