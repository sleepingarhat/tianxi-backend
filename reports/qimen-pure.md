# 純奇門 backtest @ 2026-05-09T16:23:30Z

## A. 30日 aggregate (純奇門 vs ELO baseline)
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
        "top1Hits": 2,
        "top3AnyHits": 45,
        "top3IntersectSum": 51,
        "top1HitRate": 2.8,
        "top3AnyHitRate": 62.5,
        "top3AvgIntersect": 0.71
    },
    "eloBaselineComparison": {
        "races": 0,
        "top1": null,
        "top3hits_rows": null
    },
    "perDay": [
        {
            "date": "2026-05-09",
            "races": 1,
            "top1": 0,
            "top3Any": 1,
            "intersect": 1,
            "ju": 4,
            "yang": true
        },
        {
            "date": "2026-05-03",
            "races": 11,
            "top1": 0,
            "top3Any": 10,
            "intersect": 11,
            "ju": 1,
            "yang": true
        },
        {
            "date": "2026-04-29",
            "races": 9,
            "top1": 2,
            "top3Any": 7,
            "intersect": 10,
            "ju": 8,
            "yang": true
        },
        {
            "date": "2026-04-26",
            "races": 11,
            "top1": 0,
            "top3Any": 4,
            "intersect": 4,
            "ju": 8,
            "yang": true
        },
        {
            "date": "2026-04-22",
            "races": 9,
            "top1": 0,
            "top3Any": 6,
            "intersect": 7,
            "ju": 5,
            "yang": true
        },
        {
            "date": "2026-04-19",
            "races": 11,
            "top1": 0,
            "top3Any": 6,
            "intersect": 6,
            "ju": 2,
            "yang": true
        },
        {
            "date": "2026-04-15",
            "races": 9,
            "top1": 0,
            "top3Any": 5,
            "intersect": 5,
            "ju": 2,
            "yang": true
        },
        {
            "date": "2026-04-12",
            "races": 11,
            "top1": 0,
            "top3Any": 6,
            "intersect": 7,
            "ju": 7,
            "yang": true
        }
    ],
    "generatedAt": "2026-05-09T16:23:32.777Z"
}
```

## B. 最近賽日 — 每場 Top3 含專業奇門解讀
```json
{
    "date": "2026-05-09",
    "paipan": {
        "ju": 4,
        "yang": true,
        "chaibu": {
            "ju": 4,
            "yang": true,
            "yuan": 0,
            "yuanName": "\u4e0a\u5143",
            "jieqiName": "\u7acb\u590f",
            "chaibuMode": "\u8d85\u795e",
            "superShenDays": 1,
            "futouDayGz": 15,
            "futouName": "\u5df1\u536f",
            "dayGz": 19,
            "dayGzName": "\u7678\u672a"
        },
        "palaceScores": {
            "1": 0,
            "2": 0,
            "3": -2,
            "4": -2,
            "5": -3,
            "6": 2,
            "7": 2,
            "8": 4,
            "9": 3
        },
        "stars": {
            "1": "\u5929\u67f1",
            "2": "\u5929\u4efb",
            "3": "\u5929\u82f1",
            "4": "\u5929\u84ec",
            "5": "\u5929\u82ae",
            "6": "\u5929\u885d",
            "7": "\u5929\u8f14",
            "8": "\u5929\u79bd",
            "9": "\u5929\u5fc3"
        },
        "doors": {
            "1": "\u4f11\u9580",
            "2": "\u6b7b\u9580",
            "3": "\u50b7\u9580",
            "4": "\u675c\u9580",
            "6": "\u958b\u9580",
            "7": "\u9a5a\u9580",
            "8": "\u751f\u9580",
            "9": "\u666f\u9580"
        },
        "gods": {
            "1": "\u7384\u6b66",
            "2": "\u592a\u9670",
            "3": "\u4e5d\u5929",
            "4": "\u503c\u7b26",
            "6": "\u767d\u864e",
            "7": "\u516d\u5408",
            "8": "\u4e5d\u5730",
            "9": "\u87a3\u86c7"
        },
        "zhiFu": {
            "palace": 4,
            "star": "\u5929\u84ec"
        },
        "zhiShi": {
            "palace": 4,
            "door": "\u675c\u9580"
        }
    },
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
            "qimenTop3": [
                {
                    "rank": 1,
                    "horseNumber": 1,
                    "nameCh": "\u5149\u8f1d\u6b72\u6708",
                    "jockeyCh": "\u970d\u5b8f\u8072",
                    "qimenScore": 1.25,
                    "actualFinish": 4,
                    "winOdds": 6.3,
                    "reason": {
                        "verdict": "\u2605\u2605 \u5947\u9580\u504f\u65fa\uff1a\u5409\u6c23\u7565\u52dd\u51f6\u6c23",
                        "breakdown": [
                            "\u99ac\u865f\u5165\u574e\u4e00(\u5317): \u3014\u5929\u67f1\u3015\u661f +\u3014\u4f11\u9580\u3015\u9580 +\u3014\u7384\u6b66\u3015\u795e \u2192 0\u5206(\u5e73)",
                            "\u6a94\u4f4d\u5165\u514c\u4e03(\u897f): \u3014\u5929\u8f14\u3015\u661f +\u3014\u9a5a\u9580\u3015\u9580 +\u3014\u516d\u5408\u3015\u795e \u2192 2\u5206(\u5409)",
                            "\u99ac\u540d\u300c\u5149\u300d\u5c6c\u706b\u884c \u2192 \u96e2\u4e5d(\u5357): \u3014\u5929\u5fc3\u3015\u661f +\u3014\u666f\u9580\u3015\u9580 +\u3014\u87a3\u86c7\u3015\u795e \u2192 3\u5206(\u5409)\uff08\u7b46\u756b\u4fee\u6b63 8\uff09",
                            "\u9a0e\u5e2b(\u7e3d\u7b46\u756b52) \u2192 \u826e\u516b(\u6771\u5317): \u3014\u5929\u79bd\u3015\u661f +\u3014\u751f\u9580\u3015\u9580 +\u3014\u4e5d\u5730\u3015\u795e \u2192 4\u5206(\u5927\u5409)"
                        ],
                        "totalScore": 1.25
                    }
                },
                {
                    "rank": 2,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "jockeyCh": "\u5e03\u6587",
                    "qimenScore": 0.13,
                    "actualFinish": 1,
                    "winOdds": 3.8,
                    "reason": {
                        "verdict": "\u2605 \u5947\u9580\u5e73\u548c\uff1a\u5409\u51f6\u4e92\u898b\uff0c\u7121\u660e\u986f\u52a9\u529b",
                        "breakdown": [
                            "\u99ac\u865f\u5165\u96e2\u4e5d(\u5357): \u3014\u5929\u5fc3\u3015\u661f +\u3014\u666f\u9580\u3015\u9580 +\u3014\u87a3\u86c7\u3015\u795e \u2192 3\u5206(\u5409)",
                            "\u6a94\u4f4d\u5165\u5764\u4e8c(\u897f\u5357): \u3014\u5929\u4efb\u3015\u661f +\u3014\u6b7b\u9580\u3015\u9580 +\u3014\u592a\u9670\u3015\u795e \u2192 0\u5206(\u5e73)",
                            "\u99ac\u540d\u300c\u5927\u300d\u5c6c\u4e2d\u884c \u2192 \u4e2d\u4e94: \u3014\u5929\u82ae\u3015\u661f +\u3014\u7121\u9580(\u4e2d\u5bae\u5bc4\u5764)\u3015\u9580 +\u3014\u7121\u795e(\u4e2d\u5bae\u5bc4\u5764)\u3015\u795e \u2192 -3\u5206(\u51f6)\uff08\u7b46\u756b\u4fee\u6b63 1\uff09",
                            "\u9a0e\u5e2b(\u7e3d\u7b46\u756b41) \u2192 \u4e7e\u516d(\u897f\u5317): \u3014\u5929\u885d\u3015\u661f +\u3014\u958b\u9580\u3015\u9580 +\u3014\u767d\u864e\u3015\u795e \u2192 2\u5206(\u5409)"
                        ],
                        "totalScore": 0.13
                    }
                },
                {
                    "rank": 3,
                    "horseNumber": 12,
                    "nameCh": "\u5e7b\u5f71\u65cb\u98a8",
                    "jockeyCh": "\u5df4\u5ea6",
                    "qimenScore": 0.13,
                    "actualFinish": 9,
                    "winOdds": 12,
                    "reason": {
                        "verdict": "\u2605 \u5947\u9580\u5e73\u548c\uff1a\u5409\u51f6\u4e92\u898b\uff0c\u7121\u660e\u986f\u52a9\u529b",
                        "breakdown": [
                            "\u99ac\u865f\u5165\u9707\u4e09(\u6771): \u3014\u5929\u82f1\u3015\u661f +\u3014\u50b7\u9580\u3015\u9580 +\u3014\u4e5d\u5929\u3015\u795e \u2192 -2\u5206(\u51f6)",
                            "\u6a94\u4f4d\u5165\u826e\u516b(\u6771\u5317): \u3014\u5929\u79bd\u3015\u661f +\u3014\u751f\u9580\u3015\u9580 +\u3014\u4e5d\u5730\u3015\u795e \u2192 4\u5206(\u5927\u5409)",
                            "\u99ac\u540d\u300c\u5e7b\u300d\u5c6c\u4e2d\u884c \u2192 \u4e2d\u4e94: \u3014\u5929\u82ae\u3015\u661f +\u3014\u7121\u9580(\u4e2d\u5bae\u5bc4\u5764)\u3015\u9580 +\u3014\u7121\u795e(\u4e2d\u5bae\u5bc4\u5764)\u3015\u795e \u2192 -3\u5206(\u51f6)\uff08\u7b46\u756b\u4fee\u6b63 5\uff09",
                            "\u9a0e\u5e2b(\u7e3d\u7b46\u756b15) \u2192 \u514c\u4e03(\u897f): \u3014\u5929\u8f14\u3015\u661f +\u3014\u9a5a\u9580\u3015\u9580 +\u3014\u516d\u5408\u3015\u795e \u2192 2\u5206(\u5409)"
                        ],
                        "totalScore": 0.13
                    }
                }
            ],
            "actualTop3": [
                {
                    "pos": 1,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "qimenRank": 2,
                    "qimenScore": 0.13,
                    "winOdds": 3.8
                },
                {
                    "pos": 2,
                    "horseNumber": 13,
                    "nameCh": "\u6771\u65b9\u9b45\u5f71",
                    "qimenRank": 7,
                    "qimenScore": -0.37,
                    "winOdds": 59
                },
                {
                    "pos": 3,
                    "horseNumber": 11,
                    "nameCh": "\u4e0a\u5e02\u9b45\u529b",
                    "qimenRank": 12,
                    "qimenScore": -0.75,
                    "winOdds": 3.5
                }
            ],
            "top1Hit": false,
            "top3AnyHit": true,
            "top3Intersect": 1
        }
    ],
    "generatedAt": "2026-05-09T16:23:33.249Z"
}
```
