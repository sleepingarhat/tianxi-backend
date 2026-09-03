# 天喜後端 · tianxi-backend

天喜賽馬預測的生產 API 與 TX-Oracle v3.2 引擎。

公開站台：[tianxi.racing](https://tianxi.racing)

## 產品

TX-Oracle 對每場香港賽馬輸出獨贏、頭三、頭四機率與排名。模型用 LightGBM LambdaRank 學習名次順序，再與多軸 Elo 組合；臨場獨贏賠率只作參考欄，不進入排名模型。賽季中按賽程輸出訓練健康指標；休季自動暫停定時更新，開季後自動恢復。

截至上季最後一日（2026-07-15），引擎仍用當日凍結的預測紀錄，不改寫歷史戰績。

Elo 快照存於 D1。賽果本身按日同步；若快照缺月，由 `d1_fill_elo_gap` 工作流用 2016 起連續重算後只補缺口月份，不抹掉已有列、不改 LambdaRank 權重。

## 生態

| 倉 | 職責 |
|---|---|
| [tianxi-site](https://github.com/sleepingarhat/tianxi-site) | 公開站台 |
| [tianxi-database](https://github.com/sleepingarhat/tianxi-database) | 賽果與馬医 CSV |
| [tianxi-marksix](https://github.com/sleepingarhat/tianxi-marksix) | 六合彩命盤研究 |
| [hk-mark-six-2002-now](https://github.com/sleepingarhat/hk-mark-six-2002-now) | 六合彩攞珠紀錄 |

## 技術

- Cloudflare Workers（Hono）+ D1
- TX-Oracle v3.2：LambdaRank + Elo v12 + 因子補償
