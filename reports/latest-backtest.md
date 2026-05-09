# Backtest DIFF diagnostic @ 2026-05-09T15:15:47Z

## /backtest-diff
```json
{
    "aggregate_per_variant": [
        {
            "variant": "baseline-bt",
            "rows": 1273,
            "avg_p_win": 0.079339,
            "avg_rank": 6.9285,
            "top1_hits": 101,
            "top3_hits": 303,
            "avg_factor_bonus": 0,
            "nonzero_bonus_rows": 0,
            "null_pwin": 0
        },
        {
            "variant": "qimen-bt",
            "rows": 1273,
            "avg_p_win": 0.07934,
            "avg_rank": 6.9285,
            "top1_hits": 101,
            "top3_hits": 303,
            "avg_factor_bonus": 0.2898,
            "nonzero_bonus_rows": 1200,
            "null_pwin": 0
        }
    ],
    "row_diff_summary": {
        "total": 1273,
        "diff_rows": 553,
        "rank_diff_rows": 140
    },
    "sample_15_rows": [
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_G312",
            "horse_number": 1,
            "base_p_win": 0.118,
            "qimen_p_win": 0.12,
            "base_rank": 1,
            "qimen_rank": 1,
            "base_bonus": 0,
            "qimen_bonus": 1.38,
            "actual_finish": 10
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J182",
            "horse_number": 2,
            "base_p_win": 0.074,
            "qimen_p_win": 0.074,
            "base_rank": 10,
            "qimen_rank": 10,
            "base_bonus": 0,
            "qimen_bonus": -0.5,
            "actual_finish": 5
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J541",
            "horse_number": 3,
            "base_p_win": 0.091,
            "qimen_p_win": 0.091,
            "base_rank": 3,
            "qimen_rank": 3,
            "base_bonus": 0,
            "qimen_bonus": 0.5,
            "actual_finish": 4
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J508",
            "horse_number": 4,
            "base_p_win": 0.1,
            "qimen_p_win": 0.099,
            "base_rank": 2,
            "qimen_rank": 2,
            "base_bonus": 0,
            "qimen_bonus": -0.25,
            "actual_finish": 8
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J331",
            "horse_number": 5,
            "base_p_win": 0.076,
            "qimen_p_win": 0.076,
            "base_rank": 8,
            "qimen_rank": 8,
            "base_bonus": 0,
            "qimen_bonus": 0,
            "actual_finish": 3
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J524",
            "horse_number": 6,
            "base_p_win": 0.08,
            "qimen_p_win": 0.081,
            "base_rank": 7,
            "qimen_rank": 7,
            "base_bonus": 0,
            "qimen_bonus": 1.38,
            "actual_finish": 9
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_K306",
            "horse_number": 7,
            "base_p_win": 0.089,
            "qimen_p_win": 0.089,
            "base_rank": 4,
            "qimen_rank": 4,
            "base_bonus": 0,
            "qimen_bonus": 0.25,
            "actual_finish": 1
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J371",
            "horse_number": 8,
            "base_p_win": 0.067,
            "qimen_p_win": 0.068,
            "base_rank": 11,
            "qimen_rank": 11,
            "base_bonus": 0,
            "qimen_bonus": 1.38,
            "actual_finish": 11
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_H293",
            "horse_number": 9,
            "base_p_win": 0.083,
            "qimen_p_win": 0.083,
            "base_rank": 5,
            "qimen_rank": 5,
            "base_bonus": 0,
            "qimen_bonus": 0.25,
            "actual_finish": 2
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_K110",
            "horse_number": 10,
            "base_p_win": 0.082,
            "qimen_p_win": 0.083,
            "base_rank": 6,
            "qimen_rank": 6,
            "base_bonus": 0,
            "qimen_bonus": 1.5,
            "actual_finish": 7
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J326",
            "horse_number": 11,
            "base_p_win": 0.063,
            "qimen_p_win": 0.063,
            "base_rank": 12,
            "qimen_rank": 12,
            "base_bonus": 0,
            "qimen_bonus": 0.13,
            "actual_finish": 12
        },
        {
            "date": "2026-03-04",
            "race_number": 1,
            "horse_id": "horse_J269",
            "horse_number": 12,
            "base_p_win": 0.075,
            "qimen_p_win": 0.074,
            "base_rank": 9,
            "qimen_rank": 9,
            "base_bonus": 0,
            "qimen_bonus": -1,
            "actual_finish": 6
        },
        {
            "date": "2026-03-04",
            "race_number": 2,
            "horse_id": "horse_K044",
            "horse_number": 1,
            "base_p_win": 0.079,
            "qimen_p_win": 0.08,
            "base_rank": 6,
            "qimen_rank": 6,
            "base_bonus": 0,
            "qimen_bonus": 1.25,
            "actual_finish": 10
        },
        {
            "date": "2026-03-04",
            "race_number": 2,
            "horse_id": "horse_J243",
            "horse_number": 2,
            "base_p_win": 0.07,
            "qimen_p_win": 0.07,
            "base_rank": 11,
            "qimen_rank": 11,
            "base_bonus": 0,
            "qimen_bonus": 0.5,
            "actual_finish": 3
        },
        {
            "date": "2026-03-04",
            "race_number": 2,
            "horse_id": "horse_H273",
            "horse_number": 3,
            "base_p_win": 0.102,
            "qimen_p_win": 0.102,
            "base_rank": 2,
            "qimen_rank": 2,
            "base_bonus": 0,
            "qimen_bonus": 0.13,
            "actual_finish": 4
        }
    ],
    "interpretation": {
        "note": "If diff_rows == 0 \u2192 variants are identical \u2192 bug in writer. If diff_rows > 0 but stats match \u2192 bug in /backtest-report statsFor."
    },
    "generatedAt": "2026-05-09T15:15:48.496Z"
}
```

## /backtest-report (full)
# Backtest Report (90日 walk-forward)
  Generated: 2026-05-09T15:15:48.893Z
  Reusing existing prediction_log rows

  ## Variant comparison

  | Metric | baseline-bt (純 ELO) | qimen-bt (ELO + 奇門) | Δ |
  |---|---|---|---|
  | Rows (馬-場記錄) | 1244 | 1244 | — |
  | Races (賽事數) | 101 | 101 | — |
  | Brier score (越低越好) | 0.0741 | 0.0741 | 0 |
  | Top1 命中率 % | 12.9 | 12.9 | 0 |
  | Top3 任一命中率 % | 72.3 | 72.3 | 0 |
  | Top3 平均交集 (滿分3) | 1.06 | 1.06 | 0 |
  