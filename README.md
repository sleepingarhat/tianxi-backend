# 天喜後端 · tianxi-backend

Cloudflare Workers + D1 API 服務、ELO 複合預測引擎、內部管理控制台。

## 技術棧

- **Runtime**: Cloudflare Workers (Hono v4)
- **Database**: Cloudflare D1（SQLite，綁定名 `DB`）
- **語言**: TypeScript 5.9
- **部署**: `wrangler deploy`

## 系統架構

**生態系統（3 repos）**

| Repo | 角色 |
|------|------|
| **tianxi-database**（public） | 數據爬取 · CSV · GHA 調度 |
| **tianxi-backend**（本 repo · private） | API + ELO + 預測 + 管理控制台 |
| **tianxi-site**（public） | CF Pages 前端 |

## API 端點

### 公開 API（無需認證）

| 端點 | 說明 |
|------|------|
| `GET /api/meetings/smart/current` | 當前 / 最近賽馬日 |
| `GET /api/meetings/next` | 下一個賽馬日 |
| `GET /api/races/:id/entries` | 排位表 + 兄弟場次導航 |
| `GET /api/horses/:id/detail` | 馬匹詳情 KV（Level-3 用） |
| `GET /api/analyze/top-picks?raceId=` | R5 複合預測（ELO + draw + weight） |
| `GET /api/analyze/explain?raceId=&horseId=` | 單匹因子分解 + 說明文字 |
| `GET /api/jockeys` | 騎師列表 + 統計 |
| `GET /api/trainers` | 練馬師列表 + 統計 |
| `GET /api/silks/:code.gif` | 騎師衫色代理 |
| `GET /api/analyze/prediction-accuracy?days=N` | 三個 variant (qimen-bt / baseline-bt / r5-bt) walk-forward 命中率 + Brier / log-loss |
| `GET /api/analyze/r5-comparison?days=N` | R5 (ELO+draw+weight) vs baseline (純 ELO) Δ + 95% CI + KEEP_R5 / REVERT / INCONCLUSIVE 決議 |

### 管理 API（Bearer token 或 `?token=`）

| 端點 | 說明 |
|------|------|
| `GET /admin` | 內部控制台 HTML |
| `GET /admin/api/coverage` | 14 個數據源覆蓋狀態 |
| `GET /admin/api/status` | D1 即時計數 |
| `GET /admin/api/alerts` | 系統告警 |
| `GET /admin/api/runs` | GHA 工作流運行記錄 |
| `GET /admin/api/meetings` | 最近賽事列表（預測工具用） |
| `POST /admin/api/dispatch` | 觸發 GHA 工作流 |

## ELO 預測引擎 R5（current production · 2026-05-10 deploy）

  複合分：`finalScore = 0.7 × 馬匹ELO + 0.2 × 騎師ELO + 0.1 × 練馬師ELO + (fDraw.bonus + fWeight.bonus)`

  **只計分 2 個因子**：檔位偏差 (`fDraw`) · 負磅變化 (`fWeight`)
  **Telemetry only（仍 compute, 但不入 score）**：近戰狀態 · 途程適應 · 場地適應 · 晨操狀態 · 騎練配對 · 損傷標記

  > R5 ablation 由 88 日 walk-forward 結果決定 (見 `reports/decision-log.md`)。其餘 6 個因子或同 ELO double-count，或加噪音；單獨保留 `draw + weight` 喺 88 日測試錄得 +3.9pp Top1 / +5.1pp T4≥3。

  ### A/B variants in `prediction_log`

  | variant | 公式 | 用途 |
  |---|---|---|
  | `baseline-bt` | 純 ELO（無 factor） | walk-forward control |
  | `qimen-bt` | 純 ELO（與 baseline 同分） | telemetry，確認奇門無 alpha |
  | `r5-bt` | ELO + draw + weight | walk-forward 驗證 R5 production 公式 |

  ### 決策追蹤

  `/api/analyze/r5-comparison?days=30` 自動計算 Δ + Wilson 95% CI，按以下規則決議：
  - `KEEP_R5`: r5 vs baseline ≥ +2pp banker hit on ≥30 races
  - `REVERT_TO_PURE_ELO`: r5 ≤ -1pp banker hit
  - `INCONCLUSIVE`: 之間或 sample 不足

  完整決議歷史見 [`reports/decision-log.md`](./reports/decision-log.md)（R0 → R5 + code review）。

## 本地開發

```bash
npm install
npm run dev           # wrangler dev
npm run deploy        # wrangler deploy
```

## Worker Secrets（必須設定）

```bash
wrangler secret put ADMIN_TOKEN     # 管理控制台 token
wrangler secret put GITHUB_TOKEN    # GitHub PAT（repo + workflow 權限）
wrangler secret put GITHUB_REPO     # 值：sleepingarhat/tianxi-database
```

> **注意**：`GITHUB_TOKEN` + `GITHUB_REPO` 未設定時，管理控制台所有自動化狀態顯示為「✗ 無自動」且無法觸發工作流。

## D1 資料庫

- **綁定**：`DB`
- **資料庫 ID**：`aad1636e-869a-43f5-aa95-4a19e3aa5517`
- **Schema 檔案**：`src/db/schema.sql` + `schema_v2.sql` + 各擴充 SQL
