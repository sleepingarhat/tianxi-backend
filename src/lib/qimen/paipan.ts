// 時家奇門遁甲 · 排盤模組 (拆補法 v2)
  // 拆補法：以「符頭」(甲己日) 為三元起點，根據符頭與節氣的相對位置決定使用哪個節氣的局。
  // 符頭距節氣 0 日 = 正授；符頭在節氣前 1-9 日 = 超神；符頭在節氣後 1-9 日 = 接氣。

  export type Palace = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  export const NINE_STARS = ['天蓬', '天芮', '天衝', '天輔', '天禽', '天心', '天柱', '天任', '天英'] as const;
  export const EIGHT_DOORS = ['休門', '生門', '傷門', '杜門', '景門', '死門', '驚門', '開門'] as const;
  export const EIGHT_GODS = ['值符', '螣蛇', '太陰', '六合', '白虎', '玄武', '九地', '九天'] as const;

  const OUTER_PALACES_CW: Palace[] = [1, 8, 3, 4, 9, 2, 7, 6];

  const TIANGAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const DIZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

  export function jdnFromYMD(year: number, month: number, day: number): number {
    const a = Math.floor((14 - month) / 12);
    const y = year + 4800 - a;
    const m = month + 12 * a - 3;
    return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  }

  export function julianDayNumber(d: Date): number {
    return jdnFromYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  // 2000/1/1 = 戊午日 (干支序 54)
  export function dayGanzhiIndex(d: Date): number {
    const jdn = julianDayNumber(d);
    return ((jdn - 2451545 + 54) % 60 + 60) % 60;
  }

  export function ganzhiName(idx: number): string {
    const i = ((idx % 60) + 60) % 60;
    return TIANGAN[i % 10] + DIZHI[i % 12];
  }

  export function hourZhiIndex(d: Date): number {
    const hktHour = (d.getUTCHours() + 8) % 24;
    if (hktHour === 23 || hktHour === 0) return 0;
    return Math.floor((hktHour + 1) / 2);
  }

  export function hourGanzhiIndex(d: Date): { gan: number; zhi: number } {
    const dayGz = dayGanzhiIndex(d);
    const dayGan = dayGz % 10;
    const zhi = hourZhiIndex(d);
    const startGan = ((dayGan % 5) * 2) % 10;
    const gan = (startGan + zhi) % 10;
    return { gan, zhi };
  }

  // 24 節氣（公曆近似日期 ±1 日）+ 三元局數
  const JIEQI: Array<{ name: string; m: number; d: number; yang: boolean; ju: [number, number, number] }> = [
    { name: '冬至', m: 12, d: 22, yang: true, ju: [1, 7, 4] },
    { name: '小寒', m: 1, d: 6, yang: true, ju: [2, 8, 5] },
    { name: '大寒', m: 1, d: 20, yang: true, ju: [3, 9, 6] },
    { name: '立春', m: 2, d: 4, yang: true, ju: [8, 5, 2] },
    { name: '雨水', m: 2, d: 19, yang: true, ju: [9, 6, 3] },
    { name: '驚蟄', m: 3, d: 6, yang: true, ju: [1, 7, 4] },
    { name: '春分', m: 3, d: 21, yang: true, ju: [3, 9, 6] },
    { name: '清明', m: 4, d: 5, yang: true, ju: [4, 1, 7] },
    { name: '穀雨', m: 4, d: 20, yang: true, ju: [5, 2, 8] },
    { name: '立夏', m: 5, d: 6, yang: true, ju: [4, 1, 7] },
    { name: '小滿', m: 5, d: 21, yang: true, ju: [5, 2, 8] },
    { name: '芒種', m: 6, d: 6, yang: true, ju: [6, 3, 9] },
    { name: '夏至', m: 6, d: 21, yang: false, ju: [9, 3, 6] },
    { name: '小暑', m: 7, d: 7, yang: false, ju: [8, 2, 5] },
    { name: '大暑', m: 7, d: 23, yang: false, ju: [7, 1, 4] },
    { name: '立秋', m: 8, d: 8, yang: false, ju: [2, 5, 8] },
    { name: '處暑', m: 8, d: 23, yang: false, ju: [1, 4, 7] },
    { name: '白露', m: 9, d: 8, yang: false, ju: [9, 3, 6] },
    { name: '秋分', m: 9, d: 23, yang: false, ju: [7, 1, 4] },
    { name: '寒露', m: 10, d: 8, yang: false, ju: [6, 9, 3] },
    { name: '霜降', m: 10, d: 23, yang: false, ju: [5, 8, 2] },
    { name: '立冬', m: 11, d: 7, yang: false, ju: [6, 9, 3] },
    { name: '小雪', m: 11, d: 22, yang: false, ju: [5, 8, 2] },
    { name: '大雪', m: 12, d: 7, yang: false, ju: [4, 7, 1] },
  ];

  // 符頭 yuan：上元(0): 甲子/己卯/甲午/己酉 → dayGz%15==0
  //             中元(1): 甲戌/己丑/甲辰/己未 → dayGz%15==10
  //             下元(2): 甲申/己亥/甲寅/己巳 → dayGz%15==5
  export function yuanOfFutou(futouDayGz: number): 0 | 1 | 2 {
    const m = ((futouDayGz % 15) + 15) % 15;
    if (m === 0) return 0;
    if (m === 10) return 1;
    return 2;
  }

  export interface ChaibuResult {
    ju: number;
    yang: boolean;
    yuan: 0 | 1 | 2;
    yuanName: '上元' | '中元' | '下元';
    jieqiName: string;
    chaibuMode: '正授' | '超神' | '接氣';
    superShenDays: number;     // 符頭距節氣的絕對天數 (正授=0)
    futouDayGz: number;
    futouName: string;          // e.g. '甲子'
    dayGz: number;
    dayGzName: string;
  }

  // 拆補法主體
  export function determineJu(d: Date): ChaibuResult {
    const todayJdn = julianDayNumber(d);
    const dayGz = dayGanzhiIndex(d);
    const futouOffset = dayGz % 5;          // 0 = 今日即符頭
    const futouJdn = todayJdn - futouOffset;
    const futouDayGz = ((dayGz - futouOffset) % 60 + 60) % 60;

    // 構建鄰近三年所有節氣 JDN
    const year = d.getUTCFullYear();
    const candidates: Array<{ jdn: number; entry: typeof JIEQI[0] }> = [];
    for (const yr of [year - 1, year, year + 1]) {
      for (const j of JIEQI) {
        candidates.push({ jdn: jdnFromYMD(yr, j.m, j.d), entry: j });
      }
    }
    // 找距「符頭」最近的節氣（拆補法：以符頭定本節氣）
    candidates.sort((a, b) => Math.abs(a.jdn - futouJdn) - Math.abs(b.jdn - futouJdn));
    const active = candidates[0];

    const offsetDays = active.jdn - futouJdn; // >0 超神(符頭在節氣前)；<0 接氣(符頭在節氣後)；0 正授
    const chaibuMode: '正授' | '超神' | '接氣' = offsetDays === 0 ? '正授' : offsetDays > 0 ? '超神' : '接氣';
    const yuan = yuanOfFutou(futouDayGz);
    const yuanName = (['上元', '中元', '下元'] as const)[yuan];

    return {
      ju: active.entry.ju[yuan],
      yang: active.entry.yang,
      yuan,
      yuanName,
      jieqiName: active.entry.name,
      chaibuMode,
      superShenDays: Math.abs(offsetDays),
      futouDayGz,
      futouName: ganzhiName(futouDayGz),
      dayGz,
      dayGzName: ganzhiName(dayGz),
    };
  }

  export interface Paipan {
    ju: number;
    yang: boolean;
    chaibu: ChaibuResult;
    dayGanzhi: number;
    hourGan: number;
    hourZhi: number;
    stars: Record<Palace, string>;
    doors: Partial<Record<Palace, string>>;
    gods: Partial<Record<Palace, string>>;
    palaceScores: Record<Palace, number>;
    zhiFu: { palace: Palace; star: string };
    zhiShi: { palace: Palace; door: string };
  }

  export function paipan(d: Date): Paipan {
    const chaibu = determineJu(d);
    const { ju, yang } = chaibu;
    const dayGz = chaibu.dayGz;
    const { gan: hourGan, zhi: hourZhi } = hourGanzhiIndex(d);

    // 1. 九星佈局：陽遁順飛 / 陰遁逆飛，從 ju 宮起 天蓬
    const stars: Record<Palace, string> = {} as any;
    for (let i = 0; i < 9; i++) {
      const palace = (yang ? ((ju - 1 + i) % 9) : ((ju - 1 - i + 9) % 9)) + 1 as Palace;
      stars[palace] = NINE_STARS[i];
    }

    // 2. 八門佈局：值使門 起於 ju 宮（中5寄坤2），順時針(陽)/逆時針(陰)
    const zhiShiDoorIdx = (ju - 1) % 8;
    const doors: Partial<Record<Palace, string>> = {};
    const startPalace = (ju === 5 ? 2 : ju) as Palace;
    const startIdxCw = OUTER_PALACES_CW.indexOf(startPalace);
    for (let i = 0; i < 8; i++) {
      const idxCw = yang ? (startIdxCw + i) % 8 : (startIdxCw - i + 8) % 8;
      const palace = OUTER_PALACES_CW[idxCw];
      doors[palace] = EIGHT_DOORS[(zhiShiDoorIdx + i) % 8];
    }

    // 3. 八神：值符神 起於 值符星位（即 ju 宮 / 寄宮）
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
      ju, yang, chaibu, dayGanzhi: dayGz, hourGan, hourZhi,
      stars, doors, gods, palaceScores,
      zhiFu: { palace: startPalace, star: stars[startPalace] },
      zhiShi: { palace: startPalace, door: EIGHT_DOORS[zhiShiDoorIdx] },
    };
  }
  