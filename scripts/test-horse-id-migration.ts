import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE horses (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_ch TEXT,
    code TEXT UNIQUE,
    country_of_origin TEXT,
    colour TEXT,
    sex TEXT,
    age INTEGER,
    sire TEXT,
    dam TEXT,
    dam_sire TEXT,
    import_type TEXT,
    current_trainer_id TEXT,
    current_rating INTEGER,
    season_stakes INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_starts INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    updated_at TEXT
  );
  CREATE TABLE race_results (
    id TEXT PRIMARY KEY,
    horse_id TEXT NOT NULL REFERENCES horses(id)
  );
  CREATE TABLE horse_profile_extra (
    horse_id TEXT PRIMARY KEY REFERENCES horses(id),
    owner TEXT
  );
  INSERT INTO horses (id, name_en, code) VALUES ('J182', 'J182', 'J182');
  INSERT INTO race_results (id, horse_id) VALUES ('result_1', 'J182');
  INSERT INTO horse_profile_extra (horse_id, owner) VALUES ('J182', '會友團體');
`);

const prepare = readFileSync(
  resolve('scripts/migrate-horse-ids-d1-prepare.sql'),
  'utf8',
);
const finalize = readFileSync(
  resolve('scripts/migrate-horse-ids-d1-finalize.sql'),
  'utf8',
);

db.exec(prepare);
const tables = db.prepare(
  `SELECT DISTINCT schema.name
   FROM sqlite_master AS schema
   JOIN pragma_table_info(schema.name) AS column
   WHERE schema.type = 'table' AND column.name = 'horse_id'`,
).all() as Array<{ name: string }>;
for (const { name } of tables) {
  const table = `"${name.replace(/"/g, '""')}"`;
  db.exec(
    `UPDATE ${table}
     SET horse_id = (
       SELECT new_id FROM _horse_id_migration
       WHERE old_id = ${table}.horse_id
     )
     WHERE horse_id IN (SELECT old_id FROM _horse_id_migration)`,
  );
}
db.exec(finalize);

assert(
  db.prepare(`SELECT 1 FROM horses WHERE id = 'horse_J182' AND code = 'J182'`).get(),
  'canonical parent was not created',
);
assert(
  !db.prepare(`SELECT 1 FROM horses WHERE id = 'J182'`).get(),
  'legacy parent was not removed',
);
assert(
  (db.prepare(`SELECT horse_id FROM race_results`).get() as any).horse_id === 'horse_J182',
  'race result foreign key was not migrated',
);
assert(
  (db.prepare(`SELECT horse_id FROM horse_profile_extra`).get() as any).horse_id === 'horse_J182',
  'profile foreign key was not migrated',
);
assert(db.pragma('foreign_key_check').length === 0, 'foreign-key check failed');

// Idempotency: a completed migration must be a no-op.
db.exec(prepare);
db.exec(finalize);
assert(db.pragma('foreign_key_check').length === 0, 'migration rerun broke foreign keys');

console.log('remote horse-id migration tests passed');