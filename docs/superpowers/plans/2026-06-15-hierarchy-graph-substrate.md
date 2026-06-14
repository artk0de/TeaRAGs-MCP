# Hierarchy Graph Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist class hierarchy as a bidirectional, queryable
`cg_symbols_inheritance` structure with a sync `HierarchyView` for the resolver
and an async query API on `GraphDbClient`.

**Architecture:** Two projections of one hierarchy. The async `GraphDbClient`
(adapters) owns the persisted `cg_symbols_inheritance` table + reverse index +
recursive-CTE transitive queries. The provider (trajectory) resolves ancestor
names → symbol_id at a barrier between pass-1 (symbol collection) and pass-2
(call resolution), persists the edges, and builds a sync in-memory
`HierarchyView` snapshot injected into `CallContext.hierarchy`. The resolver
(domains/language, leaf) stays synchronous and never touches the DB.

**Tech Stack:** TypeScript, DuckDB (`@duckdb/node-api` via `DuckDbGraphClient`),
tree-sitter walkers, vitest.

**Spec:**
`docs/superpowers/specs/2026-06-15-hierarchy-graph-codegraph-design.md` **Beads
epic:** `tea-rags-mcp-f10y`

**Scope boundary:** This plan ships the SUBSTRATE only — schema, capture (incl.
TS `implements`), normalizer, persistence, `HierarchyView`, and the async query
API, proven end-to-end via `getSubtypes` / `getDescendants`. **Consuming the
view inside resolver strategies (CHA devirtualization) is epic
`tea-rags-mcp-2jet`, the next plan — NOT a task here.** The phased migration of
the legacy 3 forward Records onto `getAncestors` is a separate follow-up bead.

---

## File Structure

| File                                                                         | Responsibility                                                                                                                                                                                                                                           | New/Modify |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `src/core/contracts/types/codegraph.ts`                                      | `InheritanceKind`, `InheritanceEdge`, `HierarchyQuery`, `HierarchyView`, `HierarchySnapshot`, `InheritanceEdgeDecl`, `InheritanceEdgeRow`; `FileExtraction.inheritanceEdges`; `CallContext.hierarchy`; `GraphEdges.inheritance`; `GraphDbClient` methods | Modify     |
| `src/core/infra/migration/database/migrations/005-cg-symbols-inheritance.ts` | SQL for the table + 4 indexes                                                                                                                                                                                                                            | Create     |
| `src/core/infra/migration/database/migrations/index.ts`                      | register 005 in `DATABASE_MIGRATIONS`                                                                                                                                                                                                                    | Modify     |
| `src/core/infra/graph/hierarchy-view.ts`                                     | `MapHierarchyView` — sync impl over `HierarchySnapshot`                                                                                                                                                                                                  | Create     |
| `src/core/adapters/duckdb/client.ts`                                         | inheritance upsert (in `upsertFile`), `removeFile` cascade, `getSupertypes`/`getSubtypes`/`getTransitiveSubtypes`, `loadHierarchySnapshot`                                                                                                               | Modify     |
| `src/core/domains/language/typescript/walker/walker.ts`                      | `collectImplements` + `collectInterfaceExtends` → emit `inheritanceEdges`                                                                                                                                                                                | Modify     |
| `src/core/domains/trajectory/codegraph/symbols/inheritance-edges.ts`         | normalizer: `FileExtraction` (inheritanceEdges + legacy Records) → resolved `InheritanceEdgeRow[]`                                                                                                                                                       | Create     |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`                  | `runInheritance` accumulate (pass-1); hierarchy-finalize barrier; inject `ctx.hierarchy` (pass-2)                                                                                                                                                        | Modify     |

Tests mirror source under `tests/core/...`.

---

## Task 1: Contract types

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts`
- Test: `tests/core/contracts/types/hierarchy-types.test.ts`

- [ ] **Step 1: Write the failing test** (type-level + shape compile check)

```ts
// tests/core/contracts/types/hierarchy-types.test.ts
import { describe, expect, it } from "vitest";

import type {
  HierarchyQuery,
  HierarchySnapshot,
  HierarchyView,
  InheritanceEdge,
  InheritanceEdgeDecl,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("hierarchy contract types", () => {
  it("InheritanceEdge carries fq names, nullable symbol id, kind, depth", () => {
    const edge: InheritanceEdge = {
      sourceFqName: "Foo",
      ancestorFqName: "Bar",
      ancestorSymbolId: null,
      kind: "implements",
      depth: 1,
    };
    expect(edge.ancestorSymbolId).toBeNull();
  });

  it("HierarchyView exposes getAncestors + getDescendants", () => {
    const view: HierarchyView = {
      getAncestors: () => [],
      getDescendants: () => [],
    };
    expect(view.getAncestors("X")).toEqual([]);
  });

  it("InheritanceEdgeDecl is the walker emission shape (no resolved symbol id)", () => {
    const decl: InheritanceEdgeDecl = {
      source: "Foo",
      ancestor: "Bar",
      kind: "super",
      ordinal: 0,
    };
    expect(decl.kind).toBe("super");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/types/hierarchy-types.test.ts`
Expected: FAIL — types not exported.

- [ ] **Step 3: Add types to `codegraph.ts`**

Add near the existing `CallContext` / `GraphEdges` definitions:

```ts
export type InheritanceKind =
  | "super"
  | "include"
  | "extend"
  | "prepend"
  | "implements";

/** Walker emission shape — one row per declared inheritance relation, BEFORE
 *  name resolution. `source` / `ancestor` are raw fq/short names as written. */
export interface InheritanceEdgeDecl {
  source: string;
  ancestor: string;
  kind: InheritanceKind;
  ordinal: number;
}

/** Persisted / resolved shape — what the normalizer produces and the DB stores
 *  (minus source_rel_path, which the upsert supplies from GraphFileNode). */
export interface InheritanceEdgeRow {
  sourceFqName: string;
  sourceSymbolId: string | null;
  ancestorFqName: string;
  ancestorSymbolId: string | null;
  kind: InheritanceKind;
  ordinal: number;
}

/** Query result — a persisted edge plus traversal depth. */
export interface InheritanceEdge {
  sourceFqName: string;
  ancestorFqName: string;
  ancestorSymbolId: string | null;
  kind: InheritanceKind;
  depth: number;
}

export interface HierarchyQuery {
  kinds?: readonly InheritanceKind[];
  transitive?: boolean;
  ordered?: boolean;
}

/** Sync, leaf-safe read surface the resolver consumes via CallContext. */
export interface HierarchyView {
  getAncestors(
    fqName: string,
    opts?: HierarchyQuery,
  ): readonly InheritanceEdge[];
  getDescendants(
    fqName: string,
    opts?: HierarchyQuery,
  ): readonly InheritanceEdge[];
}

/** Plain-data snapshot the provider loads once at the barrier; MapHierarchyView
 *  wraps it. Keyed by fqName in both directions. */
export interface HierarchySnapshot {
  ancestorsBySource: Record<string, InheritanceEdgeRow[]>;
  descendantsByAncestor: Record<string, InheritanceEdgeRow[]>;
}
```

In `FileExtraction` (after `callbackParams`):

```ts
  /**
   * Optional unified inheritance edge list (bd tea-rags-mcp-f10y). New capture
   * surface superseding the per-kind classAncestors/classExtends/
   * classPrependedAncestors Records (which stay for the phased resolver-forward
   * path). TS walkers emit `implements` / interface-extends here — those have no
   * legacy Record. The normalizer reads BOTH this field and the legacy Records.
   * Plain array for NDJSON-spill round-trip.
   */
  inheritanceEdges?: InheritanceEdgeDecl[];
```

In `CallContext` (after `classPrependedAncestors`):

```ts
  /**
   * Optional bidirectional hierarchy snapshot (bd tea-rags-mcp-f10y). Built by
   * the provider at the pass-1→pass-2 barrier and injected for pass-2. CHA /
   * STI fan-out reads `getDescendants`; phased follow-up migrates the forward
   * Records onto `getAncestors`. Sync — no DB access on the resolve path.
   */
  hierarchy?: HierarchyView;
```

In `GraphEdges` (after `methodEdges`):

```ts
  /** Resolved inheritance edges for this file's source classes
   *  (bd tea-rags-mcp-f10y). Persisted to cg_symbols_inheritance via upsertFile;
   *  source_rel_path is taken from the accompanying GraphFileNode. */
  inheritance?: InheritanceEdgeRow[];
```

In `GraphDbClient` (after `getCalleeEdges` block):

```ts
/** Direct ancestors of a type (forward). */
getSupertypes: (fqName: string) => Promise<InheritanceEdge[]>;
/** Direct subtypes / implementers of a type (reverse index). */
getSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
/** Transitive subtypes via recursive CTE; `depth` reflects traversal level. */
getTransitiveSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
/** Bulk load both directions for the resolver snapshot. */
loadHierarchySnapshot: () => Promise<HierarchySnapshot>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/types/hierarchy-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/codegraph.ts tests/core/contracts/types/hierarchy-types.test.ts
git commit -m "feat(contracts): hierarchy graph types — HierarchyView, InheritanceEdge, snapshot (f10y)"
```

---

## Task 2: Migration 005 — `cg_symbols_inheritance`

**Files:**

- Create:
  `src/core/infra/migration/database/migrations/005-cg-symbols-inheritance.ts`
- Modify: `src/core/infra/migration/database/migrations/index.ts`
- Test: `tests/core/infra/migration/database/cg-inheritance-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/infra/migration/database/cg-inheritance-migration.test.ts
import { describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";

describe("005 cg_symbols_inheritance migration", () => {
  it("creates the table and is idempotent", async () => {
    const db = new DuckDbGraphClient(":memory:");
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS); // re-run
    expect(second.applied).not.toContain("005-cg-symbols-inheritance.sql");

    const cols = await db.queryAll<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cg_symbols_inheritance'",
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(
      [
        "ancestor_fq_name",
        "ancestor_symbol_id",
        "kind",
        "ordinal",
        "source_fq_name",
        "source_rel_path",
        "source_symbol_id",
      ].sort(),
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/infra/migration/database/cg-inheritance-migration.test.ts`
Expected: FAIL — table absent (migration not registered).

- [ ] **Step 3: Create the migration module**

```ts
// src/core/infra/migration/database/migrations/005-cg-symbols-inheritance.ts
/**
 * Codegraph schema — `cg_symbols_inheritance` (bd tea-rags-mcp-f10y).
 *
 * Bidirectional class-hierarchy edge table. Keyed by TYPE NAME (fq_name) not
 * def-site, so reopened classes / declaration merging coexist as multiple rows.
 * `ancestor_symbol_id` is NULL for external / unresolved ancestors (kept by
 * `ancestor_fq_name`). `ordinal` preserves declaration order for MRO. Reverse
 * indexes on the ancestor columns are the bidirectional payoff (CHA / STI).
 */
export const SQL_005_CG_SYMBOLS_INHERITANCE = `
CREATE TABLE IF NOT EXISTS cg_symbols_inheritance (
  source_fq_name     VARCHAR NOT NULL,
  source_rel_path    VARCHAR NOT NULL,
  source_symbol_id   VARCHAR,
  ancestor_fq_name   VARCHAR NOT NULL,
  ancestor_symbol_id VARCHAR,
  kind               VARCHAR NOT NULL,
  ordinal            INTEGER NOT NULL,
  PRIMARY KEY (source_fq_name, source_rel_path, ancestor_fq_name, kind)
);

CREATE INDEX IF NOT EXISTS idx_cg_inh_source       ON cg_symbols_inheritance (source_fq_name);
CREATE INDEX IF NOT EXISTS idx_cg_inh_ancestor_sym ON cg_symbols_inheritance (ancestor_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cg_inh_ancestor_fq  ON cg_symbols_inheritance (ancestor_fq_name);
CREATE INDEX IF NOT EXISTS idx_cg_inh_source_path  ON cg_symbols_inheritance (source_rel_path);
`;
```

- [ ] **Step 4: Register in `index.ts`**

Add import + array entry (after the 004 line):

```ts
import { SQL_005_CG_SYMBOLS_INHERITANCE } from "./005-cg-symbols-inheritance.js";
// ...
  { filename: "005-cg-symbols-inheritance.sql", sql: SQL_005_CG_SYMBOLS_INHERITANCE },
```

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/infra/migration/database/cg-inheritance-migration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/migration/database/migrations/005-cg-symbols-inheritance.ts src/core/infra/migration/database/migrations/index.ts tests/core/infra/migration/database/cg-inheritance-migration.test.ts
git commit -m "feat(migration): add cg_symbols_inheritance table + reverse indexes (f10y)"
```

---

## Task 3: DuckDB client — inheritance upsert + cascade delete

**Files:**

- Modify: `src/core/adapters/duckdb/client.ts` (`upsertFile`, `removeFile`)
- Test: `tests/core/adapters/duckdb/inheritance-crud.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/adapters/duckdb/inheritance-crud.test.ts
import { describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

async function freshDb() {
  const db = new DuckDbGraphClient(":memory:");
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  return db;
}

describe("inheritance upsert + delete", () => {
  it("upsertFile persists inheritance rows; removeFile clears them", async () => {
    const db = await freshDb();
    await db.upsertFile(
      { relPath: "a.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [],
        inheritance: [
          {
            sourceFqName: "Dog",
            sourceSymbolId: "Dog",
            ancestorFqName: "Animal",
            ancestorSymbolId: "Animal",
            kind: "super",
            ordinal: 0,
          },
        ],
      },
    );
    const rows = await db.queryAll<{ source_fq_name: string }>(
      "SELECT source_fq_name FROM cg_symbols_inheritance",
    );
    expect(rows).toHaveLength(1);

    await db.removeFile("a.ts");
    const after = await db.queryAll("SELECT * FROM cg_symbols_inheritance");
    expect(after).toHaveLength(0);
    await db.close();
  });

  it("re-upsert of the same file replaces its inheritance rows (idempotent)", async () => {
    const db = await freshDb();
    const node = { relPath: "a.ts", language: "typescript" };
    const edges = (kind: "super" | "implements") => ({
      fileEdges: [],
      methodEdges: [],
      inheritance: [
        {
          sourceFqName: "Dog",
          sourceSymbolId: "Dog",
          ancestorFqName: "Animal",
          ancestorSymbolId: "Animal",
          kind,
          ordinal: 0,
        },
      ],
    });
    await db.upsertFile(node, edges("super"));
    await db.upsertFile(node, edges("super"));
    const rows = await db.queryAll("SELECT * FROM cg_symbols_inheritance");
    expect(rows).toHaveLength(1);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/inheritance-crud.test.ts`
Expected: FAIL — `upsertFile` ignores `edges.inheritance`.

- [ ] **Step 3: Extend `upsertFile`**

In `upsertFile`, mirror the existing `cg_symbols_edges_file` delete+insert
pattern (client.ts ~290). Add a per-source-file delete + insert for inheritance:

```ts
// inside upsertFile's serialized transaction, after the existing edge writes:
await this.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [
  node.relPath,
]);
for (const e of edges.inheritance ?? []) {
  await this.run(
    `INSERT OR IGNORE INTO cg_symbols_inheritance
       (source_fq_name, source_rel_path, source_symbol_id, ancestor_fq_name, ancestor_symbol_id, kind, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      e.sourceFqName,
      node.relPath,
      e.sourceSymbolId,
      e.ancestorFqName,
      e.ancestorSymbolId,
      e.kind,
      e.ordinal,
    ],
  );
}
```

In `removeFile`, add (next to the existing edge deletes ~340-348):

```ts
await this.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [
  relPath,
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/inheritance-crud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/client.ts tests/core/adapters/duckdb/inheritance-crud.test.ts
git commit -m "feat(adapters): persist inheritance edges via upsertFile + removeFile cascade (f10y)"
```

---

## Task 4: DuckDB client — hierarchy read queries

**Files:**

- Modify: `src/core/adapters/duckdb/client.ts` (`getSupertypes`, `getSubtypes`,
  `getTransitiveSubtypes`, `loadHierarchySnapshot`)
- Test: `tests/core/adapters/duckdb/inheritance-reads.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/adapters/duckdb/inheritance-reads.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

// Hierarchy: Animal <- Dog <- Puppy ; EmbeddingProvider implemented by Onnx, Remote
let db: DuckDbGraphClient;
beforeEach(async () => {
  db = new DuckDbGraphClient(":memory:");
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  const row = (
    s: string,
    a: string,
    kind: string,
    asym: string | null = a,
  ) => ({
    sourceFqName: s,
    sourceSymbolId: s,
    ancestorFqName: a,
    ancestorSymbolId: asym,
    kind: kind as any,
    ordinal: 0,
  });
  await db.upsertFile(
    { relPath: "dog.ts", language: "typescript" },
    {
      fileEdges: [],
      methodEdges: [],
      inheritance: [row("Dog", "Animal", "super")],
    },
  );
  await db.upsertFile(
    { relPath: "puppy.ts", language: "typescript" },
    {
      fileEdges: [],
      methodEdges: [],
      inheritance: [row("Puppy", "Dog", "super")],
    },
  );
  await db.upsertFile(
    { relPath: "onnx.ts", language: "typescript" },
    {
      fileEdges: [],
      methodEdges: [],
      inheritance: [row("Onnx", "EmbeddingProvider", "implements")],
    },
  );
  await db.upsertFile(
    { relPath: "remote.ts", language: "typescript" },
    {
      fileEdges: [],
      methodEdges: [],
      inheritance: [row("Remote", "EmbeddingProvider", "implements")],
    },
  );
});

describe("hierarchy reads", () => {
  it("getSubtypes returns direct implementers (reverse index)", async () => {
    const subs = await db.getSubtypes("EmbeddingProvider");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Onnx", "Remote"]);
    await db.close();
  });

  it("getSupertypes returns direct ancestors", async () => {
    const sup = await db.getSupertypes("Puppy");
    expect(sup.map((e) => e.ancestorFqName)).toEqual(["Dog"]);
    await db.close();
  });

  it("getTransitiveSubtypes walks the chain Animal -> Dog -> Puppy", async () => {
    const subs = await db.getTransitiveSubtypes("Animal");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Dog", "Puppy"]);
    await db.close();
  });

  it("loadHierarchySnapshot indexes both directions", async () => {
    const snap = await db.loadHierarchySnapshot();
    expect(
      snap.descendantsByAncestor["EmbeddingProvider"]
        .map((e) => e.sourceFqName)
        .sort(),
    ).toEqual(["Onnx", "Remote"]);
    expect(
      snap.ancestorsBySource["Puppy"].map((e) => e.ancestorFqName),
    ).toEqual(["Dog"]);
    await db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/inheritance-reads.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the read methods**

Add to `DuckDbGraphClient` (model on the existing `getCallers`/`getCallees`
query style ~717-735):

```ts
async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
  const rows = await this.queryAll<{ ancestorFqName: string; ancestorSymbolId: string | null; kind: InheritanceKind }>(
    `SELECT ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind
       FROM cg_symbols_inheritance WHERE source_fq_name = ? ORDER BY ordinal`,
    [fqName],
  );
  return rows.map((r) => ({ sourceFqName: fqName, ancestorFqName: r.ancestorFqName, ancestorSymbolId: r.ancestorSymbolId, kind: r.kind, depth: 1 }));
}

async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
  const rows = await this.queryAll<{ sourceFqName: string; kind: InheritanceKind }>(
    `SELECT source_fq_name AS "sourceFqName", kind
       FROM cg_symbols_inheritance WHERE ancestor_fq_name = ? ORDER BY source_fq_name`,
    [fqName],
  );
  return rows.map((r) => ({ sourceFqName: r.sourceFqName, ancestorFqName: fqName, ancestorSymbolId: null, kind: r.kind, depth: 1 }));
}

async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
  const rows = await this.queryAll<{ sourceFqName: string; ancestorFqName: string; kind: InheritanceKind; depth: number }>(
    `WITH RECURSIVE sub(source_fq_name, ancestor_fq_name, kind, depth) AS (
       SELECT source_fq_name, ancestor_fq_name, kind, 1
         FROM cg_symbols_inheritance WHERE ancestor_fq_name = ?
       UNION ALL
       SELECT c.source_fq_name, c.ancestor_fq_name, c.kind, sub.depth + 1
         FROM cg_symbols_inheritance c JOIN sub ON c.ancestor_fq_name = sub.source_fq_name
     )
     SELECT source_fq_name AS "sourceFqName", ancestor_fq_name AS "ancestorFqName", kind, depth FROM sub`,
    [fqName],
  );
  return rows.map((r) => ({ sourceFqName: r.sourceFqName, ancestorFqName: r.ancestorFqName, ancestorSymbolId: null, kind: r.kind, depth: r.depth }));
}

async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
  const rows = await this.queryAll<{
    sourceFqName: string; sourceSymbolId: string | null; ancestorFqName: string; ancestorSymbolId: string | null; kind: InheritanceKind; ordinal: number;
  }>(
    `SELECT source_fq_name AS "sourceFqName", source_symbol_id AS "sourceSymbolId",
            ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind, ordinal
       FROM cg_symbols_inheritance ORDER BY source_fq_name, ordinal`,
  );
  const ancestorsBySource: Record<string, InheritanceEdgeRow[]> = {};
  const descendantsByAncestor: Record<string, InheritanceEdgeRow[]> = {};
  for (const r of rows) {
    (ancestorsBySource[r.sourceFqName] ??= []).push(r);
    (descendantsByAncestor[r.ancestorFqName] ??= []).push(r);
  }
  return { ancestorsBySource, descendantsByAncestor };
}
```

Add the type imports at the top of `client.ts`:

```ts
import type {
  HierarchySnapshot,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../contracts/types/codegraph.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/inheritance-reads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/client.ts tests/core/adapters/duckdb/inheritance-reads.test.ts
git commit -m "feat(adapters): hierarchy read queries — getSubtypes/getSupertypes/transitive CTE/snapshot (f10y)"
```

---

## Task 5: `MapHierarchyView` — sync view over the snapshot

**Files:**

- Create: `src/core/infra/graph/hierarchy-view.ts`
- Test: `tests/core/infra/graph/hierarchy-view.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/infra/graph/hierarchy-view.test.ts
import { describe, expect, it } from "vitest";

import type { HierarchySnapshot } from "../../../../src/core/contracts/types/codegraph.js";
import { MapHierarchyView } from "../../../../src/core/infra/graph/hierarchy-view.js";

const snap: HierarchySnapshot = {
  ancestorsBySource: {
    Service: [
      {
        sourceFqName: "Service",
        sourceSymbolId: "Service",
        ancestorFqName: "Logging",
        ancestorSymbolId: "Logging",
        kind: "prepend",
        ordinal: 0,
      },
      {
        sourceFqName: "Service",
        sourceSymbolId: "Service",
        ancestorFqName: "Base",
        ancestorSymbolId: "Base",
        kind: "super",
        ordinal: 0,
      },
      {
        sourceFqName: "Service",
        sourceSymbolId: "Service",
        ancestorFqName: "Comparable",
        ancestorSymbolId: "Comparable",
        kind: "include",
        ordinal: 0,
      },
    ],
    Base: [
      {
        sourceFqName: "Base",
        sourceSymbolId: "Base",
        ancestorFqName: "Object",
        ancestorSymbolId: null,
        kind: "super",
        ordinal: 0,
      },
    ],
  },
  descendantsByAncestor: {
    Base: [
      {
        sourceFqName: "Service",
        sourceSymbolId: "Service",
        ancestorFqName: "Base",
        ancestorSymbolId: "Base",
        kind: "super",
        ordinal: 0,
      },
    ],
    Object: [
      {
        sourceFqName: "Base",
        sourceSymbolId: "Base",
        ancestorFqName: "Object",
        ancestorSymbolId: null,
        kind: "super",
        ordinal: 0,
      },
    ],
  },
};

describe("MapHierarchyView", () => {
  it("getAncestors returns direct ancestors", () => {
    const view = new MapHierarchyView(snap);
    expect(
      view
        .getAncestors("Service")
        .map((e) => e.ancestorFqName)
        .sort(),
    ).toEqual(["Base", "Comparable", "Logging"]);
  });

  it("ordered=true yields MRO: prepend, then self-ancestors include, then super", () => {
    const view = new MapHierarchyView(snap);
    const ordered = view
      .getAncestors("Service", { ordered: true })
      .map((e) => e.kind);
    expect(ordered).toEqual(["prepend", "include", "super"]);
  });

  it("transitive getAncestors walks Service -> Base -> Object", () => {
    const view = new MapHierarchyView(snap);
    const names = view
      .getAncestors("Service", { transitive: true })
      .map((e) => e.ancestorFqName);
    expect(names).toContain("Object");
  });

  it("getDescendants reads the reverse index; kinds filter applies", () => {
    const view = new MapHierarchyView(snap);
    expect(view.getDescendants("Base").map((e) => e.sourceFqName)).toEqual([
      "Service",
    ]);
    expect(view.getDescendants("Base", { kinds: ["implements"] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/graph/hierarchy-view.test.ts` Expected:
FAIL — module missing.

- [ ] **Step 3: Implement `MapHierarchyView`**

```ts
// src/core/infra/graph/hierarchy-view.ts
/**
 * Sync, in-memory HierarchyView over a HierarchySnapshot (bd tea-rags-mcp-f10y).
 * Lives in infra/ so both the provider (trajectory) and any leaf consumer can
 * import it. No DB access — all reads hit the pre-loaded snapshot maps.
 */
import type {
  HierarchyQuery,
  HierarchySnapshot,
  HierarchyView,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../contracts/types/codegraph.js";

// MRO precedence: prepend (highest) -> include/extend -> super (lowest).
const MRO_RANK: Record<InheritanceKind, number> = {
  prepend: 0,
  include: 1,
  extend: 1,
  implements: 2,
  super: 3,
};

export class MapHierarchyView implements HierarchyView {
  constructor(private readonly snapshot: HierarchySnapshot) {}

  getAncestors(
    fqName: string,
    opts: HierarchyQuery = {},
  ): readonly InheritanceEdge[] {
    return this.walk(
      fqName,
      "ancestorsBySource",
      (r) => r.ancestorFqName,
      opts,
    );
  }

  getDescendants(
    fqName: string,
    opts: HierarchyQuery = {},
  ): readonly InheritanceEdge[] {
    return this.walk(
      fqName,
      "descendantsByAncestor",
      (r) => r.sourceFqName,
      opts,
    );
  }

  private walk(
    key: string,
    index: "ancestorsBySource" | "descendantsByAncestor",
    next: (r: InheritanceEdgeRow) => string,
    opts: HierarchyQuery,
  ): InheritanceEdge[] {
    const out: InheritanceEdge[] = [];
    const seen = new Set<string>();
    const visit = (node: string, depth: number): void => {
      if (seen.has(node)) return; // cycle guard (defensive)
      seen.add(node);
      let rows = this.snapshot[index][node] ?? [];
      if (opts.kinds) rows = rows.filter((r) => opts.kinds!.includes(r.kind));
      if (opts.ordered && index === "ancestorsBySource") {
        rows = [...rows].sort(
          (a, b) =>
            MRO_RANK[a.kind] - MRO_RANK[b.kind] || a.ordinal - b.ordinal,
        );
      }
      for (const r of rows) {
        out.push({
          sourceFqName: r.sourceFqName,
          ancestorFqName: r.ancestorFqName,
          ancestorSymbolId: r.ancestorSymbolId,
          kind: r.kind,
          depth,
        });
        if (opts.transitive) visit(next(r), depth + 1);
      }
    };
    visit(key, 1);
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/graph/hierarchy-view.test.ts` Expected:
PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/graph/hierarchy-view.ts tests/core/infra/graph/hierarchy-view.test.ts
git commit -m "feat(infra): MapHierarchyView — sync bidirectional view over hierarchy snapshot (f10y)"
```

---

## Task 6: TS walker — capture `extends` + `implements` + interface-extends into `inheritanceEdges`

**Files:**

- Modify: `src/core/domains/language/typescript/walker/walker.ts`
- Test:
  `tests/core/domains/language/typescript/walker-inheritance-edges.test.ts`

> **Note:** This ADDS `inheritanceEdges` emission to the TS walker. The existing
> `classExtends` Record emission STAYS (phased — the super resolver still reads
> it). Do NOT delete or modify existing `collectClassExtends` examples.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/typescript/walker-inheritance-edges.test.ts
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { walkTypescript } from "../../../../../src/core/domains/language/typescript/walker/walker.js"; // adjust to actual export

function extract(code: string) {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript);
  const tree = parser.parse(code);
  return walkTypescript({
    relPath: "x.ts",
    language: "typescript",
    code,
    tree,
    chunks: [],
  } as any);
}

describe("TS walker inheritanceEdges", () => {
  it("captures class extends + implements with kinds", () => {
    const out = extract(
      `class Dog extends Animal implements Pet, Trackable {}`,
    );
    const edges = (out.inheritanceEdges ?? [])
      .map((e) => `${e.source}:${e.ancestor}:${e.kind}`)
      .sort();
    expect(edges).toEqual(
      [
        "Dog:Animal:super",
        "Dog:Pet:implements",
        "Dog:Trackable:implements",
      ].sort(),
    );
  });

  it("captures interface extends as implements-kind edges", () => {
    const out = extract(`interface Writable extends Closeable, Flushable {}`);
    const edges = (out.inheritanceEdges ?? [])
      .map((e) => `${e.source}:${e.ancestor}:${e.kind}`)
      .sort();
    expect(edges).toEqual(
      ["Writable:Closeable:implements", "Writable:Flushable:implements"].sort(),
    );
  });

  it("ordinal reflects declaration order of implements list", () => {
    const out = extract(`class C implements A, B {}`);
    const impl = (out.inheritanceEdges ?? [])
      .filter((e) => e.kind === "implements")
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(impl.map((e) => e.ancestor)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/typescript/walker-inheritance-edges.test.ts`
Expected: FAIL — `inheritanceEdges` undefined.

- [ ] **Step 3: Add collectors + emit**

Add a collector modelled on `collectClassExtends` (walker.ts:739). It reuses the
`class_heritage` → `implements_clause` sibling and `interface_declaration` →
`extends_type_clause`:

```ts
function collectInheritanceEdges(
  root: Parser.SyntaxNode,
): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  walk(root, (node) => {
    if (
      node.type === "class_declaration" ||
      node.type === "abstract_class_declaration"
    ) {
      const className = node.childForFieldName("name")?.text;
      if (!className) return;
      const heritage = node.children.find((c) => c.type === "class_heritage");
      if (!heritage) return;
      const ext = heritage.children.find((c) => c.type === "extends_clause");
      if (ext) {
        const parent = baseTypeName(
          ext.children.find(
            (c) =>
              c.type === "identifier" ||
              c.type === "member_expression" ||
              c.type === "generic_type",
          ),
        );
        if (parent)
          edges.push({
            source: className,
            ancestor: parent,
            kind: "super",
            ordinal: 0,
          });
      }
      const impl = heritage.children.find(
        (c) => c.type === "implements_clause",
      );
      if (impl) {
        let i = 0;
        for (const c of impl.children) {
          const name = baseTypeName(c);
          if (name)
            edges.push({
              source: className,
              ancestor: name,
              kind: "implements",
              ordinal: i++,
            });
        }
      }
    } else if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      const ext = node.children.find((c) => c.type === "extends_type_clause");
      if (!ext) return;
      let i = 0;
      for (const c of ext.children) {
        const base = baseTypeName(c);
        if (base)
          edges.push({
            source: name,
            ancestor: base,
            kind: "implements",
            ordinal: i++,
          });
      }
    }
  });
  return edges;
}

// Reduce identifier / member_expression / generic_type / type_identifier to the
// base type name. Returns null for separators (`,`/`extends`/`implements`).
function baseTypeName(node: Parser.SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (
    node.type === "identifier" ||
    node.type === "type_identifier" ||
    node.type === "member_expression"
  )
    return node.text;
  if (node.type === "generic_type") {
    const base = node.children.find(
      (c) =>
        c.type === "identifier" ||
        c.type === "member_expression" ||
        c.type === "type_identifier",
    );
    return base ? base.text : null;
  }
  return null;
}
```

In the walker's `out: FileExtraction` assembly (near walker.ts:98-104 where
`classExtends` is attached):

```ts
const inheritanceEdges = collectInheritanceEdges(input.tree.rootNode);
if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
```

Import the type:
`import type { InheritanceEdgeDecl, FileExtraction } from "...contracts/types/codegraph.js";`

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/typescript/walker-inheritance-edges.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify existing TS walker tests still pass (preserve examples)**

Run: `npx vitest run tests/core/domains/language/typescript/` Expected: PASS —
`it`/`describe` count ≥ base (`.claude/rules/domains-language.md`).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/typescript/walker/walker.ts tests/core/domains/language/typescript/walker-inheritance-edges.test.ts
git commit -m "feat(chunker): TS walker captures extends/implements/interface-extends into inheritanceEdges (f10y)"
```

---

## Task 7: Normalizer — `FileExtraction` → resolved `InheritanceEdgeRow[]`

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/inheritance-edges.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/inheritance-edges.test.ts`

The normalizer unifies the new `inheritanceEdges` field AND the legacy 3
Records, then resolves each ancestor name to a `symbol_id` via the symbol table
(fq_name match; NULL when external/unresolved).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/trajectory/codegraph/symbols/inheritance-edges.test.ts
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { normalizeInheritanceEdges } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";

// Minimal symbol resolver: returns a symbolId if the fq name is "known".
const resolve = (fq: string): string | null =>
  ["Animal", "Pet", "Dog"].includes(fq) ? fq : null;

describe("normalizeInheritanceEdges", () => {
  it("resolves ancestors from the unified inheritanceEdges field", () => {
    const ex = {
      relPath: "dog.ts",
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
        { source: "Dog", ancestor: "Pet", kind: "implements", ordinal: 0 },
      ],
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows).toContainEqual({
      sourceFqName: "Dog",
      sourceSymbolId: "Dog",
      ancestorFqName: "Animal",
      ancestorSymbolId: "Animal",
      kind: "super",
      ordinal: 0,
    });
  });

  it("external ancestor resolves to null symbol id but keeps fq name", () => {
    const ex = {
      relPath: "m.rb",
      inheritanceEdges: [
        {
          source: "User",
          ancestor: "ActiveRecord::Base",
          kind: "super",
          ordinal: 0,
        },
      ],
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows[0]).toMatchObject({
      ancestorFqName: "ActiveRecord::Base",
      ancestorSymbolId: null,
    });
  });

  it("lifts legacy classExtends / classAncestors / classPrependedAncestors Records", () => {
    const ex = {
      relPath: "x.rb",
      classExtends: { Dog: "Animal" },
      classAncestors: { Dog: ["Comparable"] },
      classPrependedAncestors: { Dog: ["Logging"] },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    const byKind = rows.reduce<Record<string, string[]>>(
      (m, r) => ((m[r.kind] ??= []).push(r.ancestorFqName), m),
      {},
    );
    expect(byKind.super).toEqual(["Animal"]);
    expect(byKind.include).toEqual(["Comparable"]);
    expect(byKind.prepend).toEqual(["Logging"]);
  });

  it("inheritanceEdges field wins over legacy when both present for a source (no duplicates)", () => {
    const ex = {
      relPath: "x.ts",
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
      ],
      classExtends: { Dog: "Animal" },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(
      rows.filter((r) => r.sourceFqName === "Dog" && r.kind === "super"),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/inheritance-edges.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the normalizer**

```ts
// src/core/domains/trajectory/codegraph/symbols/inheritance-edges.ts
/**
 * Normalize a FileExtraction's inheritance declarations into resolved
 * InheritanceEdgeRow[] (bd tea-rags-mcp-f10y). Unifies the new `inheritanceEdges`
 * field with the legacy classExtends/classAncestors/classPrependedAncestors
 * Records, then resolves each ancestor name to an in-project symbol_id.
 *
 * `resolveAncestor` returns the symbol_id for an in-project fq name, or null for
 * external / unresolved ancestors (kept by fq name).
 */
import type {
  FileExtraction,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../../../contracts/types/codegraph.js";

export type AncestorResolver = (fqName: string) => string | null;

export function normalizeInheritanceEdges(
  extraction: FileExtraction,
  resolveAncestor: AncestorResolver,
): InheritanceEdgeRow[] {
  const out: InheritanceEdgeRow[] = [];
  const seen = new Set<string>(); // `${source} ${ancestor} ${kind}` dedup

  const push = (
    source: string,
    ancestor: string,
    kind: InheritanceKind,
    ordinal: number,
  ): void => {
    const key = `${source} ${ancestor} ${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      sourceFqName: source,
      sourceSymbolId: resolveAncestor(source), // source is a class def — usually resolves
      ancestorFqName: ancestor,
      ancestorSymbolId: resolveAncestor(ancestor),
      kind,
      ordinal,
    });
  };

  // 1. unified field first (so it wins dedup over legacy)
  for (const e of extraction.inheritanceEdges ?? [])
    push(e.source, e.ancestor, e.kind, e.ordinal);

  // 2. legacy Records (skipped per (source,ancestor,kind) if already emitted)
  for (const [src, parent] of Object.entries(extraction.classExtends ?? {}))
    push(src, parent, "super", 0);
  for (const [src, anc] of Object.entries(extraction.classAncestors ?? {}))
    anc.forEach((a, i) => push(src, a, "include", i));
  for (const [src, anc] of Object.entries(
    extraction.classPrependedAncestors ?? {},
  ))
    anc.forEach((a, i) => push(src, a, "prepend", i));

  return out;
}
```

> **Note:** `classAncestors`'s first entry is semantically the superclass in
> some languages; mapping it wholesale to `include` is the conservative phased
> choice (the legacy super edge already arrives via `classExtends` for
> TS/JS/Python; Ruby's `classAncestors` mixes superclass+mixins). The follow-up
> forward-migration refines per-language kind tagging — out of scope here.
> Document this in the file header.

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/inheritance-edges.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/inheritance-edges.ts tests/core/domains/trajectory/codegraph/symbols/inheritance-edges.test.ts
git commit -m "feat(trajectory): inheritance-edges normalizer — unify capture + resolve ancestors (f10y)"
```

---

## Task 8: Provider — accumulate, barrier-finalize, inject `ctx.hierarchy`

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/provider-hierarchy.test.ts`

Three wirings: (a) accumulate `inheritanceEdges` + legacy run-global in
`sink.write`; (b) at the pass-1→pass-2 barrier,
normalize+resolve+`upsertFile(inheritance)`+`loadHierarchySnapshot`→build
`MapHierarchyView`; (c) set `ctx.hierarchy` in `resolveExtraction`'s
`CallContext` build (near provider.ts:1543-1568). Reset run-global at finalize
alongside the existing `runAncestors = {}` resets.

- [ ] **Step 1: Write the failing test** (behavioral — exercises the provider's
      sink → finish → snapshot path against an in-memory graph DB)

```ts
// tests/core/domains/trajectory/codegraph/symbols/provider-hierarchy.test.ts
import { describe, expect, it } from "vitest";

// Use the existing codegraph provider test harness helpers (mirror provider.test.ts setup).
// Index two TS files: one interface, two implementers — assert the persisted
// reverse index returns both, and a built HierarchyView resolves getDescendants.

describe("provider hierarchy finalize", () => {
  it("persists inheritance and exposes reverse index after finish", async () => {
    const { provider, graphDb } = await setupCodegraphProvider(); // harness from provider.test.ts
    const sink = provider.asExtractionSink("code_test");
    await sink.write({
      relPath: "onnx.ts",
      language: "typescript",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "Onnx", scope: [], calls: [] }],
      inheritanceEdges: [
        {
          source: "Onnx",
          ancestor: "EmbeddingProvider",
          kind: "implements",
          ordinal: 0,
        },
      ],
    } as any);
    await sink.write({
      relPath: "remote.ts",
      language: "typescript",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "Remote", scope: [], calls: [] }],
      inheritanceEdges: [
        {
          source: "Remote",
          ancestor: "EmbeddingProvider",
          kind: "implements",
          ordinal: 0,
        },
      ],
    } as any);
    await sink.finish();

    const subs = await graphDb.getSubtypes("EmbeddingProvider");
    expect(subs.map((e: any) => e.sourceFqName).sort()).toEqual([
      "Onnx",
      "Remote",
    ]);
  });
});
```

> Build `setupCodegraphProvider` by following the existing `provider.test.ts`
> construction (GraphDbClientPool over `:memory:`, run DATABASE_MIGRATIONS).
> Reuse — do NOT duplicate the harness if one already exists in the test file;
> import it.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-hierarchy.test.ts`
Expected: FAIL — inheritance never persisted (no accumulation / barrier).

- [ ] **Step 3a: Accumulate in `sink.write`**

Add an instance field beside `runAncestors` (provider.ts:414):

```ts
private runInheritance: import("../../../../contracts/types/codegraph.js").InheritanceEdgeDecl[] = [];
```

In `sink.write`, after the existing `classExtends` merge (provider.ts:678-682):

```ts
if (extraction.inheritanceEdges)
  this.runInheritance.push(...extraction.inheritanceEdges);
```

> Source-rel-path is not tracked per decl here; the barrier re-derives rows per
> file in 3b. Simpler: ALSO buffer the per-file extraction (the NDJSON spill
> already does). The barrier reads the spill, not `runInheritance`, for per-file
> attribution — keep `runInheritance` only if a run-global resolve is preferred.
> **Chosen approach:** resolve per-file at the barrier by re-reading the NDJSON
> spill (same loop pass-2 uses), so `source_rel_path` is correct and
> `removeFile` lifecycle holds. Remove `runInheritance` if the spill-reread
> approach is used; keep the symbol table (complete after pass-1) for ancestor
> resolution.

- [ ] **Step 3b: Barrier finalize — normalize, persist, snapshot, build view**

At the start of the pass-2 resolve flow (in `finish` / `streamFileBatch`, BEFORE
the per-file `resolveExtraction` loop), add a pre-pass over the spilled
extractions:

```ts
// Hierarchy finalize (barrier): pass-1 complete → symbolTable complete.
// Resolve + persist inheritance, then build the snapshot view for pass-2.
const resolveAncestor = (fq: string): string | null =>
  symbolTable.findByFqName(fq)?.symbolId ?? null;
for await (const line of readSpillLines()) {
  // same NDJSON source pass-2 reads
  const ex = JSON.parse(line) as FileExtraction;
  const inheritance = normalizeInheritanceEdges(ex, resolveAncestor);
  if (inheritance.length > 0) {
    await graphDb.upsertFile(
      { relPath: ex.relPath, language: ex.language },
      { fileEdges: [], methodEdges: [], inheritance },
    );
  }
}
const snapshot = await graphDb.loadHierarchySnapshot();
this.hierarchyView = new MapHierarchyView(snapshot);
```

> If `symbolTable` has no `findByFqName`, add a thin lookup (it already indexes
> by fq for resolution — reuse the existing accessor; check
> `GlobalSymbolTable`). The upsert here writes ONLY inheritance (empty
> file/method edges) so it does not disturb the pass-2 edge writes that follow;
> `upsertFile`'s per-source-file inheritance delete makes the later pass-2
> `upsertFile` for the same file idempotent (it carries `inheritance: undefined`
> → the delete clears nothing new). To avoid double-writing, prefer carrying the
> resolved `inheritance` INTO the pass-2 `resolveExtraction` result instead —
> see Step 3c note.

- [ ] **Step 3c: Inject `ctx.hierarchy`**

In the `CallContext` construction inside `resolveExtraction`
(provider.ts:1543-1568), add:

```ts
hierarchy: this.hierarchyView,
```

Declare the field: `private hierarchyView: HierarchyView | undefined;` and reset
it in the finalize cleanup beside `this.runAncestors = {}` (provider.ts:1216,
1248): `this.hierarchyView = undefined;`.

Import `MapHierarchyView` from `../../../../infra/graph/hierarchy-view.js` and
`normalizeInheritanceEdges` from `./inheritance-edges.js`.

> **Single-write refinement (preferred):** rather than the separate barrier
> upsert in 3b, compute the snapshot from an in-memory accumulation and let
> pass-2 attach `inheritance` to each file's `GraphEdges` so a single
> `upsertFile` per file persists edges + inheritance together. Implement
> whichever keeps one upsert per file; the test in Step 1 asserts the OBSERVABLE
> outcome (reverse index populated after finish), not the internal write count.

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-hierarchy.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full codegraph provider suite (no regressions)**

Run: `npx vitest run tests/core/domains/trajectory/codegraph/` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/provider-hierarchy.test.ts
git commit -m "feat(trajectory): hierarchy-finalize barrier persists inheritance + injects ctx.hierarchy (f10y)"
```

---

## Task 9: End-to-end — index fixture, assert bidirectional reverse index

**Files:**

- Test: `tests/core/domains/trajectory/codegraph/hierarchy-e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

```ts
// tests/core/domains/trajectory/codegraph/hierarchy-e2e.test.ts
import { describe, expect, it } from "vitest";

// Reuse the codegraph end-to-end harness (index a small in-memory/temp project,
// run the provider through asExtractionSink + finish, query the graph DB).

describe("hierarchy graph E2E", () => {
  it("interface with N implementers → reverse index returns all N", async () => {
    const files = {
      "embedding-provider.ts": `export interface EmbeddingProvider { embed(): number[]; }`,
      "onnx.ts": `import { EmbeddingProvider } from "./embedding-provider.js"; export class Onnx implements EmbeddingProvider { embed() { return []; } }`,
      "remote.ts": `import { EmbeddingProvider } from "./embedding-provider.js"; export class Remote implements EmbeddingProvider { embed() { return []; } }`,
      "jina.ts": `import { EmbeddingProvider } from "./embedding-provider.js"; export class Jina implements EmbeddingProvider { embed() { return []; } }`,
    };
    const { graphDb } = await indexFixtureProject(files); // harness
    const subs = await graphDb.getSubtypes("EmbeddingProvider");
    expect(subs.map((e: any) => e.sourceFqName).sort()).toEqual([
      "Jina",
      "Onnx",
      "Remote",
    ]);

    const trans = await graphDb.getTransitiveSubtypes("EmbeddingProvider");
    expect(trans).toHaveLength(3); // no deeper chain in this fixture
  });
});
```

> `indexFixtureProject` — reuse the existing codegraph E2E fixture harness if
> present (search `tests/core/domains/trajectory/codegraph/` for the
> project-indexing helper); otherwise assemble from the chunker + provider as
> the existing E2E tests do. Do NOT invent a new harness shape.

- [ ] **Step 2: Run test to verify it fails (then passes once harness wired)**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/hierarchy-e2e.test.ts`
Expected: PASS (all substrate tasks complete).

- [ ] **Step 3: Full build + type check + suite**

Run: `npm run build && npx vitest run` Expected: tsc 0 errors; all tests green.

- [ ] **Step 4: Commit**

```bash
git add tests/core/domains/trajectory/codegraph/hierarchy-e2e.test.ts
git commit -m "test(trajectory): E2E interface→implementers reverse index (f10y)"
```

---

## Self-Review notes

- **Spec coverage:** schema (Task 2), edge identity resolve-at-write (Task 7),
  HierarchyGraph async API (Task 4), HierarchyView sync (Task 5), unified
  capture incl. TS implements (Task 6), pipeline barrier (Task 8), bidirectional
  E2E (Task 9). The phased legacy-Record migration and CHA resolver consumption
  are explicitly OUT (2jet / follow-up).
- **Type consistency:** `InheritanceEdgeDecl` (capture) vs `InheritanceEdgeRow`
  (persist) vs `InheritanceEdge` (query+depth) are distinct and used
  consistently across Tasks 1, 4, 5, 7, 8.
- **Open verification (Task 8):** the spill-reread vs single-upsert wiring is
  left to the implementer with the observable-outcome test as the contract; both
  satisfy per-file `removeFile` lifecycle. Confirm `GlobalSymbolTable` exposes
  an fq-name lookup before Step 3b; if not, the first sub-step adds it.

## Live verification (after merge, per `.local/mcp-testing.md` + CLAUDE.md npm-link workflow)

Schema touches DuckDB codegraph payload → re-index required. After merge to
main + `npm run build && npm link` + MCP reconnect:
`force_reindex project=tea-rags`, then confirm `cg_symbols_inheritance` is
populated (interface implementers resolve) via a DuckDB read or a
`get_subtypes`-style probe once the MCP query tool lands (2jet).
