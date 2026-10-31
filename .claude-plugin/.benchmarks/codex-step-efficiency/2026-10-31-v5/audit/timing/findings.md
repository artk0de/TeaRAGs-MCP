# Offline timing audit

Reproduce: `python3 .tmp/codex-speed-v5-audit-2026-10-31/timing/analyze.py --test` (3 union/clipping tests), then the same script without `--test`. No models, benchmarks, production files, runner files, or raw inputs were changed. Metadata parser never accesses reasoning text, summaries, or encrypted reasoning.

| Metric | Latest A | Reference B | Previous A |
|---|---:|---:|---:|
| Controller actor seconds | 1032.740 | 547.348 | 874.223 |
| Controller verification seconds | 338.178 | 579.924 | 416.716 |
| Sum question actor seconds | 1031.287 | 546.058 | 873.233 |
| Native turn seconds | 1026.831 | 540.245 | 872.066 |
| Responses | 114 | 104 | 115 |
| Tool / final responses | 75 / 39 | 65 / 39 | 76 / 39 |
| Commentary-only / empty responses | 0 / 0 | 0 / 0 | 0 / 0 |
| Native tool interval union seconds | 17.361 | 30.725 | 16.367 |
| Hook observed interval union seconds | 24.223 | 0 | 27.468 |
| Native tools + hooks union seconds | 39.426 | 30.725 | 42.860 |
| Outer executor union seconds | 37.307 | 41.861 | 41.052 |
| All measured runtime union seconds | 44.848 | 41.861 | 49.260 |
| Native-turn residual seconds | 981.983 | 498.384 | 822.806 |
| Input tokens | 15,430,213 | 14,330,994 | 15,819,154 |
| Cached input tokens | 15,234,432 | 14,124,544 | 15,633,408 |
| Cache share | 98.731% | 98.559% | 98.826% |
| Output / reasoning output tokens | 32,899 / 2,559 | 28,979 / 615 | 34,392 / 4,973 |
| Reasoning item count (metadata only) | 48 | 20 | 60 |

Latest A's +485.392 controller actor seconds versus B decompose into +483.599 native-turn residual, +2.987 measured runtime union, and -1.194 outside-native-turn controller overhead. Residual means model/network/client/queue/service time not covered by observed runtime; it is **not pure inference**. The residual accounts for 99.63% of the controller actor delta. Native tools themselves are faster in A by 13.364 seconds. Hooks cost observed wall time, but their overlapping total cannot explain this delta. Summing hook handler durations would be wrong: latest A has 563 handler completions, 65.833s summed declared handler duration, but only 24.223s union of observed hook windows.

The residual increase is concentrated in final-response intervals: +315.410s final residual and +168.704s tool-response residual. The remaining -0.515s residual delta is the difference in turn tails after final response completion. A final interval includes generation/streaming of the final answer; the trace lacks native response request-start timestamps. Q01's final response (`resp_0774613464b3f479016ae605623e80819191db2234522a2d0d`) completes 50.846s after its last tool output; B's equivalent is 23.047s and previous A's is 24.968s. This is a measured gap, not evidence about private reasoning.

| Question | Latest A minus B actor seconds | Response delta | Measured runtime delta |
|---|---:|---:|---:|
| Q01 | +56.394 | +2 | +2.491 |
| Q02 | +49.467 | +3 | +3.945 |
| Q03 | +44.895 | +2 | +1.761 |
| Q04 | +30.492 | -1 | +0.121 |
| Q06 | +29.753 | 0 | -4.067 |
| Q15 | +24.995 | +1 | +0.410 |
| Q30 | +23.301 | +1 | +1.597 |
| Q12 | +22.427 | +3 | +0.346 |

Top three questions contribute 150.756s (31.1%) and top eight 281.724s (58.0%) of the +485.229s summed-question delta. The first six contribute 201.206s (41.5%). 32/39 questions are slower. The 16 questions with equal response counts still contribute +142.678s, so +10 extra responses do not explain all slowdown.

Latest A versus previous A: +158.517 controller actor seconds despite **one fewer response**, 1,493 fewer output tokens, 2,414 fewer reasoning tokens, and 4.412s less measured runtime. Residual rises +159.177s. 30/39 questions are slower; median per-question wall ratio is 1.167. The 25 equal-response-count questions contribute +109.233s while emitting 1,087 fewer output tokens. This is consistent with a broad temporal/service/client slowdown confound, but cannot identify its cause or establish a controlled temporal effect: runs were not interleaved and content/plugin behavior can differ. Input cache was heavily warm in every run; the cache fractions do not support a simple cache-miss explanation. Prefix cache/load/service differences remain uncontrolled.

There are no actor `wait`/`write_stdin` calls and no commentary-only or empty responses in these three runs. Latest A's 29 commentary messages share responses with tool calls; removing their text does not automatically remove model steps. Each extra tool response is a real continuation boundary; opportunities should target dependency-independent tool batching or eliminating unnecessary tool waves, not alleged executor-wait responses. All executor calls here are `exec`; outer execution is separately recorded and unioned with native nested tools/hooks rather than double counted.

`accounting.json` preserves all 39 question IDs per run, all actual response IDs and native usage, per-response categories and completion windows, item/call IDs, event indices for executor calls/results, exact measured interval endpoints, and per-input SHA-256 fingerprints. Assertions verify every response ID, count, and usage field against controller/native accounting; all tool outputs match and intervals have valid timestamps. Native tool timestamps are item start/end; hook windows are observed notification start/completion timestamps and can reflect buffering; executor windows are call-item completion through matching output-item completion. The small controller versus summed-question/native-turn discrepancies are explicitly retained in totals. No quality/correctness grades are inferred.
