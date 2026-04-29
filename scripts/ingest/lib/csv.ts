/**
 * CSV parser utilities
 * Handles Replit HKJC data quirks:
 *   - UTF-8 BOM prefix (\uFEFF)
 *   - Quoted fields with embedded commas
 *   - DD/MM/YYYY dates
 *   - Chinese venue names
 */
import { readFileSync } from 'node:fs';

export type CsvRow = Record<string, string>;

export function parseCsv(path: string): CsvRow[] {
  let raw = readFileSync(path, 'utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    if (vals.length === 1 && vals[0] === '') continue;
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (vals[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

export function readTxtLines(path: string): string[] {
  const raw = readFileSync(path, 'utf-8');
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}
