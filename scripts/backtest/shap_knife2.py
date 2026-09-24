#!/usr/bin/env python3
"""Knife-2 TreeSHAP on the frozen racing LGB track. Never writes prediction_log."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

DISCLAIMER = (
    "LGB-track contribution only. Not win-cause. Not Elo. Not alpha blend. "
    "Do not show on today-picks until fingerprint matches the locked booster."
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--booster", help="Read-only lgb.txt used at lock")
    ap.add_argument("--features", help="Same-version dump-features CSV")
    ap.add_argument("--fingerprint", default="unknown")
    ap.add_argument("--max-rows", type=int, default=4000)
    ap.add_argument("--out", default="reports/shap/latest.json")
    args = ap.parse_args()

    out: dict = {
        "ok": True,
        "knife": 2,
        "sport": "racing",
        "status": "blocked",
        "fingerprint": args.fingerprint,
        "method": "TreeSHAP",
        "applied_to_freeze": False,
        "disclaimer": DISCLAIMER,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "global_mean_abs": [],
        "per_runner": [],
        "reason": None,
    }
    booster_p = Path(args.booster) if args.booster else None
    feat_p = Path(args.features) if args.features else None
    if not booster_p or not booster_p.exists():
        out["reason"] = "frozen booster not in repo; run in engine job with lock-time lgb.txt"
    elif not feat_p or not feat_p.exists():
        out["reason"] = "same-version features CSV missing"
    else:
        try:
            import lightgbm as lgb
            import numpy as np
            import pandas as pd
            import shap
        except ImportError as e:
            out["reason"] = f"deps missing: {e}"
        else:
            booster = lgb.Booster(model_file=str(booster_p))
            names = booster.feature_name()
            df = pd.read_csv(feat_p)
            use = [c for c in names if c in df.columns]
            if len(use) < 8:
                out["reason"] = f"feature overlap too small: {len(use)}"
            else:
                X = df[use].astype(float).fillna(-1.0).to_numpy()[: args.max_rows]
                explainer = shap.TreeExplainer(booster)
                sv = explainer.shap_values(X)
                if isinstance(sv, list):
                    sv = sv[0]
                mean_abs = np.abs(sv).mean(axis=0)
                order = np.argsort(-mean_abs)
                out["global_mean_abs"] = [
                    {"feature": use[i], "mean_abs": float(mean_abs[i])}
                    for i in order[:20]
                ]
                out["status"] = "ok"
                out["n_rows"] = int(len(X))
                out["n_features"] = len(use)

    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"wrote": str(dest), "status": out["status"], "reason": out.get("reason")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
