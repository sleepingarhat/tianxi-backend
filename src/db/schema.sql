-- 天喜娛樂 Tianxi Entertainment
-- D1 Database Schema (SQLite compatible)
-- 歷史賽馬數據庫 2016-2026+

-- =============================================
-- 核心表
-- =============================================

-- 賽事日 (Race Meeting)
CREATE TABLE IF NOT EXISTS race_meetings (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  venue TEXT NOT NULL,                -- 'ST' (沙田) / 'HV' (跑馬地)
  track_condition TEXT,               -- 好地/黏地/軟地/濕軟地
  weather TEXT,
  total_races INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, venue)
);

CREATE INDEX IF NOT EXISTS idx_meetings_date ON race_meetings(date);

-- 賽事 (Race)
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES race_meetings(id),
  race_number INTEGER NOT NULL,
  title TEXT,
  class TEXT,                         -- Class 1-5, Griffin, Group 1/2/3
  distance INTEGER,                   -- 米
  going TEXT,                         -- 好地/黏地/軟地等
  track TEXT,                         -- 草地/泥地/全天候跑道
  course TEXT,                        -- A/A+3/B/B+2/C/C+3 等
  prize TEXT,
  start_time TEXT,
  video_url TEXT,
  UNIQUE(meeting_id, race_number)
);

CREATE INDEX IF NOT EXISTS idx_races_meeting ON races(meeting_id);

-- 馬匹 (Horse)
CREATE TABLE IF NOT EXISTS horses (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ch TEXT,
  code TEXT UNIQUE,                   -- HKJC 馬匹編號 e.g. 'V123'
  country_of_origin TEXT,
  colour TEXT,
  sex TEXT,
  age INTEGER,
  sire TEXT,                          -- 父系
  dam TEXT,                           -- 母系
  dam_sire TEXT,                      -- 母父系
  import_type TEXT,                   -- PP / PPG / ISG 等
  current_trainer_id TEXT,
  current_rating INTEGER,
  season_stakes INTEGER DEFAULT 0,
  total_wins INTEGER DEFAULT 0,
  total_starts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',       -- active / retired / deceased
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_horses_code ON horses(code);
CREATE INDEX IF NOT EXISTS idx_horses_name ON horses(name_en);

-- 騎師 (Jockey)
CREATE TABLE IF NOT EXISTS jockeys (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ch TEXT,
  nationality TEXT,
  licence_type TEXT,                  -- 自由身 / 從騎 / 見習
  is_active INTEGER DEFAULT 1
);

-- 練馬師 (Trainer)
CREATE TABLE IF NOT EXISTS trainers (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ch TEXT,
  nationality TEXT,
  location TEXT,                      -- 沙田/跑馬地
  is_active INTEGER DEFAULT 1
);

-- =============================================
-- 賽果與表現數據
-- =============================================

-- 賽果 (Race Result) — 核心表
CREATE TABLE IF NOT EXISTS race_results (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  horse_number INTEGER,               -- 馬號
  finishing_position INTEGER,         -- 名次 (999 = DNF/PU/UR)
  draw INTEGER,                       -- 檔位
  jockey_id TEXT REFERENCES jockeys(id),
  trainer_id TEXT REFERENCES trainers(id),
  actual_weight REAL,                 -- 實際負磅
  declared_weight REAL,               -- 宣佈負磅
  handicap_weight REAL,               -- 讓磅
  lbw TEXT,                           -- 落後距離 e.g. '1-1/4', 'N', 'SH'
  running_position TEXT,              -- 沿途走位 e.g. '2-2-1-1'
  finish_time REAL,                   -- 完成時間（秒）
  win_odds REAL,                      -- 獨贏賠率
  gear TEXT,                          -- 配備 e.g. 'B' (Blinkers), 'V' (Visor)
  race_class_rating INTEGER,          -- 當場評分
  UNIQUE(race_id, horse_id)
);

CREATE INDEX IF NOT EXISTS idx_results_race ON race_results(race_id);
CREATE INDEX IF NOT EXISTS idx_results_horse ON race_results(horse_id);
CREATE INDEX IF NOT EXISTS idx_results_jockey ON race_results(jockey_id);
CREATE INDEX IF NOT EXISTS idx_results_trainer ON race_results(trainer_id);
CREATE INDEX IF NOT EXISTS idx_results_position ON race_results(finishing_position);

-- 分段時間 (Sectional Times)
CREATE TABLE IF NOT EXISTS sectional_times (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  section_number INTEGER NOT NULL,    -- 第幾段 (1 = 第一段200m)
  section_distance INTEGER,           -- 該段距離（米）
  section_time REAL,                  -- 該段用時（秒）
  cumulative_time REAL,               -- 累計時間（秒）
  leading_horse TEXT,                 -- 領先馬匹
  UNIQUE(race_id, section_number)
);

CREATE INDEX IF NOT EXISTS idx_sectional_race ON sectional_times(race_id);

-- 個別馬匹分段時間
CREATE TABLE IF NOT EXISTS horse_sectional_times (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  section_number INTEGER NOT NULL,
  section_time REAL,
  position_at_section INTEGER,
  UNIQUE(race_id, horse_id, section_number)
);

-- 沿途走勢文字評述 (Running Comments)
CREATE TABLE IF NOT EXISTS running_comments (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  horse_id TEXT REFERENCES horses(id),
  comment_text TEXT NOT NULL,
  language TEXT DEFAULT 'ch',         -- 'ch' / 'en'
  UNIQUE(race_id, horse_id, language)
);

CREATE INDEX IF NOT EXISTS idx_comments_race ON running_comments(race_id);

-- =============================================
-- 派彩 (Dividends)
-- =============================================

CREATE TABLE IF NOT EXISTS dividends (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  pool_type TEXT NOT NULL,            -- WIN/PLA/QIN/QPL/TRI/FF/TCE/QTT/DBL/TBL
  combination TEXT,                   -- 中獎組合 e.g. '3' / '3,7' / '3,7,12'
  dividend REAL NOT NULL,             -- 每$10派彩
  UNIQUE(race_id, pool_type, combination)
);

CREATE INDEX IF NOT EXISTS idx_dividends_race ON dividends(race_id);

-- =============================================
-- 試閘 (Barrier Trials)
-- =============================================

CREATE TABLE IF NOT EXISTS barrier_trials (
  id TEXT PRIMARY KEY,
  horse_id TEXT NOT NULL REFERENCES horses(id),
  trial_date TEXT NOT NULL,
  venue TEXT,
  distance INTEGER,
  going TEXT,
  finishing_position INTEGER,
  total_runners INTEGER,
  time REAL,
  jockey TEXT,
  comment TEXT,
  UNIQUE(horse_id, trial_date, venue, distance)
);

CREATE INDEX IF NOT EXISTS idx_trials_horse ON barrier_trials(horse_id);
CREATE INDEX IF NOT EXISTS idx_trials_date ON barrier_trials(trial_date);

-- =============================================
-- 晨操 (Trackwork)
-- =============================================

CREATE TABLE IF NOT EXISTS trackwork (
  id TEXT PRIMARY KEY,
  horse_id TEXT NOT NULL REFERENCES horses(id),
  date TEXT NOT NULL,
  venue TEXT,
  batch TEXT,
  distance INTEGER,
  time TEXT,
  partner TEXT,
  comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_trackwork_horse ON trackwork(horse_id);
CREATE INDEX IF NOT EXISTS idx_trackwork_date ON trackwork(date);

-- =============================================
-- 即時賠率快照 (Live Odds Snapshots)
-- =============================================

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  timestamp TEXT NOT NULL,
  win_odds REAL,
  place_odds REAL,
  pool_investment REAL,
  odds_type TEXT DEFAULT 'live'       -- 'opening' / 'live' / 'final'
);

CREATE INDEX IF NOT EXISTS idx_odds_race ON odds_snapshots(race_id);
CREATE INDEX IF NOT EXISTS idx_odds_horse ON odds_snapshots(horse_id, race_id);
CREATE INDEX IF NOT EXISTS idx_odds_timestamp ON odds_snapshots(timestamp);

-- =============================================
-- 影片連結 (Video Links)
-- =============================================

CREATE TABLE IF NOT EXISTS race_videos (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  video_url TEXT NOT NULL,
  video_type TEXT DEFAULT 'replay',   -- 'replay' / 'sectional' / 'patrol'
  UNIQUE(race_id, video_type)
);

-- =============================================
-- 用戶系統 (Users - 付費平台)
-- =============================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  subscription_tier TEXT DEFAULT 'free',  -- 'free' / 'basic' / 'premium'
  subscription_expires TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =============================================
-- 統計視圖 (便利查詢)
-- =============================================

-- 騎師統計 view
CREATE VIEW IF NOT EXISTS v_jockey_stats AS
SELECT
  j.id,
  j.name_en,
  j.name_ch,
  COUNT(rr.id) AS total_rides,
  SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN rr.finishing_position <= 3 THEN 1 ELSE 0 END) AS top3,
  ROUND(CAST(SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS win_rate,
  ROUND(CAST(SUM(CASE WHEN rr.finishing_position <= 3 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS top3_rate
FROM jockeys j
JOIN race_results rr ON rr.jockey_id = j.id
GROUP BY j.id;

-- 練馬師統計 view
CREATE VIEW IF NOT EXISTS v_trainer_stats AS
SELECT
  t.id,
  t.name_en,
  t.name_ch,
  COUNT(rr.id) AS total_runners,
  SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN rr.finishing_position <= 3 THEN 1 ELSE 0 END) AS top3,
  ROUND(CAST(SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS win_rate
FROM trainers t
JOIN race_results rr ON rr.trainer_id = t.id
GROUP BY t.id;

-- 騎練配對統計 view
CREATE VIEW IF NOT EXISTS v_jockey_trainer_combo AS
SELECT
  j.name_ch AS jockey_name,
  t.name_ch AS trainer_name,
  j.id AS jockey_id,
  t.id AS trainer_id,
  COUNT(rr.id) AS total_rides,
  SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS wins,
  ROUND(CAST(SUM(CASE WHEN rr.finishing_position = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(rr.id) * 100, 1) AS win_rate
FROM race_results rr
JOIN jockeys j ON j.id = rr.jockey_id
JOIN trainers t ON t.id = rr.trainer_id
GROUP BY rr.jockey_id, rr.trainer_id
HAVING COUNT(rr.id) >= 5;

-- 馬匹往績 view
CREATE VIEW IF NOT EXISTS v_horse_form AS
SELECT
  h.id AS horse_id,
  h.name_ch,
  h.name_en,
  rm.date,
  rm.venue,
  r.race_number,
  r.distance,
  r.class,
  r.going,
  rr.finishing_position,
  rr.draw,
  rr.finish_time,
  rr.win_odds,
  rr.running_position,
  rr.lbw,
  rr.gear,
  j.name_ch AS jockey_name,
  t.name_ch AS trainer_name
FROM race_results rr
JOIN horses h ON h.id = rr.horse_id
JOIN races r ON r.id = rr.race_id
JOIN race_meetings rm ON rm.id = r.meeting_id
LEFT JOIN jockeys j ON j.id = rr.jockey_id
LEFT JOIN trainers t ON t.id = rr.trainer_id
ORDER BY rm.date DESC;
