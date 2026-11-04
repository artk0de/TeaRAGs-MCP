# Retained attempts and limitations

- Initial new unit run: ten failed assertions, with six locator checks affected
  by an incomplete mock metadata setup. A second fixture attempt incorrectly
  used essentialTrajectoryFields (git selection). Both logs retained. Corrected
  fixtures declare actual payloadSignals; expected assertions are unchanged.
- Valid RED: ten missing-option/duplicate-locator assertions and one changed-tree
  representative assertion. Implementation followed this valid RED.
- Initial GREEN: 266 pass, one schema-size check fails at 4119 > 4000. The cap
  remains 4000; the vector filter hint now points at the existing filters guide.
  Actual tools/list schema is 3920 characters; affected schema checks pass.
- Generator checks: 63/63, followed only by the affected entrypoint budget check
  after the final short wording clarification. No full repository suite run.
- First backend snapshot: pre-review seven-file production patch, 7879 exact
  runtime files. No model actors used it. Retained privately with its manifest
  and successful locator probe; it is not the accepted runtime.
- Review found a pre-existing critical public-DTO -> explore-domain dependency.
  Move the identical SearchConfidence type to the existing search-result contract,
  keep its old domain re-export, and retarget the DTO. Confidence baselines passed
  before this behavior-neutral move. Afterward 292 affected tests pass, build
  passes, and the new nine-file production patch is sealed separately.
- A nine-file MCP re-review did not return before its executor was canceled.
  This is not a passing review or a model eval. The equivalent CLI review over
  all nine files completed in 7.19s: all five sections built, no truncation,
  introduced=0, critical dependency resolved, touchedActive empty. One dependency
  norm is explicitly UNJUDGED/untypedRole. Native MCP reload was requested;
  the cause of the stalled request remains unconfirmed.
- Before model launch, all five fresh profiles actually exposed distinctFiles
  as a boolean on semantic_search and hybrid_search. Exact 17 read-only tools,
  18 skills, 14 trusted hooks, one plugin, zero prior model turns. Immutable
  runtime/source and plugin hash guards remain enabled. Runtime count 7879.
- D01 validates native locator serialization, preset usability and scheduling.
  It does not prove all hybrid hits are equally relevant or that ranking quality
  improved: the model explicitly identified the broader workflow hits.

Raw native journals remain private; public exports contain actions, final answers,
source locators/hashes and numeric usage only. Prefix caching is observed; no
claim that provider prompt caching was disabled. No B or Claude run.

## H8 launch

- All five H7 cases completed once. Factual and routing gates pass; the complete
  Q01/Q03 pair takes longer than H2 despite lower input. H7 is not an established
  latency win. Keep the detailed H7 verdicts and as-run grading unchanged.
- Formatting produced a separate sealed snapshot under `formatted/`. It is NOT
  used in H8: the new four-case stage uses the exact H7 `review-repair` runtime
  and its original production patch. No canonical-build equivalence is assumed.
- H8 uses Q01/Q03/W01/U01, gpt-6.1-sol/medium, n=1, A only. Each fresh profile
  passed isolation and zero-turn checks before launch. All 17 native tool
  definitions match H7 exactly; their canonical JSON SHA-256 is
  `11fe439ab82567d140c1a741e268fc3bd63e59b205426010828b6d505bd53d35`.
- The changed answer rule and shortened schema-routing prose form one wording
  intervention. Do not attribute all differences to table formatting alone.
- H8's existing 4800-character entrypoint budget check passes. Native model
  results and factual/format grading remain pending at launch; no retry allowed
  without preserving the attempt and identifying a relevant correction.
