# 天喜後端 · tianxi-backend

Cloudflare Workers + D1 API、TX-Oracle v3 預測引擎、內部管理控制台。

## 技術棧

- **Runtime**: Cloudflare Workers (Hono v4)
- **Database**: Cloudflare D1（SQLite，綁定名 `DB`）
- **語言**: TypeScript 5.9
- **部署**: `wrangler deploy`

## 系統架構（3 repos 生態）

| Repo | 角色 |
|------|------|
| **tianxi-database**（public） | HKJC 爬取 · CSV 數據底 · GHA 調度 · ELO pipeline |
| **tianxi-backend**（本 repo · private） | D1 API + TX-Oracle v3 預測引擎 + 管理控制台 |
| **tianxi-site**（public） | CF Pages 純靜態前端 |

---

## ✅ 當前生產引擎：TX-Oracle v3（2026-05-21 上線）

LightGBM lambdarank（graded labels）+ ELO+factor 喺概率層面 ensemble blend。
P3 backfill 完成後覆蓋 2025-09-03 至今 8+ 個月 race meetings。

### 公式

```
// 1. 各引擎獨立計分
lgbScore   = LightGBM lambdarank model output（val-tuned τ_lgb, τ_elo）
eloScore   = composite ELO + factor bonus (見下)

// 2. Per-race z-norm
lgb_z      = (lgbScore − μ_lgb) / σ_lgb     ← per race
elo_z      = (eloScore − μ_elo) / σ_elo     ← per race

// 3. Probability-level blend
finalScore = 1500 + (α·lgb_z + (1−α)·elo_z + factor·0.5) · 100
             ↑ α = 0.62 (val-tuned, 2026-05-22 reconfirmed)

P(勝)      = softmax(finalScore / 200)
```

實作見 `applyEnsembleBlend()` 喺 `src/routes/analyze.ts`。

### ELO composite（v12 — time-weighted multi-axis）

```
eloComposite = (0.7·馬匹ELO + 0.2·騎師ELO + 0.1·練馬師ELO) / availableWeight
factorBonus  = fDraw.bonus + fWeight.bonus
```

| 組件 | 來源 | 權重 |
|------|------|------|
| 馬匹 ELO | `horse_elo_snapshots` (axis_key='overall', v12) | 0.7 |
| 騎師 ELO | `jockey_elo_snapshots` (v12) | 0.2 |
| 練馬師 ELO | `trainer_elo_snapshots` (v12) | 0.1 |
| 檔位偏差 `fDraw` | `(venue, distance)` bucket 出閘位歷史勝率 | additive |
| 負磅變化 `fWeight` | 今戰負磅 vs 近戰平均負磅 Δ | additive |

> v11 ELO fallback 已於 2026-05-22 移除（production D1 已完成 v12 migration）。
> 所有 ELO read 直接查 `id LIKE 'v12:%'` 行。

### α 調校（offline tuner）

- `POST /api/analyze/ensemble-alpha {alpha}` — ADMIN_TOKEN-gated，寫入 `app_settings.ensemble_alpha`
- `GET /api/analyze/hit-rate?alpha=N` — 帶 alpha override，per-(date,alpha) 結果快取
- GHA workflow `.github/workflows/alpha_tune.yml` — sweep α grid, composite metric = top1·0.6 + top4Avg/4·0.4
- 最新 sweep（2026-05-22, 73 dates / 712 races）：α=0.62 winner composite=0.349

---

## ❌ 試過但唔用嘅 approach（歷史）

| Approach | 結果 |
|---|---|
| **R5（純 ELO + 2 factor）** | 2026-05-10 production，被 TX-Oracle v3 取代 |
| **Multi-axis horse ELO**（surface × distance bucket） | 2026-05-12 backtest：C/E variants 12.9% Top1 < A (overall) 14.3% Top1，唔 productionize |
| **奇門遁甲 / 梅花易數 score** | 88 日 backtest 同純 ELO 一樣，無 alpha |
| **R0 (8-factor 全入分) / R1 / R2** | 全部 underperform R5 |
| **v11 ELO（pre time-weighting）** | 2026-04-28 起被 v12 取代，2026-05-22 fallback 完全移除 |

完整決議歷史見 [`reports/decision-log.md`](./reports/decision-log.md)。

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
| `GET /api/analyze/top-picks?raceId=` | **TX-Oracle v3 預測**（race 頁用） |
| `GET /api/analyze/explain?raceId=&horseId=` | 單匹因子分解 + 解釋（horse 頁用） |
| `GET /api/analyze/factors` | 17-因子 catalog（predictor 頁，純探索，非生產公式） |
| `GET /api/analyze/picks-by-date?date=YYYY-MM-DD` | 指定日全因子預測（支援未來/過去） |
| `GET /api/analyze/hit-rate?date=YYYY-MM-DD[&alpha=N]` | 單日命中率 + ensemble breakdown + per-(date,alpha) cache |
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
| `POST /api/analyze/ensemble-alpha` | 寫入 production α（α tuner --apply 用） |

> 2026-05-22 cleanup 移除：`/api/analyze/{prediction-accuracy, r5-comparison, run-backtest, run-backtest-day, qimen-only-day/range, meihua-only-day/range}` 同 retired `/api/cleanup-2026-05-20-phantom`。

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
