-- 天喜 Odds snapshot schema (2026-05-01)
--
-- Time-series odds + pool totals captured via hkjc-api GraphQL wrapper.
-- Purpose: informational display (Bloomberg-for-HKJC) + factor input for
-- composite score model (market price vs AI price signal).
--
-- Convention:
--   - `combination` encodes the entry selection:
--       WIN/PLA/CWA/CWB/CWC/IWN → "<horse_no>"     e.g. "5"
--       QIN/QPL/FCT/DBL        → "<a>-<b>"         e.g. "3-7"
--       TCE/TRI/TBL            → "<a>-<b>-<c>"     e.g. "2-5-9"
--       FF/QTT                 → "<a>-<b>-<c>-<d>"
--       DT/TT/SixUP            → race-spanning; combination = pipe-joined sub-combos
--   - `odds` null = pool not yet open OR entry scratched
--   - `snapshot_at` = scraper fetch time (UTC ISO-8601, second-precision)
--   - No UPDATE: every scrape appends a new row → full OHLC timeline

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id              TEXT PRIMARY KEY,          -- uuidv4 or race_date|venue|race|pool|combo|snapshot hash
  race_date       TEXT NOT NULL,             -- YYYY-MM-DD
  venue           TEXT NOT NULL,             -- ST | HV
  race_number     INTEGER NOT NULL,
  pool_type       TEXT NOT NULL,             -- WIN | PLA | QIN | QPL | FCT | TCE | TRI | FF | QTT | DBL | TBL | DT | TT | SixUP
  combination     TEXT NOT NULL,             -- see convention above
  odds            REAL,                      -- NULL = closed/SCR
  snapshot_at     TEXT NOT NULL,             -- ISO-8601 UTC
  source_commit   TEXT
);

CREATE INDEX IF NOT EXISTS idx_odds_race ON odds_snapshots (race_date, venue, race_number);
CREATE INDEX IF NOT EXISTS idx_odds_lookup ON odds_snapshots (race_date, venue, race_number, pool_type, combination, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_odds_snapshot_at ON odds_snapshots (snapshot_at);

CREATE TABLE IF NOT EXISTS pool_totals (
  id                TEXT PRIMARY KEY,
  race_date         TEXT NOT NULL,
  venue             TEXT NOT NULL,
  race_number       INTEGER NOT NULL,
  pool_type         TEXT NOT NULL,
  total_investment  REAL,                    -- HKD, null if pool not yet open
  snapshot_at       TEXT NOT NULL,
  source_commit     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pool_totals_race ON pool_totals (race_date, venue, race_number);
CREATE INDEX IF NOT EXISTS idx_pool_totals_lookup ON pool_totals (race_date, venue, race_number, pool_type, snapshot_at);
