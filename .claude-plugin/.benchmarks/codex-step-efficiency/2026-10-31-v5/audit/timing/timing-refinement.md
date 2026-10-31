# Final visible-output timing refinement

All 39 final answers in each run expose `item/agentMessage/delta` timestamps. First nonempty delta to final `agentMessage.completedAtMs` gives observed visible-stream duration. Subtracting the same runtime interval union used by the original audit partitions final-response residual exactly. No runtime intersects these observed final streams.

| Aggregate over 39 finals | Latest A | Reference B | Previous A |
|---|---:|---:|---:|
| Final-response residual seconds | 584.400 | 268.990 | 458.813 |
| Residual before first visible delta seconds | 133.343 | 91.307 | 159.980 |
| Observed visible-stream seconds | 450.184 | 177.077 | 298.186 |
| Residual after final message completion seconds | 0.873 | 0.606 | 0.647 |
| First-to-last visible delta seconds | 445.046 | 174.109 | 295.370 |
| Visible final text UTF-8 bytes | 89,970 | 90,512 | 84,691 |
| Approximate visible-token proxy: output minus reasoning | 19,116 | 18,873 | 18,117 |
| Proxy tokens / observed stream second | 42.46 | 106.58 | 60.76 |
| Visible bytes / observed stream second | 199.85 | 511.14 | 284.02 |

Latest A's **+315.410s final-response residual versus B** splits into **+42.036s before visible output, +273.107s during observed visible streaming, and +0.267s after message completion**. Thus 86.59% of this final-response gap occurs while visible text is streaming. Latest A emits 542 fewer final-text bytes than B; the substantial stream-duration difference cannot be explained simply by more visible bytes. The proxy final visible-token volume is only 1.29% larger. Latest A's observed stream takes 2.542 times B's; the aggregate proxy-token throughput is 60.16% lower. These are client-observed streaming measurements, not causal server generation-speed measurements.

The prior A control strengthens this distinction: latest A adds **151.998s visible-stream time** while its pre-output residual **decreases 26.637s**, resulting in +125.587s final-response residual after the +0.226s message-tail difference. Latest A has 6.23% more final visible bytes than prior A but 50.97% longer visible-stream duration. This points to an observed streaming-throughput confound that a simple model-step count does not capture. The evidence does not distinguish model decoding, network delivery, buffering, client scheduling, service load, or other causes.

Across all 333 raw response usage metadata records (114 latest A, 104 B, 115 prior A), the schema contains token totals, cached/cache-write tokens, reasoning tokens, and per-item token attribution. There are **no explicit latency, queue, duration, processing-time, first-token, or service-tier metrics** in `usageMetadata`. Attribution item IDs are wildcarded in the exported schema; attribution values and opaque metadata are not dumped. Private reasoning text, summaries, and encrypted content are never accessed.

The pre-output measurement starts at the previous response completion (or turn start for a one-response question), subtracts observed runtime until the first visible delta, and is labeled residual because response request-start and server first-token timestamps are unavailable. The first delta is an observed notification, not a guaranteed actual first generated token. Final text byte counts come from visible assistant output only. Output-minus-reasoning tokens are an approximate visible-token proxy, potentially including output overhead; no tokenizer or model was run. `agentMessage` start precedes first visible delta by only 0.400/0.416/0.201 total seconds over all 39 finals in latest A/B/prior A respectively.

Reproduce with `python3 .tmp/codex-speed-v5-audit-2026-10-31/timing/refine.py --test`, then the same script without `--test`. Two model-free tests cover residual partitioning with overlapping intervals and metadata ID redaction. All 117 final answers satisfy temporal ordering and exact per-item visible-delta byte reconciliation; partition sums match the original final residual to floating-point tolerance. Raw-event fingerprints match the original audit, and the script verifies that `accounting.json` remains byte-for-byte unchanged. Per-question item/response IDs, timestamps, delta event indices, counts, byte totals, and approximate rates are retained in `timing-refinement.json`.
