# Historical efficiency audit and controller evidence

This archive records the investigation preceding the v5 candidate. It does **not**
claim candidate success. It contains offline aggregate evidence and scripts, not
raw actor transcripts, private reasoning, auth files or actor homes. Native eval
transcripts, inventories and final answers are archived separately.

Historical hook IDs include actor-path labels ending in hooks.json. These are
provenance strings, not home contents or credentials; exact bytes and hashes are
preserved in the accounting archive.

## Historical comparison

All runs used requested model `gpt-6.1-sol`, medium effort, one run per condition,
with 39 questions and natural within-run context. Audited latest A is plugin
0.54.0 / commit ced48; do not assume it equals newest main or the candidate.
Historical controller executable identity was not recorded.

| Metric | Latest A | Reference B | Previous A |
|---|---:|---:|---:|
| Controller actor seconds | 1032.740 | 547.348 | 874.223 |
| Controller verification seconds | 338.178 | 579.924 | 416.716 |
| Native completed responses, final included | 114 | 104 | 115 |
| Tool / final responses | 75 / 39 | 65 / 39 | 76 / 39 |
| Measured runtime interval union, seconds | 44.848 | 41.861 | 49.260 |
| Native-turn residual, seconds | 981.983 | 498.384 | 822.806 |
| Observed final visible-stream seconds | 450.184 | 177.077 | 298.186 |
| Final visible UTF-8 bytes | 89,970 | 90,512 | 84,691 |
| Input tokens | 15,430,213 | 14,330,994 | 15,819,154 |
| Cached-input share | 98.731% | 98.559% | 98.826% |

Latest A adds 485.392 controller actor seconds versus B: +483.599 native-turn
residual, +2.987 measured runtime union, and -1.194 outside-native-turn overhead.
Residual is model/network/client/queue/service time outside observed intervals,
**not pure inference or proven plugin latency**. Native tool intervals themselves
are faster in A by 13.364 seconds. Union overlapping tools/hooks/executors; summed
handler durations would double-count. Nested calls are not model responses.

The +315.410-second final-response residual gap includes +273.107 seconds during
observed visible streaming (86.59%), despite 542 fewer final visible bytes.
Notifications are client-observed, not server token timestamps. The traces cannot
separate decoding, network delivery, buffering, client scheduling or service load.
Latest A is also 158.517 seconds slower than previous A despite one fewer response
and less output/reasoning token volume. Non-interleaved runs, warm prefix caches,
content differences and live service/load differences remain uncontrolled.
There were no actor wait/write_stdin or commentary-only responses to remove.

## Controller persistence and cause bounds

Frozen controller inspection found full-list JSON rewriting on every callback.
The original offline 39-question Python 3.9 replay measured 159.338 / 106.707 /
147.907 persistence wall seconds for latest A / B / previous A, respectively.
Those differences are smaller than the historical actor gaps and **cannot be
subtracted from historical wall time**: live persistence overlaps waiting and
would require demonstrated observer/backpressure coupling to stretch streaming.
The unpaced background-reader probe observed contention but drained Q01 in under
half a second; it did not reproduce the whole-run streaming gap.

Q01 calibration was substantially faster on explicit Python 3.15 than tool-shell
Python 3.9. Pycache hints prove an import under 3.15, not the historical controller
executable. Interpreter pinning is therefore a measurement requirement, not proof
of the historical cause. Requested serviceTier was null in all three effective
thread records; identical actual service conditions do not follow.

`controller/real-Q01-io-replay.json` is a separate, single same-interpreter
Python 3.15 comparison of exact old dump persistence and append-only persistence:
all 2,253 opaque events retain fidelity and order. Old writes total
2,239,585,668 bytes / 2,254 full-list snapshots / 8.047 seconds; new writes total
2,673,619 bytes / one full snapshot / 0.035 seconds. These are offline IO
observations, not model-time or historical-gap attribution. Old-then-new order,
cache/load, no live RPC and the measured helper source fingerprint are explicit.
The later runtime-guard/job-exit review fixes did not change append/snapshot logic;
this package does not perform a second replay or assert a new measurement.

## Source-audit corrections take precedence

Read `early/outer-output-correction.*` and
`late/outer-visibility-addendum.*` before the initial reports. Full inner native
MCP results do not prove what the actor received: actual outer
`custom_tool_call_output.output` is the visibility boundary.

The early initial claim that VerifyGrant and DisconnectAll bodies were already
held in Q01 is **withdrawn**. The relevant outer wrapper omitted 1,270 of 11,270
original tokens; later method reads may recover missing evidence. The initial
reports remain under `early/initial-findings.*` to preserve the failed attempt,
not as valid duplicate-read savings. No such savings should be inferred.

The RefusalsHelper locator and the relevant Q21 outline IDs positively survive
outer-output checks; a locator is still not a held body. The late initial
exhaustive “no body repetition” claim is withdrawn as UNVERIFIED. Top late
scheduling hypotheses have positive outer-output provenance, but their original
native-response savings remain counterfactual until evaluated.

## Baseline reproduction status; candidate pending

`baseline-status-crossreference.json` is an aggregate whitelist derived from the
separate native baseline verdict file, including its source hash and frozen
case/grading/controller hashes. Five baseline actors ran once (27 total native
responses); source/skill/schema setup responses remain counted and diagnosed
separately. No raw native transcript or final answer is bundled here.

| Extracted case | Baseline responses | Baseline conclusion |
|---|---:|---|
| Q02 independent discovery | 8 | **NO_REPRO** for initial semantic/literal concurrency; historical activation/original spec use PARTIAL/UNKNOWN |
| Q21 known missing groups | 5 | Current behavior complete; known ready source groups split across two evidence responses |
| Q34 held validation, missing gem | 3 | Current behavior complete; partial reproduction of independent ready-file splitting |
| Q35 missing helper control | 5 | Needed missing helper/source dependency preserved |
| Q36 migration locator control | 6 | Genuine discovery/read dependencies preserved |

Q21 includes one schema-only and one skill-only setup response; Q02 includes one
skill-only setup response. These are legitimate observations, not automatic
failures. Q21 and Q34 identify hypotheses worth testing against a candidate;
**candidate outcomes are pending in this archive**. Q02 is not relabeled a
baseline failure to manufacture improvement. Quality/history completeness and
scheduling efficiency stay separate.

These are n=1 compact extracted contexts, not replays of complete original
pre-question history. Additional genuine discovery, missing bodies, absence checks
and real tool setup remain legitimate. B's broad initial reads can become
accidentally relevant later, so B is not a universal optimal plan. No statistical
speed, quality or cost superiority follows from these records.

## Contents and provenance

- `timing/`: original metadata accounting, timing/stream refinements, persistence
  inventories/replays/calibration, limitations and six offline Python scripts.
- `early/`, `late/`: aggregate findings plus mandatory visibility corrections.
- `controller/`: aggregate same-interpreter old/new persistence comparison.
- `manifest.json`: per-artifact byte size, SHA256, source SHA256 and transformations.

Large safe-visible transcript dumps, full inner-body ledgers, selected raw extracts
and redundant console logs are omitted. Source event fingerprints and native IDs
remain in the aggregates. Omission does not establish source coverage or erase
failed attempts.

Scripts are archived unchanged with their original `.tmp/.../timing` layout
assumptions; they are not automatically runnable from this relocated archive.
Reproduction requires the separately retained matching raw sources and restoring
that layout or explicitly reviewing path configuration in a new copy. Some scripts
write aggregates or append replay observations; never silently overwrite retained
evidence. This packaging task ran no tests, actors, indexing, replay or build and
did not edit cases, grading, repro utilities or policy.
