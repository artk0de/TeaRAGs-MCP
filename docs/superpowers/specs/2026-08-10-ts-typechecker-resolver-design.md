# TS typeChecker fallback resolver — design

Epic: `tea-rags-mcp-nl93h`. Coverage taxonomy this design closes gaps against:
`docs/superpowers/specs/2026-08-10-ts-codegraph-node-edge-coverage.md`.

## Problem

Ruby's codegraph resolver (`src/core/domains/language/ruby/resolver/`) is
statistically complete: ~30 `SymbolResolutionStrategy` classes, a
`walker/type-sources/` layer, a DSL/framework grammar layer, and a forensics
harness. TS's resolver (`src/core/domains/language/typescript/resolver/`) has
10 strategy classes under `TSCallResolver`, pure tree-sitter heuristics —
`ts.createProgram`/`typeChecker` are used nowhere. Per the coverage doc, ~10 of
~35 taxonomy cases (generics, overloads, union narrowing, structural typing,
interface merging, cross-call return-type inference) are structurally
unsolvable by AST pattern-matching and need real type information.

TS does not need Ruby's DSL/framework grammar layer — TS has no implicit
macro-DSL convention (`has_many`, `validates`); decorators are explicit typed
constructs the type checker already understands.

## Architecture

`TSTypeCheckerFallbackStrategy` — a new `SymbolResolutionStrategy` — registers
**last** in the existing `TSCallResolver` chain
(`src/core/domains/language/typescript/resolver/ts-resolver.ts`). It fires
only when all 10 tree-sitter strategies return unresolved AND the call site's
`ReceiverKind`/syntax shape matches a 🔶 row in the coverage doc. No changes to
the 10 existing strategies, to `CallEdgeResolutionRunner`
(`src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts` —
shared, language-agnostic, also carries Ruby's path today), or to
`CodegraphRunState`.

**Program lifecycle — `TSProgramCache`.** LRU, scoped to a single indexing
run, lives alongside (not inside) `CodegraphRunState` so it doesn't grow the
already highest-churn/highest-fanOut file in the domain
(`provider.ts`, commitCount 79, fanOut 10). Keyed by `relPath`; on miss, builds
`ts.Program` from `rootFiles: [target file + transitive import closure,
capped]`. Bounded by entry count, not by time. Discarded at the end of the
run — no persistence across incremental reindexes (upstream `.d.ts` /
dependency state may have changed, so a stale cache is worse than a cold one).

**Oracle harness.** `scripts/ts-codegraph-typechecker-oracle.ts`, pattern-
matched on `taxdome-codegraph-recall-forensics.ts` but a different mechanism:
for each call site matching a taxonomy row, compute BOTH the tree-sitter
chain's answer and the typeChecker's answer (`getResolvedSignature` /
`getTypeAtLocation`), diff. A mismatch is either a new corner case (heuristic
wrong where it shouldn't be) or an expected gap (🔶 row correctly deferred to
the fallback). Output: per-category diff-rate table, feeds back into the
coverage doc.

**Corpus selection.** Two stages, don't collapse them:

1. **Base/dev corpus — tea-rags-mcp itself** (`tea-rags-worktree` project
   alias, same pattern as the `test-self-reindex` skill). Zero corpus-sourcing
   risk, already self-indexed, type-rich enough for generics/overloads/union
   narrowing/interface merging/cross-call inference (Reranker's generic
   `DerivedSignalDescriptor`, Zod schemas, the `SymbolResolutionStrategy`
   hierarchy itself). Gap: no JSX/React — this corpus can't exercise B5
   (JSX component resolution) at all; that sub-case needs its own fixture
   corpus regardless of what validates the rest.
2. **Final live validation — taxdome's React/TS codebase**, at the very end
   only, after the strategies are unit-tested against the dev corpus. Real
   production scale, so it's the `epic-completion-gate.md` live-validation
   step (user-gated: reindex + `resolveSuccessRate` re-measurement), not a
   development-time corpus. Also the first point B5 gets exercised against
   real JSX at scale. Don't point the oracle harness at it early — it's the
   acceptance check, not the design loop.

**Testing.** Fixture-per-🔶-row unit tests on `TSTypeCheckerFallbackStrategy`,
same `describe "... (bd XXXX)"` convention as
`tests/core/domains/language/typescript/walker/typescript-walker.test.ts`.
Live validation per `.claude/rules/epic-completion-gate.md`: re-measure
`resolveSuccessRate` by `receiverKind` via `DEBUG=1 tea-rags prime` before/
after — user-gated, not a blocker for landing the code.

## Execution order

One blocking foundation piece, then independent parallel tracks. Tracks don't
share mutable state — each subagent works in worktree isolation, merged back
after.

### Foundation (blocking, sequential — must land before Wave 2)

`TSProgramCache` + `TSTypeCheckerFallbackStrategy` (registered + routing
classification for which call sites reach it) + the FIRST 🔶 case implemented
end-to-end as the proof the plumbing works: **generics/overload resolution**
via `getResolvedSignature` (highest-value, best-defined 🔶 case — doubles as
Track B1, not a bare stub). Estimated sub-epic, 5–10 commits.

### Wave 1 — parallel, starts immediately, zero dependency on Foundation

- **Track A** — the 10 ⬜ coverage-doc gaps solvable without typeChecker:
  `require()` interop, `export * from`/re-export, `import * as` namespace
  member access, `arr[i].foo()` / `obj['foo']()` computed access, `.call`/
  `.apply`/`.bind` dynamic dispatch, method-as-value. Pure tree-sitter walker
  work — touches `src/core/domains/language/typescript/walker/`, never
  `resolver/`. No shared files with Foundation.

### Wave 2 — parallel, starts once Foundation's real interface exists

- **Track B (remaining sub-cases)** — B2 union narrowing, B3 structural
  typing / interface merging, B4 cross-call return-type inference, B5 JSX
  component resolution. Each is an independent read-only query against
  `TSProgramCache`; sub-cases don't see each other.
- **Track C** — oracle harness. Needs `TSProgramCache`'s real Program-
  construction interface to avoid a throwaway duplicate. Ideally leads Wave 2
  — its diff-rate on a real corpus should reprioritize which of B2–B5 lands
  first, rather than guessing from the taxonomy table alone.

## Open follow-ups

- Verify `typescript` is a runtime `dependencies` entry, not only
  `devDependencies` — the compiler API now runs in production code, not just
  at build time.
- Live `resolveSuccessRate` re-measurement is user-gated per
  `epic-completion-gate.md` — file as its own bead once code lands, don't fold
  into an implementation bead's closing reason.
