// 梅花易數 · 後天數推斷 (v1 - 筆畫版本, backtest 驗證 Top1 12.5%)
  import { totalStrokes } from '../qimen/wuxing';

  const TRIGRAMS = ['坎','坤','震','巽','乾','兌','艮','離'] as const;
  export type Trigram = typeof TRIGRAMS[number];

  const TRIGRAM_WX: Record<Trigram, '木'|'火'|'土'|'金'|'水'> = {
    乾: '金', 兌: '金', 離: '火', 震: '木', 巽: '木', 坎: '水', 艮: '土', 坤: '土',
  };
  const TRIGRAM_LINES: Record<Trigram, [number,number,number]> = {
    乾: [1,1,1], 兌: [1,1,0], 離: [1,0,1], 震: [1,0,0],
    巽: [0,1,1], 坎: [0,1,0], 艮: [0,0,1], 坤: [0,0,0],
  };
  function numToTrigram(n: number): Trigram {
    const idx = ((n - 1) % 8 + 8) % 8;
    return TRIGRAMS[idx];
  }
  const KW: Record<Trigram, Record<Trigram, number>> = {
    乾: { 乾:1, 兌:43, 離:14, 震:34, 巽:9,  坎:5,  艮:26, 坤:11 },
    兌: { 乾:10, 兌:58, 離:38, 震:54, 巽:61, 坎:60, 艮:41, 坤:19 },
    離: { 乾:13, 兌:49, 離:30, 震:55, 巽:37, 坎:63, 艮:22, 坤:36 },
    震: { 乾:25, 兌:17, 離:21, 震:51, 巽:42, 坎:3,  艮:27, 坤:24 },
    巽: { 乾:44, 兌:28, 離:50, 震:32, 巽:57, 坎:48, 艮:18, 坤:46 },
    坎: { 乾:6,  兌:47, 離:64, 震:40, 巽:59, 坎:29, 艮:4,  坤:7  },
    艮: { 乾:33, 兌:31, 離:56, 震:62, 巽:53, 坎:39, 艮:52, 坤:15 },
    坤: { 乾:12, 兌:45, 離:35, 震:16, 巽:20, 坎:8,  艮:23, 坤:2  },
  };
  const HEX_NAMES: Record<number, string> = {
    1:'乾為天', 2:'坤為地', 3:'水雷屯', 4:'山水蒙', 5:'水天需', 6:'天水訟', 7:'地水師', 8:'水地比',
    9:'風天小畜', 10:'天澤履', 11:'地天泰', 12:'天地否', 13:'天火同人', 14:'火天大有', 15:'地山謙', 16:'雷地豫',
    17:'澤雷隨', 18:'山風蠱', 19:'地澤臨', 20:'風地觀', 21:'火雷噬嗑', 22:'山火賁', 23:'山地剝', 24:'地雷復',
    25:'天雷无妄', 26:'山天大畜', 27:'山雷頤', 28:'澤風大過', 29:'坎為水', 30:'離為火', 31:'澤山咸', 32:'雷風恆',
    33:'天山遁', 34:'雷天大壯', 35:'火地晉', 36:'地火明夷', 37:'風火家人', 38:'火澤睽', 39:'水山蹇', 40:'雷水解',
    41:'山澤損', 42:'風雷益', 43:'澤天夬', 44:'天風姤', 45:'澤地萃', 46:'地風升', 47:'澤水困', 48:'水風井',
    49:'澤火革', 50:'火風鼎', 51:'震為雷', 52:'艮為山', 53:'風山漸', 54:'雷澤歸妹', 55:'雷火豐', 56:'火山旅',
    57:'巽為風', 58:'兌為澤', 59:'風水渙', 60:'水澤節', 61:'風澤中孚', 62:'雷山小過', 63:'水火既濟', 64:'火水未濟',
  };
  const HEX_SCORE: Record<number, number> = {
    1:5, 2:3, 3:-2, 4:-1, 5:1, 6:-3, 7:0, 8:3,
    9:1, 10:2, 11:5, 12:-4, 13:3, 14:5, 15:5, 16:2,
    17:3, 18:-3, 19:3, 20:2, 21:-1, 22:1, 23:-4, 24:4,
    25:0, 26:4, 27:2, 28:-3, 29:-3, 30:1, 31:3, 32:3,
    33:-2, 34:3, 35:3, 36:-3, 37:3, 38:-2, 39:-4, 40:1,
    41:2, 42:4, 43:2, 44:-2, 45:2, 46:4, 47:-4, 48:1,
    49:2, 50:4, 51:2, 52:0, 53:4, 54:-1, 55:1, 56:-1,
    57:2, 58:3, 59:1, 60:2, 61:3, 62:-1, 63:4, 64:0,
  };
  const SHENG: Record<string,string> = {木:'火', 火:'土', 土:'金', 金:'水', 水:'木'};
  const KE:    Record<string,string> = {木:'土', 土:'水', 水:'火', 火:'金', 金:'木'};
  function tiyongMod(tiWx: string, yongWx: string): {mod: number; relation: string} {
    if (tiWx === yongWx) return {mod: +0.5, relation: '比和(小吉)'};
    if (KE[tiWx] === yongWx) return {mod: +1, relation: '體克用(大吉)'};
    if (KE[yongWx] === tiWx) return {mod: -1.5, relation: '用克體(大凶)'};
    if (SHENG[tiWx] === yongWx) return {mod: -0.5, relation: '體生用(洩氣,小凶)'};
    if (SHENG[yongWx] === tiWx) return {mod: +0.5, relation: '用生體(得助,吉)'};
    return {mod: 0, relation: '無關'};
  }
  function biangua(upper: Trigram, lower: Trigram, dongLine: number): {upper: Trigram; lower: Trigram} {
    const lines: number[] = [...TRIGRAM_LINES[lower], ...TRIGRAM_LINES[upper]];
    const i = dongLine - 1;
    lines[i] = lines[i] ? 0 : 1;
    const findT = (t: number[]): Trigram => {
      for (const k of TRIGRAMS) {
        const lns = TRIGRAM_LINES[k];
        if (lns[0]===t[0] && lns[1]===t[1] && lns[2]===t[2]) return k;
      }
      return '坤';
    };
    return { lower: findT(lines.slice(0,3)), upper: findT(lines.slice(3,6)) };
  }
  function hourZhiHK(d: Date): number {
    const h = d.getUTCHours() + 8;
    return Math.floor(((h + 1) % 24) / 2);
  }

  export interface MeihuaInput {
    raceTime: Date; horseNumber: number; draw: number; horseNameCh: string; jockeyNameCh: string;
  }
  export interface MeihuaScore {
    meihuaScore: number;
    upperTrigram: Trigram; lowerTrigram: Trigram;
    upperSum: number; lowerSum: number; dongLine: number; hourZhi: number;
    benGuaNum: number; benGuaName: string; benGuaScore: number;
    bianGuaNum: number; bianGuaName: string; bianGuaScore: number;
    ti: Trigram; yong: Trigram; tiyongRelation: string; tiyongMod: number;
    horseStrokes: number; jockeyStrokes: number;
  }

  export function meihuaScoreForHorse(input: MeihuaInput): MeihuaScore {
    const horseStrokes = totalStrokes(input.horseNameCh || '中');
    const jockeyStrokes = totalStrokes(input.jockeyNameCh || '中');
    const hourZhi = hourZhiHK(input.raceTime);
    const upperSum = (input.horseNumber || 1) + (input.draw || 1);
    const lowerSum = horseStrokes + jockeyStrokes;
    const dongLine = (((upperSum + lowerSum + hourZhi) % 6) || 6);
    const upper = numToTrigram(upperSum);
    const lower = numToTrigram(lowerSum);
    const benGuaNum = KW[upper][lower];
    const benGuaName = HEX_NAMES[benGuaNum];
    const benGuaScore = HEX_SCORE[benGuaNum];
    const bian = biangua(upper, lower, dongLine);
    const bianGuaNum = KW[bian.upper][bian.lower];
    const bianGuaName = HEX_NAMES[bianGuaNum];
    const bianGuaScore = HEX_SCORE[bianGuaNum];
    const yong = dongLine <= 3 ? lower : upper;
    const ti   = dongLine <= 3 ? upper : lower;
    const tym = tiyongMod(TRIGRAM_WX[ti], TRIGRAM_WX[yong]);
    const raw = benGuaScore * 0.6 + bianGuaScore * 0.4 + tym.mod;
    const meihuaScore = Math.max(-5, Math.min(5, raw));
    return {
      meihuaScore: Math.round(meihuaScore * 100) / 100,
      upperTrigram: upper, lowerTrigram: lower,
      upperSum, lowerSum, dongLine, hourZhi,
      benGuaNum, benGuaName, benGuaScore,
      bianGuaNum, bianGuaName, bianGuaScore,
      ti, yong, tiyongRelation: tym.relation, tiyongMod: tym.mod,
      horseStrokes, jockeyStrokes,
    };
  }
  