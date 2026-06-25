// =============================================
// Official HKJC localresults dividend-table parser
// =============================================
// Parses the 派彩 table from a HKJC localresults page. CRITICAL: dead-heat
// races pay MULTIPLE winning combinations per pool (e.g. a tie for 3rd makes
// two valid tierce/trio/quartet combos). In the HTML the pool-label <td>
// carries a rowspan, so the 2nd+ combinations render as 2-cell <tr> rows
// (combo + amount, no label) under the same pool. A naive "3 cells only"
// parse silently drops every continuation row → missing dead-heat combos.
// This parser tracks the current pool label and also captures 2-cell rows.

export interface HkjcDividendRow {
  poolZh: string;       // raw Chinese pool label, e.g. '三重彩'
  combination: string;  // winning combination as shown, e.g. '3,11,7'
  dividend: number;     // payout per $10
}

export function parseHkjcDividends(html: string): HkjcDividendRow[] {
  const out: HkjcDividendRow[] = [];
  const hIdx = html.indexOf('勝出組合');
  if (hIdx < 0) return out;
  const tbodyStart = html.indexOf('<tbody>', hIdx);
  if (tbodyStart < 0) return out;
  let tbodyEnd = html.indexOf('</tbody>', tbodyStart);
  if (tbodyEnd < 0) tbodyEnd = tbodyStart + 8000;
  const seg = html.slice(tbodyStart, tbodyEnd);
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  let curPool = '';
  while ((m = trRe.exec(seg)) !== null) {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells: string[] = [];
    let t: RegExpExecArray | null;
    while ((t = tdRe.exec(m[1])) !== null) {
      const v = t[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
      if (v !== '') cells.push(v);
    }
    let pool: string;
    let combo: string;
    let amt: string;
    if (cells.length >= 3) {
      pool = cells[0];
      combo = cells[1];
      amt = cells[2];
      curPool = pool;
    } else if (cells.length === 2) {
      pool = curPool;
      combo = cells[0];
      amt = cells[1];
    } else {
      continue;
    }
    const dividend = parseFloat(amt.replace(/,/g, ''));
    if (!isFinite(dividend) || dividend <= 0) continue;
    out.push({ poolZh: pool, combination: combo, dividend });
  }
  return out;
}

// Chinese label → pool code for the four 四揀複式 box pools.
export const BOX_POOL_MAP: Record<string, string> = {
  '四連環': 'FF',
  '單T': 'TRI',
  '三重彩': 'TCE',
  '四重彩': 'QTT',
};
