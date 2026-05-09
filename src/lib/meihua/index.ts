// 梅花易數 · 取象+取數 (Phase C v3)
  // 上卦(數)=馬號+檔位; 下卦(象)=馬名+騎師名八卦類象加權投票; 動爻(機)=(上+下象+時辰)mod6
  // v3: 字典擴至 ~500+ 字; 馬名第一字×3 (主象), 其餘馬名×2, 騎師×0.5

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

  // ── 八卦萬物類象字典 v3 (擴至 ~500+ 字, 重 HK 馬名/騎師覆蓋) ──
  const XIANG: Record<string, Trigram> = {
    // 乾 ☰ 天/金/君/父/玉/馬/首/赤/圓/剛健/將帥
    天:'乾',王:'乾',皇:'乾',帝:'乾',君:'乾',主:'乾',父:'乾',首:'乾',元:'乾',魁:'乾',
    龍:'乾',駒:'乾',駿:'乾',驥:'乾',騏:'乾',驊:'乾',驌:'乾',騮:'乾',馬:'乾',
    玉:'乾',金:'乾',珠:'乾',寶:'乾',鑽:'乾',鑫:'乾',鋼:'乾',鐵:'乾',劍:'乾',璽:'乾',銘:'乾',
    將:'乾',帥:'乾',軍:'乾',雄:'乾',霸:'乾',豪:'乾',傑:'乾',英:'乾',統:'乾',領:'乾',爵:'乾',侯:'乾',公:'乾',
    剛:'乾',強:'乾',健:'乾',勁:'乾',威:'乾',武:'乾',神:'乾',聖:'乾',尊:'乾',貴:'乾',
    乾:'乾',陽:'乾',大:'乾',巨:'乾',至:'乾',上:'乾',真:'乾',赫:'乾',赤:'乾',
    冠:'乾',冕:'乾',珉:'乾',璧:'乾',琪:'乾',琛:'乾',璋:'乾',珩:'乾',珅:'乾',琰:'乾',
    鴻:'乾',弘:'乾',宏:'乾',浩:'乾',渾:'乾',
    
    // 兌 ☱ 澤/少女/喜/口/言/笑/羊/銀/白/甜/美
    澤:'兌',湖:'兌',池:'兌',塘:'兌',潭:'兌',
    喜:'兌',悅:'兌',笑:'兌',歡:'兌',甜:'兌',蜜:'兌',
    美:'兌',艷:'兌',嬌:'兌',麗:'兌',佳:'兌',倩:'兌',娟:'兌',婷:'兌',妍:'兌',雅:'兌',
    口:'兌',言:'兌',語:'兌',歌:'兌',唱:'兌',吟:'兌',談:'兌',
    少:'兌',妹:'兌',女:'兌',姐:'兌',姑:'兌',娥:'兌',
    銀:'兌',白:'兌',皓:'兌',素:'兌',潔:'兌',淨:'兌',霽:'兌',
    羊:'兌',蝶:'兌',鸚:'兌',
    
    // 離 ☲ 火/日/明/麗/光/紅/赤/雉/中女/夏/星/燈/電/輝
    火:'離',日:'離',光:'離',明:'離',亮:'離',輝:'離',煇:'離',
    紅:'離',朱:'離',丹:'離',彩:'離',霞:'離',虹:'離',
    焰:'離',熾:'離',炎:'離',燚:'離',燦:'離',煌:'離',燿:'離',耀:'離',
    星:'離',燈:'離',電:'離',閃:'離',
    鳳:'離',凰:'離',雀:'離',雉:'離',鸞:'離',鶯:'離',鴛:'離',鴦:'離',
    夏:'離',暉:'離',旭:'離',旦:'離',旺:'離',昌:'離',昇:'離',昂:'離',晨:'離',曦:'離',曙:'離',晴:'離',晝:'離',
    華:'離',采:'離',燁:'離',熠:'離',煜:'離',燎:'離',煥:'離',烈:'離',煒:'離',熹:'離',熔:'離',
    歲:'離',月:'離',  // 月光屬離(明)
    心:'離',  // 心屬離火
    
    // 震 ☳ 雷/動/木/長男/聲/驚/足/龍/東/春/青/勇/奔/速
    雷:'震',震:'震',動:'震',驚:'震',奮:'震',勇:'震',猛:'震',勝:'震',凱:'震',
    聲:'震',響:'震',鳴:'震',吼:'震',
    奔:'震',跑:'震',跨:'震',躍:'震',騰:'震',跳:'震',馳:'震',衝:'震',
    快:'震',速:'震',疾:'震',
    東:'震',春:'震',青:'震',
    戰:'震',爭:'震',闖:'震',捷:'震',銳:'震',飆:'震',  
    鼓:'震',號:'震',
    士:'震',兵:'震',  // 武士屬震動
    
    // 巽 ☴ 風/木/順/草/長女/雞/翔/鳥/羽
    風:'巽',雲:'巽',順:'巽',頌:'巽',
    木:'巽',林:'巽',森:'巽',樹:'巽',枝:'巽',葉:'巽',花:'巽',草:'巽',香:'巽',芳:'巽',
    蘭:'巽',竹:'巽',梅:'巽',松:'巽',柏:'巽',桐:'巽',柳:'巽',桃:'巽',李:'巽',杏:'巽',楊:'巽',
    綠:'巽',翠:'巽',蔭:'巽',蓮:'巽',菊:'巽',茉:'巽',薇:'巽',蓁:'巽',
    飛:'巽',翔:'巽',翼:'巽',翅:'巽',羽:'巽',揚:'巽',展:'巽',
    雞:'巽',鵝:'巽',鳥:'巽',燕:'巽',鶴:'巽',雁:'巽',鴿:'巽',鵬:'巽',鷹:'巽',隼:'巽',
    繩:'巽',帆:'巽',
    風雲:'巽',雲飛:'巽',  // (won't match — single chars)
    巴:'巽',  // 騎師「巴度」,「巴賴」(輕風入意)
    班:'巽',潘:'巽',
    
    // 坎 ☵ 水/雨/險/陷/血/中男/耳/北/冬/黑/智
    水:'坎',江:'坎',河:'坎',海:'坎',湖:'坎',泉:'坎',川:'坎',溪:'坎',瀑:'坎',洋:'坎',
    雨:'坎',雪:'坎',冰:'坎',霜:'坎',露:'坎',霧:'坎',
    波:'坎',濤:'坎',浪:'坎',潮:'坎',涌:'坎',流:'坎',涵:'坎',渤:'坎',淼:'坎',
    深:'坎',沉:'坎',淵:'坎',沼:'坎',洲:'坎',渡:'坎',漂:'坎',漁:'坎',
    寒:'坎',冬:'坎',北:'坎',夜:'坎',黑:'坎',暗:'坎',陰:'坎',
    智:'坎',慧:'坎',思:'坎',謀:'坎',默:'坎',
    魚:'坎',
    
    // 艮 ☶ 山/土/止/石/門/手/狗/少男/重/穩/堡/守
    山:'艮',岳:'艮',峰:'艮',嶺:'艮',崗:'艮',丘:'艮',崙:'艮',崑:'艮',崧:'艮',
    石:'艮',岩:'艮',巖:'艮',磐:'艮',磯:'艮',碩:'艮',
    土:'艮',城:'艮',堡:'艮',壘:'艮',門:'艮',關:'艮',
    穩:'艮',固:'艮',實:'艮',厚:'艮',重:'艮',鎮:'艮',守:'艮',衛:'艮',護:'艮',
    止:'艮',靜:'艮',定:'艮',寧:'艮',安:'艮',
    手:'艮',
    
    // 坤 ☷ 地/眾/順/方/腹/牛/西南/秋/黃/載/包/福(集合萬般)
    地:'坤',田:'坤',野:'坤',方:'坤',
    眾:'坤',廣:'坤',博:'坤',
    母:'坤',娘:'坤',婆:'坤',妻:'坤',慈:'坤',仁:'坤',愛:'坤',恩:'坤',德:'坤',
    黃:'坤',褐:'坤',
    腹:'坤',載:'坤',
    牛:'坤',
    運:'坤',福:'坤',祿:'坤',壽:'坤',康:'坤',樂:'坤',財:'坤',富:'坤',發:'坤',
    好:'坤',吉:'坤',如:'坤',意:'坤',稱:'坤',
    豐:'坤',盛:'坤',盈:'坤',滿:'坤',
    萬:'坤',千:'坤',百:'坤',全:'坤',
    承:'坤',  // 傳承 → 坤(載)
    傳:'坤',  // 同上
    
    // 補：常見 HK 馬名虛字
    之:'坤',的:'坤',者:'坤',  // 中性字 → 坤(地萬般)
    來:'巽',  // 來如風入
    去:'震',  // 去如奔
    進:'震',  // 進取
    得:'坤',  // 獲得
    心:'離',  // (重複) 心火
    紫:'離',  // 紫氣東來但屬火紅
    奇:'乾',  // 奇異卓越
    飛:'巽',  // (重複)
    彩:'離',  // (重複)
  };
  // 騎師常見字補充 (重新覆蓋以確認)
  XIANG['黃'] = '坤'; XIANG['田'] = '坤';  // 田/黃 → 坤地
  XIANG['莫'] = '巽';  // 莫雷拉 (草頭)
  XIANG['潘'] = '坎';  // 潘 (氵旁) → 水
  XIANG['霍'] = '坎';  // 霍宏聲 (雨頭) → 水
  XIANG['周'] = '坤';  // 周俊樂
  XIANG['陳'] = '艮';  // 陳 (阜) 山土
  XIANG['梁'] = '巽';  // 梁 (木) 
  XIANG['杜'] = '巽';  // 杜 (木)
  XIANG['何'] = '艮';  // 中土
  XIANG['蘇'] = '巽';  // 草頭
  XIANG['霍'] = '坎'; XIANG['宏'] = '乾'; XIANG['聲'] = '震';
  XIANG['袁'] = '乾'; XIANG['幸'] = '兌'; XIANG['堯'] = '乾';
  XIANG['白'] = '兌'; XIANG['布'] = '坤';  // 布袋象坤
  XIANG['班'] = '巽'; XIANG['沛'] = '坎'; XIANG['博'] = '坤';
  XIANG['楊'] = '巽'; XIANG['明'] = '離'; XIANG['爾'] = '坤';
  XIANG['希'] = '兌'; XIANG['頓'] = '艮';
  XIANG['利'] = '震';  // 利如刀(銳=震)
  XIANG['德'] = '坤'; XIANG['里'] = '坤';
  XIANG['泰'] = '乾'; XIANG['安'] = '艮'; XIANG['俊'] = '乾';
  XIANG['卓'] = '乾'; XIANG['偉'] = '乾'; XIANG['軒'] = '震';
  XIANG['翰'] = '巽'; XIANG['樺'] = '巽'; XIANG['楓'] = '巽';
  XIANG['邦'] = '坤';

  // ── 由「象」取下卦：加權投票 + tiebreak ──
  // 馬名第一字 ×3 (主象), 其餘馬名 ×2, 騎師 ×0.5
  function trigramFromXiang(horseName: string, jockeyName: string): {
    trigram: Trigram; xiangChars: Record<string, string>; voteSum: number; voteDist: Record<Trigram, number>;
  } {
    const votes: Record<Trigram, number> = { 乾:0, 兌:0, 離:0, 震:0, 巽:0, 坎:0, 艮:0, 坤:0 };
    const matched: Record<string, string> = {};
    let codeSum = 0;
    
    const horseChars = [...(horseName||'')];
    for (let i = 0; i < horseChars.length; i++) {
      const ch = horseChars[i];
      codeSum += ch.charCodeAt(0);
      const t = XIANG[ch];
      if (t) {
        const w = i === 0 ? 3 : 2;  // 主象 ×3, 其餘 ×2
        votes[t] += w;
        matched[ch] = `${t}×${w}`;
      }
    }
    for (const ch of (jockeyName||'')) {
      codeSum += ch.charCodeAt(0);
      const t = XIANG[ch];
      if (t) {
        votes[t] += 0.5;
        if (!matched[ch]) matched[ch] = `${t}×0.5`;
      }
    }
    
    let best: Trigram = '坤'; let max = -1;
    for (const t of TRIGRAMS) { if (votes[t] > max) { max = votes[t]; best = t; } }
    
    // Tiebreak: 若 max==0 用字碼數
    if (max === 0) {
      best = numToTrigram((codeSum % 8) + 1);
    } else {
      // 若有多個 trigram 並列 max，用 codeSum 揀
      const tied = TRIGRAMS.filter(t => votes[t] === max);
      if (tied.length > 1) {
        best = tied[codeSum % tied.length];
      }
    }
    
    const voteSum = Object.values(votes).reduce((a,b)=>a+b,0);
    return { trigram: best, xiangChars: matched, voteSum, voteDist: votes };
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
    xiangChars: Record<string, string>;
    xiangBreakdown: string;
  }

  export function meihuaScoreForHorse(input: MeihuaInput): MeihuaScore {
    const hourZhi = hourZhiHK(input.raceTime);

    const upperSum = (input.horseNumber || 1) + (input.draw || 1);
    const upper = numToTrigram(upperSum);

    const xiang = trigramFromXiang(input.horseNameCh || '', input.jockeyNameCh || '');
    const lower = xiang.trigram;

    const lowerSeed = TRIGRAMS.indexOf(lower) + 1 + Math.round(xiang.voteSum);
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

    const breakdownParts: string[] = [];
    for (const [ch, t] of Object.entries(xiang.xiangChars)) {
      breakdownParts.push(`${ch}→${t}`);
    }
    const xiangBreakdown = breakdownParts.length ? breakdownParts.join('、') : '無類象匹配，取字碼數';

    return {
      meihuaScore: Math.round(meihuaScore * 100) / 100,
      upperTrigram: upper, lowerTrigram: lower,
      upperSum, lowerVoteSum: Math.round(xiang.voteSum * 10) / 10, dongLine, hourZhi,
      benGuaNum, benGuaName, benGuaScore,
      bianGuaNum, bianGuaName, bianGuaScore,
      ti, yong, tiyongRelation: tym.relation, tiyongMod: tym.mod,
      xiangChars: xiang.xiangChars,
      xiangBreakdown,
    };
  }
  