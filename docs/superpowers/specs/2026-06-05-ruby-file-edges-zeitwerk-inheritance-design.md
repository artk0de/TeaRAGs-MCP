# Ruby file-level codegraph edges — Zeitwerk constants + inheritance

**Date:** 2026-06-05 **Status:** Design approved, pending implementation plan
**Scope:** Ruby only. TypeScript/Python/Go/Java/Rust/JS file graphs are
unaffected.

## Problem

On a fresh index of a large Rails monolith (taxdome, tea-rags 1.28.0,
2026-06-04), `codegraph.file.fanOut` for Ruby is effectively empty: `count = 92`
files with any fan-out (`max = 2`) out of ~24 590 indexed files. The 92 are
exactly the files carrying explicit `require` / `require_relative` (lib/,
scripts, non-Rails). The Ruby **method-call graph** (chunk-level) is fully
populated in the same index (`codegraph.chunk.fanIn` up to 1465), so symbol
resolution works — only the **file graph** is empty.

Two independent gaps cause this:

### Gap 1 — Zeitwerk constant refs never become file edges

The Ruby walker emits two import channels into `FileExtraction.imports[]`
(`src/core/domains/language/ruby/walker/walker.ts:88`):

```ts
const imports: ImportRef[] = [...explicitImports, ...constantRefs];
```

`constantRefs` are Zeitwerk constant uses prefixed with `ZEITWERK_PREFIX`
(`"zeitwerk:"`), e.g. `zeitwerk:User`.

File edges are built ONLY from `imports[]`, in
`CodegraphEnrichmentProvider#resolveExtraction`
(`src/core/domains/trajectory/codegraph/symbols/provider.ts:1531-1549`) by
synthesising a "call-shaped" lookup:

```ts
for (const imp of extraction.imports) {
  const last = lastSegment(imp.importText);
  const target = resolver.resolve(
    { callText: imp.importText, receiver: last, member: last, startLine: imp.startLine },
    { callerFile: extraction.relPath, callerScope: extraction.fileScope, imports, symbolTable, ... },
  );
  if (target) fileEdges.push({ targetRelPath: target.targetRelPath, importText: imp.importText });
}
```

For `imp.importText = "zeitwerk:User"`:

- `lastSegment("zeitwerk:User")` returns `"zeitwerk:User"` — `lastSegment`
  splits on `/`, `#`, `.`, but NOT `:`, so the prefix is never stripped.
- `RubyConstantSymbolResolutionStrategy.attempt`
  (`resolvers/ruby/strategies/ruby-constant.ts:29`) gates on
  `looksLikeConstant(call.receiver)` → regex `/^[A-Z].../`. `"zeitwerk:User"`
  starts lowercase → returns `CONTINUE`. No strategy resolves the prefixed
  string → `target = null` → no file edge.
- `collectKnownPaths` (`resolvers/ruby/strategies/shared.ts:61`) **deliberately
  excludes** `zeitwerk:`-prefixed entries from the require-path set, confirming
  the channel separation: Zeitwerk entries are meant to be resolved as constants
  (bare name), never as file paths.

The method-call path works because the walker emits the **bare** receiver
(`User`) on each `CallRef`; the `zeitwerk:User` entry in `imports[]` is only a
membership hint. The file-edge synthesis feeds the **prefixed** string as the
receiver, which the resolver contract rejects.

Root cause: the provider's import→file-edge synthesis is not Zeitwerk-aware, and
it should not be — `zeitwerk:` is the walker↔resolver contract
(`.claude/rules/codegraph-walkers.md`), the provider must not know it.

### Gap 2 — Inheritance / mixin edges are never file edges

The walker also emits `FileExtraction.classAncestors` (superclass + `include` +
`extend`) and `FileExtraction.classPrependedAncestors` (`prepend`) as
`Record<fqClassName, constName[]>` (`walker.ts:118-130`). These are consumed
ONLY by the chunk/method resolver for inheritance-aware method lookup
(`ruby-super.ts`, `ruby-local-type.ts`,
`ruby-constant.ts:walkAncestorsForConstantCall`). No file-edge builder reads
them. So "class A in file X inherits/mixes module M defined in file Y" never
produces the file edge X → Y.

## Approved decision

Inheritance/mixin file edges **fold into the same
`codegraph.file.fanOut`/`fanIn`** — NOT a separate signal or edge type.
Rationale:

- Inheritance is the same efferent coupling ("file X depends on file Y") that
  `file.fanOut` already means per `.claude/rules/imports-field-semantics.md`.
- Minimal new surface — no new payload descriptor, stats accumulator, MCP
  filter, or preset. This matters: the target method `resolveExtraction` is the
  single hottest method in `provider.ts` (commitCount 29, intense changeDensity)
  and the file is concentrated-ownership (Arthur Korochansky 88%). Narrow edits
  only.
- YAGNI: an `edgeKind` discriminator or `inheritanceFanOut` signal is a future
  enhancement, added only if a use-case needs to distinguish "uses" from
  "inherits".

## Architecture

Introduce an optional per-file method on the `CallResolver` contract:

```ts
// contracts/types/codegraph.ts (or language.ts — wherever CallResolver lives)
resolveFileEdges?(extraction: FileExtraction, ctx: FileEdgeContext): FileEdge[];
```

`FileEdgeContext` carries what the Ruby resolver needs: `symbolTable`, the
caller file/scope, `imports`, and the ancestor maps (`classAncestors`,
`classPrependedAncestors`) — the same inputs already threaded into the
call-resolution `ctx`.

In `resolveExtraction`, the file-edge loop (1531-1549) becomes:

```ts
const fileEdges = resolver.resolveFileEdges
  ? resolver.resolveFileEdges(extraction, fileEdgeCtx)
  : defaultImportFileEdges(extraction, resolver, symbolTable); // current synthesised-call loop, extracted verbatim
```

- `defaultImportFileEdges` is the **current** loop, moved into a named helper
  with NO behaviour change. TS/Python/Go/Java/Rust/JS keep using it — zero risk
  to those languages.
- Only Ruby implements `resolveFileEdges`. The provider no longer synthesises a
  fake call for Ruby and never sees the `zeitwerk:` prefix — the abstraction
  leak is removed.

### Ruby `resolveFileEdges` — three channels, all → `fileEdges`

Every channel resolves a **name → declaring file** via the existing
`resolveConstant(name, ctx)` (which already does direct symbol-table lookup →
`Module.nesting` walk → Zeitwerk convention) or the require-path logic. All
produced edges go into the same `FileEdge[]`, hence the same fan-out/fan-in.

1. **Explicit `require` / `require_relative`** — unchanged logic: basename /
   relative-path resolution over `collectKnownPaths`.
2. **Zeitwerk constant refs** — for each `imports[]` entry starting with
   `ZEITWERK_PREFIX`, strip the prefix and `resolveConstant(bareConst, ctx)` →
   target file. (Fixes Gap 1; the resolver owns its own prefix.)
3. **Inheritance / mixins** — for each class declared in `extraction.fileScope`,
   read `classAncestors[fqClass]` and `classPrependedAncestors[fqClass]`; for
   each ancestor constant name, `resolveConstant(ancestorConst, ctx)` → target
   file. (Fixes Gap 2.)

### Correctness

- **Self-loop skip.** Drop any edge where
  `targetRelPath === extraction.relPath`. Zeitwerk/ancestor resolution can
  resolve a constant declared in the same file (a class inheriting a sibling
  defined alongside it); a file coupling to itself is spurious. The
  explicit-import path never self-resolved, so this guard is new and lives in
  the Ruby `resolveFileEdges`.
- **Cross-channel dedup is free.** `cg_symbols_edges_file` uses
  `INSERT OR IGNORE` keyed on `(source_rel_path, target_rel_path)`
  (`adapters/duckdb/client.ts:289-298`; `import_text` is a payload column, not
  part of the dedup key — **verify the PK does not include `import_text` during
  implementation**). `getFanOut = COUNT(*) WHERE source_rel_path = ?`, so
  `fanOut` counts **distinct target files**. A file that both uses constant
  `Foo` and inherits from `Foo` (same target) collapses to ONE edge; inheritance
  only increments `fanOut` for **new** target files. No double-counting.

### Layering / rules compliance

- `.claude/rules/imports-field-semantics.md` — `file.fanOut` stays sourced from
  the codegraph edge table, never from `imports[]` directly. Downstream derived
  signals (`fanOut`, `instability`, `isHub`, `transitiveImpact`) inherit the new
  coverage automatically.
- `.claude/rules/codegraph-walkers.md` — the walker stays pure; it already emits
  `constantRefs` and `classAncestors`. ALL new resolution lives in the resolver.
  The walker is not modified.
- `.claude/rules/domain-boundaries.md` — `resolveFileEdges` is part of the
  `CallResolver` contract in `contracts/`; the Ruby implementation lives in
  `domains/language/ruby/resolver/`; the provider in `domains/trajectory/`
  consumes the contract. No new cross-domain edge.

## Components changed

| Component                         | Change                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `contracts` (`CallResolver` type) | Add optional `resolveFileEdges?` + `FileEdgeContext` type                                                              |
| `provider.ts:resolveExtraction`   | Branch on `resolver.resolveFileEdges`; extract current loop into `defaultImportFileEdges` helper (no behaviour change) |
| `domains/language/ruby/resolver/` | Implement `resolveFileEdges`: 3 channels + self-loop skip, reusing `resolveConstant` / `collectKnownPaths`             |
| walker                            | **Unchanged** — data already emitted                                                                                   |
| Other language resolvers          | **Unchanged** — fall through to `defaultImportFileEdges`                                                               |

## Testing

Per `.claude/rules/test-patterns.md` and `domains-language.md` (preserve
examples; do not rewrite passing business-logic tests):

- **Existing** walker tests and call-resolver tests: untouched (their business
  logic is unchanged).
- **New** Ruby resolver tests for `resolveFileEdges`:
  1. Zeitwerk constant ref (`User.find`, file declares `User`) → file edge
     source → `app/models/user.rb`.
  2. Explicit `require_relative` → file edge (parity with old path).
  3. `class A < B` (superclass in another file) → file edge A.file → B.file.
  4. `include Mod` / `prepend Mod` / `extend Mod` (module in another file) →
     file edge.
  5. Self-loop: constant/ancestor declared in the same file → NO edge.
  6. Cross-channel dedup: same target via constant use AND inheritance → ONE
     edge (assert fan-out counts the target once).
- **Provider test**: `resolveExtraction` routes Ruby through `resolveFileEdges`
  and non-Ruby through `defaultImportFileEdges` (both produce edges).
- **Live verification**: force-reindex a real Ruby/Rails project (huginn, or
  taxdome) on the new build; assert `get_index_metrics` shows
  `codegraph.file.fanOut` for Ruby rising from ~0 (count 92) into the thousands,
  comparable in shape to the TypeScript file graph.

## Out of scope

- Distinguishing "uses" vs "inherits" edges (no `edgeKind` column / no separate
  signal) — deferred until a use-case needs it.
- File-level graph for other dynamically-loaded languages — Ruby only.
- Method-call (chunk) graph — already correct, untouched.
