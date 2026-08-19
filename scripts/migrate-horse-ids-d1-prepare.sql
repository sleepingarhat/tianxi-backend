-- Stage 1 of the remote D1 horse-id migration.
-- Keep this table if a later child-table update fails: reruns can resume safely.
CREATE TABLE IF NOT EXISTS _horse_id_migration (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL
);

INSERT OR IGNORE INTO _horse_id_migration (old_id, new_id, code)
SELECT id, 'horse_' || code, code
FROM horses
WHERE id = code
  AND id NOT LIKE 'horse_%'
  AND code GLOB '[A-Z][0-9]*';

-- Free the UNIQUE(code) value before cloning the parent. Both parent rows then
-- coexist while child tables move, so every individual UPDATE remains FK-safe.
UPDATE horses
SET code = NULL
WHERE id IN (SELECT old_id FROM _horse_id_migration);

INSERT OR IGNORE INTO horses (
  id, name_en, name_ch, code, country_of_origin, colour, sex, age,
  sire, dam, dam_sire, import_type, current_trainer_id, current_rating,
  season_stakes, total_wins, total_starts, status, updated_at
)
SELECT
  migration.new_id, horse.name_en, horse.name_ch, migration.code,
  horse.country_of_origin, horse.colour, horse.sex, horse.age,
  horse.sire, horse.dam, horse.dam_sire, horse.import_type,
  horse.current_trainer_id, horse.current_rating, horse.season_stakes,
  horse.total_wins, horse.total_starts, horse.status, horse.updated_at
FROM horses AS horse
JOIN _horse_id_migration AS migration ON migration.old_id = horse.id;