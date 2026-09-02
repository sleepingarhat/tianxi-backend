# 天喜後端 · tianxi-backend

天喜賽馬預測的生產 API 與 TX-Oracle v3.2 引擎。

公開站台：[tianxi.racing](https://tianxi.racing)

## 產品

TX-Oracle 對每場香港賽馬輸出獨贏、頭三、頭四概率與排名。模型用 LightGBM LambdaRank 學習名次順序，再與多軸 Elo 進行組合；臨場獨贏賠率只作參考欄，不進入排名模型。賽季中按賽程輸出訓練健康指標；休季自動暫停定時更新，開季後自動恢復。

截至上季最後一日（2026-07-15），引擎仍用當日凍結的預測紀錄，不改寫歷史戰績。

## 技術

- Cloudflare Workers（Hono）+ D1
- TX-Oracle v3.2：LambdaRank + Elo v12 + 因子補償
- 前端：[tianxi-site](https://github.com/sleepingarhat/tianxi-site)
- 賽事數據：[tianxi-database](https://github.com/sleepingarhat/tianxi-database)
