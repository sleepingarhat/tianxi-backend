-- 天喜娛樂 Tianxi Entertainment
-- D1 Database Schema v2 (Additive Migration)
-- 配合 Replit Pool A/B/C 數據結構 + Elo engine
-- 日期：2026-04-21
--
-- 部署原則：純 additive — 唔 ALTER 現有表、唔 DROP、唔 rename
-- 應用順序：schema.sql → schema_v2.sql
-- Idempotent: 全部 CREATE ... IF NOT EXISTS

-- =============================================
-- 一、馬匹 profile 擴展
-- =============================================
-- horses 表已有 basic fields，呢個 side table 存 Replit horses/profile CSV 嘅額外欄位
-- 唔改 horses table 以免 break 現有 queries
CREATE TABLE IF NOT EXISTS horse_profile_extra (
  horse_id TEXT PRIMARY KEY REFERENCES horses(id),
  name_with_status TEXT,               -- '福穎 (A001) (已退役)'
  status TEXT,                         -- 'active' / 'retired'
  last_race_date TEXT,
  country_of_origin TEXT,              -- 出生地 (AUS/IRE/NZ 等)
  colour_sex_raw TEXT,                 -- 毛色___性別 原文
  import_type TEXT,                    -- 進口類別 (自購馬/私人購買馬/國際拍賣馬)
  total_stakes_raw TEXT,               -- 總獎金 原文含 '$' + 逗號
  total_stakes_int INTEGER,            -- normalized
  record_wins INTEGER,                 -- 冠
  record_seconds INTEGER,              -- 亞
  record_thirds INTEGER,               -- 季
  record_total_starts INTEGER,         -- 總出賽次數
  owner TEXT,                          -- 馬主
  last_rating REAL,                    -- 最後評分
  sire TEXT,                           -- 父系
  dam TEXT,                            -- 母系
  dam_sire TEXT,                       -- 外祖父
  half_siblings TEXT,                  -- 同父系馬
  profile_last_scraped TEXT,           -- Replit 抓取日
  source_commit TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hpx_last_scraped ON horse_profile_extra(profile_last_scraped);
CREATE INDEX IF NOT EXISTS idx_hpx_status ON horse_profile_extra(status);

-- =============================================
-- 二、馬匹 form records（逐場詳細 log）
-- =============================================
-- 對應 Replit horses/<code>/form_records.csv
-- 呢個係 raw ingestion staging table — source of truth for per-start detail
-- race_results 係 race-centric normalized，呢度係 horse-centric denormalized mirror
-- 好處：可以喺未 match 到 race_id 時直接 store（馬號 / 場次 / 日期做 natural key）
CREATE TABLE IF NOT EXISTS horse_form_records (
  id TEXT PRIMARY KEY,                 -- hash(horse_id + race_date + venue + race_no)
  horse_id TEXT NOT NULL REFERENCES horses(id),
  race_date TEXT NOT NULL,
  venue TEXT,                          -- 'ST' / 'HV'
  race_number INTEGER,
  race_index_no TEXT,                  -- HKJC raceindex
  race_class TEXT,
  distance INTEGER,
  going TEXT,
  track TEXT,
  course TEXT,
  finishing_position TEXT,             -- 原文保留 '999', 'WV-A', 'PU' 等
  finishing_position_num INTEGER,      -- normalized (999 for DNF)
  total_runners INTEGER,
  draw INTEGER,
  horse_number INTEGER,
  actual_weight REAL,
  declared_weight REAL,
  jockey_name TEXT,
  trainer_name TEXT,
  lbw TEXT,
  running_position TEXT,
  finish_time TEXT,                    -- 原文 '1.10.45' 格式
  finish_time_sec REAL,                -- normalized 秒
  win_odds REAL,
  gear TEXT,
  rating INTEGER,                      -- 當場評分
  race_id TEXT REFERENCES races(id),   -- NULL 直到 matcher resolve
  match_confidence REAL,               -- 0-1 · matcher score
  source_commit TEXT,                  -- GitHub commit SHA
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_id, race_date, venue, race_number)
);

CREATE INDEX IF NOT EXISTS idx_hfr_horse ON horse_form_records(horse_id);
CREATE INDEX IF NOT EXISTS idx_hfr_date ON horse_form_records(race_date);
CREATE INDEX IF NOT EXISTS idx_hfr_race ON horse_form_records(race_id) WHERE race_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hfr_unmatched ON horse_form_records(horse_id) WHERE race_id IS NULL;

-- =============================================
-- 三、馬匹晨操 v2（取代 legacy trackwork）
-- =============================================
-- 對應 Replit horses/<code>/trackwork.csv — 7 columns confirmed
-- legacy trackwork table 保留俾現有 code，新 ingestion 寫入 horse_trackwork
-- Migration path: 之後逐步 shift legacy writers 到新表
CREATE TABLE IF NOT EXISTS horse_trackwork (
  id TEXT PRIMARY KEY,                 -- hash(horse_id + date + venue + distance + time)
  horse_id TEXT NOT NULL REFERENCES horses(id),
  trackwork_date TEXT NOT NULL,
  venue TEXT,                          -- 沙田 / 跑馬地 / 磡角 等
  batch TEXT,                          -- 晨操批次
  distance TEXT,                       -- 原文保留（可能係 '600m' / 'gallops' / '慢跑'）
  time_text TEXT,                      -- 原文晨操時間（可能 'slow' / '0.36.8'）
  time_sec REAL,                       -- normalized 秒，文字則 NULL
  partner TEXT,                        -- 合操馬
  comment TEXT,                        -- 狀態備註
  source_commit TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_id, trackwork_date, venue, distance, time_text)
);

CREATE INDEX IF NOT EXISTS idx_htw_horse ON horse_trackwork(horse_id);
CREATE INDEX IF NOT EXISTS idx_htw_date ON horse_trackwork(trackwork_date);
CREATE INDEX IF NOT EXISTS idx_htw_horse_date ON horse_trackwork(horse_id, trackwork_date DESC);

-- =============================================
-- 四、馬匹傷病記錄
-- =============================================
-- 對應 Replit horses/<code>/injury.csv
-- 用於 Data Gate — recent injury flag
CREATE TABLE IF NOT EXISTS horse_injury (
  id TEXT PRIMARY KEY,
  horse_id TEXT NOT NULL REFERENCES horses(id),
  injury_date TEXT NOT NULL,
  injury_type TEXT,                    -- 原文保留（手術 / 休養 / 肌肉拉傷 等）
  resolution_date TEXT,                -- NULL 如果 ongoing
  days_out INTEGER,                    -- resolution - injury
  description TEXT,
  source_commit TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_id, injury_date, injury_type)
);

CREATE INDEX IF NOT EXISTS idx_hinj_horse ON horse_injury(horse_id);
CREATE INDEX IF NOT EXISTS idx_hinj_date ON horse_injury(injury_date DESC);

-- =============================================
-- 五、騎師年度 records
-- =============================================
-- 對應 Replit jockeys/<code>/records.csv — 每季統計
CREATE TABLE IF NOT EXISTS jockey_season_records (
  id TEXT PRIMARY KEY,                 -- jockey_id + season
  jockey_id TEXT NOT NULL REFERENCES jockeys(id),
  season TEXT NOT NULL,                -- '2024/25'
  rides INTEGER,
  wins INTEGER,
  seconds INTEGER,
  thirds INTEGER,
  fourths INTEGER,
  stakes_hkd INTEGER,
  win_rate REAL,                       -- wins / rides
  top3_rate REAL,
  source_commit TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(jockey_id, season)
);

CREATE INDEX IF NOT EXISTS idx_jsr_season ON jockey_season_records(season);
CREATE INDEX IF NOT EXISTS idx_jsr_jockey ON jockey_season_records(jockey_id);

-- =============================================
-- 六、試閘 sessions + results 分開
-- =============================================
-- barrier_trials 係 runner-level · 但冇 session metadata
-- 新 trial_sessions 記 session 層面資料（日期/場地/場次編號）
-- 新 trial_runners 取代 barrier_trials 做 runner-level link
-- Legacy barrier_trials 保留唔改，只新增兩個表平行
CREATE TABLE IF NOT EXISTS trial_sessions (
  id TEXT PRIMARY KEY,                 -- trial_date + venue + session_no
  trial_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  session_number INTEGER,              -- 該日第幾場試閘
  distance INTEGER,
  going TEXT,
  track TEXT,                          -- 草地/全天候
  total_runners INTEGER,
  source_commit TEXT,
  UNIQUE(trial_date, venue, session_number)
);

CREATE INDEX IF NOT EXISTS idx_ts_date ON trial_sessions(trial_date DESC);

CREATE TABLE IF NOT EXISTS trial_runners (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES trial_sessions(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  horse_number INTEGER,
  finishing_position INTEGER,
  time_text TEXT,
  time_sec REAL,
  jockey_name TEXT,                    -- name 為主，jockey_id 只 soft link
  jockey_id TEXT REFERENCES jockeys(id),
  lbw TEXT,
  gear TEXT,
  comment TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, horse_id)
);

CREATE INDEX IF NOT EXISTS idx_tr_session ON trial_runners(session_id);
CREATE INDEX IF NOT EXISTS idx_tr_horse ON trial_runners(horse_id);

-- =============================================
-- 七、未來排位表（forward-only capture）
-- =============================================
-- HKJC 確認歷史 racecard 唔 archive → 呢個表只能累積未來資料
-- 已知 limitation：無法 backfill，只能 going-forward
CREATE TABLE IF NOT EXISTS entries_upcoming (
  id TEXT PRIMARY KEY,                 -- race_date + venue + race_no + horse_id
  race_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_class TEXT,
  distance INTEGER,
  track TEXT,
  course TEXT,
  horse_id TEXT REFERENCES horses(id),
  horse_number INTEGER,
  horse_code TEXT,                     -- HKJC 馬號（未 resolve horse_id 時 fallback）
  draw INTEGER,
  jockey_name TEXT,
  jockey_id TEXT REFERENCES jockeys(id),
  trainer_name TEXT,
  trainer_id TEXT REFERENCES trainers(id),
  actual_weight REAL,
  declared_weight REAL,
  gear TEXT,
  rating INTEGER,
  priority_order TEXT,                 -- '正選' / '後備N'
  scraped_at TEXT,
  source_commit TEXT,
  UNIQUE(race_date, venue, race_number, horse_number)
);

CREATE INDEX IF NOT EXISTS idx_eu_date ON entries_upcoming(race_date);
CREATE INDEX IF NOT EXISTS idx_eu_horse ON entries_upcoming(horse_id);
CREATE INDEX IF NOT EXISTS idx_eu_upcoming ON entries_upcoming(race_date, venue, race_number);

-- =============================================
-- 八、Elo rating tables（三軸 ensemble）
-- =============================================
-- 核心設計：
--   - horse_elo: 以馬為主 + surface + distance_bucket 三軸 key
--   - jockey_elo: 騎師 overall rating
--   - trainer_elo: 練馬師 overall rating
-- 計算引擎：後端 TypeScript / Python ingestion CLI · 寫入 D1 只做 snapshot
-- Burn-in: 2016-2018 · 驗證起點 2019
-- Anti-Public Bias: 完全 derived from finish positions · 零 odds 依賴

-- 馬匹 Elo rating snapshots（每場後更新）
CREATE TABLE IF NOT EXISTS horse_elo_snapshots (
  id TEXT PRIMARY KEY,                 -- horse_id + axis_key + as_of_race_id
  horse_id TEXT NOT NULL REFERENCES horses(id),
  axis_key TEXT NOT NULL,              -- 'overall' / 'turf_1200' / 'awt_1650' 等
  surface TEXT,                        -- 'turf' / 'awt'
  distance_bucket TEXT,                -- 'sprint' (<=1400) / 'mile' (1400-1800) / 'middle' (1800-2000) / 'staying' (>2000)
  as_of_race_id TEXT REFERENCES races(id),
  as_of_date TEXT NOT NULL,
  rating REAL NOT NULL,
  games_played INTEGER DEFAULT 0,
  days_since_last_race INTEGER,
  last_decay_applied_days INTEGER,     -- 追蹤已 apply 過幾多日 decay
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_id, axis_key, as_of_race_id)
);

CREATE INDEX IF NOT EXISTS idx_hes_horse ON horse_elo_snapshots(horse_id);
CREATE INDEX IF NOT EXISTS idx_hes_date ON horse_elo_snapshots(as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_hes_axis ON horse_elo_snapshots(horse_id, axis_key, as_of_date DESC);

-- 騎師 Elo rating snapshots
CREATE TABLE IF NOT EXISTS jockey_elo_snapshots (
  id TEXT PRIMARY KEY,
  jockey_id TEXT NOT NULL REFERENCES jockeys(id),
  as_of_race_id TEXT REFERENCES races(id),
  as_of_date TEXT NOT NULL,
  rating REAL NOT NULL,
  games_played INTEGER DEFAULT 0,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(jockey_id, as_of_race_id)
);

CREATE INDEX IF NOT EXISTS idx_jes_jockey ON jockey_elo_snapshots(jockey_id);
CREATE INDEX IF NOT EXISTS idx_jes_date ON jockey_elo_snapshots(as_of_date DESC);

-- 練馬師 Elo rating snapshots
CREATE TABLE IF NOT EXISTS trainer_elo_snapshots (
  id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL REFERENCES trainers(id),
  as_of_race_id TEXT REFERENCES races(id),
  as_of_date TEXT NOT NULL,
  rating REAL NOT NULL,
  games_played INTEGER DEFAULT 0,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trainer_id, as_of_race_id)
);

CREATE INDEX IF NOT EXISTS idx_tes_trainer ON trainer_elo_snapshots(trainer_id);
CREATE INDEX IF NOT EXISTS idx_tes_date ON trainer_elo_snapshots(as_of_date DESC);

-- Elo 計算 run 元數據（audit + reproducibility）
CREATE TABLE IF NOT EXISTS elo_runs (
  id TEXT PRIMARY KEY,
  run_label TEXT,                      -- 'v1_init' / 'v1_daily_2026-04-21' 等
  k_factor REAL NOT NULL,
  initial_rating REAL DEFAULT 1500,
  decay_half_life_days INTEGER,
  burn_in_from TEXT,                   -- '2016-09-01'
  burn_in_to TEXT,
  races_processed INTEGER,
  results_processed INTEGER,
  surface_axes TEXT,                   -- JSON array
  distance_buckets TEXT,               -- JSON array
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  success INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_elo_runs_date ON elo_runs(started_at DESC);

-- =============================================
-- 九、Sync metadata（last_sync.json mirror）
-- =============================================
-- Replit 會喺 GitHub push last_sync.json · 呢個表 mirror 佢
-- 俾 ingestion CLI 做 delta detection
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,                -- 'horses_count' / 'entries_rows' / 'trackwork_rows' / 'injury_rows' / 'trials_rows' / 'results_csvs' / 'jockey_files' / 'trainer_files'
  value_int INTEGER,
  value_text TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  source_commit TEXT
);

-- Ingestion run log
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT,                       -- 'horses_profiles' / 'form_records' / 'trackwork' / 'injury' / 'trials' / 'entries' / 'jockey_records' / 'elo_rebuild'
  source_commit TEXT,
  rows_inserted INTEGER DEFAULT 0,
  rows_updated INTEGER DEFAULT 0,
  rows_skipped INTEGER DEFAULT 0,
  rows_failed INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  success INTEGER DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ing_runs_type ON ingestion_runs(run_type, started_at DESC);

-- =============================================
-- 十、Views 便利 query
-- =============================================

-- 馬匹最新 Elo（三軸 overall 版本）
CREATE VIEW IF NOT EXISTS v_horse_latest_elo AS
SELECT
  h.id AS horse_id,
  h.name_ch,
  h.name_en,
  h.code,
  overall.rating AS overall_elo,
  overall.as_of_date AS overall_as_of,
  overall.games_played AS overall_games
FROM horses h
LEFT JOIN (
  SELECT horse_id, rating, as_of_date, games_played,
         ROW_NUMBER() OVER (PARTITION BY horse_id ORDER BY as_of_date DESC) AS rn
  FROM horse_elo_snapshots
  WHERE axis_key = 'overall'
) overall ON overall.horse_id = h.id AND overall.rn = 1;

-- 馬匹最近晨操（最新 3 次）
CREATE VIEW IF NOT EXISTS v_horse_recent_trackwork AS
SELECT
  horse_id,
  trackwork_date,
  venue,
  batch,
  distance,
  time_text,
  time_sec,
  partner,
  comment,
  ROW_NUMBER() OVER (PARTITION BY horse_id ORDER BY trackwork_date DESC) AS recency
FROM horse_trackwork;

-- 馬匹活躍傷病（ongoing + 最近 90 日內 resolved）
CREATE VIEW IF NOT EXISTS v_horse_active_injury AS
SELECT
  horse_id,
  injury_date,
  injury_type,
  resolution_date,
  days_out,
  description,
  CASE
    WHEN resolution_date IS NULL THEN 'ongoing'
    WHEN julianday('now') - julianday(resolution_date) <= 90 THEN 'recent'
    ELSE 'historic'
  END AS status
FROM horse_injury
WHERE resolution_date IS NULL
   OR julianday('now') - julianday(resolution_date) <= 90;

-- 未來賽事 upcoming entries + 馬匹 Elo prior
CREATE VIEW IF NOT EXISTS v_upcoming_with_elo AS
SELECT
  eu.race_date,
  eu.venue,
  eu.race_number,
  eu.horse_id,
  eu.horse_number,
  eu.draw,
  eu.jockey_name,
  eu.trainer_name,
  vle.overall_elo,
  vle.overall_games,
  h.name_ch AS horse_name_ch
FROM entries_upcoming eu
LEFT JOIN horses h ON h.id = eu.horse_id
LEFT JOIN v_horse_latest_elo vle ON vle.horse_id = eu.horse_id
WHERE eu.race_date >= date('now')
ORDER BY eu.race_date, eu.race_number, eu.draw;

-- 練馬師轉會 view（用 LAG 自動 derive）
CREATE VIEW IF NOT EXISTS v_trainer_transitions AS
SELECT
  horse_id,
  race_date,
  trainer_name,
  LAG(trainer_name) OVER (PARTITION BY horse_id ORDER BY race_date) AS previous_trainer,
  CASE
    WHEN LAG(trainer_name) OVER (PARTITION BY horse_id ORDER BY race_date) IS NOT NULL
     AND LAG(trainer_name) OVER (PARTITION BY horse_id ORDER BY race_date) != trainer_name
    THEN 1 ELSE 0
  END AS is_transition
FROM horse_form_records
WHERE trainer_name IS NOT NULL;
