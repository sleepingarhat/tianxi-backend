import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestHorseProfiles } from './ingest/sources/horse_profiles.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE horses (
    id TEXT PRIMARY KEY, name_en TEXT, name_ch TEXT, code TEXT UNIQUE,
    country_of_origin TEXT, colour TEXT, sex TEXT, import_type TEXT,
    sire TEXT, dam TEXT, dam_sire TEXT, current_trainer_id TEXT,
    current_rating INTEGER, season_stakes INTEGER DEFAULT 0,
    status TEXT, updated_at TEXT
  );
  CREATE TABLE trainers (id TEXT PRIMARY KEY, name_ch TEXT, name_en TEXT);
  CREATE TABLE horse_profile_extra (
    horse_id TEXT PRIMARY KEY, name_with_status TEXT, status TEXT,
    last_race_date TEXT, country_of_origin TEXT, colour_sex_raw TEXT,
    import_type TEXT, season_stakes_raw TEXT, season_stakes_int INTEGER,
    total_stakes_raw TEXT, total_stakes_int INTEGER,
    record_wins INTEGER, record_seconds INTEGER, record_thirds INTEGER,
    record_total_starts INTEGER, current_trainer TEXT, owner TEXT, last_rating REAL,
    sire TEXT, dam TEXT, dam_sire TEXT, half_siblings TEXT,
    profile_last_scraped TEXT, profile_checked_at TEXT, source_commit TEXT, updated_at TEXT
  );
  CREATE TABLE race_results (id TEXT PRIMARY KEY, horse_id TEXT);
  INSERT INTO horses (id, name_en, code, status) VALUES ('J182', 'J182', 'J182', 'active');
  INSERT INTO race_results (id, horse_id) VALUES ('result_1', 'J182');
  INSERT INTO trainers (id, name_ch) VALUES ('trainer_PF', '伍鵬志');
`);

const dir = mkdtempSync(join(tmpdir(), 'horse-profile-test-'));
const csv = join(dir, 'profiles.csv');
writeFileSync(csv, [
  'horse_no,name,status,profile_last_scraped,出生地___馬齡,毛色___性別,進口類別,今季獎金*,總獎金*,冠-亞-季-總出賽次數*,練馬師,馬主,父系,母系,外祖父',
  'J182,齊歡最樂,active,2026-08-19,紐西蘭 / 6,棕 / 閹,自購新馬,"$0","$1,783,775",3-1-0-24,伍鵬志,會友團體,Savabeel,Candelabra,Pins',
].join('\n'));

const stats = ingestHorseProfiles(db, csv, 'source-sha');
assert(stats.failed === 0 && stats.updated === 1, 'canonical profile ingest failed');
const horse = db.prepare('SELECT * FROM horses WHERE code = ?').get('J182') as any;
const profile = db.prepare('SELECT * FROM horse_profile_extra WHERE horse_id = ?').get('horse_J182') as any;
assert(horse.id === 'horse_J182', 'ingest created a duplicate bare-code horse');
const result = db.prepare('SELECT horse_id FROM race_results WHERE id = ?').get('result_1') as any;
assert(result.horse_id === 'horse_J182', 'legacy dependent horse id was not migrated');
assert(horse.country_of_origin === '紐西蘭', 'origin/age alias was not canonicalized');
assert(horse.current_trainer_id === 'trainer_PF', 'public current trainer was not linked');
assert(profile.current_trainer === '伍鵬志', 'public current trainer text was not retained');
assert(profile.season_stakes_int === 0, 'verified zero season stakes was not retained');
assert(profile.owner === '會友團體', 'owner missing');
assert(profile.sire === 'Savabeel' && profile.dam_sire === 'Pins', 'pedigree missing');
assert(profile.total_stakes_int === 1783775, 'starred total stakes alias missing');
assert(profile.profile_last_scraped === '2026-08-19', 'profile provenance date missing');
assert(profile.profile_checked_at === '2026-08-19', 'profile check time missing');

writeFileSync(csv, [
  'horse_no,name,status,profile_last_scraped,總獎金',
  'J182,齊歡最樂,active,2026-08-20,"$1,800,000"',
].join('\n'));
ingestHorseProfiles(db, csv, 'source-sha-2');
const preserved = db.prepare('SELECT * FROM horse_profile_extra WHERE horse_id = ?').get('horse_J182') as any;
assert(preserved.owner === '會友團體', 'partial refresh erased verified owner');
assert(preserved.sire === 'Savabeel', 'partial refresh erased verified pedigree');
assert(preserved.total_stakes_int === 1800000, 'fresh verified value did not update');

console.log('horse profile ingest tests passed');