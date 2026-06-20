# Hierarchy Graph as Codegraph Symbols Substrate — Design

- **Date:** 2026-06-15
- **Beads epic:** `tea-rags-mcp-f10y` (P0: bidirectional class hierarchy
  structure)
- **Parent program:** `tea-rags-mcp-cai0` (Ruby resolver precision) — note this
  design deliberately exceeds the cai0 (Ruby-only) boundary by building a
  language-agnostic substrate that also serves `tea-rags-mcp-ba9u` (TS resolver
  precision) and its child `tea-rags-mcp-ezli` (TS interface→impl fan-out).
- **Downstream consumers (separate beads):** `tea-rags-mcp-2jet` (CHA
  devirtualization), `ezli` (TS interface→impl), super-precision, STI fan-out,
  inheritance blast-radius.

## Problem

The codegraph captures class inheritance (`classAncestors`,
`classPrependedAncestors`, `classExtends`) only as **forward-only, in-memory,
run-scoped Records** on `CallContext`. The provider aggregates them run-global
(`runAncestors` / `runExtends` / `runPrependedAncestors`) and feeds them to the
synchronous resolver for the duration of one indexing run. Three gaps:

1. **No reverse index.** Given an interface or base class, there is no way to
   enumerate its implementers / subclasses. CHA devirtualization
   (`embeddings.checkHealth()` where `embeddings: EmbeddingProvider` has 6
   implementers) and STI fan-out are impossible — `globalShortName` drops when
   `N > 1` implementers.
2. **Not persisted / queryable.** The hierarchy evaporates at run end. No MCP
   tool, rerank signal, or blast-radius query can read it.
3. **TS `implements` not captured at all.** `classExtends` deliberately excludes
   `implements` ("type-only, no runtime dispatch") — correct for the call graph,
   but `implements` IS a hierarchy edge.

## Goal

Persist class hierarchy as a first-class, **bidirectional, queryable**
structure: a `cg_symbols_inheritance` edge table plus a reverse index, exposed
to the synchronous resolver via a sync `HierarchyView` snapshot and to
query-time consumers (MCP tools, rerank, blast-radius) via the async
`GraphDbClient`. This is the substrate for CHA, super precision, STI, and
blast-radius.

## Decisions (settled during brainstorm)

| #   | Decision               | Choice                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Language scope         | **Full now** — language-agnostic schema + TS walker gains `implements` / interface-extends capture in this epic.                                                                                                                                                                                                                                                 |
| 2   | Edge identity          | **Resolve-at-write, store both** — resolve ancestor name → `symbol_id` once at the barrier; store both `ancestor_symbol_id` (NULL for external) and raw `ancestor_fq_name`. Reverse index on both. Rationale: performant + scalable (resolution amortized at index, indexed reverse lookup at query); keeps the external-ancestor signal (`ActiveRecord::Base`). |
| 3   | Resolver relationship  | **Two projections, split by layer.** Async `HierarchyGraph` (behind `GraphDbClient`, adapters) for persistence + query. Sync `HierarchyView` (contracts/, leaf-safe) for the resolver, backed by an in-memory snapshot the provider loads. Resolver stays sync and never touches the DB — respects `domains/language` leaf-boundary.                             |
| 4   | Record cleanup phasing | **Phased.** `HierarchyView` ships with BOTH directions; CHA/ezli consume `getDescendants`. The legacy 3 forward Records keep working; migrating resolver forward-reads onto `getAncestors` is a separate follow-up bead.                                                                                                                                         |
| 5   | Capture output shape   | **Unified `FileExtraction.inheritanceEdges`.** New capture (incl. TS `implements`) emits one kind-tagged edge list. The normalizer reads `inheritanceEdges` AND the legacy 3 Records (until walkers migrate emission). Single source of truth for new capture.                                                                                                   |

## Architecture

### Two projections of one hierarchy

```
walker extractions ──► provider (trajectory/, may import adapters)
                          1. resolve ancestor names → symbol_id
                          2. WRITE cg_symbols_inheritance (async, GraphDbClient)
                          3. LOAD bidirectional snapshot (one batch read)
                          4. build sync HierarchyView → CallContext.hierarchy
                          ▼
                       resolver (domains/language, leaf, SYNC) ──► reads ctx.hierarchy
```

| Component                                 | Layer          | Sync? | Consumers                         | Purpose                                    |
| ----------------------------------------- | -------------- | ----- | --------------------------------- | ------------------------------------------ |
| `HierarchyGraph` (behind `GraphDbClient`) | adapters       | async | provider, MCP tools, blast-radius | persistent bidirectional store + query API |
| `HierarchyView` (snapshot)                | **contracts/** | sync  | resolver strategies               | resolve-time read, no DB, leaf-safe        |

The provider is the only seam that bridges the async store and the sync view.

### `HierarchyView` interface (contracts/types/codegraph.ts)

```ts
type InheritanceKind =
  | "super"
  | "include"
  | "extend"
  | "prepend"
  | "implements";

interface InheritanceEdge {
  sourceFqName: string;
  ancestorFqName: string;
  ancestorSymbolId: string | null; // null = external / unresolved (e.g. ActiveRecord::Base)
  kind: InheritanceKind;
  depth: number; // 1 = direct; > 1 only when transitive requested
}

interface HierarchyQuery {
  kinds?: readonly InheritanceKind[]; // filter by edge kind; default = all
  transitive?: boolean; // default false (direct only)
  ordered?: boolean; // getAncestors only: MRO order (prepend↓ ▸ self ▸ include ▸ super)
}

interface HierarchyView {
  getAncestors(
    fqName: string,
    opts?: HierarchyQuery,
  ): readonly InheritanceEdge[]; // upward
  getDescendants(
    fqName: string,
    opts?: HierarchyQuery,
  ): readonly InheritanceEdge[]; // downward (reverse / CHA)
}
```

`CallContext` gains one field: `hierarchy?: HierarchyView`. The legacy
`classAncestors` / `classExtends` / `classPrependedAncestors` remain (phased). A
`hasAncestor` convenience is deferred (YAGNI; classification consumer is
follow-up).

### Storage — `cg_symbols_inheritance`

Hierarchy is a relation over **type names** (fq_name), not over definition sites
(Ruby reopened classes / TS declaration merging = one logical type, multiple
`symbol_id`). Key by fq_name; `symbol_id` is the resolved pointer.

```sql
-- migration: 005-cg-symbols-inheritance.ts (next sequential number)
CREATE TABLE IF NOT EXISTS cg_symbols_inheritance (
  source_fq_name     VARCHAR NOT NULL,   -- subclass / implementer type
  source_rel_path    VARCHAR NOT NULL,   -- per-file lifecycle + reopened class across files
  source_symbol_id   VARCHAR,            -- class def-site symbol (navigation)
  ancestor_fq_name   VARCHAR NOT NULL,   -- always present (raw / resolved)
  ancestor_symbol_id VARCHAR,            -- NULL for external / unresolved
  kind               VARCHAR NOT NULL,   -- super | include | extend | prepend | implements
  ordinal            INTEGER NOT NULL,   -- declaration order → MRO reconstruction
  PRIMARY KEY (source_fq_name, source_rel_path, ancestor_fq_name, kind)
);
CREATE INDEX idx_cg_inh_source       ON cg_symbols_inheritance (source_fq_name);     -- forward: getAncestors
CREATE INDEX idx_cg_inh_ancestor_sym ON cg_symbols_inheritance (ancestor_symbol_id); -- reverse robust: CHA
CREATE INDEX idx_cg_inh_ancestor_fq  ON cg_symbols_inheritance (ancestor_fq_name);   -- reverse external
CREATE INDEX idx_cg_inh_source_path  ON cg_symbols_inheritance (source_rel_path);    -- per-file delete
```

`ordinal` is mandatory: SQL rows lose array order, but MRO (prepend reverse,
include order) depends on it. Transitive closure is computed **on demand via
DuckDB `WITH RECURSIVE`** over the indexed columns — **no materialized closure
table** (write-amplification kills incremental reindex).

### `GraphDbClient` extension (adapters, async)

```ts
getSupertypes(fqName: string): Promise<InheritanceEdge[]>;                 // direct ancestors
getSubtypes(fqName: string): Promise<InheritanceEdge[]>;                   // direct descendants (reverse)
getTransitiveSubtypes(fqName: string, opts?): Promise<InheritanceEdge[]>;  // recursive CTE
loadHierarchySnapshot(): Promise<HierarchySnapshot>;                       // bulk → resolver view
```

Writes ride the existing `upsertFile` (`GraphEdges` gains an `inheritance`
field); `removeFile` additionally deletes inheritance rows by `source_rel_path`
— the same per-file lifecycle as `cg_symbols_edges_*`.

## Pipeline integration

Codegraph enrichment is a two-pass streaming pipeline in the provider. Hierarchy
integrates at three touchpoints plus one barrier.

```
PASS-1  (sink.write, per file, streaming)
  walker → FileExtraction (NOW emits inheritanceEdges, incl. TS implements)
  symbolTable.upsertFile + graphDb.upsertSymbols
  merge run-global: runAncestors / runExtends / runPrepended / + runInheritance (NEW)   ← touchpoint 2
  spill FileExtraction → NDJSON

──── BARRIER: pass-1 done → symbolTable COMPLETE, run-global COMPLETE ────
  HIERARCHY FINALIZE (NEW):                                                              ← touchpoint 3
    resolve ancestor names → ancestor_symbol_id  (fq_name lookup + source file import-map)
    write cg_symbols_inheritance                 (bulk; per-source-file delete lifecycle)
    build HierarchyView snapshot (bidirectional)

PASS-2  (finish / finalize, reads NDJSON back)
  resolveExtraction(extraction, symbolTable) with ctx.hierarchy = view  → GraphEdges
  graphDb.upsertFile(node, edges)
    └─ CHA strategies call ctx.hierarchy.getDescendants(...)

POST-FINALIZE chunk pass (unchanged)
```

**Touchpoint 1 — capture (pass-1, walker).** `FileExtraction.inheritanceEdges`
emitted where `classAncestors` is emitted today. New: TS `collectImplements` +
interface-extends. No extra walk pass.

**Touchpoint 2 — accumulate (pass-1, `sink.write`).** `runInheritance` merged
run-global alongside the existing `runAncestors` merge, same batch lifecycle
(accumulate across batches, reset at finalize).

**Touchpoint 3 — hierarchy finalize (barrier).** A standalone step between
symbol collection and call resolution. **Why a barrier, not inline in pass-2:**
CHA needs the COMPLETE reverse index at the moment it resolves a call; resolving
inheritance file-by-file inside the pass-2 loop would leave the reverse index
partial. The hierarchy is fully derivable from pass-1 state (`runInheritance` +
complete symbol table), so it resolves in one cheap bulk pass (inheritance edges
are O(classes) ≪ call graph) before pass-2 begins.

### Capture layers

```
LAYER 1 — syntactic capture (per-language, leaf)
  domains/language/<lang>/walker/  — language-specific collectors (tree-sitter)
    Ruby: existing super/include/extend/prepend
    TS:   NEW collectImplements + interface-extends
  emit → FileExtraction.inheritanceEdges (contracts/)

LAYER 2 — normalize + resolve + persist (language-neutral, trajectory)
  domains/trajectory/codegraph/symbols/inheritance-edges.ts (NEW)
    reads FileExtraction.inheritanceEdges + legacy 3 Records
    resolves ancestor names → symbol_id
    → GraphEdges.inheritance → upsertFile
    → builds HierarchyView snapshot
```

The walker (leaf, sync) owns syntax → `FileExtraction`. The provider
(trajectory, may touch adapters) owns `FileExtraction` → resolved edges → DB +
view. The resolver never participates in capture — it only consumes
`ctx.hierarchy`.

## Use cases

**In scope for f10y (substrate + cheap consumers):**

1. **CHA devirtualization (2jet)** — `getDescendants` cone, reverse fan-out.
2. **TS interface→impl (ezli)** — `getDescendants({ kinds: ["implements"] })`.
3. **STI fan-out** — `getDescendants` from STI base.
4. **super precision** — `getAncestors({ ordered: true })` (resolver migration
   onto the view is the phased follow-up).

**Follow-up consumers (separate beads; substrate readies them):**

5. **Inheritance blast-radius** — transitive `getDescendants`: "change this base
   / interface → N concrete subtypes affected." New `inheritanceImpact` derived
   signal (analog of `transitiveImpact` over imports) + filter.
6. **MCP `get_subtypes` / `get_supertypes`** — analog of `get_callers` /
   `get_callees`; the agent asks "who implements `EmbeddingProvider`" directly.
7. **Type-level architectural hub signal** — high `subtypeCount` = key interface
   / abstraction (analog of `isHub` over fanIn); feeds onboarding /
   architecturalHub presets.
8. **Sibling discovery** — types with a common ancestor (`getAncestors` →
   `getDescendants`).

**Out of scope (YAGNI):** inheritance cycle detection (inheritance does not
cycle; diamonds handled by MRO ordering); materialized closure table.

## Testing

- **Migration** — table + 4 indexes created.
- **`GraphDbClient` inheritance CRUD** — upsert / `removeFile` cascade /
  `getSupertypes` / `getSubtypes` / `getTransitiveSubtypes` (recursive CTE),
  DuckDB integration.
- **`HierarchyView` snapshot** — bidirectional map + `ordered` MRO order.
- **CHA strategy per language** — consumes `getDescendants`, **preserving
  existing examples** (`domains-language.md`: `it` / `describe` count ≥ base).
- **E2E fixture** — interface + N implementers ⇒ reverse index returns all N
  (the "EmbeddingProvider → 6 implementers" case from ezli).

## Known constraints

- **Cross-file resolution staleness** under incremental single-file reindex: the
  same eventual-consistency as method edges — resolve what is available;
  `force-reindex` restores the full picture. Documented, not blocked.
- **Phased dual surface:** until the forward-read migration follow-up lands, the
  resolver reads the legacy 3 Records for forward queries and `HierarchyView`
  for reverse (CHA). The normalizer is the single seam that unifies both into
  persisted edges.

## File touchpoints

| Area                                                                | Change                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/types/codegraph.ts`                                      | `InheritanceKind`, `InheritanceEdge`, `HierarchyQuery`, `HierarchyView`, `HierarchySnapshot`; `FileExtraction.inheritanceEdges`; `CallContext.hierarchy`; `GraphEdges.inheritance`; `GraphDbClient` inheritance methods |
| `infra/migration/database/migrations/005-cg-symbols-inheritance.ts` | new table + indexes                                                                                                                                                                                                     |
| `adapters/duckdb/client.ts`                                         | inheritance upsert / delete / read queries + recursive CTE                                                                                                                                                              |
| `domains/language/typescript/walker/`                               | `collectImplements` + interface-extends → `inheritanceEdges`                                                                                                                                                            |
| `domains/language/<lang>/walker/`                                   | emit existing capture into `inheritanceEdges` (incremental)                                                                                                                                                             |
| `domains/trajectory/codegraph/symbols/inheritance-edges.ts`         | NEW normalizer: resolve + build snapshot                                                                                                                                                                                |
| `domains/trajectory/codegraph/symbols/provider.ts`                  | run-global `runInheritance` merge; hierarchy-finalize barrier; inject `ctx.hierarchy`                                                                                                                                   |
| `domains/language/<lang>/resolver/strategies/`                      | CHA strategy consuming `getDescendants` (2jet)                                                                                                                                                                          |
