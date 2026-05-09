# 純梅花易數(後天數) backtest @ 2026-05-09T18:58:50Z

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
        "top1Hits": 7,
        "top3AnyHits": 51,
        "top3IntersectSum": 65,
        "top1HitRate": 9.7,
        "top3AnyHitRate": 70.8,
        "top3AvgIntersect": 0.9
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
            "top3Any": 8,
            "intersect": 9
        },
        {
            "date": "2026-04-29",
            "races": 9,
            "top1": 0,
            "top3Any": 7,
            "intersect": 10
        },
        {
            "date": "2026-04-26",
            "races": 11,
            "top1": 3,
            "top3Any": 10,
            "intersect": 15
        },
        {
            "date": "2026-04-22",
            "races": 9,
            "top1": 0,
            "top3Any": 5,
            "intersect": 7
        },
        {
            "date": "2026-04-19",
            "races": 11,
            "top1": 1,
            "top3Any": 7,
            "intersect": 8
        },
        {
            "date": "2026-04-15",
            "races": 9,
            "top1": 0,
            "top3Any": 6,
            "intersect": 7
        },
        {
            "date": "2026-04-12",
            "races": 11,
            "top1": 1,
            "top3Any": 8,
            "intersect": 9
        }
    ],
    "generatedAt": "2026-05-09T18:58:51.788Z"
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
                    "horseNumber": 8,
                    "nameCh": "\u904b\u4f86\u52c7\u58eb",
                    "jockeyCh": "\u9ec3\u667a\u5f18",
                    "meihuaScore": 3.9,
                    "actualFinish": 11,
                    "winOdds": 88,
                    "reason": {
                        "verdict": "\u2605\u2605\u2605 \u6613\u5366\u5927\u65fa\uff1a\u672c\u5366\u8b8a\u5366\u4ff1\u5409\uff0c\u9ad4\u7528\u76f8\u751f\uff0c\u5b9c\u91cd\u6ce8",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u4e7e\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=13) \uff0f \u4e0b\u5366\u3014\u5764\u3015(\u8c61\u00b7\u6295\u7968:\u904b\u2192\u5764\u3001\u52c7\u2192\u9707\u3001\u9ec3\u2192\u5764\u3001\u667a\u2192\u574e)",
                            "\u52d5\u723b\uff1a\u7b2c2\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u5730\u5929\u6cf0(11) \u2192 +5",
                            "\u8b8a\u5366\uff1a\u6c34\u5929\u9700(5) \u2192 +1",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u4e7e(\u4e0a\u5366)\u3015 \u2194 \u7528\u3014\u5764(\u4e0b\u5366)\u3015 \u2192 \u7528\u751f\u9ad4(\u5f97\u52a9,\u5409) (+0.5)"
                        ],
                        "totalScore": 3.9
                    }
                },
                {
                    "rank": 2,
                    "horseNumber": 1,
                    "nameCh": "\u5149\u8f1d\u6b72\u6708",
                    "jockeyCh": "\u970d\u5b8f\u8072",
                    "meihuaScore": 2.3,
                    "actualFinish": 4,
                    "winOdds": 6.3,
                    "reason": {
                        "verdict": "\u2605\u2605 \u6613\u5366\u504f\u65fa\uff1a\u5409\u6c23\u7565\u52dd",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u96e2\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=8) \uff0f \u4e0b\u5366\u3014\u96e2\u3015(\u8c61\u00b7\u6295\u7968:\u5149\u2192\u96e2\u3001\u8f1d\u2192\u96e2\u3001\u8072\u2192\u9707)",
                            "\u52d5\u723b\uff1a\u7b2c2\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u96e2\u70ba\u706b(30) \u2192 +1",
                            "\u8b8a\u5366\uff1a\u5929\u706b\u540c\u4eba(13) \u2192 +3",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u96e2(\u4e0a\u5366)\u3015 \u2194 \u7528\u3014\u96e2(\u4e0b\u5366)\u3015 \u2192 \u6bd4\u548c(\u5c0f\u5409) (+0.5)"
                        ],
                        "totalScore": 2.3
                    }
                },
                {
                    "rank": 3,
                    "horseNumber": 6,
                    "nameCh": "\u5e78\u904b\u50b3\u627f",
                    "jockeyCh": "\u83ab\u96f7\u62c9",
                    "meihuaScore": 2.3,
                    "actualFinish": 7,
                    "winOdds": 12,
                    "reason": {
                        "verdict": "\u2605\u2605 \u6613\u5366\u504f\u65fa\uff1a\u5409\u6c23\u7565\u52dd",
                        "breakdown": [
                            "\u4e0a\u5366\u3014\u5764\u3015(\u6578\u00b7\u99ac\u865f+\u6a94\u4f4d=18) \uff0f \u4e0b\u5366\u3014\u5764\u3015(\u8c61\u00b7\u6295\u7968:\u904b\u2192\u5764\u3001\u96f7\u2192\u9707)",
                            "\u52d5\u723b\uff1a\u7b2c5\u723b (\u6642\u8fb0\u5730\u652f7)",
                            "\u672c\u5366\uff1a\u5764\u70ba\u5730(2) \u2192 +3",
                            "\u8b8a\u5366\uff1a\u5730\u6c34\u5e2b(7) \u2192 +0",
                            "\u9ad4\u7528\uff1a\u9ad4\u3014\u5764(\u4e0b\u5366)\u3015 \u2194 \u7528\u3014\u5764(\u4e0a\u5366)\u3015 \u2192 \u6bd4\u548c(\u5c0f\u5409) (+0.5)"
                        ],
                        "totalScore": 2.3
                    }
                }
            ],
            "actualTop3": [
                {
                    "pos": 1,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "meihuaRank": 5,
                    "meihuaScore": 2.1,
                    "winOdds": 3.8
                },
                {
                    "pos": 2,
                    "horseNumber": 13,
                    "nameCh": "\u6771\u65b9\u9b45\u5f71",
                    "meihuaRank": 11,
                    "meihuaScore": 0.7,
                    "winOdds": 59
                },
                {
                    "pos": 3,
                    "horseNumber": 11,
                    "nameCh": "\u4e0a\u5e02\u9b45\u529b",
                    "meihuaRank": 6,
                    "meihuaScore": 1.9,
                    "winOdds": 3.5
                }
            ],
            "top1Hit": false,
            "top3AnyHit": false,
            "top3Intersect": 0
        }
    ],
    "generatedAt": "2026-05-09T18:58:52.298Z"
}
```
