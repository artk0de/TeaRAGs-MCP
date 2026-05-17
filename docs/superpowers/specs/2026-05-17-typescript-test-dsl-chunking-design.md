# TypeScript Test DSL Chunking — Design

**Status:** Approved-pending-implementation **Date:** 2026-05-17 **Author:**
Arthur Korochansky (with Claude)

## Problem

The TypeScript chunker emits zero semantic chunks for test files whose top-level
structure is `describe(...)` calls only. Current TS `chunkableTypes` recognises
`function_declaration`, `method_definition`, `class_declaration`,
`interface_declaration`, `type_alias_declaration`, `enum_declaration` — none of
which match a `describe()` top-level call. Test files therefore fall through to
default chunking and either produce a single whole-file chunk or no semantic
structure at all, which:

- dilutes vector-search signal for queries like "what tests cover admin login
  flow"
- breaks `find_symbol` for test names
- removes test-files from the same ranking presets (codeReview, hotspots) that
  already work for Ruby spec files

Ruby solved the same problem in `hooks/ruby/rspec-filter.ts` +
`hooks/ruby/rspec-scope-chunker.ts`: one chunk per leaf RSpec scope, with
inherited setup, `symbolId = TopDescribe.leafName`,
`chunkType = test`/`test_setup`. Ruby spec files are now first-class in semantic
search.

## Goal

Port the Ruby RSpec chunker hooks to TypeScript with **identical chunking
logic**, adapted only to TS AST node types and the Jest-family DSL. Cover the
testing frameworks that share the `describe`/`it`/`test`/`before*`/ `after*`
vocabulary: Vitest, Jest, Mocha, Jasmine, Bun test, Cypress, node:test, and
Playwright's identifier-form (`test.describe` is handled by member-expression
callee walking).

Non-goals (deferred to follow-up beads issues):

- AVA (flat `test('name', fn)` model, no describe)
- `test.each(table)(name, fn)` chained-call extraction
- E2E layout detection (`e2e/`, `cypress/`, `playwright/` directories)
- Vitest/Jest config-driven custom test-path overrides

## Architecture

Two new files mirror the Ruby hook split:

```
src/core/domains/ingest/pipeline/chunker/hooks/typescript/
  test-dsl-filter.ts        ← port of rspec-filter.ts
  test-scope-chunker.ts     ← port of rspec-scope-chunker.ts
  index.ts                  ← register both new hooks in chain
  class-body-chunker.ts     (unchanged)
  comment-capture.ts        (unchanged)
  utils.ts                  (unchanged)
```

One edit to `chunker/config.ts`:

```ts
typescript: {
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "call_expression",        // +1
  ],
  childChunkTypes: [
    "method_definition",
    "call_expression",        // +1
  ],
  alwaysExtractChildren: true,
  hooks: typescriptHooks,
}
```

Hook chain registration in `hooks/typescript/index.ts`:

```ts
export const typescriptHooks: ChunkingHook[] = [
  testDslFilterHook, // filterNode: accept DSL calls in test files
  typescriptCommentCaptureHook, // must run before body chunker
  testScopeChunkerHook, // process: scope-tree → chunks, skipChildren=true
  typescriptBodyChunkingHook, // unchanged
];
```

The base chunker is **not touched**. The pattern is the same one Ruby uses
today: chunkable node type added globally, hook's `filterNode` rejects non-test
files at O(1) cost (one regex check on `filePath`).

## Component Responsibilities

### `test-dsl-filter.ts`

Mirror of `rspec-filter.ts`. Two responsibilities:

1. `isTestFile(filePath)` — single source of truth for test-file detection.
2. `testDslFilterHook.filterNode` — for each candidate `call_expression`:
   - return `undefined` if node is not `call_expression` (no opinion, let other
     hooks decide)
   - return `false` if file is not a test file
   - return `false` if callee name (after member-expression unwrap) is not in
     DSL vocabulary
   - return `true` otherwise

`isTestFile` regex (Option A — canonical layout, decided in brainstorm):

```ts
function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(filePath)) return true;
  return /(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/.test(filePath);
}
```

DSL vocabulary constants (mirror of Ruby `RSPEC_*_METHODS`):

```ts
const CONTAINER_METHODS = new Set(["describe", "context", "suite"]);

const EXAMPLE_METHODS = new Set([
  "it",
  "test",
  "bench",
  "fit",
  "ftest",
  "xit",
  "xtest",
]);

const SETUP_METHODS = new Set([
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "before",
  "after",
  "setup",
  "teardown",
]);

const ALL_DSL_METHODS = new Set([
  ...CONTAINER_METHODS,
  ...EXAMPLE_METHODS,
  ...SETUP_METHODS,
]);
```

Callee name extraction handles two AST shapes:

```ts
function getCallName(node: Parser.SyntaxNode, code: string): string | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  if (!callee) return null;

  // Plain: it(...), describe(...)
  if (callee.type === "identifier") {
    return code.substring(callee.startIndex, callee.endIndex);
  }

  // Member: it.skip(...), test.each(...), describe.only(...)
  // Walk member_expression.object until we reach the root identifier.
  if (callee.type === "member_expression") {
    let cursor: Parser.SyntaxNode | null = callee;
    while (cursor && cursor.type === "member_expression") {
      cursor = cursor.childForFieldName("object");
    }
    if (cursor && cursor.type === "identifier") {
      return code.substring(cursor.startIndex, cursor.endIndex);
    }
  }

  return null;
}
```

The modifier suffix (`.skip`, `.only`, `.each`, `.concurrent`, `.failing`,
`.todo`) is **not** carried into the chunk name — `it.skip('foo', ...)`
classifies identically to `it('foo', ...)`.

No equivalent of `isShouldaOneLiner` is ported — TypeScript has no shoulda-style
matcher and `it('name')` without a callback is uncommon (usually a test author
error).

### `test-scope-chunker.ts`

Mirror of `rspec-scope-chunker.ts`. Same exported shape:

- `TestScope` interface (1:1 with `RSpecScope`): `name`, `node`, `isLeaf`,
  `setupLines`, `ownItBlocks`, `children`, `otherLines`
- `buildScopeTree(containerNode, code): TestScope`
- `produceScopeChunks(rootScope, code, config): BodyChunkResult[]`
- `testScopeChunkerHook: ChunkingHook` — `process(ctx)` runs three guards before
  doing work, then calls `buildScopeTree` followed by `produceScopeChunks`,
  writes `ctx.bodyChunks`, sets `ctx.skipChildren = true` so class-body chunker
  doesn't double-emit for this container.

Process guards (mirror of Ruby's `isRspecFile` check, with one TS-specific
addition):

```ts
process(ctx) {
  if (!isTestFile(ctx.filePath)) return;
  if (ctx.containerNode.type !== "call_expression") return;       // TS-only
  if (!isDslContainerCall(ctx.containerNode, ctx.code)) return;   // TS-only

  const tree = buildScopeTree(ctx.containerNode, ctx.code);
  const chunks = produceScopeChunks(tree, ctx.code, ctx.config);
  if (chunks.length > 0) {
    ctx.bodyChunks = chunks;
    ctx.skipChildren = true;
  }
}
```

Why the extra TS guards (not needed in Ruby): a Ruby spec file is effectively
DSL-only — any chunkable node that survived filterNode is guaranteed to be an
RSpec call. A TS test file commonly contains helper classes, helper functions,
and fixture constants alongside `describe()` calls. `filterNode` returns
`undefined` for non-`call_expression` nodes (it has no opinion on them), so
`class_declaration` and `function_declaration` survive into `process()`. Without
the `containerNode.type` check the hook would treat a helper class as if it were
a describe and produce nonsensical chunks. `isDslContainerCall` further narrows
to `describe`/`context`/`suite` so a stray top-level `it()` call doesn't get
treated as a container.

`skipChildren = true` is scoped to the current `containerNode` only — when the
hook runs on a top-level `describe()` it suppresses child emission for that
subtree, but separate top-level helper classes/functions in the same file still
go through the regular class-body chunker.

The chunking algorithm is **byte-for-byte the same as Ruby**:

| Scope kind                  | Output                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf with `it` blocks       | One `test` chunk: inherited setup + own setup + other lines + it blocks. `symbolId = TopName.leafName`. Auto-split per-it if `content.length > maxChunkSize && ownItBlocks.length > 1` (each split gets shared setup duplicated). |
| Leaf without `it` blocks    | One `test_setup` chunk if `setupLines.length > 0 \|\| otherLines.length > 0`.                                                                                                                                                     |
| Intermediate (has children) | Recurse into children. If intermediate also has own `it` blocks, emit one extra `test_setup` chunk for setup + those it blocks.                                                                                                   |
| Root                        | If root is leaf, process directly. Otherwise walk children with root as ancestor. Root's own it blocks (rare for `describe(...)`) emit a `test_setup` chunk.                                                                      |

Min-content threshold (50 chars) and line-range computation rules (line range
from scope's own lines only, not ancestors — to keep git blame and Read offsets
correct) carry over unchanged.

`DELEGATING_TEST_METHODS` from Ruby (`it_behaves_like`, `include_examples`) is
**not** ported — TypeScript has no equivalent shared-examples mechanism.
`describe.each(...)` produces real describes, not delegations.

### TS-specific AST shape adaptation

| Concept                     | Ruby AST                                                                    | TypeScript AST                                                                                              |
| --------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chunkable DSL node          | `call`                                                                      | `call_expression`                                                                                           |
| Callee identifier           | `identifier` child of `call`                                                | `function` field of `call_expression`; either `identifier` or `member_expression` (walk to root identifier) |
| Callback body wrapper       | `do_block` / `block` child                                                  | `arrow_function` or `function_expression` in `arguments`, then its `body` field                             |
| Body statements list        | `body_statement` / `block_body` inside wrapper                              | `statement_block` (the `body` field itself)                                                                 |
| Test/scope name (first arg) | `string` / `simple_string` / `constant` / `scope_resolution` in `arguments` | `string` / `template_string` / `identifier` in `arguments`                                                  |

Concrete helpers in `test-scope-chunker.ts`:

```ts
function findCallbackBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type === "arrow_function" || arg.type === "function_expression") {
      const body = arg.childForFieldName("body");
      if (body && body.type === "statement_block") return body;
    }
  }
  return null;
}

function extractScopeName(node: Parser.SyntaxNode, code: string): string {
  // Format: "describe 'name'" or "it 'name'" — preserve the human label
  // by taking the literal text of the call up to but not including the
  // callback argument.
  const callName = getCallName(node, code);
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildren.length === 0) return callName ?? "unknown";

  const firstArg = args.namedChildren[0];
  const nameText = code.substring(firstArg.startIndex, firstArg.endIndex);
  return callName ? `${callName} ${nameText}` : nameText;
}

function extractTopLevelName(scope: TestScope, code: string): string {
  const args = scope.node.childForFieldName("arguments");
  if (args) {
    for (const arg of args.namedChildren) {
      if (arg.type === "identifier") {
        return code.substring(arg.startIndex, arg.endIndex);
      }
      if (arg.type === "string" || arg.type === "template_string") {
        const text = code.substring(arg.startIndex, arg.endIndex);
        return text.replace(/^['"`]|['"`]$/g, "");
      }
    }
  }
  return scope.name;
}
```

Async callbacks (`async () => { ... }`, `async function () { ... }`) require no
special handling — `arrow_function.body` and `function_expression.body` are
`statement_block` regardless of `async`.

## Edge cases (v1 behavior)

| Case                                                              | Behavior                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ``describe(`User ${role}`, () => …)``                             | name = literal text as-is including `${...}` (no interpolation)                                                                    |
| `describe(SomeVar, () => …)` (identifier name)                    | name = identifier text (`"SomeVar"`)                                                                                               |
| `test.each([...])('name %s', fn)`                                 | filterNode rejects: callee is `call_expression`, not identifier/member_expression. Deferred to follow-up issue.                    |
| `async () => { ... }` callback                                    | handled transparently                                                                                                              |
| `it('name')` with no callback                                     | scope-walker finds no body → no chunk emitted                                                                                      |
| `.only` / `.skip` / `.concurrent` / `.failing` / `.todo`          | classified by root identifier; modifier dropped from `name`                                                                        |
| Top-level helper code in a test file (non-DSL `function`/`class`) | class-body chunker still runs for those nodes — only DSL subtrees are claimed by `skipChildren=true` semantics (set per-container) |
| Empty test file (only imports)                                    | no DSL calls match, no chunks from this hook; default behavior unchanged                                                           |

## Test-file detection

The single regex pair in `isTestFile` is the contract:

```ts
/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/
/(^|[/\\])(__tests__|__specs__|tests?|specs?)[/\\]/
```

Decision recorded in brainstorm: false positives on helper files inside `tests/`
(e.g. `tests/.../__helpers__/test-helpers.ts`) are safe — the helper's non-DSL
calls are filtered out by `filterNode`'s second check (callee name not in DSL
set), so the file goes through the default class- body chunker.

## Error handling

No try/catch in either hook. Per project rule (typed-errors), errors during AST
walking are programming errors (invariant violations) and bubble up. The base
chunker's `enforceMaxChunkSize` already covers oversized content as a defensive
net even if `produceScopeChunks`'s own per-it split misses an edge case.

## Testing strategy

Two new test files mirror the Ruby tests one-for-one:

```
tests/core/domains/ingest/pipeline/chunker/hooks/typescript/
  test-dsl-filter.test.ts        ← mirrors ruby/rspec-filter.test.ts
  test-scope-chunker.test.ts     ← mirrors ruby/rspec-scope-chunker.test.ts
```

Test fixtures are inline string literals representing minimal `.test.ts` files.
Coverage targets (mirroring Ruby tests):

- `isTestFile` — true/false for each pattern category, edge cases (no extension,
  `.tsx`, `tests-old/`, `testing.ts` without dir)
- `getCallName` — plain identifier, member expression depth 1 (`it.skip`), depth
  2 (`it.skip.each`), non-call node
- `buildScopeTree` — flat describe with its, nested describes, intermediate with
  own its, mixed setup, async callbacks, template literal names, identifier
  names
- `produceScopeChunks` — leaf chunks, intermediate chunks, oversized split,
  min-content rejection, line-range correctness (own lines only)
- Hook chain integration — `skipChildren` behavior, ordering with
  `commentCaptureHook` and `classBodyChunkingHook`

Tree-sitter mock pattern follows the existing project convention (per-test- file
mock; see `.claude/rules/test-patterns.md`).

## Risk register

Three risks surfaced by tea-rags enrichment of `**/chunker/**`:

1. **Template fragility.** `rspec-scope-chunker.ts` is a deep-silo Hotspot
   (bugFixRate 38 concerning, 100% solo author). The port copies its structure
   but interrogates each branch — particularly the line-range computation (Ruby
   fixed a "ancestor setup inflates range" bug; the port inherits the fix from
   day one).
2. **Base chunker churn.** `chunker/tree-sitter.ts` had 6 commits in 6 days. The
   change minimises coupling — we only touch `config.ts` `chunkableTypes` array
   and add new files. No changes to `tree-sitter.ts` itself.
3. **Silo-pairing rule.** Both `hooks/typescript/index.ts` (target) and the Ruby
   files (template) are deep-silos. Commit message MUST include a `Why:` line
   per `.claude/rules/silo-pairing.md`.

## Re-index requirement

This change touches the chunker output (new `chunkType = "test"` /
`"test_setup"` values, new `symbolId` patterns for TS test files). After
landing, `force_reindex` is required on tea-rags self-test (`code_8b243ffe`) per
`.claude/CLAUDE.md` schema-drift section — existing TS test files in the index
were chunked under the old (effectively empty) test-file behavior and must be
re-chunked. For user projects (production-rails-app etc.) the next incremental reindex will
re-chunk only modified test files; already-indexed test files remain on the old
shape until force-reindex or file edit.

## Follow-up beads issues (created after writing-plans approval)

1. Playwright/Cypress/E2E layout support (`e2e/`, `cypress/`, `playwright/`
   directories + `test.describe` style — already covered by member- expression
   logic; this issue adds path detection).
2. `test.each(table)(name, fn)` chained-call extraction.
3. AVA flat-test support.
4. Config-driven custom test-path patterns.

## Affected files

| Path                                                                                     | Change                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/chunker/config.ts`                                     | edit: add `call_expression` to `typescript.chunkableTypes` and `childChunkTypes` |
| `src/core/domains/ingest/pipeline/chunker/hooks/typescript/index.ts`                     | edit: register two new hooks in chain                                            |
| `src/core/domains/ingest/pipeline/chunker/hooks/typescript/test-dsl-filter.ts`           | new                                                                              |
| `src/core/domains/ingest/pipeline/chunker/hooks/typescript/test-scope-chunker.ts`        | new                                                                              |
| `tests/core/domains/ingest/pipeline/chunker/hooks/typescript/test-dsl-filter.test.ts`    | new                                                                              |
| `tests/core/domains/ingest/pipeline/chunker/hooks/typescript/test-scope-chunker.test.ts` | new                                                                              |
