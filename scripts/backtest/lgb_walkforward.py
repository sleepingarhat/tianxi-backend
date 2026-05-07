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
    ap.add_argument("--dividends", required=False, default=None,
                    help="Dividends CSV (race_id,pool_type,combination,dividend) for ROI eval")
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
        actual_top3 = set(ta.nsmallest(3, "finishing_position")["horse_id"].tolist())

        lgb_top1 = ta.iloc[int(np.argmax(scores))]["horse_id"]

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
            "lgb_top3_hit": bool(lgb_top1 in actual_top3),
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

    # ── Stage C: profitability — simulate $10 bets, lookup actual dividends ──
    profitability: dict = {}
    if args.dividends:
        from itertools import combinations
        ddf = pd.read_csv(args.dividends, dtype={"race_id": str, "pool_type": str, "combination": str})
        ddf["dividend"] = pd.to_numeric(ddf["dividend"], errors="coerce")
        # Lookup: (race_id, pool_type) -> list of (frozenset of horse_numbers, dividend)
        div_by_race_pool: dict[tuple[str, str], list[tuple[frozenset, float]]] = {}
        for row in ddf.itertuples(index=False):
            if not row.combination or pd.isna(row.dividend):
                continue
            try:
                nums = frozenset(int(x.strip()) for x in str(row.combination).split(",") if x.strip())
            except ValueError:
                continue
            if not nums:
                continue
            div_by_race_pool.setdefault((str(row.race_id), str(row.pool_type)), []).append((nums, float(row.dividend)))

        # Build race -> ranked horse_number list from per-race scores we already have.
        # We need to re-score; cheaper: re-run the eval passes but reuse the booster sequence.
        # Simplest: do a second pass over race_ids, retraining identically and scoring.
        # To avoid retraining cost, we cache (rid -> ranked horse_numbers) inline below.
        # NOTE: ranked list was not stored in per_race; we recompute by re-running the loop.
        # To keep this lightweight + deterministic, we use the SAME retrain schedule.

        def settle(race_id: str, pool: str, picks: list[int], k: int) -> tuple[float, float]:
            """Box-bet: every C(len(picks), k) combination of `picks`. Returns (stake, payout)."""
            if len(picks) < k:
                return (0.0, 0.0)
            combos = list(combinations(picks, k))
            stake = 10.0 * len(combos)
            entries = div_by_race_pool.get((race_id, pool), [])
            payout = 0.0
            for combo in combos:
                cset = frozenset(combo)
                for win_set, div in entries:
                    if win_set == cset:
                        payout += div  # dividend is per $10 bet; we staked $10 per combo
                        break
            return (stake, payout)

        bet_results: dict[str, dict[str, float]] = {}
        def acc(name: str, stake: float, payout: float):
            d = bet_results.setdefault(name, {"races": 0, "stake": 0.0, "payout": 0.0, "wins": 0})
            if stake > 0:
                d["races"] += 1
                d["stake"] += stake
                d["payout"] += payout
                if payout > 0:
                    d["wins"] += 1

        # Re-score (replays the same retrain schedule deterministically).
        booster2: lgb.Booster | None = None
        last_trained_at2 = -10**9
        for i, rid in enumerate(race_ids):
            test_df = race_to_rows[rid]
            if len(test_df) < 4:
                continue
            if i < args.min_train_races:
                continue
            if booster2 is None or (i - last_trained_at2) >= args.retrain_every_races:
                train_mask = df["race_id"].isin(race_ids[:i])
                train_df = df[train_mask]
                if len(train_df) < 200:
                    continue
                booster2 = train_booster(train_df, args, feat_cols)
                last_trained_at2 = i
            Xt = test_df[feat_cols].astype(float).fillna(-1.0).to_numpy()
            scores = booster2.predict(Xt)
            ta = test_df.reset_index(drop=True)
            order = np.argsort(-scores)
            ranked_nums = pd.to_numeric(ta.iloc[order]["horse_number"], errors="coerce").dropna().astype(int).tolist()
            if not ranked_nums:
                continue
            top1 = ranked_nums[:1]; top2 = ranked_nums[:2]; top3 = ranked_nums[:3]
            top4 = ranked_nums[:4]; top5 = ranked_nums[:5]; top6 = ranked_nums[:6]
            rid_s = str(rid)
            # WIN model top 1
            s, p = settle(rid_s, "WIN", top1, 1); acc("WIN_top1", s, p)
            # PLA model top 1 (single-horse place bet)
            s, p = settle(rid_s, "PLA", top1, 1); acc("PLA_top1", s, p)
            # QIN model top 1+2
            s, p = settle(rid_s, "QIN", top2, 2); acc("QIN_top2", s, p)
            # QPL model top 1+2 (place quinella, lower threshold)
            s, p = settle(rid_s, "QPL", top2, 2); acc("QPL_top2", s, p)
            # TRI box on model top 3 (1 combo) and top 4 (4 combos)
            s, p = settle(rid_s, "TRI", top3, 3); acc("TRI_box3", s, p)
            s, p = settle(rid_s, "TRI", top4, 3); acc("TRI_box4", s, p)
            # FF box on model top 4 (1 combo), top 5 (5 combos), top 6 (15 combos)
            s, p = settle(rid_s, "FF", top4, 4); acc("FF_box4", s, p)
            s, p = settle(rid_s, "FF", top5, 4); acc("FF_box5", s, p)
            s, p = settle(rid_s, "FF", top6, 4); acc("FF_box6", s, p)

        for name, d in bet_results.items():
            stake = d["stake"]; payout = d["payout"]; n = d["races"]; w = d["wins"]
            profitability[name] = {
                "races_bet": int(n),
                "total_stake": round(stake, 2),
                "total_payout": round(payout, 2),
                "net_pnl": round(payout - stake, 2),
                "roi": round((payout - stake) / stake, 4) if stake > 0 else None,
                "hit_rate": round(w / n, 4) if n > 0 else None,
                "avg_payout_when_hit": round(payout / w, 2) if w > 0 else None,
            }

    summary = {
        "n_races_evaluated": int(len(rdf)),
        "date_range": (
            [str(rdf["date"].min()), str(rdf["date"].max())] if len(rdf) else None
        ),
        "metrics": {
            "lgb_top1_hit_rate":    rate("lgb_top1_hit"),
            "lgb_top3_hit_rate":    rate("lgb_top3_hit"),
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
