---
paths:
  - "src/core/domains/ingest/pipeline/chunker/hooks/**/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/tree-sitter.ts"
  - "src/core/domains/ingest/pipeline/chunker/config.ts"
---

# Chunker Hook Chain (MANDATORY)

Applies to every `ChunkingHook` registered under
`src/core/domains/ingest/pipeline/chunker/hooks/<language>/`.

## Claim invariant (orchestrator-enforced)

The hook chain stops the moment any hook populates `ctx.bodyChunks`. The
orchestrator in `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
short-circuits the loop:

```ts
for (const hook of langConfig.hooks ?? []) {
  if (ctx.bodyChunks.length > 0) break;
  hook.process(ctx);
}
```

Implication for hook authors:

- **Writing `ctx.bodyChunks` claims the container.** Subsequent hooks will NOT
  run on this `ctx`. Set the chunks once and don't expect post-passes on the
  same container.
- **Per-hook guards are unnecessary.** Don't write
  `if (ctx.bodyChunks.length > 0) return;` inside `process` — the orchestrator
  already handled it.
- **Set `ctx.skipChildren = true` whenever you claim**, so child emission is
  also suppressed for the container.

## Hook ordering (MANDATORY)

Order in `<language>/index.ts` is positional — the orchestrator runs hooks in
registration order and stops at the first writer. Keep this canonical ordering
for every language:

1. **Filter hooks** — `filterNode` only, no `process` work. Narrow the candidate
   node set globally added to `chunkableTypes`.
2. **Comment / metadata hooks** — populate `excludedRows`, `methodPrefixes`,
   etc. for downstream readers. Must NOT write `bodyChunks` (would short-circuit
   the chain prematurely).
3. **Specialised scope / DSL chunkers** — claim semantic containers
   (`describe`/`context`/`suite` for tests, RSpec blocks for Ruby). Write
   `ctx.bodyChunks` AND set `ctx.skipChildren = true`.
4. **Generic body chunker (last)** — class/function body extraction for any
   container the specialised chunkers didn't claim. Runs only when no prior hook
   wrote `bodyChunks`.

Reordering breaks the invariant. Don't reorder without revising this rule.

## What NOT to put in the chain

- Hooks that read `ctx.bodyChunks` after another hook wrote them
  (post-processing, enrichment of chunks). The orchestrator stops the chain, so
  these would never run. If you need that, propose extending the contract (e.g.
  a separate post-claim pass) before adding the hook.

## Reference implementations

- TypeScript chain:
  `src/core/domains/ingest/pipeline/chunker/hooks/typescript/index.ts`
- Ruby chain: `src/core/domains/ingest/pipeline/chunker/hooks/ruby/index.ts`
- Orchestrator short-circuit:
  `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
  (`chunkWithChildExtraction` + `processChildren`)
- Coverage:
  `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
  asserts the invariant end-to-end via `chunkType === "test"` on a real describe
  block.
