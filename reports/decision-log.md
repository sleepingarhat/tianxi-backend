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
  

  ## 2026-05-10 · R5 88 賽日 ablation (12 個月 / 853 場) — production 簡化至 ELO + draw + weight

  ### Sample expansion vs R3 (8 賽日 / 72 場)

  | | R3 (8d) | **R5 (88d)** | scale-up |
  |---|---:|---:|---:|
  | 場數 | 72 | **853** | 11.8× |
  | 跨度 | 1 個月 | **12 個月** (2025-05-10 → 2026-05-09) | 12× |

  每場 ablation：保留 picks-by-date 嘅 factorBreakdown + hit-rate 嘅 actualTop3/Top4，本地 rerank `finalScore = eloComposite + Σ(enabled factor bonuses × conf)`。

  ### Top configs (sorted by Top1)

  | Config | Top1 | T3任1 | T3any | QP | Trio | T4 avg | T4≥2 | **T4≥3** |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|
  | ELO + draw + recency | **24.9** | 54.2 | 87.6 | 41.1 | 5.3 | 2.09 | 76.3 | 31.4 |
  | **ELO + draw + weight** ⭐ | **24.5** | 54.3 | 88.0 | 40.7 | **6.1** | **2.13** | **77.8** | **34.5** |
  | ELO + draw | 24.4 | 54.5 | 88.2 | **42.2** | 5.5 | 2.12 | 77.3 | 33.8 |
  | ELO + draw + injury | 24.3 | 54.7 | **88.3** | **42.4** | 5.4 | 2.13 | **78.3** | 33.6 |
  | ELO + recency + weight + draw | 24.2 | 53.7 | 87.6 | 39.3 | 5.6 | 2.10 | 76.2 | 32.8 |
  | pure ELO | 23.0 | 52.6 | 88.3 | 41.4 | 5.4 | 2.10 | 76.6 | 32.4 |
  | **R3 baseline (all 8) — 即 R4 production** | **20.6** | 50.3 | 86.6 | 39.4 | 5.7 | 2.04 | 74.0 | 29.4 |
  | 8 minus draw | 20.4 | 49.4 | 86.2 | 37.4 | 5.9 | 2.03 | 72.9 | 29.7 |

  ### 顛覆 R3 結論嘅 4 大發現

  1. **`draw` 係最強因子** — R3 8 賽日小樣本完全冇睇出。加 draw 一個 +1.4pp Top1，加埋全 8 個反而 -2.4pp。
  2. **8 因子 baseline 過擬合**：Top1 20.6% **遠低過** pure ELO 23.0% (-2.4pp)。R4 production 喺 12 個月真實 sample 下其實**輸畀純 ELO**。
  3. **`recency` / `jtCombo` 邊際效用近零**或負面。R3 sample 太細誤判 recency 為「最強」。
  4. **`weight` 對 Trio / T4 partial 仍有貢獻** (+0.6pp Trio, +0.7pp T4≥3 over ELO+draw)。

  ### 穩定性測試 (88 日切兩半 @ 2025-12-07)

  | Config | 舊半 (n=422) Top1/Trio/T4≥3 | 新半 (n=431) Top1/Trio/T4≥3 | Δ Top1 |
  |---|---|---|---:|
  | ELO+draw | 27.0% / 5.0% / 34.8% | 21.8% / 6.0% / 32.7% | -5.2pp |
  | **ELO+draw+recency** | 26.8% / 5.5% / 32.9% | 23.0% / 5.1% / 29.9% | **-3.8pp** |
  | baseline 8 | 24.2% / 6.2% / 30.1% | 17.2% / 5.3% / 28.8% | -7.0pp (最差) |
  | pure ELO | 24.9% / 5.0% / 32.7% | 21.1% / 5.8% / 32.0% | -3.8pp |

  ### 決定 (production)

  - **採用 `ELO + draw + weight`** 為新 production composite。
  - 目標：贏大錢 → T4≥3 (First4 partial) **34.5%** (vs 舊 baseline 29.4% → **+5.1pp**) 同 Trio **6.1%** (vs 5.7% → +0.4pp) 最大化高賠率彩池命中率。
  - Top1 **24.5%** (vs 舊 20.6% → +3.9pp)，WIN bet 亦同步提升。
  - `recency / distance / going / condition / injury / jtCombo` 保留喺 `factorBreakdown` 作 telemetry，但 **唔加入 finalScore**。
  - 實作改動：`src/routes/analyze.ts` 嘅 `computeComposite` factorBonus 由 8 因子求和改為 `fDraw.bonus + fWeight.bonus`。

  ### Walk-forward caveat

  呢次 sample 用 `/picks-by-date` (用今日 ELO snapshot)，**有 same-day leakage 風險** ~2.8pp。實際生產 Top1 預期 **22%–24%** 區間。

  ### Next

  - Deploy 後觀察 5/13 (下個賽日) 實戰；2-3 個賽日後對比 R4 vs R5。
  - 5/9 R2-R11 賽果 backfill 仍 pending (上游 `capy_race_daily` scraper bug — 11 場全部寫成 race_no=1)。
  

  ---

  ## R5 後續：Code Review (2026-05-10) — 風險澄清同已知問題

  部署 R5 之後做咗系統 code review (architect)，發現幾項要記低：

  ### ✅ 已驗證冇問題
  - **3 個 production patch site 都齊** (L1213 `computeComposite`, L1840 / L1987 `computePicksFromEntries` 兩條 path)，`finalScore = eloComposite + (fDraw.bonus + fWeight.bonus)`
  - **All 8 batch helpers 都用 strict `rm.date < asOf` 過濾** — `batchDrawBias`/`batchWeightDelta`/`batchLastRaceDate`/`batchDistanceFit`/`batchGoingFit`/`batchConditionFit`/`batchInjuryFlag`/`batchJtComboFit` 全部冇時間 leakage
  - **Live verification**: `/picks-by-date` 12/12 + `/top-picks` 1/1 sampled picks 嘅 `factorBonus = fDraw.bonus + fWeight.bonus` 完全一致

  ### ⚠️ 已知問題（未修，留待跟進）

  **HIGH — `/run-backtest` 唔 validate R5 公式**
  - `runBacktestForDate` 嘅 `baseline-bt` lane 寫嘅係 `finalScore = eloComposite, factorBonus = 0`（純 ELO），即係呢個 walk-forward backtester 量度緊嘅唔係 R5 production formula
  - R5 嘅 +3.9pp Top1 / +5.1pp T4≥3 證據純粹來自我本機 88-day in-memory rerank（即 same-day 賽果重 score）
  - 即使 ELO ratings 係 as-of-date 同所有 batch helpers 都 `< asOf`，rerank 嘅 `drawBias`/`weightDelta` 都係 strictly historical，但 prediction_log 入面 R5 lane 並未有獨立 walk-forward 證據
  - **Action**: 建議下一步喺 `runBacktestForDate` 加 `r5` variant，跑 30–60d real walk-forward 確認

  **MEDIUM — Sample-size CI 重疊**
  - 853 races, p=0.245，95% CI ±2.9pp。R5 vs pure ELO 嘅 Top1 +1.5pp 喺 noise band 入面（+5.1pp T4≥3 較 meaningful 但都 ±3pp CI）
  - **Action**: 觀察 5/13 起 30 forward race-days，若未能重現 ≥+2pp Top1 vs pure ELO，考慮 revert 到 pure ELO

  **MEDIUM — API 命名混淆**
  - `factorBreakdown` 仍出 8 個 factor (telemetry)，但 `factorBonus` 只 sum 其中 2 個。下游 (admin UI、prediction_log rolling stats) 容易誤解
  - **Action**: 加 `scoringFormula: 'r5-elo+draw+weight'` field；或 split `factorBreakdown` → `scoring: {draw,weight}` + `telemetry: {…6個}`

  **MEDIUM — `race_day_report_cache` 無 formula version**
  - Cache 表 keyed by `(date, engine)`，無 TTL / formula 版本。若 R5 deploy 之前已 cache，會serve 舊 8-factor payload 直到下次 cron (HKT 06/11/18:00) 重 build
  - **Action**: 加 `formula_version` column，或單次 `DELETE FROM race_day_report_cache` 即時清；現時 5/10 無賽，下次 5/13 cron 已自然 turnover，無逼切性

  **MEDIUM — Draw / weight 同 venue / distance 相關**
  - `fDraw` 已 bucketed by `(venue, distance)`，可能同 ELO 入面已蘊含嘅 venue/distance 信號 double-count
  - Split-half stability test 顯示 `ELO+draw` 由舊半年到新半年 Top1 跌 5.2pp，較 `ELO+draw+recency` (3.8pp) 不穩
  - **Action**: 計 `fDraw.bonus` × `fWeight.bonus` × `eloComposite` × `is_hit_top1` correlation matrix

  **LOW — `_score` 公式 path 不一致 (pre-existing)**
  - `computeComposite` (L1218): `_score = base + winRate*1.2 + factorBonus/100`
  - `computePicksFromEntries` (L1843, L1991): `_score = base + factorBonus/100` (無 winRate term)
  - R5 縮細 factorBonus 後，`top-picks` 入面 `winRate*1.2` 嘅相對權重會放大

  **LOW — `prediction_log` baseline variant 混合公式版本**
  - 同一 `variant='baseline'` 下，pre-R5 同 post-R5 rows formula 不同。Rolling 30-day baseline accuracy 跨 deploy 日會誤導
  - **Action**: 報表加 `WHERE date >= '2026-05-10'` filter；或新 variant `'baseline-r5'`

  ### 結論
  R5 production code 正確同已 live。主要遺留風險：缺少 R5 lane 嘅 real walk-forward 驗證，加上 sample-size CI 重疊。建議 5/13 起跟蹤 forward 30 race-days，同時喺 backtester 加 R5 lane。
  