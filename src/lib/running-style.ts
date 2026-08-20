export type RunningStyleCode =
  | 'leader'
  | 'prominent'
  | 'midfield'
  | 'held-up';

export interface RunningStyleEntry {
  horseId: string;
  code: RunningStyleCode;
  label: string;
  sampleCount: number;
}

export interface RawRunStyleRow {
  horse_id: string;
  race_date: string;
  venue: string;
  race_number: number;
  running_position: string | null;
  total_runners: number | null;
  source_priority?: number;
}

const STYLE_THRESHOLDS = {
  leader: 1 / 6,
  prominent: 0.4,
  midfield: 0.7,
} as const;

const STYLE_LABELS: Record<RunningStyleCode, string> = {
  leader: '放',
  prominent: '前',
  midfield: '中',
  'held-up': '後',
};

export function parseFirstPosition(
  raw: string | null | undefined,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+([-\s]\d+)*$/.test(trimmed)) return null;
  const token = trimmed.split(/[-\s]/, 1)[0];
  const value = Number.parseInt(token, 10);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

export function normalisePosition(
  firstPosition: number | null,
  totalRunners: number | null,
): number | null {
  const total = Number(totalRunners);
  if (
    firstPosition == null ||
    !Number.isFinite(total) ||
    total < 2 ||
    firstPosition < 1 ||
    firstPosition > total
  ) {
    return null;
  }
  return (firstPosition - 1) / (total - 1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function classify(value: number): RunningStyleCode {
  if (value <= STYLE_THRESHOLDS.leader) return 'leader';
  if (value <= STYLE_THRESHOLDS.prominent) return 'prominent';
  if (value <= STYLE_THRESHOLDS.midfield) return 'midfield';
  return 'held-up';
}

export function computeRunningStyles(
  rows: RawRunStyleRow[],
): RunningStyleEntry[] {
  const grouped = new Map<string, RawRunStyleRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.horse_id) ?? [];
    group.push(row);
    grouped.set(row.horse_id, group);
  }

  const styles: RunningStyleEntry[] = [];
  for (const [horseId, horseRows] of grouped) {
    const ordered = [...horseRows].sort((a, b) =>
      String(b.race_date).localeCompare(String(a.race_date)) ||
      Number(b.race_number ?? -1) - Number(a.race_number ?? -1) ||
      Number(a.source_priority ?? 0) - Number(b.source_priority ?? 0)
    );
    const seen = new Set<string>();
    const samples: number[] = [];

    for (const row of ordered) {
      if (samples.length === 8) break;
      const value = normalisePosition(
        parseFirstPosition(row.running_position),
        row.total_runners,
      );
      if (value == null) continue;
      const key = `${row.race_date}|${row.venue ?? ''}|${row.race_number ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push(value);
    }

    if (samples.length < 3) continue;
    const code = classify(median(samples));
    styles.push({
      horseId,
      code,
      label: STYLE_LABELS[code],
      sampleCount: samples.length,
    });
  }
  return styles;
}

export function validateHorseIds(ids: string[]): boolean {
  return ids.length > 0 &&
    ids.every((id) => /^horse_[A-Za-z0-9_-]+$/.test(id));
}

export function validateDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

export function validateRaceId(raceId: string): boolean {
  if (!/^race_\d{4}-\d{2}-\d{2}_(ST|HV)_\d+$/.test(raceId)) {
    return false;
  }
  return validateDate(raceId.slice(5, 15));
}

export function dateFromRaceId(raceId: string): string {
  return raceId.slice(5, 15);
}