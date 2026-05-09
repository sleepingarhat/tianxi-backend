// 梅花易數 · 取象+取數 (Phase C v2)
  // 上卦(數)=馬號+檔位; 下卦(象)=馬名+騎師名八卦類象投票; 動爻(機)=(上+下象+時辰)mod6
  // 「將混沌的『機』轉化為清晰的『數』，再由『數』定『象』」

  const TRIGRAMS = ['坎','坤','震','巽','乾','兌','艮','離'] as const;
  export type Trigram = typeof TRIGRAMS[number];

  const TRIGRAM_WX: Record<Trigram, '木'|'火'|'土'|'金'|'水'> = {
    乾: '金', 兌: '金', 離: '火', 震: '木', 巽: '木', 坎: '水', 艮: '土', 坤: '土',
  };

  const TRIGRAM_LINES: Record<Trigram, [number,number,number]> = {
    乾: [1,1,1], 兌: [1,1,0], 離: [1,0,1], 震: [1,0,0],
    巽: [0,1,1], 坎: [0,1,0], 艮: [0,0,1], 坤: [0,0,0],
  };

  // 後天數 → 卦：1坎 2坤 3震 4巽 5(中,改6乾) 6乾 7兌 8艮 9離；普通 mod 8
  function numToTrigram(n: number): Trigram {
    const idx = ((n - 1) % 8 + 8) % 8;
    return TRIGRAMS[idx];
  }

  // ── 八卦萬物類象字典 (邵雍《梅花易數·萬物類象》+《周易·說卦》) ──
  // 每字映射至最主要嘅卦象。覆蓋常見 HK 馬名/騎師名漢字 ~280+
  const XIANG: Record<string, Trigram> = {
    // 乾 ☰ 天/金/君/父/玉/馬/首/赤/圓/剛健/王者/將帥/寶
    天:'乾',王:'乾',皇:'乾',帝:'乾',君:'乾',主:'乾',父:'乾',首:'乾',元:'乾',魁:'乾',
    龍:'乾',駒:'乾',駿:'乾',驥:'乾',騏:'乾',驊:'乾',驌:'乾',騮:'乾',
    玉:'乾',金:'乾',珠:'乾',寶:'乾',鑽:'乾',鑫:'乾',鋼:'乾',鐵:'乾',劍:'乾',璽:'乾',
    將:'乾',帥:'乾',軍:'乾',雄:'乾',霸:'乾',豪:'乾',傑:'乾',英:'乾',統:'乾',領:'乾',
    剛:'乾',強:'乾',健:'乾',勁:'乾',威:'乾',武:'乾',神:'乾',聖:'乾',尊:'乾',貴:'乾',
    乾:'乾',陽:'乾',大:'乾',巨:'乾',至:'乾',上:'乾',真:'乾',赫:'乾',
    
    // 兌 ☱ 澤/少女/喜/口/言/笑/缺/羊/金/悅/美/甜/銀/白
    澤:'兌',湖:'兌',池:'兌',塘:'兌',
    喜:'兌',悅:'兌',笑:'兌',歡:'兌',樂:'兌',甜:'兌',蜜:'兌',
    美:'兌',艷:'兌',嬌:'兌',麗:'兌',佳:'兌',倩:'兌',娟:'兌',婷:'兌',
    口:'兌',言:'兌',語:'兌',歌:'兌',唱:'兌',吟:'兌',
    少:'兌',妹:'兌',女:'兌',姐:'兌',姑:'兌',
    銀:'兌',白:'兌',皓:'兌',素:'兌',潔:'兌',淨:'兌',
    羊:'兌',蝶:'兌',
    
    // 離 ☲ 火/日/明/麗/光/紅/赤/雉/中女/夏/星/燈/電/輝
    火:'離',日:'離',光:'離',明:'離',亮:'離',輝:'離',
    紅:'離',朱:'離',丹:'離',赤:'離',彩:'離',
    焰:'離',熾:'離',炎:'離',燚:'離',燦:'離',煌:'離',燿:'離',耀:'離',
    星:'離',燈:'離',電:'離',雷霆:'離',霞:'離',虹:'離',
    鳳:'離',凰:'離',雀:'離',雉:'離',鸞:'離',鶯:'離',
    夏:'離',暉:'離',旭:'離',旦:'離',旺:'離',昌:'離',昇:'離',昂:'離',晨:'離',曦:'離',曙:'離',
    華:'離',采:'離',燁:'離',熠:'離',煜:'離',燎:'離',
    
    // 震 ☳ 雷/動/木/長男/聲/驚/足/龍/東/春/青/勇/奔/速
    雷:'震',震:'震',動:'震',驚:'震',奮:'震',勇:'震',猛:'震',勝:'震',
    聲:'震',響:'震',鳴:'震',吼:'震',嚎:'震',
    奔:'震',跑:'震',跨:'震',躍:'震',騰:'震',跳:'震',馳:'震',
    快:'震',速:'震',疾:'震',
    東:'震',春:'震',青:'震',
    戰:'震',爭:'震',闖:'震',凱:'震',
    鼓:'震',號:'震',
    
    // 巽 ☴ 風/木/入/順/繩/草/長女/雞/東南/翔/鳥/羽/翼
    風:'巽',雲:'巽',順:'巽',
    木:'巽',林:'巽',森:'巽',樹:'巽',枝:'巽',葉:'巽',花:'巽',草:'巽',香:'巽',
    蘭:'巽',竹:'巽',梅:'巽',松:'巽',柏:'巽',桐:'巽',柳:'巽',桃:'巽',李:'巽',
    綠:'巽',翠:'巽',蔭:'巽',
    飛:'巽',翔:'巽',翼:'巽',翅:'巽',羽:'巽',
    雞:'巽',鵝:'巽',鳥:'巽',鴻:'巽',燕:'巽',鶴:'巽',雁:'巽',鴿:'巽',鵬:'巽',
    繩:'巽',帆:'巽',揚:'巽',
    
    // 坎 ☵ 水/雨/險/陷/血/中男/耳/豕/北/冬/黑/智/沉
    水:'坎',江:'坎',河:'坎',海:'坎',湖:'坎',泉:'坎',川:'坎',溪:'坎',瀑:'坎',洋:'坎',
    雨:'坎',雪:'坎',冰:'坎',霜:'坎',露:'坎',霧:'坎',
    波:'坎',濤:'坎',浪:'坎',潮:'坎',涌:'坎',流:'坎',涵:'坎',渾:'坎',渤:'坎',
    深:'坎',沉:'坎',潭:'坎',淵:'坎',沼:'坎',洲:'坎',渡:'坎',漂:'坎',漁:'坎',
    寒:'坎',冬:'坎',北:'坎',夜:'坎',黑:'坎',暗:'坎',陰:'坎',
    智:'坎',慧:'坎',思:'坎',謀:'坎',
    魚:'坎',
    
    // 艮 ☶ 山/土/止/石/門/手/狗/少男/東北/重/穩/堡/守/碩
    山:'艮',岳:'艮',峰:'艮',嶺:'艮',崗:'艮',丘:'艮',崙:'艮',崑:'艮',崧:'艮',
    石:'艮',岩:'艮',巖:'艮',磐:'艮',磯:'艮',
    土:'艮',城:'艮',堡:'艮',壘:'艮',門:'艮',關:'艮',
    穩:'艮',固:'艮',實:'艮',厚:'艮',重:'艮',碩:'艮',鎮:'艮',守:'艮',
    止:'艮',靜:'艮',定:'艮',寧:'艮',
    手:'艮',
    
    // 坤 ☷ 地/土/母/眾/順/方/腹/牛/西南/秋/黃/載/包/福
    地:'坤',田:'坤',野:'坤',方:'坤',
    眾:'坤',廣:'坤',博:'坤',
    母:'坤',娘:'坤',婆:'坤',妻:'坤',慈:'坤',仁:'坤',愛:'坤',
    黃:'坤',褐:'坤',
    腹:'坤',載:'坤',
    牛:'坤',馬:'坤',  // 古類象馬實乾，但唐後文獻馬亦歸坤(地行)；此處保留乾
    運:'坤',福:'坤',祿:'坤',壽:'坤',康:'坤',樂:'坤',
    好:'坤',吉:'坤',順:'坤',如:'坤',意:'坤',
    豐:'坤',盛:'坤',盈:'坤',滿:'坤',豪:'坤',
    萬:'坤',千:'坤',百:'坤',
  };
  // 修正：馬本屬乾，覆蓋上面坤
  XIANG['馬'] = '乾';
  // 修正：豪偏向乾(豪傑)
  XIANG['豪'] = '乾';

  // ── 由「象」取下卦：投票 + tiebreak ──
  function trigramFromXiang(text: string): { trigram: Trigram; xiangChars: Record<string, Trigram>; voteSum: number } {
    const votes: Record<Trigram, number> = { 乾:0, 兌:0, 離:0, 震:0, 巽:0, 坎:0, 艮:0, 坤:0 };
    const matched: Record<string, Trigram> = {};
    let codeSum = 0;
    for (const ch of text) {
      const t = XIANG[ch];
      codeSum += ch.charCodeAt(0);
      if (t) { votes[t] += 1; matched[ch] = t; }
    }
    let best: Trigram = '坤'; let max = -1;
    for (const t of TRIGRAMS) { if (votes[t] > max) { max = votes[t]; best = t; } }
    // 若完全冇匹配，fallback 用 charCode 總和取數
    if (max === 0) {
      best = numToTrigram((codeSum % 8) + 1);
    }
    const voteSum = Object.values(votes).reduce((a,b)=>a+b,0);
    return { trigram: best, xiangChars: matched, voteSum };
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
    raceTime: Date;
    horseNumber: number;
    draw: number;
    horseNameCh: string;
    jockeyNameCh: string;
  }

  export interface MeihuaScore {
    meihuaScore: number;
    upperTrigram: Trigram; lowerTrigram: Trigram;
    upperSum: number; lowerVoteSum: number; dongLine: number; hourZhi: number;
    benGuaNum: number; benGuaName: string; benGuaScore: number;
    bianGuaNum: number; bianGuaName: string; bianGuaScore: number;
    ti: Trigram; yong: Trigram; tiyongRelation: string; tiyongMod: number;
    xiangChars: Record<string, Trigram>;
    xiangBreakdown: string;
  }

  export function meihuaScoreForHorse(input: MeihuaInput): MeihuaScore {
    const hourZhi = hourZhiHK(input.raceTime);

    // 上卦：數 (馬號 + 檔位)
    const upperSum = (input.horseNumber || 1) + (input.draw || 1);
    const upper = numToTrigram(upperSum);

    // 下卦：象 (馬名 + 騎師名 取象投票)
    const text = (input.horseNameCh || '') + (input.jockeyNameCh || '');
    const xiang = trigramFromXiang(text);
    const lower = xiang.trigram;

    // 動爻：機 (上卦數 + 下卦象總分 + 時辰)
    const lowerSeed = TRIGRAMS.indexOf(lower) + 1 + xiang.voteSum;
    const dongLine = (((upperSum + lowerSeed + hourZhi) % 6) || 6);

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

    // 取象說明
    const breakdownParts: string[] = [];
    for (const [ch, t] of Object.entries(xiang.xiangChars)) {
      breakdownParts.push(`${ch}→${t}`);
    }
    const xiangBreakdown = breakdownParts.length ? breakdownParts.join('、') : '無類象匹配，取字碼數';

    return {
      meihuaScore: Math.round(meihuaScore * 100) / 100,
      upperTrigram: upper, lowerTrigram: lower,
      upperSum, lowerVoteSum: xiang.voteSum, dongLine, hourZhi,
      benGuaNum, benGuaName, benGuaScore,
      bianGuaNum, bianGuaName, bianGuaScore,
      ti, yong, tiyongRelation: tym.relation, tiyongMod: tym.mod,
      xiangChars: xiang.xiangChars,
      xiangBreakdown,
    };
  }
  