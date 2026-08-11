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
