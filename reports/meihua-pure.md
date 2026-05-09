# 純梅花易數(後天數) backtest @ 2026-05-09T17:01:40Z

## A. 30日 aggregate
```json
{
    "rangeDays": 30,
    "datesEvaluated": 8,
    "dates": [
        "2026-05-09",
        "2026-05-03",
        "2026-04-29",
        "2026-04-26",
        "2026-04-22",
        "2026-04-19",
        "2026-04-15",
        "2026-04-12"
    ],
    "summary": {
        "totalRaces": 72,
        "top1Hits": 9,
        "top3AnyHits": 49,
        "top3IntersectSum": 65,
        "top1HitRate": 12.5,
        "top3AnyHitRate": 68.1,
        "top3AvgIntersect": 0.9
    },
    "perDay": [
        {
            "date": "2026-05-09",
            "races": 1,
            "top1": 0,
            "top3Any": 1,
            "intersect": 1
        },
        {
            "date": "2026-05-03",
            "races": 11,
            "top1": 0,
            "top3Any": 7,
            "intersect": 7
        },
        {
            "date": "2026-04-29",
            "races": 9,
            "top1": 2,
            "top3Any": 7,
            "intersect": 9
        },
        {
            "date": "2026-04-26",
            "races": 11,
            "top1": 1,
            "top3Any": 8,
            "intersect": 11
        },
        {
            "date": "2026-04-22",
            "races": 9,
            "top1": 2,
            "top3Any": 8,
            "intersect": 15
        },
        {
            "date": "2026-04-19",
            "races": 11,
            "top1": 1,
            "top3Any": 5,
            "intersect": 8
        },
        {
            "date": "2026-04-15",
            "races": 9,
            "top1": 2,
            "top3Any": 7,
            "intersect": 7
        },
        {
            "date": "2026-04-12",
            "races": 11,
            "top1": 1,
            "top3Any": 6,
            "intersect": 7
        }
    ],
    "generatedAt": "2026-05-09T17:01:42.973Z"
}
```

## B. 最近賽日 — 每場 Top3 含專業梅花解讀
```json
{
    "date": "2026-05-09",
    "summary": {
        "racesEvaluated": 1,
        "top1HitRate": 0,
        "top3AnyHitRate": 100,
        "top3AvgIntersect": 1,
        "top1Hits": 0,
        "top3AnyHits": 1,
        "top3IntersectSum": 1
    },
    "races": [
        {
            "raceNumber": 1,
            "distance": 1650,
            "going": "\u597d\u5730",
            "meihuaTop3": [
                {
                    "rank": 1,
                    "horseNumber": 8,
                    "nameCh": "\u904b\u4f86\u52c7\u58eb",
                    "jockeyCh": "\u9ec3\u667a\u5f18",
                    "meihuaScore": 5,
                    "actualFinish": 11,
                    "winOdds": 88,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u4e7e\u3015(\u99ac\u865f+\u6a94\u4f4d=13) \uff0f \u4e0b\u5366\u3014\u96e2\u3015(\u99ac\u540d\u7b46\u756b56+\u9a0e\u5e2b\u7b46\u756b48=104)",
                            "\u52d5\u723b\uff1a\u7b2c4\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u706b\u5929\u5927\u6709(14) \u2192 +5",
                            "\u8b8a\u5366\uff1a\u706b\u98a8\u9f0e(50) \u2192 +4",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u96e2(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u4e7e(\u4e0a\u5366)\u3015 \u2192 \u9ad4\u514b\u7528(\u5927\u5409) (+1)"
                        ],
                        "totalScore": 5
                    }
                },
                {
                    "rank": 2,
                    "horseNumber": 11,
                    "nameCh": "\u4e0a\u5e02\u9b45\u529b",
                    "jockeyCh": "\u7530\u6cf0\u5b89",
                    "meihuaScore": 4.6,
                    "actualFinish": 3,
                    "winOdds": 3.5,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u826e\u3015(\u99ac\u865f+\u6a94\u4f4d=15) \uff0f \u4e0b\u5366\u3014\u5dfd\u3015(\u99ac\u540d\u7b46\u756b81+\u9a0e\u5e2b\u7b46\u756b27=108)",
                            "\u52d5\u723b\uff1a\u7b2c4\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u98a8\u5c71\u6f38(53) \u2192 +4",
                            "\u8b8a\u5366\uff1a\u98a8\u706b\u5bb6\u4eba(37) \u2192 +3",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u5dfd(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u826e(\u4e0a\u5366)\u3015 \u2192 \u9ad4\u514b\u7528(\u5927\u5409) (+1)"
                        ],
                        "totalScore": 4.6
                    }
                },
                {
                    "rank": 3,
                    "horseNumber": 5,
                    "nameCh": "\u9583\u8000\u5a01\u9f8d",
                    "jockeyCh": "\u8881\u5e78\u582f",
                    "meihuaScore": 4.2,
                    "actualFinish": 12,
                    "winOdds": 10,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u826e\u3015(\u99ac\u865f+\u6a94\u4f4d=15) \uff0f \u4e0b\u5366\u3014\u5dfd\u3015(\u99ac\u540d\u7b46\u756b51+\u9a0e\u5e2b\u7b46\u756b41=92)",
                            "\u52d5\u723b\uff1a\u7b2c6\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u98a8\u5c71\u6f38(53) \u2192 +4",
                            "\u8b8a\u5366\uff1a\u98a8\u5730\u89c0(20) \u2192 +2",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u5dfd(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u826e(\u4e0a\u5366)\u3015 \u2192 \u9ad4\u514b\u7528(\u5927\u5409) (+1)"
                        ],
                        "totalScore": 4.2
                    }
                }
            ],
            "actualTop3": [
                {
                    "pos": 1,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "meihuaRank": 4,
                    "meihuaScore": 3.8,
                    "winOdds": 3.8
                },
                {
                    "pos": 2,
                    "horseNumber": 13,
                    "nameCh": "\u6771\u65b9\u9b45\u5f71",
                    "meihuaRank": 10,
                    "meihuaScore": 0.7,
                    "winOdds": 59
                },
                {
                    "pos": 3,
                    "horseNumber": 11,
                    "nameCh": "\u4e0a\u5e02\u9b45\u529b",
                    "meihuaRank": 2,
                    "meihuaScore": 4.6,
                    "winOdds": 3.5
                }
            ],
            "top1Hit": false,
            "top3AnyHit": true,
            "top3Intersect": 1
        }
    ],
    "generatedAt": "2026-05-09T17:01:43.519Z"
}
```
