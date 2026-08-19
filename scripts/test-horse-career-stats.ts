import Database from 'better-sqlite3';
import { HORSE_CAREER_STATS_CTE } from '../src/lib/horse-career-stats';

interface CareerRow {
  horse_id: string;
  total_wins: number;
  total_seconds: number;
  total_thirds: number;
  total_starts: number;
  source: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE horse_profile_extra (
    horse_id TEXT PRIMARY KEY,
    record_wins INTEGER,
    record_seconds INTEGER,
    record_thirds INTEGER,
    record_total_starts INTEGER
  );
  CREATE TABLE horse_form_records (
    id TEXT PRIMARY KEY,
    horse_id TEXT NOT NULL,
    race_date TEXT NOT NULL,
    venue TEXT,
    race_number INTEGER,
    race_id TEXT,
    match_confidence REAL,
    ingested_at TEXT,
    finishing_position TEXT,
    finishing_position_num INTEGER
  );
  CREATE TABLE race_results (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    horse_id TEXT NOT NULL,
    finishing_position INTEGER
  );

  INSERT INTO horse_profile_extra VALUES
    ('horse_J343', 7, 3, 1, 17),
    ('horse_J127', 5, 8, 6, 34),
    ('horse_impossible', 9, 2, 1, 4);

  -- A genuine zero-win horse: one finish, one PU, one withdrawal.
  INSERT INTO horse_form_records VALUES
    ('zero_1', 'horse_zero_win', '2026-01-01', 'ST', 1, 'race_1', 1, '2026-01-02', '4', 4),
    ('zero_2', 'horse_zero_win', '2026-01-08', 'HV', 2, 'race_2', 1, '2026-01-09', 'PU', 999),
    ('zero_3', 'horse_zero_win', '2026-01-15', 'ST', 3, 'race_3', 1, '2026-01-16', 'WV-A', NULL);

  -- Raw/normalized copies from the same meeting must count once. The linked
  -- normalized row wins the ranking even if its ingestion timestamp is older.
  INSERT INTO horse_form_records VALUES
    ('dup_raw', 'horse_duplicate', '2026-02-01', 'ST', 791, NULL, 0, '2026-02-02', '1', 1),
    ('dup_normalized', 'horse_duplicate', '2026-02-01', 'ST', 3, 'race_3', 1, '2026-02-01', '1', 1);

  -- Impossible profile values must be rejected in favour of verified form.
  INSERT INTO horse_form_records VALUES
    ('impossible_fallback', 'horse_impossible', '2026-03-01', 'ST', 4, 'race_4', 1, '2026-03-02', '2', 2);

  -- Normalized race_results are the fallback when no complete form exists.
  INSERT INTO race_results VALUES
    ('rr_1', 'race_5', 'horse_rr_only', 1),
    ('rr_2', 'race_6', 'horse_rr_only', 999),
    ('rr_upcoming', 'race_7', 'horse_rr_only', NULL);

  -- A stale horses-table zero has no representation here and therefore must
  -- remain unknown; the canonical snapshot never reads horses totals.
`);

const rows = db.prepare(`
  ${HORSE_CAREER_STATS_CTE}
  SELECT * FROM career_stats ORDER BY horse_id
`).all() as CareerRow[];
const byId = new Map(rows.map((row) => [row.horse_id, row]));

const galaxy = byId.get('horse_J343');
assert(galaxy?.total_starts === 17 && galaxy.total_wins === 7, '錶之星河 record mismatch');
assert(galaxy.total_seconds === 3 && galaxy.total_thirds === 1, '錶之星河 placings mismatch');
assert(galaxy.source === 'profile', 'verified profile was not preferred');

const soleil = byId.get('horse_J127');
assert(soleil?.total_starts === 34 && soleil.total_wins === 5, '太陽勇士 record mismatch');

const zeroWin = byId.get('horse_zero_win');
assert(zeroWin?.total_starts === 2, 'withdrawal or non-finisher start boundary is wrong');
assert(zeroWin.total_wins === 0, 'genuine zero-win horse did not preserve zero');

const duplicate = byId.get('horse_duplicate');
assert(duplicate?.total_starts === 1 && duplicate.total_wins === 1, 'raw/normalized duplicate counted twice');

const impossible = byId.get('horse_impossible');
assert(impossible?.source === 'horse_form_records', 'impossible profile was not rejected');
assert(impossible.total_starts === 1 && impossible.total_seconds === 1, 'impossible profile fallback mismatch');

const rrOnly = byId.get('horse_rr_only');
assert(rrOnly?.source === 'race_results', 'normalized result fallback missing');
assert(rrOnly.total_starts === 2 && rrOnly.total_wins === 1, 'DNF/upcoming race boundary is wrong');

assert(!byId.has('horse_unknown'), 'unknown career was synthesized as zero');

console.log('horse career stats tests passed');