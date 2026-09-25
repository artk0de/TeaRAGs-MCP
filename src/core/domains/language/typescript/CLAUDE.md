# domains/language/typescript — TypeScript vertical: Vitest/Jest test outline by example

Scope of this navigator so far: the test-spec chunking hooks under `chunking/`.
Resolver-chain, `TSProgramCache` and walker facts live in the parent
`domains/language/CLAUDE.md`; the canonical cross-language test-chunk contract
is `.claude/rules/test-spec-chunking.md` — read it before touching a hook.

## Invariants

- **`testScopeChunkerHook` only READS the AST; the kernel emits.**
  `buildScopeTree` (`chunking/test-scope-chunker.ts`) turns a top-level
  `describe` / `context` / `suite` call into the neutral `TestScope`, and
  `produceScopeChunks` hands it with `extractTopLevelName` to
  `produceTestScopeChunks` (`kernel/test-scope-chunks.ts`). One chunk per `it` /
  `test` example, id `<top>.<scope>.<example>`, parented by the scope id with
  `parentType: "test_scope"`; `~N`, the 50-char floor, setup inheritance and the
  size budget are the kernel's. Why: building a `BodyChunkResult` here forks the
  id shape the explore outline and `find_symbol` read (bd tea-rags-mcp-b55x2,
  epic tea-rags-mcp-phftd).
- **`setupLines` are the scope's OWN hooks** — `beforeEach` / `beforeAll` /
  `afterEach` / `afterAll` / `before` / `after` / `setup` / `teardown`. The
  kernel prepends the ancestors'; copying them in here doubles them in every
  example. Non-DSL statements of the body (`const`, `vi.mock(...)`, a `for`
  loop) are `otherLines` and reach only the examples of that same scope.
- **No TypeScript line sets `delegatesExamples`.** A parametrized
  `it.each(table)(name, fn)` / `test.for(cases)(name, fn)` is ONE example
  defined inline, not a statement running examples defined elsewhere; there is
  no `it_behaves_like` counterpart in Vitest/Jest. A custom shared-behaviour
  helper (`itBehavesLikeARepository()`) is not DSL and lands in `otherLines`.

## Mechanics

- **A name is the call as written plus its first argument.**
  `getCallDisplayName` (`chunking/test-dsl-filter.ts`) keeps the callee chain
  with its modifiers — `it.skip`, `describe.only`, `test.concurrent`, `it.todo`,
  `it.each` — whitespace removed, a parametrizer's table dropped; the first
  argument is kept verbatim, quotes included, line breaks folded to a space.
  `describe(() => …)` is named `describe`, never by its callback text. Why: the
  bead requires `.skip` / `.only` visible, and a verbatim literal greps back to
  the source.
- **Parametrizers are seen through, not modelled.** `getCallName` resolves a
  callee that is itself a call on a `PARAMETRIZER_MEMBERS` member (`each`,
  `for`, `skipIf`, `runIf`) to the DSL call underneath, so the filter admits
  `describe.each(t)('x', fn)` at top level and the scope chunker files
  `it.each(t)('x', fn)` as an example. Any other call callee
  (`makeSuite()('x', fn)`) stays non-DSL. Why: before this, a parametrized
  example inside a `describe` fell into `otherLines` and was pasted into every
  sibling example's chunk.
- **A DSL name alone does not make an example or a chunk.** `buildScopeTree`
  files an example-named call as an example only when its arguments carry a
  string / template title or a callback (`isExampleShaped`), so a helper call
  `test(app)` is an `otherLines` statement while `it.todo('x')` stays an
  example. `isInsideHelperDefinition` (`chunking/test-dsl-filter.ts`) rejects
  every DSL call under a function that is not invoked in place (a declared,
  assigned or returned helper, not a callback or IIFE), so the helper stays one
  plain function chunk. Why: each `it` in `function test(app) {…}` became a leaf
  `test.it` — five identical title-less ids — and a nested describe claimed its
  rows while the helper's own statements reached no chunk (bd
  tea-rags-mcp-c0vdv).
- **`topLevelName` prefers a string / template literal (quotes stripped) or an
  identifier among the root call's arguments, else the root scope's name.** A
  `describe.each` root is therefore named by its title template (`Cart in %s`),
  not per row.

## Gotchas

- **The engine prepends the claimed container's header line to every hook chunk,
  and splits an example still over `maxChunkSize` into `<exampleId>#partN`.** A
  unit test on `produceScopeChunks` sees neither; drive `TreeSitterChunker` when
  a test asserts stored content or the `#partN` stitch. Why: the pre-kernel hook
  gave every oversized part the scope id, which is how the epic's reproducer
  outlined as `describe #part1..#part4` with no `it` names.
- **The hook sees only DIRECT statements of a callback body.** A `describe`
  created inside a loop or helper is not a scope (bd tea-rags-mcp-l180), and a
  callback with an expression body has no scope body at all.
- **`chunking/` is its own version axis.** Any byte under it — a comment
  included — moves the `chunking` digest in `version-pins.json`; the example
  shape rides the shared `chunking` 2 bump, so a change here re-pins
  (`npm run pin:lang-versions`) and does not bump, per
  `.claude/rules/test-spec-chunking.md` → Versioning.

## See also

- `.claude/rules/test-spec-chunking.md`, `.claude/rules/chunker-hooks.md`
- `tests/core/domains/language/typescript/chunking/test-outline-by-example.test.ts`
  — the epic reproducer, driven through the real chunker and `resolveSymbols`.
