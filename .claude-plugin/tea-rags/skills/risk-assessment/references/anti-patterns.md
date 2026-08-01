# Anti-patterns

Full list of risk-assessment anti-patterns. The top 3 are also inlined in
SKILL.md near the top for skim safety; the rest live here.

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
