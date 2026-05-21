#!/usr/bin/env python3
"""
P3 backfill (2026-05-21): walk-forward LGB inference for PAST race meetings
whose lgb_predictions rows were never generated (LGB cron only scores upcoming
meetings, so the production ensemble path falls back to pure ELO+factor for
every meeting predating Stage 7 v2 rollout — 17 such meetings in May 2026).

Pipeline per target date d (strict no-leakage):
  1. Slice features.csv into train_part = (race_date < d) and target_part = (race_date == d).
  2. Train LGB lambdarank on train_part with val-days split = min(20, 10% of train days).
  3. Fit τ_lgb, τ_elo on val, then α (same protocol as predict_upcoming v2).
  4. Refit on full train_part with frozen best_iter, predict target_part.
  5. lgb_score = log(p_blended); POST to /admin/api/lgb-predictions (handler
     upserts by (race_id, horse_id), so past race_ids are accepted as-is).

After POST: caller (workflow step) MUST hit /api/analyze/hit-rate?date=d&refresh=1
for each date to recompute meeting_hit_rate_cache under the new tx3 cache tag.

This script reuses predict_upcoming.py helpers (per_race_softmax, fit_alpha,
standardize_per_race, etc.) to keep the math identical between live + backfill.
"""
from __future__ import annotations
import argparse, json, sys, math
import numpy as np
import pandas as pd
import lightgbm as lgb
import urllib.request, urllib.error

# Reuse v2 helpers verbatim — exact same train/calibrate path
sys.path.insert(0, '.')
from scripts.backtest.predict_upcoming import (  # type: ignore
    FEAT_COLS, standardize_per_race, per_race_softmax,
    race_log_loss, fit_temperature, fit_alpha, make_graded_label,
)


def train_and_predict_one(
    train_part: pd.DataFrame,
    target_part: pd.DataFrame,
    val_days: int,
    max_iter: int,
    early_stop: int,
    lr: float,
    leaves: int,
    min_leaf: int,
) -> tuple[np.ndarray, dict]:
    """Train LGB on train_part with walk-forward val, fit τ/α, predict target_part.
    Returns (p_blended for target rows, diag dict). Same protocol as predict_upcoming.py
    but with target replacing 'upcoming'."""
    train_part = train_part.sort_values(['race_date', 'race_id']).reset_index(drop=True)
    train_part['race_date'] = pd.to_datetime(train_part['race_date'])

    use_val = val_days > 0
    val_part = None
    if use_val:
        cutoff = train_part['race_date'].max() - pd.Timedelta(days=val_days)
        val_mask = train_part['race_date'] > cutoff
        train_split = train_part[~val_mask].copy()
        val_part = train_part[val_mask].copy()
        if val_part['race_id'].nunique() < 15:
            use_val = False
            train_split = train_part
            val_part = None
    else:
        train_split = train_part

    Xtr = train_split[FEAT_COLS].fillna(-1.0).to_numpy()
    ytr = make_graded_label(train_split)
    grp_tr = train_split.groupby('race_id', sort=False).size().to_numpy()

    params = {
        'objective': 'lambdarank',
        'metric': 'ndcg',
        'ndcg_eval_at': [1, 3, 5],
        'first_metric_only': True,
        'learning_rate': lr,
        'num_leaves': leaves,
        'min_data_in_leaf': min_leaf,
        'verbose': -1,
    }
    diag = {'val_races': 0, 'best_iteration': 200, 'tau_lgb': 1.0, 'tau_elo': 1.0, 'alpha': 1.0,
            'train_rows': int(len(train_part)), 'target_rows': int(len(target_part))}
    tau_lgb = tau_elo = 1.0
    alpha = 1.0

    if use_val:
        Xv = val_part[FEAT_COLS].fillna(-1.0).to_numpy()
        yv = make_graded_label(val_part)
        grp_v = val_part.groupby('race_id', sort=False).size().to_numpy()
        ds_tr = lgb.Dataset(Xtr, label=ytr, group=grp_tr)
        ds_v = lgb.Dataset(Xv, label=yv, group=grp_v, reference=ds_tr)
        booster = lgb.train(
            params, ds_tr, num_boost_round=max_iter,
            valid_sets=[ds_v], valid_names=['val'],
            callbacks=[lgb.early_stopping(early_stop, verbose=False)],
        )
        best_iter = booster.best_iteration or max_iter
        diag['best_iteration'] = int(best_iter)
        diag['val_races'] = int(val_part['race_id'].nunique())

        val_scores = booster.predict(Xv)
        val_rids = val_part['race_id'].to_numpy()
        val_is_top1 = (val_part['finishing_position'] == 1).astype(int).to_numpy()
        val_baseline = standardize_per_race(val_part['baseline_score'].fillna(0).to_numpy(), val_rids)

        tau_lgb = fit_temperature(val_scores, val_rids, val_is_top1)
        tau_elo = fit_temperature(val_baseline, val_rids, val_is_top1)
        p_lgb_val = per_race_softmax(val_scores, val_rids, tau_lgb)
        p_elo_val = per_race_softmax(val_baseline, val_rids, tau_elo)
        alpha = fit_alpha(p_lgb_val, p_elo_val, val_rids, val_is_top1)
        diag.update({'tau_lgb': tau_lgb, 'tau_elo': tau_elo, 'alpha': alpha})

        # Refit on full pre-target data
        Xfull = train_part[FEAT_COLS].fillna(-1.0).to_numpy()
        yfull = make_graded_label(train_part)
        grp_full = train_part.groupby('race_id', sort=False).size().to_numpy()
        booster = lgb.train(params, lgb.Dataset(Xfull, label=yfull, group=grp_full),
                            num_boost_round=int(best_iter))
    else:
        n_round = min(max_iter, 200)
        booster = lgb.train(params, lgb.Dataset(Xtr, label=ytr, group=grp_tr), num_boost_round=n_round)
        diag['best_iteration'] = n_round

    # Predict target
    Xt = target_part[FEAT_COLS].fillna(-1.0).to_numpy()
    t_scores = booster.predict(Xt)
    t_rids = target_part['race_id'].to_numpy()
    t_baseline = standardize_per_race(target_part['baseline_score'].fillna(0).to_numpy(), t_rids)
    p_lgb_t = per_race_softmax(t_scores, t_rids, tau_lgb)
    p_elo_t = per_race_softmax(t_baseline, t_rids, tau_elo)
    p_blended = alpha * p_lgb_t + (1.0 - alpha) * p_elo_t
    return p_blended, diag


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--features', required=True, help='Full history features.csv (incl. target dates).')
    ap.add_argument('--dates', required=True, help='Comma-separated YYYY-MM-DD target dates to backfill.')
    ap.add_argument('--admin-url', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--model-version', default='lgb-backfill-v1')
    ap.add_argument('--val-days', type=int, default=20)
    ap.add_argument('--max-iter', type=int, default=400)
    ap.add_argument('--early-stop', type=int, default=20)
    ap.add_argument('--learning-rate', type=float, default=0.05)
    ap.add_argument('--num-leaves', type=int, default=15)
    ap.add_argument('--min-data-in-leaf', type=int, default=20)
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    print(f'[backfill] loading features={args.features}', flush=True)
    df = pd.read_csv(args.features)
    df['race_date'] = pd.to_datetime(df['race_date']).dt.strftime('%Y-%m-%d')
    print(f'[backfill] total rows={len(df)} races={df["race_id"].nunique()} '
          f'date range {df["race_date"].min()}..{df["race_date"].max()}', flush=True)

    target_dates = [d.strip() for d in args.dates.split(',') if d.strip()]
    print(f'[backfill] {len(target_dates)} target dates: {target_dates}', flush=True)

    overall = {'dates_done': 0, 'dates_skipped': 0, 'total_posted': 0, 'per_date': []}
    for d in target_dates:
        target_part = df[df['race_date'] == d].copy()
        train_part = df[df['race_date'] < d].copy()
        if len(target_part) == 0:
            print(f'[backfill] {d}: SKIP — no rows in features.csv for this date', flush=True)
            overall['dates_skipped'] += 1
            overall['per_date'].append({'date': d, 'status': 'SKIP_NO_TARGET'})
            continue
        if train_part['race_id'].nunique() < 200:
            print(f'[backfill] {d}: SKIP — only {train_part["race_id"].nunique()} train races (need >=200)', flush=True)
            overall['dates_skipped'] += 1
            overall['per_date'].append({'date': d, 'status': 'SKIP_TOO_FEW_TRAIN'})
            continue
        print(f'\n[backfill] === {d}: train={len(train_part)} rows ({train_part["race_id"].nunique()} races), '
              f'target={len(target_part)} rows ({target_part["race_id"].nunique()} races) ===', flush=True)

        try:
            p_blended, diag = train_and_predict_one(
                train_part, target_part, args.val_days, args.max_iter,
                args.early_stop, args.learning_rate, args.num_leaves, args.min_data_in_leaf,
            )
        except Exception as e:
            print(f'[backfill] {d}: TRAIN/PREDICT FAILED — {e}', flush=True)
            overall['dates_skipped'] += 1
            overall['per_date'].append({'date': d, 'status': 'TRAIN_FAIL', 'error': str(e)})
            continue

        eps = 1e-12
        target_part = target_part.copy()
        target_part['lgb_score'] = np.log(np.maximum(p_blended, eps))
        target_part['p_win'] = p_blended

        payload = {
            'predictions': [
                {'raceId': str(r['race_id']), 'horseId': str(r['horse_id']),
                 'lgbScore': float(r['lgb_score']), 'pWin': float(r['p_win'])}
                for _, r in target_part.iterrows()
            ],
            'modelVersion': f"{args.model_version}-{d}",
            'diagnostics': diag,
        }
        print(f'[backfill] {d}: payload {len(payload["predictions"])} predictions · '
              f'α={diag["alpha"]:.3f} τ_lgb={diag["tau_lgb"]:.3f} τ_elo={diag["tau_elo"]:.3f} '
              f'best_iter={diag["best_iteration"]} val_races={diag["val_races"]}', flush=True)

        if args.dry:
            print(json.dumps(payload['predictions'][:3], indent=2))
            overall['dates_done'] += 1
            overall['per_date'].append({'date': d, 'status': 'DRY_OK', 'count': len(payload['predictions'])})
            continue

        try:
            req = urllib.request.Request(
                args.admin_url, data=json.dumps(payload).encode('utf-8'), method='POST',
                headers={'Authorization': f'Bearer {args.token}', 'Content-Type': 'application/json',
                         'User-Agent': 'tianxi-lgb-backfill/1.0 (+github-actions)'},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode('utf-8')
                print(f'[backfill] {d}: POST {resp.status} {body[:200]}', flush=True)
                overall['dates_done'] += 1
                overall['total_posted'] += len(payload['predictions'])
                overall['per_date'].append({'date': d, 'status': 'POSTED', 'count': len(payload['predictions']),
                                            'alpha': diag['alpha'], 'best_iter': diag['best_iteration']})
        except urllib.error.HTTPError as e:
            print(f'[backfill] {d}: POST FAILED {e.code} {e.reason} {e.read().decode("utf-8", "ignore")[:200]}', flush=True)
            overall['dates_skipped'] += 1
            overall['per_date'].append({'date': d, 'status': 'POST_FAIL', 'http': e.code})
        except Exception as e:
            print(f'[backfill] {d}: POST EXCEPTION — {e}', flush=True)
            overall['dates_skipped'] += 1
            overall['per_date'].append({'date': d, 'status': 'POST_EXC', 'error': str(e)})

    print(f'\n[backfill] DONE: {overall["dates_done"]}/{len(target_dates)} dates posted, '
          f'{overall["total_posted"]} predictions, {overall["dates_skipped"]} skipped', flush=True)
    print(json.dumps(overall, indent=2), flush=True)
    return 0 if overall['dates_done'] > 0 else 1


if __name__ == '__main__':
    sys.exit(main())
