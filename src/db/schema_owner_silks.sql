-- Optional HKJC-accurate silks color overrides.
-- When present, /api/silks-svg/:code.svg uses these values; otherwise falls
-- back to deterministic hash-derived palette. Safe to leave empty.

CREATE TABLE IF NOT EXISTS owner_silks (
  code    TEXT PRIMARY KEY,       -- HKJC owner code (e.g. 'K059')
  body    TEXT NOT NULL,          -- hex color for body (#RRGGBB)
  accent  TEXT,                   -- accent / pattern color
  trim    TEXT,                   -- outline / trim color
  pattern TEXT,                   -- solid|hstripe|vstripe|hoops|quarters|chevron|cross|diamonds|star|sash
  source  TEXT DEFAULT 'manual',  -- manual | hkjc-scrape | user-contrib
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_owner_silks_pattern ON owner_silks(pattern);
