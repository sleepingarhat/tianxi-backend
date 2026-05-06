# LightGBM walk-forward backtest (Stage 3)

  A second-stage re-ranker on top of the existing ELO + factor model. Trains
  LightGBM `LambdaRank` chronologically — for each race, the model is fit on
  all rows from prior races, then scores the current race's runners. Argmax
  of the score is the predicted Top-1.

  ## Files

  | File | Purpose |
  | --- | --- |
  | `dump-features.ts` | Reads `bulk-local.db` (built by `pnpm db:seed`), writes per-runner feature CSV. Mirrors the SQL queries in `composite-backtest.ts` so features are identical to what `analyze.ts` consumes at inference. |
  | `lgb_walkforward.py` | Walk-forward LGBM training + evaluation. Reports Top-1/Top-3 hit-rate against ELO baseline and market favourite. |

  ## Quickstart

  ```bash
  # 1. Build / refresh bulk-local.db from CSVs (existing pipeline)
  pnpm db:seed

  # 2. Dump features for the eval window (~1-2 min)
  pnpm tsx scripts/backtest/dump-features.ts \
    --db=bulk-local.db \
    --from=2024-09-01 --to=2026-04-30 \
    --out=features.csv

  # 3. Walk-forward LGB train + eval (~3-5 min)
  pip install lightgbm pandas numpy
  python scripts/backtest/lgb_walkforward.py \
    --features features.csv \
    --out results.json \
    --min-train-races 200 \
    --retrain-every-races 50 \
    --verbose
  ```

  `results.json` contains:

  ```json
  {
    "summary": {
      "n_races_evaluated": 700,
      "metrics": {
        "lgb_top1_hit_rate":    0.18,
        "lgb_top3_hit_rate":    0.55,
        "elo_top1_hit_rate":    0.13,
        "elo_top3_hit_rate":    0.45,
        "market_top1_hit_rate": 0.32
      },
      "feature_importance_gain": { ... }
    },
    "per_race": [ ... ]
  }
  ```

  ## Tuning

  * `--objective lambdarank` (default) — uses inverted finishing position as a
    graded relevance label, with race_id as the group. Best for ordering tasks.
  * `--objective binary` — only learns "is winner?" (positive class is
    imbalanced ~1/12, handled with `is_unbalance`). Often worse than ranking
    but useful as a calibration sanity check.
  * `--retrain-every-races N` — smaller N is more accurate but slower. With
    the default `50` (~5 race-meetings) the full backtest takes a few minutes.
  * `--num-leaves` — keep small (15-31) given training set size.

  ## What it does NOT do

  * No hyperparameter search. Defaults are conservative; tune after seeing a
    baseline result.
  * No production inference path. To deploy, persist the booster
    (`booster.save_model('model.txt')`) and load it inside an admin endpoint
    that reads the same features dump-features.ts emits, then re-rank in
    analyze.ts. That integration is a separate step once the offline numbers
    beat the ELO baseline meaningfully.
  