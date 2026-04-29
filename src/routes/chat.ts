import { Hono } from 'hono';
import type { Env, ChatRequest } from '../types';
import { racingChat, parseUserIntent } from '../services/ai';

export const chatRoutes = new Hono<{ Bindings: Env }>();

/**
 * 反幻覺架構（Anti-Hallucination Gate）
 *
 * 流程：
 *   User Query → Intent Parser → Required Data Definition
 *               → DB Scan → Data Availability Gate
 *               → [若數據充足] AI with strict factual context
 *               → [若數據不足] 返回明確「暫無數據」訊息，不調用 AI
 *
 * 核心原則：AI 只能基於 DB 實際資料回答，絕不自由發揮
 */

interface DataAvailability {
  meetingFound: boolean;
  racesFound: number;
  horsesFound: number;
  horseFormFound: number;
  jockeyStatsFound: boolean;
  trainerStatsFound: boolean;
  sectionalDataFound: number;
  trackworkFound: number;
  trialsFound: number;
  oddsFound: number;
  missingFactors: string[]; // 🔴 PENDING 嘅工具列表
}

// 反資料洩漏 (Result Blind Gate)：
//   歷史賽事 + 預測意圖 → AI 一定要盲測，唔俾睇賽果
//   歷史賽事 + 回顧意圖 → AI 可以睇賽果，做事後分析
type ChatMode = 'blind_prediction' | 'recap' | 'general';

function decideMode(intent: any, message: string): ChatMode {
  const recapKeywords = ['回顧', '點解', '邊匹贏', '賽果', '分析上場', '事後', '檢討', '贏咗', '點解贏', 'recap'];
  const isRecap = recapKeywords.some(k => message.includes(k));
  if (isRecap) return 'recap';

  const predictionIntents = ['bet_suggestion', 'horse_analysis', 'jockey_analysis', 'trainer_analysis'];
  if (predictionIntents.includes(intent?.action)) return 'blind_prediction';

  return 'general';
}

// 決定某個 intent 所需嘅最低數據
function requiredDataForIntent(intent: string): string[] {
  switch (intent) {
    case 'bet_suggestion':
      return ['meeting', 'race', 'horses'];
    case 'horse_analysis':
      return ['horse', 'horseForm'];
    case 'jockey_analysis':
      return ['jockey', 'jockeyStats'];
    case 'trainer_analysis':
      return ['trainer', 'trainerStats'];
    case 'general_question':
      return []; // 一般問題可以答
    default:
      return [];
  }
}

chatRoutes.post('/', async (c) => {
  const body = await c.req.json<ChatRequest>();
  const { message, raceDate, raceNumber, conversationHistory } = body;

  if (!message) {
    return c.json({ error: '請輸入問題' }, 400);
  }

  try {
    // ========== Step 1: Intent Parser ==========
    const intent = await parseUserIntent(c.env, message);

    const targetDate = raceDate || new Date().toISOString().split('T')[0];
    const targetRaceNumber = raceNumber || intent.raceNumber;

    // 決定對話模式（盲測預測 / 事後回顧 / 一般）
    const mode = decideMode(intent, message);

    // ========== Step 2: DB Scan — 查詢一切可用數據 ==========
    let raceData: any = null;
    let horseFormData: any[] = [];
    const availability: DataAvailability = {
      meetingFound: false,
      racesFound: 0,
      horsesFound: 0,
      horseFormFound: 0,
      jockeyStatsFound: false,
      trainerStatsFound: false,
      sectionalDataFound: 0,
      trackworkFound: 0,
      trialsFound: 0,
      oddsFound: 0,
      missingFactors: [],
    };

    // 查賽事
    const meeting = await c.env.DB.prepare(
      'SELECT * FROM race_meetings WHERE date = ? ORDER BY date DESC LIMIT 1'
    ).bind(targetDate).first<any>();

    if (meeting) {
      availability.meetingFound = true;

      let racesQuery = 'SELECT * FROM races WHERE meeting_id = ?';
      const raceParams: unknown[] = [meeting.id];

      if (targetRaceNumber) {
        racesQuery += ' AND race_number = ?';
        raceParams.push(targetRaceNumber);
      }
      racesQuery += ' ORDER BY race_number';

      const { results: races } = await c.env.DB.prepare(racesQuery).bind(...raceParams).all();
      availability.racesFound = races?.length ?? 0;

      const racesWithHorses = await Promise.all(
        (races ?? []).map(async (race: any) => {
          const { results: entries } = await c.env.DB.prepare(`
            SELECT
              rr.*, h.name_en, h.name_ch, h.code, h.sire, h.dam, h.current_rating,
              h.total_starts, h.total_wins, h.country_of_origin AS country, h.sex,
              j.name_en AS jockey_en, j.name_ch AS jockey_ch,
              t.name_en AS trainer_en, t.name_ch AS trainer_ch
            FROM race_results rr
            JOIN horses h ON h.id = rr.horse_id
            LEFT JOIN jockeys j ON j.id = rr.jockey_id
            LEFT JOIN trainers t ON t.id = rr.trainer_id
            WHERE rr.race_id = ?
            ORDER BY rr.horse_number
          `).bind(race.id).all();

          availability.horsesFound += entries?.length ?? 0;

          // ========== FTS (First-Time Starter) Detection + Factor Availability ==========
          // 對每匹馬，計算過往出賽次數（嚴格 < targetDate，避免未來數據洩漏）
          const horseFactorMap: Record<string, any> = {};
          for (const e of (entries ?? []) as any[]) {
            const pastStartsRow = await c.env.DB.prepare(`
              SELECT COUNT(*) AS n FROM race_results rr
              JOIN races r ON r.id = rr.race_id
              JOIN race_meetings rm ON rm.id = r.meeting_id
              WHERE rr.horse_id = ?
                AND rr.finishing_position IS NOT NULL
                AND rm.date < ?
            `).bind(e.horse_id, targetDate).first<any>();
            const pastStarts = Number(pastStartsRow?.n ?? 0);
            const isFTS = pastStarts === 0;

            // 試閘次數（< targetDate）
            const trialsRow = await c.env.DB.prepare(`
              SELECT COUNT(*) AS n FROM barrier_trials
              WHERE horse_id = ? AND trial_date < ?
            `).bind(e.horse_id, targetDate).first<any>();
            const pastTrials = Number(trialsRow?.n ?? 0);

            // 決定可用因子
            const available: string[] = [];
            const unavailable: string[] = [];

            if (pastStarts > 0) available.push('past_form', 'past_pace', 'class_performance', 'venue_record');
            else unavailable.push('past_form', 'past_pace', 'class_performance', 'venue_record');

            if (pastTrials > 0) available.push('barrier_trials');
            else unavailable.push('barrier_trials');

            // 以下因子對所有馬都有效（只要 entry list 有）
            available.push('draw_advantage', 'jockey_trainer_combo', 'gear_analysis', 'breeding_fit', 'market_support', 'trackwork');

            horseFactorMap[String(e.horse_id)] = {
              isFTS,
              pastStarts,
              pastTrials,
              available,
              unavailable,
            };
          }

          // 查分段時間 — 注意：呢啲係 IN-RACE 量度出嚟，屬 POST-RACE 資料
          // 盲測模式下唔可以俾 AI 睇本場自己嘅分段時間
          const { results: sectionals } = await c.env.DB.prepare(`
            SELECT hst.*, rr.horse_number, h.name_ch AS horse_name
            FROM horse_sectional_times hst
            JOIN horses h ON h.id = hst.horse_id
            JOIN race_results rr ON rr.race_id = hst.race_id AND rr.horse_id = hst.horse_id
            WHERE hst.race_id = ?
          `).bind(race.id).all();
          availability.sectionalDataFound += sectionals?.length ?? 0;

          // 查即時賠率快照（opening / snapshot / closing）
          // 呢個係 PRE-RACE 因子，永遠可見；資金流向係冷熱判斷嘅重要訊號
          const { results: oddsSnaps } = await c.env.DB.prepare(`
            SELECT horse_id, win_odds, place_odds, pool_investment, odds_type, timestamp
            FROM odds_snapshots
            WHERE race_id = ?
            ORDER BY timestamp ASC
          `).bind(race.id).all();
          availability.oddsFound += oddsSnaps?.length ?? 0;

          // 按馬匯總：opening / latest + 走勢
          const oddsByHorse: Record<string, any> = {};
          for (const s of ((oddsSnaps ?? []) as any[])) {
            const hid = String(s.horse_id);
            if (!oddsByHorse[hid]) {
              oddsByHorse[hid] = { opening: null, latest: null, trend: [], poolFlow: [] };
            }
            const bucket = oddsByHorse[hid];
            if (s.odds_type === 'opening' && !bucket.opening) bucket.opening = s.win_odds;
            bucket.latest = s.win_odds;
            bucket.trend.push({ t: s.timestamp, w: s.win_odds });
            if (s.pool_investment != null) bucket.poolFlow.push({ t: s.timestamp, v: s.pool_investment });
          }

          // 判定本場係咪「已開跑」— 只要有馬匹 finishing_position NOT NULL 即 post-race
          const isHistorical = (entries ?? []).some((e: any) => e.finishing_position != null);
          const blindThisRace = mode === 'blind_prediction' && isHistorical;

          // 判定本場係咪「預賽」（排位表出咗但未開跑） — 所有馬 finishing_position 全 NULL
          const isEntryListOnly = (entries ?? []).every((e: any) => e.finishing_position == null);

          return {
            raceNumber: race.race_number,
            title: race.title,
            distance: race.distance,
            class: race.class,
            going: race.going,
            track: race.track,
            horses: (entries ?? []).map((e: any) => {
              const fm = horseFactorMap[String(e.horse_id)] ?? {};
              const od = oddsByHorse[String(e.horse_id)] ?? {};
              // 判斷盤口冷熱趨勢
              let oddsDrift: string | null = null;
              if (od.opening != null && od.latest != null) {
                const delta = od.latest - od.opening;
                const pct = od.opening > 0 ? (delta / od.opening) * 100 : 0;
                if (pct <= -15) oddsDrift = 'sharp_drop'; // 急跌 → 資金支持
                else if (pct <= -5) oddsDrift = 'drop'; // 緩跌
                else if (pct >= 15) oddsDrift = 'sharp_rise'; // 急升 → 冷淡
                else if (pct >= 5) oddsDrift = 'rise';
                else oddsDrift = 'stable';
              }
              return {
                horseNumber: e.horse_number,
                name: e.name_en,
                nameCh: e.name_ch,
                draw: e.draw,
                jockey: e.jockey_en,
                jockeyCh: e.jockey_ch,
                trainer: e.trainer_en,
                trainerCh: e.trainer_ch,
                // ⛔ POST-RACE FIELDS — 盲測模式下一律剝離
                finishingPosition: blindThisRace ? null : e.finishing_position,
                finishTime: blindThisRace ? null : e.finish_time,
                runningPosition: blindThisRace ? null : e.running_position,
                // ✅ PRE-RACE FIELDS — 永遠可見
                winOdds: e.win_odds, // race_results 儲嘅 final odds；若有 opening，以 oddsOpening 為準
                oddsOpening: od.opening ?? null,
                oddsLatest: od.latest ?? null,
                oddsDrift, // 'sharp_drop' | 'drop' | 'stable' | 'rise' | 'sharp_rise' | null
                poolFlowSamples: (od.poolFlow ?? []).length,
                gear: e.gear,
                rating: e.current_rating,
                sire: e.sire,
                dam: e.dam,
                totalStarts: e.total_starts,
                totalWins: e.total_wins,
                country: e.country,
                sex: e.sex,
                // 🆕 因子可用性（FTS 等）
                isFTS: !!fm.isFTS,
                pastStarts: fm.pastStarts ?? 0,
                pastTrials: fm.pastTrials ?? 0,
                factorsAvailable: fm.available ?? [],
                factorsUnavailable: fm.unavailable ?? [],
              };
            }),
            // 盲測模式下唔俾 AI 睇本場自己嘅分段時間（呢啲係 in-race 量度）
            sectionals: blindThisRace ? [] : (sectionals ?? []),
            isHistorical,
            isEntryListOnly,
            blindMode: blindThisRace,
          };
        })
      );

      raceData = {
        date: meeting.date,
        venue: meeting.venue,
        trackCondition: meeting.track_condition,
        weather: meeting.weather,
        races: racesWithHorses,
      };

      // 特定馬匹查詢 — 近績 + 試閘 + 晨操
      if (intent.horseName) {
        const horse = await c.env.DB.prepare(
          'SELECT * FROM horses WHERE name_ch LIKE ? OR name_en LIKE ? LIMIT 1'
        ).bind(`%${intent.horseName}%`, `%${intent.horseName}%`).first<any>();

        if (horse) {
          // 盲測模式下，近績必須嚴格 < targetDate，杜絕「未來數據」洩漏
          const formCutoff = mode === 'blind_prediction' ? targetDate : '9999-12-31';

          const { results: form } = await c.env.DB.prepare(`
            SELECT rm.date, rm.venue, r.race_number, r.distance, r.class, r.going,
              rr.finishing_position AS position, rr.draw, rr.finish_time, rr.win_odds,
              rr.running_position, rr.gear,
              j.name_ch AS jockey, t.name_ch AS trainer
            FROM race_results rr
            JOIN races r ON r.id = rr.race_id
            JOIN race_meetings rm ON rm.id = r.meeting_id
            LEFT JOIN jockeys j ON j.id = rr.jockey_id
            LEFT JOIN trainers t ON t.id = rr.trainer_id
            WHERE rr.horse_id = ? AND rm.date < ?
            ORDER BY rm.date DESC LIMIT 10
          `).bind(horse.id, formCutoff).all();

          const { results: trials } = await c.env.DB.prepare(`
            SELECT trial_date AS date, finishing_position AS position, time AS finish_time, comment
            FROM barrier_trials
            WHERE horse_id = ? AND trial_date < ?
            ORDER BY trial_date DESC LIMIT 5
          `).bind(horse.id, formCutoff).all();

          const { results: trackwork } = await c.env.DB.prepare(`
            SELECT date, track, time, comment
            FROM trackwork
            WHERE horse_id = ? AND date < ?
            ORDER BY date DESC LIMIT 5
          `).bind(horse.id, formCutoff).all();

          availability.horseFormFound = form?.length ?? 0;
          availability.trialsFound = trials?.length ?? 0;
          availability.trackworkFound = trackwork?.length ?? 0;

          horseFormData.push({
            horse: {
              nameCh: horse.name_ch,
              nameEn: horse.name_en,
              currentRating: horse.current_rating,
              totalStarts: horse.total_starts,
              totalWins: horse.total_wins,
              sire: horse.sire,
              dam: horse.dam,
              damSire: horse.dam_sire,
            },
            recentForm: form ?? [],
            trials: trials ?? [],
            trackwork: trackwork ?? [],
          });
        }
      }
    }

    // 標記未實現嘅工具（🔴 PENDING）
    availability.missingFactors = [
      '傷患紀錄', '馬匹搬遷紀錄', 'SpeedPRO 速勢能量',
    ];

    // ========== Step 3: Data Availability Gate ==========
    const required = requiredDataForIntent(intent.action);
    const insufficientForBet = intent.action === 'bet_suggestion' &&
      (!availability.meetingFound || availability.horsesFound === 0);
    const insufficientForHorse = intent.action === 'horse_analysis' &&
      availability.horseFormFound === 0;

    if (insufficientForBet) {
      return c.json({
        message: `📊 數據閘報告：\n\n目前資料庫冇 ${targetDate}${targetRaceNumber ? ` 第 ${targetRaceNumber} 場` : ''} 嘅賽事資料。\n\n可能原因：\n• 當日冇賽事\n• 賽事數據尚未採集/導入\n• 日期格式有誤\n\n建議：\n• 查詢其他已有賽事日期（可用 /api/meetings 列出可用日期）\n• 等待下一個賽馬日（通常週三跑馬地夜賽 / 週日沙田日賽）\n• 若確認應有數據，請聯繫系統管理員檢查 CSV 導入流程`,
        metadata: {
          raceDate: targetDate,
          raceNumber: targetRaceNumber,
          intent: intent.action,
          betType: intent.betType,
          dataGate: 'INSUFFICIENT',
          availability,
        },
      });
    }

    if (insufficientForHorse) {
      return c.json({
        message: `📊 數據閘報告：\n\n無法搵到馬匹「${intent.horseName}」嘅近績資料。可能係：\n• 馬名拼寫稍有差異（試試用中文全名 / 英文名 / 馬號）\n• 該馬未有歷史賽績（新馬 / 海外馬）\n• 數據尚未完整導入\n\n請提供更完整嘅馬匹名稱，或查詢其他馬匹。`,
        metadata: {
          raceDate: targetDate,
          intent: intent.action,
          horseName: intent.horseName,
          dataGate: 'INSUFFICIENT',
          availability,
        },
      });
    }

    // ========== Step 4: 調用 AI（含嚴格 context + 可用性提示）==========
    // 強化反幻覺：若 context 空，AI 要誠實回應
    const factualNoticeParts: string[] = [];
    if (!availability.meetingFound) {
      factualNoticeParts.push(`⚠️ 資料庫中 ${targetDate} 冇賽事紀錄`);
    }
    if (availability.missingFactors.length > 0) {
      factualNoticeParts.push(`⚠️ 以下工具尚未接駁，絕不可以編造相關資料：${availability.missingFactors.join('、')}`);
    }

    // ========== Result Blind Gate 提示 ==========
    if (mode === 'blind_prediction') {
      factualNoticeParts.push(
        `🔒 **盲測模式 (Blind Prediction Mode)**：\n` +
        `• 此場可能係歷史賽事，但系統已嚴格剝離所有 POST-RACE 資料。\n` +
        `• Context 中 finishingPosition/finishTime/runningPosition 全部係 null。\n` +
        `• 本場自己嘅分段時間亦已隱藏（只能引用此馬匹過往其他場嘅分段）。\n` +
        `• 近績查詢只包含 targetDate 之前嘅資料，冇未來洩漏。\n` +
        `• 你必須根據 PRE-RACE 資料（檔位、騎師、練馬師、評分、血統、配備、過往近績）做獨立判斷，絕對唔可以「靠估果」。`
      );
    } else if (mode === 'recap') {
      factualNoticeParts.push(
        `📜 **事後回顧模式 (Recap Mode)**：\n` +
        `• 此場已跑完，賽果已提供俾你。\n` +
        `• 你嘅任務係分析「點解果匹馬贏」— 要引用具體分段時間、走位、騎師策略等。\n` +
        `• 唔好扮成預測，直接做賽後 case study。`
      );
    }

    // ========== 排位表模式（上車邏輯）==========
    const anyEntryListOnly = raceData?.races?.some((r: any) => r.isEntryListOnly) ?? false;
    if (anyEntryListOnly) {
      factualNoticeParts.push(
        `📋 **排位表模式 (Entry List Mode)**：\n` +
        `• 本場賽事嘅排位表已出，但尚未開跑（所有 finishingPosition 為 null 係正常）。\n` +
        `• 系統已基於排位表可用數據進行預測：檔位、騎練配對、配備、過往近績、試閘、晨操、即時賠率（若有）。\n` +
        `• 你可以俾出 PRE-RACE 獨立判斷，但**必須標示預測信心度**（高/中/低）及使用嘅主要因子。`
      );
    }

    // ========== FTS (初出馬) 處理 ==========
    const ftsHorsesGlobal: Array<{ raceNum: number; horseNum: number; name: string; pastTrials: number }> = [];
    for (const r of (raceData?.races ?? [])) {
      for (const h of (r.horses ?? [])) {
        if (h.isFTS) {
          ftsHorsesGlobal.push({
            raceNum: r.raceNumber,
            horseNum: h.horseNumber,
            name: h.nameCh || h.name,
            pastTrials: h.pastTrials ?? 0,
          });
        }
      }
    }
    if (ftsHorsesGlobal.length > 0) {
      const listStr = ftsHorsesGlobal
        .map(f => `  - 第${f.raceNum}場 ${f.horseNum}號 ${f.name}（過往試閘 ${f.pastTrials} 次）`)
        .join('\n');
      factualNoticeParts.push(
        `🐎 **初出馬處理 (First-Time Starter Protocol)**：\n` +
        `本場共有 ${ftsHorsesGlobal.length} 匹初出馬（過往正式出賽 = 0）：\n${listStr}\n\n` +
        `對於初出馬，以下因子**唔可用**，絕對不可捏造：\n` +
        `  ❌ 過往近績 (past_form)\n` +
        `  ❌ 歷史步速 (past_pace)\n` +
        `  ❌ 級數成績 (class_performance)\n` +
        `  ❌ 場地紀錄 (venue_record)\n\n` +
        `可用嘅替代因子：\n` +
        `  ✅ 試閘表現 (barrier_trials) — 若過往試閘 > 0\n` +
        `  ✅ 血統配合 (breeding_fit) — 父系/母系適合距離、場地\n` +
        `  ✅ 晨操表現 (trackwork)\n` +
        `  ✅ 檔位優勢 (draw_advantage)\n` +
        `  ✅ 騎練配對 (jockey_trainer_combo)\n` +
        `  ✅ 配備分析 (gear_analysis)\n` +
        `  ✅ 資金流向 / 即時賠率 (market_support)\n\n` +
        `初出馬信心度必須降低，建議標明「首出馬，信心偏低，僅作腳部腳色」或避免作為膽。`
      );
    }

    factualNoticeParts.push(
      `⚠️ 反幻覺指引：你只可以引用上面 context 中明確列出嘅馬名、騎師、練馬師、數字。如果 context 冇呢個資料，必須回答「目前資料庫冇呢項數據」，絕對不可以捏造馬匹/騎師/賠率/時間等任何數字。` +
      `對每匹馬嘅 factorsAvailable / factorsUnavailable 欄位，你必須嚴格遵守 — 冇喺 available list 嘅因子一律唔可以用。`
    );

    const factualNotice = factualNoticeParts.join('\n\n');

    const aiResponse = await racingChat(
      c.env,
      message + `\n\n[系統提示（AI 必讀）]\n${factualNotice}`,
      raceData,
      horseFormData,
      undefined,  // TimesFM predictions (optional)
      conversationHistory
    );

    // 判定本場整體係咪 historical
    const anyHistorical = raceData?.races?.some((r: any) => r.isHistorical) ?? false;

    return c.json({
      message: aiResponse,
      metadata: {
        raceDate: targetDate,
        raceNumber: targetRaceNumber,
        intent: intent.action,
        betType: intent.betType,
        dataGate: 'OK',
        mode, // 'blind_prediction' | 'recap' | 'general'
        isHistorical: anyHistorical,
        isEntryListOnly: anyEntryListOnly,
        resultBlindGate: mode === 'blind_prediction' && anyHistorical ? 'ENFORCED' : 'NOT_APPLICABLE',
        ftsHorses: ftsHorsesGlobal,
        ftsCount: ftsHorsesGlobal.length,
        availability,
      },
    });
  } catch (err: any) {
    console.error('Chat error:', err);
    return c.json({
      error: '分析時發生錯誤，請稍後再試',
      details: err.message,
    }, 500);
  }
});
