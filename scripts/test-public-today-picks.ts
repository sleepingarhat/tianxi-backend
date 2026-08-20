#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  projectExplainForPublic,
  projectHitRateForPublic,
  projectHitRateRollupForPublic,
  projectStrategyPnlForPublic,
  projectTodayPicksForPublic,
  projectTopPicksForPublic,
} from '../src/lib/public-today-picks';

const internal = {
  date: '2026-07-15',
  venue: 'HV',
  trackCondition: '好地',
  eloReady: true,
  generatedAt: '2026-07-15T01:02:03.000Z',
  eloEngine: 'v12',
  eloWeights: { horse: 0.7 },
  seedSummary: { totalSeeded: 3 },
  lgbModelVersion: 'private-model',
  computeMs: 1234,
  predictionLog: { rows: 12 },
  races: [{
    raceId: 'race_2026-07-15_HV_1',
    lgbLookupRaceId: 'private-lookup',
    raceNumber: 1,
    title: '第一場',
    class: '第五班',
    distance: 1650,
    going: '好地',
    track: '草地',
    course: 'C',
    scoreSource: 'tx-oracle-v3 (lgb=12/12, α=0.88)',
    lgbCoverage: { hits: 12, total: 12, rows: 12, applied: true },
    lgbModelVersion: 'private-model',
    ensembleAlpha: 0.88,
    marketReady: true,
    oddsSnapshotAt: '2026-07-15T01:00:00.000Z',
    marketBeta: 0.4,
    expectedBoxCoverage: {
      trio_n4: 0.4,
      trio_n5: 0.5,
      first4_n4: 0.2,
      privateRaw: 99,
    },
    probabilityModel: { name: 'private' },
    raceQuality: { tier: '高', rank: 1, total: 9, score: 88 },
    picks: [{
      horseId: 'horse_J080',
      horseNumber: 3,
      nameCh: '川河型駒',
      nameEn: 'RIVER HORSE',
      jockeyCh: '騎師',
      trainerCh: '練馬師',
      draw: 2,
      declaredWeight: 133,
      rating: 48,
      horseElo: 1550,
      jockeyElo: 1600,
      trainerElo: 1500,
      eloComposite: 1555,
      factorBonus: 3.5,
      factorBreakdown: { draw: { bonus: 2 } },
      finalScore: 1558.5,
      lgbScore: -1.2,
      lgbModelVersion: 'private-model',
      ensembleAlpha: 0.88,
      scoreSource: 'tx-oracle-v3 (ensemble α=0.88)',
      pWin: 0.2,
      pTop3: 0.5,
      pTop4: 0.62,
      rank: 1,
      liveWinOdds: 4.2,
      marketRank: 2,
      blendProb: 0.18,
      value: 'overlay',
      valueEdge: 0.03,
    }, {
      horseId: 'J999',
      horseNumber: 9,
      nameCh: '未驗證 ID',
      scoreSource: 'elo',
      pWin: 0.01,
    }],
  }],
};

const result = projectTodayPicksForPublic(internal);
const race = result.races[0];
const pick = race.picks[0];

assert.deepEqual(Object.keys(result).sort(), [
  'date',
  'eloReady',
  'generatedAt',
  'races',
  'trackCondition',
  'venue',
]);
assert.equal(race.raceId, 'race_2026-07-15_HV_1');
assert.equal(race.scoreSource, 'lgb');
assert.deepEqual(race.lgbCoverage, { applied: true });
assert.deepEqual(race.raceQuality, { tier: '高', rank: 1, total: 9 });
assert.equal(race.expectedBoxCoverage.privateRaw, undefined);
assert.equal(pick.horseId, 'horse_J080');
assert.equal(pick.scoreSource, 'lgb');
assert.equal(race.picks[1].horseId, undefined);
assert.equal(race.picks[1].scoreSource, 'baseline');

const serialized = JSON.stringify(result);
for (const forbidden of [
  'eloWeights',
  'eloEngine',
  'seedSummary',
  'lgbModelVersion',
  'computeMs',
  'predictionLog',
  'lgbLookupRaceId',
  'ensembleAlpha',
  'marketBeta',
  'probabilityModel',
  'factorBreakdown',
  'factorBonus',
  'finalScore',
  'horseElo',
  'jockeyElo',
  'trainerElo',
  'eloComposite',
  'lgbScore',
  'privateRaw',
  '"hits"',
  '"total":12',
]) {
  assert.equal(serialized.includes(forbidden), false, `must omit ${forbidden}`);
}

const topPicks = projectTopPicksForPublic({
  raceId: 'race_2026-07-15_HV_1',
  raceNumber: 1,
  date: '2026-07-15',
  venue: 'HV',
  eloReady: true,
  eloWeights: { horse: 0.7 },
  allPicks: [{ horseId: 'horse_J080', finalScore: 999 }],
  picks: [{
    horseId: 'horse_J080',
    horseNumber: 3,
    nameCh: '川河型駒',
    winOdds: 4.2,
    pWin: 0.2,
    pTop3: 0.5,
    pTop4: 0.62,
    rank: 1,
    horseElo: 1550,
    factorBreakdown: { draw: { bonus: 2 } },
    finalScore: 1558.5,
    lgbScore: -1.2,
    scoreSource: 'tx-oracle-v3 (ensemble α=0.88)',
  }],
});
assert.deepEqual(Object.keys(topPicks).sort(), [
  'date',
  'eloReady',
  'picks',
  'raceId',
  'raceNumber',
  'venue',
]);
assert.equal(topPicks.picks[0].winOdds, 4.2);
assert.equal(topPicks.picks[0].scoreSource, 'lgb');

const explanation = projectExplainForPublic({
  raceId: 'race_2026-07-15_HV_1',
  horseId: 'horse_J080',
  rank: 1,
  pWin: 0.2,
  pTop3: 0.5,
  pTop4: 0.62,
  eloWeights: { horse: 0.7 },
  factorBreakdown: { draw: { bonus: 2 } },
  finalScore: 1558.5,
  comment: 'private formula',
});
assert.deepEqual(explanation, {
  rank: 1,
  pWin: 0.2,
  pTop3: 0.5,
  pTop4: 0.62,
  raceId: 'race_2026-07-15_HV_1',
  horseId: 'horse_J080',
});

const hitRate = projectHitRateForPublic({
  date: '2026-07-15',
  venue: 'HV',
  engine: 'v12',
  alphaUsed: 0.88,
  summary: {
    racesEvaluated: 9,
    top1Hits: 3,
    top1HitRate: 33.3,
    scoreSourceBreakdown: { ensemble: 9 },
    lgbRunnerCoverage: { hits: 100, slots: 100 },
  },
  races: [{
    raceNumber: 1,
    scoreSource: 'tx-oracle',
    lgbModelVersion: 'private-model',
    predictedTop4: [{
      rank: 1,
      horseNumber: 3,
      horseId: 'horse_J080',
      nameCh: '川河型駒',
      finalScore: 1558.5,
      factorBonus: 2,
      reason: 'private factor detail',
    }],
    actualTop4: [{
      position: 1,
      horseNumber: 3,
      horseId: 'horse_J080',
      nameCh: '川河型駒',
      winOdds: 4.2,
    }],
    boxPayouts: [{
      pool: 'TRIO',
      name: '單T',
      units: 4,
      cost: 40,
      dividend: 120,
      net: 80,
      rawCombo: 'private',
    }],
  }],
});
assert.equal(hitRate.summary.top1HitRate, 33.3);
assert.equal(hitRate.races[0].predictedTop4[0].finalScore, undefined);
assert.equal(hitRate.races[0].boxPayouts[0].rawCombo, undefined);

const rollup = projectHitRateRollupForPublic({
  windowDays: 90,
  from: '2026-05-01',
  to: '2026-07-30',
  racesEvaluated: 80,
  top1HitRate: 25,
  errors: [{ date: '2026-07-01', error: 'private DB error' }],
  perMeeting: [{
    date: '2026-07-15',
    venue: 'HV',
    racesEvaluated: 9,
    top1Hits: 3,
    scoreSourceBreakdown: { ensemble: 9 },
  }],
});
assert.equal(rollup.perMeeting[0].top1Hits, 3);
assert.equal(rollup.errors, undefined);

const pnl = projectStrategyPnlForPublic({
  engine: 'v12',
  from: '2026-06-01',
  to: '2026-07-30',
  daysEvaluated: 10,
  racesBet: 80,
  totalCost: 42400,
  totalPayout: 30000,
  totalNet: -12400,
  roiPct: -29.2,
  cumNet: -12400,
  pending: 1,
  pendingRecent: 1,
  skippedMissingBoxData: 4,
  poolBreakdown: {
    TRIO: { cost: 3200, payout: 5000, net: 1800, wins: 4, bets: 80, private: 1 },
  },
  points: [{
    date: '2026-07-15',
    venue: 'HV',
    racesBet: 9,
    cost: 4770,
    payout: 3000,
    net: -1770,
    cum: -12400,
    rawPicks: [1, 2, 3, 4],
  }],
});
assert.equal(pnl.poolBreakdown.TRIO.net, 1800);
assert.equal(pnl.pendingRecent, undefined);
assert.equal(pnl.points[0].rawPicks, undefined);

const allPublic = JSON.stringify({
  topPicks,
  explanation,
  hitRate,
  rollup,
  pnl,
});
for (const forbidden of [
  'eloWeights',
  'factorBreakdown',
  'factorBonus',
  'finalScore',
  'lgbScore',
  'lgbModelVersion',
  'scoreSourceBreakdown',
  'alphaUsed',
  'private formula',
  'private factor detail',
  'private DB error',
]) {
  assert.equal(allPublic.includes(forbidden), false, `all public DTOs must omit ${forbidden}`);
}

console.log('Public analyze contract tests passed');