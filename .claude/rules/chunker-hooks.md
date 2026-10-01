---
paths:
  - "src/core/domains/language/*/chunking/**/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/hooks/**/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/tree-sitter.ts"
  - "src/core/domains/ingest/pipeline/chunker/config.ts"
---

# Chunker Hook Chain (MANDATORY)

Applies to every `ChunkingHook` a language contributes from
`src/core/domains/language/<lang>/chunking/` — the array its `chunking/index.ts`
exports (e.g. `rubyHooks`), which the `LanguageDefinition` passes on as
`hooks:`. The `ChunkingHook` type itself lives in `contracts/types/chunker.ts`;
`chunker/hooks/types.ts` is a re-export kept for legacy import sites, not a
place to add hooks.

## Claim invariant (orchestrator-enforced)

Hook chain stops moment any hook populates `ctx.bodyChunks`. Orchestrator in
`src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` short-circuits loop:

```ts
for (const hook of langConfig.hooks ?? []) {
  if (ctx.bodyChunks.length > 0) break;
  hook.process(ctx);
}
```

Implication for hook authors:

- **Writing `ctx.bodyChunks` claims the container.** Subsequent hooks NOT run on
  this `ctx`. Set chunks once, expect no post-passes on same container.
- **Per-hook guards unnecessary.** Don't write
  `if (ctx.bodyChunks.length > 0) return;` inside `process` — orchestrator
  already handled it.
- **Set `ctx.skipChildren = true` whenever you claim**, so child emission also
  suppressed for container.

## Hook ordering (MANDATORY)

Order in `language/<lang>/chunking/index.ts` positional — orchestrator runs
hooks in registration order, stops at first writer. Keep canonical ordering per
language:

1. **Filter hooks** — `filterNode` only, no `process` work. Narrow candidate
   node set globally added to `chunkableTypes`.
2. **Comment / metadata hooks** — populate `excludedRows`, `methodPrefixes`,
   etc. for downstream readers. Must NOT write `bodyChunks` (would short-circuit
   chain prematurely).
3. **Specialised scope / DSL chunkers** — claim semantic containers
   (`describe`/`context`/`suite` for tests, RSpec blocks for Ruby). Write
   `ctx.bodyChunks` AND set `ctx.skipChildren = true`.
4. **Generic body chunker (last)** — class/function body extraction for any
   container specialised chunkers didn't claim. Runs only when no prior hook
   wrote `bodyChunks`.

Reordering breaks invariant. Don't reorder without revising this rule.

## Container remainder (engine-owned, bd tea-rags-mcp-deoki)

After the children are emitted, the engine emits ONE remainder chunk per
container for the container's own rows no child, no captured comment
(`excludedRows`) and no body chunk carries — under the container's own symbolId,
`lineRanges` for the non-contiguous rows, `#partN` when oversized. It stays out
when a hook wrote `ctx.bodyChunks` (that hook owns the container's rows) or set
`ctx.skipChildren` (a claim owns the whole container). So a hook never needs to
re-emit a type-level chunk just to keep the container's rows searchable; to
relabel it, a metadata hook sets `ctx.containerChunkType`.

Rows a comment hook puts in `excludedRows` for child `ci` (with `methodPrefixes`
/ `methodStartLines`) are PROMISED to that child: the engine carries them on
every emission path — the leaf chunk's prefix, the head of an oversized child's
`#part1`, a recursed child's remainder (bd tea-rags-mcp-u7tjf / 6wy02). Only
exclude rows you set a prefix for.

## Module remainder (engine-owned)

The file-level counterpart: after the top-level chunks are emitted, the engine
emits ONE remainder for the top-level statements none of whose rows any chunk
carries (`TreeSitterChunker#withModuleRemainder` — same planner, same 50-char
floor, `lineRanges`, `#partN`). Imports never join it: grammar import node types
and `export … from` / bare `export { … }` lists are recognized by the engine; a
language whose import is an ordinary call (Ruby `require`) declares
`LanguageChunkerHooks.isModuleImport`. A remainder that is exactly one named
declaration takes its name as symbolId. A hook never re-emits top-level code to
keep it searchable.

## Container header: once per chunk, on every member part

A chunk names its container exactly ONCE (bd tea-rags-mcp-4i6ab). A body chunk
whose first row already IS the container's header row (a class-body hook writes
it verbatim, `export class X extends Y {` / `class Foo < Bar`) gets only the
enclosing hierarchy from the engine, not the engine's `class X extends Y {` on
top; a body chunk that does not start with it gets the header prefixed. The
remainder carries its header row as its own row when that row is among its rows,
and as a prefix only when a child covers it. The hook budget
(`bodyChunkPrefixLength`) reserves the full prefix either way.

Every `#partN` of a split MEMBER opens with the container hierarchy prefix,
exactly like the unsplit member chunk (bd tea-rags-mcp-jgb5a). A part's layout,
top to bottom:

1. hierarchy prefix — the enclosing containers' headers;
2. leading comment — `#part1` only (the u7tjf rule above), in the same part as
   the signature whenever both fit; a comment too large for that spreads over
   the first parts, each comment-only one opened by the signature rows, so no
   part is a bare doc block (bd tea-rags-mcp-ic5mv);
3. the splitter's signature/context prefix — every part after the first;
4. the part's own rows — the only rows `startLine..endLine` covers.

The hierarchy prefix is taken out of every part's budget, so each part stays ≤
`maxChunkSize`. A member that fits the budget alone but not under its prefix and
leading comment takes the same split path instead of being line-cut by the
`enforceMaxChunkSize` post-pass. Top-level split symbols carry no hierarchy
prefix. Several chunks sharing one symbolId (class-body groups, accessor pairs)
is by design — never uniquify them.

Every OTHER `#partN` tail names its container too (bd tea-rags-mcp-j4jrn):

- A hook sizes its body chunks with `bodyChunkContentBudget(ctx.config)`, not
  `maxChunkSize` — the reservation already counts a header row the hook writes
  itself, so a group fits whole instead of being line-cut.
- A container remainder's windows after the one holding the header row open with
  the hierarchy prefix plus the container header.
- A hook body chunk that still overflows (a setup-only test chunk, a row wider
  than the budget) is cut by the `enforceMaxChunkSize` post-pass with its
  transient `contextPrefix` (hierarchy + header rows) repeated on every part. A
  body chunk that declares a `partHeader` (a test example's call row) gets that
  row repeated after the prefix on every `#part2+` too (bd tea-rags-mcp-l24yk);
  it is text only, so line ranges stay the part's own rows.
- The header is the row the container's `name` starts on, not its first row — a
  leading attribute / decorator / annotation row (`@NSApplicationMain`) is never
  the header.

## What NOT to put in the chain

- Hooks reading `ctx.bodyChunks` after another hook wrote them (post-processing,
  chunk enrichment). Orchestrator stops chain, so these never run. If you need
  that, propose extending contract (e.g. separate post-claim pass) before adding
  hook.

## Reference implementations

- TypeScript chain: `src/core/domains/language/typescript/chunking/index.ts`
- Ruby chain: `src/core/domains/language/ruby/chunking/index.ts`
- Orchestrator short-circuit:
  `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
  (`chunkWithChildExtraction` + `processChildren`)
- Coverage:
  `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
  asserts invariant end-to-end via `chunkType === "test"` on a real describe
  block.
