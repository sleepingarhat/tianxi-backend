-- Stage 3: run only after every existing table with a horse_id column has been
-- updated. The old parents are then unreferenced and can be removed safely.
DELETE FROM horses
WHERE id IN (SELECT old_id FROM _horse_id_migration)
  AND EXISTS (
    SELECT 1
    FROM horses AS canonical
    JOIN _horse_id_migration AS migration ON migration.new_id = canonical.id
    WHERE migration.old_id = horses.id
  );

DELETE FROM _horse_id_migration
WHERE old_id NOT IN (SELECT id FROM horses);