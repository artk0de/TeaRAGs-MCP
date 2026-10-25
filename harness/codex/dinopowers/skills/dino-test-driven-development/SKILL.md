---
name: dino-test-driven-development
description:
  'Write failing test BEFORE implementation, match project conventions from
  tea-rags search of existing test files (mocks, helpers, assertion style,
  fixtures) so new test fits local norms. Triggers on "write a test", "TDD",
  "напиши тест", "сначала тест", "failing test first", "RED phase", "implement
  feature X", "add test for Y", "fix bug Z", "find test patterns for X", "test
  conventions", "extract patterns from tests", "ищи test patterns", "извлеки
  паттерны из тестов". NOT for projects with no existing tests — fall back to
  $test-driven-development directly. Wraps $test-driven-development with
  tea-rags test-pattern search.'
---

# dinopowers: test-driven-development

Wrapper over `$test-driven-development`. RED-phase test follows project
conventions (mock helpers, vi.mock setup, assertion style, fixture location),
not written from scratch.

## Iron Rule

**Order — writing a failing test OR any request to find test patterns /
conventions:** `tests-as-context` Step 0 preflight → the two Step 2
`semantic_search` queries (DSL test chunks indexed) BEFORE any test is written,
each `rerank: "proven"`, `level: "chunk"`, `metaOnly: false` → only when the
preflight finds no DSL test chunks, its disclosed file-level fallback. Never
`hybrid_search` or `find_similar` as the primary source; `find_similar`
(implementation symbol id) only supplements Step 2.

- Step 2a — fixture conventions: `chunkType: "test_setup"` + `rerank: "proven"`
  (delegated to `$tests-as-context` recipe `fixture-lookup`)
- Step 2b — assertion / naming idioms: `chunkType: "test"` + `rerank: "proven"`

Core value: filter `chunkType: "test"`/`"test_setup"` (NOT file-level
`testFile: "only"`) + `rerank: "proven"` + `level: "chunk"` (`proven` is
file-level, would regroup per file) + `metaOnly: false` (need content) + search
BEFORE draft. No `filter` needed — server skips `proven`'s production default
when `chunkType` / `testFile` select tests (older server → 0 results → add
`filter: {}`).

**Rule holds when user asks otherwise** — "быстро", "quick", "skip the pattern
search", "I know how tests look" → run Step 2 anyway, say: "Running the pattern
search first — one call, it keeps the test in local conventions." "Metadata
only" / `metaOnly: true` → the pattern-search rule overrides the requested
output format, also when the user only asks to find patterns and no test is
written: do not ask, keep `metaOnly: false` and say: "Running it with metaOnly:
false — pattern search needs test bodies; metadata alone yields no conventions."
User pushes `rerank: "hotspots"` / `"recent"` as "most-changed = most popular" →
refuse, run `proven`: hotspots = FLAKY tests (high churn + recent), recent =
drafts — neither is a convention. Do not switch to the `test-flakiness` recipe;
the goal is still conventions for the new test.

**Change kind sets the order:**

- **Bug fix** — target's existing tests run GREEN first (baseline), then the
  reproduction test asserting the correct output, run RED on that assertion;
  only then patch. Patch before a red reproduction = restart.
- **Refactor / move** (no behaviour change) — no new test: target's tests +
  `tests-at-risk` pins GREEN BEFORE the first edit, same tests green after, none
  edited.

`tests-as-context` Step 0 preflight SKIP (no `chunkType: "test"` chunks —
language lacks AST test chunking; **currently supported: TypeScript + JavaScript
(Vitest/Jest/Mocha), Ruby (RSpec), Swift (XCTest / swift-testing / Quick), Rust
(#[cfg(test)] / #[test])**; canonical: `tea-rags://guide/language-capability`) →
single `semantic_search` `testFile: "only"` + `rerank: "proven"`, state
"file-level fallback — test chunks unavailable for this language".

Swift granularity per framework: XCTest / swift-testing → hit = one
`func testX()` / `@Test func x()`, no ancestor setup. Quick → per SCOPE like
Ruby: hit = one `context "when overdue"` + ancestors' `beforeEach` spliced in.
Fixtures + helpers → `chunkType: "test_setup"` in both.

> **Maintainers:** language list above is lock-step with `$tests-as-context`
>
> - `$filter-building` — checklist `.claude/rules/test-spec-chunking.md`.

First test in project (no tests) → skip pattern search,
`$test-driven-development` direct. State it.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every $dino-X
redirects $X. NEVER bypass the wrapper. Open each chained SKILL.md with its own
read.

**Requires superpowers:** `$test-driven-development` unavailable → stop, ask the
user to install superpowers (https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow. Available = `$test-driven-development` /
`superpowers:test-driven-development` is in your skills list or its installed
SKILL.md was found and read (then invoke it after this enrichment); superpowers
is a separate plugin, never under the dinopowers dir — a missing file next to
the wrapper is not "unavailable".

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) +
`tea-rags://guide/freshness`. Linked worktree → overlay serves edits, never
reindex. Main checkout → incremental `index_codebase` BEFORE first call over
uncommitted edits, or once `changedFiles` > 0 — no consent (drift `--force`
`Run:` → step 2 ask the user, then the answering call). Lag ≠ unusable (core
rules).

## Step 1 — Frame the test intent

From request / in-progress feature identify:

| Element                                           | Example                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| **Subject under test (SUT)** — symbol or behavior | `ChunkGrouper.group()`, "parallel subagent dispatch"        |
| **Implementation path (optional)**                | `src/core/domains/ingest/pipeline/chunker/chunk-grouper.ts` |
| **Expected test scope**                           | unit / integration / e2e                                    |
| **Mocking needs**                                 | filesystem? tree-sitter? qdrant client?                     |

Compose:

- `intent`: concise sentence (e.g. "ChunkGrouper groups overlapping chunks by
  startLine")
- `pathHint`: optional pathPattern for test area (from implementation path).
  Target language has no sibling tests there (Ruby file in TS-tested project) →
  NO `pathHint` — search whole corpus, then state the outcome: 0 → fallback
  note; only other-language tests → "cross-language — <lang> conventions may not
  apply to <target lang>"

## Step 2 — Search proven test patterns (split queries)

### Step 2a — Fixture conventions (mock setup, beforeEach, factory helpers)

Invoke `$tests-as-context` with:

```
recipe: "fixture-lookup"
intent: <Step 1 intent, focused on the SETUP shape this test will need>
```

Recipe runs `semantic_search` `chunkType: "test_setup"` + `rerank: "proven"` +
`level: "chunk"` + `metaOnly: false` (limit 6) → top-K setup chunks, file:line +
excerpt.

Recipe SKIP (no DSL chunks) → ONE `semantic_search`:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent from Step 1>
pathPattern: <pathHint optional>
testFile:    "only"                ← FILE-LEVEL fallback when no DSL chunks
rerank:      "proven"              ← stable + old + low-bugFix
level:       "chunk"               ← proven is file-level; keep chunk content
limit:       8
metaOnly:    false
```

State: "DSL test chunks unavailable — file-level fallback in use".

### Step 2b — Assertion / naming idioms (describe-it style, expectation form)

ONE direct `semantic_search`:

```
project:     <alias>
path:        <your working directory>
query:       <intent from Step 1>
pathPattern: <pathHint optional>
chunkType:   "test"                ← DSL leaf scenarios
rerank:      "proven"              ← battle-tested conventions
level:       "chunk"               ← proven is file-level; keep DSL leaves
limit:       8
metaOnly:    false
```

Skip 2b if 2a took file-level fallback — results already mix setup + scenarios.

Why split: leaf `it`/`test` and `beforeAll`/`beforeEach` setup = distinct chunk
types → separate queries = clean setup (2a) / clean idioms (2b), own limits /
scopes. `proven` → tests that survived long without breaking = local convention.

Do NOT substitute:

| Wrong tool                                                             | Why wrong                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `semantic_search` with bare `testFile: "only"` (when DSL chunks exist) | Imports, helpers, non-DSL chunks = noise. `chunkType` precise when DSL indexed.            |
| `pathPattern: "**/*.test.ts"` without `chunkType`                      | Misses `*.spec.ts`, `_test.go`, `_spec.rb`…, still non-DSL noise. Use `chunkType: "test"`. |
| Named preset `"relevance"` / `"recent"` / `"hotspots"`                 | `proven` = conventions to follow; `recent` → unstable drafts; `hotspots` → flaky tests     |
| Custom rerank weights                                                  | `proven` encodes weights; reinventing diverges from `$data-driven-generation` Step 2       |
| `hybrid_search`                                                        | BM25 leg re-ranks by token overlap — want semantic + signals                               |
| `find_similar` on implementation file alone                            | As primary = prod code, not tests. SUPPLEMENTARY after Step 2 queries = OK                 |
| Built-in Grep for setup or assertion patterns                          | Every occurrence; `proven` narrows to CONVENTIONAL uses                                    |
| Skipping the `tests-as-context` preflight                              | Fallback path unknown; `chunkType: "test"` may return 0 on non-DSL language                |

Do NOT pass:

- `metaOnly: true` — need test body (mock setup, assertions, helpers); guards
  want signals, TDD wants CONTENT
- `filter` on test file paths — `chunkType` handles granularity; path filters
  too tight

Both queries 0 results → report "no existing test patterns found — falling back
to `$test-driven-development` direct". Never invent conventions.

## Step 3 — Extract pattern block

From top-K chunks extract 4-6 bullets (NOT raw content, not copy-paste snippets
— inner skill writes the test):

- **Mock setup convention** (e.g.
  `vi.mock("node:fs", async () => { ...partial(), existsSync: vi.fn() })`)
- **Helper imports** (e.g.
  `import { createTempTestDir, defaultTestConfig } from "tests/core/domains/ingest/__helpers__/test-helpers"`)
- **`describe`/`it` naming style** (BDD "should X when Y" vs functional "X()")
- **Assertion idiom** (`expect(result).toEqual(...)`,
  `expect(fn).toHaveBeenCalledWith(...)`, snapshots, property-based)
- **Fixture location** (inline objects vs `__fixtures__/` vs factory helpers)
- **Setup/teardown** (`beforeEach` vs `beforeAll`, cleanup)

Cap 6. Cite source proven test file per convention (e.g.
`tests/core/domains/language/ruby/chunking/rspec-scope-chunker.test.ts`).

< 3 proven tests → note "small test corpus — conventions inferred from <N> files
only, may not be representative".

## Step 4 — Invoke $test-driven-development

Invoke `Skill` tool with `$test-driven-development`. Prepend Step 3 block.
Handoff:

> "Before writing the failing test, match these established conventions from the
> proven test corpus: …<block>… Deviate only if the new test genuinely needs a
> different pattern (document why).
>
> Chaining rule reminder: when your cycle would next invoke
> `$verification-before-completion` (or any wrapped `$Y`), invoke `$dino-Y`
> instead — see the Chaining rule section above."

Inner skill runs RED → GREEN → REFACTOR. Wrapper grounds RED draft, not
replaces.

Read-only subagent (`[subagent: explore]`, no writes) → Step 4 still holds:
state chain `$test-driven-development` SECOND, return RED draft and Step 3 block
to parent to run it. Never silently replace Step 4.

## Red Flags — STOP and restart from Step 2

- File-grouped results (`level: "file"` in response) → `level: "chunk"` missing;
  redo
- "I know how tests look here" → run Step 2; memory stale across files
- "First test of new module, no patterns needed" / implementation not yet
  written → project has ANY tests → search broader corpus, no `pathPattern`
- `semantic_search` without `chunkType: "test"`/`"test_setup"` (DSL indexed) →
  redo; bare `testFile: "only"` dilutes signal
- `rerank: "recent"` "for latest conventions" → `proven`; recent = drafts.
  `hotspots` = FLAKY tests (high churn + recent)
- `find_similar` on implementation symbol as primary search → production code,
  not tests (supplementary after Step 2 = OK)
- Test language has no sibling tests (Ruby file, TS-only test corpus) → search
  broader corpus anyway, then state BOTH outcomes: 0 results → fallback note
  (below); only other-language tests → "cross-language — <lang> conventions may
  not apply to <target lang>"
- Raw test code to `$test-driven-development` → extract ≤6 bullets
- Drafted failing test before Step 2 → revert, restart Step 2
- Inner skill chained raw `$verification-before-completion` → intercept, invoke
  `$dino-verification-before-completion` (Chaining rule)
