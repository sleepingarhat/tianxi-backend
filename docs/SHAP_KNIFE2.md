# 賽馬第二刀 · TreeSHAP（研究軌）

第一刀：覆蓋（`/explain`）已上線。
第二刀：同一版凍結 LGB booster 計 TreeSHAP，先落 `reports/shap/`，**不寫凍結、不改四擁、不上今晚預測卡**。

## 硪2口

- `method`: TreeSHAP（`shap.TreeExplainer`），解釋 LambdaRank **score**，唔解釋 Elo 軌、唔解釋 α 混合。
- 必須輸入：當日鎖定所用同一份 `lgb.txt` + `dump-features` 同版特徵。
- 輸出 JSON：`fingerprint`、`global_mean_abs`、`per_runner`（top 正／負 8 個因子）。
- 字眼：「LGB 軌貢獻」；禁止「勝出原因」。
- 缺 booster 或缺同版特徵 → `status=blocked`，前端仍不顯示紅綠。

跑法：`python scripts/backtest/shap_knife2.py --booster PATH --features PATH --out reports/shap/latest.json`
