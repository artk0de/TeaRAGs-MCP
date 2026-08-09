/**
 * Codegraph contracts — language-agnostic types shared between the
 * chunker (which emits extractions), the codegraph trajectory (which
 * resolves them and writes to the graph DB), and the graph DB adapter
 * (DuckDB for slice 1, PostgreSQL planned for slice 4).
 *
 * Lives in `contracts/` per `.claude/rules/domain-boundaries.md`:
 * foundation layer, no runtime beyond a handful of pure helpers, no Zod.
 *
 * This file is a BARREL. The declarations moved into siblings cut along the
 * pipeline they describe; every name this file exported before the split is
 * still exported from here, so no importer changes:
 *
 *   - `codegraph-symbols.ts`       identity aliases, `SymbolDefinition`,
 *                                  `GlobalSymbolTable`, `NamedSymbol`
 *   - `codegraph-hierarchy.ts`     inheritance edges + `HierarchyView`
 *   - `codegraph-graph.ts`         persisted nodes / edges / cycles / run stats
 *   - `codegraph-dispatch.ts`      lookup-table dispatch, capture to fan-out
 *   - `codegraph-local-binding.ts` flow-sensitive local receiver typing
 *   - `codegraph-extraction.ts`    what a walker emits per file (pass 1)
 *   - `codegraph-resolution.ts`    `CallContext` / `CallResolver` (pass 2)
 *   - `codegraph-storage.ts`       `GraphDbClient` and its call shapes
 *
 * Dependencies run strictly one way, symbols → storage, with no cycles; import
 * a sibling directly when you want the narrow surface, or this barrel when you
 * want the set. `export *` rather than an enumerated list on purpose: a new
 * export in any sibling reaches consumers without an edit here, which is what
 * keeps the barrel exhaustive by construction. The `type` qualifier below marks
 * the siblings that are pure types today — `consistent-type-exports` flips a
 * line the moment its sibling gains or loses a runtime export, so the
 * distinction stays accurate without anyone maintaining it.
 *
 * Spec: `docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md`
 */

export * from "./codegraph-dispatch.js";
export type * from "./codegraph-extraction.js";
export type * from "./codegraph-graph.js";
export type * from "./codegraph-hierarchy.js";
export * from "./codegraph-local-binding.js";
export * from "./codegraph-resolution.js";
export type * from "./codegraph-storage.js";
export type * from "./codegraph-symbols.js";
