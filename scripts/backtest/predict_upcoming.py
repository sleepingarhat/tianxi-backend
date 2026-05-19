#!/usr/bin/env python3
"""
Stage 7: predict LGB scores for upcoming races and POST them to prod.

Inputs:
  --train       features.csv (output of dump-features.ts in default mode)
  --upcoming    upcoming-features.csv (output of dump-features.ts --upcoming-json=...)
  --admin-url   POST endpoint, e.g. https://tianxi.racing/admin/api/lgb-predictions
  --token       admin bearer token (matches Worker env ADMIN_TOKEN)
  --dry         if set, print payload instead of POSTing

Trains a LightGBM lambdarank on the full history and predicts on upcoming entries.
Posts {raceId, horseId, lgbScore, pWin} batches to the admin endpoint.
"""
from __future__ import annotations
import argparse, json, sys, os
import numpy as np
import pandas as pd
import lightgbm as lgb
import urllib.request

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', required=True)
    ap.add_argument('--upcoming', required=True)
    ap.add_argument('--admin-url', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--model-version', default='lgb-lambdarank-v1')
    ap.add_argument('--n-estimators', type=int, default=200)
    ap.add_argument('--num-leaves', type=int, default=15)
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

    # Sort training by race_date so groups are contiguous
    train = train.sort_values(['race_date', 'race_id']).reset_index(drop=True)
    groups = train.groupby('race_id', sort=False).size().values

    # Fill NaN feature cells with 0 (LGB handles NaN natively, but keep parity with backtest)
    Xtr = train[FEAT_COLS].fillna(0).values
    ytr = train['is_top1'].values

    model = lgb.LGBMRanker(
        objective='lambdarank',
        num_leaves=args.num_leaves,
        n_estimators=args.n_estimators,
        learning_rate=0.05,
        min_child_samples=20,
        verbose=-1,
    )
    print('[predict] fitting...', flush=True)
    model.fit(Xtr, ytr, group=groups)

    Xu = upc[FEAT_COLS].fillna(0).values
    upc['lgb_score'] = model.predict(Xu)

    # Per-race softmax → p_win
    def softmax_grp(g: pd.DataFrame) -> pd.Series:
        s = g['lgb_score'].values
        e = np.exp(s - s.max())
        return pd.Series(e / e.sum(), index=g.index)
    upc['p_win'] = upc.groupby('race_id', group_keys=False).apply(softmax_grp)

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
    }
    print(f'[predict] payload: {len(payload["predictions"])} predictions across '
          f'{upc["race_id"].nunique()} races, modelVersion={args.model_version}', flush=True)

    if args.dry:
        print(json.dumps(payload, indent=2)[:2000])
        return 0

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        args.admin_url,
        data=data,
        method='POST',
        headers={
            'Authorization': f'Bearer {args.token}',
            'Content-Type': 'application/json',
            'User-Agent': 'tianxi-lgb-predict/1.0 (+github-actions)',
            'Accept': 'application/json',
        },
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
