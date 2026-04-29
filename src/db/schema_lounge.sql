-- ================================================================
-- 天喜 TIANXI · Lounge (community threads) schema
-- Phase A2.3 · anon display-name identity (no real auth yet · A3)
-- ================================================================

CREATE TABLE IF NOT EXISTS lounge_threads (
  id TEXT PRIMARY KEY,                    -- ULID
  title TEXT NOT NULL,
  category TEXT,                          -- 'race_day' | 'horse_chat' | 'general' | 'jockey' | 'analysis'
  race_date TEXT,                         -- optional FK (soft) to race_meetings.date
  horse_id TEXT,                          -- optional anchor to a horse
  author_handle TEXT NOT NULL,            -- client-provided display name (localStorage)
  author_id TEXT NOT NULL,                -- client-gen anon UUID in localStorage
  reply_count INTEGER DEFAULT 0,
  last_post_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  is_pinned INTEGER DEFAULT 0,
  is_locked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lt_last_post ON lounge_threads(last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_lt_category ON lounge_threads(category, last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_lt_horse ON lounge_threads(horse_id, last_post_at DESC);

CREATE TABLE IF NOT EXISTS lounge_posts (
  id TEXT PRIMARY KEY,                    -- ULID
  thread_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  is_hidden INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lp_thread ON lounge_posts(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_lp_author ON lounge_posts(author_id, created_at DESC);
