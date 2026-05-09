// 奇門遁甲 · 馬匹評分 (Phase B v1)
  // 將 paipan 的宮位吉凶 × 馬匹 4 個輸入（馬號/檔位/馬名/騎師名）→ 單一 ±5 分加成。

  import { paipan, type Paipan, type Palace } from './paipan';
  import { horseNameToPalace, jockeyNameToPalace } from './wuxing';

  export interface QimenInput {
    raceTime: Date;
    horseNumber: number;
    draw: number;
    horseNameCh: string;
    jockeyNameCh: string;
    silksColor?: string; // v1 暫不使用
  }

  export interface QimenHorseScore {
    qimenScore: number;        // 最終加成 (-5 ~ +5)
    rawScore: number;          // 4 宮平均 (-10 ~ +10)
    details: {
      horseNumberPalace: { palace: number; score: number };
      drawPalace: { palace: number; score: number };
      horseNamePalace: { palace: number; score: number; wx: string; firstChar: string; strokeMod: number };
      jockeyPalace: { palace: number; score: number; totalStroke: number };
      silksPalace: { palace: number; score: number }; // v1 全 0
    };
  }

  // 等權 0.25，但 v1 silks 設 0 → 其他 4 項權重等比放大到 0.25
  const W = { horseNumber: 0.25, draw: 0.25, horseName: 0.25, jockey: 0.25, silks: 0 };

  function palaceFromNumber(n: number): number {
    return ((n - 1) % 9 + 9) % 9 + 1;
  }

  export function qimenScoreForHorse(pp: Paipan, input: QimenInput): QimenHorseScore {
    // 1. 馬號宮
    const hnPalace = palaceFromNumber(input.horseNumber || 1);
    const hnScore = pp.palaceScores[hnPalace as Palace] ?? 0;

    // 2. 檔位宮
    const drawPalace = palaceFromNumber(input.draw || 1);
    const drawScore = pp.palaceScores[drawPalace as Palace] ?? 0;

    // 3. 馬名宮 (取象 + 筆畫修正)
    const hn = horseNameToPalace(input.horseNameCh || '中');
    const baseHnScore = pp.palaceScores[hn.palace as Palace] ?? 0;
    // 筆畫修正：strokeMod 0-2 → -1, 3-5 → 0, 6-8 → +1
    const strokeAdj = hn.strokeMod <= 2 ? -1 : hn.strokeMod >= 6 ? 1 : 0;
    const horseNameScore = baseHnScore + strokeAdj;

    // 4. 騎師宮 (筆畫)
    const jk = jockeyNameToPalace(input.jockeyNameCh || '中');
    const jkScore = pp.palaceScores[jk.palace as Palace] ?? 0;

    // 5. 綵衣宮 v1 = 0
    const silksScore = 0;
    const silksPalace = 0;

    const rawScore =
      W.horseNumber * hnScore +
      W.draw * drawScore +
      W.horseName * horseNameScore +
      W.jockey * jkScore +
      W.silks * silksScore;

    // qimen 範圍 ~±10 → 縮放至 ±5
    const qimenScore = Math.max(-5, Math.min(5, rawScore * 0.5));

    return {
      qimenScore: Math.round(qimenScore * 100) / 100,
      rawScore: Math.round(rawScore * 100) / 100,
      details: {
        horseNumberPalace: { palace: hnPalace, score: hnScore },
        drawPalace: { palace: drawPalace, score: drawScore },
        horseNamePalace: { palace: hn.palace, score: horseNameScore, wx: hn.wx, firstChar: hn.firstChar, strokeMod: hn.strokeMod },
        jockeyPalace: { palace: jk.palace, score: jkScore, totalStroke: jk.totalStroke },
        silksPalace: { palace: silksPalace, score: silksScore },
      },
    };
  }

  export { paipan } from './paipan';
  