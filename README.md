# 天喜後端 · tianxi-backend

  Cloudflare Workers + D1 API、ELO 複合預測引擎、內部管理控制台。

  ## 技術棧

  - **Runtime**: Cloudflare Workers (Hono v4)
  - **Database**: Cloudflare D1（SQLite，綁定名 `DB`）
  - **語言**: TypeScript 5.9
  - **部署**: `wrangler deploy`

  ## 系統架構（3 repos 生態）

  | Repo | 角色 |
  |------|------|
  | **tianxi-database**（public） | HKJC 爬取 · CSV 數據底 · GHA 調度 · ELO pipeline |
  | **tianxi-backend**（本 repo · private） | D1 API + R5 預測引擎 + 管理控制台 |
  | **tianxi-site**（public） | CF Pages 純靜態前端 |

  ---

  ## ✅ 當前生產引擎：R5（2026-05-10 上線）

  呢條公式係由 88 日 walk-forward ablation + 2026-05-12 multi-axis backtest 共同確認嘅最佳組合。

  ### 公式

  ```
  finalScore = eloComposite + factorBonus

  eloComposite = (0.7·馬匹ELO + 0.2·騎師ELO + 0.1·練馬師ELO) / availableWeight
                  ↑ 缺資料時自動 rescale，例如新馬只有 J+T 兩個分量

  factorBonus  = fDraw.bonus + fWeight.bonus
                  ↑ 只有兩個因子真正入分

  P(勝)        = softmax(_score)，其中 _score = (eloComposite − 1500)/200 + factorBonus/100
  ```

  ### 入分組件

  | 組件 | 來源 | 權重 |
  |------|------|------|
  | 馬匹 ELO | `horse_elo_snapshots` (axis_key='overall') | 0.7 |
  | 騎師 ELO | `jockey_elo_snapshots` (`name_en` keyed) | 0.2 |
  | 練馬師 ELO | `trainer_elo_snapshots` (`name_en` keyed) | 0.1 |
  | 檔位偏差 `fDraw` | `(venue, distance)` bucket 出閘位歷史勝率 | additive |
  | 負磅變化 `fWeight` | 今戰負磅 vs 近戰平均負磅 Δ | additive |

  ### Telemetry-only（compute 但不入 score，純供 explain 顯示）

  | 因子 | 為何不入分 |
  |------|-----------|
  | 近戰狀態 `recency` | 噪音大、ELO 已 decay |
  | 途程適應 `distance` | 同 ELO 多重共線 |
  | 場地適應 `going` | 樣本太散 |
  | 騎練配對 `jtCombo` | 同 J·T ELO double count |
  | 損傷標記 `injury` | 覆蓋率低 |
  | 狀態 `condition` | 採樣不一致 |

  > 加返呢 6 個入分嘅版本 (R0/R1/R2) 全部喺 88 日測試 underperform R5 (見 `reports/decision-log.md`)。

  ### A/B variants in `prediction_log`

  | variant | 公式 | 用途 |
  |---|---|---|
  | `baseline-bt` | 純 ELO（無 factor） | walk-forward control |
  | `r5-bt` | ELO + draw + weight | 確認 R5 production 公式 |
  | `qimen-bt` | 純 ELO（與 baseline 同） | 確認奇門無 alpha（已棄用） |

  ### 自動決議

  `GET /api/analyze/r5-comparison?days=30` 計 Δ + Wilson 95% CI：

  - `KEEP_R5`: r5 vs baseline ≥ +2pp banker hit on ≥30 races
  - `REVERT_TO_PURE_ELO`: r5 ≤ −1pp banker hit
  - `INCONCLUSIVE`: 之間或 sample 不足

  完整決議歷史見 [`reports/decision-log.md`](./reports/decision-log.md)。

  ---

  ## ❌ 試過但唔用嘅 approach

  | Approach | 測試 | 結果 |
  |---|---|---|
  | **Multi-axis horse ELO**（per surface × distance bucket） | 2026-05-12 5-variant backtest（A/B/C/D/E vs R5） | C/E (multi-axis) 12.9% Top1 < A (overall) 14.3% Top1。Multi-axis 唔贏 overall，**唔 productionize**。詳見 `reports/multiaxis-compare.md` |
  | **奇門遁甲 score** | 88 日 backtest | 同純 ELO 一樣，無 alpha |
  | **梅花易數** | 88 日 backtest | 同上 |
  | **R0 (8-factor 全入分)** / R1 / R2 | 88 日 walk-forward | 全部 underperform R5，見 decision-log |
  | **LightGBM re-ranker** | offline backtest | 已寫 harness（`scripts/backtest/lgb_walkforward.py`），未 deploy |

  > 雖然 `horse_elo_snapshots` schema 仍寫 multi-axis 數據（5 個 axis_key），但生產 `readElo()` 只查 `axis_key='overall'`。多餘嘅 axis 行純為將來 re-test 預留。

  ---

  ## API 端點

  ### 公開 API

  | 端點 | 說明 |
  |------|------|
  | `GET /api/meetings/smart/current` | 當前/最近賽馬日 |
  | `GET /api/meetings/next` | 下一個賽馬日 |
  | `GET /api/races/:id/entries` | 排位表 + 兄弟場次導航 |
  | `GET /api/horses/:id/detail` | 馬匹詳情（前端 horse 頁用） |
  | `GET /api/horses/leaderboard?by=elo` | ELO 排行（百科用） |
  | `GET /api/horses/search/query?q=` | 馬匹搜尋 |
  | `GET /api/analyze/top-picks?raceId=` | **R5 複合預測**（race 頁用） |
  | `GET /api/analyze/explain?raceId=&horseId=` | 單匹因子分解 + 解釋（horse 頁用） |
  | `GET /api/analyze/factors` | 預測探索工具用嘅 17-因子 catalog（predictor 頁，純探索，非生產公式） |
  | `GET /api/analyze/prediction-accuracy?days=N` | 三 variant walk-forward 命中率 + Brier |
  | `GET /api/analyze/r5-comparison?days=N` | R5 vs baseline Δ + 95% CI + 決議 |
  | `GET /api/silks/:code.gif` | 騎師衫色代理 |
  | `GET /api/lounge/chat` · `POST /api/lounge/chat` | 全局聊天室 |

  ### 管理 API（Bearer / `?token=`）

  | 端點 | 說明 |
  |------|------|
  | `GET /admin` | 內部控制台 HTML |
  | `GET /admin/api/coverage` | 14 個數據源覆蓋狀態 |
  | `GET /admin/api/status` | D1 即時計數 |
  | `GET /admin/api/alerts` | 系統告警 |
  | `GET /admin/api/runs` | GHA 工作流運行記錄 |
  | `POST /admin/api/dispatch` | 觸發 GHA 工作流 |
  | `POST /admin/api/refresh-hit-cache` | 重 build hit-rate cache |
  | `POST /admin/api/refresh-race-day-report` | 重 build race day report |

  ---

  ## 本地開發

  ```bash
  npm install
  npm run dev           # wrangler dev
  npm run deploy        # wrangler deploy
  ```

  ## Worker Secrets（必須）

  ```bash
  wrangler secret put ADMIN_TOKEN
  wrangler secret put GITHUB_TOKEN
  wrangler secret put GITHUB_REPO   # sleepingarhat/tianxi-database
  ```

  ## D1 資料庫

  - **綁定**: `DB` · **ID**: `aad1636e-869a-43f5-aa95-4a19e3aa5517`
  - **Schema**: `src/db/schema.sql` + `schema_v2.sql`（multi-axis snapshot 表）+ 各擴充 SQL
  