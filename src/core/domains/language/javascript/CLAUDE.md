# domains/language/javascript — JavaScript vertical: Vitest/Jest/Mocha test outline by example

Scope of this navigator so far: the test-spec chunking hooks under `chunking/`.
Resolver and walker facts live in the parent `domains/language/CLAUDE.md`; the
canonical cross-language test-chunk contract is
`.claude/rules/test-spec-chunking.md` — read it before touching a hook.

## Invariants

- **The two hooks are a hand-kept MIRROR of `../typescript/chunking/`.**
  `jsTestDslFilterHook` / `jsTestScopeChunkerHook` read the
  tree-sitter-javascript grammar, which has the same node vocabulary for this
  job (call_expression, `function` / `arguments` fields, arrow_function /
  function_expression callbacks, statement_block bodies — bd
  tea-rags-mcp-1etj8). They differ from the TypeScript pair only in the hook
  names, `isTestFile`'s extension list and prose. A change to how a scope or
  example is read or named lands in BOTH, in the same wave. Why: a divergence
  gives a `.js` spec and its `.ts` twin different ids for the same `it`, and no
  test compares the two directories.
- **`jsTestScopeChunkerHook` only READS the AST; the kernel emits.**
  `buildScopeTree` (`chunking/test-scope-chunker.ts`) turns a top-level
  `describe` / `context` / `suite` call into the neutral `TestScope`, and
  `produceScopeChunks` hands it with `extractTopLevelName` to
  `produceTestScopeChunks` (`kernel/test-scope-chunks.ts`), which owns chunk
  shape, ids (`<top>.<scope>.<example>`, `~N`), line ranges and the per-scope
  setup chunks (bd tea-rags-mcp-dppnr, epic tea-rags-mcp-phftd).
- **`setupLines` are the scope's OWN hooks** — the kernel stores each scope's
  once and scopes it by line span. No JavaScript line sets `delegatesExamples`:
  a parametrized `it.each(table)(name, fn)` is ONE example defined inline, and a
  shared-behaviour helper function is not DSL, so it lands in `otherLines`.

## Mechanics

- **Names keep the call as written.** `getCallDisplayName`
  (`chunking/test-dsl-filter.ts`) keeps the callee chain with its modifiers —
  Mocha's `context.only`, `it.skip`, `it.todo`, `test.concurrent`, `it.each` —
  and the first argument verbatim with line breaks folded; `describe(() => …)`
  is named `describe`. `getCallName` sees through a parametrizer call (`each` /
  `for` / `skipIf` / `runIf`) to the DSL call underneath, and no other call
  callee (`makeSuite()('x', fn)`).
- **Mocha's `function () {}` callbacks count like arrows.** `findCallbackBody`
  accepts `function_expression` as well as `arrow_function`, so a Mocha suite
  that relies on `this.timeout(…)` is scoped the same way.

## Gotchas

- **`chunking/` is its own version axis** — any byte under it moves the
  `chunking` digest in `version-pins.json`. The example shape rides the shared
  `chunking` 2 bump: re-pin (`npm run pin:lang-versions`), do not bump, per
  `.claude/rules/test-spec-chunking.md` → Versioning.

## See also

- `../typescript/CLAUDE.md` — the mirrored hooks, the parametrizer rationale,
  the engine's header / `#partN` behaviour.
- `tests/core/domains/language/javascript/chunking/test-outline-by-example.test.ts`
  — example ids, names, and a `find_symbol` stitch through the real chunker.
