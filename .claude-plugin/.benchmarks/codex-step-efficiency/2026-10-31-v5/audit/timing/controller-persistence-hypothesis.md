# Controller persistence hypothesis: offline replay

The frozen controller performs expensive quadratic persistence, but this replay **does not reproduce enough observer/backpressure delay to explain the full historical slowdown**. Controller work is a real confound; the remaining residual still cannot be assigned causally to model/service latency.

Frozen-source inspection confirms that `codex61_runner.py` lines 99–103 append **every** callback event and rewrite the entire observed list through `dump` (`json.dumps(..., ensure_ascii=False, indent=2) + '\n'`, then `Path.write_text`). `protocol.py` invokes the callback synchronously before feeding `TurnObserver`, for both pending events and queued events. `codex61_app_rpc.py` has a separate background reader that writes+flushes raw JSONL, parses the line, and adds it to an unbounded queue. Only frozen-corpus verification time is subtracted from reported actor wall time. Thus persistence is charged to actor time, and native `emittedAtMs` timestamps alone cannot rule out stdout/GIL backpressure.

Exact extracted frozen `dump` was replayed into disposable files, with no original writes, live RPC, models, inference, or paced sleeps. All 39 questions in each run were replayed once under the current tool-shell Python 3.9.6. The three frozen `dump` function ASTs are identical.

| Full 39-question replay / inventory | Latest A | Reference B | Previous A |
|---|---:|---:|---:|
| Event count | 22,641 | 21,475 | 21,811 |
| Visible-message delta event count, all phases | 19,874 | 19,677 | 18,841 |
| Final per-question event files, total bytes | 20,908,672 | 19,773,093 | 21,134,313 |
| Cumulative bytes rewritten by callback | 9,633,557,260 | 8,281,250,623 | 8,923,939,452 |
| Persistence-only wall seconds | 159.338 | 106.707 | 147.907 |
| Persistence-only CPU seconds | 157.139 | 105.192 | 146.411 |
| Historical controller actor seconds | 1032.740 | 547.348 | 874.223 |

On the same replay interpreter, latest A adds **52.631s persistence work versus B** and **11.431s versus previous A**; these are much smaller than the historical +485.392s/+158.517s actor differences. For Q02–Q39, persistence work during the final visible-message event segment is 119.602s/80.537s/114.091s respectively: +39.065s latest A versus B, compared with +249.756s observed visible-stream difference over those same 38 questions. Initial Q01 replay predates phase counters, so no full-39 same-interpreter phase total is invented.

**These replay seconds are not directly subtractable from historical actor seconds.** Live persistence CPU can overlap network/model waiting. The historical controller-minus-native-turn totals are just 5.909s/7.103s/2.157s, respectively. Explaining stretched native visible streaming therefore requires actual observer-to-server coupling/backpressure, rather than expensive callback work alone.

Q01 is a matched slow-case control. Latest A has 2,253 events, a 1,482,450-byte final event file, and 2,238,103,218 cumulative rewritten bytes; B has 2,142 events / 1,277,972 final bytes / 1,815,849,477 rewritten bytes; previous A has 1,816 events / 1,384,486 final bytes / 1,719,356,863 rewritten bytes.

| Q01 persistence-only wall seconds | Latest A | Reference B | Previous A |
|---|---:|---:|---:|
| Current Python 3.9.6 | 27.505 | 20.478 | 20.767 |
| Explicit Homebrew Python 3.15.0 | 7.311 | 5.633 | 5.234 |

The alternate-interpreter calibration makes interpreter pinning essential: Q01 dump work is approximately 3.6–4.0 times faster on measured Python 3.15. No whole-run 3.15 extrapolation is treated as measured. The calibration stopped after Q01 in all three runs because it exceeded the chosen 5-second cheap-calibration threshold. B/prior-A controller modules have `cpython-315.pyc` files; latest A has only an MCP-proxy `cpython-315.pyc`. Cache tags establish that a 3.15 import occurred, **not** the historical controller executable. No historical `sys.executable` record was located in searched provenance logs/JSON/text. Latest root launch used literal `python3`, whose resolution depends on PATH. Historical interpreter identity remains unproven.

A separate unpaced background-reader probe mirrors raw JSONL write+flush, `json.loads`, and the unbounded queue, with the consumer optionally performing exact persistence. This isolates present-machine queue/GIL contention without a real RPC or live server:

| Q01 reader probe | Latest A | Reference B |
|---|---:|---:|
| Reader drains all events, persistence disabled | 0.034s | 0.028s |
| Reader drains all events, persistence enabled | 0.457s | 0.186s |
| Maximum observed reader delivery gap, enabled | 9.43ms | 2.75ms |
| Main consumer total wall, enabled | 26.788s | 18.543s |

Contention is observable, but the reader drains an entire historical Q01 stream in under half a second while persistence continues for tens of seconds. This does **not** reproduce a reader bottleneck on the scale of the +273.107s whole-run visible-stream gap. The probe uses in-memory historical lines, without a live stdout pipe, server pacing, actual socket traffic, or historical machine load, so it cannot conclusively rule out historical backpressure. It rejects treating the expensive callback alone as demonstrated causation, and does not establish server causation either.

All three `thread-start.json` effective fields match: model `gpt-6.1-sol`, provider `openai`, reasoning effort `medium`, `serviceTier: null`; no `speed` field is present. A null requested/effective field does not establish identical actual service conditions. Usage metadata has no explicit latency/queue/service-tier timing metrics, as documented in the earlier refinement.

Next measurement should pin and record controller interpreter/version, record reader receipt/queue/callback monotonic timestamps and callback CPU time, and avoid rewriting the full accumulated fixture on every delta. Append-only raw evidence plus bounded checkpoints preserves evidence while removing this known observer workload. This audit makes no runner changes or new actor requests.

Artifacts and validation:

- `controller-persistence-hypothesis.json`: all 117 per-question inventories and direct replay timings, source-module fingerprints, four queue/reader probes.
- `controller-persistence-hypothesis-python315.json`: three alternate-interpreter Q01 calibrations, interpreter and script fingerprints.
- `controller-persistence-hypothesis-summary.json`: aggregates, comparison deltas, explicit limitations and phase coverage.
- `controller-persistence-hypothesis-environment.json`: current executable/version/platform, historical pycache hints, effective thread fields, script fingerprints.
- `persistence_replay.py`, `persistence_calibration.py`, `persistence_summarize.py`, `persistence_validation.py`: reproducible source. Run `python3 .../persistence_validation.py` for three model-free tests; run the summarizer to regenerate aggregates without repeating replays. Replay commands are expensive and append observations; existing attempts are retained.

All 117 source-file SHA-256 fingerprints match the original accounting; exact reserialization matches every original fixture byte-for-byte. Every replay output matches the frozen dump of its full event list. Three tests pass: Unicode/exact cumulative-prefix bytes, frozen dump fidelity/no input mutation, and equality of all frozen dump ASTs. Original accounting remains byte-for-byte unchanged. Only event metadata/counters and serialization fidelity were analyzed; no private reasoning content was inspected or emitted. Replay CPU/filesystem conditions are current-machine measurements, not reconstructed historical load.
