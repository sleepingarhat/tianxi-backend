import { validateRaceId } from './running-style';

type JsonRecord = Record<string, any>;

const PICK_SCALARS = [
  'horseNumber',
  'nameCh',
  'nameEn',
  'jockeyCh',
  'trainerCh',
  'draw',
  'declaredWeight',
  'rating',
  'pWin',
  'pTop3',
  'pTop4',
  'rank',
  'winOdds',
  'liveWinOdds',
  'marketRank',
  'blendProb',
  'value',
  'valueEdge',
] as const;

const RACE_SCALARS = [
  'raceNumber',
  'title',
  'class',
  'distance',
  'going',
  'track',
  'course',
  'marketReady',
  'oddsSnapshotAt',
] as const;

const COVERAGE_KEYS = [
  'trio_n4',
  'trio_n5',
  'trio_n6',
  'first4_n4',
  'first4_n5',
  'first4_n6',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPublicScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function copyScalars(
  source: JsonRecord,
  keys: readonly string[],
): JsonRecord {
  const result: JsonRecord = {};
  for (const key of keys) {
    if (isPublicScalar(source[key])) result[key] = source[key];
  }
  return result;
}

function safeHorseId(value: unknown): string | undefined {
  return typeof value === 'string' && /^horse_[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

function safeRaceId(value: unknown): string | undefined {
  return typeof value === 'string' && validateRaceId(value)
    ? value
    : undefined;
}

function safeScoreSource(
  source: JsonRecord,
  coverageApplied = false,
): 'lgb' | 'baseline' {
  const raw = typeof source.scoreSource === 'string'
    ? source.scoreSource.toLowerCase()
    : '';
  return coverageApplied || source.lgbScore != null || /lgb|ensemble/.test(raw)
    ? 'lgb'
    : 'baseline';
}

function projectCoverage(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const projected = copyScalars(value, COVERAGE_KEYS);
  return Object.keys(projected).length ? projected : undefined;
}

function projectRaceQuality(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const projected: JsonRecord = {};
  if (value.tier === '高' || value.tier === '中' || value.tier === '低') {
    projected.tier = value.tier;
  }
  if (typeof value.rank === 'number' && Number.isFinite(value.rank)) {
    projected.rank = value.rank;
  }
  if (typeof value.total === 'number' && Number.isFinite(value.total)) {
    projected.total = value.total;
  }
  return Object.keys(projected).length ? projected : undefined;
}

function projectPick(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const projected = copyScalars(value, PICK_SCALARS);
  const horseId = safeHorseId(value.horseId);
  if (horseId) projected.horseId = horseId;
  projected.scoreSource = safeScoreSource(value);
  return projected;
}

function projectRace(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const projected = copyScalars(value, RACE_SCALARS);
  const raceId = safeRaceId(value.raceId);
  if (raceId) projected.raceId = raceId;

  const coverageApplied = Boolean(
    isRecord(value.lgbCoverage) && value.lgbCoverage.applied === true,
  );
  projected.scoreSource = safeScoreSource(value, coverageApplied);
  projected.lgbCoverage = { applied: coverageApplied };

  const expectedBoxCoverage = projectCoverage(value.expectedBoxCoverage);
  if (expectedBoxCoverage) {
    projected.expectedBoxCoverage = expectedBoxCoverage;
  }
  const raceQuality = projectRaceQuality(value.raceQuality);
  if (raceQuality) projected.raceQuality = raceQuality;

  projected.picks = Array.isArray(value.picks)
    ? value.picks.map(projectPick).filter(Boolean)
    : [];
  return projected;
}

/**
 * Public HTTP boundary for today-picks.
 *
 * The compute/cache/log pipeline keeps its full internal payload. Only this
 * projector is allowed to shape the unauthenticated response.
 */
export function projectTodayPicksForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return { races: [] };
  const projected = copyScalars(value, [
    'date',
    'venue',
    'trackCondition',
    'eloReady',
    'generatedAt',
  ]);
  projected.races = Array.isArray(value.races)
    ? value.races.map(projectRace).filter(Boolean)
    : [];
  return projected;
}

export function projectTopPicksForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return { picks: [] };
  const projected = copyScalars(value, [
    'raceNumber',
    'date',
    'venue',
    'eloReady',
  ]);
  const raceId = safeRaceId(value.raceId);
  if (raceId) projected.raceId = raceId;
  projected.picks = Array.isArray(value.picks)
    ? value.picks.map(projectPick).filter(Boolean)
    : [];
  return projected;
}

export function projectExplainForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const projected = copyScalars(value, [
    'rank',
    'pWin',
    'pTop3',
    'pTop4',
  ]);
  const raceId = safeRaceId(value.raceId);
  if (raceId) projected.raceId = raceId;
  const horseId = safeHorseId(value.horseId);
  if (horseId) projected.horseId = horseId;
  return projected;
}

const HIT_RATE_SUMMARY_KEYS = [
  'racesEvaluated',
  'top1HitRate',
  'top3AnyHitRate',
  'top3AvgIntersect',
  'quinellaHitRate',
  'qpHitRate',
  'trioHitRate',
  'tierceHitRate',
  'first4HitRate',
  'top4AvgIntersect',
  'top1Hits',
  'top3AnyHits',
  'quinellaHits',
  'qpHits',
  'trioHits',
  'tierceHits',
  'first4Hits',
  'first4Eligible',
  'top4Eligible',
] as const;

function projectResultHorse(value: unknown, actual = false): JsonRecord | null {
  if (!isRecord(value)) return null;
  const projected = copyScalars(value, actual
    ? ['position', 'horseNumber', 'nameCh', 'winOdds', 'hit']
    : ['rank', 'horseNumber', 'nameCh', 'hit']);
  const horseId = safeHorseId(value.horseId);
  if (horseId) projected.horseId = horseId;
  return projected;
}

function projectBoxPayout(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  return copyScalars(value, [
    'pool',
    'name',
    'units',
    'cost',
    'dividend',
    'net',
  ]);
}

function projectHitRateRace(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const projected = copyScalars(value, [
    'raceNumber',
    'title',
    'distance',
    'going',
    'top1Hit',
    'top3IntersectCount',
    'top3AnyHit',
    'top4IntersectCount',
    'quinellaHit',
    'qpHit',
    'trioHit',
    'tierceHit',
    'first4Hit',
  ]);
  projected.predictedTop4 = Array.isArray(value.predictedTop4)
    ? value.predictedTop4.map((item) => projectResultHorse(item)).filter(Boolean)
    : [];
  projected.actualTop4 = Array.isArray(value.actualTop4)
    ? value.actualTop4.map((item) => projectResultHorse(item, true)).filter(Boolean)
    : [];
  projected.boxPayouts = Array.isArray(value.boxPayouts)
    ? value.boxPayouts.map(projectBoxPayout).filter(Boolean)
    : [];
  return projected;
}

export function projectHitRateForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return { races: [] };
  const projected = copyScalars(value, [
    'date',
    'venue',
    'trackCondition',
    'generatedAt',
  ]);
  projected.summary = isRecord(value.summary)
    ? copyScalars(value.summary, HIT_RATE_SUMMARY_KEYS)
    : {};
  projected.races = Array.isArray(value.races)
    ? value.races.map(projectHitRateRace).filter(Boolean)
    : [];
  return projected;
}

function projectMeetingSummary(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  return copyScalars(value, [
    'date',
    'venue',
    ...HIT_RATE_SUMMARY_KEYS,
  ]);
}

export function projectHitRateRollupForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return { perMeeting: [] };
  const projected = copyScalars(value, [
    'windowDays',
    'from',
    'to',
    'meetingsFound',
    'meetingsEvaluated',
    'generatedAt',
    ...HIT_RATE_SUMMARY_KEYS,
  ]);
  projected.perMeeting = Array.isArray(value.perMeeting)
    ? value.perMeeting.map(projectMeetingSummary).filter(Boolean)
    : [];
  return projected;
}

function projectPnlPoint(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  return copyScalars(value, [
    'date',
    'venue',
    'racesBet',
    'cost',
    'payout',
    'net',
    'cum',
  ]);
}

function projectPoolBreakdown(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const result: JsonRecord = {};
  for (const key of ['FF', 'TRIO', 'TIERCE', 'QUARTET']) {
    if (!isRecord(value[key])) continue;
    result[key] = copyScalars(value[key], [
      'cost',
      'payout',
      'net',
      'wins',
      'bets',
    ]);
  }
  return result;
}

export function projectStrategyPnlForPublic(value: unknown): JsonRecord {
  if (!isRecord(value)) return { points: [], poolBreakdown: {} };
  const projected = copyScalars(value, [
    'from',
    'to',
    'perRaceCost',
    'daysEvaluated',
    'racesBet',
    'totalCost',
    'totalPayout',
    'totalNet',
    'roiPct',
    'cumNet',
    'pending',
    'generatedAt',
  ]);
  projected.poolBreakdown = projectPoolBreakdown(value.poolBreakdown);
  projected.points = Array.isArray(value.points)
    ? value.points.map(projectPnlPoint).filter(Boolean)
    : [];
  return projected;
}