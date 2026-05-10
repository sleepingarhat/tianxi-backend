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
  

  ---

  ## 2026-05-10 · 完整 hit-rate 統計 + 8 因子 ablation

  ### 完整命中率 (純 ELO + 8 factors baseline, 8 賽日 / 72 場)

  | 指標 | 命中 | 命中率 | 含義 |
  |---|---|---|---|
  | Top1 | 17/72 | **23.6%** | 預測第1 = 實際冠軍 |
  | Top3 任1 | 63/72 | **87.5%** | 預測前3 至少1隻入實際前3 |
  | Top3 任2 | 19/72 | **26.4%** | 預測前3 至少2隻入實際前3 |
  | Top4 任2 | 37/72 | **51.4%** | 預測前4 至少2隻入實際前3 |
  | Top4 任3 | 2/72 | **2.8%** | 預測前4 中3隻全入實際前3 |

  > ⚠️ `/hit-rate` 用當前 ELO snapshot，可能含同日 leakage。Walk-forward (`/run-backtest`) 嘅 Top1 較保守為 20.8%。

  ### 投注 implication

  | 種類 | 命中率 | break-even Win 賠率 |
  |---|---|---|
  | 獨贏押 #1 | 23.6% (保守 20.8%) | 4.24x (4.81x) |
  | 位置 Q (前2包位) | ≥51.4% | 1.94x |
  | 三 Q.P. (前3任2入位) | 26.4% | 3.79x |
  | 三 T 全中 | 2.8% | 35.7x |

  **甜蜜點：三 Q.P.** — 平均賠率超過 3.79x 即正期望。

  ---

  ### 澄清：「純 ELO baseline」嘅實際組成

  之前措辭含糊。生產 pipeline 實際係 **3 軸 ELO + 8 個 micro-factors**：

  | # | 因子 | 來源 |
  |---|---|---|
  | ELO×3 | horse / jockey / trainer (W=0.7/0.2/0.1) | `batchEloReadings` |
  | 1 | recency 距上次出賽 | `batchLastRaceDate` |
  | 2 | distance 距離適性 | `batchDistanceFit` |
  | 3 | going 場地適性 | `batchGoingFit` |
  | 4 | draw 檔位偏向 (按場館+距離) | `batchDrawBias` |
  | 5 | weight 體重變化 | `batchWeightDelta` |
  | 6 | condition 晨操狀態 | `batchConditionFit` |
  | 7 | injury 傷病標記 | `batchInjuryFlag` |
  | 8 | jtCombo 騎練配對 | `batchJtComboFit` |

  `finalScore = eloComposite × confWeight + Σ factorBonus`

  R4 「純 ELO」= 唔加奇門/梅花，其餘 11 個 signal 全保留。

  ---

  ### 8 因子 Ablation (8 賽日 / 72 場, picks-by-date computed)

  **Baseline 對照:**
  | 配置 | Top1 | T3任1 | T3任2 | T4任2 | T4任3 |
  |---|---|---|---|---|---|
  | ELO + 全 8 因子 (current production) | 18.1% | 84.7% | 37.5% | 55.6% | 5.6% |
  | 純 ELO (0 因子) | 18.1% | 86.1% | 34.7% | 52.8% | 8.3% |

  **Leave-One-Out (移除 1 個因子, vs full baseline):**
  | 移除 | Top1 | T3任1 | T3任2 | T4任2 | T4任3 | ΔTop1 | ΔT3任1 |
  |---|---|---|---|---|---|---|---|
  | recency     | 18.1% | 83.3% | 34.7% | 51.4% | 5.6% | +0.0pp | -1.4pp |
| distance    | 19.4% | 84.7% | 31.9% | 48.6% | 8.3% | +1.4pp | +0.0pp |
| going       | 18.1% | 87.5% | 34.7% | 51.4% | 8.3% | +0.0pp | +2.8pp |
| draw        | 19.4% | 84.7% | 31.9% | 52.8% | 4.2% | +1.4pp | +0.0pp |
| weight      | 15.3% | 86.1% | 34.7% | 51.4% | 6.9% | -2.8pp | +1.4pp |
| condition   | 18.1% | 84.7% | 37.5% | 55.6% | 5.6% | +0.0pp | +0.0pp |
| injury      | 18.1% | 84.7% | 37.5% | 54.2% | 5.6% | +0.0pp | +0.0pp |
| jtCombo     | 18.1% | 87.5% | 31.9% | 54.2% | 1.4% | +0.0pp | +2.8pp |

  **Single-Factor Add (純 ELO + 1 個因子, vs 純 ELO):**
  | 加入 | Top1 | T3任1 | T3任2 | T4任2 | T4任3 | ΔTop1 | ΔT3任1 |
  |---|---|---|---|---|---|---|---|
  | recency     | 22.2% | 86.1% | 34.7% | 50.0% | 5.6% | +4.2pp | +0.0pp |
| distance    | 19.4% | 86.1% | 34.7% | 50.0% | 6.9% | +1.4pp | +0.0pp |
| going       | 19.4% | 83.3% | 33.3% | 50.0% | 8.3% | +1.4pp | -2.8pp |
| draw        | 18.1% | 84.7% | 37.5% | 55.6% | 9.7% | +0.0pp | -1.4pp |
| weight      | 18.1% | 81.9% | 34.7% | 54.2% | 9.7% | +0.0pp | -4.2pp |
| condition   | 18.1% | 86.1% | 34.7% | 52.8% | 8.3% | +0.0pp | +0.0pp |
| injury      | 16.7% | 86.1% | 34.7% | 52.8% | 6.9% | -1.4pp | +0.0pp |
| jtCombo     | 18.1% | 83.3% | 31.9% | 54.2% | 6.9% | +0.0pp | -2.8pp |

  ### Ablation 結論

  1. **8 因子集合 net Top1 = 0** (18.1% with = without)。8 因子合計唔提升 Top1，輕微傷害 T3任1 (-1.4pp)。
  2. **recency 單加最強** (+4.2pp Top1) — 距上次出賽天數係最有預測力嘅 factor。
  3. **weight 移除後 Top1 跌 2.8pp** — 體重變化係必保留嘅 signal。
  4. **going / jtCombo 移除後 T3任1 升 +2.8pp** — 兩者目前係 noise > signal，候選 prune。
  5. **injury / condition 影響近 0** — 因 5/9 普遍「無記錄」(data sparsity)，需先補 data 再評估。

  ### 推薦配置 (待 validate)

  `finalScore = eloComposite + W_recency·recency + W_weight·weight + W_distance·distance + W_draw·draw` (4 因子精簡版)

  候選下一輪 backtest：4-因子精簡 vs 全 8 因子 baseline。

  ---

  ## 2026-05-10 · 5/9 賽果 backfill 狀態

  - 5/9 排位確認 11 場 (R1–R11)，但 D1 `race_results` **只有 R1 (桂花讓賽) 有 finishing_position**
  - 餘下 R2–R11 未 ingest
  - **無 Worker endpoint 可遠端 trigger ingestion** — 流程為本地 CLI:
    1. `scripts/import-csv.ts` 由 `hkjc-data` repo 嘅 `results_YYYY-MM-DD.csv` 寫入本地 `bulk-local.db`
    2. `scripts/push-delta.ts` + `scripts/push-to-d1.sh` 推 delta 上 D1
  - `hkjc-data` repo (sleepingarhat) **404** — 私倉或 repo 名不同
  - **Action required (用戶端)**：
    1. 確認 `hkjc-data` repo 真實位置
    2. 確認 5/9 results CSV 已 scraped
    3. 本地跑 `import-csv → push-delta → push-to-d1.sh`
  - 建議：增設 GitHub Actions cron 自動 ingest 賽後當晚 (sched: race day 23:00 HKT)
  