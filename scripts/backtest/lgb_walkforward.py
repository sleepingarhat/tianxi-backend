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
import math
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb

import pl_calibration as pl  # Phase-1 PL/Henery calibration head (eval-only)

# ── PL/Henery calibration head config (eval-only; prod untouched) ──
# A monotone transform of the single LGB score → top-N selection and realized
# box coverage/ROI are UNCHANGED (architect-confirmed). This block measures
# probability CALIBRATION only. τ/γ are fit LEAK-SAFE on a trailing window of
# already-evaluated (out-of-fold) races, frozen for future test races.
CALIB_MIN_OOF = 150        # warm-up: OOF races before calibrator activates
CALIB_REFIT_EVERY = 50     # refit τ/γ every N evaluated races
CALIB_WINDOW_MAX = 800     # trailing OOF window cap (bounds cost, stays current)
CALIB_MAXPOS = 4           # fit γ2..γ4 (Henery exponents for positions 2..4)
_HARVILLE = [1.0, 1.0, 1.0, 1.0]


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
      # Stage 6 (NEW): pace style + race-level pace clash
      "horse_pace_n", "horse_pace_early", "horse_pace_style",
      "race_n_leaders", "race_n_closers", "horse_pace_clash",
      # Stage 6 (NEW): class change
      "class_now_num", "last_class_num", "class_delta",
      # Stage 8 (NEW v3.2 2026-05-25): real sectional aggregates + distance bands
      # See predict_upcoming.py FEAT_COLS comment for rationale. beaten_lengths
      # excluded — it's a future regression-head label, not a feature.
      "sect_n", "sect_early_avg", "sect_late_kick",
      # ⑥ sectional-SPEED z (sect_early_z / sect_fin_z — first/final section TIME
      # z-scored within each PAST race's field, leak-safe; -9 sentinel=no data) is
      # DORMANT: two walk-forward A/B pairs (1299 races, 2024-11→2026-04) gave a
      # NON-reproducible result — at retrain=50 top1 +0.62 / top3 +0.31, but at
      # retrain=25 the signs FLIPPED to top1 -0.23 / top3 -0.77 (all within ~1 SE
      # ≈1.15pp; only top4 consistently up +0.23/+0.92). High importance (~830/799)
      # but NO robust hit-rate lift → NOT promoted to predict_upcoming.py. Columns
      # still emitted by dump-features.ts (leak-safe, free) — re-add the two names
      # here to re-test. (4th pure-feature non-win after ①試閘 / ③場內相對 / ⑤gear.)
      "is_sprint", "is_middle", "is_distance",
      "draw_x_sprint", "paceclash_x_distance",
      # Stage 10 (NEW v3.2 ④ pedigree): leak-safe target-encoded breeding signal.
      # Smoothed progeny top3-rate as-of race date (sire general / sire at this
      # distance band / damsire). Missing pedigree → -1.0 sentinel via fillna.
      "sire_top3_sm", "sire_dist_top3_sm", "damsire_top3_sm",
      # Stage 13 (⑦ hard-luck): comment-derived trouble signal (recency-weighted
      # A受阻 + B走大疊 + C出閘失準 over last 8 starts; cmt_n=depth (0=none), frac=-1)
      # is DORMANT: double-confirmed walk-forward A/B (1299 races, 2024-11→2026-04)
      # REGRESSED the headline top1 at BOTH cadences (retrain=50 -0.08 / retrain=25
      # -0.15); top2/top3 were mildly positive (+1.08/+1.54 and +0.92/+0.69) but all
      # sub-noise (SE≈1.15pp) and top4 flipped (-0.54/+0.46). High importance
      # (cmt_wide gain ~952) but NO robust top1 lift → NOT promoted to
      # predict_upcoming.py. Columns still emitted by dump-features.ts (94.7%
      # coverage, leak-safe, free) — re-add the four names here to re-test in a
      # future interaction. (5th feature non-win after ①試閘/③場內相對/⑤gear/⑥sect-z;
      # a genuinely-NEW signal that still cannot beat ELO+form+pedigree saturation.)
      # "cmt_n", "cmt_trouble", "cmt_wide", "cmt_badstart",
      # ⑤ gear/equipment-change (gear_first_n/off_n/changed/blinkers) is DORMANT:
      # walk-forward A/B (1299 races, 2024-11→2026-04) regressed top1 -0.15 /
      # top2 -0.85 / top3 -0.39pp (only top4 +0.46). Columns still emitted by
      # dump-features.ts (leak-safe, free) — re-add the names here to re-test a
      # future interaction, but do NOT promote to predict_upcoming.py without a
      # walk-forward lift. (Same verdict as ①試閘 / ③場內相對.)
      # ⑴ MARKET ODDS ("有賠率" parallel model ONLY — the no-odds model excludes
      # these 4 via --exclude to stay byte-identical). Derived in load() from
      # win_odds (SP, known at race-off → leak-safe pre-race feature).
      "implied_prob", "implied_prob_norm", "log_win_odds", "market_rank",
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
    ap.add_argument("--exclude", default="",
                    help="comma-separated FEATURE_COLS to drop (A/B ablation control)")
    ap.add_argument("--db", default="bulk-local.db",
                    help="sqlite DB holding the dividends table for box-bet ROI "
                         "(same DB dump-features.ts reads); missing -> ROI disabled")
    return ap.parse_args()


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    # Categorical going (rare values bucketed)
    df["going"] = df["going"].fillna("UNKNOWN").astype(str)
    df["going_code"] = pd.Categorical(df["going"]).codes.astype(int)

    # Sort: chronological day, then by race_id so groups are contiguous.
    df = df.sort_values(["race_date", "race_id"]).reset_index(drop=True)

    # ⑴ Market-odds features (for the "有賠率" model). Derived from win_odds (SP).
    # Invalid/missing odds -> NaN (LightGBM-native; eval loop fills -1.0 sentinel).
    _o = pd.to_numeric(df["win_odds"], errors="coerce")
    _o = _o.where(_o > 0)
    df["implied_prob"] = 1.0 / _o
    df["log_win_odds"] = np.log(_o)
    df["_o_tmp"] = _o
    _g = df.groupby("race_id")
    df["market_rank"] = _g["_o_tmp"].rank(method="min", ascending=True)
    df["implied_prob_norm"] = df["implied_prob"] / _g["implied_prob"].transform("sum")
    df = df.drop(columns=["_o_tmp"])

    # Coerce numerics + sentinel for missing.
    for c in FEATURE_COLS:
        if c not in df.columns:
            raise SystemExit(f"missing column in features CSV: {c}")
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def train_booster(train_df: pd.DataFrame, args: argparse.Namespace, feat_cols: list[str]) -> lgb.Booster:
    X = train_df[feat_cols].astype(float).fillna(-1.0).to_numpy()
    if args.objective == "lambdarank":
        # higher label = better. Clipped to top-5 grades (0..4) to align with
        # label_gain=[0,1,7,31,127] and lambdarank_truncation_level=4.
        # FIX 2026-05-27: see predict_upcoming.py make_graded_label for full
        # rationale. Old `max_pos - pos` produced labels 0..13 → label_gain
        # saturated 127 for labels 4-13 → 1-tree saturation. Mapping:
        # 1st→4, 2nd→3, 3rd→2, 4th→1, 5th+→0. Mirror of predict_upcoming.py
        # so backtest reflects production training signal.
        pos = train_df["finishing_position"].astype(int).clip(lower=1, upper=5)
        label = (5 - pos).clip(lower=0).astype(int).to_numpy()
        groups = train_df.groupby("race_id", sort=False).size().to_numpy()
        ds = lgb.Dataset(X, label=label, group=groups,
                         categorical_feature=[feat_cols.index("going_code")])
        params = {
            "objective": "lambdarank",
            "metric": "ndcg",
            "ndcg_eval_at": [1, 3],
            # 2026-05-25 (v3.1): truncate gradient to top-4 + exponential gains
            # to focus learning on positions that decide trio/tierce/QP.
            # Must mirror predict_upcoming.py so backtest reflects production.
            "lambdarank_truncation_level": 4,
            "label_gain": [0, 1, 7, 31, 127, 127, 127, 127, 127, 127, 127, 127,
                           127, 127, 127, 127, 127, 127, 127, 127],
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


def rank_metrics(ranked, actual_top1, actual_top3, actual_top4):
    # Box-coverage + place-rate metrics for ONE race given a model ranked
    # horse_id list (best first). None when ranking unavailable or the actual
    # placed set is incomplete (abandoned / short field). Box coverage is the
    # product north-star (see replit.md / tx-betting-objective):
    #   trio_nN   = P(actual top-3 within predicted top-N)   -> 三重彩 / 三T box
    #   first4_nN = P(actual top-4 within predicted top-N)   -> 四重彩 box
    #   qp_nN     = P(>=2 of actual top-3 within pred top-N) -> 位置Q / 連贏
    #   place_in_topK = fraction of the 4 picks that finished top-K -> 入名率
    keys = ("top1_hit", "top3_hit", "trio_n4", "trio_n5", "trio_n6",
            "first4_n4", "first4_n5", "first4_n6", "qp_n4", "qp_n5", "qp_n6",
            "place_in_top3", "place_in_top4")
    if not ranked:
        return {k: None for k in keys}
    out = {}
    out["top1_hit"] = bool(ranked[0] == actual_top1) if actual_top1 else None
    out["top3_hit"] = (bool(ranked[0] in actual_top3)
                       if len(actual_top3) == 3 else None)
    for N in (4, 5, 6):
        s = set(ranked[:N])
        out["trio_n%d" % N] = (bool(actual_top3.issubset(s))
                               if len(actual_top3) == 3 else None)
        out["first4_n%d" % N] = (bool(actual_top4.issubset(s))
                                 if len(actual_top4) == 4 else None)
        out["qp_n%d" % N] = (bool(len(s & actual_top3) >= 2)
                             if len(actual_top3) == 3 else None)
    s4 = set(ranked[:4])
    out["place_in_top3"] = (len(s4 & actual_top3) / 4.0
                            if len(actual_top3) == 3 else None)
    out["place_in_top4"] = (len(s4 & actual_top4) / 4.0
                            if len(actual_top4) == 4 else None)
    return out


# ── Box-bet ROI (北極星: 入名率/箱形派彩, not top1). Mirrors the per-race box
# payout in src/routes/analyze.ts but aggregated across the whole walk-forward so
# model variants are judged by money won, not only coverage%. EVAL-ONLY: no train
# / param change, so predict_upcoming.py needs NO mirror.
BOX_POOLS = [
    # (code, label, units, cost, win_key). units = #($10) combinations when boxing
    # 4 horses; a box wins iff the actual placed set is covered by our top-4, so the
    # exact-order pools (TCE/TRI/QTT) reuse the unordered trio/ff win flag.
    # POOL CODES follow the dividends-TABLE convention (import-csv.ts normalizePool):
    #   四連環(任序首4)=FF, 單T(任序首3)=TCE, 三重彩(依序首3)=TRI, 四重彩(依序首4)=QTT.
    # NOTE analyze.ts LIVE HKJC scrape uses the OPPOSITE TRI/TCE labels - we read
    # the dividends table here, so we MUST use the table convention or 單T/三重彩 swap.
    ("FF",  "四連環(任序首4)", 1,  10,  "ff"),
    ("TCE", "單T(任序首3)",   4,  40,  "trio"),
    ("TRI", "三重彩(依序首3)", 24, 240, "trio"),
    ("QTT", "四重彩(依序首4)", 24, 240, "ff"),
]
_BOX_CODES = tuple(p[0] for p in BOX_POOLS)
# QIN(連贏) is an EVAL-ONLY banker-wheel/parlay pool (NOT in BOX_POOLS, so box_roi
# stays untouched); we still store its per-race dividend alongside the box ones.
_DIV_CODES = _BOX_CODES + ("QIN",)


def load_dividends(db_path: str) -> dict:
    """race_id -> {pool_code: dividend}, straight from the bulk-local.db `dividends`
    table (the same DB dump-features.ts reads). MAX() collapses the rare dead-heat
    multi-combo rows. Returns {} (box-ROI silently disabled) when the DB/table is
    absent so a CSV-only local run still works."""
    if not Path(db_path).exists():
        print(f"[lgb-wf] WARN: --db {db_path} not found -> box-bet ROI disabled", file=sys.stderr)
        return {}
    try:
        con = sqlite3.connect(db_path)
        rows = con.execute(
            "SELECT race_id, pool_type, MAX(dividend) FROM dividends "
            "WHERE pool_type IN ('FF','TCE','TRI','QTT','QIN') AND dividend IS NOT NULL "
            "GROUP BY race_id, pool_type").fetchall()
        con.close()
    except Exception as e:
        print(f"[lgb-wf] WARN: dividends load failed ({e}) -> box-ROI disabled", file=sys.stderr)
        return {}
    out: dict = {}
    sums: dict = {}
    for rid, pool, div in rows:
        out.setdefault(str(rid), {})[str(pool)] = float(div)
        s = sums.setdefault(str(pool), [0, 0.0])
        s[0] += 1
        s[1] += float(div)
    # Sanity: 三重彩(TRI, exact-order) must pay FAR more than 單T(TCE, any-order);
    # if this prints reversed the table pool-code convention has changed.
    summ = {p: (n, round(t / n, 1) if n else None) for p, (n, t) in sums.items()}
    print(f"[lgb-wf] dividends for {len(out):,} races; per-pool (n, mean$): {summ}", file=sys.stderr)
    return out


def box_roi(records: list[dict]) -> dict:
    """Realised P&L of boxing each source's top-4 into each pool EVERY race.
    Stake = units*$10/race; return = the pool dividend on a win. A winning box with
    a missing dividend is dropped from BOTH stake and return for that pool (kept
    unbiased) and counted in wins_nodiv. '_ALL' = box all four pools every race."""
    res: dict = {}
    for src in ("lgb", "elo", "market"):
        acc = {c: dict(bets=0, wins=0, wins_nodiv=0, stake=0.0, ret=0.0) for c in _BOX_CODES}
        for r in records:
            top6 = r.get("%s_top6" % src)
            if not top6:
                continue
            top4 = set(top6[:4])
            ao = r.get("actual_order6") or []
            a3, a4 = set(ao[:3]), set(ao[:4])
            trio_ok = len(a3) == 3 and a3.issubset(top4)
            ff_ok = len(a4) == 4 and a4.issubset(top4)
            divs = r.get("box_divs") or {}
            for code, _label, _units, cost, wk in BOX_POOLS:
                settleable = (len(a3) == 3) if wk == "trio" else (len(a4) == 4)
                if not settleable:
                    continue
                amt = divs.get(code)
                win = trio_ok if wk == "trio" else ff_ok
                a = acc[code]
                if amt is None:
                    # dividend unavailable for this race/pool -> NOT scoreable for
                    # ANY source (winner OR loser) so per-pool denominators stay
                    # identical across lgb/elo/market. Track would-be wins only.
                    if win:
                        a["wins_nodiv"] += 1
                    continue
                a["bets"] += 1
                a["stake"] += cost
                if win:
                    a["wins"] += 1
                    a["ret"] += amt
        out: dict = {}
        tot = dict(bets=0, wins=0, stake=0.0, ret=0.0)
        for code, label, units, cost, _wk in BOX_POOLS:
            a = acc[code]
            net = a["ret"] - a["stake"]
            out[code] = dict(
                label=label, units=units, cost_per_race=cost,
                bets=a["bets"], wins=a["wins"], wins_nodiv=a["wins_nodiv"],
                hit_rate=(a["wins"] / a["bets"] if a["bets"] else None),
                stake=round(a["stake"], 1), ret=round(a["ret"], 1), net=round(net, 1),
                roi_pct=(round(100 * net / a["stake"], 2) if a["stake"] else None),
                avg_win_div=(round(a["ret"] / a["wins"], 1) if a["wins"] else None))
            tot["bets"] += a["bets"]
            tot["wins"] += a["wins"]
            tot["stake"] += a["stake"]
            tot["ret"] += a["ret"]
        net = tot["ret"] - tot["stake"]
        out["_ALL"] = dict(
            label="四式全打/場", bets=tot["bets"], wins=tot["wins"],
            stake=round(tot["stake"], 1), ret=round(tot["ret"], 1), net=round(net, 1),
            roi_pct=(round(100 * net / tot["stake"], 2) if tot["stake"] else None))
        res[src] = out
    return res


# ───────── QIN(連贏) banker-wheel + 過關 (EVAL-ONLY) ─────────
# No training / param change. 連贏 has a SINGLE winning combination per race =
# the actual (1st,2nd) pair, and that dividend is complete in the source CSVs
# (unlike 位置/位置Q which only store the winner / the (1,2)-pair), so QIN is the
# only quinella/place-family pool we can score honestly. Win-determination needs
# NO 馬號 mapping: records carry actual_order6 and {src}_top6 as horse_ids, and a
# held pair wins iff it equals the actual top-2 set.
_QIN_SRCS = ("lgb", "elo", "market")


def _qin_eligible(rec: dict) -> bool:
    """A race is QIN-comparable iff the (1st,2nd) pair, its dividend, race_no and a
    top-4 for EVERY source are present. Requiring all sources keeps the denominators
    identical across lgb/elo/market (clean money comparison)."""
    ao = rec.get("actual_order6") or []
    if len(ao) < 2 or ao[0] == ao[1]:
        return False
    if rec.get("race_no") is None:
        return False
    if (rec.get("box_divs") or {}).get("QIN") is None:
        return False
    for src in _QIN_SRCS:
        top = rec.get(src + "_top6")
        if not top or len(top) < 4:
            return False
    return True


def _qin_hit(rec: dict, src: str) -> bool:
    """Banker(top1) wheels with partners(top2..4): wins iff the banker is in the
    actual top-2 AND the other top-2 horse is one of the 3 partners."""
    top = rec[src + "_top6"]
    banker, partners = top[0], set(top[1:4])
    top2 = set(rec["actual_order6"][:2])
    if banker not in top2:
        return False
    other = top2 - {banker}
    return len(other) == 1 and next(iter(other)) in partners


def qin_wheel_roi(records, min_field=None) -> dict:
    """連贏拖式: banker(首選) 拖 #2/#3/#4 = 3 注 x $10 = $30/場.
    命中派彩 = 該場連贏賠率(每 $10)."""
    elig = [r for r in records
            if _qin_eligible(r) and (min_field is None or r["field_size"] >= min_field)]
    out = {"n_races": len(elig), "units": 3, "cost_per_race": 30}
    for src in _QIN_SRCS:
        bets = len(elig)
        wins = stake = ret = 0.0
        for r in elig:
            stake += 30.0
            if _qin_hit(r, src):
                wins += 1
                ret += r["box_divs"]["QIN"]
        net = ret - stake
        out[src] = dict(
            bets=int(bets), wins=int(wins),
            hit_rate=(round(wins / bets, 4) if bets else None),
            stake=round(stake, 1), ret=round(ret, 1), net=round(net, 1),
            roi_pct=(round(100 * net / stake, 2) if stake else None),
            avg_win_div=(round(ret / wins, 1) if wins else None))
    return out


def qin_parlay_roi(records, legs, min_field=None) -> dict:
    """連贏過關 (legs 關): each leg = the QIN banker-wheel for one race. Buys the
    full cross-product of held combos = 3**legs lines x $10. At most ONE line can win
    (each leg has a single true QIN pair); if EVERY leg's wheel hits, the winning line
    rolls over = product(qin_div) / 10**(legs-1). Windows = same-day races with
    CONSECUTIVE race_no, sliding (R1-R2, R2-R3, ...). Windows are defined by
    eligibility (all-source) so denominators are identical across sources."""
    by_date = {}
    for r in records:
        if _qin_eligible(r) and (min_field is None or r["field_size"] >= min_field):
            by_date.setdefault(r["date"], {})[r["race_no"]] = r
    n_lines = 3 ** legs
    line_cost = 10.0
    out = {"legs": legs, "lines": n_lines, "cost_per_window": n_lines * line_cost}
    n_windows = 0
    for byno in by_date.values():
        for start in byno:
            if all((start + k) in byno for k in range(legs)):
                n_windows += 1
    out["n_windows"] = n_windows
    for src in _QIN_SRCS:
        windows = wins = stake = ret = 0.0
        for byno in by_date.values():
            for start in sorted(byno):
                legs_recs = [byno.get(start + k) for k in range(legs)]
                if any(x is None for x in legs_recs):
                    continue
                windows += 1
                stake += n_lines * line_cost
                if all(_qin_hit(x, src) for x in legs_recs):
                    wins += 1
                    payout = 1.0
                    for x in legs_recs:
                        payout *= x["box_divs"]["QIN"]
                    ret += payout / (10 ** (legs - 1))
        net = ret - stake
        out[src] = dict(
            windows=int(windows), wins=int(wins),
            hit_rate=(round(wins / windows, 4) if windows else None),
            stake=round(stake, 1), ret=round(ret, 1), net=round(net, 1),
            roi_pct=(round(100 * net / stake, 2) if stake else None),
            avg_win_payout=(round(ret / wins, 1) if wins else None))
    return out


def _calibration_report(rows, races, n_mismatch, tau, gamma, n_oof_final) -> dict:
    """Assemble the Phase-1 calibration report from the eval-only accumulators."""
    if not rows:
        return {"_status": "insufficient_oof",
                "note": "calibrator never warmed up (need >= %d OOF races)" % CALIB_MIN_OOF}
    A = np.asarray(rows, dtype=float)
    pw, ywin, p3h, p3e, p4h, p4e, y3, y4 = (A[:, j] for j in range(8))

    def cal(p, y):
        return {"brier": round(pl.brier(p, y), 5),
                "ece": round(pl.ece(p, y), 5),
                "logloss": round(pl.binary_logloss(p, y), 5),
                "pred_mean": round(float(np.mean(p)), 5),
                "obs_mean": round(float(np.mean(y)), 5)}

    cov = {}
    for fam in ("trio", "first4"):
        for nsel in (4, 5, 6):
            preds = np.array([r[fam][nsel][0] for r in races
                              if fam in r and nsel in r[fam]])
            obs = np.array([r[fam][nsel][1] for r in races
                            if fam in r and nsel in r[fam]])
            if len(preds):
                cov["%s_n%d" % (fam, nsel)] = {
                    "n": int(len(preds)),
                    "pred_mean": round(float(preds.mean()), 5),
                    "obs_mean": round(float(obs.mean()), 5),
                    "brier": round(pl.brier(preds, obs), 5),
                    "ece": round(pl.ece(preds, obs), 5),
                    "deciles": pl.reliability_deciles(preds, obs)}

    nll_h = np.array([r["nll3"][0] for r in races if "nll3" in r], dtype=float)
    nll_e = np.array([r["nll3"][1] for r in races if "nll3" in r], dtype=float)
    win_p = np.array([r["pwin_winner"] for r in races if "pwin_winner" in r],
                     dtype=float)
    return {
        "_status": "ok",
        "n_horse_rows": int(len(A)),
        "n_oof_races_final": int(n_oof_final),
        "tau_final": round(float(tau), 4),
        "gamma_final": [round(float(g), 4) for g in gamma],
        "pwin": cal(pw, ywin),
        "winner_nll_mean": (round(float(np.mean(
            -np.log(np.clip(win_p, 1e-12, 1.0)))), 5) if len(win_p) else None),
        "pTop3": {"harville": cal(p3h, y3), "henery": cal(p3e, y3)},
        "pTop4": {"harville": cal(p4h, y4), "henery": cal(p4e, y4)},
        "toporder_nll3": {
            "harville_mean": (round(float(np.nanmean(nll_h)), 5) if len(nll_h) else None),
            "henery_mean": (round(float(np.nanmean(nll_e)), 5) if len(nll_e) else None),
            "henery_better_pct": (round(float(np.mean(nll_e < nll_h)) * 100, 2)
                                  if len(nll_h) else None),
            "n": int(len(nll_h))},
        "coverage_reliability": cov,
        "invariant_topN_mismatch": int(n_mismatch),
        "box_roi_unchanged_by_calibration": True,
        "note": ("PL/Henery worth = exp(score/tau) is a monotone transform of the "
                 "single LGB score -> top-N selection and realized coverage/box ROI "
                 "are UNCHANGED. This block measures probability CALIBRATION only "
                 "(pWin/pTop3/pTop4 + analytic E[box coverage]); Henery gamma vs "
                 "Harville is the lower-place calibration test."),
    }


def main() -> int:
    args = parse_args()
    df = load(args.features)
    box_divs_by_race = load_dividends(args.db)
    exclude = {c.strip() for c in args.exclude.split(",") if c.strip()}
    if exclude:
        miss = exclude - set(FEATURE_COLS)
        if miss:
            print(f"[lgb-wf] WARN: --exclude names not in FEATURE_COLS: {sorted(miss)}", file=sys.stderr)
        print(f"[lgb-wf] A/B ablation: excluding {sorted(exclude & set(FEATURE_COLS))}", file=sys.stderr)
    feat_cols = [c for c in FEATURE_COLS if c not in exclude] + ["going_code"]

    race_ids = list(dict.fromkeys(df["race_id"].tolist()))
    print(f"[lgb-wf] {len(df):,} runner-rows across {len(race_ids):,} races "
          f"({df['race_date'].min()}..{df['race_date'].max()})", file=sys.stderr)

    race_to_rows = {rid: g for rid, g in df.groupby("race_id", sort=False)}

    booster: lgb.Booster | None = None
    last_trained_at = -10**9
    per_race: list[dict] = []

    # PL/Henery calibration head accumulators (eval-only, leak-safe)
    calib_oof: list = []                  # trailing OOF buffer: (scores, order_local)
    calib_tau = 1.0
    calib_gamma = [1.0, 1.0, 1.0, 1.0]
    calib_warm = False
    races_since_refit = 0
    calib_rows: list = []                 # per-horse (pw,ywin,p3h,p3e,p4h,p4e,y3,y4)
    calib_race: list = []                 # per-race coverage forecasts + nll
    n_invariant_mismatch = 0

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

        # ----- actual finishing order (best first) -----
        ta_fin = ta.dropna(subset=["finishing_position"]).copy()
        ta_fin["finishing_position"] = ta_fin["finishing_position"].astype(float)
        ta_fin = ta_fin.sort_values("finishing_position")
        actual_order = ta_fin["horse_id"].tolist()
        actual_top1 = actual_order[0] if actual_order else None
        actual_top3 = set(actual_order[:3])
        actual_top4 = set(actual_order[:4])

        # ----- LGB ranking (model score desc) -----
        order = np.argsort(-scores)
        lgb_ranked = ta.iloc[order]["horse_id"].tolist()

        # ----- ELO+factor ranking (baseline_score desc) -----
        bs = pd.to_numeric(ta["baseline_score"], errors="coerce")
        if bs.notna().sum() >= 4:
            elo_ranked = (ta.assign(_b=bs)
                          .sort_values("_b", ascending=False, na_position="last")
                          ["horse_id"].tolist())
        else:
            elo_ranked = None

        # ----- Market ranking (win_odds asc = favourite first) -----
        odds = pd.to_numeric(ta["win_odds"], errors="coerce")
        odds = odds.where(odds > 0)
        if odds.notna().sum() >= 4:
            market_ranked = (ta.assign(_o=odds)
                             .sort_values("_o", ascending=True, na_position="last")
                             ["horse_id"].tolist())
        else:
            market_ranked = None

        rec = {
            "race_id": str(rid),
            "date": str(ta["race_date"].iloc[0]),
            "field_size": int(len(ta)),
            # full ranked lists + actual order -> coverage recomputable OFFLINE
            "actual_order6": actual_order[:6],
            "lgb_top6": lgb_ranked[:6],
            "elo_top6": (elo_ranked[:6] if elo_ranked else None),
            "market_top6": (market_ranked[:6] if market_ranked else None),
            # per-race box dividends (table convention; see BOX_POOLS) -> ROI
            # fully recomputable OFFLINE alongside coverage.
            "race_no": (int(ta["race_no"].iloc[0])
                        if pd.notna(ta["race_no"].iloc[0]) else None),
            "box_divs": {c: box_divs_by_race[str(rid)][c]
                         for c in _DIV_CODES
                         if str(rid) in box_divs_by_race
                         and c in box_divs_by_race[str(rid)]},
        }
        for name, ranked in (("lgb", lgb_ranked),
                             ("elo", elo_ranked),
                             ("market", market_ranked)):
            for k, v in rank_metrics(ranked, actual_top1,
                                     actual_top3, actual_top4).items():
                rec["%s_%s" % (name, k)] = v
        per_race.append(rec)

        # ── PL/Henery calibration head (eval-only, leak-safe) ──
        # Fit τ/γ ONLY on OOF races strictly before this one; score THIS race
        # (still out-of-fold for the booster) with the frozen calibrator.
        hid_to_local = {h: k for k, h in enumerate(ta["horse_id"].tolist())}
        order_local = [hid_to_local[h] for h in actual_order if h in hid_to_local]
        if len(order_local) >= 3 and len(scores) == len(ta):
            if ((not calib_warm or races_since_refit >= CALIB_REFIT_EVERY)
                    and len(calib_oof) >= CALIB_MIN_OOF):
                window = calib_oof[-CALIB_WINDOW_MAX:]
                calib_tau, calib_gamma = pl.fit_calibrator(window, max_pos=CALIB_MAXPOS)
                calib_warm = True
                races_since_refit = 0
            if calib_warm:
                sc = np.asarray(scores, dtype=float)
                vv = pl.worths(sc, calib_tau)
                pwv = pl.pwin(vv)
                tk_h = pl.top_k_probs(vv, _HARVILLE, 4)
                tk_e = pl.top_k_probs(vv, calib_gamma, 4)
                t3s, t4s = set(order_local[:3]), set(order_local[:4])
                for k in range(len(sc)):
                    calib_rows.append((
                        float(pwv[k]), 1.0 if k == order_local[0] else 0.0,
                        float(tk_h[k, 2]), float(tk_e[k, 2]),
                        float(tk_h[k, 3]), float(tk_e[k, 3]),
                        1.0 if k in t3s else 0.0, 1.0 if k in t4s else 0.0))
                order_sc = np.argsort(-sc)
                if (set(order_sc[:4].tolist())
                        != set(np.argsort(-tk_e[:, 2])[:4].tolist())):
                    n_invariant_mismatch += 1
                rfc = {"pwin_winner": float(pwv[order_local[0]]),
                       "trio": {}, "first4": {}}
                for Nsel in (4, 5, 6):
                    S = order_sc[:Nsel].tolist()
                    Ss = set(S)
                    rfc["trio"][Nsel] = (pl.coverage_prob(vv, calib_gamma, S, 3),
                                         1.0 if t3s.issubset(Ss) else 0.0)
                    if len(order_local) >= 4:
                        rfc["first4"][Nsel] = (
                            pl.coverage_prob(vv, calib_gamma, S, 4),
                            1.0 if t4s.issubset(Ss) else 0.0)
                rfc["nll3"] = (pl.toporder_nll(vv, _HARVILLE, order_local[:3]),
                               pl.toporder_nll(vv, calib_gamma, order_local[:3]))
                calib_race.append(rfc)
            races_since_refit += 1
            calib_oof.append((np.asarray(scores, dtype=float), order_local))

        if args.verbose and (i + 1) % 200 == 0:
            print(f"  [{i + 1}/{len(race_ids)}] evaluated", file=sys.stderr)

    rdf = pd.DataFrame(per_race)

    _metric_keys = ("top1_hit", "top3_hit", "trio_n4", "trio_n5", "trio_n6",
                    "first4_n4", "first4_n5", "first4_n6", "qp_n4", "qp_n5",
                    "qp_n6", "place_in_top3", "place_in_top4")

    def rate_on(sub, col):
        if col not in sub.columns or len(sub) == 0:
            return None
        s = sub[col].dropna()
        return float(s.mean()) if len(s) else None

    def metric_block(sub):
        return {"%s_%s" % (name, k): rate_on(sub, "%s_%s" % (name, k))
                for name in ("lgb", "elo", "market") for k in _metric_keys}

    rdf8 = rdf[rdf["field_size"] >= 8] if len(rdf) else rdf

    summary = {
        "n_races_evaluated": int(len(rdf)),
        "n_races_field8": int(len(rdf8)),
        "date_range": (
            [str(rdf["date"].min()), str(rdf["date"].max())] if len(rdf) else None
        ),
        "field_size_mean": (float(rdf["field_size"].mean()) if len(rdf) else None),
        "metrics": metric_block(rdf),
        "metrics_field8": metric_block(rdf8),
        "box_roi": (box_roi(per_race) if box_divs_by_race
                    else {"_disabled": "no dividends loaded from --db"}),
        "box_roi_field8": (box_roi([r for r in per_race if r["field_size"] >= 8])
                           if box_divs_by_race
                           else {"_disabled": "no dividends loaded from --db"}),
        "qin_wheel_roi": (qin_wheel_roi(per_race) if box_divs_by_race
                          else {"_disabled": "no dividends loaded from --db"}),
        "qin_wheel_roi_field8": (qin_wheel_roi(per_race, 8) if box_divs_by_race
                                 else {"_disabled": "no dividends loaded from --db"}),
        "qin_parlay_roi": ({"leg2": qin_parlay_roi(per_race, 2),
                            "leg3": qin_parlay_roi(per_race, 3)} if box_divs_by_race
                           else {"_disabled": "no dividends loaded from --db"}),
        "qin_parlay_roi_field8": ({"leg2": qin_parlay_roi(per_race, 2, 8),
                                   "leg3": qin_parlay_roi(per_race, 3, 8)}
                                  if box_divs_by_race
                                  else {"_disabled": "no dividends loaded from --db"}),
        "calibration": _calibration_report(calib_rows, calib_race,
                                           n_invariant_mismatch, calib_tau,
                                           calib_gamma, len(calib_oof)),
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
            "excluded_features": sorted(exclude & set(FEATURE_COLS)),
        },
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(
        {"summary": summary, "per_race": per_race}, indent=2, default=str))

    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
