---
name: tests-as-context
user-invocable: false
description:
  Agentic-only — surfaces DSL test chunks (chunkType "test" scenarios,
  "test_setup" fixtures) as context for review, verification, refactoring,
  debugging; a user asking for test patterns / conventions wants the dinopowers
  TDD wrapper, not this recipe.
  Five recipes: tests-at-risk (scenarios under threat for edited source),
  fixture-lookup (reuse existing setup before drafting new),
  regression-archaeology (when was the test for X added), test-flakiness
  (unstable test zones and infra), spec-extraction (living docs from test
  TOC). Cross-language safe — recipes emit runner-agnostic output. Skipped
  automatically when DSL test chunks absent from index. Invoked from
  dinopowers wrappers (test-driven-development, requesting-code-review,
  verification-before-completion, receiving-code-review) and direct
  use-cases.md callouts. NOT user-invocable — does not appear in interactive
  slash command list.
---

# tests-as-context

Five recipes turn DSL test chunks into review / verify / refactor / TDD
enrichment. Owned by tea-rags, used by dinopowers wrappers and other tea-rags
skills.

## Iron Rules

1. **Preflight gate** — Step 0 MUST run before any tea-rags call. DSL test
   chunks not indexed for this project → return SKIP verdict, no search call.
2. **Cross-language** — recipes MUST NOT name test runners, assertion libraries,
   package managers in output. Generic phrasing only: "run the tests for these
   files", "the project's standard test command", "execute the affected
   scenarios".
3. **Single-shot** — each recipe = one `semantic_search` call. No retry loops
   (Rule 5's old-server `filter: {}` re-issue excepted), no expansion. Caller
   composes recipes if needs multiple.
4. **Filter is `chunkType`, not `testFile`** — `chunkType: "test"` and
   `chunkType: "test_setup"` are chunk-level DSL filters. `testFile: "only"` =
   file-level fallback, only when DSL chunks absent.
5. **`proven` → `level: "chunk"`** — `proven` is file-level
   (`signalLevel: "file"`) → without it DSL chunks regroup per file. Test-scoped
   calls need no `filter`: server skips a preset's production default when
   `chunkType` / `testFile` select tests (rule: `tea-rags://guide/overview` →
   `### filter`). Server predating that rule returns 0 → add `filter: {}`.
6. **Agentic-only** — `user-invocable: false` in frontmatter. Recipes = building
   blocks consumed by other skills, not surfaced to user.

## Step 0 — Preflight

!`tea-rags resource "tea-rags://project/{alias}/metrics?section=thresholds" --path "$PWD" || true`

No `## Signal thresholds — <lang>` table above → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=thresholds`
(ReadMcpResourceTool). Resource unreadable → ONE probe instead:
`semantic_search(chunkType: "test", language: <lang>, limit: 1, metaOnly: true)`
— ≥1 row = present, 0 = absent. Test corpus **present** if ≥1 `git.chunk.*` row
has numbers (or `=src`) in `test ≥`, e.g.

```
| signal | bands | source ≥ | test ≥ |
| git.chunk.commitCount | low/typical/high/extreme | 2 / 3 / 7 | 1 / 2 / 4 |
```

**Absent** if every `git.chunk.*` row shows `—` in `test ≥`, or no `git.chunk.*`
row.

**Addressing (every recipe):** `project: <alias>` +
`path: <your working directory>`. Lag (`changedFiles` / `pendingFiles` / drift)
never licenses `cat` / `grep` / `Read` over code — `tea-rags://guide/freshness`.

If absent — return verdict, stop:

```
SKIP — no test chunks indexed for <project>. Possible reasons:
 (a) primary language has no AST test chunking
     (currently supported: TypeScript + JavaScript Vitest/Jest/Mocha,
      Ruby RSpec, Swift XCTest/swift-testing/Quick,
      Rust #[cfg(test)] / #[test] —
      see src/core/domains/language/<lang>/chunking/)
 (b) .contextignore excludes test directories
 (c) project has no tests
Caller fallback: file-level search (below), disclosed.
```

**SKIP ≠ skip the lookup.** Caller degrades to ONE file-level call —
`semantic_search` `testFile: "only"` + recipe's rerank (`fixture-lookup` →
`rerank: "proven"`), no `chunkType` (Iron Rule 4) — and states it: "file-level
fallback — DSL test chunks unavailable for this language". Silent fallback or
dropping the pattern search = wrong. Caller with no search step (review bundle
line) → emits its "unavailable (no DSL test chunks indexed)" line instead.

## Step 1 — Recipe routing

Dispatch on caller-provided `recipe` parameter. Each recipe owns its query,
filter, rerank, output format.

### Recipe `tests-at-risk`

**Purpose:** for edited / diffed / refactor-target source files (or a single
symbol's file), surface leaf-scope test chunks exercising affected scenarios.

**Caller inputs:**

- `affectedFiles`: relative paths — array. Single-element array OK for
  refactor/rename callers (receiving-code-review). Multi-file diff callers
  (requesting-code-review, verification-before-completion) pass full set.
- `intent`: one-sentence change description ("error handling in payments",
  "refactor reranker scoring", "rename ChunkGrouper.group to aggregate")

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
  path:        <your working directory>
  query:       <intent>
  chunkType:   "test"
  filter:      { must_not: [{ key: "relativePath", match: { any: <affectedFiles> } }] }
  rerank:      { custom: { similarity: 0.7, age: -0.1, churn: 0.2 } }
  limit:       12
  metaOnly:    false                  ← need content + describe-it path
```

Filter form: raw `must_not` on `relativePath` excludes affected source files
themselves (want tests describing them, not source chunks ranked back). Works
for any array size, incl single-element (receiving-code-review case) — no
brace-expansion edge cases.

Rerank shape rationale: `tests-at-risk` favours tests semantically referencing
change intent (similarity, 0.7), prefers fresher over legacy (negative age
weight), slightly weights active scenarios (churn) — stale tests on dead paths
downranked. `imports` weight intentionally absent: test chunks rarely imported
by other modules, signal near-zero for this corpus.

**Output:** ranked list, one entry per leaf scope:

```
- <relativePath>:<startLine> — <parentSymbolId or describe-it path>
  <one-line excerpt from inherited setup or assertion>
  age: <ageDays> | churn: <commitCount> | bugFix: <bugFixRate or "—">
```

**Empty result:** return single line
`no scenarios obviously bound to this change found — caller should still run general verification`.
Empty ≠ SKIP; preflight passed, no semantic match.

### Recipe `fixture-lookup`

**Purpose:** before drafting new mock setup or fixture, find existing fixture
chunks with similar shape.

**Caller inputs:**

- `intent`: setup intent, natural language ("user with admin role", "temp
  directory with config file", "mocked qdrant client returning empty")

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
  path:        <your working directory>
  query:       <intent>
  chunkType:   "test_setup"
  rerank:      "proven"               ← stable + old + low-bugFix + multi-author
  level:       "chunk"                ← proven is file-level; keep setup chunks (Iron Rule 5)
  limit:       6
  metaOnly:    false                  ← need setup content
```

`"proven"` preset weights:
`{similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05}`.
Surfaces battle-tested fixtures established as project convention.

**Output:** top-K fixture chunks:

```
- <relativePath>:<startLine> — <fixture description>
  <content excerpt: 5-8 lines, the setup body>
```

**Empty result:** return
`no proven fixture matches — drafting from scratch is acceptable`. Caller
(typically TDD wrapper) proceeds with generic fixture pattern.

### Recipe `regression-archaeology`

**Purpose:** identify when a test (by proxy, a feature contract) was first
introduced.

**Caller inputs:**

- `intent`: feature or scenario description ("retry after 5xx", "user signup
  with invalid email")
- `subjectPath` (optional): pathPattern scope to module

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
  path:        <your working directory>
  query:       <intent>
  chunkType:   "test"
  pathPattern: <subjectPath if provided, else omit>
  rerank:      { custom: { similarity: 0.2, age: 0.8 } }
  limit:       8
  metaOnly:    true                   ← need metadata (taskIds, ageDays)
```

Custom rerank, heavy age weight, surfaces oldest semantic matches. Caller sorts
results ascending by `git.chunk.ageDays` for introduction order.

**Output:**

```
- <relativePath>:<startLine> — <describe-it path>
  introduced: <ageDays> days ago | taskIds: [<tickets>] | author: <blameDominant>
```

**Empty result:** return
`no test history found for this scenario — either the scenario was never tested or pre-dates indexed history`.

### Recipe `test-flakiness`

**Purpose:** identify unstable test zones (high churn / bugFixRate on test code)
or unstable fixture infra (flaky setup).

**Caller inputs:**

- `intent`: scope description ("payments tests", "<dir> pipeline test setup")
- `target`: `"scenarios"` | `"infra"` — selects chunkType
- `subjectPath` (optional): pathPattern scope

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
  path:        <your working directory>
  query:       <intent>
  chunkType:   "test" if target=="scenarios" else "test_setup"
  pathPattern: <subjectPath if provided, else omit>
  rerank:      "hotspots"
  limit:       10
  metaOnly:    true
```

`"hotspots"` preset captures recent churn + ownership concentration +
bugFixRate; on test chunks maps to "scenarios / infra that keep breaking and
getting rewritten".

**Output:**

```
- <relativePath>:<startLine> — <describe-it path or fixture name>
  churn: <commitCount> | bugFix: <bugFixRate> | age: <ageDays> | owner: <blameDominant>
```

**Empty result:** `no flaky zones in scope — test suite stable here`.

### Recipe `spec-extraction`

**Purpose:** living-doc TOC of scenarios a module must satisfy.

**Caller inputs:**

- `modulePath`: test file relativePath, or test dir as `<dir>/**` (bare dir path
  matches nothing) being documented (e.g.
  `tests/core/domains/explore/reranker.test.ts` or
  `tests/core/domains/explore/**`)
- `intent` (optional): high-level theme to bias query; omit for full-module
  enumeration

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
  path:        <your working directory>
  query:       <intent if provided, else generic theme like "scenarios">
  pathPattern: <modulePath>
  chunkType:   "test"
  limit:       50
  metaOnly:    true
```

Why `semantic_search` not `find_symbol`: `find_symbol(relativePath:)` returns a
file-level outline, does NOT accept a `filter` param, so can't narrow to
`chunkType: "test"` inside the tool. `pathPattern` + `chunkType` combo on
`semantic_search` enumerates DSL leaf scenarios of the test surface directly,
full describe-it path in `parentSymbolId` / `symbolId`.

**Output:** scenario TOC, grouped by `parentSymbolId` (describe block):

```
## <Top-level describe>
  - <nested describe> > <it scope> — <relativePath>:<startLine>
  - <nested describe> > <it scope> — <relativePath>:<startLine>
## <Next top-level describe>
  ...
```

**Empty result:** `module has no test scenarios — undocumented contract`.

## Step 2 — Output to caller

Every recipe ends in exactly one of three outcomes; every caller handles all
three:

| Outcome   | When                                 | Caller emits                                                                         |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| SKIP      | Step 0 preflight: no DSL test chunks | "unavailable (no DSL test chunks indexed)" or disclosed file-level fallback (Step 0) |
| non-empty | search returned scopes               | recipe bundle (`tests-at-risk` → "Scenarios under risk:" list)                       |
| empty     | preflight passed, no semantic match  | recipe's empty line — not SKIP                                                       |

Return recipe's formatted output. Caller (dinopowers wrapper,
`tea-rags://guide/decision-tree` direct user, another tea-rags skill) embeds
block in its own format — review bundle line, verification ladder annotation,
debug context paragraph.

This skill never invokes another `Skill(...)`. Leaf in call chain.

## Cross-language safety contract

Outputs MUST NOT name:

- Test runners: `vitest`, `jest`, `mocha`, `pytest`, `unittest`, `rspec`,
  `minitest`, `go test`, `dotnet test`, `JUnit`, `phpunit`
- Assertion libraries: `expect`, `assert`, `should`, `chai`, `sinon`
- Package managers: `npm`, `pnpm`, `yarn`, `bundle`, `pip`, `poetry`, `cargo`

When suggesting next action, use generic phrasing:

- "run the tests for these files"
- "execute the affected scenarios"
- "the project's standard test command"

Caller agent resolves actual command from project context (`package.json`
scripts, `Makefile`, CI config, README) — not from this skill.

## Red flags — STOP

- Preflight returned non-SKIP but query went out without `chunkType` filter →
  restart; bare `testFile: "only"` is wrong tool.
- Recipe named a runner ("run with vitest", "pytest tests/...") → strip, restart
  output formatting.
- Two `semantic_search` calls for one recipe → recipes single-shot; multi-call
  belongs to caller. Sole exception: the old-server `filter: {}` re-issue (Rule
  5).
- Used `metaOnly: true` for `fixture-lookup` or `tests-at-risk` → wrong; these
  recipes need content for caller to extract conventions / describe-it path.
- Preflight skipped → all five recipes require it. Even if "obviously" project
  has tests, gate is only way to know DSL chunks indexed.
