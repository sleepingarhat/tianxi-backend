// AI Gateway Service — 使用 x.ai Grok 模型
import type { Env } from '../types';
import {
  RACING_AI_SYSTEM_PROMPT,
  buildRaceContext,
  buildHorseFormContext,
} from '../prompts/racing-ai';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AICompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

// 調用 AI Gateway（兼容 OpenRouter API）
export async function callAI(env: Env, options: AICompletionOptions): Promise<string> {
  const { messages, temperature = 0.7, maxTokens = 2000 } = options;

  const response = await fetch(env.AI_API_URL || 'https://ai-gateway.happycapy.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'x-ai/grok-3',
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// 賽馬 AI 聊天（核心功能）
export async function racingChat(
  env: Env,
  userMessage: string,
  raceData?: any,
  horseFormData?: any[],
  timesfmPredictions?: any[],
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  // 構建系統 prompt + 數據 context
  let systemContent = RACING_AI_SYSTEM_PROMPT;

  if (raceData) {
    systemContent += buildRaceContext(raceData);
  }

  if (horseFormData && horseFormData.length > 0) {
    for (const form of horseFormData) {
      systemContent += buildHorseFormContext(form);
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
  ];

  // 加入對話歷史（最多保留最近 10 條）
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-10);
    for (const msg of recent) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  return callAI(env, {
    messages,
    temperature: 0.7,
    maxTokens: 3000,
  });
}

// 解析用戶意圖（用 AI function calling 風格）
export async function parseUserIntent(env: Env, userMessage: string): Promise<{
  raceNumber?: number;
  betType?: string;
  format?: string;
  action: string;
  horseName?: string;
  jockeyName?: string;
  trainerName?: string;
}> {
  const parsePrompt = `分析以下香港賽馬相關查詢，提取結構化信息。只返回 JSON，不要其他文字。

查詢：「${userMessage}」

返回格式：
{
  "action": "bet_suggestion" | "horse_analysis" | "jockey_analysis" | "trainer_analysis" | "general_question",
  "raceNumber": <場次數字或null>,
  "betType": "WIN" | "PLA" | "QIN" | "QPL" | "TRI" | "TCE" | "FF" | "QTT" | "DBL" | "SINGLE_T" | "DOUBLE_T" | "TRIPLE_T" | "SIX_UP" | "ALL_UP" | "JOCKEY_CHALLENGE" | "TRAINER_CHALLENGE" | null,
  "format": <投注格式描述，例如"兩膽4腳"，或null>,
  "horseName": <馬匹名稱或null>,
  "jockeyName": <騎師名稱或null>,
  "trainerName": <練馬師名稱或null>
}`;

  const result = await callAI(env, {
    messages: [
      { role: 'system', content: '你是一個 JSON 解析器。只返回有效 JSON，不要任何其他文字。' },
      { role: 'user', content: parsePrompt },
    ],
    temperature: 0.1,
    maxTokens: 500,
  });

  try {
    // 嘗試提取 JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  return { action: 'general_question' };
}

// 因子分析 AI 總結
export async function generateAnalysisSummary(
  env: Env,
  raceData: any,
  timesfmResults: any[],
  selectedFactors: string[]
): Promise<{
  aiSummary: string;
  recommendations: { type: string; picks: string; reason: string; confidence: number }[];
}> {
  let context = RACING_AI_SYSTEM_PROMPT;
  context += buildRaceContext(raceData);
  context += `\n\n用戶選擇了以下分析因子：${selectedFactors.join('、')}`;

  const prompt = `根據以上所有數據，請提供：
1. 綜合分析總結（200字以內）
2. 三個投注建議（主膽推薦、單T組合、四重彩），每個包含選馬和理由

請用以下 JSON 格式返回：
{
  "aiSummary": "綜合分析...",
  "recommendations": [
    { "type": "主膽推薦", "picks": "X號", "reason": "...", "confidence": 0.85 },
    { "type": "單T組合", "picks": "X-Y-Z-W", "reason": "...", "confidence": 0.72 },
    { "type": "四重彩", "picks": "X,Y/Z,W/...", "reason": "...", "confidence": 0.65 }
  ]
}`;

  const result = await callAI(env, {
    messages: [
      { role: 'system', content: context },
      { role: 'user', content: prompt },
    ],
    temperature: 0.5,
    maxTokens: 2000,
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  return {
    aiSummary: result,
    recommendations: [],
  };
}

