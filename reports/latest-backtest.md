# Backtest report run @ 2026-05-09T13:48:47Z

## Subdomain API resp
{
  "result": {
    "subdomain": "tianxi-entertainment"
  },
  "success": true,
  "errors": [],
  "messages": []
}

Detected subdomain: [tianxi-entertainment]

## Worker custom domains
{
  "result": [
    {
      "id": "6d9dd022f27fa257a132c20ce3abc6da43fc89bf",
      "zone_id": "cb362ae9db1820db68a6160e6a06de95",
      "zone_name": "tianxi.racing",
      "hostname": "www.tianxi.racing",
      "service": "tianxi-backend",
      "environment": "production",
      "cert_id": "32300533-6442-4b3d-8737-9b272e612650",
      "previews_enabled": false,
      "enabled": true
    },
    {
      "id": "65cb0f7b3db1ac5b4bec6642e1cc2acd7b6c4649",
      "zone_id": "cb362ae9db1820db68a6160e6a06de95",
      "zone_name": "tianxi.racing",
      "hostname": "tianxi.racing",
      "service": "tianxi-backend",
      "environment": "production",
      "cert_id": "81bd2cd0-7ac6-403a-8090-d793ba48a148",
      "previews_enabled": false,
      "enabled": true
    }
  ],
  "success": true,
  "errors": null,
  "messages": null,
  "result_info": {
    "page": 1,
    "per_page": 2,
    "count": 2,
    "total_count": 2
  }
}


## Trying base: https://tianxi-backend.tianxi-entertainment.workers.dev
/prediction-accuracy HTTP=200
{"sinceDate":"2026-04-09","days":30,"summary":[]}

## Using BASE=https://tianxi-backend.tianxi-entertainment.workers.dev

--- /backtest-report attempt 1 ---
HTTP=200 bytes=510

## Report body
# Backtest Report (90日 walk-forward)
  Generated: 2026-05-09T13:48:48.694Z
  Reusing existing prediction_log rows

  ## Variant comparison

  | Metric | baseline-bt (純 ELO) | qimen-bt (ELO + 奇門) | Δ |
  |---|---|---|---|
  | Rows (馬-場記錄) | 373 | 373 | — |
  | Races (賽事數) | 30 | 30 | — |
  | Brier score (越低越好) | 0.0737 | 0.0738 | 0.0001 |
  | Top1 命中率 % | 6.7 | 10 | 3.3 |
  | Top3 任一命中率 % | 70 | 70 | 0 |
  | Top3 平均交集 (滿分3) | 1.1 | 1.1 | 0 |
  
## /backtest-status
{"ok":true,"baseline":{"days":3,"rows":385},"qimen":{"days":3,"rows":385},"joined":746}