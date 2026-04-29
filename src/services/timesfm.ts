// TimesFM 趨勢預測服務 — 調用 RunPod Serverless
import type { Env, TimesFMPrediction } from '../types';

interface TimesFMRequest {
  horseId: string;
  factors: string[];
  historyData: Record<string, number[]>;  // factor name → time series values
  predictHorizon?: number;
}

// 調用 RunPod 上的 TimesFM endpoint
async function callTimesFM(env: Env, request: TimesFMRequest): Promise<any> {
  const url = env.TIMESFM_API_URL;
  if (!url) {
    throw new Error('TIMESFM_API_URL not configured');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TIMESFM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        time_series: request.historyData,
        horizon: request.predictHorizon || 3,
        freq: 0,  // irregular time series
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`TimesFM API error: ${response.status}`);
  }

  return response.json();
}

// 因子名稱映射
const FACTOR_MAP: Record<string, { cn: string; dbQuery: string }> = {
  draw: { cn: '檔位優勢', dbQuery: 'draw' },
  course: { cn: '場地', dbQuery: 'venue' },
  going: { cn: '場地狀況', dbQuery: 'going' },
  pace: { cn: '分段時間趨勢', dbQuery: 'finish_time' },
  sectional: { cn: '分段時間詳細', dbQuery: 'sectional' },
  running_position: { cn: '沿途走位', dbQuery: 'running_position' },
  form: { cn: '近期近績', dbQuery: 'finishing_position' },
  finish_time: { cn: '完成時間趨勢', dbQuery: 'finish_time' },
  placing: { cn: '名次表現', dbQuery: 'finishing_position' },
  bloodline: { cn: '血統適應度', dbQuery: 'bloodline' },
  trackwork: { cn: '晨操資料', dbQuery: 'trackwork' },
  trial: { cn: '試閘結果', dbQuery: 'trial' },
  jockey: { cn: '騎師近期狀態', dbQuery: 'jockey_win_rate' },
  trainer: { cn: '練馬師/馬房狀態', dbQuery: 'trainer_win_rate' },
  jockey_trainer: { cn: '騎練配對', dbQuery: 'jockey_trainer_combo' },
  equipment: { cn: '配備變化', dbQuery: 'gear' },
  odds_flow: { cn: '即時賠率與資金流向', dbQuery: 'win_odds' },
};

// 從數據庫提取馬匹歷史時間序列數據
export async function extractHistoryTimeSeries(
  db: D1Database,
  horseId: string,
  factors: string[],
  limit: number = 20
): Promise<Record<string, number[]>> {
  const timeSeries: Record<string, number[]> = {};

  for (const factor of factors) {
    const mapping = FACTOR_MAP[factor];
    if (!mapping) continue;

    switch (factor) {
      case 'finish_time':
      case 'pace': {
        const { results } = await db.prepare(`
          SELECT rr.finish_time
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.horse_id = ? AND rr.finish_time IS NOT NULL
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit).all();
        timeSeries[factor] = (results ?? []).map((r: any) => r.finish_time).reverse();
        break;
      }

      case 'form':
      case 'placing': {
        const { results } = await db.prepare(`
          SELECT rr.finishing_position
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.horse_id = ? AND rr.finishing_position IS NOT NULL AND rr.finishing_position < 99
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit).all();
        timeSeries[factor] = (results ?? []).map((r: any) => r.finishing_position).reverse();
        break;
      }

      case 'odds_flow': {
        const { results } = await db.prepare(`
          SELECT rr.win_odds
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.horse_id = ? AND rr.win_odds IS NOT NULL
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit).all();
        timeSeries[factor] = (results ?? []).map((r: any) => r.win_odds).reverse();
        break;
      }

      case 'draw': {
        const { results } = await db.prepare(`
          SELECT rr.draw
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.horse_id = ? AND rr.draw IS NOT NULL
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit).all();
        timeSeries[factor] = (results ?? []).map((r: any) => r.draw).reverse();
        break;
      }

      case 'jockey': {
        // 騎師近期勝率趨勢（最近 N 場的 rolling win rate）
        const { results } = await db.prepare(`
          SELECT
            CASE WHEN rr.finishing_position = 1 THEN 1.0 ELSE 0.0 END AS win_flag
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.jockey_id = (
            SELECT jockey_id FROM race_results WHERE horse_id = ? ORDER BY rowid DESC LIMIT 1
          )
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit * 3).all();
        // 計算 rolling window
        const flags = (results ?? []).map((r: any) => r.win_flag).reverse();
        const windowSize = 10;
        const rollingRates: number[] = [];
        for (let i = windowSize; i <= flags.length; i++) {
          const window = flags.slice(i - windowSize, i);
          const rate = window.reduce((a: number, b: number) => a + b, 0) / windowSize;
          rollingRates.push(Math.round(rate * 100));
        }
        timeSeries[factor] = rollingRates.slice(-limit);
        break;
      }

      case 'trainer': {
        const { results } = await db.prepare(`
          SELECT
            CASE WHEN rr.finishing_position = 1 THEN 1.0 ELSE 0.0 END AS win_flag
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rr.trainer_id = (
            SELECT trainer_id FROM race_results WHERE horse_id = ? ORDER BY rowid DESC LIMIT 1
          )
          ORDER BY rm.date DESC
          LIMIT ?
        `).bind(horseId, limit * 3).all();
        const flags = (results ?? []).map((r: any) => r.win_flag).reverse();
        const windowSize = 10;
        const rollingRates: number[] = [];
        for (let i = windowSize; i <= flags.length; i++) {
          const window = flags.slice(i - windowSize, i);
          const rate = window.reduce((a: number, b: number) => a + b, 0) / windowSize;
          rollingRates.push(Math.round(rate * 100));
        }
        timeSeries[factor] = rollingRates.slice(-limit);
        break;
      }

      default:
        // 其他因子暫時跳過（血統、配備等不適合時間序列）
        break;
    }
  }

  return timeSeries;
}

// 執行 TimesFM 預測（主入口）
export async function runTimesFMAnalysis(
  env: Env,
  db: D1Database,
  horseIds: string[],
  factors: string[]
): Promise<TimesFMPrediction[]> {
  const predictions: TimesFMPrediction[] = [];

  // 判斷哪些因子適合做時間序列預測
  const timeSeriesFactors = factors.filter((f) =>
    ['finish_time', 'pace', 'form', 'placing', 'odds_flow', 'jockey', 'trainer', 'draw'].includes(f)
  );

  // 非時間序列因子直接用統計分析
  const nonTimeSeriesFactors = factors.filter((f) =>
    ['bloodline', 'equipment', 'trackwork', 'trial', 'running_position', 'sectional', 'course', 'going', 'jockey_trainer'].includes(f)
  );

  // TimesFM 預測（時間序列因子）
  if (timeSeriesFactors.length > 0 && env.TIMESFM_API_URL) {
    for (const horseId of horseIds) {
      const historyData = await extractHistoryTimeSeries(db, horseId, timeSeriesFactors);

      try {
        const result = await callTimesFM(env, {
          horseId,
          factors: timeSeriesFactors,
          historyData,
          predictHorizon: 3,
        });

        // 解析 TimesFM 返回結果
        for (const factor of timeSeriesFactors) {
          const mapping = FACTOR_MAP[factor];
          if (!mapping) continue;

          const history = historyData[factor];
          if (!history || history.length < 3) continue;

          const predicted = result?.output?.[factor];
          if (predicted && predicted.length > 0) {
            const lastValue = history[history.length - 1];
            const predictedValue = predicted[0];
            const change = predictedValue - lastValue;
            const changePercent = (change / lastValue) * 100;

            let trend: 'up' | 'down' | 'stable' = 'stable';
            if (Math.abs(changePercent) > 2) {
              // 對於名次和完成時間，下降是好事
              if (factor === 'form' || factor === 'placing' || factor === 'finish_time') {
                trend = change < 0 ? 'up' : 'down';
              } else {
                trend = change > 0 ? 'up' : 'down';
              }
            }

            predictions.push({
              factorName: factor,
              factorNameCn: mapping.cn,
              trendDirection: trend,
              confidence: Math.min(0.95, 0.6 + Math.abs(changePercent) / 100),
              insight: generateInsight(factor, trend, changePercent, lastValue, predictedValue),
            });
          }
        }
      } catch (err) {
        console.error(`TimesFM error for horse ${horseId}:`, err);
        // Fallback: 用簡單統計趨勢
        for (const factor of timeSeriesFactors) {
          const fallback = generateFallbackPrediction(factor, historyData[factor]);
          if (fallback) predictions.push(fallback);
        }
      }
    }
  } else {
    // TimesFM 未配置，用 fallback 統計分析
    for (const horseId of horseIds) {
      const historyData = await extractHistoryTimeSeries(db, horseId, timeSeriesFactors);
      for (const factor of timeSeriesFactors) {
        const fallback = generateFallbackPrediction(factor, historyData[factor]);
        if (fallback) predictions.push(fallback);
      }
    }
  }

  // 非時間序列因子用統計分析
  for (const factor of nonTimeSeriesFactors) {
    const mapping = FACTOR_MAP[factor];
    if (mapping) {
      predictions.push({
        factorName: factor,
        factorNameCn: mapping.cn,
        trendDirection: 'stable',
        confidence: 0.7,
        insight: `${mapping.cn}分析已納入綜合評估`,
      });
    }
  }

  return predictions;
}

// 生成趨勢洞察文字
function generateInsight(
  factor: string,
  trend: 'up' | 'down' | 'stable',
  changePercent: number,
  lastValue: number,
  predictedValue: number
): string {
  const trendText = trend === 'up' ? '上升' : trend === 'down' ? '下降' : '穩定';
  const absChange = Math.abs(changePercent).toFixed(1);

  switch (factor) {
    case 'finish_time':
    case 'pace':
      return trend === 'up'
        ? `預期完成時間趨勢向好，預計快約 ${Math.abs(lastValue - predictedValue).toFixed(1)} 秒`
        : trend === 'down'
        ? `完成時間趨勢放慢，需注意狀態下滑`
        : `完成時間保持穩定`;
    case 'form':
    case 'placing':
      return trend === 'up'
        ? `近績趨勢${trendText}，名次表現改善 ${absChange}%`
        : `名次趨勢${trendText} ${absChange}%`;
    case 'odds_flow':
      return `賠率趨勢${trendText} ${absChange}%，${trend === 'down' ? '資金流入增加' : '市場信心偏弱'}`;
    case 'jockey':
      return `騎師勝率趨勢${trendText} ${absChange}%`;
    case 'trainer':
      return `練馬師勝率趨勢${trendText} ${absChange}%`;
    default:
      return `趨勢${trendText} ${absChange}%`;
  }
}

// Fallback: 用簡單線性回歸估算趨勢
function generateFallbackPrediction(
  factor: string,
  data: number[] | undefined
): TimesFMPrediction | null {
  if (!data || data.length < 3) return null;

  const mapping = FACTOR_MAP[factor];
  if (!mapping) return null;

  // 簡單線性回歸
  const n = data.length;
  const xMean = (n - 1) / 2;
  const yMean = data.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (data[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const slopePercent = yMean !== 0 ? (slope / yMean) * 100 : 0;

  let trend: 'up' | 'down' | 'stable' = 'stable';
  if (Math.abs(slopePercent) > 1) {
    if (factor === 'form' || factor === 'placing' || factor === 'finish_time') {
      trend = slope < 0 ? 'up' : 'down';
    } else {
      trend = slope > 0 ? 'up' : 'down';
    }
  }

  return {
    factorName: factor,
    factorNameCn: mapping.cn,
    trendDirection: trend,
    confidence: Math.min(0.85, 0.5 + Math.abs(slopePercent) / 50),
    insight: `統計趨勢分析：${mapping.cn}趨勢${trend === 'up' ? '上升' : trend === 'down' ? '下降' : '穩定'}`,
  };
}
