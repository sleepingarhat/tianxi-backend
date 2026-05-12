# Multi-axis ELO comparison @ 2026-05-12T16:37:39Z

Window: `2024-06-01` → `2024-06-30` · ELO compute: v11 (multi-axis + 180d decay)

| variant | top1 hit | top3 hit | podium IoU | spearman | brier top1 | races |
|---|---:|---:|---:|---:|---:|---:|
| A_overall_8factor | 0.14285714285714285 | 0.5142857142857142 | — | 0.2589867275581562 | — | 70 |
| B_overall_pure | 0.08571428571428572 | 0.44285714285714284 | — | 0.23524261452832884 | — | 70 |
| C_axis_8factor | 0.12857142857142856 | 0.45714285714285713 | — | 0.2382781504210075 | — | 70 |
| D_axis_pure | 0.1 | 0.42857142857142855 | — | 0.22200371057513912 | — | 70 |
| E_hybrid_8factor | 0.12857142857142856 | 0.45714285714285713 | — | 0.25719566148137585 | — | 70 |

## Detail JSONs (top 80 lines each)

### A_overall_8factor
```json
{
    "config": {
        "dbPath": "bulk-local.db",
        "from": "2024-06-01",
        "to": "2024-06-30",
        "engine": "v12",
        "weights": {
            "horse": 0.7,
            "jockey": 0.2,
            "trainer": 0.1
        },
        "factors": [
            "recency",
            "distance",
            "going",
            "draw",
            "weight",
            "combo"
        ]
    },
    "raceCount": 70,
    "validRaces": 70,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0.14285714285714285,
        "top3HitRate": 0.5142857142857142,
        "meanPodiumIOU": 0.3952380952380953,
        "meanSpearman": 0.2589867275581562,
        "marketTop1HitRate": 0.3142857142857143,
        "marketTotal": 70
    },
    "byMonth": {
        "2024-06": {
            "n": 70,
            "top1HitRate": 0.14285714285714285,
            "top3HitRate": 0.5142857142857142,
            "podiumIOU": 0.3952380952380953,
            "marketTop1HitRate": 0.3142857142857143
        }
    }
}
```

### B_overall_pure
```json
{
    "config": {
        "dbPath": "bulk-local.db",
        "from": "2024-06-01",
        "to": "2024-06-30",
        "engine": "v12",
        "weights": {
            "horse": 0.7,
            "jockey": 0.2,
            "trainer": 0.1
        },
        "factors": []
    },
    "raceCount": 70,
    "validRaces": 70,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0.08571428571428572,
        "top3HitRate": 0.44285714285714284,
        "meanPodiumIOU": 0.39523809523809533,
        "meanSpearman": 0.23524261452832884,
        "marketTop1HitRate": 0.3142857142857143,
        "marketTotal": 70
    },
    "byMonth": {
        "2024-06": {
            "n": 70,
            "top1HitRate": 0.08571428571428572,
            "top3HitRate": 0.44285714285714284,
            "podiumIOU": 0.39523809523809533,
            "marketTop1HitRate": 0.3142857142857143
        }
    }
}
```

### C_axis_8factor
```json
{
    "config": {
        "dbPath": "bulk-local.db",
        "from": "2024-06-01",
        "to": "2024-06-30",
        "engine": "v12",
        "weights": {
            "horse": 0.7,
            "jockey": 0.2,
            "trainer": 0.1
        },
        "factors": [
            "recency",
            "distance",
            "going",
            "draw",
            "weight",
            "combo"
        ]
    },
    "raceCount": 70,
    "validRaces": 70,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0.12857142857142856,
        "top3HitRate": 0.45714285714285713,
        "meanPodiumIOU": 0.39523809523809533,
        "meanSpearman": 0.2382781504210075,
        "marketTop1HitRate": 0.3142857142857143,
        "marketTotal": 70
    },
    "byMonth": {
        "2024-06": {
            "n": 70,
            "top1HitRate": 0.12857142857142856,
            "top3HitRate": 0.45714285714285713,
            "podiumIOU": 0.39523809523809533,
            "marketTop1HitRate": 0.3142857142857143
        }
    }
}
```

### D_axis_pure
```json
{
    "config": {
        "dbPath": "bulk-local.db",
        "from": "2024-06-01",
        "to": "2024-06-30",
        "engine": "v12",
        "weights": {
            "horse": 0.7,
            "jockey": 0.2,
            "trainer": 0.1
        },
        "factors": []
    },
    "raceCount": 70,
    "validRaces": 70,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0.1,
        "top3HitRate": 0.42857142857142855,
        "meanPodiumIOU": 0.36666666666666675,
        "meanSpearman": 0.22200371057513912,
        "marketTop1HitRate": 0.3142857142857143,
        "marketTotal": 70
    },
    "byMonth": {
        "2024-06": {
            "n": 70,
            "top1HitRate": 0.1,
            "top3HitRate": 0.42857142857142855,
            "podiumIOU": 0.36666666666666675,
            "marketTop1HitRate": 0.3142857142857143
        }
    }
}
```

### E_hybrid_8factor
```json
{
    "config": {
        "dbPath": "bulk-local.db",
        "from": "2024-06-01",
        "to": "2024-06-30",
        "engine": "v12",
        "weights": {
            "horse": 0.7,
            "jockey": 0.2,
            "trainer": 0.1
        },
        "factors": [
            "recency",
            "distance",
            "going",
            "draw",
            "weight",
            "combo"
        ]
    },
    "raceCount": 70,
    "validRaces": 70,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0.12857142857142856,
        "top3HitRate": 0.45714285714285713,
        "meanPodiumIOU": 0.4047619047619048,
        "meanSpearman": 0.25719566148137585,
        "marketTop1HitRate": 0.3142857142857143,
        "marketTotal": 70
    },
    "byMonth": {
        "2024-06": {
            "n": 70,
            "top1HitRate": 0.12857142857142856,
            "top3HitRate": 0.45714285714285713,
            "podiumIOU": 0.4047619047619048,
            "marketTop1HitRate": 0.3142857142857143
        }
    }
}
```
