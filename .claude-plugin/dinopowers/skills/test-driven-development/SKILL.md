---
name: test-driven-development
description:
  Write a failing test BEFORE implementation, matching project conventions found
  via tea-rags search of existing test files (mocks, helpers, assertion style,
  fixture conventions) so the new test fits local norms. Triggers on "write a
  test", "TDD", "напиши тест", "сначала тест", "failing test first", "RED
  phase", "implement feature X", "add test for Y", "fix bug Z". NOT for projects
  with no existing tests — fall back to superpowers:test-driven-development
  directly. Wraps superpowers:test-driven-development with tea-rags test-pattern
  search.
---

# dinopowers: test-driven-development

Wrapper over `superpowers:test-driven-development`. Ensures the RED-phase
failing test follows this project's established test conventions (mock helpers,
vi.mock setup, assertion style, fixture location) instead of being written from
scratch.

## Iron Rule

**Two split queries on DSL test chunks MUST be made BEFORE writing the failing
test** — whenever the project has DSL test chunks indexed:

- Step 2a — fixture conventions: `chunkType: "test_setup"` + `rerank: "proven"`
  (delegated to `Skill(tea-rags:tests-as-context)` recipe `fixture-lookup`)
- Step 2b — assertion / naming idioms: `chunkType: "test"` + `rerank: "proven"`

Correct filter (`chunkType: "test"`/`"test_setup"`, NOT file-level
`testFile: "only"`) + correct rerank (`"proven"` — battle-tested patterns) +
correct parameters (`metaOnly: false` to see actual test content) + correct
ordering (search BEFORE draft) is the core value.

If `Skill(tea-rags:tests-as-context)` Step 0 preflight returns SKIP (DSL test
chunks absent — happens when the primary language has no DSL test chunker;
**currently supported: TypeScript (Vitest/Jest/Mocha) and Ruby (RSpec)** — see
`src/core/domains/ingest/pipeline/chunker/hooks/<lang>/test-scope-chunker.ts`
and `rspec-scope-chunker.ts` for the canonical list), fall back to a single
`mcp__tea-rags__semantic_search` with `testFile: "only"` + `rerank: "proven"`
and state "file-level fallback — DSL test chunks unavailable for this language".

> **Maintainers:** when a new language gains a DSL test chunker, update the
> supported-languages list above AND the same lists in
> `tea-rags:tests-as-context` (Step 0 SKIP block) and `tea-rags:filter-building`
> (chunkType section). The canonical checklist lives in
> `.claude/rules/test-spec-chunking.md`.

If this is the first test in the project (no existing tests): skip pattern
search, invoke `superpowers:test-driven-development` directly. State it.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — MUST run
`mcp__tea-rags__reindex_changes` if any file was edited in this session, BEFORE
the first tea-rags call.

## Step 1 — Frame the test intent

From the user request or in-progress feature, identify:

| Element                                           | Example                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| **Subject under test (SUT)** — symbol or behavior | `ChunkGrouper.group()`, "parallel subagent dispatch"        |
| **Implementation path (optional)**                | `src/core/domains/ingest/pipeline/chunker/chunk-grouper.ts` |
| **Expected test scope**                           | unit / integration / e2e                                    |
| **Mocking needs**                                 | filesystem? tree-sitter? qdrant client?                     |

Compose:

- `intent`: concise sentence (e.g. "ChunkGrouper groups overlapping chunks by
  startLine")
- `pathHint`: optional pathPattern scoping to the test area (derived from
  implementation path)

## Step 2 — Search proven test patterns (split queries)

### Step 2a — Fixture conventions (mock setup, beforeEach, factory helpers)

Invoke `Skill(tea-rags:tests-as-context)` with:

```
recipe: "fixture-lookup"
intent: <Step 1 intent, focused on the SETUP shape this test will need>
```

The recipe internally issues `mcp__tea-rags__semantic_search` with
`chunkType: "test_setup"` + `rerank: "proven"` + `metaOnly: false` (limit 6) and
returns top-K setup chunks with file:line + content excerpt.

If the recipe returns SKIP (DSL test chunks absent), fall back to ONE
`mcp__tea-rags__semantic_search` call:

```
project:     <alias from list_projects — RECOMMENDED>
path:        <current project path — fallback when no alias>
query:       <intent from Step 1>
pathPattern: <pathHint optional>
testFile:    "only"                ← FILE-LEVEL fallback when no DSL chunks
rerank:      "proven"              ← stable + old + low-bugFix
limit:       8
metaOnly:    false
```

State explicitly: "DSL test chunks unavailable — file-level fallback in use".

### Step 2b — Assertion / naming idioms (describe-it style, expectation form)

Issue ONE direct `mcp__tea-rags__semantic_search`:

```
project:     <alias>
query:       <intent from Step 1>
pathPattern: <pathHint optional>
chunkType:   "test"                ← DSL leaf scenarios
rerank:      "proven"              ← battle-tested conventions
limit:       8
metaOnly:    false
```

Skip Step 2b if Step 2a took the file-level fallback path — file-level results
already cover both setup and scenarios mixed together.

### Why split queries

DSL test chunking emits two distinct chunk types per
`test-scope-chunker.ts:265,289` (leaf `it`/`test` blocks) and `:309,340,376`
(`beforeAll`/`beforeEach` setup). Querying them separately:

- Returns setup conventions cleanly in 2a (no scenario noise)
- Returns assertion idioms cleanly in 2b (no setup noise)
- Allows different limits / scopes per dimension

`"proven"` preset is calibrated for
`{stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05, similarity: 0.2}` —
surfaces tests that survived long without breaking, the local convention.

Do NOT substitute:

| Wrong tool                                                             | Why wrong                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic_search` with bare `testFile: "only"` (when DSL chunks exist) | Captures imports, helpers, non-DSL chunks as noise. `chunkType` is the precise filter when DSL chunks are indexed.                     |
| `pathPattern: "**/*.test.ts"` without `chunkType`                      | Works for TypeScript but misses `*.spec.ts`, `_test.go`, `_spec.rb` etc., AND still captures non-DSL noise. Use `chunkType: "test"`.   |
| Named preset `"relevance"` / `"recent"` / `"hotspots"`                 | `proven` is calibrated for "conventions to follow"; `recent` returns unstable drafts; `hotspots` returns flaky tests to avoid          |
| Custom rerank weights                                                  | `proven` preset already encodes the right weights; reinventing diverges from `tea-rags:data-driven-generation` Step 2                  |
| `mcp__tea-rags__hybrid_search`                                         | Rerank presets are tied to `semantic_search`                                                                                           |
| `mcp__tea-rags__find_similar` on implementation file alone             | Finds structurally similar code, not tests that exercise similar behavior                                                              |
| Built-in Grep for setup or assertion patterns                          | Returns every occurrence; `proven` narrows to CONVENTIONAL uses                                                                        |
| Skipping the `tests-as-context` preflight                              | Without preflight, fallback path is unknown; you may issue a `chunkType: "test"` query that returns 0 on a non-DSL language by mistake |

Do NOT pass:

- `metaOnly: true` — we need actual test body to extract conventions (mock
  setup, assertion style, helper calls); signal-only payload is useless for TDD
- `filter` on test file paths — `chunkType` handles granularity; adding path
  filters restricts too tight

If both queries return 0 results (no existing tests at all, or none matching the
area): report "no existing test patterns found — falling back to
`superpowers:test-driven-development` direct". Do NOT invent conventions.

## Step 3 — Extract pattern block

From the top-K returned chunks, extract as 4-6 concise bullets (NOT raw
content):

- **Mock setup convention** (e.g.
  `vi.mock("node:fs", async () => { ...partial(), existsSync: vi.fn() })`)
- **Helper imports** (e.g.
  `import { createTempTestDir, defaultTestConfig } from "tests/core/domains/ingest/__helpers__/test-helpers"`)
- **`describe`/`it` naming style** (e.g. BDD "should X when Y" vs functional
  "X()")
- **Assertion idiom** (e.g. `expect(result).toEqual(...)`,
  `expect(fn).toHaveBeenCalledWith(...)`, snapshots, property-based)
- **Fixture location** (inline objects vs `__fixtures__/` files vs factory
  helpers)
- **Setup/teardown** (`beforeEach` vs `beforeAll`, cleanup patterns)

Cap bullets at 6. Cite the proven test file each convention came from (e.g.
`tests/core/domains/ingest/chunker/hooks-composition.test.ts`).

If tea-rags returned fewer than 3 proven tests (thin corpus): note "small test
corpus — conventions inferred from <N> files only, may not be representative".

## Step 4 — Invoke superpowers:test-driven-development

Invoke the `Skill` tool with `superpowers:test-driven-development`. Prepend the
pattern block from Step 3 as context. Phrase the handoff as:

> "Before writing the failing test, match these established conventions from the
> proven test corpus: …<block>… Deviate only if the new test genuinely needs a
> different pattern (document why).
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:test-driven-development` run its RED → GREEN → REFACTOR cycle.
This wrapper does not replace it — it grounds the RED draft in local
conventions.

## Red Flags — STOP and restart from Step 2

- "I know how tests look in this project" → run Step 2 anyway; memory is stale
  across files
- "First test of a new module, no patterns needed" → if the project has ANY
  tests, search the broader corpus with no `pathPattern`
- Used `semantic_search` without `chunkType: "test"`/`"test_setup"` (when DSL
  chunks indexed) → redo; bare `testFile: "only"` captures import / helper noise
  that dilutes the pattern signal
- Picked `rerank: "recent"` "to get latest conventions" → `proven` is calibrated
  better; recent returns drafts
- Passed raw test code to `superpowers:test-driven-development` → extract
  pattern block first (6 bullets, not raw content)
- Started drafting the failing test before Step 2 → revert, restart from Step 2
- Let `superpowers:test-driven-development` chain into a raw
  `superpowers:verification-before-completion` without redirecting to
  `dinopowers:verification-before-completion` → intercept and invoke the wrapper
  instead (see Chaining rule)

## Common Mistakes

| Mistake                                                        | Reality                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Search with `rerank: "hotspots"` thinking "find popular tests" | `hotspots` surfaces FLAKY tests (high churn + recent). Use `proven` (stable+old+low-bugFix).                             |
| Omit `chunkType: "test"`/`"test_setup"` filter (DSL projects)  | Returns implementation code or noisy test-file chunks. `chunkType` is the precise filter for DSL leaves and fixtures.    |
| Use `find_similar` on implementation symbol                    | Finds structurally-related production code, not tests that exercise it                                                   |
| Extract verbatim code snippets as "patterns"                   | Patterns are conventions (5-6 bullets), not copy-paste. Let `superpowers:test-driven-development` write the actual test. |
| Skip Step 2 if implementation doesn't exist yet                | Tests for the new feature should still follow project test conventions; run Step 2 on the broader corpus                 |
| Set `metaOnly: true` for a guard-style call                    | Guards want signals. TDD wants CONTENT (mock setup, assertions). Use `metaOnly: false`.                                  |
