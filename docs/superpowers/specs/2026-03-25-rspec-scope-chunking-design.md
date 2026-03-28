# RSpec Scope-Centric Chunking

**Date:** 2026-03-25 **Status:** Approved **Scope:** `chunker/hooks/ruby/`

## Problem

The current RSpec chunking strategy treats RSpec files like Ruby classes —
recursing into `describe`/`context` as containers and extracting `it` blocks as
leaf children. This produces six concrete problems:

1. **Mega-chunks (3000+ lines):** `extractRspecBodyChunk` collects ALL non-child
   lines into a single body chunk without size limits.
2. **Micro-chunks (1-2 lines):** Individual `it` or `context` blocks with
   minimal content pass the 50-character threshold.
3. **Lost setup context:** `let`/`before`/`subject` end up in body chunks while
   `it` blocks are separate leaf chunks — no semantic connection.
4. **symbolId overflow:** `buildParentPath` joins all nesting levels with `>`,
   producing 300+ character strings for deep specs.
5. **Duplicate `it` names:** Different `it` blocks with identical text in
   different contexts are indistinguishable by `name`.
6. **Single chunkType:** All RSpec chunks get `chunkType: "block"` — no way to
   filter tests from other code.

## Solution: Scope-Centric Chunking

**Core principle:** A leaf scope (`describe`/`context` with no nested
`describe`/`context`) is the unit of chunking. Each leaf chunk contains all
`let`/`before`/`subject`/`it` from that scope, plus injected setup from parent
scopes.

**Architectural approach:** The scope chunker takes over the ENTIRE chunking for
RSpec files. Instead of working within the per-level `processChildren`
recursion, the hook walks the full AST subtree from the root container, builds a
scope tree, and produces all chunks at once. This is necessary because parent
setup injection requires visibility into ancestor scopes — which the per-level
HookContext does not provide.

### Leaf Scope Definition

A **leaf scope** is a `describe`, `context`, `feature`, `shared_examples`, or
`shared_context` block that contains no nested container blocks — only `it`
blocks, setup (`let`/`before`/`subject`), and helper calls.

A **non-leaf (intermediate) scope** is one that contains nested
`describe`/`context` blocks. Its own `it` blocks (siblings of nested scopes) are
included in the intermediate scope's body chunk.

```ruby
describe User do                            # root container — recurse into
  let(:company) { create(:company) }        # root setup

  it 'has a name' do ... end                # ← body chunk of root (intermediate)

  context 'when admin' do                   # intermediate — has nested context
    let(:user) { create(:admin, company:) } # intermediate setup

    context 'with expired token' do         # LEAF — no nested context
      let(:token) { expired_token(user) }
      it 'denies access' do ... end
      it 'shows error' do ... end
    end
  end
end
```

Resulting chunks:

1. **Leaf chunk** (`"test"`): `context 'with expired token'` — contains
   `let(:company)` + `let(:user)` (injected parent setup) + `let(:token)` + both
   `it` blocks.
2. **Body chunk** (`"test_setup"`): root scope body — `let(:company)` +
   `it 'has a name'`.

### Oversized Leaf Scope Splitting

When a leaf scope exceeds `maxChunkSize`, split into groups of `it` blocks by
accumulated size. Each sub-chunk receives the same setup injection (all
`let`/`before`/`subject` from the leaf scope and its parents).

```
leaf scope (500 lines, 30 it blocks)
  → sub-chunk 1: setup + it[0..9]     (~maxChunkSize)
  → sub-chunk 2: setup + it[10..19]   (~maxChunkSize)
  → sub-chunk 3: setup + it[20..29]   (~maxChunkSize)
```

Setup duplication across sub-chunks is acceptable — typically 5-15 lines,
improves semantic search recall.

### Parent Setup Injection

For each leaf scope, collect `let`/`before`/`subject` calls from ALL ancestor
scopes (root → intermediate → leaf). Inject them at the top of the chunk in
nesting order:

```
# Injected from: describe User
let(:company) { create(:company) }
# Injected from: context 'when admin'
let(:user) { create(:admin, company:) }
# --- leaf scope: context 'with expired token' ---
let(:token) { expired_token(user) }
it 'denies access' do ... end
```

**Setup identification:** Lines starting with `let`, `let!`, `subject`,
`before`, `after`, `around`, `shared_context`, `include_context`,
`it_behaves_like`, `include_examples`.

Note: `let!` is NOT currently in `DECLARATION_KEYWORDS` in
`class-body-chunker.ts` — it must be added as part of this work (`let!` →
`"setup"`).

### New chunkType Values

Extend the `ChunkType` union:

```typescript
type ChunkType =
  | "function"
  | "class"
  | "interface"
  | "block"
  | "test"
  | "test_setup";
```

| chunkType      | When                                                       |
| -------------- | ---------------------------------------------------------- |
| `"test"`       | Leaf scope chunk (contains `it` blocks)                    |
| `"test_setup"` | Body chunk of intermediate scope (setup without own tests) |

No backward-compatibility alias. Existing `chunkType: "block"` filters were
returning noise for RSpec chunks anyway.

### 2-Level symbolId

Format: `TopLevelDescribe.leafScopeName`

```
# Before (current):
"describe User > context 'when admin' > context 'with expired token'"

# After:
"User.context 'with expired token'"
```

- `TopLevelDescribe` = first argument of the root `describe`/`RSpec.describe`
  (class name or string).
- `leafScopeName` = `methodName + firstArg` from the leaf scope's call node
  (same as current `nameExtractor`).
- For body chunks of intermediate scopes: `User.context 'when admin'` (the
  intermediate scope name).
- Collisions within one file are unlikely; `relativePath` disambiguates across
  files.

**Fallback for top-level `shared_examples` / `shared_context`:** When there is
no wrapping `describe` (e.g., `shared_examples 'authenticable' do ... end` at
file root), use the shared_examples name as TopLevelDescribe:
`authenticable.it 'validates token'`.

**`RSpec.describe` AST handling:** `RSpec.describe` parses as a `call` node with
receiver `RSpec`. The `nameExtractor` in `config.ts` already handles this — it
extracts the method name (`describe`) from the identifier child. For the
TopLevelDescribe part, the scope chunker extracts the first argument of the call
node regardless of receiver presence.

### Architecture: New Hook File

**New file:**
`src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`

Responsibilities:

- Build scope tree from AST (identify leaf vs intermediate scopes)
- Collect setup lines per scope level
- Produce leaf chunks with parent setup injection
- Produce body chunks for intermediate scopes with own `it` blocks
- Handle oversized leaf splitting by maxChunkSize
- Assign `chunkType: "test"` / `"test_setup"`
- Build 2-level symbolId

**Hook chain update** (`hooks/ruby/index.ts`):

```typescript
export const rubyHooks: ChunkingHook[] = [
  rspecFilterHook, // filterNode: accepts RSpec DSL calls
  rubyCommentCaptureHook, // populates excludedRows
  rspecScopeChunkerHook, // NEW: scope-centric chunking for spec files
  rubyBodyChunkingHook, // body grouping for non-spec Ruby files
];
```

### Integration with TreeSitterChunker

**Problem:** The current `processChildren()` recurses per-level, creating a
fresh `HookContext` at each nesting depth. The scope chunker needs visibility
into the full scope tree for parent setup injection — it cannot work within
per-level recursion.

**Solution:** Two changes to `HookContext` and one to `BodyChunkResult`:

1. **`HookContext.skipChildren?: boolean`** — When set to `true` by the scope
   chunker, `processChildren()` skips emitting leaf child chunks for this
   container. All chunks are produced by the hook via `bodyChunks`.

2. **`BodyChunkResult.chunkType?: string`** — Optional field allowing hooks to
   specify the chunkType for each body chunk. When present, the chunker uses it
   instead of hardcoded `"block"`. When absent, falls back to `"block"`.

3. **`BodyChunkResult.symbolId?: string`** — Optional field for hook-provided
   symbolId. When present, the chunker uses it instead of `buildSymbolId()`.

**Control flow for RSpec files:**

```
TreeSitterChunker.chunk()
  → findChunkableNodes() → finds top-level describe (via rspec-filter)
  → shouldExtractChildren = true (alwaysExtractChildren)
  → findChildChunkableNodes() → finds nested describe/context/it
  → createHookContext() + run hook chain
    → rspecScopeChunkerHook.process(ctx):
        1. Detects isRspecFile → takes over
        2. Walks ctx.containerNode subtree (full AST, not just validChildren)
        3. Builds scope tree, identifies leaves vs intermediates
        4. Collects setup at each level, propagates to children
        5. Produces all chunks into ctx.bodyChunks with chunkType/symbolId
        6. Sets ctx.skipChildren = true
    → rubyBodyChunkingHook.process(ctx):
        Checks ctx.bodyChunks.length > 0 → skips (already handled)
  → processChildren():
      Checks ctx.skipChildren === true → skips child emission
  → emits ctx.bodyChunks (with hook-provided chunkType/symbolId)
```

This avoids per-level recursion for RSpec files. The scope chunker does its own
full-depth traversal in a single `process()` call. `processChildren` and
`rubyBodyChunkingHook` both skip via guards.

**Guard mechanism:** `rubyBodyChunkingHook` checks `ctx.bodyChunks.length > 0`
(not `isRspecFile()`), avoiding duplicated detection logic. If the scope chunker
produced chunks, the body chunker has nothing to do.

**Hook ordering is load-bearing:** `rspecScopeChunkerHook` MUST run before
`rubyBodyChunkingHook`. The guard in `rubyBodyChunkingHook`
(`ctx.bodyChunks.length > 0`) depends on the scope chunker having already
populated bodyChunks.

**Body chunk metadata:** Chunks produced by the scope chunker must set:

- `name` — leaf scope label (e.g., `"context 'with expired token'"`)
- `parentName` — TopLevelDescribe (e.g., `"User"`)
- `chunkType` — `"test"` or `"test_setup"`
- `symbolId` — 2-level format (e.g., `"User.context 'with expired token'"`)

**Existing files modified:**

- `hooks/ruby/index.ts` — add new hook to chain
- `hooks/types.ts` — add `skipChildren` to `HookContext`, add `chunkType` and
  `symbolId` to `BodyChunkResult`
- `class-body-chunker.ts` — remove `extractRspecBodyChunk` (dead code) and its
  `isRspecFile` import, add guard in `rubyBodyChunkingHook.process()` to skip if
  bodyChunks already set, add `"let!"` to `DECLARATION_KEYWORDS`
- `src/core/types.ts` — extend inline `chunkType` union with
  `| "test" | "test_setup"` (note: this is an inline union at line 205, not a
  named type alias)
- `tree-sitter.ts`:
  - `processChildren()` — check `ctx.skipChildren` and skip child emission
  - Body chunk emission (TWO sites: top-level at ~line 224 and nested at
    ~line 544) — use `result.chunkType` when present, fallback `"block"`; use
    `result.symbolId` when present
  - `getChunkType()` return type — extend union for type consistency (function
    is not called for RSpec chunks since hook provides chunkType directly)

**No changes to:**

- `rspec-filter.ts` — continues to filter AST nodes as before
- `comment-capture.ts` — continues to populate excludedRows
- `config.ts` — `chunkableTypes`, `childChunkTypes` unchanged

### Shoulda One-Liners

`rspecFilterHook.filterNode()` rejects shoulda one-liners
(`it { is_expected.to ... }`) from being chunkable nodes. However, these ARE
valid test assertions and must appear in leaf scope chunks.

The scope chunker walks the full AST subtree — it sees ALL lines within the
scope, not just `validChildren` filtered by hooks. Shoulda one-liners are
included as regular content lines in the leaf scope chunk. The filter hook only
affects what `findChunkableNodes`/`findChildChunkableNodes` return — it does not
affect the scope chunker's own AST traversal.

## Edge Cases

### Setup-only scopes (no `it` blocks)

A `context` with only `let`/`before` and no `it` blocks is technically a leaf
scope by the formal definition (no nested containers). Produce a `"test_setup"`
chunk, not `"test"` — since there are no tests, only setup.

### Deep nesting (5+ levels) with setup at every level

Injected parent setup can accumulate to 50+ lines for deeply nested specs. No
artificial limit on injection depth — the full setup chain is needed for
semantic completeness. If the resulting chunk exceeds `maxChunkSize`, the
oversized split mechanism handles it (setup goes into every sub-chunk).

### Empty `describe`/`context` blocks

Blocks with no content (only `do...end`) produce no chunks. Minimum content
threshold (50 characters) filters these out.

### `mergeSmallChunks` interaction

`mergeSmallChunks()` only merges chunks with `chunkType: "block"` or
`"interface"`. The new `"test"` and `"test_setup"` types are NOT in
`MERGEABLE_TYPES` — no erroneous merging will occur.

## Performance

No additional AST parsing. `TreeSitterChunker.chunk()` parses the file once
(`langConfig.parser.parse(code)` at line 152). The scope chunker receives
`ctx.containerNode` — an existing AST node from the same tree — and traverses
its children recursively. No second `parse()` call.

**Comparison with current approach:**

| Aspect              | Current (per-level recursion)                          | Scope chunker                                   |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| AST parsing         | 1 time                                                 | 1 time (same tree)                              |
| AST traversal       | N levels × (findChildChunkableNodes + processChildren) | 1 findChunkableNodes + 1 full traversal in hook |
| Hook chain calls    | Once per recursion level                               | Once on root container                          |
| HookContext objects | One per level                                          | One total                                       |

For deeply nested RSpec files (5+ levels), the scope chunker is **faster** than
the current approach — single pass instead of repeated findChildChunkableNodes +
createHookContext + processChildren at each depth.

## What This Solves

| Problem                          | Before                          | After                                  |
| -------------------------------- | ------------------------------- | -------------------------------------- |
| Mega-chunks 3000+ lines          | All body in one chunk           | Leaf scopes ~20-80 lines               |
| Micro-chunks 1-2 lines           | Individual it/context as chunks | Scope includes setup+it, min ~10 lines |
| Lost setup context               | let/before in body, it separate | Parent setup injected into leaf chunk  |
| symbolId overflow (300+ chars)   | Full nesting path               | 2-level: `User.context 'when admin'`   |
| Duplicate it names               | Same name, different parent     | it not chunked separately              |
| chunkType "block" for everything | No filtering possible           | `"test"` / `"test_setup"`              |
