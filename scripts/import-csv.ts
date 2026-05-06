/**
 * 天喜娛樂 — CSV 數據導入腳本 (配合 HKJC 實際 CSV 格式)
 *
 * 將 Scraper 產生的 CSV 檔案導入到 SQLite/D1 數據庫。
 *
 * 用法：
 *   npx tsx scripts/import-csv.ts --data-dir ./data --db ./local.db
 *
 * CSV 格式（每個賽馬日 5 個檔案）：
 *   results_YYYY-MM-DD.csv         — 賽果 + 賽事資料
 *   dividends_YYYY-MM-DD.csv       — 派彩
 *   sectional_times_YYYY-MM-DD.csv — 分段時間
 *   commentary_YYYY-MM-DD.csv      — 沿途走勢文字評述
 *   video_links_YYYY-MM-DD.csv     — 影片連結
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// =============================================
// CLI 參數
// =============================================

const args = process.argv.slice(2);
const dataDir = getArg('--data-dir') || './data';
const dbPath = getArg('--db') || './local.db';
const yearFilter = getArg('--year');  // 可選: 只導入指定年份
const dateFilter = getArg('--date');  // 可選: 只導入指定日期

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// =============================================
// 解析工具
// =============================================

// 中文場地 → 代碼
function normalizeVenue(zhVenue: string): string {
  if (!zhVenue) return '';
  if (zhVenue.includes('沙田')) return 'ST';
  if (zhVenue.includes('跑馬地')) return 'HV';
  if (zhVenue.toUpperCase().includes('ST')) return 'ST';
  if (zhVenue.toUpperCase().includes('HV')) return 'HV';
  return zhVenue;
}

// 中文 Pool 名稱 → 代碼
function normalizePool(zhPool: string): string {
  const map: Record<string, string> = {
    '獨贏': 'WIN',
    '位置': 'PLA',
    '連贏': 'QIN',
    '位置Q': 'QPL',
    '三重彩': 'TRI',
    '四連環': 'FF',
    '單T': 'TCE',
    '孖T': 'DTC',
    '三T': 'TTT',
    '四重彩': 'QTT',
    '孖寶': 'DBL',
    '三寶': 'TBL',
    '六環彩': 'SIX',
    '過關': 'AUP',
  };
  return map[zhPool.trim()] || zhPool.trim();
}

// 從 "喆喆友福 (J345)" 提取馬匹代碼
function extractHorseCode(horseName: string): { name: string; code: string } {
  if (!horseName) return { name: '', code: '' };
  const match = horseName.match(/^(.+?)\s*\(([A-Z]?\d+[A-Z]?)\)\s*$/);
  if (match) {
    return { name: match[1].trim(), code: match[2].trim() };
  }
  return { name: horseName.trim(), code: '' };
}

// 將 "0:56.75" / "1:23.45" / "56.75" 轉為秒
function parseFinishTime(s: string): number | null {
  if (!s) return null;
  s = s.trim();
  if (s === '---' || s === '-' || s === '') return null;

  // Format: M:SS.ss
  const mmssMatch = s.match(/^(\d+):(\d+\.?\d*)$/);
  if (mmssMatch) {
    return parseInt(mmssMatch[1]) * 60 + parseFloat(mmssMatch[2]);
  }

  // Plain number
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

function parseInteger(s: string | undefined): number | null {
  if (!s || s.trim() === '' || s.trim() === '-' || s.trim() === '---') return null;
  const n = parseInt(s);
  return isNaN(n) ? null : n;
}

function parseFloatOrNull(s: string | undefined): number | null {
  if (!s || s.trim() === '' || s.trim() === '-' || s.trim() === '---') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// =============================================
// CSV 解析（支持 BOM 同 quoted fields）
// =============================================

function parseCSV(content: string): Record<string, string>[] {
  // 移除 BOM
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);

  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// =============================================
// ID 生成
// =============================================

function generateId(prefix: string, ...parts: string[]): string {
  const hash = parts.join('_').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 180);
  return `${prefix}_${hash}`;
}

function meetingId(date: string, venue: string): string {
  return `${date}_${venue}`;
}

function raceId(date: string, venue: string, raceNo: string | number): string {
  return `race_${date}_${venue}_${raceNo}`;
}

function horseId(code: string, fallbackName: string): string {
  if (code) return `horse_${code}`;
  // Fallback: hash from name
  return `horse_${fallbackName.replace(/[^\w]/g, '_').slice(0, 100)}`;
}

function personId(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/[^\w\u4e00-\u9fff]/g, '_').slice(0, 100)}`;
}

// =============================================
// 初始化數據庫
// =============================================

function initDatabase(db: Database.Database) {
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/db/schema.sql'),
    'utf-8'
  );

  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      db.exec(stmt + ';');
    } catch (err: any) {
      if (!err.message.includes('already exists')) {
        console.warn(`Schema warning: ${err.message.slice(0, 150)}`);
      }
    }
  }
}

// =============================================
// Prepared Statements
// =============================================

function prepareStatements(db: Database.Database) {
  return {
    insertMeeting: db.prepare(`
      INSERT OR IGNORE INTO race_meetings (id, date, venue, track_condition, total_races)
      VALUES (?, ?, ?, ?, ?)
    `),
    updateMeetingRaces: db.prepare(`
      UPDATE race_meetings SET total_races = ? WHERE id = ?
    `),
    insertRace: db.prepare(`
      INSERT OR REPLACE INTO races
      (id, meeting_id, race_number, title, class, distance, going, track, course, prize, start_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertHorse: db.prepare(`
      INSERT OR IGNORE INTO horses (id, name_en, name_ch, code)
      VALUES (?, ?, ?, ?)
    `),
    updateHorseName: db.prepare(`
      UPDATE horses SET name_ch = COALESCE(NULLIF(name_ch, ''), ?) WHERE id = ?
    `),
    insertJockey: db.prepare(`
      INSERT OR IGNORE INTO jockeys (id, name_en, name_ch)
      VALUES (?, ?, ?)
    `),
    insertTrainer: db.prepare(`
      INSERT OR IGNORE INTO trainers (id, name_en, name_ch)
      VALUES (?, ?, ?)
    `),
    insertResult: db.prepare(`
      INSERT OR REPLACE INTO race_results
      (id, race_id, horse_id, horse_number, finishing_position, draw, jockey_id, trainer_id,
       actual_weight, declared_weight, lbw, running_position, finish_time, win_odds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertDividend: db.prepare(`
      INSERT OR REPLACE INTO dividends (id, race_id, pool_type, combination, dividend)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertHorseSectional: db.prepare(`
      INSERT OR REPLACE INTO horse_sectional_times
      (id, race_id, horse_id, section_number, section_time, position_at_section)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertComment: db.prepare(`
      INSERT OR REPLACE INTO running_comments (id, race_id, horse_id, comment_text, language)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertVideo: db.prepare(`
      INSERT OR REPLACE INTO race_videos (id, race_id, video_url, video_type)
      VALUES (?, ?, ?, ?)
    `),
  };
}

type Stmts = ReturnType<typeof prepareStatements>;

// =============================================
// 導入 results CSV (賽果 + 賽事資料)
// =============================================

function importResults(stmts: Stmts, db: Database.Database, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) return 0;

  const transaction = db.transaction(() => {
    // 先建立 meeting（一個檔案對應一個賽馬日）
    const firstRow = rows[0];
    const date = firstRow.date;
    const venue = normalizeVenue(firstRow.venue);
    const mId = meetingId(date, venue);

    // 從 rows 推斷場地狀況
    const goingValues = new Set(rows.map((r) => r.going).filter(Boolean));
    const going = Array.from(goingValues).join(' / ');

    const raceCount = new Set(rows.map((r) => r.race_no)).size;

    stmts.insertMeeting.run(mId, date, venue, going, raceCount);
    stmts.updateMeetingRaces.run(raceCount, mId);

    // 按場次分組
    const raceGroups = new Map<string, Record<string, string>[]>();
    for (const row of rows) {
      const raceNo = row.race_no || '1';
      if (!raceGroups.has(raceNo)) raceGroups.set(raceNo, []);
      raceGroups.get(raceNo)!.push(row);
    }

    for (const [raceNo, entries] of raceGroups) {
      const rId = raceId(date, venue, raceNo);
      const first = entries[0];

      stmts.insertRace.run(
        rId,
        mId,
        parseInt(raceNo),
        first.race_name || null,
        first.race_class || null,
        parseInteger(first.distance_m),
        first.going || null,
        null,  // track (grass/dirt) — 需要從 course 推斷
        first.course || null,
        first.prize_hkd || null,
        // race_finish_time CSV 欄位實際係分段時間 splits，唔係 clock 時間。
        // HKJC results CSV 冇 start_time，留 null；scheduled 賽事 start time 由另一個 source 填入。
        null
      );

      for (const entry of entries) {
        const { name: horseName, code: horseCode } = extractHorseCode(entry.horse_name);
        const hId = horseId(horseCode, horseName);

        stmts.insertHorse.run(hId, horseName, horseName, horseCode);
        if (horseName) {
          stmts.updateHorseName.run(horseName, hId);
        }

        // Jockey
        let jId: string | null = null;
        if (entry.jockey) {
          jId = personId('jockey', entry.jockey);
          stmts.insertJockey.run(jId, entry.jockey, entry.jockey);
        }

        // Trainer
        let tId: string | null = null;
        if (entry.trainer) {
          tId = personId('trainer', entry.trainer);
          stmts.insertTrainer.run(tId, entry.trainer, entry.trainer);
        }

        // Result
        const resultId = generateId('result', date, venue, raceNo, horseCode || horseName);
        const position = parseInteger(entry.place);
        // 處理 DNF / PU / UR 等特殊情況（place 可能係 "---" 或 非數字）
        const finalPosition = position ?? (entry.place && /^\d+$/.test(entry.place) ? parseInt(entry.place) : null);

        stmts.insertResult.run(
          resultId,
          rId,
          hId,
          parseInteger(entry.horse_no),
          finalPosition,
          parseInteger(entry.draw),
          jId,
          tId,
          parseFloatOrNull(entry.actual_wt_lbs),
          parseFloatOrNull(entry.declared_wt_lbs),
          entry.lbw || null,
          entry.running_position || null,
          parseFinishTime(entry.finish_time),
          parseFloatOrNull(entry.win_odds)
        );
      }
    }
  });

  transaction();
  return rows.length;
}

// =============================================
// 導入 dividends CSV
// =============================================

function importDividends(stmts: Stmts, db: Database.Database, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) return 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const date = row.date;
      const venue = normalizeVenue(row.venue);
      const raceNo = row.race_no;
      const rId = raceId(date, venue, raceNo);
      const poolType = normalizePool(row.pool);
      const combo = row.combination || '';
      const dividend = parseFloatOrNull(row.dividend_hkd);

      if (poolType && dividend !== null) {
        const dId = generateId('div', date, venue, raceNo, poolType, combo);
        stmts.insertDividend.run(dId, rId, poolType, combo, dividend);
      }
    }
  });

  transaction();
  return rows.length;
}

// =============================================
// 導入 sectional_times CSV (個別馬匹分段)
// =============================================

function importSectionals(stmts: Stmts, db: Database.Database, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) return 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const date = row.date;
      const venue = normalizeVenue(row.venue);
      const raceNo = row.race_no;
      const rId = raceId(date, venue, raceNo);
      const { code: horseCode, name: horseName } = extractHorseCode(row.horse_name);
      const hId = horseId(horseCode, horseName);

      // 每段 (sec1, sec2, ...) 分別插入
      for (let sec = 1; sec <= 6; sec++) {
        const timeStr = row[`sec${sec}_time`];
        const posStr = row[`sec${sec}_running_pos`];

        // sec_time 可能係 "12.78" 或 "21.18 10.24    10.94"（累計＋分段）
        let secTime: number | null = null;
        if (timeStr) {
          const firstNum = timeStr.match(/[\d.]+/);
          if (firstNum) secTime = parseFloat(firstNum[0]);
        }

        const position = parseInteger(posStr);

        if (secTime !== null) {
          const sId = generateId('sec', date, venue, raceNo, horseCode || horseName, String(sec));
          stmts.insertHorseSectional.run(sId, rId, hId, sec, secTime, position);
        }
      }
    }
  });

  transaction();
  return rows.length;
}

// =============================================
// 導入 commentary CSV (沿途走勢評述)
// =============================================

function importCommentary(stmts: Stmts, db: Database.Database, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) return 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const date = row.date;
      const venue = normalizeVenue(row.venue);
      const raceNo = row.race_no;
      const rId = raceId(date, venue, raceNo);
      const { code: horseCode, name: horseName } = extractHorseCode(row.horse_name);
      const hId = horseId(horseCode, horseName);
      const comment = row.commentary || '';

      if (comment && comment !== '無特別報告') {
        // 只存有內容嘅評述，「無特別報告」跳過以節省空間
      }

      if (comment) {
        const cId = generateId('cmt', date, venue, raceNo, horseCode || horseName);
        stmts.insertComment.run(cId, rId, hId, comment, 'ch');
      }

      // 同時更新 race_results 嘅 gear 欄位
      if (row.gear) {
        db.prepare(`
          UPDATE race_results SET gear = ?
          WHERE race_id = ? AND horse_id = ? AND (gear IS NULL OR gear = '')
        `).run(row.gear, rId, hId);
      }
    }
  });

  transaction();
  return rows.length;
}

// =============================================
// 導入 video_links CSV
// =============================================

function importVideos(stmts: Stmts, db: Database.Database, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) return 0;

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const date = row.date;
      const venue = normalizeVenue(row.venue);
      const raceNo = row.race_no;
      const rId = raceId(date, venue, raceNo);

      for (const [field, type] of [
        ['video_full_url', 'replay'],
        ['video_passthrough_url', 'passthrough'],
        ['video_aerial_url', 'aerial'],
      ] as const) {
        const url = row[field];
        if (url && url.trim()) {
          const vId = generateId('vid', date, venue, raceNo, type);
          stmts.insertVideo.run(vId, rId, url.trim(), type);
        }
      }
    }
  });

  transaction();
  return rows.length;
}

// =============================================
// 主程序
// =============================================

function main() {
  console.log('=== 天喜娛樂 CSV 數據導入工具 ===');
  console.log(`數據目錄: ${dataDir}`);
  console.log(`數據庫: ${dbPath}`);
  if (yearFilter) console.log(`年份過濾: ${yearFilter}`);
  if (dateFilter) console.log(`日期過濾: ${dateFilter}`);

  if (!fs.existsSync(dataDir)) {
    console.error(`Error: 找不到數據目錄: ${dataDir}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF');  // 導入階段關閉 FK 加速

  initDatabase(db);
  const stmts = prepareStatements(db);

  // 掃描年份目錄
  const years = fs.readdirSync(dataDir).filter((d) => {
    const fullPath = path.join(dataDir, d);
    return fs.statSync(fullPath).isDirectory() && /^\d{4}$/.test(d);
  }).sort();

  let stats = {
    files: 0,
    results: 0,
    dividends: 0,
    sectionals: 0,
    comments: 0,
    videos: 0,
    errors: 0,
  };

  for (const year of years) {
    if (yearFilter && year !== yearFilter) continue;

    const yearDir = path.join(dataDir, year);
    const files = fs.readdirSync(yearDir).sort();

    // 按日期分組
    const dateFileMap = new Map<string, { results?: string; dividends?: string; sectionals?: string; commentary?: string; videos?: string }>();

    for (const file of files) {
      const match = file.match(/^(\w+)_(\d{4}-\d{2}-\d{2})\.csv$/);
      if (!match) continue;
      const type = match[1];
      const date = match[2];
      if (dateFilter && date !== dateFilter) continue;

      if (!dateFileMap.has(date)) dateFileMap.set(date, {});
      const group = dateFileMap.get(date)!;
      const filePath = path.join(yearDir, file);

      if (type === 'results') group.results = filePath;
      else if (type === 'dividends') group.dividends = filePath;
      else if (type === 'sectional_times') group.sectionals = filePath;
      else if (type === 'commentary') group.commentary = filePath;
      else if (type === 'video_links') group.videos = filePath;
    }

    console.log(`\n[${year}] 發現 ${dateFileMap.size} 個賽馬日`);

    let processed = 0;
    for (const [date, files] of dateFileMap) {
      try {
        // 必須先導 results（建立 meeting 同 race）
        if (files.results) {
          stats.results += importResults(stmts, db, files.results);
        }
        if (files.dividends) {
          stats.dividends += importDividends(stmts, db, files.dividends);
        }
        if (files.sectionals) {
          stats.sectionals += importSectionals(stmts, db, files.sectionals);
        }
        if (files.commentary) {
          stats.comments += importCommentary(stmts, db, files.commentary);
        }
        if (files.videos) {
          stats.videos += importVideos(stmts, db, files.videos);
        }

        stats.files += Object.values(files).filter(Boolean).length;
        processed++;

        if (processed % 50 === 0) {
          process.stdout.write(`  ${processed}/${dateFileMap.size} ...\r`);
        }
      } catch (err: any) {
        stats.errors++;
        console.error(`\n  [錯誤] ${date}: ${err.message}`);
      }
    }
    console.log(`  [${year}] 完成 ${processed}/${dateFileMap.size} 賽馬日`);
  }

  // 更新馬匹統計
  console.log('\n更新馬匹統計...');
  db.exec(`
    UPDATE horses SET
      total_starts = (SELECT COUNT(*) FROM race_results WHERE horse_id = horses.id),
      total_wins = (SELECT COUNT(*) FROM race_results WHERE horse_id = horses.id AND finishing_position = 1)
  `);

  // 統計
  const final = {
    meetings: (db.prepare('SELECT COUNT(*) AS c FROM race_meetings').get() as any).c,
    races: (db.prepare('SELECT COUNT(*) AS c FROM races').get() as any).c,
    results: (db.prepare('SELECT COUNT(*) AS c FROM race_results').get() as any).c,
    horses: (db.prepare('SELECT COUNT(*) AS c FROM horses').get() as any).c,
    jockeys: (db.prepare('SELECT COUNT(*) AS c FROM jockeys').get() as any).c,
    trainers: (db.prepare('SELECT COUNT(*) AS c FROM trainers').get() as any).c,
    dividends: (db.prepare('SELECT COUNT(*) AS c FROM dividends').get() as any).c,
    sectionals: (db.prepare('SELECT COUNT(*) AS c FROM horse_sectional_times').get() as any).c,
    comments: (db.prepare('SELECT COUNT(*) AS c FROM running_comments').get() as any).c,
    videos: (db.prepare('SELECT COUNT(*) AS c FROM race_videos').get() as any).c,
  };

  console.log('\n=== 導入完成 ===');
  console.log(`處理檔案:         ${stats.files}`);
  console.log(`錯誤:             ${stats.errors}`);
  console.log(`──────────────────────`);
  console.log(`賽馬日:           ${final.meetings}`);
  console.log(`場次:             ${final.races}`);
  console.log(`賽果記錄:         ${final.results}`);
  console.log(`馬匹:             ${final.horses}`);
  console.log(`騎師:             ${final.jockeys}`);
  console.log(`練馬師:           ${final.trainers}`);
  console.log(`派彩:             ${final.dividends}`);
  console.log(`分段時間:         ${final.sectionals}`);
  console.log(`沿途評述:         ${final.comments}`);
  console.log(`影片連結:         ${final.videos}`);

  db.close();
}

main();
