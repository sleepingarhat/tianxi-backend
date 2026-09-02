# 天喜後端 · tianxi-backend

## 引擎健康守門（TX-Oracle v3.2）

對齊 [tianxi-database/reports/SANITY.md](https://github.com/sleepingarhat/tianxi-database/blob/main/reports/SANITY.md) 的 passing 列表。完整頁：[ENGINE_STATUS.md](./ENGINE_STATUS.md)

| 狀態 | 檢查 |
|---|---|
| PASS | LambdaRank listwise |
| PASS | Frame 名次標籤（頭四） |
| PASS | 臨場盤不入 LGB |
| PASS | 特徵 as-of／τ α 無洩漏 |
| PASS | α 自癒閘 fail-closed |
| PASS | 休季自動暫停 |
| PASS | Elo v12 後備 |
| PASS | 公開戰績 |
| PASS | min_data_in_leaf=80 |
| PASS | max_depth=4 · bagging/feature 0.7 |
| PASS | live／backfill 約束對齊 |
| WATCH | 開季後寫入當日 best_iter／τ／α |
| WATCH | 休季無 live 訓練曲線 |

**總評 WATCH**（12 PASS · 2 WATCH · 0 FAIL）· 休季 · 上仗 2026-07-15

JSON：`GET /api/analyze/engine-health` · 監控：`/admin/engine-health` · 用戶端：https://tianxi.racing/engine/

---

Cloudflare Workers + D1 API、TX-Oracle v3.2 預測引擎、內部管理控制台。

## 技術梯

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
