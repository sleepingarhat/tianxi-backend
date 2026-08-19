import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { horsesRoutes } from '../src/routes/horses';
import { racesRoutes } from '../src/routes/races';
import type { Env } from '../src/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class D1StatementShim {
  private params: unknown[] = [];

  constructor(
    private readonly database: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async all<T>() {
    const results = this.database.prepare(this.sql).all(...this.params) as T[];
    return { results };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
}

class D1DatabaseShim {
  constructor(private readonly database: Database.Database) {}

  prepare(sql: string) {
    return new D1StatementShim(this.database, sql);
  }
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE horses (
    id TEXT PRIMARY KEY, name_en TEXT, name_ch TEXT, code TEXT,
    country_of_origin TEXT, colour TEXT, sex TEXT, age INTEGER,
    sire TEXT, dam TEXT, dam_sire TEXT, import_type TEXT,
    current_trainer_id TEXT, current_rating INTEGER, season_stakes INTEGER,
    total_wins INTEGER DEFAULT 0, total_starts INTEGER DEFAULT 0,
    status TEXT, updated_at TEXT, silks_code TEXT
  );
  CREATE TABLE horse_profile_extra (
    horse_id TEXT PRIMARY KEY, last_race_date TEXT, current_trainer TEXT,
    owner TEXT, half_siblings TEXT, colour_sex_raw TEXT,
    season_stakes_int INTEGER, total_stakes_int INTEGER,
    record_wins INTEGER, record_seconds INTEGER, record_thirds INTEGER,
    record_total_starts INTEGER, sire TEXT, dam TEXT, dam_sire TEXT,
    country_of_origin TEXT, import_type TEXT, last_rating REAL,
    status TEXT, profile_last_scraped TEXT, profile_checked_at TEXT,
    source_commit TEXT
  );
  CREATE TABLE horse_pedigree (
    horse_id TEXT, code TEXT, sire TEXT, dam TEXT, dam_sire TEXT
  );
  CREATE TABLE horse_form_records (
    id TEXT PRIMARY KEY, horse_id TEXT, race_date TEXT, venue TEXT,
    race_number INTEGER, race_id TEXT, match_confidence REAL, ingested_at TEXT,
    finishing_position TEXT, finishing_position_num INTEGER
  );
  CREATE TABLE race_meetings (
    id TEXT PRIMARY KEY, date TEXT, venue TEXT, track_condition TEXT, weather TEXT
  );
  CREATE TABLE races (
    id TEXT PRIMARY KEY, meeting_id TEXT, race_number INTEGER,
    distance INTEGER, class TEXT, going TEXT, track TEXT, course TEXT,
    title TEXT, prize INTEGER, start_time TEXT, video_url TEXT
  );
  CREATE TABLE race_results (
    id TEXT PRIMARY KEY, race_id TEXT, horse_id TEXT, horse_number INTEGER,
    finishing_position INTEGER, draw INTEGER, finish_time REAL, win_odds REAL,
    running_position TEXT, lbw TEXT, gear TEXT, actual_weight REAL,
    declared_weight REAL, jockey_id TEXT, trainer_id TEXT, race_class_rating INTEGER
  );
  CREATE TABLE jockeys (id TEXT PRIMARY KEY, name_ch TEXT, name_en TEXT);
  CREATE TABLE trainers (id TEXT PRIMARY KEY, name_ch TEXT, name_en TEXT);
  CREATE TABLE entries_upcoming (
    id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER,
    race_class TEXT, distance INTEGER, horse_id TEXT, horse_number INTEGER,
    draw INTEGER, jockey_name TEXT, trainer_name TEXT, actual_weight REAL,
    declared_weight REAL, gear TEXT, rating INTEGER, post_time TEXT
  );
  CREATE TABLE v_horse_latest_elo (
    horse_id TEXT, overall_elo REAL, overall_as_of TEXT
  );

  INSERT INTO horses (
    id, name_en, name_ch, code, current_rating, total_wins, total_starts, status
  ) VALUES
    ('horse_J343', 'PATCH OF STARS', '錶之星河', 'J343', 100, 0, 0, 'active'),
    ('horse_J127', 'SOLEIL FIGHTER', '太陽勇士', 'J127', 90, 0, 0, 'active'),
    ('horse_zero', 'HONEST ZERO', '真零勝', 'Z001', 40, 99, 99, 'active'),
    ('horse_unknown', 'UNKNOWN', '未知馬', 'U001', 30, 0, 0, 'active');
  INSERT INTO horse_profile_extra (
    horse_id, record_wins, record_seconds, record_thirds, record_total_starts,
    status, profile_last_scraped
  ) VALUES
    ('horse_J343', 7, 3, 1, 17, 'active', '2026-08-19'),
    ('horse_J127', 5, 8, 6, 34, 'active', '2026-08-19');
  INSERT INTO horse_form_records VALUES
    ('zero_1', 'horse_zero', '2026-01-01', 'ST', 1, 'race_old', 1, '2026-01-02', '5', 5);
  INSERT INTO v_horse_latest_elo VALUES
    ('horse_J343', 1600, '2026-08-19'),
    ('horse_J127', 1550, '2026-08-19'),
    ('horse_unknown', 1500, '2026-08-19');
  CREATE TABLE sectional_times (
    race_id TEXT, section_number INTEGER, section_distance INTEGER,
    section_time REAL, cumulative_time REAL
  );
  CREATE TABLE dividends (
    race_id TEXT, pool_type TEXT, combination TEXT, dividend REAL
  );
  CREATE TABLE running_comments (
    race_id TEXT, horse_id TEXT, comment_text TEXT, language TEXT
  );

  INSERT INTO race_meetings (id, date, venue) VALUES ('meeting_past', '2026-08-01', 'ST');
  INSERT INTO races (id, meeting_id, race_number, distance, class, going, track, course) VALUES ('race_past', 'meeting_past', 3, 1400, '第三班', '好地', '草地', 'B');
  INSERT INTO race_results (
    id, race_id, horse_id, horse_number, finishing_position, draw, actual_weight
  ) VALUES
    ('rr_past_1', 'race_past', 'horse_J343', 1, 1, 3, 122),
    ('rr_past_2', 'race_past', 'horse_J127', 2, 4, 5, 118),
    ('rr_past_3', 'race_past', 'horse_zero', 3, 5, 7, 115),
    ('rr_past_4', 'race_past', 'horse_unknown', 4, NULL, 9, 113);
  INSERT INTO race_meetings (id, date, venue) VALUES ('meeting_future', '2026-08-30', 'ST');
  INSERT INTO races (id, meeting_id, race_number, distance, class, going, track, course) VALUES ('race_future', 'meeting_future', 1, 1200, '第四班', '好地', '草地', 'A');
  INSERT INTO entries_upcoming VALUES (
    'entry_future', '2026-08-30', 'ST', 1, '第四班', 1200,
    'horse_J343', 1, 2, '測試騎師', '測試練馬師', 1100, 126, 'B', 100, NULL
  );
`);

const app = new Hono<{ Bindings: Env }>();
app.route('/api/horses', horsesRoutes);
app.route('/api/races', racesRoutes);
const env = { DB: new D1DatabaseShim(db) as unknown as D1Database } as Env;

async function json(path: string) {
  const response = await app.request(`http://test.local${path}`, {}, env);
  const payload = await response.json<any>();
  assert(response.ok, `${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  const index = await json('/api/horses?sort=wins&status=all&limit=20');
  const indexById = new Map<string, any>(index.horses.map((horse: any) => [horse.id, horse]));
  assert(indexById.get('horse_J343')?.totalStarts === 17, 'index did not use verified starts');
  assert(indexById.get('horse_J343')?.totalWins === 7, 'index did not use verified wins');
  assert(indexById.get('horse_J127')?.totalStarts === 34, 'index did not preserve 太陽勇士 starts');
  assert(indexById.get('horse_zero')?.totalWins === 0, 'index hid a genuine zero-win record');
  assert(indexById.get('horse_unknown')?.totalStarts === null, 'index synthesized unknown starts');
  assert(indexById.get('horse_unknown')?.totalWins === null, 'index synthesized unknown wins');

  const wins = await json('/api/horses/leaderboard?by=wins&status=all&limit=10');
  assert(wins.horses[0].id === 'horse_J343', 'wins leaderboard did not sort verified wins');
  assert(wins.horses.some((horse: any) => horse.id === 'horse_zero' && horse.totalWins === 0), 'zero-win horse missing');
  assert(!wins.horses.some((horse: any) => horse.id === 'horse_unknown'), 'unknown record entered wins leaderboard');

  const elo = await json('/api/horses/leaderboard?by=elo&status=all&limit=10');
  assert(elo.horses.find((horse: any) => horse.id === 'horse_unknown')?.totalStarts === null, 'Elo board faked starts');

  const search = await json('/api/horses/search/query?q=星河');
  assert(search.horses[0].totalStarts === 17 && search.horses[0].totalWins === 7, 'search record mismatch');

  const detail = await json('/api/horses/horse_J127');
  assert(detail.totalStarts === 34 && detail.totalWins === 5, 'detail record mismatch');
  assert(detail.totalSeconds === 8 && detail.totalThirds === 6, 'detail placings mismatch');

  const form = await json('/api/horses/horse_J343/form?limit=3');
  assert(form.horse.totalStarts === 17 && form.horse.totalWins === 7, 'form header record mismatch');

  const research = await json('/api/horses/horse_J343/research?limit=3');
  assert(research.horse.record.totalStarts === 17, 'research record mismatch');
  assert(research.raceContext === null, 'race context leaked without raceId');

  const raceResearch = await json('/api/horses/horse_J343/research?limit=3&raceId=race_future');
  assert(raceResearch.raceContext?.actualWeight === 126, 'declared carrying weight was not used');
  const serialized = JSON.stringify(raceResearch);
  assert(!serialized.includes('"bodyWeight"'), 'body weight leaked into public research contract');
  assert(!serialized.includes('"lgbScore"') && !serialized.includes('"featureVector"'), 'internal model data leaked');

  const raceEntries = await json('/api/races/race_past/entries');
  const entryByHorse = new Map<string, any>(
    raceEntries.entries.map((entry: any) => [entry.horseId, entry]),
  );
  assert(entryByHorse.get('horse_J343')?.totalStarts === 17, 'race entries missed verified starts');
  assert(entryByHorse.get('horse_J343')?.totalWins === 7, 'race entries missed verified wins');
  assert(entryByHorse.get('horse_zero')?.totalWins === 0, 'race entries hid genuine zero wins');
  assert(entryByHorse.get('horse_unknown')?.totalStarts === null, 'race entries synthesized starts');

  const raceDetail = await json('/api/races/race_past');
  const raceHorse = raceDetail.horses.find((horse: any) => horse.id === 'horse_J127');
  assert(raceHorse?.totalStarts === 34 && raceHorse?.totalWins === 5, 'race detail record mismatch');

  console.log('horse career API tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});