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

Order of operations: early-stopped fit → refit-full → τ_lgb → τ_elo → α.

CLI flags --no-calibrate / --no-ensemble / --val-days=0 fall back step-by-step
to the v1 behaviour if anything in the pipeline misbehaves.
"""
from __future__ import annotations
import argparse, json, sys, math
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
    'elo_composite', 'factor_bonus', 'baseline_score',
    'form_n', 'form_avgpos_w', 'form_top3rate_w', 'form_pos_slope',
    'tv_starts', 'tv_top3', 'jv_starts', 'jv_top3', 'jdb_starts', 'jdb_top3',
    'jg_starts', 'jg_top3', 'tg_starts', 'tg_top3',
    'horse_pace_n', 'horse_pace_early', 'horse_pace_style',
    'race_n_leaders', 'race_n_closers', 'horse_pace_clash',
    'class_now_num', 'last_class_num', 'class_delta',
]


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
    """Graded lambdarank label: higher = better. max_pos - finishing_position, clipped ≥0."""
    max_pos = max(int(df['finishing_position'].max()), 1)
    return (max_pos - df['finishing_position'].astype(int)).clip(lower=0).to_numpy()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', required=True)
    ap.add_argument('--upcoming', required=True)
    ap.add_argument('--admin-url', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--model-version', default='lgb-ensemble-v2')
    ap.add_argument('--num-leaves', type=int, default=15)
    ap.add_argument('--learning-rate', type=float, default=0.05)
    ap.add_argument('--max-n-estimators', type=int, default=500,
                    help='Upper bound for early-stopping search (was n_estimators in v1).')
    ap.add_argument('--min-data-in-leaf', type=int, default=20)
    ap.add_argument('--early-stopping-rounds', type=int, default=20)
    ap.add_argument('--val-days', type=int, default=30,
                    help='Last N days held out for early-stopping, τ and α tuning. '
                         '0 disables validation (v1 legacy mode).')
    ap.add_argument('--no-calibrate', action='store_true')
    ap.add_argument('--no-ensemble', action='store_true')
    ap.add_argument('--dry', action='store_true')
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
        'metric': 'ndcg',
        'ndcg_eval_at': [1, 3],
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
        print(f'[predict] training with validation: train_rows={len(Xtr)} val_rows={len(Xv)} val_races={val_part["race_id"].nunique()}', flush=True)
        booster = lgb.train(
            params, ds_tr,
            num_boost_round=args.max_n_estimators,
            valid_sets=[ds_v], valid_names=['val'],
            callbacks=[lgb.early_stopping(args.early_stopping_rounds, verbose=False)],
        )
        best_iter = booster.best_iteration or args.max_n_estimators
        print(f'[predict] early stopping picked best_iteration={best_iter}', flush=True)
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
        val_baseline = val_part['baseline_score'].fillna(0).to_numpy()

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
    upc_baseline = upc['baseline_score'].fillna(0).to_numpy()

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
    return 0


if __name__ == '__main__':
    sys.exit(main())
