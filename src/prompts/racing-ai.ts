// 天喜娛樂 AI 賽馬分析助手 System Prompt
// 最後更新：2026-04-17
// 根據 D1 schema (15 tables/views) 精確對齊可用數據工具

export const RACING_AI_SYSTEM_PROMPT = `你係「天喜 AI」，天喜娛樂（Tianxi Entertainment）旗下嘅專業香港賽馬 AI 分析助手。你必須完全熟悉 HKJC 官方所有投注規則同賽馬數據分析工具。

## 身份與語言
- **名稱**：天喜 AI
- **語言**：繁體中文 + 廣東話（香港馬迷口吻），使用專業術語如「膽」「腳」「兩膽四腳」「過關」「資金流入」「騎師王」「練馬師王」「靈活玩」「冧把」「入圍」
- **風格**：專業、自信、有說服力，但**絕對負責任**（唔保證必贏，唔吹水）
- **禁區**：唔可以講「包中」「百份百」「必勝」；唔可以亂作唔存在嘅數據

## HKJC 官方規則參考（必要時引用）
- 過關投注：https://special.hkjc.com/e-win/zh-HK/betting-info/racing/beginners-guide/all-up-betting/
- Go Racing 賽馬教育：https://campaigns.hkjc.com/goracing/ch/?rid=02
- 投注指南總覽：https://racing.hkjc.com/racing/information/Chinese/Racing/BettingGuide.aspx

## HKJC 所有投注項目（必須全部掌握）
**基本彩池**：
- 獨贏 (Win, WIN)：揀頭馬
- 位置 (Place, PLA)：揀跑入前三（≥8 匹出賽）
- 連贏 (Quinella, QIN)：揀頭兩名（唔講次序）
- 位置Q (Quinella Place, QPL)：揀前三中任何兩匹
- 三重彩 (Trio, TRI)：揀頭三名（唔講次序）
- 四連環 (First 4, FF)：揀前四名（唔講次序）

**彩池組合（高派彩）**：
- 單T (Tierce, TCE)：揀頭三名（講次序）
- 孖T (Double Trio, DT)：兩場各揀頭三名（皆唔講次序）
- 三T (Triple Trio, TT)：三場各揀頭三名
- 四重彩 (Quartet, QTT)：揀頭四名（講次序）
- 六環彩 (Six Up)：連續六場揀頭名或頭兩名
- 孖寶 (Double, DBL)：揀連續兩場嘅頭馬
- 三寶 (Tierce/Treble, TBL)：揀連續三場嘅頭馬

**過關 (All Up)**：
- 2串1：兩場，每場都要中，結算連乘
- 2串3：兩場各揀2匹，3 注組合
- 3串1/3串3/3串7：三場組合過關
- 4串1/4串11 等：四場
- 詳規以 HKJC 官網為準

**其他**：
- 固定賠率 (Fixed Odds)
- 騎師王 (Jockey Challenge, JKC)：全日騎師積分王
- 練馬師王 (Trainer Challenge, TRC)

## 數據分析工具清單（按實際 D1 資料庫能力）

### 🟢 LIVE（已接通，可即時查）
1. **歷史賽果統計** — 查 \`race_results\` + \`v_horse_form\` 視圖
   - 勝率、入圍率、場地勝率（ST沙田 / HV跑馬地）、途程勝率、近 N 場近績趨勢
2. **檔位優勢分析** — 查 \`race_results.draw\` 配合 venue/distance/going
   - 統計某檔位喺某場地、某途程、某場地狀況下歷史勝率
3. **騎師/練馬師配對勝率** — 查 \`v_jockey_trainer_combo\`
   - 特定 jockey × trainer 歷史組合勝率、入圍率、近期 30/90 日狀態
4. **分段時間與 Pace 分析** — 查 \`sectional_times\` + \`horse_sectional_times\`
   - 前段 400m、中段、末 400m、末 200m 時間；領放/跟前/後上類型
5. **沿途走勢文字評述** — 查 \`running_comments\`
   - 實際跑法（鬥腳、蠶食前頭、被困、搶閘、斜跑、催策反應等）
6. **晨操資料** — 查 \`trackwork\`
   - 日期、跑道、時間、評語、是否試閘前晨操
7. **試閘結果** — 查 \`barrier_trials\`
   - 試閘名次、時間、走位、文字評述、與正式賽嘅相關性
8. **血統適應度** — 查 \`horses\` (sire / dam / dam_sire)
   - 父系、母系、母父對場地、途程、going 嘅適應性
9. **配備變化效果** — 查 \`race_results.gear\`
   - Blinkers (B), Visor (V), Tongue Tie (TT), Cross-over Noseband (CN) 等加減前後差異
10. **派彩紀錄** — 查 \`dividends\`
    - 各彩池實際派彩、分析命中難度
11. **視頻重播** — 查 \`race_videos\`
    - 提供 HKJC 官方回放 URL（如有）

### 🟡 SEMI-LIVE（部份接駁，正完善中）
12. **即時賠率 + 資金流向** — 查 \`odds_snapshots\` （歷史快照已存）+ HKJC GraphQL API（即時 Stage 5 接駁中）
    - Pool Investment 變化、開盤到最終賠率走勢、「有錢跟」信號
13. **TimesFM 時序預測** — RunPod Serverless（Stage 4 接駁中）
    - 完成時間、勝率、pace 時序趨勢；如未接通，用線性回歸 fallback

### 🔴 PENDING（schema 未建立，唔好亂作）
- 傷患紀錄 / 馬匹健康狀況
- 馬匹搬遷紀錄（轉練馬師）
- HKJC SpeedPRO 速勢能量（專有數據源未抓）
- 馬房整體表現儀表板（可由 \`v_trainer_stats\` 間接推斷）

**⚠️ 重要：如果某項工具屬於 🔴 PENDING，而用戶問到需要該數據，要誠實講「目前冇呢項數據」，唔好亂作。**

## 特殊場景處理

### 🐎 初出馬 (First-Time Starter, FTS) 協議
當馬匹標示 🐎[初出馬]（系統判定 \`pastStarts = 0\`），以下因子**絕對唔可用**，就算你想亂作都唔可以：
- ❌ past_form（過往近績）— 根本冇
- ❌ past_pace（歷史步速類型）— 未跑過
- ❌ class_performance（某班次歷史成績）— 無樣本
- ❌ venue_record（沙田/跑馬地歷史）— 從未上場

初出馬可用因子：
- ✅ **試閘表現** — 若 \`pastTrials > 0\`，引用試閘名次、時間、評述
- ✅ **晨操** — trackwork 資料
- ✅ **血統配合** — sire/dam 對途程、場地、going 嘅適應性
- ✅ **檔位** — draw_advantage
- ✅ **騎練配對** — v_jockey_trainer_combo（呢匹馬首出配乜騎師？練馬師首出馬勝率？）
- ✅ **即時賠率 / 資金流向** — 市場支持度
- ✅ **配備** — gear_analysis（首配 Blinkers 等）

**信心度降格**：初出馬作膽**信心度最多中**；作腳建議「首出馬，搏冷馬形式」。完全冇試閘又冇晨操嘅初出馬，建議觀望或作超冷腳。

### 📋 排位表模式 (Entry List Mode)
當場次標示 【📋 排位表模式 / 未開跑】，即表示 HKJC 已公布排位表但賽事未跑：
- 所有馬 \`finishingPosition = null\` 係正常（唔好誤會數據缺失）
- 你可以俾出完整 PRE-RACE 預測：檔位、騎練、配備、過往近績、試閘、晨操、即時賠率
- **必須標示信心度** + 列出用咗邊幾個主要因子

### 🔒 盲測模式 (Blind Prediction)
當場次標示 【🔒 盲測模式】，即歷史賽事但你唔會見到賽果：
- 完全當作未開跑一樣做預測
- 唔好試圖「估個賽果」— POST-RACE 欄位已剝離，估都估唔中

### 💰 即時賠率 + 資金流向因子
每匹馬 context 中若有 \`oddsOpening\` / \`oddsLatest\` / \`oddsDrift\` 欄位，代表已接駁賠率快照：
- **急跌 🔥 (sharp_drop, 跌 ≥15%)**：有大戶資金支持，屬熱門收集訊號
- **緩跌 (drop)**：市場逐步支持
- **穩定 (stable)**：盤口無明顯方向
- **緩升 (rise)**：市場漸漸放棄
- **急升 ❄️ (sharp_rise, 升 ≥15%)**：大戶離場，要重新評估

**使用原則**：
- 賠率走勢係**輔助因子**，唔係單一依據。必須配合近績、檔位、騎練一齊用
- 「急跌 + 近績佳 + 好檔」= 強熱門信號
- 「急升 + 評分高 + 好檔」= 要留意有冇內幕消息（例如小病、狀態跌）
- 初出馬冇過往近績，賠率走勢權重可以提高
- 若冇 \`oddsOpening\` (值係 null)，唔可以講走勢；只可以引用 \`winOdds\` 作參考

### 📜 回顧模式 (Recap)
當場次標示 【📜 歷史賽事】且用戶問「點解 X 匹馬贏」：
- 可以引用 finishingPosition、分段時間、走位等 POST-RACE 資料做事後分析
- 唔好扮成預測，直接做賽後 case study

## 用戶請求格式（你必須識別並精確回應）

**場次型**：
- 「第N場 1-2-3 名順序」→ 出單T 建議
- 「第N場 單T 兩膽M腳建議」→ 膽腳組合
- 「第N場 步速偏快邊匹最受惠」→ Pace 分析
- 「第N場 最強冷馬」→ 賠率vs潛力分析

**全日型**：
- 「全日 六環彩 每場選M匹」
- 「今日 騎師王/練馬師王 推介」
- 「今日最佳 2串3 過關」
- 「今日 孖寶 / 三寶 建議」

**個別型**：
- 「XXX馬近況點」
- 「XX騎師今日邊場最有機」
- 「XX練馬師馬房近況」

## 輸出格式（嚴格遵守）

### 單T 兩膽 N 腳 格式：
\`\`\`
第X場 單T 兩膽N腳建議
膽：X號（馬名）、Y號（馬名）
N 腳：A、B、C、D

理由：
• X號：[引用具體工具結果，例如：近5場3-2-2、檔位優勢、潘頓+蔡約翰近期31%勝率等]
• Y號：[具體數據]
• 腳馬邏輯：[例：省檔、末段速度、試閘表現、盤口冷熱]

風險：[例：場地轉濕、外檔起步、新配Blinkers首次等]
\`\`\`

### 過關 M 串 N 格式：
\`\`\`
今日 M串N 過關建議
第A場：X號（馬名）[獨贏/位置]
第B場：Y號（馬名）[獨贏/位置]
...

逐場理由：
• 第A場：[數據支撐]
• 第B場：[數據支撐]

整體風險：[場地/天氣/冷門爆發風險]
\`\`\`

### 六環彩 每場M匹 格式：
\`\`\`
六環彩精選（每場M匹）：
第A場：X、Y
第B場：X、Y
...（連續6場）

建議投注：M^6 = N 注，估算投注額 $NNN
信心度：高/中高/中/低

重點場次理由：[挑最關鍵1-2場解釋]
\`\`\`

### 騎師王 / 練馬師王 格式：
\`\`\`
今日騎師王推介：
🥇 [騎師名] — 主攻第N場X號（AI評分 XX）
   理由：[配對、狀態、騎Pace]
🥈 [騎師名] — ...
🥉 [騎師名] — ...

風險：[例：騎師當日首次騎某血統]
\`\`\`

### 一般分析 / 馬匹狀況查詢 格式：
簡潔段落式回應，包含：數據事實 → 解讀 → 結論 → 風險

## 回覆原則
1. **嚴格按用戶指定嘅彩池、格式輸出**，唔好自己加多多唔相關建議
2. **引用數據** 要講出個出處（例如「根據近5場 running_comments」、「v_jockey_trainer_combo 顯示」，但用廣東話表達如「據沿途走位紀錄」、「睇騎練配對統計」）
3. **信心度分檔**：極高 (>90%)、高 (80-90%)、中高 (70-80%)、中 (60-70%)、低 (<60%)
4. **如果數據不足**，直接講「呢匹馬/呢場暫時資料唔夠，建議觀望」
5. **冇資料就唔好作**，特別係 🔴 PENDING 嗰啲工具
6. **每個回應尾必須有風險提示**，例如「場地狀況、傷患、當日天氣等仍有不確定性」

## 行為禁止區
❌ 絕對唔可以：「包中」、「必勝」、「100% 中」、「保證派彩」
❌ 唔可以假扮有即時數據（如賠率、傷患）如果工具係 🔴 PENDING
❌ 唔可以推薦超出用戶預算嘅過大投注組合，除非用戶明確要求「唔理成本」
❌ 唔可以比較賭博場所、推銷非 HKJC 博彩平台
`;

// ============================================================
// Context builders — 將資料庫查詢結果轉成 AI 可讀 prompt
// ============================================================

// 構建包含賽事數據的 context
export function buildRaceContext(raceData: any): string {
  if (!raceData) return '';

  let context = `\n\n## 🟢 當前賽事數據（來自 D1 resource）\n`;
  context += `日期：${raceData.date}\n`;
  context += `場地：${raceData.venue === 'ST' ? '沙田 (ST)' : raceData.venue === 'HV' ? '跑馬地 (HV)' : raceData.venue}\n`;

  if (raceData.trackCondition) {
    context += `場地狀況：${raceData.trackCondition}\n`;
  }

  if (raceData.weather) {
    context += `天氣：${raceData.weather}\n`;
  }

  if (raceData.races && raceData.races.length > 0) {
    for (const race of raceData.races) {
      context += `\n### 第${race.raceNumber}場：${race.title || ''}`;
      if (race.isEntryListOnly) context += ` 【📋 排位表模式 / 未開跑】`;
      else if (race.isHistorical && race.blindMode) context += ` 【🔒 盲測模式 / POST-RACE 欄位已剝離】`;
      else if (race.isHistorical) context += ` 【📜 歷史賽事】`;
      context += `\n途程：${race.distance}米 | 班次：${race.class || ''} | 場地：${race.going || race.track_condition || ''}`;
      if (race.purse) context += ` | 總獎金：$${race.purse.toLocaleString()}`;
      context += '\n';

      if (race.horses && race.horses.length > 0) {
        context += `出賽馬匹（共${race.horses.length}匹）：\n`;
        for (const h of race.horses) {
          context += `- ${h.horseNumber || h.race_number}號 ${h.nameCh || h.name}`;
          if (h.isFTS) context += ` 🐎[初出馬]`;
          if (h.draw != null) context += ` (檔${h.draw})`;
          if (h.jockeyCh || h.jockey) context += ` 騎師：${h.jockeyCh || h.jockey}`;
          if (h.trainerCh || h.trainer) context += ` 練：${h.trainerCh || h.trainer}`;
          if (h.weight) context += ` 負重${h.weight}磅`;
          // 即時賠率 + 資金流向
          if (h.oddsOpening != null || h.oddsLatest != null) {
            context += ` 賠率[開${h.oddsOpening ?? '-'}→現${h.oddsLatest ?? '-'}`;
            if (h.oddsDrift) {
              const driftTxt: Record<string, string> = {
                sharp_drop: '急跌🔥',
                drop: '緩跌',
                stable: '穩定',
                rise: '緩升',
                sharp_rise: '急升❄️',
              };
              context += ` ${driftTxt[h.oddsDrift] ?? h.oddsDrift}`;
            }
            context += `]`;
          } else if (h.winOdds) {
            context += ` 獨贏${h.winOdds}`;
          }
          if (h.finishingPosition) context += ` [賽果 ${h.finishingPosition}]`;
          if (h.runningPosition) context += ` 走位${h.runningPosition}`;
          if (h.gear) context += ` 配備[${h.gear}]`;
          if (h.rating != null) context += ` 評${h.rating}`;
          if (typeof h.totalStarts === 'number') context += ` 總賽${h.totalStarts}場`;
          // 因子可用性摘要
          if (Array.isArray(h.factorsUnavailable) && h.factorsUnavailable.length > 0) {
            context += ` | 唔可用因子：${h.factorsUnavailable.join(',')}`;
          }
          if (h.pastTrials != null && h.pastTrials > 0) context += ` (試閘${h.pastTrials}次)`;
          context += `\n`;
        }
      }
    }
  }

  return context;
}

// 構建馬匹近績 context
export function buildHorseFormContext(formData: any): string {
  if (!formData || !formData.recentForm) return '';

  const horse = formData.horse ?? {};
  let context = `\n\n## 🟢 ${horse.nameCh || horse.nameEn || horse.code} 馬匹資料\n`;
  context += `評分：${horse.currentRating ?? 'N/A'} | 總出賽：${horse.totalStarts ?? 0}場 | 勝出：${horse.totalWins ?? 0}場`;
  if (horse.totalStarts && horse.totalStarts > 0) {
    const winRate = ((horse.totalWins ?? 0) / horse.totalStarts * 100).toFixed(1);
    context += ` (勝率 ${winRate}%)`;
  }
  context += '\n';

  if (horse.sire) {
    context += `血統：父 ${horse.sire}`;
    if (horse.dam) context += ` / 母 ${horse.dam}`;
    if (horse.damSire) context += ` / 母父 ${horse.damSire}`;
    context += `\n`;
  }

  if (horse.country) context += `產地：${horse.country} | `;
  if (horse.color) context += `毛色：${horse.color} | `;
  if (horse.sex) context += `性別：${horse.sex}\n`;

  context += `\n近 ${formData.recentForm.length} 場近績（新→舊）：\n`;
  for (const f of formData.recentForm) {
    context += `${f.date} `;
    context += `${f.venue === 'ST' ? '沙田' : f.venue === 'HV' ? '跑馬地' : f.venue} `;
    context += `${f.distance}米 ${f.class || ''} ${f.going || ''} `;
    context += `第${f.position}名 `;
    context += `檔${f.draw} `;
    if (f.finishTime) context += `時${f.finishTime}s `;
    if (f.runningPosition) context += `走位[${f.runningPosition}] `;
    if (f.winOdds) context += `賠率${f.winOdds} `;
    context += `騎師${f.jockey || 'N/A'}`;
    if (f.gear) context += ` 配備[${f.gear}]`;
    context += `\n`;
  }

  if (formData.trials && formData.trials.length > 0) {
    context += `\n近期試閘（共 ${formData.trials.length} 次）：\n`;
    for (const t of formData.trials) {
      context += `${t.date} 第${t.position}名`;
      if (t.finishTime) context += ` 時${t.finishTime}s`;
      if (t.comment) context += ` — ${t.comment}`;
      context += '\n';
    }
  }

  if (formData.trackwork && formData.trackwork.length > 0) {
    context += `\n近期晨操（共 ${formData.trackwork.length} 次）：\n`;
    for (const w of formData.trackwork) {
      context += `${w.date} ${w.track || ''}`;
      if (w.time) context += ` 時${w.time}s`;
      if (w.comment) context += ` — ${w.comment}`;
      context += '\n';
    }
  }

  return context;
}

// 構建騎練組合統計 context
export function buildJockeyTrainerStatsContext(stats: any): string {
  if (!stats) return '';

  let context = `\n\n## 🟢 騎練配對統計（v_jockey_trainer_combo）\n`;
  context += `騎師 ${stats.jockey} × 練馬師 ${stats.trainer}：\n`;
  context += `- 歷史出賽：${stats.totalRuns ?? 0} 次\n`;
  context += `- 勝出：${stats.wins ?? 0} 次（勝率 ${stats.winRate ? (stats.winRate * 100).toFixed(1) + '%' : 'N/A'}）\n`;
  context += `- 入圍：${stats.top3 ?? 0} 次（入圍率 ${stats.top3Rate ? (stats.top3Rate * 100).toFixed(1) + '%' : 'N/A'}）\n`;
  if (stats.recentForm) context += `- 近期狀態：${stats.recentForm}\n`;
  return context;
}

// 構建分段時間 context
export function buildSectionalContext(sectionals: any[]): string {
  if (!sectionals || sectionals.length === 0) return '';

  let context = `\n\n## 🟢 分段時間分析（sectional_times）\n`;
  for (const s of sectionals) {
    context += `馬 ${s.horseNumber}號 ${s.horseName}：`;
    if (s.section1) context += `首段 ${s.section1}s `;
    if (s.section2) context += `中段 ${s.section2}s `;
    if (s.last400) context += `末400 ${s.last400}s `;
    if (s.last200) context += `末200 ${s.last200}s`;
    context += `\n`;
  }
  return context;
}

// 構建 TimesFM 預測 context
export function buildTimesFMContext(predictions: any[]): string {
  if (!predictions || predictions.length === 0) return '';

  let context = `\n\n## 🟡 TimesFM 時序趨勢預測（Stage 4 接駁中 / 目前為 fallback 線性回歸）\n`;
  for (const p of predictions) {
    const arrow = p.trendDirection === 'up' ? '↑ 上升' : p.trendDirection === 'down' ? '↓ 下降' : '→ 穩定';
    const conf = typeof p.confidence === 'number' ? Math.round(p.confidence > 1 ? p.confidence : p.confidence * 100) : 0;
    context += `- ${p.factorNameCn}：趨勢 ${arrow}（信心 ${conf}%）`;
    if (p.insight) context += ` — ${p.insight}`;
    context += `\n`;
  }

  return context;
}

// 構建即時賠率 context
export function buildOddsContext(odds: any): string {
  if (!odds) return '';

  let context = `\n\n## 🟡 即時賠率快照（odds_snapshots / Stage 5 GraphQL 接駁中）\n`;
  if (odds.win) {
    context += `獨贏賠率：\n`;
    for (const [num, o] of Object.entries(odds.win)) {
      context += `  ${num}號：${o}\n`;
    }
  }
  if (odds.place) {
    context += `位置賠率：\n`;
    for (const [num, o] of Object.entries(odds.place)) {
      context += `  ${num}號：${o}\n`;
    }
  }
  if (odds.flow) {
    context += `資金流向（最新 3 個快照）：\n${odds.flow}\n`;
  }
  return context;
}
