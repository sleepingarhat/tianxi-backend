#!/usr/bin/env python3
"""scripts/backtest/lgb_walkforward.py

Walk-forward LightGBM ranker on per-runner features.

Reads the CSV produced by dump-features.ts. For every race in chronological
order (after a warm-up of --min-train-races), trains LGBM-LambdaRank on all
prior races' rows, scores the current race's runners, and takes the argmax
as the predicted Top-1. Compares hit rates against:
  * the existing ELO+factor baseline (baseline_score column)
  * the market favourite (lowest win_odds)

To keep cost bounded the model is retrained every --retrain-every-races
races; in between, the previous booster scores incoming races.

Usage:
    python scripts/backtest/lgb_walkforward.py \
        --features features.csv \
        --out results.json \
        --min-train-races 200 \
        --retrain-every-races 50
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb


FEATURE_COLS = [
      "h_elo", "j_elo", "t_elo", "days_since_last",
      "distance", "draw", "actual_weight", "field_size",
      "dist_starts", "dist_top3", "going_starts", "going_top3",
      "draw_starts", "draw_top3", "combo_starts", "combo_top3",
      "weight_avg5",
      # raw factor parts that the baseline already encodes — keeping them
      # lets the GBM learn non-linear interactions the additive baseline misses.
      "factor_bonus",
      # Stage 4c: recency-weighted form (per horse, last 5 starts)
      "form_n", "form_avgpos_w", "form_top3rate_w", "form_pos_slope",
      # Stage 4c: cross-features (interaction history, no odds)
      "tv_starts", "tv_top3",     # trainer × venue
      "jv_starts", "jv_top3",     # jockey × venue
      "jdb_starts", "jdb_top3",   # jockey × distance band
        # Stage 5: track-condition specialization
        "jg_starts", "jg_top3",     # jockey × going
        "tg_starts", "tg_top3",     # trainer × going
      # going_code is appended below as a categorical feature.
  ]


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--features", required=True, help="CSV from dump-features.ts")
    ap.add_argument("--out", required=True, help="Output JSON path")
    ap.add_argument("--min-train-races", type=int, default=200,
                    help="Skip evaluation until this many races have happened")
    ap.add_argument("--retrain-every-races", type=int, default=50,
                    help="Retrain frequency (races)")
    ap.add_argument("--num-leaves", type=int, default=15)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--n-estimators", type=int, default=200)
    ap.add_argument("--min-data-in-leaf", type=int, default=20)
    ap.add_argument("--objective", choices=["lambdarank", "binary"], default="lambdarank",
                    help="lambdarank uses position as ranking label; "
                         "binary uses is_top1 with race-grouping ignored")
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args()


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    # Categorical going (rare values bucketed)
    df["going"] = df["going"].fillna("UNKNOWN").astype(str)
    df["going_code"] = pd.Categorical(df["going"]).codes.astype(int)

    # Sort: chronological day, then by race_id so groups are contiguous.
    df = df.sort_values(["race_date", "race_id"]).reset_index(drop=True)

    # Coerce numerics + sentinel for missing.
    for c in FEATURE_COLS:
        if c not in df.columns:
            raise SystemExit(f"missing column in features CSV: {c}")
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def train_booster(train_df: pd.DataFrame, args: argparse.Namespace, feat_cols: list[str]) -> lgb.Booster:
    X = train_df[feat_cols].astype(float).fillna(-1.0).to_numpy()
    if args.objective == "lambdarank":
        # higher label = better. Flip finishing_position so winner has highest.
        max_pos = int(train_df["finishing_position"].max())
        label = (max_pos - train_df["finishing_position"]).clip(lower=0).astype(int).to_numpy()
        groups = train_df.groupby("race_id", sort=False).size().to_numpy()
        ds = lgb.Dataset(X, label=label, group=groups,
                         categorical_feature=[feat_cols.index("going_code")])
        params = {
            "objective": "lambdarank",
            "metric": "ndcg",
            "ndcg_eval_at": [1, 3],
            "learning_rate": args.learning_rate,
            "num_leaves": args.num_leaves,
            "min_data_in_leaf": args.min_data_in_leaf,
            "verbose": -1,
        }
    else:
        label = train_df["is_top1"].astype(int).to_numpy()
        ds = lgb.Dataset(X, label=label,
                         categorical_feature=[feat_cols.index("going_code")])
        params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "learning_rate": args.learning_rate,
            "num_leaves": args.num_leaves,
            "min_data_in_leaf": args.min_data_in_leaf,
            "is_unbalance": True,
            "verbose": -1,
        }
    return lgb.train(params, ds, num_boost_round=args.n_estimators)


def main() -> int:
    args = parse_args()
    df = load(args.features)
    feat_cols = FEATURE_COLS + ["going_code"]

    race_ids = list(dict.fromkeys(df["race_id"].tolist()))
    print(f"[lgb-wf] {len(df):,} runner-rows across {len(race_ids):,} races "
          f"({df['race_date'].min()}..{df['race_date'].max()})", file=sys.stderr)

    race_to_rows = {rid: g for rid, g in df.groupby("race_id", sort=False)}

    booster: lgb.Booster | None = None
    last_trained_at = -10**9
    per_race: list[dict] = []

    for i, rid in enumerate(race_ids):
        test_df = race_to_rows[rid]
        if len(test_df) < 4:
            continue
        if i < args.min_train_races:
            continue

        if booster is None or (i - last_trained_at) >= args.retrain_every_races:
            train_mask = df["race_id"].isin(race_ids[:i])
            train_df = df[train_mask]
            if len(train_df) < 200:
                continue
            booster = train_booster(train_df, args, feat_cols)
            last_trained_at = i
            if args.verbose:
                print(f"  [retrain @ race {i}] {len(train_df):,} rows", file=sys.stderr)

        Xt = test_df[feat_cols].astype(float).fillna(-1.0).to_numpy()
        scores = booster.predict(Xt)
        ta = test_df.reset_index(drop=True)

        actual_top1 = ta.loc[ta["finishing_position"].idxmin(), "horse_id"]
        actual_top2 = set(ta.nsmallest(2, "finishing_position")["horse_id"].tolist())
        actual_top3 = set(ta.nsmallest(3, "finishing_position")["horse_id"].tolist())
        actual_top4 = set(ta.nsmallest(4, "finishing_position")["horse_id"].tolist())

        order = np.argsort(-scores)
        lgb_ranked = ta.iloc[order]["horse_id"].tolist()
        lgb_top1 = lgb_ranked[0]
        lgb_top2_set = set(lgb_ranked[:2])
        lgb_top3_set = set(lgb_ranked[:3])
        lgb_top4_set = set(lgb_ranked[:min(4, len(lgb_ranked))])

        # ELO+factor baseline pick (highest baseline_score)
        bs = pd.to_numeric(ta["baseline_score"], errors="coerce")
        elo_top1 = ta.loc[bs.idxmax(), "horse_id"] if bs.notna().any() else None

        # Market favourite (lowest positive win_odds)
        odds = pd.to_numeric(ta["win_odds"], errors="coerce")
        odds_valid = ta[odds > 0]
        market_top1 = (
            odds_valid.loc[odds_valid["win_odds"].astype(float).idxmin(), "horse_id"]
            if len(odds_valid) >= 3 else None
        )

        per_race.append({
            "race_id": str(rid),
            "date": str(ta["race_date"].iloc[0]),
            "field_size": int(len(ta)),
            "lgb_top1_hit": bool(lgb_top1 == actual_top1),
            "lgb_top2_hit": bool(bool(lgb_top2_set & actual_top2)),
            "lgb_top3_hit": bool(bool(lgb_top3_set & actual_top3)),
            "lgb_top4_hit": bool(bool(lgb_top4_set & actual_top4)),
            "elo_top1_hit": None if elo_top1 is None else bool(elo_top1 == actual_top1),
            "elo_top3_hit": None if elo_top1 is None else bool(elo_top1 in actual_top3),
            "market_top1_hit": None if market_top1 is None else bool(market_top1 == actual_top1),
        })

        if args.verbose and (i + 1) % 200 == 0:
            print(f"  [{i + 1}/{len(race_ids)}] evaluated", file=sys.stderr)

    rdf = pd.DataFrame(per_race)

    def rate(col: str) -> float | None:
        if col not in rdf.columns or len(rdf) == 0:
            return None
        s = rdf[col].dropna()
        return float(s.mean()) if len(s) else None

    summary = {
        "n_races_evaluated": int(len(rdf)),
        "date_range": (
            [str(rdf["date"].min()), str(rdf["date"].max())] if len(rdf) else None
        ),
        "metrics": {
            "lgb_top1_hit_rate":    rate("lgb_top1_hit"),
            "lgb_top2_hit_rate":    rate("lgb_top2_hit"),
            "lgb_top3_hit_rate":    rate("lgb_top3_hit"),
            "lgb_top4_hit_rate":    rate("lgb_top4_hit"),
            "elo_top1_hit_rate":    rate("elo_top1_hit"),
            "elo_top3_hit_rate":    rate("elo_top3_hit"),
            "market_top1_hit_rate": rate("market_top1_hit"),
        },
        "profitability": profitability,
        "feature_importance_gain": (
            dict(zip(feat_cols,
                     booster.feature_importance(importance_type="gain").tolist()))
            if booster is not None else {}
        ),
        "config": {
            "objective": args.objective,
            "min_train_races": args.min_train_races,
            "retrain_every_races": args.retrain_every_races,
            "num_leaves": args.num_leaves,
            "n_estimators": args.n_estimators,
            "learning_rate": args.learning_rate,
            "min_data_in_leaf": args.min_data_in_leaf,
        },
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(
        {"summary": summary, "per_race": per_race}, indent=2, default=str))

    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
