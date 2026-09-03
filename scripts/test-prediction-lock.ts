#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  applyFrozenOrder,
  auditTop4Pairs,
  predictedTop4Key,
  top4Mismatch,
} from '../src/lib/prediction-lock';

const frozen = [
  { horseNumber: 10, rank: 1, nameCh: '辣得金', pWin: 0.22, scoreSource: 'lgb' },
  { horseNumber: 3, rank: 2, nameCh: '萬眾開心', pWin: 0.18, scoreSource: 'lgb' },
  { horseNumber: 2, rank: 3, nameCh: '咥咥友福', pWin: 0.14, scoreSource: 'lgb' },
  { horseNumber: 1, rank: 4, nameCh: '鄉村樂韻', pWin: 0.12, scoreSource: 'lgb' },
];
const liveDrift = [
  { horseNumber: 10, rank: 1, nameCh: '辣得金', jockeyCh: '何澤堯', pWin: 0.21, scoreSource: 'lgb' },
  { horseNumber: 1, rank: 2, nameCh: '鄉村樂韻', jockeyCh: 'A', pWin: 0.19, scoreSource: 'lgb' },
  { horseNumber: 2, rank: 3, nameCh: '咥咥友福', jockeyCh: 'B', pWin: 0.15, scoreSource: 'lgb' },
  { horseNumber: 5, rank: 4, nameCh: '洛河', jockeyCh: 'C', pWin: 0.11, scoreSource: 'lgb' },
];

assert.equal(predictedTop4Key(frozen), '10-3-2-1');
assert.equal(predictedTop4Key(liveDrift), '10-1-2-5');
assert.equal(top4Mismatch(frozen, liveDrift), true);
assert.equal(top4Mismatch(frozen, frozen), false);

const merged = applyFrozenOrder(liveDrift, frozen);
assert.equal(merged.applied, true);
assert.equal(predictedTop4Key(merged.picks), '10-3-2-1');
assert.equal(merged.picks[0].jockeyCh, '何澤堯');
assert.equal(merged.picks[1].nameCh, '萬眾開心');

const incomplete = applyFrozenOrder(liveDrift, frozen.slice(0, 2));
assert.equal(incomplete.applied, false);
assert.equal(predictedTop4Key(incomplete.picks), '10-1-2-5');

const audit = auditTop4Pairs(
  new Map([[1, frozen], [4, [
    { horseNumber: 5, rank: 1 }, { horseNumber: 1, rank: 2 },
    { horseNumber: 7, rank: 3 }, { horseNumber: 2, rank: 4 },
  ]]]),
  new Map([[1, liveDrift], [4, [
    { horseNumber: 5, rank: 1 }, { horseNumber: 1, rank: 2 },
    { horseNumber: 7, rank: 3 }, { horseNumber: 2, rank: 4 },
  ]]]),
);
assert.equal(audit.ok, false);
assert.equal(audit.mismatches.length, 1);
assert.equal(audit.mismatches[0].raceNumber, 1);
assert.equal(audit.mismatches[0].frozenTop4, '10-3-2-1');
assert.equal(audit.mismatches[0].comparedTop4, '10-1-2-5');

console.log('prediction-lock ok');
