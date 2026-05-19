// scripts/backtest/dump-features.ts
  //
  // Export per-runner feature CSV for LightGBM walk-forward training.
  // Mirrors the SQL queries in composite-backtest.ts verbatim so features
  // match what analyze.ts uses at inference time.
  //
  // Usage:
  //   pnpm tsx scripts/backtest/dump-features.ts \
  //     --db=bulk-local.db \
  //     --from=2024-09-01 --to=2026-04-30 \
  //     --out=features.csv
  //
  // One row per (race, runner). Columns:
  //   race_id, race_date, venue, race_no, distance, going, field_size,
  //   horse_id, jockey_id, trainer_id, draw, actual_weight, win_odds,
  //   h_elo, j_elo, t_elo, days_since_last,
  //   dist_starts, dist_top3, going_starts, going_top3,
  //   draw_starts, draw_top3, combo_starts, combo_top3, weight_avg5,
  //   elo_composite, factor_bonus, baseline_score,
  //   finishing_position, is_top1, is_top3
  //
  // 'baseline_score' = elo_composite + factor_bonus, identical to analyze.ts
  // finalScore — included so the LGB script can compute the ELO baseline
  // hit-rate over the SAME race set for an apples-to-apples comparison.

  import Database from 'better-sqlite3';
  import { writeFileSync, appendFileSync } from 'node:fs';

  function arg(name: string, fallback?: string): string {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const ix = process.argv.indexOf(`--${name}`);
    if (ix >= 0 && ix + 1 < process.argv.length) return process.argv[ix + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  function argNum(name: string, fallback: number): number {
    const v = arg(name, String(fallback));
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  const DB_PATH = arg('db', 'bulk-local.db');
  const FROM = arg('from', '2024-09-01');
  const TO = arg('to', '2026-04-30');
  const ENGINE = (arg('engine', 'v12') === 'v11' ? 'v11' : 'v12') as 'v11' | 'v12';
  const W_HORSE = argNum('w-horse', 0.7);
  const W_JOCKEY = argNum('w-jockey', 0.2);
  const W_TRAINER = argNum('w-trainer', 0.1);
  const OUT = arg('out', 'features.csv');
  // ── Stage 7: upcoming-prediction mode ────────────────────────────────────
  // When set, ignore --from/--to and read race+runner list from the JSON
  // produced by /admin/api/entries-upcoming-export. Same feature columns
  // are computed; finishing_position / is_top1 / is_top3 emitted as 0.
  const UPCOMING_JSON = arg('upcoming-json', '');

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('cache_size = -200000'); // 200MB cache

  // ── ELO readers ────────────────────────────────────────────────────────
    // FIX 2026-05-06: previous query had two bugs that returned null for ALL ELOs:
    //   1) jockey_elo_snapshots & trainer_elo_snapshots have NO axis_key column
    //      (only horse_elo_snapshots does — see src/db/schema_v2.sql L255 vs L273/L288).
    //      The old WHERE axis_key='overall' threw a SQL error → caught → null.
    //   2) Old WHERE id LIKE 'v12:%' never matched: compute.ts builds horse snap
    //      ids as `${id}|overall|${date}|...` and compute_v11.ts uses
    //      `${entityId}|${axisKey}|...` — neither uses any v12: / v11: prefix.
    // Result: feature_importance for h_elo / j_elo / t_elo was 0.0 in Stage 3
    // because every value in the column was null.
    //
    // Fix: per-entity query that matches actual schema. Since neither engine
    // tags rows with a prefix and the workflow only ever runs one engine into
    // the cached DB, the ENGINE arg is now informational only — the same row
    // set is read regardless.
    // ── ELO ID-bridge ──────────────────────────────────────────────────
      // compute.ts writes ELO snapshots keyed by:
      //   horse_elo_snapshots.horse_id     = horse_form_records.horse_id  ≡ horses.code      (e.g. 'A001')
      //   jockey_elo_snapshots.jockey_id   = horse_form_records.jockey_name ≡ jockeys.name_ch  (中文名)
      //   trainer_elo_snapshots.trainer_id = horse_form_records.trainer_name ≡ trainers.name_ch
      //
      // race_results uses prefixed surrogate IDs (horse_A001 / jockey_郭能 / trainer_方嘉柏)
      // which never match snapshot keys directly. Without this translation step every
      // readElo returned null — h_elo/j_elo/t_elo were 100% null and LGB importance was 0.
      const horseCodeStmt = db.prepare('SELECT code FROM horses WHERE id=?');
      const jockeyNameStmt = db.prepare('SELECT name_ch FROM jockeys WHERE id=?');
      const trainerNameStmt = db.prepare('SELECT name_ch FROM trainers WHERE id=?');
      const bridgeCache: Record<'horse' | 'jockey' | 'trainer', Map<string, string | null>> = {
        horse: new Map(), jockey: new Map(), trainer: new Map(),
      };
      function bridgeId(entity: 'horse' | 'jockey' | 'trainer', rawId: string): string | null {
        const cache = bridgeCache[entity];
        if (cache.has(rawId)) return cache.get(rawId)!;
        let bridged: string | null = null;
        if (entity === 'horse') {
          const row = horseCodeStmt.get(rawId) as { code: string | null } | undefined;
          bridged = row?.code ?? null;
        } else if (entity === 'jockey') {
          const row = jockeyNameStmt.get(rawId) as { name_ch: string | null } | undefined;
          bridged = row?.name_ch ?? null;
        } else {
          const row = trainerNameStmt.get(rawId) as { name_ch: string | null } | undefined;
          bridged = row?.name_ch ?? null;
        }
        cache.set(rawId, bridged);
        return bridged;
      }

      const eloStmtCache = new Map<string, Database.Statement>();
      function eloStmt(entity: 'horse' | 'jockey' | 'trainer'): Database.Statement {
        let s = eloStmtCache.get(entity);
        if (s) return s;
        const table = `${entity}_elo_snapshots`;
        const col = `${entity}_id`;
        // horse_elo_snapshots has axis_key NOT NULL — filter to 'overall'.
        // jockey/trainer snapshot tables have no axis_key column.
        const sql = entity === 'horse'
          ? `SELECT rating FROM ${table} WHERE ${col}=? AND axis_key='overall' AND as_of_date<? ORDER BY as_of_date DESC LIMIT 1`
          : `SELECT rating FROM ${table} WHERE ${col}=? AND as_of_date<? ORDER BY as_of_date DESC LIMIT 1`;
        s = db.prepare(sql);
        eloStmtCache.set(entity, s);
        return s;
      }
      function readElo(entity: 'horse' | 'jockey' | 'trainer', id: string | null, asOf: string): number | null {
        if (!id) return null;
        const key = bridgeId(entity, id);
        if (!key) return null;
        try {
          const row = eloStmt(entity).get(key, asOf) as { rating: number } | undefined;
          return row?.rating ?? null;
        } catch (e) {
          if (process.env.DEBUG_ELO) console.error(`[readElo] ${entity} ${id}->${key} ${asOf}:`, (e as Error).message);
          return null;
        }
      }

    // ── Factor queries (verbatim from composite-backtest.ts) ────────────────
  const qDistFit = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ?
       AND rm.date < ?
       AND r.distance BETWEEN ? AND ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qGoingFit = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ?
       AND rm.date < ?
       AND r.going = ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qDrawBias = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rm.venue = ?
       AND rm.date < ?
       AND r.distance BETWEEN ? AND ?
       AND rr.draw = ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

  const qWeightDelta = db.prepare(`
    SELECT AVG(rr.actual_weight) AS avg_w
      FROM (
        SELECT rr.actual_weight
          FROM race_results rr
          JOIN races r ON r.id = rr.race_id
          JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id = ?
           AND rm.date < ?
           AND rr.actual_weight IS NOT NULL
         ORDER BY rm.date DESC LIMIT 5
      ) rr`);

  const qLastRaceDate = db.prepare(`
    SELECT MAX(rm.date) AS last_date
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.horse_id = ? AND rm.date < ?`);

  const qCombo = db.prepare(`
    SELECT COUNT(*) AS starts,
           SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
      FROM race_results rr
      JOIN races r ON r.id = rr.race_id
      JOIN race_meetings rm ON rm.id = r.meeting_id
     WHERE rr.jockey_id = ?
       AND rr.trainer_id = ?
       AND rm.date < ?
       AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // ── Stage 4c: recency-weighted form + cross-features (no odds) ─────────
    // form_last5: last 5 starts of horse with field size for normalization.
    const qFormLast5 = db.prepare(`
      SELECT rr.finishing_position AS pos,
             (SELECT COUNT(*) FROM race_results rr2
                WHERE rr2.race_id = rr.race_id
                  AND rr2.finishing_position BETWEEN 1 AND 98) AS field
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.horse_id = ? AND rm.date < ?
         AND rr.finishing_position BETWEEN 1 AND 98
       ORDER BY rm.date DESC LIMIT 5`);

    // trainer × venue: how often trainer's runners hit top-3 at this venue
    const qTrainerVenue = db.prepare(`
      SELECT COUNT(*) AS starts,
             SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.trainer_id = ? AND rm.venue = ? AND rm.date < ?
         AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // jockey × venue: jockey-venue specialization
    const qJockeyVenue = db.prepare(`
      SELECT COUNT(*) AS starts,
             SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.jockey_id = ? AND rm.venue = ? AND rm.date < ?
         AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // jockey × distance band: sprinter vs stayer specialization
    const qJockeyDistBand = db.prepare(`
      SELECT COUNT(*) AS starts,
             SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.jockey_id = ? AND r.distance BETWEEN ? AND ?
         AND rm.date < ?
         AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // ── Stage 5: track-condition specialization ────────────────────────────
    // jockey × going: how does this jockey perform on this surface (Good / Yielding / Soft / etc)
    const qJockeyGoing = db.prepare(`
      SELECT COUNT(*) AS starts,
             SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.jockey_id = ? AND r.going = ? AND rm.date < ?
         AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // trainer × going: trainer's preparation suited to today's surface
    const qTrainerGoing = db.prepare(`
      SELECT COUNT(*) AS starts,
             SUM(CASE WHEN rr.finishing_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.trainer_id = ? AND r.going = ? AND rm.date < ?
         AND rr.finishing_position > 0 AND rr.finishing_position < 99`);

    // ── Stage 6 (NEW): pace style — last 8 starts running_position ─────────
    // Format: "2-2-1-1" = sectional positions through race. First segment = early.
    const qHorsePace = db.prepare(`
      SELECT rr.running_position AS rp
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rr.horse_id = ? AND rm.date < ?
         AND rr.running_position IS NOT NULL AND rr.running_position != ''
       ORDER BY rm.date DESC LIMIT 8`);

    // ── Stage 6 (NEW): class change — last race_class for horse ────────────
    // horse_form_records.race_class is text. Format varies:
    //   - bare digit "4"  (from form_records CSV col 9)
    //   - "Class 4"       (older formats)
    //   - "第四班"        (Chinese narrative)
    //   - "Griffin"/"Group 1"
    // Date format in form_records is DD/MM/YYYY (e.g. "01/01/2019"), NOT ISO YYYY-MM-DD.
    // String compare against meta.date (YYYY-MM-DD) would be nonsense, so we fetch ALL
    // prior records and sort in JS using normalized dates.
    const qAllClassHistory = db.prepare(`
      SELECT race_class AS rc, race_date AS dt
        FROM horse_form_records
       WHERE horse_id = ?
         AND race_class IS NOT NULL AND race_class != ''
         AND race_date IS NOT NULL AND race_date != ''`);
    // Normalize date: accept DD/MM/YYYY → YYYY-MM-DD; pass through ISO.
    function normDate(s: string): string | null {
      if (!s) return null;
      const t = s.trim();
      const ddmm = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2,'0')}-${ddmm[1].padStart(2,'0')}`;
      const iso = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
      return null;
    }

  
  // ── Bonus helpers (verbatim) ────────────────────────────────────────────
  function daysBetween(a: string, b: string): number {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
  }
  function recencyBonus(d: number | null): number {
    if (d == null) return 0;
    if (d < 7) return -10;
    if (d <= 28) return 10;
    if (d <= 60) return 0;
    if (d <= 120) return -5;
    return -15;
  }
  function rateBonus(starts: number, top3: number, scale = 15): number {
    if (!starts) return 0;
    return ((top3 + 0.30 * 5) / (starts + 5) - 0.30) * scale;
  }
  function weightBonus(curr: number | null, avg: number | null): number {
    if (curr == null || avg == null) return 0;
    return -(curr - avg) * 0.5;
  }

  // ── Stage 6: pace + class helpers ───────────────────────────────────────
  // Parse "2-2-1-1" → array of integers. Returns [] if unparseable.
  function parseRP(rp: string): number[] {
    return rp.split('-').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  }
  // From last-N running_positions: { early: mean first-sectional position, style: 1=leader/2=stalker/3=closer/0=unknown }
  function paceProfile(rps: string[]): { early: number | null; style: number } {
    const earlies: number[] = [];
    for (const rp of rps) {
      const segs = parseRP(rp);
      if (segs.length > 0) earlies.push(segs[0]);
    }
    if (!earlies.length) return { early: null, style: 0 };
    const avg = earlies.reduce((a, b) => a + b, 0) / earlies.length;
    const style = avg <= 2.5 ? 1 : avg <= 4 ? 2 : 3;
    return { early: Math.round(avg * 100) / 100, style };
  }
  // Convert race class text → numeric (lower = higher class).
  // Group 1 = -1, Group 2 = -2, Group 3 = -3 (top); Class 1 = 1 .. Class 5 = 5; Griffin = 6.
  function classToNum(c: string | null | undefined): number | null {
    if (!c) return null;
    const s = String(c).trim();
    // Bare digit (form_records col 9 stores "4" not "Class 4" / "第四班")
    if (/^[1-9]$/.test(s)) return parseInt(s, 10);
    // English
    let m = s.match(/Class\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    if (/griffin/i.test(s)) return 6;
    m = s.match(/Group\s*(\d+)/i);
    if (m) return -parseInt(m[1], 10);
    // Chinese variants — both Arabic ("第4班") and Chinese ("第四班") digits.
    const cnDigit: Record<string, number> = { '一':1, '二':2, '兩':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };
    m = s.match(/第\s*([0-9一二三四五六七八九十兩])\s*班/);
    if (m) {
      const d = m[1];
      if (/\d/.test(d)) return parseInt(d, 10);
      if (d in cnDigit) return cnDigit[d];
    }
    // 新馬 = griffin/new horses
    if (/新馬|無評分|0班/.test(s)) return 6;
    // 國際/Group equivalents
    if (/國際一級|一級賽/.test(s)) return -1;
    if (/國際二級|二級賽/.test(s)) return -2;
    if (/國際三級|三級賽/.test(s)) return -3;
    return null;
  }

  // ── Race iteration ──────────────────────────────────────────────────────
  type RaceMeta = { id: string; date: string; venue: string; race_number: number; distance: number; going: string; class: string | null };
  type RunnerRow = {
    race_id: string; horse_id: string; jockey_id: string | null; trainer_id: string | null;
    finishing_position: number; draw: number | null; actual_weight: number | null; win_odds: number | null;
  };

  // ── Race + runner source ────────────────────────────────────────────────
  // Default mode: pull historical races + finishing positions from race_results.
  // --upcoming-json mode: read upcoming entries from JSON file (admin export).
  let races: RaceMeta[];
  // runnersByRace: pre-built for upcoming mode; qRunners: SQL prepared for history mode.
  let qRunners: any = null;
  const runnersByRace: Map<string, RunnerRow[]> = new Map();
  const UPCOMING_MODE = UPCOMING_JSON !== '';

  if (UPCOMING_MODE) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const data = JSON.parse(readFileSync(UPCOMING_JSON, 'utf8'));
    const entries: any[] = data.entries || [];
    const metaByKey: Map<string, RaceMeta> = new Map();
    for (const e of entries) {
      if (!e.horse_id) continue;  // skip unresolved runners
      // Skip reserve/unassigned pool entries: race_number 0 or missing.
      // (HKJC pre-declarations land horses in a "race 0" bucket until they're
      // assigned to a numbered race. Predicting that pool as one big race is
      // meaningless — scores would diffuse across 100+ unrelated horses.)
      if (!e.race_number || Number(e.race_number) < 1) continue;
      // Synthesize a race_id when D1 hasn't assigned one yet:
      // YYYYMMDD_VENUE_R<n>  (matches our prod race_id naming convention).
      const dateCompact = String(e.race_date || '').replace(/-/g, '');
      const synthId = `${dateCompact}_${e.venue}_R${e.race_number}`;
      const raceId: string = e.race_id || synthId;
      if (!metaByKey.has(raceId)) {
        metaByKey.set(raceId, {
          id: raceId,
          date: e.race_date,
          venue: e.venue,
          race_number: Number(e.race_number),
          distance: Number(e.distance) || 0,
          going: String(e.going || ''),
          class: e.race_class || null,
        });
      }
      const list = runnersByRace.get(raceId) || [];
      list.push({
        race_id: raceId,
        horse_id: e.horse_id,
        jockey_id: e.jockey_id || null,
        trainer_id: e.trainer_id || null,
        finishing_position: 0,  // unknown — placeholder
        draw: e.draw != null ? Number(e.draw) : null,
        actual_weight: e.actual_weight != null ? Number(e.actual_weight) : null,
        win_odds: null,
      });
      runnersByRace.set(raceId, list);
    }
    races = Array.from(metaByKey.values())
      .sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    console.error(`[dump-features] UPCOMING mode: ${races.length} races, ${entries.length} entries → ${OUT}`);
  } else {
    races = db.prepare(`
      SELECT r.id AS id, rm.date AS date, rm.venue AS venue, r.race_number AS race_number,
             r.distance AS distance, r.going AS going, r.class AS class
        FROM races r
        JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE rm.date BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_id = r.id AND rr.finishing_position BETWEEN 1 AND 98)
       ORDER BY rm.date ASC, r.id ASC`).all(FROM, TO) as RaceMeta[];

    qRunners = db.prepare(`
      SELECT race_id, horse_id, jockey_id, trainer_id, finishing_position,
             draw, actual_weight, win_odds
        FROM race_results
       WHERE race_id = ?
         AND finishing_position BETWEEN 1 AND 98`);
  }

  console.error(`[dump-features] ${FROM}..${TO} → ${races.length} races · ELO=${ENGINE} · W=H${W_HORSE}/J${W_JOCKEY}/T${W_TRAINER}`);
  console.error(`[dump-features] writing → ${OUT}`);

  const HEADER = [
      'race_id','race_date','venue','race_no','distance','going','field_size',
      'horse_id','jockey_id','trainer_id','draw','actual_weight','win_odds',
      'h_elo','j_elo','t_elo','days_since_last',
      'dist_starts','dist_top3','going_starts','going_top3',
      'draw_starts','draw_top3','combo_starts','combo_top3','weight_avg5',
      'elo_composite','factor_bonus','baseline_score',
      // Stage 4c: recency-weighted form (per horse, last 5 starts)
      'form_n','form_avgpos_w','form_top3rate_w','form_pos_slope',
      // Stage 4c: cross-features (interaction history)
      'tv_starts','tv_top3','jv_starts','jv_top3','jdb_starts','jdb_top3',
      // Stage 5: track-condition specialization (jockey/trainer × going)
      'jg_starts','jg_top3','tg_starts','tg_top3',
      // Stage 6 (NEW): pace style (per horse, last 8 starts) + race-level pace clash
      'horse_pace_n','horse_pace_early','horse_pace_style',
      'race_n_leaders','race_n_closers','horse_pace_clash',
      // Stage 6 (NEW): class change (current vs horse's last race_class)
      'class_now_num','last_class_num','class_delta',
      'finishing_position','is_top1','is_top3',
    ];
  writeFileSync(OUT, HEADER.join(',') + '\n');

  function csv(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  let buf: string[] = [];
  let written = 0;
  function flush() { if (buf.length) { appendFileSync(OUT, buf.join('')); buf = []; } }

  for (let i = 0; i < races.length; i++) {
    const meta = races[i];
    const runners: RunnerRow[] = UPCOMING_MODE
      ? (runnersByRace.get(meta.id) || [])
      : (qRunners.all(meta.id) as RunnerRow[]);
    if (runners.length < 4) continue;

    // sort by finish position to identify top1/top3 horse_ids for label
    // (upcoming mode: all finishing_position=0, so top1/top3 are arbitrary; labels unused.)
    const sorted = [...runners].sort((a, b) => a.finishing_position - b.finishing_position);
    const top1Id = sorted[0].horse_id;
    const top3Set = new Set(sorted.slice(0, 3).map(r => r.horse_id));
    const fieldSize = runners.length;

    // Stage 6: pre-pass to collect each runner's pace style → race-level counts
    const paceByHorse: Map<string, { early: number | null; style: number; n: number }> = new Map();
    for (const r of runners) {
      const rps = (qHorsePace.all(r.horse_id, meta.date) as { rp: string }[]).map(x => x.rp);
      const pp = paceProfile(rps);
      paceByHorse.set(r.horse_id, { early: pp.early, style: pp.style, n: rps.length });
    }
    let raceNLeaders = 0, raceNClosers = 0;
    for (const v of paceByHorse.values()) {
      if (v.style === 1) raceNLeaders++;
      if (v.style === 3) raceNClosers++;
    }
    const classNowNum = classToNum(meta.class);

    for (const r of runners) {
      const hElo = readElo('horse', r.horse_id, meta.date);
      const jElo = readElo('jockey', r.jockey_id, meta.date);
      const tElo = readElo('trainer', r.trainer_id, meta.date);
      const eloParts = [hElo, jElo, tElo].map((e, ix) => e == null ? null : e * [W_HORSE, W_JOCKEY, W_TRAINER][ix]);
      const eloComposite = eloParts.some(p => p == null) ? null : (eloParts as number[]).reduce((a, b) => a + b, 0);

      const lr = qLastRaceDate.get(r.horse_id, meta.date) as { last_date: string | null } | undefined;
      const daysSince = lr?.last_date ? daysBetween(lr.last_date, meta.date) : null;

      const dF = qDistFit.get(r.horse_id, meta.date, meta.distance - 200, meta.distance + 200) as { starts: number; top3: number } | undefined;
      const gF = meta.going ? qGoingFit.get(r.horse_id, meta.date, meta.going) as { starts: number; top3: number } | undefined : undefined;
      const drawF = (r.draw != null) ? qDrawBias.get(meta.venue, meta.date, meta.distance - 100, meta.distance + 100, r.draw) as { starts: number; top3: number } | undefined : undefined;
      const wF = qWeightDelta.get(r.horse_id, meta.date) as { avg_w: number | null } | undefined;
      const cF = (r.jockey_id && r.trainer_id) ? qCombo.get(r.jockey_id, r.trainer_id, meta.date) as { starts: number; top3: number } | undefined : undefined;

        // ── Stage 4c features ──
        // Recency-weighted form from last 5 starts
        const formRows = qFormLast5.all(r.horse_id, meta.date) as { pos: number; field: number }[];
        const formN = formRows.length;
        let formAvgPosW: number | null = null, formTop3RateW: number | null = null, formPosSlope: number | null = null;
        if (formN > 0) {
          const wAll = [0.40, 0.25, 0.15, 0.10, 0.10];
          const w = wAll.slice(0, formN);
          const wSum = w.reduce((a, b) => a + b, 0);
          const normPos = formRows.map(f => f.field > 0 ? f.pos / f.field : 0.5);
          formAvgPosW = normPos.reduce((s, p, ix) => s + p * w[ix], 0) / wSum;
          const top3 = formRows.map(f => f.pos >= 1 && f.pos <= 3 ? 1 : 0);
          formTop3RateW = top3.reduce((s, t, ix) => s + t * w[ix], 0) / wSum;
          if (formN >= 2) {
            // Linear slope of -pos over time index (most recent = highest x).
            // Positive slope = improving (positions getting better over time).
            const xs = formRows.map((_, ix) => formN - 1 - ix);
            const ys = formRows.map(f => -f.pos);
            const xMean = xs.reduce((a, b) => a + b, 0) / formN;
            const yMean = ys.reduce((a, b) => a + b, 0) / formN;
            let num = 0, den = 0;
            for (let k = 0; k < formN; k++) { num += (xs[k] - xMean) * (ys[k] - yMean); den += (xs[k] - xMean) ** 2; }
            formPosSlope = den > 0 ? num / den : 0;
          } else {
            formPosSlope = 0;
          }
        }
        // Cross-features
        const tvF = r.trainer_id ? qTrainerVenue.get(r.trainer_id, meta.venue, meta.date) as { starts: number; top3: number } | undefined : undefined;
        const jvF = r.jockey_id ? qJockeyVenue.get(r.jockey_id, meta.venue, meta.date) as { starts: number; top3: number } | undefined : undefined;
        const jdbF = r.jockey_id ? qJockeyDistBand.get(r.jockey_id, meta.distance - 200, meta.distance + 200, meta.date) as { starts: number; top3: number } | undefined : undefined
        // Stage 5
        const jgF = (r.jockey_id && meta.going) ? qJockeyGoing.get(r.jockey_id, meta.going, meta.date) as { starts: number; top3: number } | undefined : undefined;
        const tgF = (r.trainer_id && meta.going) ? qTrainerGoing.get(r.trainer_id, meta.going, meta.date) as { starts: number; top3: number } | undefined : undefined;;
  
      const fRecency = recencyBonus(daysSince);
      const fDist = rateBonus(dF?.starts ?? 0, dF?.top3 ?? 0, 15);
      const fGoing = rateBonus(gF?.starts ?? 0, gF?.top3 ?? 0, 12);
      const fDraw = rateBonus(drawF?.starts ?? 0, drawF?.top3 ?? 0, 10);
      const fWeight = weightBonus(r.actual_weight, wF?.avg_w ?? null);
      const fCombo = rateBonus(cF?.starts ?? 0, cF?.top3 ?? 0, 8);
      const factorBonus = fRecency + fDist + fGoing + fDraw + fWeight + fCombo;
      const baselineScore = eloComposite != null ? eloComposite + factorBonus : null;

      // Stage 6: pace + class
      const pace = paceByHorse.get(r.horse_id)!;
      // pace_clash: leaders penalized when many leaders in field; closers slightly bonus when few closers
      let paceClash: number | null = null;
      if (pace.style === 1) paceClash = -(raceNLeaders - 1);          // each extra leader = -1
      else if (pace.style === 3) paceClash = Math.max(0, 2 - raceNClosers); // few closers = +1/+2
      else if (pace.style === 2) paceClash = 0;
      // horse_form_records.horse_id = horses.code (A001), but race_results.horse_id is prefixed (horse_A001). Bridge.
      // Also: form_records.race_date is DD/MM/YYYY → fetch all + sort in JS using normDate.
      const horseCode = bridgeId('horse', r.horse_id);
      let lastClassRaw: string | null = null;
      if (horseCode) {
        const hist = qAllClassHistory.all(horseCode) as { rc: string | null; dt: string }[];
        let bestIso = '';
        for (const h of hist) {
          const iso = normDate(h.dt);
          if (iso && iso < meta.date && iso > bestIso) {
            bestIso = iso;
            lastClassRaw = h.rc;
          }
        }
      }
      const lastClassNum = classToNum(lastClassRaw);
      const classDelta = (classNowNum != null && lastClassNum != null) ? (lastClassNum - classNowNum) : null;

      const row = [
          meta.id, meta.date, meta.venue, meta.race_number, meta.distance, meta.going, fieldSize,
          r.horse_id, r.jockey_id, r.trainer_id, r.draw, r.actual_weight, r.win_odds,
          hElo, jElo, tElo, daysSince,
          dF?.starts ?? 0, dF?.top3 ?? 0, gF?.starts ?? 0, gF?.top3 ?? 0,
          drawF?.starts ?? 0, drawF?.top3 ?? 0, cF?.starts ?? 0, cF?.top3 ?? 0, wF?.avg_w ?? null,
          eloComposite, factorBonus, baselineScore,
          formN, formAvgPosW, formTop3RateW, formPosSlope,
          tvF?.starts ?? 0, tvF?.top3 ?? 0, jvF?.starts ?? 0, jvF?.top3 ?? 0, jdbF?.starts ?? 0, jdbF?.top3 ?? 0,
          jgF?.starts ?? 0, jgF?.top3 ?? 0, tgF?.starts ?? 0, tgF?.top3 ?? 0,
          pace.n, pace.early, pace.style,
          raceNLeaders, raceNClosers, paceClash,
          classNowNum, lastClassNum, classDelta,
          r.finishing_position,
          r.horse_id === top1Id ? 1 : 0,
          top3Set.has(r.horse_id) ? 1 : 0,
        ].map(csv).join(',');
      buf.push(row + '\n');
      written++;
      if (buf.length >= 5000) flush();
    }
    if ((i + 1) % 100 === 0) console.error(`  [${i + 1}/${races.length}] races processed, ${written} rows written`);
  }
  flush();
  console.error(`[dump-features] done: ${written} rows × ${HEADER.length} cols → ${OUT}`);
  db.close();
  