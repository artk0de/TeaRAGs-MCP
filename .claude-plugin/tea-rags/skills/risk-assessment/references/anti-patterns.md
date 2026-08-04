# Anti-patterns

Full list of risk-assessment anti-patterns. The most damaging few are also
inlined in SKILL.md near the top for skim safety; the rest live here.

- **Using bug-hunt for risk assessment.** bug-hunt finds ONE root cause. This
  skill scans the risk surface.
- **Exhaustive scope resolution.** One semantic/hybrid call. Don't find_similar
  to expand scope — that's pattern-search's job.
- **Reading full files.** Chunk coordinates exist. Use them.
- **Paginating all 3 presets to page 3.** If gradient drops on page 1 — stop.
- **Reporting 1/N overlap as risk.** Single-preset hits are noise. Minimum 2/N
  for Medium.
- **find_similar from Medium candidates.** Only Critical warrants expansion.
- **Braces with slashes in pathPattern.** Extract directory prefixes instead.
- **Single unfiltered scan for broad scope.** Dominant-churn domain takes 100%
  of slots. Always run stratified second scan with `!**/dominant/**`.
- **Scanning tests and documentation as risk surface.** Dimension presets
  (`panicZone`, `godMethods`, …) select a RISK profile, not a code population.
  Tests routinely make up half an index and churn hardest — they change with
  every feature — so they outrank production code on every churn-weighted
  preset. Every Phase 1/1b call carries `testFile: "exclude"` +
  `documentation: "exclude"`.
- **Reaching for `presets: "production"` instead.** It excludes tests and docs
  but ALSO `chunkType: "block"`, silently dropping barrel files, config objects
  and top-level constant blocks — which can be hubs (a barrel re-export with
  `fanIn: 11` is real blast radius). The two explicit params exclude the same
  tests and docs with no block casualty.
- **Letting Phase 1b rank over non-shipping trees.** `decomposition` and
  `godModule` rank on raw size, so one oversized harness or generated file wins
  every slot by construction — a 14059-LOC measurement script took BOTH presets'
  entire output and buried every production module. Scope Phase 1b to the source
  root. `production` does not help: a script is neither test nor doc.
- **One batched `hybrid_search` for test coverage.** BM25 scores the joined
  symbol names as a single bag of terms, so whichever domain owns the largest
  test files takes every slot. Everything else returns empty and gets reported
  as "untested risk zone" — a fabricated finding that looks indistinguishable
  from a real one. Observed live: 3 of 5 "untested" verdicts were false; a
  second stratified call found the tests immediately. Stratify by domain
  cluster, or use `find_symbol({relativePath})` for an exact lookup.
- **Reporting "untested" from a call another domain dominated.** Absence of a
  symbol in a crowded result set is not evidence of absence in the repo. No
  verdict until the candidate has been queried in its own cluster.
- **find_similar without negativeIds.** Healthy-demoted candidates from MERGE
  are free negative examples. Always pass them to shift results toward
  antipatterns and away from active-but-clean code.
- **Classifying from a single signal.** "High churn" alone does not imply any
  class. Check companion signals (`imports`, `bugFixRate`, `ageDays`,
  `blockPenalty`) before picking a label. See
  `../../../rules/references/signal-interpretation.md`.
- **Treating mono ownership as a risk by default.** Healthy owner of stable
  mature code is an asset. Toxic silo requires pairing with bugFixRate or churn.
- **Ignoring `imports` when classifying churn-heavy files.** Without fan-in, god
  module and bug attractor look identical — they need opposite remediation.
- **Reporting feature-in-progress or boilerplate churn as risks.** High churn on
  a new single-author file with healthy bugFixRate is normal development. High
  churn on a DTO with high blockPenalty is boilerplate, not a hotspot.
- **Running decomposition as a post-filter over risk hits.** That was the old
  Phase 4.3, and it made a large but git-quiet method unreachable — it never
  entered the risk map, so nothing could filter it in. Phase 1b scans the
  structural axis independently.
- **Merging structural hits into overlap tiers.** Size is not risk. Structural
  candidates get their own section, annotated with risk and fix cost.
- **Claiming `cheap` from missing signals.** Codegraph off → fanIn /
  transitiveImpact / pageRank score 0 and the fix-cost estimate is partial, not
  cheap.
- **Standalone refactoring hunt through this skill.** Want decomposition
  candidates with no risk question attached → `refactoring-scan`.
  `risk-assessment` surfaces structural debt only within the assessment scope,
  annotated with risk and cost.
