# Top Anti-patterns — architecture-diagnostics

Loaded by `SKILL.md` Top Anti-patterns.

- **Reading flat `violations` first.** N violations into one target = ONE
  defect. Fix target, not N sources.
- **`edgeCount: 0` read as clean.** Nothing read ≠ no violations. No codegraph
  DB or empty graph — say so.
- **Ignoring `containment` / `lowConnectionCount`.** Excluded, not clean — see
  Phase 4.
- **Reading SDP as file-level.** SDP judged on COMPONENTS; file edges in
  `evidence.fileEdges` only show which files carry the dependency.
- **Using risk-assessment signals (churn, bugFixRate) here.** Other question.
  Combine only when user asks both. Exception: per-violation `maintenanceCost` —
  report's own fix PRIORITY, never verdict.
- **Proposing tolerance change.** Tolerance fixed, reported in
  `summary.stableDependencies.tolerance`. Not caller knob.
- **Prescribing a new module layout from leak lines.** Diagnosis, not
  prescription: a leak says importer walked past surface its peers use — not how
  module should be drawn.
- **Reading `facade-not-adopted` as a leak.** Nobody uses that facade → no
  boundary to leak past. Not judged, not clean.
- **`silentCoupling.built: false` read as clean.** No co-change build (git
  trajectory off, or no index run yet) — say "not built", never "no hidden
  coupling".
- **`mainSequence` judged 0 read as balanced.** `excluded.unmeasured` > 0 =
  index predates type census — say "needs codegraph recompute".
  `unobservableAbstractness` = language rarely declares abstractions (Ruby duck
  typing) — A 0 is idiom, not verdict.
- **`entryPoint: true` distance read as placement defect.** Declared cli/mcp
  entry surface — unstable end of main sequence is where it BELONGS; nothing
  imports it. Triage data, never suppression.
- **`preExisting: true` finding read as diff-introduced.** The base already
  holds the violation — the diff touches it, did not add it. Real finding;
  triage data, never suppression. Meaning per family: cycles /
  leakingAbstraction = the edge already exists; stableDependencies = base held
  another edge of the same component pair (base, or index for unchanged files);
  mainSequence = `distanceBefore` already past the threshold; layeringBackEdge =
  component pair already carried by another file edge; hubLike = already a hub
  before the diff. facadeContract / silentCoupling / splitCandidates never carry
  it.
- **`remedy` ignored or paraphrased.** `remedy` (`retargetImport` /
  `restoreExport`) is a dry-run-verified cheap repair — quote it verbatim in the
  recommendation (file, names, target), never reword it into a vague "use the
  facade". Absent = none qualified, not "none exists".
- **`layerMap` expected in a bare report.** `response.layerMap` appears ONLY
  when the request carried `layerMap` — absent = not asked, never "no layers".
- **`island` / `compositionCycle` read as violations.** Informational findings —
  count separately, say informational.
- **`knot` with `composition: true` read as a defect.** Every edge joins a
  directory to one nested inside it — composition of a module with its own
  sub-parts, not a layering defect.
- **Map `scopePathPattern` confused with report `pathPattern`.** The report's
  scopes JUDGED edges by source; the map's picks map MEMBERS (induced subgraph).
  Independent — one, both, or neither.
