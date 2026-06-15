# 天喜後端 · tianxi-backend

Cloudflare Workers + D1 API、TX-Oracle v3.2 預測引擎、內部管理控制台。

## 技術棧

- **Runtime**: Cloudflare Workers (Hono v4)
- **Database**: Cloudflare D1（SQLite，綁定名 `DB`）
- **語言**: TypeScript 5.9
- **部署**: `wrangler deploy`

## 系統架構（3 repos 生態）

| Repo | 角色 |
|------|------|
| **tianxi-database**（public） | HKJC 爬取 · CSV 數據底 · GHA 調度 · ELO pipeline |
| **tianxi-backend**（本 repo · public） | D1 API + TX-Oracle v3.2 預測引擎 + 管理控制台 |
| **tianxi-site**（public） | CF Pages 純靜態前端 |

---

## ✅ 當前生產引擎：TX-Oracle v3.2

LightGBM lambdarank（graded labels）+ ELO+factor 喺概率層面 ensemble blend。
**訓練窗口：2016-09-01 → 今日全歷史**（2026-05-28 擴展為全歷史；~8,058 races / ~98k rows）。每個賽日 from-scratch 重訓，`model_version` 為當日 date-stamp。

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
             ↑ α 由 app_settings.ensemble_alpha 管理（每賽日 auto-gate 自癒寫入，見下）

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

### α 自癒 auto-gate（每賽日自動，無人手）

- **Nominal α = 0.88**（2026-05-31 由 0.62 升；LGB 主導 ELO，α≈1 屬正常）。
- `.github/workflows/lgb_predict_upcoming.yml` 每賽日預測後行 health gate（`best_iteration`、race-logloss、τ 範圍、runner coverage…）：PASS → `set-alpha=0.88`（blend live），FAIL → `set-alpha=0`（純 ELO fallback），之後 bust cache。malformed diag fail-closed 到 α=0，唔會 crash。
- Runtime 切換（免 redeploy）：`POST /admin/api/set-alpha?value=N`（Bearer-gated）+ `POST /admin/api/refresh-race-day-report` bust per-race cache。
- 歷史 offline tuner `alpha_tune.yml` sweep（2026-05-22, 73 dates / 712 races）曾揀 α=0.62，現已由 auto-gate 0.88 取代。

---

## 近期更新（2026-06）

- **Repo 由 private 改為 public。**
- **Predictor 雙欄**（2026-06-08）：`/predictor/` 出兩欄 —— 左 **模型搏冷**（純模型 pWin，捉冷馬）、右 **市場穩陣**（LOG-blend β=0.4 模型 × 市場 implied prob，偏熱門參考）。市場欄只 mutate additive 欄位（`liveWinOdds/marketProb/blendProb/marketRank`），**唔影響** `finalScore/rank/pWin`；臨場盤口未定時顯示「等臨場盤口」。
- **開跑時間**（2026-06-13）：race card / API 出 `startTime`（HH:MM），來源 HKJC `postTime`，substring parse（UTC Worker 上 TZ-safe，唔會 off-by-one）。
- **賽果頁 Top-4 picks**：`/results/` 動態渲染最新已結算場次嘅 top-4 模型揀馬。

---

## 內部管理 / 診斷 endpoint

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/analyze/top-picks?raceId=` | 生產預測 (TX-Oracle v3.2) |
| GET | `/api/analyze/today-picks` | 全日預測 cache |
| GET | `/api/analyze/hit-rate?date=&alpha=` | meeting 命中率（per-α 快取） |
| GET | `/api/analyze/backtest-dates?days=` | 列出有 race_results 嘅 race day |
| GET | `/api/analyze/d1-inspect?table=&limit=` | ADMIN — D1 schema + sample row 探查 |
| POST | `/api/analyze/ensemble-alpha {alpha}` | ADMIN — 切換生產 α |

---

## 歷史清理紀錄

- **2026-05-22**: v11 ELO 引擎完全 strip（D1 100% v12）
- **2026-05-25**: qimen / meihua / TimesFM 探索代碼 strip（從未進入生產）
- **2026-05-25**: backtest A/B 報告 routes（start-backtest-bg / backtest-report / backtest-diff / backtest-status / ensemble-only-range）連同 `prediction_log` 嘅 `qimen-bt` / `baseline-bt` / `qimen` variant strip。剩 `baseline` variant（TX-Oracle v3.2 生產輸出）
