// 時家奇門遁甲 · 排盤模組
  // 依賽事日期時間，產出九宮的 (門/星/神) 配置 + 各宮綜合吉凶分數。
  // 使用 Julian Day Number 計算干支，避免 timezone 與閏月問題。

  export type Palace = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  // 九星（順序：蓬芮沖輔禽心柱任英 = 1~9 宮原位）
  export const NINE_STARS = ['天蓬', '天芮', '天衝', '天輔', '天禽', '天心', '天柱', '天任', '天英'] as const;
  // 八門（順序：休生傷杜景死驚開）
  export const EIGHT_DOORS = ['休門', '生門', '傷門', '杜門', '景門', '死門', '驚門', '開門'] as const;
  // 八神（陽遁順序：值符螣蛇太陰六合白虎玄武九地九天 / 陰遁逆置）
  export const EIGHT_GODS = ['值符', '螣蛇', '太陰', '六合', '白虎', '玄武', '九地', '九天'] as const;

  // 洛書宮位順序（後天八卦）：1坎 2坤 3震 4巽 5中 6乾 7兌 8艮 9離
  // 八門/八神排列順序（順時針，跳過中5）：1→8→3→4→9→2→7→6→1
  const OUTER_PALACES_CW: Palace[] = [1, 8, 3, 4, 9, 2, 7, 6];

  // === 干支計算 ===
  const TIANGAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const DIZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

  function julianDayNumber(d: Date): number {
    // Convert UTC date → JDN
    const a = Math.floor((14 - (d.getUTCMonth() + 1)) / 12);
    const y = d.getUTCFullYear() + 4800 - a;
    const m = (d.getUTCMonth() + 1) + 12 * a - 3;
    return d.getUTCDate() + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  }

  // JDN 2451545 = 2000/1/1 12:00 UTC，對應 戊午 日（gan=4, zhi=6 → 干支序 54）
  export function dayGanzhiIndex(d: Date): number {
    const jdn = julianDayNumber(d);
    return ((jdn - 2451545 + 54) % 60 + 60) % 60;
  }

  // 時辰：以 HKT (UTC+8) 計算
  export function hourZhiIndex(d: Date): number {
    const hktHour = (d.getUTCHours() + 8) % 24;
    // 23-1 = 子(0), 1-3 = 丑(1), ...
    if (hktHour === 23 || hktHour === 0) return 0;
    return Math.floor((hktHour + 1) / 2);
  }

  // 時干：日干起時干表（甲己起甲子，乙庚起丙子...）
  export function hourGanzhiIndex(d: Date): { gan: number; zhi: number } {
    const dayGz = dayGanzhiIndex(d);
    const dayGan = dayGz % 10;
    const zhi = hourZhiIndex(d);
    // 甲(0)/己(5) → 子時起甲(0)，乙(1)/庚(6) → 丙(2)，丙(2)/辛(7) → 戊(4)，丁(3)/壬(8) → 庚(6)，戊(4)/癸(9) → 壬(8)
    const startGan = ((dayGan % 5) * 2) % 10;
    const gan = (startGan + zhi) % 10;
    return { gan, zhi };
  }

  // === 24 節氣（公曆近似日期，誤差 ±1 日，對 v1 足夠）===
  // 每項：[月, 日, 陽遁? (true=冬至到夏至前), 三元局數 [上元, 中元, 下元]]
  const JIEQI: Array<{ m: number; d: number; yang: boolean; ju: [number, number, number] }> = [
    { m: 12, d: 22, yang: true, ju: [1, 7, 4] }, // 冬至
    { m: 1, d: 6, yang: true, ju: [2, 8, 5] },   // 小寒
    { m: 1, d: 20, yang: true, ju: [3, 9, 6] },  // 大寒
    { m: 2, d: 4, yang: true, ju: [8, 5, 2] },   // 立春
    { m: 2, d: 19, yang: true, ju: [9, 6, 3] },  // 雨水
    { m: 3, d: 6, yang: true, ju: [1, 7, 4] },   // 驚蟄
    { m: 3, d: 21, yang: true, ju: [3, 9, 6] },  // 春分
    { m: 4, d: 5, yang: true, ju: [4, 1, 7] },   // 清明
    { m: 4, d: 20, yang: true, ju: [5, 2, 8] },  // 穀雨
    { m: 5, d: 6, yang: true, ju: [4, 1, 7] },   // 立夏
    { m: 5, d: 21, yang: true, ju: [5, 2, 8] },  // 小滿
    { m: 6, d: 6, yang: true, ju: [6, 3, 9] },   // 芒種
    { m: 6, d: 21, yang: false, ju: [9, 3, 6] }, // 夏至（陰遁起）
    { m: 7, d: 7, yang: false, ju: [8, 2, 5] },  // 小暑
    { m: 7, d: 23, yang: false, ju: [7, 1, 4] }, // 大暑
    { m: 8, d: 8, yang: false, ju: [2, 5, 8] },  // 立秋
    { m: 8, d: 23, yang: false, ju: [1, 4, 7] }, // 處暑
    { m: 9, d: 8, yang: false, ju: [9, 3, 6] },  // 白露
    { m: 9, d: 23, yang: false, ju: [7, 1, 4] }, // 秋分
    { m: 10, d: 8, yang: false, ju: [6, 9, 3] }, // 寒露
    { m: 10, d: 23, yang: false, ju: [5, 8, 2] },// 霜降
    { m: 11, d: 7, yang: false, ju: [6, 9, 3] }, // 立冬
    { m: 11, d: 22, yang: false, ju: [5, 8, 2] },// 小雪
    { m: 12, d: 7, yang: false, ju: [4, 7, 1] }, // 大雪
  ];

  // 找出當天所屬節氣（最接近且不晚於今天的）
  export function currentJieqi(d: Date): { idx: number; entry: typeof JIEQI[0] } {
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    let best = JIEQI.length - 1;
    let bestDist = Infinity;
    for (let i = 0; i < JIEQI.length; i++) {
      const j = JIEQI[i];
      // dayofyear-ish distance assuming non-leap
      const todayDoy = m * 31 + day;
      const jDoy = j.m * 31 + j.d;
      let dist = todayDoy - jDoy;
      if (dist < 0) dist += 372; // wrap year
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return { idx: best, entry: JIEQI[best] };
  }

  // 三元（上中下）依 日干支 旬首決定：
  // 甲子旬(0-9) 上元 / 甲戌旬(10-19) 中元 / 甲申旬(20-29) 下元 / 甲午(30-39) 上元 / 甲辰(40-49) 中元 / 甲寅(50-59) 下元
  export function yuanIndex(dayGz: number): 0 | 1 | 2 {
    const x = Math.floor(dayGz / 10) % 3;
    return x as 0 | 1 | 2;
  }

  export function determineJu(d: Date): { ju: number; yang: boolean } {
    const { entry } = currentJieqi(d);
    const yuan = yuanIndex(dayGanzhiIndex(d));
    return { ju: entry.ju[yuan], yang: entry.yang };
  }

  // === 排盤主函式 ===
  export interface Paipan {
    ju: number;
    yang: boolean;
    dayGanzhi: number;
    hourGan: number;
    hourZhi: number;
    // palace → 星名 (1~9)
    stars: Record<Palace, string>;
    // palace → 門名 (5 = 中宮無門)
    doors: Partial<Record<Palace, string>>;
    // palace → 神名 (5 = 中宮無神)
    gods: Partial<Record<Palace, string>>;
    // palace → 綜合吉凶 (-10 ~ +10)
    palaceScores: Record<Palace, number>;
    zhiFu: { palace: Palace; star: string };  // 值符
    zhiShi: { palace: Palace; door: string }; // 直使
  }

  export function paipan(d: Date): Paipan {
    const { ju, yang } = determineJu(d);
    const dayGz = dayGanzhiIndex(d);
    const { gan: hourGan, zhi: hourZhi } = hourGanzhiIndex(d);

    // 1. 九星佈局：陽遁順飛、陰遁逆飛，從 ju 宮起 天蓬
    const stars: Record<Palace, string> = {} as any;
    // 飛行順序：陽遁 1→2→3→4→5→6→7→8→9 / 陰遁 9→8→...→1
    for (let i = 0; i < 9; i++) {
      const palace = (yang ? ((ju - 1 + i) % 9) : ((ju - 1 - i + 9) % 9)) + 1 as Palace;
      stars[palace] = NINE_STARS[i];
    }

    // 2. 八門佈局：值使門 = EIGHT_DOORS[ju-1]，從 ju 宮起，順時針(陽)/逆(陰) 排在 8 個外宮
    const zhiShiDoorIdx = (ju - 1) % 8;
    const doors: Partial<Record<Palace, string>> = {};
    // 起始位：找 ju 在 OUTER_PALACES_CW 的位置；若 ju=5（中宮），用其寄宮 2 (坤)
    const startPalace = (ju === 5 ? 2 : ju) as Palace;
    const startIdxCw = OUTER_PALACES_CW.indexOf(startPalace);
    for (let i = 0; i < 8; i++) {
      const idxCw = yang ? (startIdxCw + i) % 8 : (startIdxCw - i + 8) % 8;
      const palace = OUTER_PALACES_CW[idxCw];
      doors[palace] = EIGHT_DOORS[(zhiShiDoorIdx + i) % 8];
    }

    // 3. 八神：值符神 起於 值符星 所在宮（即 ju 宮 / 寄宮）
    const gods: Partial<Record<Palace, string>> = {};
    const startGodPalace = (ju === 5 ? 2 : ju) as Palace;
    const startIdxGod = OUTER_PALACES_CW.indexOf(startGodPalace);
    for (let i = 0; i < 8; i++) {
      const idxCw = yang ? (startIdxGod + i) % 8 : (startIdxGod - i + 8) % 8;
      const palace = OUTER_PALACES_CW[idxCw];
      gods[palace] = EIGHT_GODS[i];
    }

    // 4. 各宮綜合吉凶分數
    const STAR_SCORE: Record<string, number> = { '天蓬': -3, '天芮': -3, '天衝': 1, '天輔': 3, '天禽': 2, '天心': 3, '天柱': -1, '天任': 2, '天英': -1 };
    const DOOR_SCORE: Record<string, number> = { '休門': 3, '生門': 3, '傷門': -2, '杜門': -1, '景門': 1, '死門': -3, '驚門': -2, '開門': 3 };
    const GOD_SCORE: Record<string, number> = { '值符': 2, '螣蛇': -1, '太陰': 1, '六合': 1, '白虎': -2, '玄武': -2, '九地': -1, '九天': 1 };

    const palaceScores: Record<Palace, number> = {} as any;
    for (let p = 1; p <= 9; p++) {
      const s = STAR_SCORE[stars[p as Palace]] ?? 0;
      const dn = doors[p as Palace];
      const gn = gods[p as Palace];
      const dS = dn ? (DOOR_SCORE[dn] ?? 0) : 0;
      const gS = gn ? (GOD_SCORE[gn] ?? 0) : 0;
      palaceScores[p as Palace] = s + dS + gS;
    }

    return {
      ju, yang, dayGanzhi: dayGz, hourGan, hourZhi,
      stars, doors, gods, palaceScores,
      zhiFu: { palace: startPalace, star: stars[startPalace] },
      zhiShi: { palace: startPalace, door: EIGHT_DOORS[zhiShiDoorIdx] },
    };
  }
  