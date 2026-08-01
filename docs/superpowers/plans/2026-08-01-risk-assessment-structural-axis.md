# Risk Assessment Structural Axis — Implementation Plan

**Spec:**
`docs/superpowers/specs/2026-08-01-risk-assessment-structural-axis-design.md`
**Branch:** `worktree-risk-structural-axis` **Order:** T1 → T2 → {T3, T4} (T3
and T4 are independent of each other)

Every task is TDD: failing test first, then implementation, then commit. Full
suite (`npx vitest run`) and type-check must be green before each commit — the
pre-commit hook enforces both plus coverage. Never lower coverage thresholds;
write behavioral tests to close gaps. No `npm run build`, no `npm link`, no
reindex — more than one worktree is active and live validation is user-gated.

## T1 — symbol-mass payload signals

**Files:**

- `src/core/domains/ingest/pipeline/chunker/symbol-mass.ts` (new) — the
  post-pass
- the single chunker orchestration seam where a file's full chunk array exists
  after `parentSymbolId` resolution (investigate; candidates are the finalize
  path in `tree-sitter.ts` or the layer that receives the per-file chunk list —
  it must cover every code chunker, not one language)
- `src/core/domains/trajectory/static/payload-signals.ts` — three new
  descriptors with stats labels (exact labels and chunkTypeFilter in spec §A)

**Behavior (spec §A):** `memberCount` and `classLines` on class chunks,
`fileSymbolCount` flat on every code chunk. `#partN` folded, direct members
only, doc chunks excluded, `classLines = max(member endLine) − class startLine`.

**Tests first**
(`tests/core/domains/ingest/pipeline/chunker/symbol-mass.test.ts`):

- class with `#partN` split methods → folded to one member
- nested classes → inner members not counted in the outer class
- file with no classes → only `fileSymbolCount`, no class fields
- documentation file → no fields at all
- descriptor test: three descriptors registered, labels match spec §A

**Constraint to verify:** `fileSymbolCount` percentiles dedupe by `relativePath`
(follow `git.file.*` handling in collection stats); add a test proving a
many-chunk file contributes once.

**Commit:**
`feat(chunker): symbol-mass payload signals (memberCount, classLines, fileSymbolCount)`

## T2 — `symbolCount` derived signal + `godClass` preset

**Files:**

- `src/core/domains/trajectory/static/rerank/derived-signals/symbol-count.ts`
  (new) — normalizes `fileSymbolCount`, adaptive bounds p95, follow the existing
  derived-signal pattern in the directory
- `src/core/domains/trajectory/static/rerank/presets/god-class.ts` (new) — exact
  shape in spec §B (signalLevel file, weights
  `{similarity: 0.2, symbolCount: 0.8}`, overlayMask, four tools)
- registration: static presets `index.ts`, derived-signals `index.ts`

**Tests first:**

- preset resolves by name for all four tools; weights as specified
- overlayMask keys exist among payload signal descriptors
- `symbolCount` normalizes against adaptive bounds (missing raw value → no
  contribution, not NaN)

**Commit:**
`feat(presets): godClass file-level preset + symbolCount derived signal`

## T3 — composite `decomposition` preset

**Files:**

- `src/core/domains/trajectory/composite/presets/decomposition.ts` (new) — exact
  shape in spec §C (`requires: ["codegraph.symbols"]`, chunkFanOut 0.3,
  `groupBy: "parentSymbolId"` preserved)
- registration in `composite/presets/index.ts` / `buildCompositePresets`

**Tests first:**

- with codegraph registered: resolved `decomposition` weights include
  `chunkFanOut`, `groupBy` survives resolution
- without codegraph: static variant resolves, no structural keys in weights
- `tests/core/domains/explore/rerank-rank-chunks-fixes.test.ts` stays untouched
  and green (imports the static class directly)

**Commit:** `feat(presets): composite decomposition preset with chunkFanOut`

## T4 — `risk-assessment` skill rework

**Files (all under `.claude-plugin/tea-rags/skills/risk-assessment/`):**

- `SKILL.md` — per spec §D: Phase 1b (two structural calls in the Phase 1
  parallel block), delete Phase 4.3, fix-cost classifier table, god-class
  attribution with primary/fallback paths, `Structural debt` OUTPUT section with
  `Fix cost` and `Also risk?` columns, budgets ≤14/≤18 (+≤7 fallback), fix the
  four `references/signal-interpretation.md` links to point at
  `../../rules/references/signal-interpretation.md`
- `references/anti-patterns.md` — boundary line vs `refactoring-scan`
- `.claude-plugin/tea-rags/.claude-plugin/plugin.json` — patch version bump

**Style:** skill body prose caveman-compressed (ultra), output-format blocks and
tables byte-exact per `.claude/rules/caveman-compression.md`. Check
`git log --oneline -- .claude-plugin | head` for the commit scope convention and
follow it.

**No automated tests** — skill text. Run markdownlint on edited files.

## Final verification

1. `npx vitest run` — full suite green
2. `npx tsc --noEmit` (or the project's type-check script) — clean
3. `git log --oneline main..HEAD` — 5 commits (spec + plan + T1 + T2 + T3 + T4
   as authored), every commit passed the pre-commit gate
4. Report: what shipped per task, coverage numbers, anything skipped

Out of scope for the executor: merge to main, push, build+link, reindex, beads
mutations (the orchestrating session owns beads).
