# 天喜後端 · tianxi-backend

[![Deploy](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/deploy.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/deploy.yml)
[![LGB Predict](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/lgb_predict_upcoming.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/lgb_predict_upcoming.yml)
[![LGB Backfill](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/lgb_backfill.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/lgb_backfill.yml)
[![Racecard](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/capy_racecard.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/capy_racecard.yml)
[![Results](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/capy_results.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/capy_results.yml)
[![Sanity](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/engine_sanity_daily.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-backend/actions/workflows/engine_sanity_daily.yml)

數據庫那掛綠／紅 badge 係 **GitHub Actions 最近一跑結果**，唔係人手 PASS 表。本 repo 現在同款：上面每個 badge 點進去係自動 workflow。每日 sanity 會寫 [reports/SANITY.md](./reports/SANITY.md)。

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
