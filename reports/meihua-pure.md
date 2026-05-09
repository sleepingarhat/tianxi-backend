# 純梅花易數(後天數) backtest @ 2026-05-09T19:42:30Z

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
        "top1Hits": 6,
        "top3AnyHits": 49,
        "top3IntersectSum": 59,
        "top1HitRate": 8.3,
        "top3AnyHitRate": 68.1,
        "top3AvgIntersect": 0.82
    },
    "perDay": [
        {
            "date": "2026-05-09",
            "races": 1,
            "top1": 0,
            "top3Any": 0,
            "intersect": 0
        },
        {
            "date": "2026-05-03",
            "races": 11,
            "top1": 2,
            "top3Any": 9,
            "intersect": 9
        },
        {
            "date": "2026-04-29",
            "races": 9,
            "top1": 0,
            "top3Any": 5,
            "intersect": 6
        },
        {
            "date": "2026-04-26",
            "races": 11,
            "top1": 3,
            "top3Any": 8,
            "intersect": 10
        },
        {
            "date": "2026-04-22",
            "races": 9,
            "top1": 0,
            "top3Any": 5,
            "intersect": 5
        },
        {
            "date": "2026-04-19",
            "races": 11,
            "top1": 0,
            "top3Any": 7,
            "intersect": 8
        },
        {
            "date": "2026-04-15",
            "races": 9,
            "top1": 1,
            "top3Any": 7,
            "intersect": 11
        },
        {
            "date": "2026-04-12",
            "races": 11,
            "top1": 0,
            "top3Any": 8,
            "intersect": 10
        }
    ],
    "generatedAt": "2026-05-09T19:42:31.387Z"
}
```

## B. 最近賽日 — 每場 Top3 含專業梅花解讀
```json
{
    "date": "2026-05-09",
    "summary": {
        "racesEvaluated": 1,
        "top1HitRate": 0,
        "top3AnyHitRate": 0,
        "top3AvgIntersect": 0,
        "top1Hits": 0,
        "top3AnyHits": 0,
        "top3IntersectSum": 0
    },
    "races": [
        {
            "raceNumber": 1,
            "distance": 1650,
            "going": "\u597d\u5730",
            "meihuaTop3": [
                {
                    "rank": 1,
                    "horseNumber": 4,
                    "nameCh": "\u5341\u529b",
                    "jockeyCh": "\u5967\u723e\u6c11",
                    "meihuaScore": 5,
                    "actualFinish": 6,
                    "winOdds": 28,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u826e\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=7) \uff0f \u4e0b\u5366\u3014\u5764\u3015(\u8c61\u00b7\u6295\u7968:\u723e\u2192\u5764\u00d70.5)",
                            "\u52d5\u723b\uff1a\u7b2c5\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u5730\u5c71\u8b19(15) \u2192 +5",
                            "\u8b8a\u5366\uff1a\u5730\u98a8\u5347(46) \u2192 +4",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u5764(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u826e(\u4e0a\u5366)\u3015 \u2192 \u6bd4\u548c(\u5c0f\u5409) (+0.5)"
                        ],
                        "totalScore": 5
                    }
                },
                {
                    "rank": 2,
                    "horseNumber": 14,
                    "nameCh": "\u6a02\u77da\u5fc3\u6a5f",
                    "jockeyCh": "\u694a\u660e\u7db8",
                    "meihuaScore": 4.6,
                    "actualFinish": 8,
                    "winOdds": 74,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u5dfd\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=28) \uff0f \u4e0b\u5366\u3014\u5764\u3015(\u8c61\u00b7\u6295\u7968:\u6a02\u2192\u5764\u00d73\u3001\u5fc3\u2192\u96e2\u00d72\u3001\u694a\u2192\u5dfd\u00d70.5\u3001\u660e\u2192\u96e2\u00d70.5)",
                            "\u52d5\u723b\uff1a\u7b2c1\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u5730\u98a8\u5347(46) \u2192 +4",
                            "\u8b8a\u5366\uff1a\u96f7\u98a8\u6046(32) \u2192 +3",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u5dfd(\u4e0a\u5366)\u3015 \u2194 \u7528\u3014\u5764(\u4e0b\u5366)\u3015 \u2192 \u9ad4\u514b\u7528(\u5927\u5409) (+1)"
                        ],
                        "totalScore": 4.6
                    }
                },
                {
                    "rank": 3,
                    "horseNumber": 10,
                    "nameCh": "\u4e00\u9e7f\u6b61\u9a30",
                    "jockeyCh": "\u937e\u6613\u79ae",
                    "meihuaScore": 3.6,
                    "actualFinish": 5,
                    "winOdds": 12,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u9707\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=11) \uff0f \u4e0b\u5366\u3014\u514c\u3015(\u8c61\u00b7\u6295\u7968:\u6b61\u2192\u514c\u00d72\u3001\u9a30\u2192\u9707\u00d72)",
                            "\u52d5\u723b\uff1a\u7b2c4\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u6fa4\u96f7\u96a8(17) \u2192 +3",
                            "\u8b8a\u5366\uff1a\u6fa4\u5730\u8403(45) \u2192 +2",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u514c(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u9707(\u4e0a\u5366)\u3015 \u2192 \u9ad4\u514b\u7528(\u5927\u5409) (+1)"
                        ],
                        "totalScore": 3.6
                    }
                }
            ],
            "actualTop3": [
                {
                    "pos": 1,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "meihuaRank": 12,
                    "meihuaScore": -0.3,
                    "winOdds": 3.8
                },
                {
                    "pos": 2,
                    "horseNumber": 13,
                    "nameCh": "\u6771\u65b9\u9b45\u5f71",
                    "meihuaRank": 8,
                    "meihuaScore": 1.8,
                    "winOdds": 59
                },
                {
                    "pos": 3,
                    "horseNumber": 11,
                    "nameCh": "\u4e0a\u5e02\u9b45\u529b",
                    "meihuaRank": 14,
                    "meihuaScore": -2.1,
                    "winOdds": 3.5
                }
            ],
            "top1Hit": false,
            "top3AnyHit": false,
            "top3Intersect": 0
        }
    ],
    "generatedAt": "2026-05-09T19:42:31.722Z"
}
```
