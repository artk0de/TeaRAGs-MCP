# Distinct-file chunk locators

Base: main 08673b95bd9f3196cd6cef6779e9c6e257748b99, installed plugin 0.55.7.
Candidate: plugin 0.55.8 and a newly built, separately sealed backend.

The previous H5 distinct-file policy returned file rows, losing symbol/line
locators. VectorSearchStrategy already groups Qdrant results by relativePath;
BaseExploreStrategy deliberately strips chunk fields only for level=file.
Keep this existing file-level contract. Add optional distinctFiles to semantic
and hybrid search, selecting one representative per file at the requested
chunk level. Default absent/false is unchanged. Reuse FileLevelGrouper.group and
fetchPathPatternMatches for single/fused queries and working-tree overlays.

MODE MODIFY. Strategy STANDARD: inspected targets have healthy bugFixRate,
recent age and high/extreme commit counts, normal churn; no hard risk rule
matches. No custom strategy matched the scoped inventory. Reuse held source
bodies; no directory tour, architecture report or index mutation in the linked
worktree. No new production helper or dependency; existing grouping owns it.
NEW_TERM distinctFiles: optional file diversity independent of signal/payload
level. groupByFile is the predicate for existing file mode or this option.

Baseline: 142 tests across six affected files, seven facade tests and 72
contract/ops tests pass. New assertions initially had a faulty metadata fixture
and are retained separately. Correct fixture uses declared payloadSignals,
not essentialTrajectoryFields (which select git fields). Assertions unchanged.
Validated RED: ten failures for missing option/duplicate-file locators, plus
one working-tree representative failure; no production edit before this RED.
The initial GREEN has 266 pass and one existing schema-size gate failure.
Keep the 4000-character limit. Replace the vector filter's catalog prose with
the same call contract and existing filters guide; preserve accepted filters.

Codex Explore requests distinctFiles with metaOnly and production test exclusion
for independent source topics. Its existing explicit spec/test routes override
that default. Shared Core and Claude/Cursor skill bodies remain unchanged.

Native gate: gpt-6.1-sol/medium, n=1, A only; Q01/Q03/W01 plus retained-body R01
and a locator/filter D01 control. Independent fresh homes and histories,
controller-only grading, raw prompts separate from expectations. No B/Claude.
Use a NEW sealed backend containing this implementation, not the prior 0.55.4
runtime. Preserve exact file/hash guards and fail closed on any mismatch.
Provider prefix caching is recorded, not described as disabled answer caching.

Mechanism acceptance: actual observed distinctFiles calls, one row per file,
relativePath plus symbol/line locators under metaOnly, directly readable body
addresses, unchanged focused-body reuse and usable production filter preset.
Factual Q01/Q03 grading is unchanged, including complete dispatch/background
contract, persisted entity reuse and VCR recording scrubbing. No missing fact
can be exchanged for lower cost. Compare the WHOLE Q01/Q03 policy against H2
(22 steps, 211.391s, 122141 fresh / 719104 cached / 7873 output); never pool
per-case winners. If the global rule regresses, reject its automatic use and
retain failed evidence. Unit tests and generator budgets do not replace actors.
