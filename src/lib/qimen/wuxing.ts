// 漢字五行歸類 + 康熙筆畫近似
  // 依「取象 + 數理」混合法為馬名落宮服務。

  export type WuXing = '木' | '火' | '土' | '金' | '水' | '中';

  // 部首五行（最常見規則 ~30 條）
  const RADICAL_RULES: Array<{ pattern: RegExp; wx: WuXing }> = [
    { pattern: /[木朩林森桃柳楊梅松柏竹艸艹萌芽蘭蓮草萊菲蓉蓁]/u, wx: '木' },
    { pattern: /[火灬炎焰焱燁烈煌煒燦煥輝煜熾]/u, wx: '火' },
    { pattern: /[日明昭昇昌晨晴朗暉曜旭]/u, wx: '火' },
    { pattern: /[紅赤朱丹炯]/u, wx: '火' },
    { pattern: /[土圭地坤垠堡垣坷塵塞墟壘]/u, wx: '土' },
    { pattern: /[山岳峰嶺崖崧嵐巖崑]/u, wx: '土' },
    { pattern: /[石碩磊礡碩磐]/u, wx: '土' },
    { pattern: /[皇寶寰宇宙宮室宏宸寰]/u, wx: '土' },
    { pattern: /[厂广廈廬廳]/u, wx: '土' },
    { pattern: /[金釒鈞銘鋒鋼鐵銀銅鑫鑽錦鎏]/u, wx: '金' },
    { pattern: /[刀刃劍剎劇刺剛勁]/u, wx: '金' },
    { pattern: /[戈戰武戰]/u, wx: '金' },
    { pattern: /[白霜雪]/u, wx: '金' },
    { pattern: /[水氵冫江河海湖洋溪潮汪沛沖泉淵深波瀾濤潔澤潤滄渝瀟]/u, wx: '水' },
    { pattern: /[雨雲霧霖霆]/u, wx: '水' },
    { pattern: /[寒冬冰凌冷]/u, wx: '水' },
    { pattern: /[黑玄墨]/u, wx: '水' },
  ];

  // 高頻馬名吉祥字字典（手工標註，~150 字，覆蓋常見約 60% 馬名首字）
  const HANDPICKED: Record<string, WuXing> = {
    // 木
    '木':'木','林':'木','森':'木','春':'木','青':'木','綠':'木','龍':'木','麒':'木','麟':'木',
    '東':'木','茂':'木','興':'木','榮':'木','華':'木','蘭':'木','梅':'木','桃':'木','柳':'木','榴':'木',
    '駿':'木','駒':'木','驍':'木','驕':'木',
    // 火
    '火':'火','日':'火','陽':'火','光':'火','明':'火','輝':'火','烈':'火','焱':'火','炎':'火','彩':'火',
    '紅':'火','朱':'火','南':'火','夏':'火','禮':'火','麗':'火','鳳':'火','凰':'火','雀':'火','燕':'火',
    '馬':'火','駿':'火','驅':'火',
    // 土
    '土':'土','山':'土','石':'土','寶':'土','皇':'土','王':'土','坤':'土','宇':'土','宙':'土','宏':'土',
    '黃':'土','信':'土','誠':'土','安':'土','穩':'土','靜':'土','中':'土','央':'土','京':'土','尊':'土',
    // 金
    '金':'金','鐵':'金','銀':'金','鋼':'金','鋒':'金','劍':'金','刀':'金','武':'金','勝':'金','成':'金',
    '西':'金','秋':'金','義':'金','正':'金','剛':'金','強':'金','利':'金','富':'金','貴':'金','錢':'金',
    '將':'金','帥':'金','王':'土','霸':'金',
    // 水
    '水':'水','江':'水','河':'水','海':'水','湖':'水','洋':'水','雨':'水','雲':'水','雪':'水','霜':'水',
    '北':'水','冬':'水','智':'水','道':'水','玄':'水','黑':'水','深':'水','淵':'水','清':'水','澈':'水',
    '潮':'水','浪':'水','濤':'水','洪':'水','泉':'水','滄':'水','潤':'水',
    // 中性 / 抽象
    '天':'中','地':'中','人':'中','心':'中','神':'中','靈':'中','聖':'中','仙':'中','玄':'水','道':'水',
    '一':'中','大':'中','太':'中','王':'土','萬':'木','喜':'土','福':'土','祿':'土','壽':'土','吉':'土',
  };

  export function charWuxing(ch: string): WuXing {
    if (HANDPICKED[ch]) return HANDPICKED[ch];
    for (const r of RADICAL_RULES) if (r.pattern.test(ch)) return r.wx;
    return '中';
  }

  // 五行 → 後天宮位
  export function wuxingToPalace(wx: WuXing): number {
    switch (wx) {
      case '木': return 3; // 震宮（兼 4 巽）
      case '火': return 9; // 離宮
      case '土': return 2; // 坤宮（兼 8 艮）
      case '金': return 7; // 兌宮（兼 6 乾）
      case '水': return 1; // 坎宮
      case '中': return 5; // 中宮
    }
  }

  // 康熙筆畫近似：用 Unicode codepoint 取模 + 字典覆寫
  // 對筆畫精度要求不高（用於修正分數，非主導），所以近似可接受。
  const STROKE_OVERRIDES: Record<string, number> = {
    '一':1,'二':2,'三':3,'四':5,'五':4,'六':4,'七':2,'八':2,'九':2,'十':2,
    '人':2,'天':4,'地':6,'王':4,'金':8,'木':4,'水':4,'火':4,'土':3,
    '日':4,'月':4,'山':3,'川':3,'大':3,'小':3,'中':4,'心':4,'手':4,
    '龍':16,'鳳':14,'麟':23,'麒':19,'駿':17,'駒':15,'馬':10,'駕':15,
    '光':6,'明':8,'輝':15,'寶':20,'皇':9,'帝':9,'宮':10,'城':9,
    '海':10,'江':6,'河':8,'湖':12,'雨':8,'雲':12,'雪':11,'霜':17,
    '紅':9,'金':8,'銀':14,'鐵':21,'鋒':15,'劍':15,'刀':2,'武':8,'勝':12,
    '春':9,'夏':10,'秋':9,'冬':5,'東':8,'西':6,'南':9,'北':5,
    '青':8,'綠':14,'紫':12,'黃':12,'白':5,'黑':12,
    '飛':9,'翔':12,'雄':12,'勇':9,'威':9,'霸':21,'王':4,'帝':9,
    '吉':6,'喜':12,'福':14,'祿':12,'壽':14,'安':6,'樂':15,
    '富':12,'貴':12,'榮':14,'華':14,'錦':16,
  };

  export function strokeCount(ch: string): number {
    if (STROKE_OVERRIDES[ch]) return STROKE_OVERRIDES[ch];
    // Approximation: codepoint-based mod 25 + 4，落在 4-28 範圍
    const cp = ch.codePointAt(0) ?? 0;
    return ((cp % 25) + 4);
  }

  export function totalStrokes(name: string): number {
    let sum = 0;
    for (const ch of name) {
      if (/\s/.test(ch)) continue;
      sum += strokeCount(ch);
    }
    return sum;
  }

  // 取馬名首個有實義的字（跳過通用前綴）
  const SKIP_PREFIX = new Set(['金', '銀', '神', '飛', '快', '勁', '雄', '巨', '王', '帝', '至']);
  export function effectiveFirstChar(name: string): string {
    const chars = [...name].filter((c) => /[\u4e00-\u9fff]/.test(c));
    if (!chars.length) return '中';
    if (chars.length === 1) return chars[0];
    // 若首字屬通用前綴且有第二字，用第二字
    if (SKIP_PREFIX.has(chars[0])) return chars[1];
    return chars[0];
  }

  // 馬名落宮：取象 + 筆畫修正
  // 主宮 = 首字五行 → 宮；筆畫 mod 9 作 ±1 微調（不換宮，調整分數時會用到）
  export function horseNameToPalace(name: string): { palace: number; wx: WuXing; firstChar: string; totalStroke: number; strokeMod: number } {
    const firstChar = effectiveFirstChar(name);
    const wx = charWuxing(firstChar);
    const palace = wuxingToPalace(wx);
    const totalStroke = totalStrokes(name);
    const strokeMod = (totalStroke % 9); // 0~8
    return { palace, wx, firstChar, totalStroke, strokeMod };
  }

  // 騎師中文名：用筆畫總和 mod 9 + 1 落宮（無取象）
  export function jockeyNameToPalace(name: string): { palace: number; totalStroke: number } {
    const totalStroke = totalStrokes(name);
    return { palace: (totalStroke % 9) + 1, totalStroke };
  }
  