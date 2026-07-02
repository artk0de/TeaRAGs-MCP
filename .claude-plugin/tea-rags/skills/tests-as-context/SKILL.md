---
name: tests-as-context
user-invocable: false
description:
  Agentic-only enrichment skill — surfaces DSL test chunks (chunkType "test"
  for leaf-scope scenarios, chunkType "test_setup" for fixtures) as context
  for review, verification, refactoring, debugging, TDD pattern extraction.
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
3. **Single-shot** — each recipe = one `semantic_search` call. No retry loops,
   no expansion. Caller composes recipes if needs multiple.
4. **Filter is `chunkType`, not `testFile`** — `chunkType: "test"` and
   `chunkType: "test_setup"` are chunk-level DSL filters. `testFile: "only"` =
   file-level fallback, only when DSL chunks absent.
5. **Agentic-only** — `user-invocable: false` in frontmatter. Recipes = building
   blocks consumed by other skills, not surfaced to user.

## Step 0 — Preflight

Read prime digest from session context. Locate `## Signal thresholds — <lang>`
section.

Test corpus **present** if ≥1 `git.chunk.*` signal line shows a `test:` row with
numeric thresholds, e.g.

```
- **git.chunk.commitCount**
  - source: low ≤1 / typical ≤2 / high ≤3 / extreme >7
  - test:   low ≤1 / typical ≤1 / high ≤2 / extreme >4
```

Test corpus **absent** if every `git.chunk.*` line shows `test: —` or no `test:`
row at all.

**Prime digest not in context (fresh subagent / cold session):** issue ONE cheap
probe call to determine DSL availability without scanning digest:

```
mcp__tea-rags__semantic_search:
  project:  <alias>
  query:    "test"
  filter:   { must: [{ key: "chunkType", match: { value: "test" } }] }
  limit:    1
  metaOnly: true
```

Empty result → DSL test chunks absent. Non-empty → present, proceed to Step 1.
Probe bounded (limit=1, metaOnly=true), runs only when prime digest missing.

If absent — return verdict, stop:

```
SKIP — no DSL test chunks indexed for <project>. Possible reasons:
 (a) primary language has no DSL test chunker
     (currently supported: TypeScript Vitest/Jest/Mocha, Ruby RSpec —
      see src/core/domains/ingest/pipeline/chunker/hooks/<lang>/)
 (b) .contextignore excludes test directories
 (c) project has no tests
Caller should fall back to language-neutral guidance without
test-context enrichment.
```

Caller decides how to degrade (often: emit generic placeholder line in its
output bundle, proceed without test data).

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
  project:     <alias from prime digest>
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
  query:       <intent>
  chunkType:   "test_setup"
  rerank:      "proven"               ← stable + old + low-bugFix + multi-author
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

- `intent`: scope description ("payments tests", "ingest pipeline test setup")
- `target`: `"scenarios"` | `"infra"` — selects chunkType
- `subjectPath` (optional): pathPattern scope

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
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

- `modulePath`: relative path or pathPattern of test file / dir being documented
  (e.g. `tests/core/domains/explore/reranker.test.ts` or
  `tests/core/domains/explore/**`)
- `intent` (optional): high-level theme to bias query; omit for full-module
  enumeration

**Call:**

```
mcp__tea-rags__semantic_search:
  project:     <alias>
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

Return recipe's formatted output. Caller (dinopowers wrapper, search-cascade
direct user, another tea-rags skill) embeds block in its own format — review
bundle line, verification ladder annotation, debug context paragraph.

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
  belongs to caller.
- Used `metaOnly: true` for `fixture-lookup` or `tests-at-risk` → wrong; these
  recipes need content for caller to extract conventions / describe-it path.
- Preflight skipped → all five recipes require it. Even if "obviously" project
  has tests, gate is only way to know DSL chunks indexed.
