# Phase 1 — REPORT — architecture-diagnostics

Loaded by `SKILL.md` Phase 1.

- `pathPattern` scopes JUDGED edges by SOURCE file (SDP: component dependency
  judged when ≥1 carrying file edge's source matches; silent coupling: by EITHER
  file of pair). Instability, facade adoption, strength cut always whole-graph —
  scoped run sees same numbers as full run.
- `norms: true` adds the dependency-norms view (bd rpx0v): the project's own
  precedents per (roleSrc, roleDst, locality), roles = each file's PRIMARY
  type's role (naming's type-role layer; suffix-only roles stay weak — never
  asserted). `response.norms` carries one ledger + direction test per language
  family + findings; `norms` violations flag every edge AGAINST its role pair's
  established direction (`misfit`, with `establishedDirection`). Absent flag =
  no norms block, no `norms` violations.
- `domain: "<dir>"` judges one directory AS ITS OWN SYSTEM (bd xb669.1): the
  induced sub-graph — files under the root, edges with both endpoints inside —
  and EVERY metric recomputed inside it. Not `pathPattern`, which keeps
  whole-graph metrics and only filters findings. `response.domain` carries
  `componentCount` / `levelCount` (the same numbers `summary.layering` holds)
  plus the border: `boundaryOut` / `boundaryIn`, aggregated per (inner,
  external) component, each naming the external component and its
  `externalLevel` on the WHOLE-graph stack — the one thing an internal view
  cannot recompute. Read `domain` first; the violations then describe the
  domain's own internals. Facade-aggregation edges never count as border.
- Tooling paths (scripts, spikes, benchmarks, examples, fixtures) removed before
  any detector — `summary.nonProduction` counts them.
- Test support removed too — file imported only by tests / other support AND
  evidence: named after test importing it (`X.spec.presets.tsx` ← `X.spec.tsx`;
  `worker.ts` ← `worker.test.ts` = reverse, no evidence), or imports test-only
  dep (package/file tests import, no production file does; or manifest dev-only
  — `devDependencies`, Gemfile `:development`/`:test` — tests import; never
  `node:*`), or imports other support, or sits in test dir (dir holds a test,
  every other indexed file there = test/support; file no test importing it is
  named after). `summary.testSupport` counts files
  - `testOnlyDependencyCount`. Worker loaded by module path, importing only
    production deps → stays production. Fixture importing only production code,
    not named after its test, alone in its dir or beside production → stays
    production (no evidence) — low count ≠ bug. Dev-tool file (codegen type,
    lint script) only a test imports + importing a devDependency → may count as
    support.
  - `developmentRootCount`: file nothing imports + imports manifest dev-only dep
    (value or `import type`) → non-production root (story, bundler/lint config);
    subtree only it reaches follows. Story-only component = excluded too (dead
    in production). Root/follower path literal naming a dir whose basename is a
    segment of its own name (`vite.prototypes.config.ts` → `'app/x/prototypes'`)
    → that dir's files nothing outside it imports (tests aside) = roots too
    (separate build's tree). Unrelated literal (`vitest.config.ts` →
    `'app/javascript'`) or imported package name → ignored.
- `limit` caps `violations` + `rootCauses` PER DETECTOR; each
  `summary.<detector>` keeps totals (`violationCount`, `rootCauseCount`).
  Totals > returned → say truncated.
- Each detector's `violations` ranked costliest-first (before `limit`) by
  `maintenanceCost` — except `shotgunSurgery` (Phase 3c2): tagged, not
  re-sorted. Carriers = files on edges that MAKE violation: named files; all
  file edges of component edge / knot cut; hub's boundary files; zone-of-pain's
  depended-on files; island / uselessness = all its files. `score` 0–1 =
  carriers' `meanPosition` (mean file `costPosition`) shrunk toward 0.5 by
  `n / (n + n₀)` — n = `measuredFileCount`, n₀ = (1/12) / between-violation
  variance over the WHOLE report, measured around the null mean 0.5 (empirical
  Bayes). A 1–2 file pair is pulled toward 0.5, a 7000-file knot keeps its mean,
  so scores compare ACROSS detectors; 0.5 = typical or unproven, all 0.5 =
  violations spread no more than noise. Use `meanPosition` + `measuredFileCount`
  for the raw reading. `hottestFile` = costliest carrier + churn/bugFix/recency
  positions + raw readings. Lead residual list with highest score. Absent = no
  git readings → detector order.
- Impact `tier` (bd r8hme.53) on SDP, leakingAbstraction, norms, layering
  backEdge/knot/abstractionBypass: `structural` = no carrying edge co-changes
  beyond chance; `active` = ≥1 carrying file-edge pair admitted by co-change
  gate; `critical` = active + admitted edge's source reach share ≥
  `summary.impactTiers.reachCut`. `tierEvidence`: admitted/total carrier pairs
  (full list, not 5-edge sample), ≤3 pairs, `sourceReach`. Family order = tier
  first (critical > active > structural > untiered), then `maintenanceCost`,
  before `limit`. Read `summary.impactTiers` first: per-detector counts, cut
  (`majority` = small-N fallback, weak), `notApplicable` (component/history
  findings, never tiered). `built: false` = no co-change history → no tier ≠
  structural. Lead with critical, then active; structural-only = cheap direction
  fix, low urgency.
- Every finding carries `detector`: `stableDependencies` (Phases 2–3),
  `leakingAbstraction` (Phase 3b), `silentCoupling` (Phase 3c), `mainSequence`
  (Phase 3d), `hubLikeDependency` (Phase 3d2) or `layering` (Phase 3e). Never
  mix groups across detectors.
