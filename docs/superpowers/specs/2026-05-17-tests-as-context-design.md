# tests-as-context — DSL test chunks as enrichment for review / verify / refactor / TDD

**Status:** Proposed **Date:** 2026-05-17 **Affects plugins:** tea-rags (minor),
dinopowers (minor)

## Motivation

The chunker emits two test-specific chunk types under DSL test chunking
(currently TypeScript-only via `test-scope-chunker.ts`):

- `chunkType: "test"` — leaf-scope test chunks (each `it`/`test` block) with
  inherited `beforeEach`/`beforeAll` setup baked into chunk content
- `chunkType: "test_setup"` — fixture / setup-only chunks

This granularity is currently underused. Existing skills either:

1. Reach for `testFile: "only"` — a file-level filter (payload `isTest: true`)
   that captures all chunks in a test file including imports, top-level helpers,
   and any non-DSL chunks. Noisy.
2. Have no test-side recipe at all (e.g. `dinopowers:requesting-code-review`,
   `dinopowers:verification-before-completion`,
   `dinopowers:receiving-code-review`).

DSL test chunks unlock four distinct workflows that the existing skill surface
does not cover:

- **Tests at risk** — for an edited / diffed source file, surface the leaf-scope
  test chunks that exercise affected scenarios. Reviewers and pre-commit
  verification get "contract under threat" visibility without re-reading whole
  test files.
- **Fixture lookup** — before drafting a new mock setup or fixture, find an
  existing `test_setup` chunk with similar shape. Avoid reinventing established
  helpers.
- **Regression archaeology** — "when was the test for X added" via
  `chunkType: "test"` ranked by `git.chunk.ageDays`. First-test-introduction is
  a meaningful timestamp.
- **Test flakiness** — `chunkType: "test"` + `rerank: "hotspots"` surfaces test
  scopes with high churn / bugFixRate; `chunkType: "test_setup"` variant
  surfaces unstable fixture infrastructure (a common flake source).

A fifth, lower-priority workflow:

- **Spec extraction** — `find_symbol(relativePath: <module>)` +
  `chunkType: "test"` yields the TOC of scenarios that module is required to
  satisfy; useful as executable spec for onboarding.

## Design

### Cross-language constraint (HARD)

Plugins MUST NOT name specific test runners (vitest, jest, pytest, rspec, go
test, JUnit) or assertion libraries (chai, expect, assertEqual) in any SKILL.md,
recipe, or generated output. Recipes emit generic phrasing — "run the tests for
these files", "the project's standard test command" — and let the consuming
agent resolve the actual command from project context (`package.json` scripts,
`Makefile`, CI config, etc.).

### Filter taxonomy clarification

Two test filters exist, addressing different granularity:

| Filter                                       | Level | Mechanism                                                                                 | Captures                                                                |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `testFile: "only" \| "exclude" \| "include"` | file  | payload `isTest: true` (set in `static/provider.ts:33` when `detectTestFile(path, lang)`) | every chunk in a test file: imports, helpers, DSL chunks, anything else |
| `chunkType: "test"`                          | chunk | DSL chunker emits this in `test-scope-chunker.ts:265,289`                                 | only leaf-scope `it`/`test` scenarios with inherited setup              |
| `chunkType: "test_setup"`                    | chunk | DSL chunker emits this in `test-scope-chunker.ts:309,340,376`                             | only fixture / setup chunks (beforeEach/beforeAll)                      |

Composition: `testFile: "only"` + `chunkType: "test"` = strict DSL leaf
scenarios from test files (defense-in-depth if `chunkType: "test"` ever appears
outside test files).

### Preflight: when DSL test chunks are absent

Tests-as-context recipes depend on `chunkType: "test"` /
`chunkType: "test_setup"` being present in the index. They are absent when:

- Primary language has no DSL test chunker (Ruby, Python, Go — currently
  TypeScript-only)
- `.contextignore` excludes test directories
- Project has no tests

The skill detects absence via the prime digest: if no `git.chunk.*` signal has a
`test:` threshold row, DSL test chunks are not indexed. The skill returns a SKIP
verdict with explicit reason; it does NOT fall back to file-level
`testFile: "only"` proxy unless explicitly invoked under a "non-DSL language"
branch (see Skill section).

### New skill: `tea-rags:tests-as-context`

**Path:** `.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md`
**Frontmatter:** `user-invocable: false` — agentic-only, called by other skills
as an enrichment step. Not surfaced to the user directly.

**Recipes:**

| Recipe                   | Triggers                                                                                                                    | Query shape                                                                                                                                                             | Output                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `tests-at-risk`          | called from requesting-code-review / verification-before-completion / receiving-code-review for edited or diff source files | `chunkType: "test"`, `pathPattern` derived from diff via reverse-similarity (find scenarios that semantically reference affected source); `metaOnly: false` for content | list of file:line + describe-it path + inherited setup excerpt |
| `fixture-lookup`         | called from TDD wrapper Step 2a, or directly when "is there an existing helper for this setup"                              | `chunkType: "test_setup"`, `rerank: "proven"` (stable+old+low-bugFix), `query` = setup intent (e.g. "user with admin role", "temp directory with config")               | top-K setup chunks with file:line + content                    |
| `regression-archaeology` | "when was the test for X added", "first test for feature Y"                                                                 | `chunkType: "test"`, `rerank: { custom: { age: 0.8, similarity: 0.2 } }`, results sorted ascending by `git.chunk.ageDays`                                               | oldest matching scenarios with ageDays + taskIds               |
| `test-flakiness`         | "find unstable test zones", "flaky test infrastructure", "where do regressions cluster"                                     | `chunkType: "test"` (scenarios) OR `chunkType: "test_setup"` (infra) + `rerank: "hotspots"`                                                                             | ranked list of unstable chunks with churn / bugFixRate / age   |
| `spec-extraction`        | "living docs for module X", "what does this module promise"                                                                 | `find_symbol(relativePath: <module>)` + `chunkType: "test"` filter on results                                                                                           | scenario TOC with parent describe → leaf it path               |

**Step 0 — Preflight:** Read prime digest from session context. Locate
`## Signal thresholds — <lang>` section. If no `git.chunk.*` signal line
contains `test:` with numeric thresholds, return verdict:

```
SKIP — no DSL test chunks in index for <project>. Possible reasons:
 (a) primary language has no DSL test chunker (TypeScript-only currently)
 (b) .contextignore excludes test directories
 (c) project has no tests
Caller should fall back to language-neutral guidance without test-context
enrichment.
```

**Step 1 — Recipe routing:** Dispatch on caller-provided `recipe` parameter (one
of the five above). Each recipe owns its query construction, filter, and rerank
choice.

**Step 2 — Execute:** Single `semantic_search` call per recipe (multi-call only
for spec-extraction which combines `find_symbol` + filter). No iteration loops —
recipes are single-shot enrichment.

**Step 3 — Format output:** Compact list with file:line + describe-it path (when
available from `navigation.parentSymbolId`) + content excerpt
(recipe-dependent). Caller formats the block for its own consumption (review
bundle, verification ladder, debug context).

### Existing skill updates

**`dinopowers:test-driven-development`**
(`.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md`)

Step 2 currently uses `testFile: "only"`. Replace with two split queries:

- Step 2a: `Skill(tea-rags:tests-as-context)` recipe `fixture-lookup` — extracts
  mock setup / fixture conventions
- Step 2b: `semantic_search` with `chunkType: "test"` + `rerank: "proven"` +
  `metaOnly: false` — extracts assertion idioms, describe/it naming

Fallback branch: if preflight reports DSL test chunks absent (non-TypeScript
project), use `testFile: "only"` + `rerank: "proven"` with note "file-level
fallback — DSL test chunks unavailable for this language".

Update "Do NOT substitute" table: add row that bare `testFile: "only"` is
suboptimal when DSL chunks exist (returns imports / helpers / non-DSL chunks as
noise).

**`dinopowers:requesting-code-review`**
(`.claude-plugin/dinopowers/skills/requesting-code-review/SKILL.md`)

Insert new **Step 3a — Tests at risk** between current Step 3 (build bundle) and
Step 4 (invoke superpowers):

- Call `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk` with
  `diffFiles` as scope
- If SKIP verdict: add bundle line
  `**Scenarios under risk:** unavailable (no DSL test chunks indexed)`
- If non-empty: add bundle section `**Scenarios under risk:**` with leaf test
  chunks (file:line + describe path) so reviewer sees affected scenarios
  alongside ownership / churn metadata

**`dinopowers:verification-before-completion`**
(`.claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md`)

Insert new **Step 3a — Tests-at-risk lookup** between current Step 3
(collateral-damage verdict) and Step 4 (invoke superpowers):

- Call `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk` on
  `editedFiles`
- Augment the verdict ladder output: for HIGH-BLAST / MEDIUM-BLAST files with
  non-empty `tests-at-risk` result, the recommendation becomes **generic**: "run
  the project's test command targeting these files: <list>". Never name a
  specific runner.
- For files without test coverage in result: keep current generic "verify
  dependents" guidance

**`dinopowers:receiving-code-review`**
(`.claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md`)

When reviewer suggests rename / move / extract on a symbol — extend the
blast-radius check:

- Call `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk` on the affected
  symbol's file (or `find_similar` from chunk)
- If non-empty: response includes "Tests bound to current name/signature:
  <list>" so user understands cost of change

### Documentation updates

**`.claude-plugin/tea-rags/rules/search-cascade.md`** — extend "After-Search
Navigation" table with two rows:

| After search returns…                   | If you need…                          | Next call                                                       |
| --------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Chunk from production src               | Tests describing this scenario        | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`       |
| Need scenario by describe-it scope name | Leaf scope chunk with inherited setup | `find_symbol(symbol: "<Parent>.<scope>")` + `chunkType: "test"` |

**`.claude-plugin/tea-rags/rules/references/use-cases.md`** — add new top-level
section "Tests as context" with table of recipes (see Recipes above). Remove
obsolete "Spec/test file content → pathPattern" line from External tools
section.

**`.claude-plugin/tea-rags/skills/filter-building/SKILL.md`** — add Test filter
levels sub-table:

| Need                                                     | Filter combo                             |
| -------------------------------------------------------- | ---------------------------------------- |
| Any chunk from test files (helpers, imports, DSL chunks) | `testFile: "only"`                       |
| Only leaf-scope DSL test scenarios                       | `chunkType: "test"`                      |
| Only DSL fixture / setup chunks                          | `chunkType: "test_setup"`                |
| Strict DSL leaves in test files only                     | `testFile: "only"` + `chunkType: "test"` |

Clarify that `chunkType` filters require DSL test chunking (TypeScript-only
currently); for other languages, `testFile: "only"` is the file-level fallback.

### Plugin versioning

- `tea-rags`: 0.20.1 → 0.21.0 (minor — new skill `tests-as-context`)
- `dinopowers`: 0.16.1 → 0.17.0 (minor — 4 skills changed)

## Non-goals

- Producing coverage data — see beads epic `tea-rags-mcp-ytoo` for
  consume-existing-coverage approach.
- DSL test chunking for non-TypeScript languages — separate beads work; this
  spec gracefully degrades when DSL chunks are absent.
- New MCP tools — recipes are agentic-only enrichment, no new MCP surface.

## Cross-language safety contract

Every recipe output and every wrapper integration point MUST be runner-agnostic.
Acceptable phrasing:

- "run the project's test command targeting <files>"
- "execute the tests covering the affected scenarios"
- "the tests for these files should be run before claiming complete"

Forbidden phrasing (will fail review):

- `vitest run ...`, `npm test`, `jest --testPathPattern`, `pytest <files>`,
  `bundle exec rspec`, `go test ./...`, `dotnet test`
- Any framework-specific assertion library name in recommendation context
- Any package-manager command (`npm`, `pnpm`, `yarn`, `bundle`, `pip`, `poetry`,
  `cargo`, `go`)

The agent reading recipe output is expected to resolve the project's actual test
command from project context (package.json scripts, Makefile, CI config, README)
— not from the recipe.

## Risk surface

- **False negatives** in `tests-at-risk`: semantic_search may miss tests that
  reference affected code indirectly (helpers, factories, snapshot IDs).
  Mitigation: recipes return ranked output; consumers treat non-empty result as
  "scenarios at risk", treat empty result as "no obvious tests found, fall back
  to general verification".
- **Over-reliance on DSL chunks**: if DSL coverage degrades (chunker bug),
  preflight catches it and skip degrades gracefully. Wrappers still function
  without test-context enrichment.
- **Cross-language regression risk**: this design adds 1 new skill + 4 wrapper
  edits. Verification: each updated SKILL.md run through `/optimize-skill` after
  edits, plugin version bumps per `.claude/rules/plugin-versioning.md`.
