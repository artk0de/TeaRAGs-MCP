# Inline Test Chunks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Index inline tests (Rust `#[cfg(test)]` / `#[test]`, Vitest in-source
`if (import.meta.vitest)`) as test chunks with `isTest: true` and keep them out
of the codegraph.

**Architecture:** Each language owns one predicate,
`isInlineTestNode(node, code)`, in `domains/language/<lang>/inline-tests.ts`.
Its consumers are that language's chunker hooks (which shape the subtree into
`test` / `test_setup` chunks) and its codegraph walker (which prunes the
subtree). `StaticPayloadBuilder` sets `isTest` when the path is a test or the
chunk type is a test chunk type. Test chunks are not graph symbols.

**Tech Stack:** TypeScript, tree-sitter (`tree-sitter-rust`,
`tree-sitter-typescript`, `tree-sitter-javascript`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-inline-test-chunks-design.md`

## Global Constraints

- Code is written through `/tea-rags:data-driven-generation`; its Step 7 gate
  (`node build/cli/index.js call review_changes '<json>'`) runs before every
  commit, and the report quotes the `GATE review_changes:` line.
- TDD: a failing test first, for the right reason, then the implementation.
- No `eslint-disable`, no lowered thresholds, no `--no-verify`.
- Runtime errors use the typed hierarchy (`.claude/rules/typed-errors.md`).
- Verticals never import each other: JavaScript mirrors the TypeScript
  recogniser, it does not import it.
- A change under `<lang>/chunking/**` or a file listed in
  `CHUNKING_IMPORTED_SOURCES` moves the `chunking` axis; any other change under
  `<lang>/` except `capability.ts` / `test-files.ts` moves the `walker` axis.
  Bumps land once, in Task 6, followed by `npm run pin:lang-versions`. Tasks
  1–5 leave `version-pins.test.ts` red for the axes they touch; that is
  expected until Task 6.
- Only targeted suites run per task (`npx vitest run <paths>`); the full
  `npm run test:coverage` runs once on `main` after the merge.
- Commit types and scopes per `.claude/rules/commit-rules.md`; the commit body
  ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Impact notes (tea-rags, rerank `blastRadius`)

| File | Signal | Plan consequence |
| --- | --- | --- |
| `trajectory/codegraph/symbols/provider.ts` | 168 commits, `transitiveImpact` 112, `fanOut` 30 | own Task (5) with explicit tests; touch it only if the investigation step proves it necessary |
| `language/kernel/test-scope-chunks.ts` | `bugFixRate` 44 | not modified |
| `ingest/pipeline/chunker/tree-sitter.ts` | 75 commits, chunk `bugFixRate` 57–75 | not modified |
| `rust/` / `typescript/` / `javascript/` chunking hooks | single-owner silos | owner review |

Coordinated change candidates: none shared among the planned files.

---

### Task 1: Rust inline-test recogniser

**Files:**

- Create: `src/core/domains/language/rust/inline-tests.ts`
- Test: `tests/core/domains/language/rust/inline-tests.test.ts`

**Interfaces:**

- Produces:
  - `isInlineTestNode(node: AstNode, code: string): boolean` — true when the
    node and its subtree compile only in the test build.
  - `isRustTestFunctionNode(node: AstNode, code: string): boolean` — a
    `function_item` carrying a test-family attribute.
  - `rustCfgIsTestOnly(predicateText: string): boolean` — `cfg(...)` predicate
    evaluation (exported for the table test).
  - `fileIsInlineTestOnly(root: AstNode, code: string): boolean` — the file
    root carries an inner `#![cfg(test)]`.

**Semantics:**

- Attributes come from AST siblings: walk `node.previousNamedSibling` back
  while its type is `attribute_item` (skip `line_comment` / `block_comment`).
  Inner attributes are `inner_attribute_item` children of the item's
  `declaration_list` (modules) or of the `source_file` root. The attribute
  body is the `attribute` child; `cfg` arguments are its `token_tree`.
- `cfg` evaluation is three-valued (`true` / `false` / `unknown`), with
  `test = false`, `not(x) = ¬x`, `all(...)` = AND, `any(...)` = OR, and any
  other predicate (`feature = "x"`, `unix`, `debug_assertions`) `unknown`.
  Test-only iff the result is definitely `false`.
- Test-function attribute: the last `::` segment of the attribute path is in
  `{test, rstest, test_case, bench, quickcheck, proptest, wasm_bindgen_test}`.
- `isInlineTestNode` is true for an item with a test-only `cfg` outer
  attribute, a `mod_item` with a test-only inner `cfg` attribute, or a
  test-family function.

- [ ] **Step 1: Write the failing table test.** One `it` per row, parsing with
  `tree-sitter-rust` and taking the first `function_item` / `mod_item` of the
  root:

  | Source | Expected `isInlineTestNode` |
  | --- | --- |
  | `#[test]\nfn a() {}` | true |
  | `#[test] fn a() {}` | true |
  | `#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}` | true |
  | `#[test] // flaky\nfn a() {}` | true |
  | `#[test]\n#[should_panic(\n  expected = "x"\n)]\nfn a() {}` | true |
  | `#[wasm_bindgen_test]\nfn a() {}` | true |
  | `#[bench]\nfn a(b: &mut Bencher) {}` | true |
  | `#[quickcheck]\nfn a(x: u8) -> bool { true }` | true |
  | `#[proptest]\nfn a(x: u8) {}` | true |
  | `#[test_case(1 ; "one")]\n#[test_case(2 ; "two")]\nfn a(x: u8) {}` | true |
  | `#[rstest]\nfn a() {}` | true |
  | `#[cfg(test)]\nfn helper() {}` | true |
  | `fn a() {}` | false |
  | `#[cfg(test)]\nmod tests { fn h() {} }` | true |
  | `#[cfg(test)] mod tests { fn h() {} }` | true |
  | `#[cfg(all(test, feature = "x"))]\nmod tests { fn h() {} }` | true |
  | `#[cfg(any(test, feature = "x"))]\nmod testing { fn h() {} }` | false |
  | `#[cfg(not(test))]\nmod real { fn h() {} }` | false |
  | `#[cfg(\n  test\n)]\nmod tests { fn h() {} }` | true |
  | `mod tests {\n  #![cfg(test)]\n  fn h() {}\n}` | true |
  | `mod t {\n  #[test]\n  fn a() {}\n}` (the `mod`) | false |
  | `#[cfg(test)]\nmod tests;` | true |
  | `#[derive(Debug)]\nstruct S;` | false |

  Plus `rustCfgIsTestOnly`: `"test"` → true, `"all(test, unix)"` → true,
  `"any(test, unix)"` → false, `"not(test)"` → false, `"unix"` → false,
  `"all(not(test), test)"` → true. And `fileIsInlineTestOnly` for
  `#![cfg(test)]\nfn a() {}` → true, `fn a() {}` → false.

- [ ] **Step 2: Run it and confirm it fails because the module is missing.**
  `npx vitest run tests/core/domains/language/rust/inline-tests.test.ts`
- [ ] **Step 3: Implement `rust/inline-tests.ts` per the semantics above.**
- [ ] **Step 4: Run the test and confirm it passes;** `npx tsc --noEmit -p .`
  clean.
- [ ] **Step 5: Commit** `feat(chunker): recognise Rust inline test items from AST attributes`.

### Task 2: Rust chunking claims inline tests

**Files:**

- Modify: `src/core/domains/language/rust/chunking/test-scope-chunker.ts`
  (`rustTestScopeChunkerHook`, `buildRustScope`)
- Modify: `src/core/domains/language/rust/chunking/test-dsl-filter.ts`
  (delete the line-reading `leadingRustAttributes`, `hasCfgTestAttribute`,
  `isRustTestModule`, `isRustTestFunction`; keep `rustTestDslFilterHook`)
- Modify: `src/core/domains/language/rust/test-files.ts` (add `**/tests.rs`)
- Modify: `src/core/domains/language/capability/version-axes.ts`
  (`CHUNKING_IMPORTED_SOURCES.rust` gets `${LANGUAGE_ROOT}/rust/inline-tests.ts`)
- Test: `tests/core/domains/language/rust/chunking/` (existing test-scope
  chunker tests are kept; new cases added)

**Interfaces:**

- Consumes: `isInlineTestNode`, `isRustTestFunctionNode` (Task 1).
- Produces: Rust test-only items reach the payload builder with
  `chunkType ∈ {"test", "test_setup"}`.

**Behaviour:**

- The hook claims a `mod_item` when `isInlineTestNode` holds (replacing
  `hasCfgTestAttribute || isRustTestModule`). Inside it, `buildRustScope`
  classifies examples with `isRustTestFunctionNode`.
- A top-level test-only item outside a test module is claimed too. A
  test-family `function_item` becomes one `test` chunk and any other test-only
  item (`#[cfg(test)] fn`, `impl`, `struct`) becomes a `test_setup` chunk. Both
  go through `produceTestScopeChunks` with a single-scope root, so ids and
  headers follow the kernel's rules.
- A module without a test-only `cfg` keeps generic chunking; only its
  test-family functions become `test` chunks.
- `testFiles.patterns` becomes `["**/*_test.rs", "**/tests.rs"]`, with the
  doc comment updated: `tests.rs` is the conventional body of
  `#[cfg(test)] mod tests;`.

- [ ] **Step 1: Write failing chunker tests** (with the real `TreeSitterChunker`,
  as in `tests/core/domains/ingest/pipeline/chunker/container-header-prefix.test.ts`)
  over a `src/lib.rs` fixture holding production `fn add`, a top-level
  `#[cfg(test)] fn fixture()`, a top-level `#[test] fn smoke()`, a one-line
  `#[cfg(test)] mod tests { use super::*; #[test] fn it_works() { add(1, 2); } }`,
  and a `#[cfg(any(test, feature = "x"))] mod testing { pub fn h() {} }`.
  Expected: `add` and `testing::h` are not test chunk types; `fixture` is
  `test_setup`; `smoke` and `it_works` are `test`. Also `classify("src/foo/tests.rs").isTest === true`.
- [ ] **Step 2: Run and confirm they fail on the assertions.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the targeted chunker tests and every existing Rust chunking test;** confirm the
  `it` / `describe` count per existing file is unchanged or larger.
- [ ] **Step 5: Commit** `fix(chunker): chunk Rust inline tests by attribute AST, not source lines`.

### Task 3: Vitest in-source tests for TypeScript and JavaScript

**Files:**

- Create: `src/core/domains/language/typescript/inline-tests.ts`
- Create: `src/core/domains/language/javascript/inline-tests.ts` (mirror)
- Modify: `src/core/domains/language/typescript/chunking/test-scope-chunker.ts`,
  `typescript/chunking/test-dsl-filter.ts`, `typescript/index.ts`
  (`chunkableTypes` gains `if_statement`)
- Modify: the JavaScript mirrors `javascript/chunking/test-scope-chunker.ts`,
  `javascript/chunking/test-dsl-filter.ts`, `javascript/index.ts`
- Modify: `capability/version-axes.ts` — `CHUNKING_IMPORTED_SOURCES` gains
  `typescript: [.../typescript/inline-tests.ts]` and
  `javascript: [.../javascript/inline-tests.ts]`
- Test: `tests/core/domains/language/typescript/inline-tests.test.ts`,
  `tests/core/domains/language/javascript/inline-tests.test.ts`, plus chunker
  tests beside the existing TS/JS test-scope chunker tests

**Interfaces:**

- Produces (per language): `isInlineTestNode(node: AstNode, code: string): boolean`
  — true for an `if_statement` whose condition, with parentheses stripped, is
  `import.meta.vitest`, `import.meta.vitest != null`,
  `import.meta.vitest !== undefined`, or
  `typeof import.meta.vitest !== "undefined"` (either quote style). Read the
  condition node shapes off the grammar, not the text: the `member_expression`
  whose object is the `import.meta` meta property and whose property is
  `vitest`.

**Behaviour:**

- `filterNode` admits an `if_statement` only when `isInlineTestNode` holds, so
  every other top-level `if` keeps today's chunking.
- `testScopeChunkerHook.process` claims an `if_statement` container when
  `isInlineTestNode` holds, in ANY file (the `isTestFile` gate stays for the
  DSL-call path only). The scope root is the `if` block, named `vitest`: the
  `const { it, expect, describe } = import.meta.vitest` line is setup, and
  `describe` / `it` / `test` calls in the block are scopes/examples via the
  existing `buildScopeTree` reading of each DSL call.

- [ ] **Step 1: Write failing recogniser tables** (per language):
  `if (import.meta.vitest) {}` → true; `if ((import.meta.vitest)) {}` → true;
  `if (import.meta.vitest != null) {}` → true;
  `if (typeof import.meta.vitest !== 'undefined') {}` → true;
  `if (!import.meta.vitest) {}` → false; `if (import.meta.env.DEV) {}` → false;
  `if (vitest) {}` → false; `if (import.meta.vitest && flag) {}` → false.
- [ ] **Step 2: Write failing chunker tests** for `src/math.ts` and
  `src/math.js`: `export function add(a, b) { return a + b }` followed by
  `if (import.meta.vitest) { const { it, expect } = import.meta.vitest; it("adds", () => { expect(add(1, 2)).toBe(3) }) }`.
  Expected: `add` is a `function` chunk; the block yields a `test` chunk for
  `adds` and the destructuring as `test_setup` content. A file with a plain
  top-level `if (process.env.X) { init() }` keeps its current chunk output.
- [ ] **Step 3: Run and confirm they fail on the assertions.**
- [ ] **Step 4: Implement both languages.**
- [ ] **Step 5: Run the new tests and every existing TS/JS test-scope chunker test;** check
  `it` counts as in Task 2.
- [ ] **Step 6: Commit** `feat(chunker): chunk Vitest in-source test blocks as test scopes`.

### Task 4: `isTest` follows test chunk types

**Files:**

- Modify: `src/core/contracts/types/chunker.ts` — export
  `TEST_CHUNK_TYPES: ReadonlySet<string> = new Set(["test", "test_setup"])`
  (barrel `contracts/index.ts` if the module is re-exported there)
- Modify: `src/core/api/internal/ops/explore-ops.ts` — drop the local
  constant, import the contract one
- Modify: `src/core/domains/trajectory/static/provider.ts`
  (`StaticPayloadBuilder#buildPayload`)
- Test: `tests/core/domains/trajectory/static/provider.test.ts` (or the
  existing payload-builder test file)

**Behaviour:**
`if (detectTestFile(relativePath, language) || TEST_CHUNK_TYPES.has(m.chunkType)) payload.isTest = true;`

- [ ] **Step 1: Write failing tests:** a chunk with `chunkType: "test"` at
  `src/lib.rs` → `isTest: true`; `"test_setup"` → `isTest: true`;
  `"function"` at `src/lib.rs` → no `isTest` key; `"function"` at
  `tests/a.test.ts` → `isTest: true` (unchanged path rule).
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the provider tests and `tests/core/api/internal/ops/explore-ops*`.**
- [ ] **Step 5: Commit** `fix(trajectory): mark test chunk types as isTest in production files`.

### Task 5: Codegraph keeps inline tests out of the graph

**Files:**

- Modify: `src/core/domains/language/rust/walker/walker.ts`
- Modify: `src/core/domains/language/typescript/walker/walker.ts`
- Modify: `src/core/domains/language/javascript/walker/*` if JavaScript has its
  own extraction path (check `javascript/index.ts`)
- Possibly modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  and `src/core/domains/ingest/pipeline/enrichment/{policy,chunk-phase}.ts`
  — only as the investigation step requires
- Test: `tests/core/domains/language/{rust,typescript,javascript}/walker/`
  and the codegraph provider tests

**Interfaces:**

- Consumes: `isInlineTestNode` per language (Tasks 1, 3).
- Produces: no `CallRef`, import, binding, declaration or inheritance row
  originates inside an inline-test subtree; no `ChunkExtraction` for a chunk
  whose range lies inside one.

**Steps:**

- [ ] **Step 1: Investigate (no edits).** Answer in the task report:
  (a) which traversal helpers each walker's collectors use — is one shared
  `walk` enough to prune, or does each collector need it; (b) how
  `input.chunks` reach the walker and become graph symbols; (c) what
  chunk-phase does for a chunk with no graph row — does it get `enrichedAt`
  with empty signals, or land in recovery / `degraded`? (d) the smallest
  mechanism by which a test chunk gets `codegraph.symbols.chunk.skippedAs =
  "test"`, if (c) shows one is needed.
- [ ] **Step 2: Write failing walker tests:** a Rust file with
  `fn add()` and `#[cfg(test)] mod tests { use super::*; #[test] fn t() { add(); } }`
  yields no call from `tests::t`, no `use super::*` import, and no
  `ChunkExtraction` for the test chunks; same for a TS file with an
  `import.meta.vitest` block calling `add`. Production calls in the same file
  are unchanged (pin an existing production call).
- [ ] **Step 3: If Step 1 (c) shows test chunks would land in recovery, write a
  failing enrichment test** for the chosen mechanism (a test chunk ends
  stamped `skippedAs: "test"` and absent from the recovery set).
- [ ] **Step 4: Implement the pruning, plus the Step 3 mechanism if needed.**
- [ ] **Step 5: Run the walker, provider, and enrichment targeted suites,**
  plus `tests/core/domains/language/materialization/`.
- [ ] **Step 6: Commit** `fix(trajectory): prune inline test subtrees from the codegraph walk`.

### Task 6: Capability, versions, navigators

**Files:**

- Modify: `src/core/domains/language/{rust,typescript,javascript}/capability.ts`
  — `tests.detection` / `tech` text names inline tests (Rust:
  `*_test.rs, tests.rs + #[cfg(test)] / #[test]-family items`; TS/JS adds
  `Vitest in-source (import.meta.vitest)`); bump `versions.chunking` and
  `versions.walker` once each for all three languages
- Run: `npm run pin:lang-versions`, `npm run gen:lang-compat`
- Modify: `src/core/domains/language/CLAUDE.md` (Boundaries: test-ness is
  per-node for languages with inline tests; the predicate is
  `<lang>/inline-tests.ts`, shared by that vertical's hooks and walker — state
  the contract, do not enumerate languages)
- Modify: `src/core/domains/trajectory/codegraph/CLAUDE.md` (Boundaries
  "Tests and generated files…": the exclusion also holds per node via the
  walker's inline-test pruning)
- Test: `tests/core/domains/language/capability/{drift-guard,version-pins}.test.ts`,
  `tests/navigator-code-references.test.ts`,
  `tests/navigator-enumerations.test.ts`

- [ ] **Step 1: Edit the descriptors and bump the versions.**
- [ ] **Step 2: Run `npm run pin:lang-versions && npm run gen:lang-compat`.**
- [ ] **Step 3: Edit the navigators.**
- [ ] **Step 4: Run the capability and navigator tests;** all green.
- [ ] **Step 5: Commit** `chore(language): declare inline test detection and bump chunking/walker`
  with a `BREAKING CHANGE:` footer: Rust, TypeScript and JavaScript projects
  need `tea-rags index-codebase --force` to mark inline tests.

## Completion gate

After merging into `main`: `npm run build`, `npm run test:coverage` once. Live
validation is user-gated: a scoped `--force --languages rust,typescript` on a
corpus with inline tests, then check that `testFile: "only"` returns inline
test chunks and that `production` excludes them.
