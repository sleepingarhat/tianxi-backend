# 天喜 Backend · tianxi-backend

> Hono + Cloudflare Workers + D1 API 層。消化 `tianxi-database` 嘅 CSV，提供賽事 / 賽駒 / 騎練 / ELO / composite prediction endpoints 畀 `tianxi-site` frontend 用。

## Production

- **Workers URL**：<https://tianxi-backend.tianxi-entertainment.workers.dev>
- **D1 binding**：`tianxi-db` (`aad1636e-869a-43f5-aa95-4a19e3aa5517`)
- **Runtime**：Cloudflare Workers · Node compat `nodejs_compat`

## 生態系統

| Repo | 角色 |
|---|---|
| [tianxi-database](https://github.com/sleepingarhat/tianxi-database) | CSV source + scraper + D1 sync GHA |
| **tianxi-backend** (本 repo) | Workers API + ELO engine |
| [tianxi-site](https://github.com/sleepingarhat/tianxi-site) | CF Pages 靜態前端 |

## 快速跑動

```bash
# 本地 dev
npm install
cp .dev.vars.example .dev.vars   # 填 D1 credentials
npm run dev

# Deploy
wrangler deploy
```

## Routes

| Path | 用途 |
|---|---|
| `GET /api/meetings` / `/api/meetings/next` / `/api/meetings/smart/current` | 賽馬日清單 / 下一個 / 最新 |
| `GET /api/races/:id` | 單場賽事（entries + 騎練 + silks + 賠率） |
| `GET /api/horses/:id` | 馬匹 profile + career stats + form |
| `GET /api/jockeys/:id` · `GET /api/trainers/:id` | 騎練 profile |
| `GET /api/analyze/top-picks?raceId=` | Composite score ranking（ELO 0.7/0.2/0.1 + per-race factors） |
| `GET /api/analyze/explain?raceId=&horseId=` | 單匹馬-場預測分解 |
| `GET /api/odds/:raceId` | 各彩池即時賠率（獨贏 / 位置 / 連贏 / 位置 Q / 三重彩 / 四重彩 / 四連環 / 六環彩 / 三 T / 單 T） |
| `GET /api/silks/:code.gif` | HKJC silks proxy + D1 blob cache |
| `POST /api/chat` · `GET /api/lounge/*` | AI chat（rate-limited） + lounge 社群 |

## Scripts

| Script | 用途 |
|---|---|
| `scripts/import-csv.ts` | CSV → `bulk-local.db` (scratch SQLite)，schema 自動 bootstrap |
| `scripts/push-delta.ts` | Date-scoped delta → SQL chunks（200 rows / chunk）· 支援 `--include=race/pool-a/all` |
| `scripts/elo/compute.ts` + `compute_v11.ts` | ELO v1.1 / v1.2 engine（horse / jockey / trainer axes） |
| `scripts/push-to-d1.sh` | 手動 push CSV → D1（配合 `push-delta.ts`） |
| `scripts/test-composite.ts` | Local test：`/analyze/top-picks` composite logic |

## 注意：Cloudflare D1 限制

**唔接受 `BEGIN;...COMMIT;`**。用 `INSERT OR REPLACE INTO ... VALUES (...)` 裸 SQL 或 transaction JS API。`push-delta.ts` 已經唔再 emit BEGIN/COMMIT wrapper（見 commit `5788a65`）。

## Composite Prediction Logic（2026-04-28 spec）

```
score = ELO_composite + Σ(factor_i × weight_i)
  where ELO_composite = 0.7 × horse_elo + 0.2 × jockey_elo + 0.1 × trainer_elo

  factors = {
    recency:    ±15 (14-28d sweet spot)
    distance:   ±20 (top-3 rate @ bucket)
    going:      ±15
    draw:       ±10 (venue × distance bias)
    weight:     ±10 (delta from career avg)
    condition:  ±15 (trackwork recency / quality)
    injury:     -30 if active flag
    jtCombo:    ±10 (jockey × trainer synergy)
  }
```

ELO snapshots 查詢用 `as_of_date < raceDate` 防止 look-ahead，但 cumulative stats on `horses.total_wins/total_starts` 係 live-updated → **小心 leakage**（見 Open issue）。

## Open issues

### 🚨 Data leakage in `winRate` (2026-04-30 flagged)

`src/routes/analyze.ts:468,542` 用 `h.total_wins / h.total_starts` 計 winRate。呢個 field 喺 `import-csv.ts` ingest 之後即時 recompute，**包含當日賽果**。即係 query 2026-04-29 一場嘅 top-picks 時，winRate 已經 include 咗該場結果 → 贏咗嘅馬被 leakage 抬高。

**Fix 方向**：

```ts
// 改 query 為：
(SELECT COUNT(*) FROM race_results rr2 JOIN races r2 ON r2.id=rr2.race_id
  JOIN race_meetings rm2 ON rm2.id=r2.meeting_id
  WHERE rr2.horse_id = rr.horse_id AND rm2.date < ?) AS wins_pre,
(SELECT COUNT(*) FROM race_results rr3 JOIN races r3 ON r3.id=rr3.race_id
  JOIN race_meetings rm3 ON rm3.id=r3.meeting_id
  WHERE rr3.horse_id = rr.horse_id AND rm3.date < ?) AS starts_pre
```

### 其他 TODO

- [ ] Pre-race AI batch (`tools/pre_race_ai_batch.py`): T-2h 將每場 `/top-picks` snapshot 寫入新 `predictions_history` table
- [ ] Factor 2-6 implementation（目前 distance/going/draw/weight/condition/injury/jtCombo 部份 stub，只有 recency 全實裝）
- [ ] `prefers-reduced-motion` bypass 測試（chat 嘅 streaming animation）

## Changelog

- `5788a65` (2026-04-30) · `push-delta.ts`：加 `--include` selector · 砍 BEGIN/COMMIT wrapper（D1 incompat fix） · `horseRefUnion` 合併 race + pool-a sources
- `b525ec5` (2026-04-29) · init · Hono + D1 · routes 齊 · ELO v1.2 online
