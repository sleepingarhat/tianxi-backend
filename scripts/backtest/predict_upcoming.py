#!/usr/bin/env python3
"""
Stage 7 v2: train LGB, calibrate, ensemble with ELO, predict upcoming, POST.

Follow-up to v1 (2026-05-19) addressing four weaknesses surfaced by post-ship review:

  #1 GRADED LABEL — switch from binary is_top1 to graded lambdarank label
     (max_pos - finishing_position) so the model learns 2nd/3rd ordering, not
     just top-1. Matches lgb_walkforward.py exactly so train/eval are aligned.

  #2 VALIDATION + EARLY STOPPING — hold out the last --val-days days as a
     validation set, run lgb.train with early_stopping → best_iteration, then
     REFIT on the full data with num_boost_round=best_iteration. Replaces the
     hard-coded n_estimators=200.

  #3 TEMPERATURE CALIBRATION — fit τ_lgb and τ_elo on the validation set to
     minimize per-race log loss of the winner's predicted probability. Produces
     calibrated p_win rather than the previously over-peaked raw softmax.

  #4 ENSEMBLE BLEND — combine LGB and ELO baseline (baseline_score column) at
     the probability level: p_final = α·p_lgb + (1-α)·p_elo, where each engine
     is independently per-race softmaxed (no mixed-scale concerns, satisfies the
     architect's 2026-05-19 gate). α is learned on the validation set by
     minimizing log loss. Posted lgb_score = log(p_final) so analyze.ts's
     existing ranking by lgb_score automatically reflects the ensemble.

Order of operations: early-stopped fit → (val_scores from early-stopped booster)
→ τ_lgb → τ_elo → α  (fit on CLEAN pre-refit val_scores to avoid leakage)
→ refit on FULL data with frozen best_iter → predict upcoming with frozen τ/α.

CLI flags --no-calibrate / --no-ensemble / --val-days=0 fall back step-by-step
to the v1 behaviour if anything in the pipeline misbehaves.
"""
from __future__ import annotations
import argparse, json, sys, math, time
import numpy as np
import pandas as pd
import lightgbm as lgb
import urllib.request, urllib.error
from scipy.optimize import minimize_scalar

FEAT_COLS = [
    'distance', 'field_size', 'draw', 'actual_weight',
    'h_elo', 'j_elo', 't_elo', 'days_since_last',
    'dist_starts', 'dist_top3', 'going_starts', 'going_top3',
    'draw_starts', 'draw_top3', 'combo_starts', 'combo_top3', 'weight_avg5',
    # 2026-05-27 FIX: dropped 'elo_composite' + 'baseline_score' (both are
    # additive aggregates of h_elo/j_elo/t_elo + factor_bonus). Their inclusion
    # let tree #1 split directly on the ELO output → val NDCG saturated → all
    # subsequent trees noise → best_iteration=1. Match walkforward FEATURE_COLS:
    # keep only the raw ELOs + factor_bonus so LGB must learn non-linear
    # interactions ELO misses, producing signal orthogonal to the ensemble's
    # ELO half. baseline_score column is still read at L325 for p_elo blend.
    'factor_bonus',
    'form_n', 'form_avgpos_w', 'form_top3rate_w', 'form_pos_slope',
    'tv_starts', 'tv_top3', 'jv_starts', 'jv_top3', 'jdb_starts', 'jdb_top3',
    'jg_starts', 'jg_top3', 'tg_starts', 'tg_top3',
    'horse_pace_n', 'horse_pace_early', 'horse_pace_style',
    'race_n_leaders', 'race_n_closers', 'horse_pace_clash',
    'class_now_num', 'last_class_num', 'class_delta',
    # Stage 8 (NEW v3.2 2026-05-25): real sectional times + distance interactions.
    # Target: improve top-3 ORDERING (current 30d eval: top3_any=80% but
    # tierce=0%, quinella=3.3%). Sectionals capture early-speed vs late-kick
    # patterns; distance-band × draw/pace interactions let LGB learn that
    # interior draws matter most in sprints, and pace clashes hurt more
    # at distance. NOTE: 'beaten_lengths' deliberately NOT a feature —
    # it's a future regression-head LABEL (would be lookahead if used).
    'sect_n', 'sect_early_avg', 'sect_late_kick',
    'is_sprint', 'is_middle', 'is_distance',
    'draw_x_sprint', 'paceclash_x_distance',
    # Stage 9 (NEW): in-race relative features — per-race cross-runner context
    # (z-scores + ordinal rank vs today's actual field). Same generator
    # (dump-features.ts) computes these for upcoming races, so train/infer match.
    'rel_helo_z', 'rel_helo_rank', 'rel_form_z', 'rel_weight_z', 'rel_days_z', 'rel_factor_z',
]


def standardize_per_race(scores: np.ndarray, race_ids: np.ndarray) -> np.ndarray:
    """Per-race z-score: (s - race_mean) / max(race_std, 1.0).
    Used to bring ELO baseline_score (which lives on 1500±50) onto a softmax-friendly
    scale comparable to LGB raw scores (~±5). Without this, fit_temperature for ELO
    saturates against its upper bound (τ ≈ 100) because the optimizer can never
    flatten a 1500±50 distribution enough — see decision log 2026-05-20."""
    out = np.zeros_like(scores, dtype=float)
    for rid in np.unique(race_ids):
        mask = race_ids == rid
        s = scores[mask].astype(float)
        m = s.mean()
        sd = max(float(s.std()), 1.0)
        out[mask] = (s - m) / sd
    return out


def per_race_softmax(scores: np.ndarray, race_ids: np.ndarray, tau: float = 1.0) -> np.ndarray:
    """Stable per-race softmax: each race's probabilities sum to 1."""
    out = np.zeros_like(scores, dtype=float)
    t = max(float(tau), 1e-6)
    for rid in np.unique(race_ids):
        mask = race_ids == rid
        s = scores[mask] / t
        s = s - s.max()
        e = np.exp(s)
        out[mask] = e / e.sum()
    return out


def race_log_loss(p: np.ndarray, is_top1: np.ndarray, race_ids: np.ndarray) -> float:
    """Mean of -log(p_winner) across races that have a labeled winner."""
    eps = 1e-12
    losses = []
    for rid in np.unique(race_ids):
        mask = race_ids == rid
        winners = is_top1[mask]
        if winners.sum() == 0:
            continue
        ps = p[mask]
        idx = int(np.argmax(winners))
        losses.append(-math.log(max(float(ps[idx]), eps)))
    return float(np.mean(losses)) if losses else float('inf')


def fit_temperature(scores: np.ndarray, race_ids: np.ndarray, is_top1: np.ndarray) -> float:
    """Find τ that minimizes per-race log loss of softmax(scores/τ). Optimized in log-space."""
    def loss(log_tau: float) -> float:
        return race_log_loss(per_race_softmax(scores, race_ids, math.exp(log_tau)),
                             is_top1, race_ids)
    res = minimize_scalar(loss, bounds=(math.log(0.01), math.log(100.0)), method='bounded')
    return float(math.exp(res.x))


def fit_alpha(p_lgb: np.ndarray, p_elo: np.ndarray, race_ids: np.ndarray, is_top1: np.ndarray) -> float:
    """Find α ∈ [0,1] minimizing log loss of α·p_lgb + (1-α)·p_elo."""
    def loss(alpha: float) -> float:
        return race_log_loss(alpha * p_lgb + (1.0 - alpha) * p_elo, is_top1, race_ids)
    res = minimize_scalar(loss, bounds=(0.0, 1.0), method='bounded')
    return float(res.x)


def make_graded_label(df: pd.DataFrame) -> np.ndarray:
    """Graded lambdarank label: higher = better. Clipped to top-5 grades (0..4)
    to align with label_gain=[0,1,7,31,127] and lambdarank_truncation_level=4.
    FIX 2026-05-27: previously used `max_pos - finishing_position` which produced
    labels 0..13 in a 14-horse race. With label_gain saturated at 127 for index
    >= 4, this made winner..10th-place all share gain=127, so the model couldn't
    differentiate the top half of the field → 1-tree saturation (best_iter=1).
    Mapping: 1st→4, 2nd→3, 3rd→2, 4th→1, 5th+→0."""
    pos = df['finishing_position'].astype(int).clip(lower=1, upper=5)
    return (5 - pos).clip(lower=0).to_numpy()


def evaluate_gates(diag: dict) -> tuple:
    """Plan A health gates. Returns (passed: bool, reasons: list[str]).
    Mirrors the manual α-reset checklist. NOTE: α≈1 is EXPECTED (LGB dominates
    ELO on validation) and is NOT a failure — only α≈0 (LGB carries no weight)
    fails, since that means the LGB signal is useless and the blend should stay
    on pure ELO."""
    reasons = []
    bi = diag.get('best_iteration', 0)
    if bi < 50:
        reasons.append(f'best_iteration={bi} < 50 (early-stop saturation)')
    rl = diag.get('race_logloss_curve')
    if not rl:
        reasons.append('no race_logloss_curve (legacy/no-val mode)')
    else:
        i1, bst = rl.get('iter1'), rl.get('best')
        if i1 is None or bst is None:
            reasons.append('race_logloss_curve missing iter1/best')
        else:
            delta = i1 - bst
            if delta < 0.05:
                reasons.append(f'race_logloss Δ={delta:+.4f} < 0.05 (no learning)')
    corr = diag.get('corr_lgb_elo')
    if corr is None or corr != corr:  # None or NaN
        reasons.append('corr_lgb_elo missing/NaN')
    elif corr >= 0.95:
        reasons.append(f'corr_lgb_elo={corr:.3f} >= 0.95 (LGB echoes ELO)')
    for nm in ('tau_lgb', 'tau_elo'):
        v = diag.get(nm)
        if v is None:
            reasons.append(f'{nm} missing')
        elif v < 0.02 or v > 50.0:
            reasons.append(f'{nm}={v:.4f} outside (0.02, 50)')
    a = diag.get('alpha')
    if a is None:
        reasons.append('alpha missing (ensemble disabled)')
    elif a < 0.05:
        reasons.append(f'alpha={a:.3f} < 0.05 (LGB has no weight)')
    return (len(reasons) == 0, reasons)


def post_admin(url: str, token: str, label: str) -> bool:
    """POST to an admin endpoint (empty body). Returns True on 2xx."""
    req = urllib.request.Request(
        url, data=b'', method='POST',
        headers={'Authorization': f'Bearer {token}',
                 'User-Agent': 'tianxi-lgb-predict/2.0 (+github-actions)',
                 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode('utf-8')
            print(f'[gate] {label} → {resp.status}: {body}', flush=True)
            return resp.status < 300
    except urllib.error.HTTPError as e:
        print(f'[gate] {label} FAILED: {e.code} {e.reason} — '
              f'{e.read().decode("utf-8", "ignore")}', flush=True)
        return False
    except Exception as e:
        print(f'[gate] {label} FAILED: {e}', flush=True)
        return False


def check_coverage(upc) -> tuple:
    """Coverage gate: a model can pass training gates yet score a sparse field
    (feature dump dropped runners); enabling the blend then leaves many runners
    on fallback. Require uploaded predictions to cover each race's declared
    field_size. Returns (ok, reason). Never blocks on its own error — the
    primary health gates already passed; coverage is a secondary net."""
    try:
        if 'field_size' not in upc.columns:
            return (True, '')  # cannot assess; do not block
        n_races, poor = 0, []
        for rid, grp in upc.groupby('race_id'):
            field = float(grp['field_size'].max())
            if not (field > 0):
                continue
            n_races += 1
            if (len(grp) / field) < 0.8:
                poor.append(f'{rid}={len(grp)}/{int(field)}')
        if n_races == 0:
            return (True, '')
        if len(poor) > max(1, int(0.2 * n_races)):
            return (False, f'coverage poor in {len(poor)}/{n_races} races: '
                           f'{", ".join(poor[:5])}')
        return (True, '')
    except Exception as e:
        return (True, f'coverage check skipped ({type(e).__name__})')


def main() -> int:
    # Captured at run start; passed to set-alpha as &asof so a stale/parallel
    # run cannot clobber a newer α decision (later-initiated run wins).
    run_asof_ms = int(time.time() * 1000)
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', required=True)
    ap.add_argument('--upcoming', required=True)
    ap.add_argument('--admin-url', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--model-version', default='lgb-ensemble-v2')
    # 2026-05-27 Plan B: prev runs collapsed to best_iteration=1 even after
    # dropping baseline_score/elo_composite from FEAT_COLS. Root cause: NDCG@3
    # saturates after a single 15-leaf tree on a 90-race val set. Force a
    # slower, deeper fit:
    #   - num_leaves 15 → 8  (less single-feature dominance per tree)
    #   - learning_rate 0.05 → 0.01 (each tree contributes less)
    #   - early_stopping_rounds 20 → 80 (more patience on noisy small val)
    ap.add_argument('--num-leaves', type=int, default=8)
    ap.add_argument('--learning-rate', type=float, default=0.01)
    # 2026-05-28 architect review: with lr=0.01, 500 trees ≈ 10 lr=0.05-equivalent
    # trees — caps capacity before slow Plan B fit can accumulate. Raise to 2000.
    ap.add_argument('--max-n-estimators', type=int, default=2000,
                    help='Upper bound for early-stopping search (was n_estimators in v1).')
    ap.add_argument('--min-data-in-leaf', type=int, default=20)
    ap.add_argument('--early-stopping-rounds', type=int, default=80)
    ap.add_argument('--val-days', type=int, default=30,
                    help='Last N days held out for early-stopping, τ and α tuning. '
                         '0 disables validation (v1 legacy mode).')
    ap.add_argument('--no-calibrate', action='store_true')
    ap.add_argument('--no-ensemble', action='store_true')
    ap.add_argument('--dry', action='store_true')
    # 2026-05-29: self-healing ensemble switch — honors 全自動 (no manual α-flip).
    # After predictions land, evaluate Plan A health gates; PASS → set ensemble_alpha
    # to --alpha-pass (LGB+ELO live), FAIL → set 0 (pure-ELO fallback). Either way
    # bust the race-day report cache. URLs derived from --admin-url's base path.
    ap.add_argument('--auto-alpha', action='store_true')
    ap.add_argument('--alpha-pass', type=float, default=0.62)
    args = ap.parse_args()

    print(f'[predict] loading train={args.train}, upcoming={args.upcoming}', flush=True)
    train = pd.read_csv(args.train)
    upc = pd.read_csv(args.upcoming)
    print(f'[predict] train rows={len(train)} races={train["race_id"].nunique()}', flush=True)
    print(f'[predict] upcoming rows={len(upc)} races={upc["race_id"].nunique()}', flush=True)
    if len(upc) == 0:
        print('[predict] no upcoming entries; exiting cleanly', flush=True)
        return 0

    train = train.sort_values(['race_date', 'race_id']).reset_index(drop=True)

    # ── #2 Validation split: last --val-days days ───────────────────────
    use_val = args.val_days > 0
    val_part = None
    if use_val:
        train['race_date'] = pd.to_datetime(train['race_date'])
        cutoff = train['race_date'].max() - pd.Timedelta(days=args.val_days)
        val_mask = train['race_date'] > cutoff
        train_part = train[~val_mask].copy()
        val_part = train[val_mask].copy()
        n_val_races = val_part['race_id'].nunique()
        if n_val_races < 20:
            print(f'[predict] validation too small ({n_val_races} races) → fallback to legacy mode', flush=True)
            use_val = False
            train_part = train
            val_part = None
    else:
        train_part = train

    Xtr = train_part[FEAT_COLS].fillna(-1.0).to_numpy()
    ytr = make_graded_label(train_part)
    grp_tr = train_part.groupby('race_id', sort=False).size().to_numpy()

    params = {
        'objective': 'lambdarank',
        # 2026-05-28 FIX (Plan A整好佢): swap eval metric from NDCG to a custom
        # per-race softmax logloss vs is_top1 (defined below as feval_race_ll).
        # Root cause of best_iter=1 collapse confirmed by local backtest on
        # 19311-row features.csv (5 configs × 5 val_days × 4 label_gain
        # variants all picked iter=1 with NDCG): NDCG@3 on 90-516-race val
        # is a *saturating* discrete metric — a single strong tree on
        # form_avgpos_w + j_elo hits its ceiling and any further trees can
        # only redistribute mass at the head → metric never improves →
        # early-stop fires at iter 1. Binary logloss on the same data
        # trained 531 iters with monotonic improvement. The fix keeps
        # lambdarank as the TRAINING objective (preserves graded ordering
        # signal that binary loses) but switches the EARLY-STOP signal to
        # race-grouped logloss, which has the same monotonic shape as
        # binary logloss. Local held-out 5/27 verification: pure ELO
        # top1=0.0% top3=11.1% → lambdarank+custom-feval ensemble
        # top1=11.1% top3=44.4% (best_iter=472, α=0.95).
        'metric': 'None',
        'lambdarank_truncation_level': 4,
        # Sharper graded label gain ([0,1,3,7,15,31,...] is LGB default).
        # Bigger jumps between rank 4 (winner+) → rank 1 (last in top4) make
        # the optimizer prioritize correct ordering at the head.
        'label_gain': [0, 1, 7, 31, 127, 127, 127, 127, 127, 127, 127, 127,
                       127, 127, 127, 127, 127, 127, 127, 127],
        'learning_rate': args.learning_rate,
        'num_leaves': args.num_leaves,
        'min_data_in_leaf': args.min_data_in_leaf,
        'verbose': -1,
    }

    diag = {
        'val_races': 0, 'best_iteration': 200,
        'tau_lgb': 1.0, 'tau_elo': 1.0, 'alpha': 1.0,
        'val_log_loss': {'baseline': None, 'lgb_calibrated': None,
                         'elo_calibrated': None, 'ensemble': None},
    }
    tau_lgb = tau_elo = 1.0
    alpha = 1.0

    if use_val:
        Xv = val_part[FEAT_COLS].fillna(-1.0).to_numpy()
        yv = make_graded_label(val_part)
        grp_v = val_part.groupby('race_id', sort=False).size().to_numpy()
        ds_tr = lgb.Dataset(Xtr, label=ytr, group=grp_tr)
        ds_v = lgb.Dataset(Xv, label=yv, group=grp_v, reference=ds_tr)
        # Custom feval for early stopping: per-race softmax (τ=1, shape-only)
        # logloss vs is_top1. See params['metric']='None' comment above for
        # why NDCG@3 saturated and binary-style logloss does not.
        val_rid_np = val_part['race_id'].to_numpy()
        val_top1_np = val_part['is_top1'].astype(int).to_numpy()
        def feval_race_ll(preds, _ds):
            probs = per_race_softmax(preds, val_rid_np, tau=1.0)
            ll = race_log_loss(probs, val_top1_np, val_rid_np)
            return ('race_logloss', ll, False)  # is_higher_better=False
        print(f'[predict] training with validation: train_rows={len(Xtr)} val_rows={len(Xv)} val_races={val_part["race_id"].nunique()}', flush=True)
        eval_hist: dict = {}
        booster = lgb.train(
            params, ds_tr,
            num_boost_round=args.max_n_estimators,
            valid_sets=[ds_v], valid_names=['val'],
            feval=feval_race_ll,
            callbacks=[lgb.early_stopping(args.early_stopping_rounds, verbose=False),
                       lgb.record_evaluation(eval_hist)],
        )
        best_iter = booster.best_iteration or args.max_n_estimators
        print(f'[predict] early stopping picked best_iteration={best_iter}', flush=True)
        # Diagnostic: race_logloss curve summary (architect 2026-05-28 review).
        # If best_iter is small AND iter1 ≈ best ≈ final, early-stop metric is
        # saturating — flag for investigation (Plan A regression check).
        if 'val' in eval_hist and 'race_logloss' in eval_hist['val']:
            rl = eval_hist['val']['race_logloss']
            rl_iter1 = rl[0]
            rl_best = rl[best_iter - 1] if best_iter <= len(rl) else rl[-1]
            rl_final = rl[-1]
            print(f'[predict] val race_logloss: iter1={rl_iter1:.4f} best={rl_best:.4f} '
                  f'final={rl_final:.4f} (curve_len={len(rl)})', flush=True)
            if best_iter < 10 and abs(rl_iter1 - rl_best) < 0.001:
                print(f'[predict] WARNING: best_iter={best_iter} with flat race_logloss '
                      f'(Δ={rl_iter1 - rl_best:+.4f}) — early-stop metric may have '
                      f'regressed to NDCG-style saturation; do NOT raise ensemble_alpha',
                      flush=True)
            diag['race_logloss_curve'] = {'iter1': float(rl_iter1),
                                          'best': float(rl_best),
                                          'final': float(rl_final),
                                          'len': len(rl)}
        diag['best_iteration'] = int(best_iter)
        diag['val_races'] = int(val_part['race_id'].nunique())

        # ── CRITICAL: fit τ/α on the PRE-REFIT model's val predictions ──────
        # If we refit on full data first and then predict on val, the model
        # has memorized the val rows and τ/α would be tuned on leaked
        # predictions (architect review of d4ba9dd flagged exactly this).
        # So: 1) score val with the early-stopped (train-only) booster,
        #     2) fit τ_lgb, τ_elo, α on those clean predictions,
        #     3) refit on FULL data for production,
        #     4) apply the FROZEN τ/α to upcoming.
        val_scores = booster.predict(Xv)
        val_rids = val_part['race_id'].to_numpy()
        val_is_top1 = (val_part['finishing_position'] == 1).astype(int).to_numpy()
        val_baseline_raw = val_part['baseline_score'].fillna(0).to_numpy()
        val_baseline = standardize_per_race(val_baseline_raw, val_rids)

        diag['val_log_loss']['baseline'] = race_log_loss(
            per_race_softmax(val_scores, val_rids, 1.0), val_is_top1, val_rids)
        print(f'[predict] val log loss (LGB raw τ=1): {diag["val_log_loss"]["baseline"]:.4f}', flush=True)

        if not args.no_calibrate:
            tau_lgb = fit_temperature(val_scores, val_rids, val_is_top1)
            tau_elo = fit_temperature(val_baseline, val_rids, val_is_top1)
            p_lgb_val = per_race_softmax(val_scores, val_rids, tau_lgb)
            p_elo_val = per_race_softmax(val_baseline, val_rids, tau_elo)
            diag['val_log_loss']['lgb_calibrated'] = race_log_loss(p_lgb_val, val_is_top1, val_rids)
            diag['val_log_loss']['elo_calibrated'] = race_log_loss(p_elo_val, val_is_top1, val_rids)
            diag['tau_lgb'] = tau_lgb
            diag['tau_elo'] = tau_elo
            print(f'[predict] τ_lgb={tau_lgb:.3f} (val log loss {diag["val_log_loss"]["lgb_calibrated"]:.4f})', flush=True)
            print(f'[predict] τ_elo={tau_elo:.3f} (val log loss {diag["val_log_loss"]["elo_calibrated"]:.4f})', flush=True)
            # Diagnostic: Pearson corr(p_lgb_val, p_elo_val) — high (≥0.95) means
            # LGB is just echoing ELO and ensemble blend cannot add orthogonal
            # signal (was the 2026-05-27 hypothesis when baseline_score was in
            # FEAT_COLS). Architect 2026-05-28 review asked for ongoing visibility.
            try:
                corr_le = float(np.corrcoef(p_lgb_val, p_elo_val)[0, 1])
            except Exception:
                corr_le = float('nan')
            diag['corr_lgb_elo'] = corr_le
            print(f'[predict] corr(p_lgb_val, p_elo_val)={corr_le:.3f}', flush=True)
            if corr_le > 0.95:
                print(f'[predict] WARNING: corr≥0.95 — LGB output near-duplicate of ELO '
                      f'on val; ensemble blend has no orthogonal signal to combine',
                      flush=True)
            # Warn if optimizer hit a bound — signals model/data mis-spec.
            for name, val in (('τ_lgb', tau_lgb), ('τ_elo', tau_elo)):
                if val < 0.02 or val > 50.0:
                    print(f'[predict] WARNING: {name}={val:.4f} near optimization bound — '
                          f'inputs may be on a degenerate scale or labels mis-specified', flush=True)
        else:
            p_lgb_val = per_race_softmax(val_scores, val_rids, 1.0)
            p_elo_val = per_race_softmax(val_baseline, val_rids, 1.0)

        # #4 Ensemble α
        if not args.no_ensemble:
            alpha = fit_alpha(p_lgb_val, p_elo_val, val_rids, val_is_top1)
            blended_val = alpha * p_lgb_val + (1.0 - alpha) * p_elo_val
            diag['val_log_loss']['ensemble'] = race_log_loss(blended_val, val_is_top1, val_rids)
            diag['alpha'] = alpha
            print(f'[predict] α={alpha:.3f}, ensemble val log loss {diag["val_log_loss"]["ensemble"]:.4f}', flush=True)
            if alpha < 0.05:
                print(f'[predict] WARNING: α≈0 — ELO baseline strictly dominates LGB on validation; '
                      f'check feature quality or training horizon', flush=True)
            elif alpha > 0.95:
                print(f'[predict] WARNING: α≈1 — ensemble degenerates to pure-LGB; '
                      f'ELO blend contributing no useful signal on validation', flush=True)
        else:
            print(f'[predict] ensemble disabled — posting pure-LGB p_win', flush=True)
    else:
        # Legacy mode: no validation, fixed iterations.
        n_round = min(args.max_n_estimators, 200)
        print(f'[predict] legacy mode (no validation): n_estimators={n_round}', flush=True)
        booster = lgb.train(params, lgb.Dataset(Xtr, label=ytr, group=grp_tr),
                            num_boost_round=n_round)
        diag['best_iteration'] = n_round

    # ── Refit on FULL data with frozen best_iter (τ_lgb/τ_elo/α stay fixed) ──
    # Only runs in validation mode: legacy mode already trained on the full corpus
    # (train_part == train when use_val is False). best_iter is only defined inside
    # the use_val branch — guard prevents NameError in legacy mode.
    if use_val:
        Xfull = train[FEAT_COLS].fillna(-1.0).to_numpy()
        yfull = make_graded_label(train)
        grp_full = train.groupby('race_id', sort=False).size().to_numpy()
        print(f'[predict] refitting on full data ({len(Xfull)} rows) with num_boost_round={best_iter} (τ/α frozen above)', flush=True)
        booster = lgb.train(
            params, lgb.Dataset(Xfull, label=yfull, group=grp_full),
            num_boost_round=int(best_iter),
        )

    # ── Predict upcoming ────────────────────────────────────────────────
    Xu = upc[FEAT_COLS].fillna(-1.0).to_numpy()
    upc_scores = booster.predict(Xu)
    upc_rids = upc['race_id'].to_numpy()
    upc_baseline_raw = upc['baseline_score'].fillna(0).to_numpy()
    upc_baseline = standardize_per_race(upc_baseline_raw, upc_rids)

    p_lgb_upc = per_race_softmax(upc_scores, upc_rids, tau_lgb)
    p_elo_upc = per_race_softmax(upc_baseline, upc_rids, tau_elo)
    p_blended = alpha * p_lgb_upc + (1.0 - alpha) * p_elo_upc

    # lgb_score = log(p_blended) keeps the per-row order consistent with the
    # blended probability; analyze.ts sorts by lgb_score so ranking automatically
    # picks up the ensemble. p_win exposes the calibrated blended probability.
    eps = 1e-12
    upc['lgb_score'] = np.log(np.maximum(p_blended, eps))
    upc['p_win'] = p_blended

    payload = {
        'predictions': [
            {
                'raceId': str(row['race_id']),
                'horseId': str(row['horse_id']),
                'lgbScore': float(row['lgb_score']),
                'pWin': float(row['p_win']),
            }
            for _, row in upc.iterrows()
        ],
        'modelVersion': args.model_version,
        'diagnostics': diag,  # admin endpoint ignores unknown fields; useful in logs
    }
    print(f'[predict] payload: {len(payload["predictions"])} predictions across '
          f'{upc["race_id"].nunique()} races, modelVersion={args.model_version}', flush=True)
    print(f'[predict] diagnostics: {json.dumps(diag, indent=2)}', flush=True)

    if args.dry:
        print(json.dumps(payload, indent=2)[:3000])
        return 0

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        args.admin_url, data=data, method='POST',
        headers={'Authorization': f'Bearer {args.token}',
                 'Content-Type': 'application/json',
                 'User-Agent': 'tianxi-lgb-predict/2.0 (+github-actions)',
                 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode('utf-8')
            print(f'[predict] POST {resp.status}: {body}', flush=True)
            if resp.status >= 300:
                return 2
    except urllib.error.HTTPError as e:
        print(f'[predict] POST failed: {e.code} {e.reason} — {e.read().decode("utf-8", "ignore")}', flush=True)
        return 3

    # ── Auto-alpha gate (2026-05-29): self-healing ensemble switch ──────
    # Reaching here means predictions posted OK. Honors 全自動 — no manual
    # α-flip. PASS all Plan A health gates → ensemble_alpha=--alpha-pass
    # (LGB+ELO blend LIVE). FAIL (e.g. best_iter=1 collapse like 5/27) →
    # ensemble_alpha=0 (pure-ELO fallback). Cache busted either way so
    # analyze.ts recomputes finalScore on the next today-picks request.
    if args.auto_alpha:
        try:
            passed, reasons = evaluate_gates(diag)
        except Exception as e:
            # Never let a malformed diag crash the pipeline after predictions
            # posted — fail closed to pure ELO.
            passed, reasons = False, [f'gate eval raised {type(e).__name__}: {e}']
        cov_ok, cov_reason = check_coverage(upc)
        if not cov_ok:
            passed = False
            reasons = reasons + [cov_reason]
        elif cov_reason:
            print(f'[gate] coverage note: {cov_reason}', flush=True)
        target = args.alpha_pass if passed else 0.0
        if passed:
            print(f'[gate] ALL Plan A health gates PASS → ensemble_alpha={target} '
                  f'(LGB+ELO ensemble LIVE)', flush=True)
        else:
            print(f'[gate] gates FAILED → ensemble_alpha=0 (pure-ELO fallback). '
                  f'reasons: {"; ".join(reasons)}', flush=True)
        base = args.admin_url.rsplit('/', 1)[0]
        ok_a = post_admin(f'{base}/set-alpha?value={target}&asof={run_asof_ms}', args.token,
                          f'set-alpha={target}')
        ok_r = post_admin(f'{base}/refresh-race-day-report', args.token,
                          'refresh-race-day-report')
        if not ok_a:
            # set-alpha is the safety-critical write; surface failures loudly
            # so the workflow goes red and gets human attention.
            print('[gate] ERROR: set-alpha POST failed — α NOT updated; '
                  'check prod manually', flush=True)
            return 4
        if not ok_r:
            print('[gate] WARNING: refresh-race-day-report failed — α updated '
                  'but cache may be stale until the next request', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
