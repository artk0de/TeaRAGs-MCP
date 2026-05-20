---
paths:
  - "src/core/domains/ingest/pipeline/chunker/hooks/*/test-*.ts"
  - "src/core/domains/ingest/pipeline/chunker/hooks/*/rspec-*.ts"
  - "tests/core/domains/ingest/pipeline/chunker/hooks/*/test-*.test.ts"
  - "tests/core/domains/ingest/pipeline/chunker/hooks/*/rspec-*.test.ts"
---

# Test-Spec DSL Chunking (MANDATORY canonical structure)

Applies to every chunker hook that produces chunks for test-spec files —
currently the Ruby RSpec hooks (`hooks/ruby/rspec-filter.ts`,
`hooks/ruby/rspec-scope-chunker.ts`) and the TypeScript Vitest/Jest hooks
(`hooks/typescript/test-dsl-filter.ts`,
`hooks/typescript/test-scope-chunker.ts`).

When adding a new language (Python pytest, Kotlin spek, etc.), follow this
canonical structure end-to-end. The shape is intentionally identical across
languages so search results are interchangeable.

## Two-hook split (MANDATORY)

A test-spec chunker is **two hooks**, not one:

| Hook file                                                    | Type                                  | Responsibility                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<lang>/test-dsl-filter.ts` (or `rspec-filter.ts`)           | `filterNode` only, `process` is no-op | `isTestFile(path)` + `getCallName(node)` + DSL-vocabulary membership. Rejects non-DSL call nodes globally added to `chunkableTypes`. |
| `<lang>/test-scope-chunker.ts` (or `rspec-scope-chunker.ts`) | `process` writer                      | Builds scope tree from a CONTAINER call, emits per-leaf chunks, sets `ctx.skipChildren = true`, claims via writing `ctx.bodyChunks`. |

Splitting prevents the filter's hot-path checks from carrying scope-tree weight,
and lets the scope chunker assume callers are already known to be DSL calls in
test files.

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

Filter accepts a call iff `getCallName(node) ∈ ALL_DSL_METHODS`. Scope chunker
only runs when `getCallName(containerNode) ∈ CONTAINER_METHODS` (guarded via
`isDslContainerCall`).

## `Scope` shape (MANDATORY)

```ts
interface TestScope {
  name: string; // formatted: `${callName} ${firstArgText}` e.g. "describe 'User'"
  node: Parser.SyntaxNode; // the AST node of the container call
  isLeaf: boolean; // true ↔ children.length === 0
  setupLines: SetupLine[]; // own setup (beforeEach/let/before) — NOT inherited
  ownItBlocks: ItBlock[]; // own example calls (it/test/specify)
  children: TestScope[]; // nested container scopes (describe/context inside)
  otherLines: SetupLine[]; // non-DSL statements inside body, non-blank, non-claimed
}
```

`SetupLine.sourceLine` and `ItBlock.startLine/endLine` are 1-based source line
numbers used for chunk line-range computation.

## Chunk emission rules (MANDATORY — identical across languages)

For each scope encountered while walking the tree from root:

| Scope kind                                                    | Output                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leaf with its**                                             | One `chunkType: "test"` chunk. `content` = inherited ancestor setup + own setup + otherLines + it blocks, joined with `\n`, then `.trim()`. |
| **Leaf without its** (only setup/other)                       | One `chunkType: "test_setup"` chunk. Same composition minus its.                                                                            |
| **Intermediate with own its** (has children AND own examples) | One extra `chunkType: "test_setup"` chunk for own setup + otherLines + own its. Children walked separately.                                 |
| **Intermediate without own its**                              | Walked recursively; no chunk for the intermediate itself.                                                                                   |
| **Empty** (no its, no setup, no other)                        | Skipped — zero chunks.                                                                                                                      |

Always-applied filters:

- **Min content**: drop chunks where `content.length < 50` (after trim).
- **Oversized split**: when
  `content.length > maxChunkSize && ownItBlocks.length > 1`, emit one chunk per
  `it` block with `setupParts + otherParts` duplicated as shared prefix. Same
  `symbolId` across the split parts.

## symbolId / parent fields (MANDATORY)

| Field            | Format                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `symbolId`       | `` `${topLevelName}.${scope.name}` `` — e.g. `"User.context 'when admin'"` or `"CLI 'doctor' command.describe \"orphan count\""` |
| `name`           | `scope.name` — formatted as `"describe 'X'"` / `"context 'Y'"` / `"it.skip 'Z'"`                                                 |
| `parentSymbolId` | `topLevelName` only — strip quotes/backticks from string args, use identifier text for `describe(User, …)`                       |
| `parentType`     | `"call_expression"` (TS) / `"call"` (Ruby) — the AST node type of the top-level container                                        |

`topLevelName` extraction priority on the root scope's first arg:

1. `string` / `template_string` → strip surrounding quotes (`'`, `"`, `` ` ``)
2. `identifier` / `constant` → use text as-is
3. fallback: full `scope.name`

## Line range rule (MANDATORY)

`startLine` / `endLine` MUST be computed from the scope's **own** line sources
only (own setupLines + own otherLines + own ownItBlocks). NEVER include ancestor
setup line ranges, even though their content is spliced into chunk `content` for
context. Otherwise `git blame` lookups and `Read` offsets drift onto the
parent's setup file region.

## Test-file detection (MANDATORY)

`isTestFile(filePath)` is a path predicate. Recommended canonical form:

```ts
function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|rb|py|kt)$/.test(filePath))
    return true;
  return /(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/.test(filePath);
}
```

Adapt extensions per language but keep both branches (extension + directory
convention). False positives on helper files inside `tests/` are safe — the
filter's second pass (DSL-vocabulary check) rejects them.

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
that **exclude** the wrapping braces / `do…end`. TypeScript's `statement_block`
**includes** the `{` and `}` rows. When collecting `otherLines`, scope chunkers
MUST skip those boundary rows for multi-line bodies. See `findCallbackBody`
callers in TS for the canonical pattern.

## Hook chain ordering (cross-reference)

Hook ordering and the claim-invariant orchestrator break are in
[chunker-hooks.md](./chunker-hooks.md). Test-spec chunkers MUST be registered
position 3 in the chain (after filter + comment-capture, before generic body
chunker).

## Reference implementations

- Ruby: `hooks/ruby/rspec-filter.ts` + `hooks/ruby/rspec-scope-chunker.ts`
- TypeScript: `hooks/typescript/test-dsl-filter.ts` +
  `hooks/typescript/test-scope-chunker.ts`
- Tests mirror sources: `tests/.../<lang>/test-*.test.ts` (or `rspec-*.test.ts`)
- End-to-end coverage:
  `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
  asserts `chunkType === "test"` for a real describe block via
  `TreeSitterChunker.chunk`.

## Skill-list sync (MANDATORY when adding or removing a language)

The list of languages that emit `chunkType: "test"` / `"test_setup"` is
duplicated in three SKILL.md files that consumers read at query time. They MUST
stay in lock-step with the actual `<lang>/test-*.ts` (or `rspec-*.ts`) hook
chain. When you add a new language (or retire one), update ALL three in the same
commit:

| File                                                                | What to update                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md` | Iron Rule fallback paragraph — supported-languages list                 |
| `.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md`          | Step 0 SKIP block — parenthesised list under "primary language has no…" |
| `.claude-plugin/tea-rags/skills/filter-building/SKILL.md`           | chunkType section — supported-languages table                           |

The hook headers (`<lang>/test-scope-chunker.ts`,
`<lang>/rspec-scope-chunker.ts`) also carry the same pointer block in their
JSDoc — keep them aligned. Treat the 3-skill update as part of the language-add
work, not a follow-up: the language is not "supported" until consumers know
about it.

## Known limitations (do NOT work around silently)

- **Dynamic-describe in loops** (`for (...) describe(name, ...)` /
  `each do |x| describe ... end`): inner describes are NOT discovered as
  separate scopes; they're absorbed into parent as `otherLines`. Tracked in
  beads `tea-rags-mcp-l180`. Both Ruby and TS share this limitation by design
  (`buildScopeTree` walks direct namedChildren only).
- **Chained-call DSL** (`test.each([...])('name', fn)`): outermost call's callee
  is itself a `call_expression`, so `getCallName` returns null and the filter
  rejects it. Not supported in v1.
