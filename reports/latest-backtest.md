# Backtest report run @ 2026-05-09T13:50:46Z

## Initial status
{"ok":true,"baseline":{"days":3,"rows":385},"qimen":{"days":3,"rows":385},"joined":746}

## Kick /start-backtest-bg (days=90)
Try POST /api/analyze/start-backtest-bg?days=90
  HTTP=200
{"ok":true,"started":true,"days":90,"message":"Backtest running in background. Poll /api/analyze/backtest-status for progress."}

## Poll status (max ~10 min)
[t=30s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=60s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=90s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=120s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=150s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=180s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=210s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=240s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=270s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=300s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=330s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=360s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=390s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=420s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=450s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=480s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=510s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=540s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=570s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}
[t=600s] days=10  raw={"ok":true,"baseline":{"days":10,"rows":1273},"qimen":{"days":10,"rows":1273},"joined":2488}

## Final /backtest-report
HTTP=200 bytes=516

# Backtest Report (90日 walk-forward)
  Generated: 2026-05-09T14:00:54.867Z
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
  