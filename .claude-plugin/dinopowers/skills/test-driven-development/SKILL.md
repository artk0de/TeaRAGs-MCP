---
name: test-driven-development
description:
  Use when about to write a new failing test — before drafting the test,
  searches existing test files via tea-rags for proven patterns (mocks, helpers,
  assertion style, fixture conventions) so the new test matches local norms.
  Triggers when superpowers:test-driven-development would fire AND the project
  has existing tests. NOT for first-test-in-project scenarios (use
  superpowers:test-driven-development directly).
---

# dinopowers: test-driven-development

Wrapper over `superpowers:test-driven-development`. Ensures the RED-phase
failing test follows this project's established test conventions (mock helpers,
vi.mock setup, assertion style, fixture location) instead of being written from
scratch.

## Iron Rule

**`mcp__tea-rags__semantic_search` with `testFile: "only"` MUST be called BEFORE
writing the failing test** — whenever the project has at least one existing test
file.

Correct filter (`testFile: "only"`) + correct rerank (`"proven"` — battle-tested
patterns) + correct parameters (`metaOnly: false` to see actual test code) +
correct ordering (search BEFORE draft) is the core value.

If this is the first test in the project (no existing tests): skip pattern
search, invoke `superpowers:test-driven-development` directly. State it.

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

## Step 2 — Search proven test patterns

Issue ONE `mcp__tea-rags__semantic_search` call:

```
path:        <current project path>
query:       <intent from Step 1>
pathPattern: <pathHint, e.g. "tests/chunker/**">  ← optional; omit to search all tests
testFile:    "only"                                ← built-in filter for test files
rerank:      "proven"                              ← battle-tested: stable + old + low bugFix
limit:       8
metaOnly:    false                                 ← content needed to extract conventions
```

The `"proven"` preset is calibrated for
`{stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05, similarity: 0.2}`
(see `tea-rags-analytics.md`). It surfaces tests that survived long without
breaking — the local convention.

Do NOT substitute:

| Wrong tool                                                 | Why wrong                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `semantic_search` without `testFile: "only"`               | Returns implementation code mixed with tests; pattern signal diluted                                                          |
| `pathPattern: "**/*.test.ts"` without `testFile: "only"`   | Works for TypeScript but misses `*.spec.ts`, `_test.go`, `_spec.rb` etc. Use the filter.                                      |
| Named preset `"relevance"` / `"recent"` / `"hotspots"`     | `proven` is calibrated for "conventions to follow"; `recent` returns unstable drafts; `hotspots` returns flaky tests to avoid |
| Custom rerank weights                                      | `proven` preset already encodes the right weights; reinventing diverges from `tea-rags:data-driven-generation` Step 2         |
| `mcp__tea-rags__hybrid_search`                             | Rerank presets are tied to `semantic_search`                                                                                  |
| `mcp__tea-rags__find_similar` on implementation file alone | Finds structurally similar code, not tests that exercise similar behavior                                                     |
| Built-in Grep for `vi.mock(` / `describe(`                 | Returns every occurrence; `proven` narrows to CONVENTIONAL uses                                                               |

Do NOT pass:

- `metaOnly: true` — we need the actual test body to extract conventions (mock
  setup, assertion style, helper calls); signal-only payload is useless for TDD
- `filter` on test file paths — `testFile: "only"` handles that; adding path
  filters restricts too tight

If `semantic_search` returns 0 results (no existing tests at all, or none
matching the area): report "no existing test patterns found — falling back to
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
> different pattern (document why)."

Let `superpowers:test-driven-development` run its RED → GREEN → REFACTOR cycle.
This wrapper does not replace it — it grounds the RED draft in local
conventions.

## Red Flags — STOP and restart from Step 2

- "I know how tests look in this project" → run Step 2 anyway; memory is stale
  across files
- "First test of a new module, no patterns needed" → if the project has ANY
  tests, search the broader corpus with no `pathPattern`
- Used `semantic_search` without `testFile: "only"` → redo; implementation noise
  is high
- Picked `rerank: "recent"` "to get latest conventions" → `proven` is calibrated
  better; recent returns drafts
- Passed raw test code to `superpowers:test-driven-development` → extract
  pattern block first (6 bullets, not raw content)
- Started drafting the failing test before Step 2 → revert, restart from Step 2

## Common Mistakes

| Mistake                                                        | Reality                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Search with `rerank: "hotspots"` thinking "find popular tests" | `hotspots` surfaces FLAKY tests (high churn + recent). Use `proven` (stable+old+low-bugFix).                             |
| Omit `testFile: "only"` filter                                 | Returns implementation code. Pattern extraction becomes noisy.                                                           |
| Use `find_similar` on implementation symbol                    | Finds structurally-related production code, not tests that exercise it                                                   |
| Extract verbatim code snippets as "patterns"                   | Patterns are conventions (5-6 bullets), not copy-paste. Let `superpowers:test-driven-development` write the actual test. |
| Skip Step 2 if implementation doesn't exist yet                | Tests for the new feature should still follow project test conventions; run Step 2 on the broader corpus                 |
| Set `metaOnly: true` for a guard-style call                    | Guards want signals. TDD wants CONTENT (mock setup, assertions). Use `metaOnly: false`.                                  |
