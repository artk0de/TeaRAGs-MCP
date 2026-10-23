# Signal Labels

Label = human-readable reading of a numeric signal value vs current codebase
distribution. From percentile thresholds (`tea-rags://project/<alias>/metrics`),
attached to ranking overlay results automatically.

## How Labels Work

Each numeric signal declares percentile→label mappings. Result with ranking
overlay → numeric values carry labels:

```json
{ "commitCount": { "value": 12, "label": "high" } }
```

Label = percentile bucket the value falls in. Actual thresholds for your codebase:
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`.

## Scoped Thresholds

Signal stats split into **source** (production) and **test** scopes — test
churn/size differs; separate thresholds keep test noise out of production labels.

Metrics resource (`section=labelMap`) exposes:
```
signals[language][signal][scope].labelMap
```

Example: `signals["ruby"]["git.file.commitCount"]["source"].labelMap`
→ `{ low: 2, typical: 5, high: 10, extreme: 25 }`

Language with indexed test chunks → `"test"` scope with own thresholds. Reranker
picks the right scope automatically.

<!-- data:label-tables -->

## Label Resolution Algorithm

1. Thresholds walked in ascending percentile order
2. Each label covers [its threshold, next threshold)
3. First label covers everything below its threshold
4. Last label covers everything at or above its threshold

Example: commitCount with thresholds p25=2, p50=5, p75=12, p95=30
- value 1 → "low" (below p25)
- value 8 → "typical" (between p50 and p75)
- value 35 → "extreme" (above p95)
