/**
 * Official published ranking SSOT helpers.
 *
 * Live LGB / ensemble recompute is allowed to drift as future results land.
 * Anything shown as "the prediction" for a settled HK meeting must come from
 * prediction_log (the pre-race freeze), not from that live path.
 */

export function horseNoKey(value: unknown): string {
  if (value == null || value === '') return '';
  return String(value).trim();
}

export function predictedTop4Key(picks: unknown): string {
  if (!Array.isArray(picks)) return '';
  const nums = picks
    .slice()
    .sort((a: any, b: any) => (Number(a?.rank) || 99) - (Number(b?.rank) || 99))
    .slice(0, 4)
    .map((p: any) => horseNoKey(p?.horseNumber ?? p?.horse_number))
    .filter(Boolean);
  return nums.length ? nums.join('-') : '';
}

export function top4Mismatch(a: unknown, b: unknown): boolean {
  const left = predictedTop4Key(a);
  const right = predictedTop4Key(b);
  if (!left || !right) return false;
  return left !== right;
}

export function mergeFrozenPick(live: Record<string, any> | null | undefined, frozen: Record<string, any>): Record<string, any> {
  const rc = live && typeof live === 'object' ? live : {};
  return {
    ...rc,
    horseId: frozen.horseId ?? rc.horseId ?? null,
    horseNumber: frozen.horseNumber ?? rc.horseNumber,
    draw: frozen.draw ?? rc.draw ?? null,
    nameCh: rc.nameCh ?? frozen.nameCh,
    nameEn: rc.nameEn ?? frozen.nameEn ?? null,
    jockeyCh: rc.jockeyCh ?? frozen.jockeyCh ?? null,
    trainerCh: rc.trainerCh ?? frozen.trainerCh ?? null,
    horseElo: frozen.horseElo ?? rc.horseElo ?? null,
    eloComposite: frozen.eloComposite ?? rc.eloComposite ?? null,
    factorBonus: frozen.factorBonus ?? rc.factorBonus ?? null,
    finalScore: frozen.finalScore ?? rc.finalScore ?? null,
    pWin: frozen.pWin ?? rc.pWin ?? null,
    pTop3: frozen.pTop3 ?? rc.pTop3 ?? null,
    pTop4: frozen.pTop4 ?? rc.pTop4 ?? null,
    rank: frozen.rank ?? rc.rank ?? null,
    lgbScore: frozen.lgbScore ?? rc.lgbScore ?? null,
    lgbModelVersion: frozen.lgbModelVersion ?? rc.lgbModelVersion ?? null,
    scoreSource: frozen.scoreSource ?? rc.scoreSource ?? null,
  };
}

export function applyFrozenOrder(
  livePicks: any[] | null | undefined,
  frozenPicks: any[] | null | undefined,
): { picks: any[]; applied: boolean } {
  if (!Array.isArray(frozenPicks) || frozenPicks.length < 4) {
    return { picks: Array.isArray(livePicks) ? livePicks : [], applied: false };
  }
  const byNo = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const p of livePicks || []) {
    const no = horseNoKey(p?.horseNumber);
    if (no) byNo.set(no, p);
    if (p?.horseId) byId.set(String(p.horseId), p);
  }
  const picks = frozenPicks.map((fp) => {
    const live = (fp?.horseId && byId.get(String(fp.horseId))) || byNo.get(horseNoKey(fp?.horseNumber)) || null;
    return mergeFrozenPick(live, fp);
  });
  picks.sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
  picks.forEach((p, i) => { p.rank = i + 1; });
  return { picks, applied: true };
}

export type LockRaceAudit = {
  raceNumber: number;
  frozenTop4: string;
  comparedTop4: string;
  ok: boolean;
};

export function auditTop4Pairs(
  frozenByRace: Map<number, any[]>,
  comparedByRace: Map<number, any[]>,
): { ok: boolean; races: LockRaceAudit[]; mismatches: LockRaceAudit[] } {
  const races: LockRaceAudit[] = [];
  for (const [rn, frozen] of frozenByRace) {
    const compared = comparedByRace.get(rn) || [];
    const frozenTop4 = predictedTop4Key(frozen);
    const comparedTop4 = predictedTop4Key(compared);
    if (!frozenTop4) continue;
    const row = {
      raceNumber: rn,
      frozenTop4,
      comparedTop4,
      ok: !!comparedTop4 && frozenTop4 === comparedTop4,
    };
    races.push(row);
  }
  const mismatches = races.filter((r) => !r.ok);
  return { ok: mismatches.length === 0 && races.length > 0, races, mismatches };
}
