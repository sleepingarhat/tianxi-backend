-- Odds snapshot schema — minimal subset used by Capy Odds workflow
-- (capy_odds.yml in tianxi-database checks out THIS repo and reads
--  this file to seed bulk-local.db). Restored after commit 8070415
-- ("drop ... unused schema_odds") deleted it from this repo — the
-- workflow has been ENOENT-ing on every cron since then (≈76h stale
-- odds as of 2026-05-25). First restore attempt mis-targeted
-- tianxi-database (commit 0dd57c6a84 there); this is the correct one.
-- Content is the odds_snapshots block from
-- .elo-pipeline/src/db/schema.sql verbatim.

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
