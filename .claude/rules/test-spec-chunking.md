---
paths:
  - "src/core/domains/language/*/chunking/test-*.ts"
  - "src/core/domains/language/*/chunking/rspec-*.ts"
  - "tests/core/domains/language/*/chunking/test-*.test.ts"
  - "tests/core/domains/language/*/chunking/rspec-*.test.ts"
  - "src/core/domains/language/kernel/test-scope-chunks.ts"
  - "tests/core/domains/language/kernel/test-scope-chunks.test.ts"
---

# Test-Spec DSL Chunking (MANDATORY canonical structure)

Applies to every chunker hook chunking test-spec files — currently Ruby RSpec
(`hooks/ruby/rspec-filter.ts`, `hooks/ruby/rspec-scope-chunker.ts`) + TS
Vitest/Jest (`hooks/typescript/test-dsl-filter.ts`,
`hooks/typescript/test-scope-chunker.ts`).

New language (Python pytest, Kotlin spek, etc.): follow this canonical structure
end-to-end. Shape intentionally identical across languages → search results
interchangeable.

## Two-hook split (MANDATORY)

Test-spec chunker = **two hooks**, not one:

| Hook file                                                    | Type                                  | Responsibility                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `<lang>/test-dsl-filter.ts` (or `rspec-filter.ts`)           | `filterNode` only, `process` is no-op | `isTestFile(path)` + `getCallName(node)` + DSL-vocabulary membership. Rejects non-DSL call nodes globally added to `chunkableTypes`.            |
| `<lang>/test-scope-chunker.ts` (or `rspec-scope-chunker.ts`) | `process` writer                      | Builds the `TestScope` tree from a CONTAINER call, hands it to the kernel, sets `ctx.skipChildren = true`, claims via writing `ctx.bodyChunks`. |

Split keeps scope-tree weight off filter hot-path, and lets scope chunker assume
callers already known DSL calls in test files.

## DSL vocabulary (three sets per language)

```ts
const CONTAINER_METHODS = new Set([
  /* describe, context, suite, ... */
]);
const EXAMPLE_METHODS = new Set([
  /* it, test, specify, fit, xit, ... */
]);
const SETUP_METHODS = new Set([
  /* beforeEach, beforeAll, let, before, ... */
]);
const ALL_DSL_METHODS = new Set([
  ...CONTAINER_METHODS,
  ...EXAMPLE_METHODS,
  ...SETUP_METHODS,
]);
```

Filter accepts call iff `getCallName(node) ∈ ALL_DSL_METHODS`. Scope chunker
runs only when `getCallName(containerNode) ∈ CONTAINER_METHODS` (guarded via
`isDslContainerCall`).

## Kernel owns emission (MANDATORY — bd tea-rags-mcp-msv3l)

A language's scope chunker does exactly two things: read its AST into the
neutral `TestScope` tree (`src/core/contracts/types/chunker.ts`), and pick the
`topLevelName`. It then hands both to `produceTestScopeChunks`
(`src/core/domains/language/kernel/test-scope-chunks.ts`), which owns what the
chunks are, their ids, their line ranges and the `~N` rule. A hook that builds
`BodyChunkResult`s itself is pre-kernel code awaiting migration (epic
tea-rags-mcp-phftd), never a pattern to copy.

## `TestScope` shape (MANDATORY)

```ts
interface TestScope {
  name: string; // display form of the container call: "describe 'User'", "context \"when admin\""
  startLine: number; // 1-based rows of the container call — orders scopes among examples
  endLine: number;
  setupLines: TestScopeLine[]; // own setup (beforeEach/let/before) — NOT inherited
  otherLines: TestScopeLine[]; // non-DSL statements inside body, non-blank, non-claimed
  examples: TestExample[]; // own examples (it/test/specify)
  children: TestScope[]; // nested container scopes; leaf ↔ children.length === 0
}
interface TestExample {
  name: string; // display form of the example call: "it 'returns nil'", "it.skip \"pending\""
  text: string;
  startLine: number;
  endLine: number;
}
interface TestScopeLine {
  text: string;
  sourceLine: number;
  delegatesExamples?: boolean; // runs examples defined elsewhere (RSpec it_behaves_like)
}
```

## Chunk emission rules (MANDATORY — identical across languages)

The unit is the **example**. Scopes are outline nodes, not chunks.

| Source                                                        | Output                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every example** (leaf or intermediate scope, root included) | One `chunkType: "test"` chunk. `content` = every ancestor's setup (outermost first) + its scope's own setup + its scope's otherLines + the example, joined with `\n`, then `.trim()`. |
| **Leaf without examples** (setup/other only)                  | One chunk of its own setup + otherLines (no ancestor setup): `"test"` when a setup line has `delegatesExamples`, else `"test_setup"`.                                                 |
| **Scope with children or examples**                           | No chunk of its own — its setup reaches the index inside its examples.                                                                                                                |
| **Empty**                                                     | Zero chunks.                                                                                                                                                                          |

Always-applied rules:

- **Min content**: drop chunks where `content.length < 50` (after trim).
- **Size budget**: when an example chunk exceeds `maxChunkSize`, the setup
  prefix sheds whole statements from the OUTERMOST end until it fits; the
  example is never cut by the kernel. An example oversized on its own is split
  by the engine's hard cap into `<exampleId>#partN` windows (`parentSymbolId` =
  the example id), which the outline folds back into one line.
- **Order**: chunks follow source order — scopes and examples interleaved by
  start line.

## symbolId / parent fields (MANDATORY)

| Chunk           | `symbolId`                         | `name`         | `parentSymbolId` | `parentType`                              |
| --------------- | ---------------------------------- | -------------- | ---------------- | ----------------------------------------- |
| Example         | `` `${scopeId}.${example.name}` `` | `example.name` | `scopeId`        | `"test_scope"` (`TEST_SCOPE_PARENT_TYPE`) |
| Setup-only leaf | `scopeId`                          | `scope.name`   | `topLevelName`   | the container's AST type (engine)         |

`scopeId` = `` `${topLevelName}.${scope.name}` `` — the IMMEDIATE scope's name,
not the path: `User.context 'when admin'.it 'can invite'`. A repeated id gets
`~N` (1-based, first occurrence unchanged), counted in source order over the
whole tree; a scope's `~N` carries into its examples' ids.
`parentType: "test_scope"` is what explore reads to draw a scope and to answer a
scope id with an outline of its examples — a test chunk under any other
parentType is a setup-only scope or a pre-example-era chunk and renders as a
plain line.

`topLevelName` extraction priority on root scope's first arg:

1. `string` / `template_string` → strip surrounding quotes (`'`, `"`, `` ` ``)
2. `identifier` / `constant` → use text as-is
3. fallback: full `scope.name`

## Outline contract (what agents see)

- `find_symbol(relativePath: <test file>)` lists each scope id once, at its
  first example, with its example ids nested under it.
- `find_symbol(symbol: <scope id>)` returns an outline of that scope's example
  ids, no bodies.
- `find_symbol(symbol: <example id>)` returns that example's chunk (inherited
  setup + example), `#partN` windows merged.

## Line range rule (MANDATORY)

An example chunk's `startLine` / `endLine` are the example's own rows. A
setup-only chunk's are its own setup + other lines. NEVER include ancestor setup
line ranges — even though ancestor content is spliced into `content` for
context. Else `git blame` lookups + `Read` offsets drift onto the parent's setup
region.

## Versioning (MANDATORY)

The example shape is `sharedVersions.chunking` 2 — the epic's ONE bump. A
language migrating its scope chunker onto the kernel re-pins its own `chunking`
digest WITHOUT bumping (`npm run pin:lang-versions`, commit body
`Versions: covered by *.chunking 2 (tea-rags-mcp-phftd)`), as long as that
shared bump has not yet been released to an index. The bump's scope is test
files only; its minimal remedy is a scoped `--force` over test files
(tea-rags-mcp-j4oww).

## Test-file detection (MANDATORY)

`isTestFile(filePath)` = path predicate. Recommended canonical form:

```ts
function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|rb|py|kt)$/.test(filePath))
    return true;
  return /(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/.test(filePath);
}
```

Adapt extensions per language, keep both branches (extension + directory
convention). False positives on helper files inside `tests/` are safe — filter's
second pass (DSL-vocabulary check) rejects them.

## AST adaptation table (per language)

| Concept               | Ruby AST                                                     | TypeScript AST                                                        | Add column when porting                 |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| Chunkable DSL node    | `call`                                                       | `call_expression`                                                     | Python `call`, Kotlin `call_expression` |
| Callee identifier     | `identifier` child                                           | `function` field → `identifier` or `member_expression` (walk to root) | Mirror for `.skip` / `.only` chain      |
| Callback body wrapper | `do_block` / `block`                                         | `arrow_function` / `function_expression` in `arguments`               | lambda / closure equivalent             |
| Body statements list  | `body_statement` / `block_body`                              | `statement_block` (the `body` field)                                  | block / suite                           |
| First-arg name        | `string` / `simple_string` / `constant` / `scope_resolution` | `string` / `template_string` / `identifier`                           | language-specific literals              |

## Per-container body boundary handling

Generic body chunkers (e.g. `class_body`, Ruby `body_statement`) have AST nodes
**excluding** wrapping braces / `do…end`. TS `statement_block` **includes** `{`
and `}` rows. When collecting `otherLines`, scope chunkers MUST skip those
boundary rows for multi-line bodies. See `findCallbackBody` callers in TS for
canonical pattern.

## Hook chain ordering (cross-reference)

Hook ordering + claim-invariant orchestrator break in
[chunker-hooks.md](./chunker-hooks.md). Test-spec chunkers MUST register
position 3 in chain (after filter + comment-capture, before generic body
chunker).

## Reference implementations

- Emission: `src/core/domains/language/kernel/test-scope-chunks.ts`, spec
  `tests/core/domains/language/kernel/test-scope-chunks.test.ts`. The language
  hooks below still build their own chunks until their phftd migration lands.
- Ruby: `hooks/ruby/rspec-filter.ts` + `hooks/ruby/rspec-scope-chunker.ts`
- TypeScript: `hooks/typescript/test-dsl-filter.ts` +
  `hooks/typescript/test-scope-chunker.ts`
- Tests mirror sources: `tests/.../<lang>/test-*.test.ts` (or `rspec-*.test.ts`)
- End-to-end coverage:
  `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
  asserts `chunkType === "test"` for a real describe block via
  `TreeSitterChunker.chunk`.

## Skill-list sync (MANDATORY when adding or removing a language)

List of languages emitting `chunkType: "test"` / `"test_setup"` is duplicated in
three SKILL.md files consumers read at query time. MUST stay lock-step with
actual `<lang>/test-*.ts` (or `rspec-*.ts`) hook chain. Adding/retiring a
language → update ALL three in same commit:

| File                                                                | What to update                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md` | Iron Rule fallback paragraph — supported-languages list                 |
| `.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md`          | Step 0 SKIP block — parenthesised list under "primary language has no…" |
| `.claude-plugin/tea-rags/skills/filter-building/SKILL.md`           | chunkType section — supported-languages table                           |

Hook headers (`<lang>/test-scope-chunker.ts`, `<lang>/rspec-scope-chunker.ts`)
also carry same pointer block in JSDoc — keep aligned. 3-skill update = part of
language-add work, not follow-up: language not "supported" until consumers know.

## Known limitations (do NOT work around silently)

- **Dynamic-describe in loops** (`for (...) describe(name, ...)` /
  `each do |x| describe ... end`): inner describes NOT discovered as separate
  scopes; absorbed into parent as `otherLines`. Tracked in beads
  `tea-rags-mcp-l180`. Both Ruby + TS share this by design (`buildScopeTree`
  walks direct namedChildren only).
- **Chained-call DSL** (`test.each([...])('name', fn)`): outermost call's callee
  is itself a `call_expression`, so `getCallName` returns null and filter
  rejects it. Not supported in v1.
