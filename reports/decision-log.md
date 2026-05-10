# 預測引擎決策日誌

  ## 2026-05-09 · R4 決議：採納純 ELO 為生產 baseline

  ### 30日 walk-forward backtest (8 賽日 / 72 場) 最終結論

  | 配置 | Top1 命中 | Top3 任一 | 平均交集 |
  |---|---|---|---|
  | **純 ELO** ⭐ | **20.8%** | **79.2%** | 1.10 |
  | ELO + 奇門(0.3) | 19.4% | 72.2% | 1.01 |
  | ELO + 梅花(0.5) | 18.1% | 72.2% | 1.01 |
  | ELO + 奇門 + 梅花 | 19.4% | 73.6% | 0.99 |
  | 純梅花 v1 (筆畫) | 12.5% | 68.1% | 0.90 |
  | 純梅花 v2 (取象) | 9.7% | 70.8% | 0.90 |
  | 純梅花 v3 (字典+加權) | 8.3% | 68.1% | 0.82 |
  | 純奇門 | ~3% | ~30% | <0.5 |

  ### 核心發現

  1. **純 ELO 同時最高 Top1 (20.8%) + 最高 Top3 任一 (79.2%)** — 加任何 weight 嘅奇門/梅花都令兩個指標一齊跌。
  2. **梅花字典擴張 + 加權反而傷害準確率** — HK 馬名「吉祥字」selection bias 令越 optimize 越偏離市場真相。
  3. **奇門/梅花 score 同 ELO 反向相關** — 佢哋偏向「冷馬吉象」，dilute ELO 嘅熱門 prior。

  ### 生產配置 (生效中, 已驗證)

  - `/api/analyze/top-picks` 用 `computeComposite` → **純 ELO + factor bonus** (horse/jockey/trainer Bayesian Elo)
  - `/api/analyze/today-picks` 返回 `baseline` payload (純 ELO)，picks 唔會帶 `qimenScore`/`meihuaScore`
  - 奇門 / 梅花 仍喺 `prediction_log` 寫 A/B variant，**只作 telemetry**，不影響回傳畀用戶嘅 ranking
  - 梅花已 revert 至 v1 筆畫版本 (Top1 12.5% — 純梅花最佳，但仍遜於純 ELO)
  - 獨立純測 endpoint `/qimen-only-day`、`/meihua-only-day`、`/ensemble-only-range` 保留作研究用

  ### 後續方向 (deferred)

  - ❌ R5 賠率動態 — 暫不立即做，等 ELO 純 baseline 穩定後再評估
  - ❌ R6 stacking model — 樣本量 (72 場) 太少，學唔出 meaningful weights
  - ✅ 重點：擴大 backtest 樣本（90+ 日），驗證 20.8% Top1 唔係 luck
  