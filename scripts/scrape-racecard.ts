#!/usr/bin/env tsx
  /**
   * Race card enrichment — hkjc-api.getAllRaces() → enrich entries_upcoming
   *
   * Replaces sentinel race_number=0 rows (written by ingest/sources/entries.ts)
   * with real race_number, draw, jockey, trainer, weight, rating data.
   *
   * Run AFTER capy_entries (horse stubs seeded) and BEFORE push-delta --include=entries.
   *
   * Usage:
   *   tsx scripts/scrape-racecard.ts [--db=bulk-local.db] [--date=YYYY-MM-DD] [--venue=ST|HV] [--dry-run]
   */
  import Database from 'better-sqlite3';
  import { resolve } from 'node:path';
  // @ts-ignore
  import { HorseRacingAPI } from 'hkjc-api';
  import { entryId } from './ingest/lib/ids.js';

  function arg(name: string, fallback = ''): string {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  }

  async function main(): Promise<void> {
    const dbPath = resolve(arg('db', 'bulk-local.db'));
    const dateFilter = arg('date', '');
    const venueFilter = arg('venue', '').toUpperCase();
    const dryRun = process.argv.includes('--dry-run');
    const sourceCommit = process.env.GITHUB_SHA ?? null;

    const api = new HorseRacingAPI();
    const meetings: any[] = await api.getAllRaces().catch(() => null as any);
    if (!meetings || !Array.isArray(meetings) || !meetings.length) {
      console.error('[racecard] getAllRaces returned empty — no active meeting');
      process.exit(0);
    }

    let meeting: any = meetings[0];
    if (dateFilter || venueFilter) {
      const matched = meetings.find((m: any) => {
        const dOk = !dateFilter || (m.date ?? '') === dateFilter;
        const vOk = !venueFilter || (m.venueCode ?? '').toUpperCase() === venueFilter;
        return dOk && vOk;
      });
      if (!matched) {
        const avail = meetings.map((m: any) => `${m.date}@${m.venueCode}`).join(', ');
        console.error(`[racecard] no meeting for date=${dateFilter} venue=${venueFilter}. Available: ${avail}`);
        process.exit(0);
      }
      meeting = matched;
    }

    const meetingDate: string = meeting.date ?? '';
    const venueCode: string = (meeting.venueCode ?? '').toUpperCase();
    const races: any[] = meeting.races ?? [];

    if (!meetingDate || !venueCode) {
      console.error('[racecard] meeting missing date or venueCode:', JSON.stringify(meeting).substring(0, 200));
      process.exit(1);
    }
    if (!races.length) {
      console.error(`[racecard] no races in meeting ${meetingDate}@${venueCode}`);
      process.exit(0);
    }

    // Log meeting summary
    let totalRunners = 0;
    for (const r of races) totalRunners += (r.runners ?? []).length;
    console.error(`[racecard] ${meetingDate}@${venueCode} · ${races.length} races · ${totalRunners} runners`);

    if (dryRun) {
      for (const race of races) {
        const raceNo = Number(race.no ?? 0);
        const runners: any[] = race.runners ?? [];
        console.error(`  R${raceNo} dist=${race.distance}m going=${race.go_en} class=${race.claCode} · ${runners.length} runners`);
        runners.slice(0, 3).forEach((r: any) => {
          console.error(`    #${r.no} ${r.name_ch ?? r.name_en} draw=${r.barrierDrawNumber} jockey=${r.jockey?.name_ch} wt=${r.handicapWeight}`);
        });
      }
      process.exit(0);
    }

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');

    const deleteSentinels = db.prepare(
      'DELETE FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number = 0',
    );

    const upsert = db.prepare(
      `INSERT INTO entries_upcoming
         (id, race_date, venue, race_number, race_class, distance, track, course,
          horse_id, horse_number, horse_code, draw, jockey_name, jockey_id,
          trainer_name, trainer_id, actual_weight, declared_weight, gear,
          rating, priority_order, scraped_at, source_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(race_date, venue, race_number, horse_number) DO UPDATE SET
         race_class      = excluded.race_class,
         distance        = excluded.distance,
         track           = excluded.track,
         course          = excluded.course,
         horse_id        = excluded.horse_id,
         horse_code      = excluded.horse_code,
         draw            = excluded.draw,
         jockey_name     = excluded.jockey_name,
         jockey_id       = excluded.jockey_id,
         trainer_name    = excluded.trainer_name,
         trainer_id      = excluded.trainer_id,
         actual_weight   = excluded.actual_weight,
         declared_weight = excluded.declared_weight,
         gear            = excluded.gear,
         rating          = excluded.rating,
         priority_order  = excluded.priority_order,
         scraped_at      = excluded.scraped_at,
         source_commit   = excluded.source_commit`,
    );

    const upsertHorse = db.prepare(
      `INSERT INTO horses (id, code, name_en, name_ch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         code    = excluded.code,
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    // jockeys table has (id, name_en, name_ch) — no code column
    const upsertJockey = db.prepare(
      `INSERT INTO jockeys (id, name_en, name_ch)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    // trainers table has (id, name_en, name_ch) — no code column
    const upsertTrainer = db.prepare(
      `INSERT INTO trainers (id, name_en, name_ch)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    const upsertMeeting = db.prepare(
      'INSERT INTO race_meetings (id, date, venue) VALUES (?, ?, ?) ON CONFLICT(date, venue) DO NOTHING',
    );

    // Also update track_condition on race_meetings from the going if available
    const updateMeetingGoing = db.prepare(
      `UPDATE race_meetings SET track_condition = ? WHERE date = ? AND venue = ? AND track_condition IS NULL`,
    );

    let deleted = 0;
    let inserted = 0;

    const tx = db.transaction(() => {
      upsertMeeting.run(`${meetingDate}_${venueCode}`, meetingDate, venueCode);

      // Derive track_condition from first race going (e.g. "GOOD", "YIELDING")
      const firstGoing: string | null = races.find((r: any) => r.go_en)?.go_en ?? null;
      if (firstGoing) updateMeetingGoing.run(firstGoing, meetingDate, venueCode);

      const del = deleteSentinels.run(meetingDate, venueCode);
      deleted = del.changes;

      for (const race of races) {
        const raceNo: number = Number(race.no ?? 0);
        if (!raceNo) continue;

        const distance: number | null = race.distance ?? null;
        const track: string | null = race.raceTrack?.description_en ?? null;
        const course: string | null = race.raceCourse?.displayCode ?? race.raceCourse?.description_en ?? null;
        const raceClass: string | null = race.claCode ?? race.raceClass_en ?? null;
        const runners: any[] = race.runners ?? [];

        for (const runner of runners) {
          const horseNo: number = Number(runner.no ?? runner.saddleClothNo ?? 0);
          if (!horseNo) continue;

          const horseCode: string = runner.horse?.code ?? '';
          const horseId: string | null = horseCode ? horseCode : null; // bare code, push-delta prefixes for D1
          const draw: number | null = runner.barrierDrawNumber ?? null;
          const declaredWeight: number | null = runner.handicapWeight ?? null;
          const actualWeight: number | null = runner.currentWeight ?? null;
          const rating: number | null = runner.currentRating ?? null;
          const gear: string | null = runner.gearInfo ?? null;
          const standbyNo: string = String(runner.standbyNo ?? '');
          const priorityOrder: string =
            standbyNo && standbyNo !== '0' && standbyNo !== '' ? `後備${standbyNo}` : '正選';

          const jCode: string = runner.jockey?.code ?? '';
          const jNameCh: string = runner.jockey?.name_ch ?? '';
          const jNameEn: string = runner.jockey?.name_en ?? '';
          const jId: string | null = jCode ? `jockey_${jCode}` : null;

          const tCode: string = runner.trainer?.code ?? '';
          const tNameCh: string = runner.trainer?.name_ch ?? '';
          const tNameEn: string = runner.trainer?.name_en ?? '';
          const tId: string | null = tCode ? `trainer_${tCode}` : null;

          // Seed FK stubs so FK constraints pass (horses id convention: 'horse_<CODE>')
          if (horseId && horseCode) {
            upsertHorse.run(horseId, horseCode, runner.name_en ?? horseCode, runner.name_ch ?? null);
          }
          if (jId) upsertJockey.run(jId, jNameEn || jCode, jNameCh || null);
          if (tId) upsertTrainer.run(tId, tNameEn || tCode, tNameCh || null);

          const id = entryId(meetingDate, venueCode, raceNo, horseNo);
          upsert.run(
            id, meetingDate, venueCode, raceNo, raceClass, distance, track, course,
            horseId, horseNo, horseCode,
            draw, jNameCh || null, jId,
            tNameCh || null, tId,
            actualWeight, declaredWeight, gear,
            rating, priorityOrder,
            new Date().toISOString(), sourceCommit,
          );
          inserted++;
        }
      }
    });

    tx();
    console.error(`[racecard] ✓ deleted ${deleted} sentinels · wrote ${inserted} enriched entries for ${meetingDate}@${venueCode}`);
  }

  main().catch((err) => {
    console.error('[racecard] fatal:', err);
    process.exit(1);
  });
  