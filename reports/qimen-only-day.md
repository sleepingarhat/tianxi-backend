# Pure Qimen one-day backtest @ 2026-05-09T16:09:57Z

GET https://tianxi-backend.tianxi-entertainment.workers.dev/api/analyze/qimen-only-day

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
                    "winOdds": 6.3
                },
                {
                    "rank": 2,
                    "horseNumber": 9,
                    "nameCh": "\u5927\u5229\u597d\u904b",
                    "jockeyCh": "\u5e03\u6587",
                    "qimenScore": 0.13,
                    "actualFinish": 1,
                    "winOdds": 3.8
                },
                {
                    "rank": 3,
                    "horseNumber": 12,
                    "nameCh": "\u5e7b\u5f71\u65cb\u98a8",
                    "jockeyCh": "\u5df4\u5ea6",
                    "qimenScore": 0.13,
                    "actualFinish": 9,
                    "winOdds": 12
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
    "generatedAt": "2026-05-09T16:09:58.095Z"
}
