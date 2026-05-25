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
             ↑ α 由 app_settings.ensemble_alpha 管理（offline tuner 寫入）

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

## 內部管理 / 診斷 endpoint

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/analyze/top-picks?raceId=` | 生產預測 (TX-Oracle v3) |
| GET | `/api/analyze/today-picks` | 全日預測 cache |
| GET | `/api/analyze/hit-rate?date=&alpha=` | meeting 命中率（per-α 快取） |
| GET | `/api/analyze/backtest-dates?days=` | 列出有 race_results 嘅 race day |
| GET | `/api/analyze/d1-inspect?table=&limit=` | ADMIN — D1 schema + sample row 探查 |
| POST | `/api/analyze/ensemble-alpha {alpha}` | ADMIN — 切換生產 α |

---

## 歷史清理紀錄

- **2026-05-22**: v11 ELO 引擎完全 strip（D1 100% v12）
- **2026-05-25**: qimen / meihua / TimesFM 探索代碼 strip（從未進入生產）
- **2026-05-25**: backtest A/B 報告 routes（start-backtest-bg / backtest-report / backtest-diff / backtest-status / ensemble-only-range）連同 `prediction_log` 嘅 `qimen-bt` / `baseline-bt` / `qimen` variant strip。剩 `baseline` variant（TX-Oracle v3 生產輸出）
