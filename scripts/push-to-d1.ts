#!/usr/bin/env tsx
/**
 * Chunked SQL dump generator for Cloudflare D1.
 *
 * Reads bulk-local.db (better-sqlite3), emits `INSERT OR REPLACE INTO ...`
 * batches of 500 rows wrapped in BEGIN/COMMIT to /tmp/d1-chunks/{table}-{n}.sql
 * so each file stays well under D1's 5 MB / 5k-statement per-request limit.
 *
 * Usage:
 *   tsx scripts/push-to-d1.ts --db=bulk-local.db --out=/tmp/d1-chunks \
 *     --tables=race_meetings,races,horses,jockeys,trainers,running_comments,horse_form_records,dividends,race_results
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

// D1 has a ~100 KB per-statement limit. Keep each INSERT well under that.
// running_comments has ~44-char average text; 200 rows × ~200 bytes ≈ 40 KB. Safe margin.
const ROWS_PER_CHUNK = 200;

// Per-table orphan filters. Local bulk-local.db has FK violations that SQLite
// tolerated (pragma foreign_keys=OFF) but D1 enforces. We filter them out here.
// Each value is an optional WHERE clause that references the table as its own
// name (no alias). Skip comment = no filter.
const FK_FILTERS: Record<string, string> = {
  running_comments:
    'horse_id IN (SELECT id FROM horses) AND race_id IN (SELECT id FROM races)',
  race_results:
    'horse_id IN (SELECT id FROM horses) AND race_id IN (SELECT id FROM races)',
  dividends:
    'race_id IN (SELECT id FROM races)',
  horse_elo_snapshots:
    "('horse_' || horse_id) IN (SELECT id FROM horses)",
  jockey_elo_snapshots:
    "('jockey_' || jockey_id) IN (SELECT id FROM jockeys)",
  trainer_elo_snapshots:
    "('trainer_' || trainer_id) IN (SELECT id FROM trainers)",
};

// Column prefix rewrites. ELO snapshot tables store raw HKJC codes / names but
// D1 horses/jockeys/trainers.id are prefixed. We rewrite on the fly so the
// emitted INSERTs satisfy the D1 FK constraints.
const COLUMN_PREFIX: Record<string, Record<string, string>> = {
  horse_elo_snapshots: { horse_id: 'horse_' },
  jockey_elo_snapshots: { jockey_id: 'jockey_' },
  trainer_elo_snapshots: { trainer_id: 'trainer_' },
};

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (fallback ?? '');
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Buffer) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function main() {
  const dbPath = resolve(arg('db', 'bulk-local.db'));
  const outDir = resolve(arg('out', '/tmp/d1-chunks'));
  const tables = arg('tables').split(',').map(t => t.trim()).filter(Boolean);

  if (!tables.length) {
    console.error('usage: tsx push-to-d1.ts --db=... --out=... --tables=t1,t2,...');
    process.exit(1);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  const manifest: string[] = [];

  for (const table of tables) {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c: { name: string }) => c.name);
    if (!cols.length) { console.error(`!! skip ${table}: no columns`); continue; }

    const colList = cols.map(c => `"${c}"`).join(',');
    const filter = FK_FILTERS[table];
    const where = filter ? ` WHERE ${filter}` : '';
    const rows = db.prepare(`SELECT ${colList} FROM ${table}${where}`).all() as Record<string, unknown>[];
    if (!rows.length) { console.error(`-- skip ${table}: 0 rows`); continue; }
    if (filter) {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      const skipped = total.n - rows.length;
      if (skipped > 0) console.error(`   (${table}: filtered ${skipped} FK orphans)`);
    }

    const prefixMap = COLUMN_PREFIX[table];
    let chunkIdx = 0;
    for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
      const slice = rows.slice(i, i + ROWS_PER_CHUNK);
      const valueTuples = slice
        .map(r => '(' + cols.map(c => {
          const pfx = prefixMap?.[c];
          const val = r[c];
          if (pfx && typeof val === 'string' && val.length && !val.startsWith(pfx)) {
            return esc(pfx + val);
          }
          return esc(val);
        }).join(',') + ')')
        .join(',\n  ');

      // NOTE: D1 rejects BEGIN TRANSACTION / COMMIT at the SQL layer (must use JS
      // storage.transaction()). wrangler batches statements from a --file implicitly,
      // so we emit plain INSERTs and rely on that.
      const sql =
        `-- ${table} chunk ${chunkIdx + 1} rows ${i + 1}-${i + slice.length} of ${rows.length}\n` +
        `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES\n  ${valueTuples};\n`;

      const chunkIdxStr = String(chunkIdx).padStart(3, '0');
      const path = join(outDir, `${table}-${chunkIdxStr}.sql`);
      writeFileSync(path, sql);
      manifest.push(path);
      chunkIdx++;
    }
    console.error(`++ ${table}: ${rows.length} rows → ${chunkIdx} chunk(s)`);
  }

  db.close();

  // Print manifest to stdout (one path per line) so shell can xargs / loop it.
  for (const p of manifest) console.log(p);
  console.error(`\ntotal chunks: ${manifest.length}`);
}

main();
