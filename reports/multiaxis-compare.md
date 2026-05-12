# Multi-axis ELO comparison @ 2026-05-12T16:08:25Z

Window: `2024-06-01` → `2024-06-30` · ELO compute: v11 (multi-axis + 180d decay)

| variant | top1 hit | top3 hit | podium IoU | spearman | brier top1 | races |
|---|---:|---:|---:|---:|---:|---:|
| A_overall_8factor | 0 | 0 | — | None | — | 70 |
| B_overall_pure | 0 | 0 | — | None | — | 70 |
| C_axis_8factor | 0 | 0 | — | None | — | 70 |
| D_axis_pure | 0 | 0 | — | None | — | 70 |
| E_hybrid_8factor | 0 | 0 | — | None | — | 70 |

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
    "validRaces": 0,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0,
        "top3HitRate": 0,
        "meanPodiumIOU": 0,
        "meanSpearman": null,
        "marketTop1HitRate": null,
        "marketTotal": 0
    },
    "byMonth": {}
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
    "validRaces": 0,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0,
        "top3HitRate": 0,
        "meanPodiumIOU": 0,
        "meanSpearman": null,
        "marketTop1HitRate": null,
        "marketTotal": 0
    },
    "byMonth": {}
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
    "validRaces": 0,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0,
        "top3HitRate": 0,
        "meanPodiumIOU": 0,
        "meanSpearman": null,
        "marketTop1HitRate": null,
        "marketTotal": 0
    },
    "byMonth": {}
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
    "validRaces": 0,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0,
        "top3HitRate": 0,
        "meanPodiumIOU": 0,
        "meanSpearman": null,
        "marketTop1HitRate": null,
        "marketTotal": 0
    },
    "byMonth": {}
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
    "validRaces": 0,
    "runnerCount": 834,
    "metrics": {
        "top1HitRate": 0,
        "top3HitRate": 0,
        "meanPodiumIOU": 0,
        "meanSpearman": null,
        "marketTop1HitRate": null,
        "marketTotal": 0
    },
    "byMonth": {}
}
```
