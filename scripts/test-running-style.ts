#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  computeRunningStyles,
  dateFromRaceId,
  normalisePosition,
  parseFirstPosition,
  validateDate,
  validateHorseIds,
  validateRaceId,
  type RawRunStyleRow,
} from '../src/lib/running-style';

function row(
  horse_id: string,
  race_date: string,
  race_number: number,
  running_position: string | null,
  total_runners: number | null,
  source_priority = 0,
): RawRunStyleRow {
  return {
    horse_id,
    race_date,
    race_number,
    running_position,
    total_runners,
    source_priority,
    venue: 'ST',
  };
}

assert.equal(parseFirstPosition('3-3-2'), 3);
assert.equal(parseFirstPosition('3 2 1'), 3);
assert.equal(parseFirstPosition('1 2-3'), 1);
for (const invalid of [null, '', ' ', 'WV-A', 'PU', '3abc', '2--1', '-1']) {
  assert.equal(parseFirstPosition(invalid), null);
}

assert.equal(normalisePosition(1, 10), 0);
assert.equal(normalisePosition(10, 10), 1);
assert.equal(normalisePosition(5, 10), 4 / 9);
for (const [position, total] of [[0, 10], [11, 10], [1, 1], [1, null]]) {
  assert.equal(normalisePosition(position as number, total as number | null), null);
}

assert.equal(validateDate('2024-02-29'), true);
for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01']) {
  assert.equal(validateDate(invalid), false);
}
assert.equal(validateRaceId('race_2026-06-14_ST_1'), true);
assert.equal(validateRaceId('race_2026-06-14_HV_10'), true);
assert.equal(validateRaceId('race_2026-02-30_ST_1'), false);
assert.equal(validateRaceId('race_2026-06-14_S1_1'), false);
assert.equal(dateFromRaceId('race_2026-06-14_ST_3'), '2026-06-14');
assert.equal(validateHorseIds(['horse_J080', 'horse_A1-B2']), true);
assert.equal(validateHorseIds(['J080']), false);
assert.equal(validateHorseIds([]), false);

const labels = computeRunningStyles([
  row('horse_leader', '2026-06-03', 3, '1-1-1', 12),
  row('horse_leader', '2026-06-02', 2, '2-2-1', 12),
  row('horse_leader', '2026-06-01', 1, '1-1-1', 12),
  row('horse_prominent', '2026-06-03', 3, '3-3-2', 12),
  row('horse_prominent', '2026-06-02', 2, '4-3-2', 12),
  row('horse_prominent', '2026-06-01', 1, '3-2-2', 12),
  row('horse_midfield', '2026-06-03', 3, '6-5-4', 12),
  row('horse_midfield', '2026-06-02', 2, '7-6-5', 12),
  row('horse_midfield', '2026-06-01', 1, '6-6-5', 12),
  row('horse_held', '2026-06-03', 3, '10-9-8', 12),
  row('horse_held', '2026-06-02', 2, '11-10-9', 12),
  row('horse_held', '2026-06-01', 1, '10-10-8', 12),
]);
assert.deepEqual(
  labels.map(({ horseId, code, label, sampleCount }) =>
    [horseId, code, label, sampleCount]),
  [
    ['horse_leader', 'leader', '放', 3],
    ['horse_prominent', 'prominent', '前', 3],
    ['horse_midfield', 'midfield', '中', 3],
    ['horse_held', 'held-up', '後', 3],
  ],
);

assert.deepEqual(computeRunningStyles([
  row('horse_short', '2026-06-02', 2, '1-1', 10),
  row('horse_short', '2026-06-01', 1, '1-1', 10),
]), []);

const fallback = computeRunningStyles([
  row('horse_fallback', '2026-06-03', 3, '1-1', 12),
  row('horse_fallback', '2026-06-02', 2, '1-1', 12),
  row('horse_fallback', '2026-06-01', 1, '1-1', null, 0),
  row('horse_fallback', '2026-06-01', 1, '1-1', 12, 1),
]);
assert.equal(fallback[0].sampleCount, 3);
assert.equal(fallback[0].code, 'leader');

const crossSource: RawRunStyleRow[] = [];
for (let index = 1; index <= 8; index++) {
  crossSource.push(row(
    'horse_cross',
    `2026-05-${String(index).padStart(2, '0')}`,
    index,
    '1-1-1',
    12,
    0,
  ));
  crossSource.push(row(
    'horse_cross',
    `2026-06-${String(index).padStart(2, '0')}`,
    index,
    '12-12-12',
    12,
    1,
  ));
}
const crossResult = computeRunningStyles(crossSource);
assert.equal(crossResult[0].sampleCount, 8);
assert.equal(crossResult[0].code, 'held-up');

console.log('Running-style regression tests passed');