# Codex step efficiency and controller IO, v5

This investigation separates model-response scheduling from transcript-controller
overhead and unexplained streaming latency. It does not rerun the full B benchmark.
The full-run comparison uses retained n=1 sessions; it is not a controlled causal
estimate of plugin speed.

## Historical full runs

| Measure | Latest A | Retained B | Previous A |
|---|---:|---:|---:|
| Questions with observed final answers | 39 | 39 | 39 |
| Native model responses, including finals | 114 | 104 | 115 |
| Actor wall, seconds | 1032.740 | 547.348 | 874.223 |
| Union of measured tool/hook/executor intervals, seconds | 44.848 | 41.861 | 49.260 |
| Native-turn residual, seconds | 981.983 | 498.384 | 822.806 |
| Input tokens | 15,430,213 | 14,330,994 | 15,819,154 |
| Cached input tokens | 15,234,432 | 14,124,544 | 15,633,408 |
| Fresh input tokens | 195,781 | 206,450 | 185,746 |
| Output tokens | 32,899 | 28,979 | 34,392 |
| API-equivalent USD | 2.2439952 | 2.1151444 | 2.2787528 |
| Quality | NOT GRADED | 36 pass, 3 unknown | 34 pass, 2 partial, 3 unknown |

All actors use gpt-6.1-sol, medium effort. Token accounting and response IDs reconcile
with native events. Output tokens already include reasoning tokens; do not charge
that subset again. Costs use $2/M fresh input, $0.10/M cached input and $10/M output
for these recorded below-threshold contexts. These are API equivalents, not
subscription charges. Corpus verification is excluded from actor wall and recorded
separately in the source evidence.

Only 2.987 seconds of the 485.392-second A–B actor gap is extra measured runtime.
The native-turn residual includes service, network and client work, not just model
inference. Final-response visible text has nearly equal byte counts, but the latest
A spent 450.184 seconds between first and last visible deltas versus B's 177.077.
Old events do not identify which component caused that difference. Previous A also
had more responses and output yet finished faster than latest A.

## Fixes and experiments

1. Replace repeated full per-question JSON rewrites with a flushed append journal
   and one final snapshot. `repro/` contains the future A-only controller, recovery
   support, pinned interpreter identity, explicit optimized-Python rejection and
   collector-error exit propagation. Sixteen focused offline tests pass. No full
   benchmark is launched by these tests.
2. Verify the IO change by replaying the same opaque Q01 events once through each
   persistence implementation with the same Python 3.15. Old: 2,239,585,668 bytes,
   8.0472 seconds. New: 2,673,619 bytes, 0.03546 seconds. Event order, duplicates
   and content are preserved. This isolated measurement is not a live model speed
   improvement; persistence can overlap model/service time.
3. Test a narrow Codex scheduling replacement using five original literal
   questions and authentic retained **outer-visible** tool results. Baseline and
   candidate each get one fresh actor per case with the actual shipped native
   plugin path and the same real 17-tool backend. Prompts/fixtures are in
   `cases.json`; expected behavior and grading remain in `grading.json`, never
   actor context. The first replacement (`queued`) is **DO_NOT_ADOPT**: 27 → 26
   responses, 2.9% higher API-equivalent cost, Q21 scheduling still open. A second
   correction (`flat`) takes 28 responses and costs $0.4844960. Both policy
   replacements are **DO_NOT_ADOPT_FROM_CURRENT_STARTUP_CONFOUNDED_N1**; the
   production generator remains unchanged.

The short baseline takes 27 model responses. Q21 reads known missing bodies in
two groups whose combined 9.9 KB fits the existing budget. That alone does not
prove an avoidable response: W1 exposes metric/helper relations and W2 obtains
actual operation labels. The superseding depth addendum marks source-wave
avoidability **UNPROVEN**, using the same dependency standard for every variant.
Q34 reads a
known spec separately from Gemfile. Q02 already batches literal and semantic
discovery: the original scheduling defect is **NO_REPRO** there. Q02's historical
activation/spec completeness remains **PARTIAL/UNKNOWN**, distinct from safe and
honest current-state reporting. Q35 and Q36 preserve genuine source dependencies.

| Short variant, five cases once each | Model responses | Input | Cached input | Fresh input | Output | API-equivalent USD |
|---|---:|---:|---:|---:|---:|---:|
| Current policy | 27 | 699,313 | 555,648 | 143,665 | 5,838 | 0.4012748 |
| Queued replacement | 26 | 721,785 | 575,360 | 146,425 | 6,247 | 0.4128560 |
| Flat replacement | 28 | 808,884 | 631,680 | 177,204 | 6,692 | 0.4844960 |

Flat Q21 has a valid two-source-wave path and three responses: a first body batch
shares the skill load; the second batch closes actual metric-label/failure-code
helper gaps and includes pending known callers. This is allowed merging into an
unavoidable dependent wave, not a failure merely because every known id was not
read first. Flat Q34 obtains additional explicit fixture-conformance tests; the
earlier variants establish the frozen rubric's helper/mock-assertion minimum but
do not establish those dedicated fixture tests. Preserve both coverage limits.

The native actor sends `turn/start` before its own MCP startup becomes ready.
Several initial code-mode catalogs are empty even though MCP is ready by executor
time; direct retained-name calls may work. This supports a catalog-snapshot race
hypothesis, not ongoing tool-execution unavailability. The new readiness guard
checks the exact 17-tool inventory on the actor's own RPC/thread before sending
the first question, with native notification waits and a bounded timeout.

Two fresh readiness-only controls use the original policy/profile, one attempt
each. Q02/Q35 take 9/4 responses versus the matching original baseline's 8/5:
**13 → 13** total and **9 → 9** source waves. Both have native ready inventory
before `turn/start` and nonempty first catalogs. Those two original baseline
catalogs were also nonempty, so these controls do not establish a causal repair
of the other variants' empty catalogs. Cost is $0.1845456 → $0.2061644; input
355,945 → 378,321, fresh 62,569 → 72,017, cached 293,376 → 306,304 and output
3,007 → 3,150. **Ordering verified; speed improvement NOT ESTABLISHED.**

All 17 attempts remain evidence, with Q02 historical completeness still unknown.
No additional models or policy tuning are part of this result. A direct test of
the previously empty-catalog variant with the readiness guard remains unrun.

CLI fallback is **NOT FIXED**: the original private shell PATH/filesystem profile
does not expose a usable `tea-rags` CLI. The narrow no-model experiment is
retained under `audit/readiness/`; its grants are not used by the actors. No
global CLI, broader controller access, or relaxed grading/auth boundaries were
introduced. The readiness correction changes the native MCP precondition only.

Two initial alleged duplicate-body reads were withdrawn: nested MCP delivery did
not imply the model saw the body after outer executor truncation. The correction
addenda in `audit/` supersede those initial claims. A held outline or filename is
not a held method body.

## Evidence boundaries

`audit/` retains accounting, timing analysis, controller replay and source-audit
corrections. `repro/evidence/` retains RED, GREEN and independent-review fixes.
`native-evals.tar.gz` retains opaque transcripts, visible outputs, sources,
manifests, native proofs, separate verdicts and all 17 model attempts. Its
inventory and completion marker verify every selected member's bytes. Failed
attempts remain visible. Do not infer an improvement from wording/unit tests.

Fresh local homes and threads prevent reuse of prior actor conversations, but
provider prompt caching and shared backend/index load are not controlled. No
reindex of the benchmark corpus, full B run, repeated case attempt, or full test
suite is part of this change. Short retained-context probes are not full-history
replays and cannot establish general benchmark speed or quality superiority.
