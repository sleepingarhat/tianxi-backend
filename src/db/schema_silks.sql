-- Phase B · Silks (綵衣) — 2026-04-28
-- Adds `horses.silks_code` column and `silks_cache` D1 blob cache table.
--
-- Silks URL pattern: https://racing.hkjc.com/racing/content/Images/RaceColor/{code}.gif
-- The `code` is typically the horse's K-code (e.g. K059). We default silks_code = horses.code.
-- Some horses share silks (same owner); `silks_code` allows future decoupling.

-- ── 1. Extend horses table
--    (D1 tolerates "ADD COLUMN IF NOT EXISTS" via separate migration harness;
--     check your push-to-d1 script whether it skips existing columns.)
ALTER TABLE horses ADD COLUMN silks_code TEXT;

-- Backfill: default to code (same K-code usually maps to a silks gif)
UPDATE horses SET silks_code = code WHERE silks_code IS NULL AND code IS NOT NULL;

-- ── 2. Silks cache (D1 blob store)
--    Each silks gif is small (~1-5 KB), ~4k horses = ~20 MB total, well within D1 limits.
--    blob stored as base64 TEXT (D1 compatibility) — can migrate to BLOB later.
CREATE TABLE IF NOT EXISTS silks_cache (
  code        TEXT PRIMARY KEY,
  blob        TEXT NOT NULL,          -- base64-encoded gif bytes
  etag        TEXT,
  fetched_at  TEXT NOT NULL,          -- ISO 8601 timestamp
  byte_length INTEGER,
  source      TEXT DEFAULT 'hkjc'     -- origin tag for future multi-source support
);

CREATE INDEX IF NOT EXISTS idx_silks_cache_fetched_at ON silks_cache(fetched_at);

-- ── 3. (Optional) lookup view matching horse → silks availability
CREATE VIEW IF NOT EXISTS v_horse_silks AS
SELECT
  h.id AS horse_id,
  h.code AS horse_code,
  COALESCE(h.silks_code, h.code) AS silks_code,
  CASE WHEN sc.code IS NOT NULL THEN 1 ELSE 0 END AS cached,
  sc.fetched_at
FROM horses h
LEFT JOIN silks_cache sc ON sc.code = COALESCE(h.silks_code, h.code);
