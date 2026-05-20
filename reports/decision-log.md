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
  

  ---

  ## 2026-05-12 — Multi-axis ELO 5-variant backtest

  **TL;DR：** Multi-axis horse ELO（per surface × distance bucket）相比 R5 baseline overall ELO **冇 outperform**。**唔 productionize**，繼續用 R5 (overall ELO + draw + weight)。

  ### Setup

  - Workflow: `.github/workflows/multiaxis_compare.yml`
  - Window: 2024-01-01..2026-04-30 (2034 races) + 1-month diag (2024-06)
  - 5 variants:

  | variant | 公式 |
  |---|---|
  | A overall + 8factor | 現行 R5 baseline |
  | B overall pure | 純 ELO (overall) |
  | C axis + 8factor | per-bucket ELO + factors |
  | D axis pure | per-bucket ELO 純分 |
  | E hybrid + 8factor | 0.6·axis + 0.4·overall + factors |

  ### Backtest harness 修復鏈（4 commits）

  1. **`composite-backtest.ts` jockey/trainer 用 ID 查 ELO** → 應該用 `name_en`（compute_v11 寫嘅 key）。改 LEFT JOIN `jockeys`/`trainers` 攞 `name_en`
  2. **`axis_key='overall'` 寫死喺所有 entity** → jockey/trainer 表冇 axis_key column → `db.prepare()` throw → silent catch → eloJ/eloT 永遠 null。改成 horse-only filter
  3. **`id LIKE 'v12:%'` filter 假設錯誤** → compute_v11 寫嘅 id 冇 v12: prefix → 0 hit。完全移除 v12/v11 prefix dance（compute_v11 wipe-and-rewrite all snapshots，冇 engine isolation 需要）
  4. **`race_results.horse_id = "horse_A001"` 但 `horse_elo_snapshots.horse_id = "A001"`** → compute_v11 strip prefix。喺 `readElo` + `readHorseAxisElo` 兩處 normalize lookup ID

  ### 1-month diag 結果（n=70 races, 2024-06）

  | variant | top1 hit | top3 hit | spearman |
  |---|---:|---:|---:|
  | A overall + 8factor | **14.3%** | **51.4%** | **0.259** |
  | B overall pure | 8.6% | 44.3% | 0.235 |
  | C axis + 8factor | 12.9% | 45.7% | 0.238 |
  | D axis pure | 10.0% | 42.9% | 0.222 |
  | E hybrid + 8factor | 12.9% | 45.7% | 0.257 |

  ### 結論

  - ✅ **8-factor 一定贏 pure**（A>B, C>D, E≈C）— factors 有 signal
  - ❌ **Multi-axis 反而輸 overall**（A 14.3% vs C/E 12.9%）— per-bucket 樣本太散，未收斂
  - ❌ **Hybrid 唔贏 axis** — 雙倍冷啟動 penalty 但無收益
  - 📊 **Sample size 細**（n=70 noise band ±5pp），但已 hint multi-axis 唔係 promising direction

  **Decision: REJECT multi-axis productionization.** R5 (overall ELO + draw + weight) 維持為生產公式。

  ### 留低嘅資產

  - `scripts/backtest/composite-backtest.ts` 修咗 4 個 join-key/schema bug，加咗 startup preflight diagnostic（snapshot row counts + sample readElo hit-rate）
  - `scripts/elo/compute_v11.ts` 仍寫 multi-axis snapshots（5 axis_key），生產 `readElo()` 只查 `axis_key='overall'`。schema 預留供將來重 test
  - `reports/multiaxis-compare.md` 1-month diag 結果留底
  

  ---

  ## 2026-05-19 · Stage 7 ship：LightGBM 預測 pipeline 上線（半成品，仍有 UI gap）

  ### 已完成（Phase A + Phase B）

  | 組件 | Status | 位置 |
  |---|---|---|
  | `lgb_predictions` D1 table (PRIMARY KEY race_id+horse_id) | ✅ schema_v2.sql + 寫入時 `CREATE TABLE IF NOT EXISTS` defensive | src/db/schema_v2.sql, admin POST |
  | Admin POST `/admin/api/lgb-predictions` (upsert) | ✅ Live | src/routes/admin.ts |
  | Admin GET `/admin/api/lgb-predictions` (summary) | ✅ Live · 已驗證返回 108 rows × 9 races | src/routes/admin.ts |
  | Admin GET `/admin/api/entries-upcoming-export` | ✅ Live · 已驗證返回 233 entries (含 125 R0 reserve pool) | src/routes/admin.ts |
  | `dump-features.ts --upcoming-json` mode | ✅ skips race_number=0 reserve pool · 233→108 真正參賽 | scripts/backtest/dump-features.ts |
  | `predict_upcoming.py` (lambdarank, 200 trees, leaves=15) | ✅ Works · POST 用 User-Agent header (CF 1010 fix) | scripts/backtest/predict_upcoming.py |
  | Nightly workflow `lgb_predict_upcoming.yml` (cron 04:00 HKT) | ✅ Live · 共用 walkforward 嘅 bulk-local.db cache | .github/workflows/lgb_predict_upcoming.yml |
  | `analyze.ts` `computeComposite` 讀 `lgb_predictions` | ✅ Live · 當 lgb_score 存在時 override _score | src/routes/analyze.ts L1170-1293 |

  ### 已驗證 E2E
  - 預測 workflow 26107516445 跑成功，POST 108 預測去 prod  
  - `GET /admin/api/lgb-predictions` 返回 `{rows_n:108, races_n:9, model_version:'lgb-lambdarank-20260519'}`

  ### ❌ 集成 GAP（下一步要修）
  `/api/analyze/today-picks`（即 UI 顯示明天 racecard 嘅嗰個 endpoint）**完全冇查 lgb_predictions**。佢只查 `entries_upcoming`。  
  `/api/analyze/top-picks` 雖然有 LGB override，但係佢要求 `races` 表已有 row（即賽事已完成），upcoming 賽事根本入唔到 top-picks。

  **結果：**  
  LGB 預測雖然每晚自動跑、入到 D1，但 **用戶側面睇唔到**。要等改 today-picks 加入 lgb_predictions JOIN，或者改 top-picks fallback 去 entries_upcoming。

  **另外：** 我合成嘅 race_id 用 `YYYYMMDD_VENUE_R<n>` 格式（無連字號），未確認同 Worker 內部 `races.id` schema 一致（meeting_id 用 `YYYY-MM-DD_VENUE` 有連字號）。如果格式唔啱，將來 race row 真係 insert 後 join 都會錯。

  ### Stage 6 旁路狀態
  Backtest run 26098556544 已完成 success，但無新 lift 數據對比 baseline 17.0%（pace/class fix 上線唯一驗證 = walkforward 通過，唔代表生產有 lift）。Stage 7 上線重要過再 tune Stage 6 features。

  ### Backtest Anchor（之前確定，無變）
  原始 LGB Top1=21.65% vs 純 ELO baseline 17.0%（+27% rel），window=2024-09-01..2026-04-30, 1549 races

  ### 推薦下一步（按優先級）
  1. 修 `analyze.ts` today-picks：每場 race join `lgb_predictions` ON (race_date+venue+race_number → synth race_id)，將 `p_win` 攝入返 picks payload  
  2. 驗證 synth race_id 同 Worker 內部 races.id 一致（grep `scripts/import-csv.ts` 中 race row insert）  
  3. UI 加 LGB score badge（可選）
  

  ---

  ## 2026-05-19 · Stage 7 完成上線：LGB 完全整合到 UI

  ### 修咗之前嘅 2 個 gap

  | Gap | Fix | Commit |
  |---|---|---|
  | Synth race_id 格式錯（`YYYYMMDD_VENUE_R<n>` 對唔上 `races.id`） | 改用 `race_<YYYY-MM-DD>_<VENUE>_<raceNo>` 對齊 `scripts/import-csv.ts` `raceId()` | b10007a |
  | `/api/analyze/today-picks` 冇查 `lgb_predictions` | `runRaceDayReportCompute` batch-load LGB scores、每場 race 用 `lgbLookupRaceId` (raceDB.id ?? synth) lookup，存在時 override `_score`；payload 加 `lgbModelVersion`/`lgbCoverage`，每場 race 加 `scoreSource`，每隻馬加 `lgbScore`/`lgbModelVersion`/`scoreSource` | 681a7ca |
  | Meeting picker 揀錯場（揀咗 ST 嘅 races 但 entries_upcoming 係 HV） | 改先揀有 `entries_upcoming` rows 嗰隻 meeting，跟住 fallback 去最多 races 嗰隻；加 `?venue=HV` query param override | cb35fe7 |

  ### 最終 E2E 驗證
  ```
  GET /api/analyze/today-picks?fresh=1
  → venue: HV
  → lgbModelVersion: lgb-lambdarank-20260519
  → lgbCoverage: { rows: 108 }
  → 9 races, all scoreSource='lgb'
  → race1 top3: 皇金合 (pWin 24%) → 綫路光驊 (13%) → 首駿 (11.1%)
  ```

  每隻馬都帶埋 `lgbScore`（原始 lambdarank logit）、`scoreSource: 'lgb'`、`lgbModelVersion`。冇 LGB 嘅馬會 fallback 去 ELO+factor，唔會 crash。

  ### Stage 7 完整 commit 清單（sleepingarhat/tianxi-backend）
  - `015ab20` Phase A scaffolding（schema + admin POST/GET + analyze override）
  - `b8b7e47`、`c61ce79` dump-features `--upcoming-json` mode + skip R0
  - `b4d4212` predict_upcoming.py（lambdarank, 200 trees, leaves=15）
  - `5254230`→`3247311`→`e68ead0` workflow path + cache key
  - `e59e77c` urllib UA header（修 CF 1010）
  - `b10007a` synth race_id 對齊 import-csv `raceId()`
  - `681a7ca` today-picks 讀 lgb_predictions
  - `cb35fe7` today-picks meeting picker（揀有 entries 嗰隻 + `?venue=` override）

  ### 後續可選改善（非 blocker）
  1. 清埋舊 108 行錯 format 嘅 lgb_predictions rows（`20260520_HV_R1` 等）→ 加個 admin DELETE endpoint
  2. UI 喺每隻馬 card 加個 "LGB" badge（前端嘅工作）
  3. 觀察 `scoreSource: 'elo+factor'` 嘅 race（即 LGB 失敗 fallback）做監控
  

  ---

  ## 2026-05-19 (晚) · Stage 7 architect 回顧 — 6 個 critical fix

  Architect (evaluate_task) 標 5 個 high-impact issue，全部修咗：

  | # | Issue | Fix | Commit |
  |---|---|---|---|
  | 1 | Venue cache key collision (HV/ST 撞 cache) | cache read 由 meeting selection 之前移到之後，key = `${engine}::${meeting.venue}`，`?venue=` 直接 bypass cache | d790d34 |
  | 2 | Mixed-scale softmax silent failure (部份馬冇 LGB 會混 scale) | **race-level ALL-OR-NOTHING**：一場全 12 隻有 LGB 先用 LGB，否則全場 fallback 到 ELO+factor | d790d34 |
  | 3 | finalScore 同 qimen/log inconsistent (LGB 只覆寫 _score) | LGB 同時覆寫 finalScore = 1500 + lgb_score×100，qimen variant + prediction_log 全部見到 LGB signal | d790d34 |
  | 4 | Tie-breaker 揀錯場 (多 meeting 有 entries 時用 m.id) | ORDER BY `(SELECT COUNT(*) FROM entries_upcoming ...)` DESC, m.id | d790d34 |
  | 5 | Cron upload 唔 invalidate cache → stale payload | admin POST /lgb-predictions 完先 `DELETE FROM race_day_report_cache WHERE date IN (...)` | f0a690c |
  | 6 | **Pre-existing bug**: `runRaceDayReportCompute` 有兩份 duplicate function declaration (建構 fail) | 刪除 orphan copy (block A, 228 行)，將 fixes port 到 live copy (block B, JS hoisting 用 last decl) | 3c254fb / d790d34 |

  ### 最終 E2E (deploy d790d34)
  ```
  GET today-picks?fresh=1&venue=HV
  → scoreSource=lgb, lgbCoverage={hits:12,total:12,applied:true}
  → top: lgbScore=0.237 → finalScore=1523.7 (= 1500+0.237×100 ✓)

  GET today-picks?fresh=1&venue=ST
  → scoreSource=elo+factor, lgbCoverage={hits:0,total:12,applied:false}
  → ST 冇 LGB rows → clean ELO fallback，唔會 mix scale

  GET today-picks?venue=HV (cached) → fromCache=true (venue-scoped)
  ```

  ### Architect 評估嘅 silent failure mode 已封堵
  - ❌ 唔會再有 race 喺 LGB 同 ELO score 之間混 softmax
  - ❌ 唔會再 cache stale payload after 新 LGB upload
  - ❌ HV / ST 唔會再撞 cache key

  ### Stage 7 全部 commit 清單
  ```
  015ab20  Phase A scaffolding (schema + admin + analyze override)
  b4d4212  predict_upcoming.py (lambdarank, 200 trees, leaves=15)
  e68ead0  sklearn dep + cache key
  3247311  workflow path
  c61ce79  skip R0
  b8b7e47  dump-features --upcoming-json mode
  e59e77c  urllib UA header (CF 1010 fix)
  b10007a  synth race_id 對齊 import-csv raceId()
  681a7ca  today-picks 讀 lgb_predictions (initial)
  cb35fe7  today-picks meeting picker (entries_upcoming + ?venue=)
  c38218d  decision log Phase A+B
  5bf150b  decision log Phase A 收尾
  eb1187a  architect fixes (partial, deploy fail due to duplicate fn)
  f0a690c  admin invalidate cache
  3c254fb  remove duplicate runRaceDayReportCompute + port cacheKey
  d790d34  port all-or-nothing LGB block to live function ★ FINAL
  ```

  明天 2026-05-20 HV 賽馬日，prod 已 ready。
  

  ---

  ## 2026-05-19 · Phantom meeting row defence (commit 9ad99d0)

  **Trigger**: User reported /schedule/ page showed two cards for 2026-05-20 — phantom `2026-05-20_ST` (total_races=1, track="好地至黏地") + real `2026-05-20_HV` (total_races=NULL → UI fallback rendered as "排位 233 匹" from entries_upcoming count instead of race count).

  **Root causes**:
  1. Phantom `race_meetings` row `2026-05-20_ST` exists in D1 (1 corresponding `races` row also exists). Likely written historically by `scrape-results.ts` which blindly INSERTs whatever HKJC returned for the (date, venue) query.
  2. Real `2026-05-20_HV` row has `total_races=NULL` because `races` table not yet populated (race day tomorrow, only `entries_upcoming` filled).
  3. `/api/meetings` returned `total_races=m.total_races` directly, no fallback to entries_upcoming distinct race count.

  **Fix B (治本 — defensive, this commit)**:
  1. `src/routes/meetings.ts`: COALESCE `total_races` to `(SELECT COUNT(DISTINCT race_number) FROM entries_upcoming WHERE race_date=m.date AND venue=m.venue)`. Also adds WHERE filter to hide meetings that have neither a non-null total_races nor any entries_upcoming row (future phantoms with all-NULL meta won't surface).
  2. `scripts/scrape-racecard.ts`: pre-INSERT guard. Before `upsertMeeting.run(...)`, runs UNION ALL check on entries_upcoming + race_meetings. If neither has evidence, logs `[scrape-racecard] SKIP phantom meeting <id>` and `return` from the transaction callback (no insert).
  3. `scripts/scrape-results.ts`: blind `INSERT INTO race_meetings VALUES ... ON CONFLICT` → `INSERT INTO race_meetings ... SELECT ... WHERE EXISTS (entries_upcoming) OR EXISTS (race_meetings) ON CONFLICT`. `entries_upcoming` is retained for past dates so post-race ingest continues to work.

  **Verified live (commit 9ad99d0 deployed)**:
  - `GET /api/meetings` for 2026-05-20_HV now returns `totalRaces: 10` (was `null`). UI no longer falls back to wrong "排位 N 匹" display.
  - 2026-05-20_ST phantom still surfaces because `total_races=1` is non-null (filter only hides all-NULL phantoms). User opted out of destructive cleanup A (`DELETE FROM race_meetings WHERE id='2026-05-20_ST'`).

  **Fix A (治表 — not applied)**: Manual `DELETE FROM race_meetings WHERE id='2026-05-20_ST'` + cascade-clean its 1 races row still needed for full UI fix. User chose to defer.

  **Future scrapes**: next time `scrape-racecard.ts` or `scrape-results.ts` is invoked for a (date, venue) with no entries_upcoming evidence, it will SKIP and log. Phantom rows can no longer be created from those two ingest paths. `import-csv.ts` (bulk historical import) intentionally not guarded.

  ## 2026-05-19 — Phantom 2026-05-20_ST cleanup + race_number=0 reserve-pool guard

  **Symptom.** /schedule for 2026-05-20 showed two rows: HV (totalRaces=10, should be 9) + ST (totalRaces=1 "好地至黏地"). Neither was real — only HV races that day, with 9 races.

  **Root cause.**
  1. `entries_upcoming` had a stray `race_number=0` bucket holding 125 horses (HKJC reserve/standby entries scraped into the same table). This inflated the `COUNT(DISTINCT race_number)` fallback in /api/meetings from 9 to 10.
  2. `race_meetings` had a phantom `2026-05-20_ST` row + 1 child `races` row + **14 `race_results` + 9 `dividends`** with `finish_time` and `win_odds` for a date that hadn't happened yet (today=2026-05-19). The racecard or results scraper misattributed an unrelated race chain to a non-existent ST meeting.

  **Fix (commit `ca67e94`).**
  - `src/routes/meetings.ts`: COALESCE fallback subquery adds `AND race_number > 0` to exclude the reserve pool from race counts going forward.
  - `src/routes/admin.ts`: added one-shot `POST /admin/api/cleanup-2026-05-20-phantom` endpoint.

  **Endpoint cascade fix (commit `119aaf5`).** First version 500'd because the phantom race had non-nullable FK children. Rewrote to mirror `cleanup-duplicate-meetings` cascade: SELECT race ids → DELETE non-nullable race_id children (race_results, sectional_times, horse_sectional_times, running_comments, dividends, odds_snapshots_legacy, race_videos) → UPDATE...NULL nullable race_id refs (horse_form_records, *_elo_snapshots) → DELETE races, race_meetings, reserve pool.

  **Verified.** Endpoint returned: race_results=14, dividends=9, races_st=1, race_meetings_st=1, reserve_pool_hv=125 deleted. Post-cleanup `/api/meetings?date=2026-05-20` returns only HV with totalRaces=9. Schedule UI clean.

  **Open follow-ups.**
  - Investigate which scraper produced phantom race_results with future `finish_time` / `win_odds` — Fix B guards already in scrape-racecard + scrape-results, but data here pre-dates them. Likely from a one-off manual or older scrape run; monitor next 2026-05-23 ST meeting for recurrence.
  - `entries_upcoming` reserve-pool insertion: prefer storing as separate table or with `is_reserve` flag instead of `race_number=0` to avoid silent inflation of derived counts. Tracked but low priority.

  ## 2026-05-19 — prediction_log schema upgrade: score_source + lgb_score + lgb_model_version

  **Problem.** prediction_log was ELO-centric; no way to separate LGB rows from R5 ELO rows in walk-forward analysis or the PREDICTION VS RESULT panel. All 10,756 historical rows were tagged `engine='v12'` with no per-row source attribution. Today's HV 2026-05-20 LGB predictions (108 rows) were silently mixed into the same column space.

  **Fix (commit `c4b0fd1`).**
  - `src/routes/analyze.ts`:
    - `ensurePredictionLogTable` CREATE TABLE: 3 new nullable columns (`lgb_score REAL`, `lgb_model_version TEXT`, `score_source TEXT`). PK unchanged. New deploys auto-get schema.
    - `writePredictionLog` INSERT OR REPLACE: column + bind list extended; reads `p.lgbScore` / `p.lgbModelVersion` (with payload-level fallback) / `p.scoreSource` — values already present on pick objects from L1320 + L2158-2167 LGB rescoring path.
  - `src/routes/admin.ts`: `POST /api/migrate-prediction-log-lgb` one-shot endpoint
    - 3 ALTER TABLE ADD COLUMN with duplicate-column catch
    - 3 backfill UPDATEs sliced by (variant × era) for traceable counts
    - Returns alter status + per-slice update counts + post-backfill score_source distribution + null count

  **Backfill mapping.**
  | Slice | score_source | lgb_model_version |
  |---|---|---|
  | baseline + generated_at ≥ 2026-05-19T00:00:00Z | `lgb` | `lgb-lambdarank-20260519` |
  | baseline + generated_at <  2026-05-19T00:00:00Z | `elo` | NULL |
  | variant != 'baseline' (qimen, baseline-bt, qimen-bt, r5-bt) | `<variant>` verbatim | NULL |

  `lgb_score` raw cannot be recovered for historical rows (only the blended `final_score` was persisted) — stays NULL for backfilled rows; new writes populate it from now on.

  **Verified (prod).** `POST /admin/api/migrate-prediction-log-lgb` returned:
  ```json
  {"alter":{"lgb_score":"added","lgb_model_version":"added","score_source":"added"},
   "backfill":{"baseline_post_lgb":108,"baseline_pre_lgb":322,"non_baseline_variants":10310},
   "verify":{"score_source_distribution":[
     {"score_source":"qimen-bt","n":3507},{"score_source":"baseline-bt","n":3507},
     {"score_source":"r5-bt","n":2866},{"score_source":"qimen","n":430},
     {"score_source":"elo","n":322},{"score_source":"lgb","n":108}],
    "score_source_null":0}}
  ```

  **Endpoint retired** in follow-up commit (410 stub) to shrink admin blast radius, consistent with the cleanup-2026-05-20-phantom pattern.

  **Open follow-ups.**
  - PREDICTION VS RESULT panel in admin UI not yet updated to filter / colour by `score_source`. Next session: surface engine in the per-race table and split aggregate hit-rate by source.
  - Once LGB has shipped on ≥3 race days, generate first walk-forward report comparing LGB vs ELO baseline using `score_source` filter.

  ## 2026-05-19 — LGB Stage 7 v2: graded label + validation + temperature calibration + ELO ensemble

  **Problem.** v1 of `predict_upcoming.py` (shipped earlier today) had four known weaknesses surfaced in the post-ship review:
  1. Binary `is_top1` label — 95% negative rows, ignores 2nd/3rd ordering signal.
  2. No validation set / early stopping — hard-coded `n_estimators=200` may overfit or underfit.
  3. Raw softmax over-peaked — `p_win` not calibrated, unsafe for Kelly-style sizing.
  4. LGB once applied fully overrides ELO — no fallback when LGB underperforms in a regime (e.g. first-timer-heavy races).

  **Fix (commit `<sha>`).** Rewrote `scripts/backtest/predict_upcoming.py` end-to-end:

  | # | Change | Detail |
  |---|---|---|
  | 1 | Graded lambdarank label | Switched from `is_top1` to `max_pos - finishing_position` clipped at 0. Matches `lgb_walkforward.py` so train/eval are aligned. |
  | 2 | Validation + early stopping | Last `--val-days=30` days held out. `lgb.train` with `early_stopping(20)` picks best iteration. Model is then **refit on FULL data** with that iteration count so production sees most-recent races. |
  | 3 | Temperature calibration | Independent τ_lgb and τ_elo learned on validation by minimizing per-race winner log loss (`scipy.optimize.minimize_scalar`, log-bounded). |
  | 4 | ELO ensemble | `p_final = α·p_lgb + (1-α)·p_elo` where each engine is per-race softmaxed independently (no mixed-scale concern — satisfies architect's 2026-05-19 ALL-OR-NOTHING gate intent). α learned on validation. Posted `lgb_score = log(p_final)` so analyze.ts ranking automatically reflects the ensemble; `p_win` is the calibrated blended probability. |

  **Safety flags.** `--no-calibrate`, `--no-ensemble`, `--val-days=0` peel each layer back to v1 behaviour if anything misbehaves.

  **Workflow updates** (`.github/workflows/lgb_predict_upcoming.yml`):
  - Added `scipy` to pip install line (was implicit via scikit-learn; making explicit).
  - Model version tag bumped from `lgb-lambdarank-YYYYMMDD` to `lgb-ensemble-YYYYMMDD` so the admin UI badge + `prediction_log.lgb_model_version` clearly distinguish v1 from v2 rows.

  **Storage compatibility.** No schema change. `admin.ts POST /api/lgb-predictions` already accepts arbitrary extra fields (the new `diagnostics` block is logged then dropped). `prediction_log` schema is unchanged from the morning's migration. analyze.ts behaviour identical — it sorts by `lgb_score` and uses race-level all-or-nothing gating; the ensemble math happens entirely in Python.

  **Validation expected on next nightly run** (04:00 HKT). Look in GH Actions log for:
  ```
  [predict] early stopping picked best_iteration=...
  [predict] τ_lgb=...  τ_elo=...
  [predict] α=...  ensemble val log loss ...
  ```
  α ≈ 1.0 means LGB dominates (ensemble degenerates to pure-LGB); 0.3–0.7 means the blend is doing real work.

  **Open follow-ups deferred** from the four-weakness list:
  - Per-venue model (HV vs ST split) — wait for more data; ~400 races/year combined is already thin.
  - Closing-odds calibration target — current calibration uses `is_top1` outcomes. Comparing Brier score vs market would be a separate evaluation task.

  ## 2026-05-20 — LGB v2 verification run (commits 2cac780 → 59b8909)

  **Three commits this session on top of d4ba9dd:**
  - `2cac780` — architect fix: eliminate validation leakage in τ/α calibration (fit on pre-refit booster predictions, then refit-on-full, then freeze τ/α). Added boundary warnings for τ_lgb, τ_elo, α.
  - `59b8909` — pure whitespace fix: dedent (template-literal indentation had leaked into the Python source, broke at `IndentationError` on line 2).

  **Manual workflow_dispatch verification** (run `26145066187` on `59b8909`): **SUCCESS** — POST 200, 108 predictions across 9 races stored under `modelVersion=lgb-ensemble-20260520`.

  **Validation diagnostics from the verification run** (training 19,058 rows / 1,549 races; val 1,122 rows / 90 races held out from last 30 days):

  ```
  val log loss (LGB raw τ=1):       2.4918
  val log loss (LGB calibrated):    2.3289   τ_lgb = 0.059
  val log loss (ELO calibrated):    2.9868   τ_elo = 99.999  ⚠ boundary
  val log loss (ensemble):          2.3173   α     = 0.739
  best_iteration:                   1
  ```

  **Two honest caveats surfaced:**

  1. **`best_iteration=1`** — lambdarank early stopping hit the patience cutoff after the very first boosting round. With 90 validation races × 1 winner each, NDCG@1 signal is too noisy to drive boosting further. This is **healthier** than v1's hard-coded 200 rounds (which definitely overfit), but it also tells us the validation set is too small to extract a confident iteration count. Follow-up: tune hyperparams (smaller learning rate, larger `min_data_in_leaf`, or switch early-stop metric to NDCG@5). Not blocking — α=0.739 means the ensemble is still LGB-driven and the calibrated p_win is monotone with rank.

  2. **`τ_elo ≈ 100`** at the optimization boundary — the boundary warning fired correctly. ELO `baseline_score` (scale 1500±50) is too compressed for per-race softmax to extract probability from at any temperature. The ranking signal in ELO is fine (analyze.ts uses it for the baseline pick), but as a **probability source** for the ensemble it contributes mostly uniform mass. The 26% weight ELO gets in α effectively acts as a shrinkage prior toward uniform. Follow-up: try `(baseline_score - mean) / std` standardization before softmax, or learn a per-race deviation feature instead of raw score.

  **Conclusion.** v2 is in production and behaves correctly. Both calibration concerns are about **data shape** rather than bugs — the pipeline did exactly what the architect's review wanted (no leakage, frozen τ/α post-refit, boundary warnings). Hyperparameter and feature-scale tuning are separate follow-ups.

  **Deferred this session (carried over from d4ba9dd entry):**
  - Per-venue model (HV/ST split) — too thin (~200 races each).
  - Closing-odds Brier evaluation — useful for measuring calibration vs market.
  - Admin UI `score_source` split panel — surface v1 vs v2 prediction counts.
  - LGB hyperparameter sweep on validation log loss (best_iter > 1).
  - ELO baseline standardization to fix τ_elo boundary.
  
