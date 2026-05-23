# Codegraph Symbols Slice 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans (via dinopowers:executing-plans wrapper per
> dinopowers chaining rule) to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a vertical slice that extracts TypeScript imports + method calls,
persists them as a graph in DuckDB, exposes Tier 1 file/method graph metrics as
Qdrant payload signals consumable by the existing reranker, and adds two MCP
tools (`get_callers`, `get_callees`) — all running as a fire-and-forget
enrichment provider that survives incremental reindex.

**Architecture:** Sub-trajectory `codegraph.symbols` plugs into the existing
`EnrichmentProvider` contract. Chunker emits `FileExtraction` (imports +
per-chunk calls) through an injected `ExtractionSink`. The provider buffers,
resolves via `TSCallResolver` + `GlobalSymbolTable`, writes to
`DuckDbGraphClient`, then `buildFileSignals` / `buildChunkSignals` read graph
metrics back into Qdrant payload. L1 codegraph family is a composition-time
factory; `TrajectoryRegistry` only sees L2 `SymbolsTrajectory`.

**Tech Stack:** TypeScript, tree-sitter (existing), DuckDB via
`@duckdb/node-api` (NEW dep), Vitest, Qdrant client (existing).

**Spec:**
`docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md` —
frozen, do not redesign. This plan decomposes the spec; it does not re-derive
it.

**Beads epic:** `tea-rags-mcp-l26`. One beads task per plan Task (1:1). Created
in lockstep with this plan per `.claude/rules/.local/plan-beads-sync.md`.

---

## Non-goals (mirror spec)

- PostgreSQL adapter (Slice 4 — `GraphDbClient` interface ships now to keep
  refactor cost zero).
- Non-TypeScript languages (Slice 3).
- Tier 2-3 metrics: `transitiveImpact`, `pageRank`, cycle detection (Slice 2).
  Betweenness was originally listed here too; cut from Slice 2 (2026-05-21) per
  Slice 2 plan Task B4.
- MCP tools beyond `get_callers`/`get_callees` (`get_dependencies`,
  `get_dependents`, `find_cycles` — Slice 2).
- Temporal coupling and other sub-graphs `cg_<other>_*` (Slice 5+).
- Auto background backfill on activation — drift prompt only.
- Removing the legacy `imports[]` payload field — separate ticket on the epic.
- Cross-language graph edges.

## Design divergence from spec — `ChunkingHook` vs file-level walker

The spec sketches `TypeScriptExtractionHook implements ChunkingHook`. The
existing hook chain (`src/core/domains/ingest/pipeline/chunker/hooks/types.ts`)
walks **per container**, not per file (each hook receives `containerNode` +
`validChildren`, never the file root). File-level imports live at the top of the
AST, outside any container, so a `ChunkingHook` cannot see them.

**Resolution:** the extraction layer is a dedicated `TypeScriptExtractionWalker`
invoked once per file by `TreeSitterChunker` after AST parse, NOT a
`ChunkingHook`. It receives `(rootNode, code, chunksProduced[])` and emits
`FileExtraction`. The walker is injected via the new optional
`extractionSink?: ExtractionSink` field on `TreeSitterChunkerOptions`. The hook
chain is untouched.

The `App` interface today is a flat method set (`semanticSearch`, `findSymbol`,
…). The spec's `graph: GraphFacade` sub-object would break that pattern; instead
we add flat methods `getCallers` and `getCallees` directly to `App`.
`GraphFacade` exists internally as a thin orchestrator per
`.claude/rules/facade-discipline.md`.

## Task DAG

```text
T1 (contracts) ──┬─► T2 (GlobalSymbolTable)
                 ├─► T3 (DuckDB adapter)
                 ├─► T4 (symbolId stability fix in tree-sitter.ts)  ── independent of T2,T3
                 ├─► T5 (TS extraction walker + ExtractionSink wiring)
                 └─► T6 (TSCallResolver)
T2 + T3 + T5 + T6 ─► T7 (Provider)
T7 ─► T8 (derived signals + preset)
T7 ─► T9 (SymbolsTrajectory + L1 factory)
T8 + T9 + T3 ─► T10 (GraphFacade + MCP tools + composition + bootstrap + drift)
```

Parallelisable batches if multiple engineers/sessions:

- After T1: T2, T3, T4, T5, T6 are independent.
- T7 needs T2/T3/T5/T6 (not T4).
- T8, T9 are independent siblings on top of T7.
- T10 is final integration.

## File structure

**New files** (28, matches spec File-by-file change list):

```text
src/core/contracts/types/codegraph.ts
src/core/adapters/duckdb/client.ts
src/core/adapters/duckdb/index.ts
src/core/infra/migration/database/runner.ts
src/core/infra/migration/database/migrations/001-cg-symbols-init.sql
src/core/domains/trajectory/codegraph/index.ts
src/core/domains/trajectory/codegraph/symbols/index.ts
src/core/domains/trajectory/codegraph/symbols/provider.ts
src/core/domains/trajectory/codegraph/symbols/payload-signals.ts
src/core/domains/trajectory/codegraph/symbols/symbol-table.ts
src/core/domains/trajectory/codegraph/symbols/resolvers/base.ts
src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.ts
src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-config-loader.ts
src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.ts
src/core/domains/trajectory/codegraph/symbols/resolvers/ts/index.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-out.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-leaf.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/called-by-count.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/call-site-count.ts
src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.ts
src/core/domains/trajectory/codegraph/symbols/rerank/presets/blast-radius.ts
src/core/domains/trajectory/codegraph/symbols/rerank/presets/index.ts
src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.ts
src/core/api/internal/facades/graph-facade.ts
src/core/api/public/dto/graph.ts
src/mcp/tools/codegraph.ts
```

**Modified files** (10):

```text
src/core/contracts/index.ts                                   # re-export codegraph types
src/core/domains/ingest/pipeline/chunker/tree-sitter.ts       # symbolId fix (L194-219) + extractionSink injection
src/core/domains/ingest/pipeline/file-processor.ts            # sink.write per file
src/core/domains/ingest/pipeline/enrichment/coordinator.ts    # inject ExtractionSink into chunker pool (only — no refactor)
src/core/api/internal/composition.ts                          # createCodegraphTrajectories factory
src/core/api/public/app.ts                                    # getCallers/getCallees methods + AppDeps.graphFacade
src/core/api/public/dto/index.ts                              # re-export graph DTOs
src/core/bootstrap/factory.ts                                 # GraphDbClient construction + migrations
src/core/infra/schema-drift-monitor.ts                        # codegraph backfill check
src/mcp/tools/index.ts                                        # registerCodegraphTools
```

**Test files** (mirror source tree):

```text
tests/core/contracts/types/codegraph.test.ts                                                 # type-level smoke
tests/core/adapters/duckdb/client.test.ts
tests/core/infra/migration/database/runner.test.ts
tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.test.ts
tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.test.ts
tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.test.ts
tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.test.ts
tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.test.ts
tests/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.test.ts
tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts
tests/core/api/internal/facades/graph-facade.test.ts
tests/mcp/tools/codegraph.test.ts
tests/integration/codegraph-vertical-slice.test.ts
```

---

## Task 1: Contracts foundation

**Description:** Author every codegraph type used downstream (extraction, symbol
table, resolver, graph DB) in a single contracts file. No implementation — only
types and barrel re-export. Allows T2-T10 to be developed in parallel against a
stable surface.

**Files:**

- Create: `src/core/contracts/types/codegraph.ts`
- Modify: `src/core/contracts/index.ts` (add re-export)
- Test: `tests/core/contracts/types/codegraph.test.ts`

**Beads:** new task linked to epic `tea-rags-mcp-l26`, depends on epic, blocks
T2-T10.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/contracts/types/codegraph.test.ts
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CalleeEdge,
  CallerEdge,
  CallRef,
  CallResolver,
  ChunkExtraction,
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  ImportRef,
  ResolvedTarget,
  SymbolDefinition,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("codegraph contracts", () => {
  it("re-exports through the contracts barrel", async () => {
    const barrel = await import("../../../../src/core/contracts/index.js");
    // Type-only re-export — at runtime the namespace is empty but importable.
    expect(typeof barrel).toBe("object");
  });

  it("FileExtraction has the documented shape", () => {
    const sample: FileExtraction = {
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [{ importText: "./bar", startLine: 1 }],
      chunks: [
        {
          symbolId: "Foo.bar",
          scope: ["Foo"],
          calls: [
            {
              callText: "Baz.qux()",
              receiver: "Baz",
              member: "qux",
              startLine: 4,
            },
          ],
        },
      ],
      fileScope: [],
    };
    expect(sample.chunks[0].calls[0].member).toBe("qux");
  });

  it("GraphDbClient interface lists every required method", () => {
    const required: (keyof GraphDbClient)[] = [
      "init",
      "close",
      "upsertFile",
      "removeFile",
      "getFanIn",
      "getFanOut",
      "getCallers",
      "getCallees",
      "getCalledByCount",
      "getCallSiteCount",
      "hasData",
    ];
    expect(required.length).toBe(11);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/contracts/types/codegraph.test.ts
```

Expected: FAIL — `Cannot find module '.../codegraph.js'`.

- [ ] **Step 3: Create `src/core/contracts/types/codegraph.ts`**

Paste the entire contract block from the spec
(`docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md`, the
"`core/contracts/types/codegraph.ts` (new file)" section). The spec content is
canonical — copy it verbatim. Two small additions relative to spec:

```typescript
// At the top, alongside existing imports from common.ts:
import type { RelPath, SymbolId } from "./common.js";

// At the bottom, add chunk preview type used by GraphFacade response:
export interface GraphChunkPreview {
  symbolId: SymbolId;
  relPath: RelPath;
  startLine: number;
  endLine: number;
  preview: string;
}
```

If `RelPath` / `SymbolId` aliases don't exist in `common.ts`, add them as
`export type RelPath = string;` and `export type SymbolId = string;`
(single-line nominal aliases — no runtime impact). If `common.ts` itself doesn't
exist, add the aliases inline at the top of `codegraph.ts` and re-export.

- [ ] **Step 4: Modify `src/core/contracts/index.ts`**

Add line:

```typescript
export type * from "./types/codegraph.js";
```

Place after the existing `export type * from "./types/trajectory.js";` line.

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/core/contracts/types/codegraph.test.ts
```

Expected: PASS — 3 tests green.

- [ ] **Step 6: Type-check the project**

```bash
npx tsc --noEmit
```

Expected: clean — contracts are types only, no runtime/compile side effects.

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/types/codegraph.ts src/core/contracts/index.ts tests/core/contracts/types/codegraph.test.ts
git commit -m "feat(contracts): add codegraph slice 1 contracts (FileExtraction, GraphDbClient, CallResolver)"
```

---

## Task 2: GlobalSymbolTable in-memory implementation

**Description:** Concrete `InMemoryGlobalSymbolTable` implementing the contract
from T1. Keyed by fully-qualified name + short name. Used by `TSCallResolver`
(T6) for cross-file symbol lookup; populated by `CodegraphEnrichmentProvider`
(T7) from chunker output.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts`
- Test: `tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts`

**Beads:** new task, depends on T1, blocks T6, T7.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("InMemoryGlobalSymbolTable", () => {
  let table: InMemoryGlobalSymbolTable;
  beforeEach(() => {
    table = new InMemoryGlobalSymbolTable();
  });

  it("returns empty arrays for unknown lookups", () => {
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookupByShortName("bar")).toEqual([]);
    expect(table.size()).toBe(0);
  });

  it("upserts symbols and resolves by fqName and short name", () => {
    table.upsertFile("src/foo.ts", [
      {
        symbolId: "Foo.bar",
        fqName: "Foo.bar",
        shortName: "bar",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
      {
        symbolId: "Foo.baz",
        fqName: "Foo.baz",
        shortName: "baz",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    expect(table.lookup("Foo.bar")).toEqual([
      {
        symbolId: "Foo.bar",
        fqName: "Foo.bar",
        shortName: "bar",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    expect(table.lookupByShortName("baz").length).toBe(1);
    expect(table.size()).toBe(2);
  });

  it("removeFile drops all symbols owned by the file", () => {
    table.upsertFile("src/foo.ts", [
      {
        symbolId: "Foo.bar",
        fqName: "Foo.bar",
        shortName: "bar",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    table.upsertFile("src/quux.ts", [
      {
        symbolId: "Quux.bar",
        fqName: "Quux.bar",
        shortName: "bar",
        relPath: "src/quux.ts",
        scope: ["Quux"],
      },
    ]);
    table.removeFile("src/foo.ts");
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookupByShortName("bar").map((d) => d.relPath)).toEqual([
      "src/quux.ts",
    ]);
  });

  it("upsertFile is idempotent — re-upserting the same file replaces previous definitions", () => {
    table.upsertFile("src/foo.ts", [
      {
        symbolId: "Foo.bar",
        fqName: "Foo.bar",
        shortName: "bar",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    table.upsertFile("src/foo.ts", [
      {
        symbolId: "Foo.baz",
        fqName: "Foo.baz",
        shortName: "baz",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    expect(table.lookup("Foo.bar")).toEqual([]);
    expect(table.lookup("Foo.baz").length).toBe(1);
  });

  it("monkey-patched modules return multiple matches for the same fqName", () => {
    table.upsertFile("src/a.ts", [
      {
        symbolId: "M.f",
        fqName: "M.f",
        shortName: "f",
        relPath: "src/a.ts",
        scope: ["M"],
      },
    ]);
    table.upsertFile("src/b.ts", [
      {
        symbolId: "M.f",
        fqName: "M.f",
        shortName: "f",
        relPath: "src/b.ts",
        scope: ["M"],
      },
    ]);
    expect(
      table
        .lookup("M.f")
        .map((d) => d.relPath)
        .sort(),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `InMemoryGlobalSymbolTable`**

```typescript
// src/core/domains/trajectory/codegraph/symbols/symbol-table.ts
import type {
  GlobalSymbolTable,
  RelPath,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";

export class InMemoryGlobalSymbolTable implements GlobalSymbolTable {
  /** fqName -> definitions across files (multiple = monkey-patched module). */
  private readonly byFq = new Map<string, SymbolDefinition[]>();
  /** shortName -> definitions across files. */
  private readonly byShort = new Map<string, SymbolDefinition[]>();
  /** relPath -> definitions, for cheap removal on re-upsert. */
  private readonly byFile = new Map<RelPath, SymbolDefinition[]>();

  upsertFile(relPath: RelPath, definitions: SymbolDefinition[]): void {
    this.removeFile(relPath);
    if (definitions.length === 0) return;
    this.byFile.set(relPath, definitions.slice());
    for (const def of definitions) {
      pushTo(this.byFq, def.fqName, def);
      pushTo(this.byShort, def.shortName, def);
    }
  }

  removeFile(relPath: RelPath): void {
    const existing = this.byFile.get(relPath);
    if (!existing) return;
    this.byFile.delete(relPath);
    for (const def of existing) {
      removeFrom(this.byFq, def.fqName, def);
      removeFrom(this.byShort, def.shortName, def);
    }
  }

  lookup(fqName: string): SymbolDefinition[] {
    return (this.byFq.get(fqName) ?? []).slice();
  }

  lookupByShortName(name: string): SymbolDefinition[] {
    return (this.byShort.get(name) ?? []).slice();
  }

  size(): number {
    let n = 0;
    for (const defs of this.byFile.values()) n += defs.length;
    return n;
  }
}

function pushTo(
  map: Map<string, SymbolDefinition[]>,
  key: string,
  def: SymbolDefinition,
): void {
  const arr = map.get(key);
  if (arr) arr.push(def);
  else map.set(key, [def]);
}

function removeFrom(
  map: Map<string, SymbolDefinition[]>,
  key: string,
  def: SymbolDefinition,
): void {
  const arr = map.get(key);
  if (!arr) return;
  const filtered = arr.filter(
    (d) =>
      d !== def && !(d.relPath === def.relPath && d.symbolId === def.symbolId),
  );
  if (filtered.length === 0) map.delete(key);
  else map.set(key, filtered);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
```

Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/symbol-table.ts tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
git commit -m "feat(codegraph): add in-memory GlobalSymbolTable"
```

---

## Task 3: DuckDB adapter + migration runner

**Description:** `DuckDbGraphClient` implementing the `GraphDbClient` contract
from T1, plus a driver-agnostic migration runner and the slice-1 schema. Single
in-process file-backed DuckDB instance per `App`, named
`<collection>.codegraph.duckdb` under the data directory. The runner is generic
over `GraphDbClient` adapter methods so Slice 4's PostgreSQL adapter plugs in
without refactor.

**Files:**

- Modify: `package.json` (add `@duckdb/node-api` dependency)
- Create: `src/core/adapters/duckdb/client.ts`
- Create: `src/core/adapters/duckdb/index.ts`
- Create: `src/core/infra/migration/database/runner.ts`
- Create: `src/core/infra/migration/database/migrations/001-cg-symbols-init.sql`
- Test: `tests/core/adapters/duckdb/client.test.ts`
- Test: `tests/core/infra/migration/database/runner.test.ts`

**Beads:** new task, depends on T1, blocks T7, T10. Label: `architecture`.

- [ ] **Step 1: Add the DuckDB dependency**

```bash
npm install --save @duckdb/node-api
```

Confirm `package.json` `dependencies` now lists `@duckdb/node-api`.

- [ ] **Step 2: Write the failing migration-runner test**

```typescript
// tests/core/infra/migration/database/runner.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";

describe("runMigrations", () => {
  let tmp: string;
  let dbPath: string;
  let migDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-mig-"));
    dbPath = join(tmp, "test.duckdb");
    migDir = join(tmp, "migrations");
    mkdirSync(migDir);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("applies migrations in numeric order and records them in schema_migrations", async () => {
    writeFileSync(
      join(migDir, "002-second.sql"),
      "CREATE TABLE second_table (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(
      join(migDir, "001-first.sql"),
      "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
    );

    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, migDir);
    await client.close();

    const client2 = new DuckDbGraphClient({ path: dbPath });
    await client2.init();
    const applied = await client2.queryAll<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    await client2.close();
    expect(applied.map((r) => r.filename)).toEqual([
      "001-first.sql",
      "002-second.sql",
    ]);
  });

  it("is idempotent — re-running applies nothing", async () => {
    writeFileSync(
      join(migDir, "001-first.sql"),
      "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
    );
    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, migDir);
    const second = await runMigrations(client, migDir);
    await client.close();
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001-first.sql"]);
  });
});
```

- [ ] **Step 3: Write the failing DuckDbGraphClient test**

```typescript
// tests/core/adapters/duckdb/client.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

const MIG_DIR = resolve(
  __dirname,
  "../../../../src/core/infra/migration/database/migrations",
);

describe("DuckDbGraphClient", () => {
  let tmp: string;
  let dbPath: string;
  let client: DuckDbGraphClient;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-db-"));
    dbPath = join(tmp, "g.duckdb");
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hasData() returns false on a freshly migrated DB", async () => {
    expect(await client.hasData()).toBe(false);
  });

  it("upsertFile inserts file row and edges atomically", async () => {
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
        methodEdges: [],
      },
    );
    expect(await client.getFanOut("src/a.ts")).toBe(1);
    expect(await client.getFanIn("src/b.ts")).toBe(1);
    expect(await client.hasData()).toBe(true);
  });

  it("removeFile removes the file row and cascades incoming + outgoing edges", async () => {
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }],
        methodEdges: [],
      },
    );
    await client.removeFile("src/a.ts");
    expect(await client.getFanOut("src/b.ts")).toBe(0);
  });

  it("getCallers returns method-edges in stable order", async () => {
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    await client.upsertFile(
      { relPath: "src/c.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "C.f",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    await client.upsertFile(
      { relPath: "src/d.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "D.g",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    const callers = await client.getCallers("A.x");
    expect(callers.map((c) => c.sourceSymbolId).sort()).toEqual(["C.f", "D.g"]);
  });
});
```

- [ ] **Step 4: Run both tests to verify they fail**

```bash
npx vitest run tests/core/adapters/duckdb/client.test.ts tests/core/infra/migration/database/runner.test.ts
```

Expected: FAIL — both modules missing.

- [ ] **Step 5: Author
      `src/core/infra/migration/database/migrations/001-cg-symbols-init.sql`**

```sql
CREATE TABLE IF NOT EXISTS cg_symbols_files (
  rel_path  VARCHAR PRIMARY KEY,
  language  VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS cg_symbols_edges_file (
  source_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  target_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  import_text      VARCHAR,
  PRIMARY KEY (source_rel_path, target_rel_path)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_file_target
  ON cg_symbols_edges_file (target_rel_path);

CREATE TABLE IF NOT EXISTS cg_symbols_edges_method (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  call_expression  VARCHAR NOT NULL,
  PRIMARY KEY (source_symbol_id, call_expression, target_symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);
```

- [ ] **Step 6: Implement `src/core/adapters/duckdb/client.ts`**

```typescript
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import type {
  CalleeEdge,
  CallerEdge,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolId,
} from "../../contracts/types/codegraph.js";

export interface DuckDbGraphClientOptions {
  path: string;
}

export class DuckDbGraphClient implements GraphDbClient {
  private instance?: DuckDBInstance;
  private conn?: DuckDBConnection;
  constructor(private readonly options: DuckDbGraphClientOptions) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.options.path), { recursive: true });
    this.instance = await DuckDBInstance.create(this.options.path);
    this.conn = await this.instance.connect();
  }

  async close(): Promise<void> {
    await this.conn?.disconnectSync?.();
    this.instance?.closeSync?.();
    this.conn = undefined;
    this.instance = undefined;
  }

  /** Generic exec — used by migration runner. Returns no rows. */
  async exec(sql: string): Promise<void> {
    await this.requireConn().run(sql);
  }

  /** Generic prepared exec with positional params. */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    const prep = await this.requireConn().prepare(sql);
    for (let i = 0; i < params.length; i++) {
      prep.bindVarchar(i + 1, params[i] == null ? null : String(params[i]));
    }
    await prep.run();
  }

  /** Generic query returning all rows as plain objects. */
  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const prep = await this.requireConn().prepare(sql);
    for (let i = 0; i < params.length; i++) {
      prep.bindVarchar(i + 1, params[i] == null ? null : String(params[i]));
    }
    const reader = await prep.runAndReadAll();
    return reader.getRowObjectsJson() as T[];
  }

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.exec("BEGIN");
    try {
      await this.run(
        "INSERT OR REPLACE INTO cg_symbols_files (rel_path, language) VALUES (?, ?)",
        [node.relPath, node.language],
      );
      await this.run(
        "DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ?",
        [node.relPath],
      );
      await this.run(
        "DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?",
        [node.relPath],
      );
      for (const e of edges.fileEdges) {
        await this.run(
          "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)",
          [node.relPath, e.targetRelPath, e.importText],
        );
      }
      for (const e of edges.methodEdges) {
        await this.run(
          "INSERT INTO cg_symbols_edges_method (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression) VALUES (?, ?, ?, ?, ?)",
          [
            e.sourceSymbolId,
            node.relPath,
            e.targetSymbolId,
            e.targetRelPath,
            e.callExpression,
          ],
        );
      }
      await this.exec("COMMIT");
    } catch (err) {
      await this.exec("ROLLBACK");
      throw err;
    }
  }

  async removeFile(relPath: RelPath): Promise<void> {
    await this.run("DELETE FROM cg_symbols_files WHERE rel_path = ?", [
      relPath,
    ]);
  }

  async getFanIn(relPath: RelPath): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE target_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE source_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return this.queryAll<CallerEdge>(
      "SELECT source_symbol_id AS sourceSymbolId, source_rel_path AS sourceRelPath, call_expression AS callExpression FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id",
      [symbolId],
    );
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return this.queryAll<CalleeEdge>(
      "SELECT target_symbol_id AS targetSymbolId, target_rel_path AS targetRelPath, call_expression AS callExpression FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path",
      [symbolId],
    );
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE target_symbol_id = ?",
      [symbolId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = ?",
      [symbolId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async hasData(): Promise<boolean> {
    const rows = await this.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_files",
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private requireConn(): DuckDBConnection {
    if (!this.conn)
      throw new Error("DuckDbGraphClient: init() must be called before use");
    return this.conn;
  }
}
```

If `@duckdb/node-api` exports differ in the installed minor version, adjust the
import + connection lifecycle accordingly — the test suite is the contract.

- [ ] **Step 7: Implement `src/core/infra/migration/database/runner.ts`**

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationCapableClient {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  queryAll<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  client: MigrationCapableClient,
  dir: string,
): Promise<MigrationResult> {
  await client.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied = new Set(
    (
      await client.queryAll<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      )
    ).map((r) => r.filename),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const filename of files) {
    if (applied.has(filename)) {
      result.skipped.push(filename);
      continue;
    }
    const sql = readFileSync(join(dir, filename), "utf8");
    await client.exec("BEGIN");
    try {
      await client.exec(sql);
      await client.run("INSERT INTO schema_migrations (filename) VALUES (?)", [
        filename,
      ]);
      await client.exec("COMMIT");
      result.applied.push(filename);
    } catch (err) {
      await client.exec("ROLLBACK");
      throw err;
    }
  }
  return result;
}
```

- [ ] **Step 8: Write the barrel `src/core/adapters/duckdb/index.ts`**

```typescript
export { DuckDbGraphClient, type DuckDbGraphClientOptions } from "./client.js";
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
npx vitest run tests/core/adapters/duckdb/client.test.ts tests/core/infra/migration/database/runner.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/core/adapters/duckdb src/core/infra/migration tests/core/adapters/duckdb tests/core/infra/migration
git commit -m "feat(adapters): add DuckDB graph adapter + migration runner with cg_symbols schema"
```

---

## Task 4: symbolId stability fix in `chunkOversizedNode`

**Description:** Single surgical patch in `tree-sitter.ts` (L194-219) so
subChunks of split methods inherit `symbolId` from the parent method and report
`chunkType: "function"` instead of `"block"`. Makes the existing invariant "all
chunks of one method share the same symbolId" hold without introducing any new
payload field.

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` (L194-219
  only)
- Test:
  `tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts`

**Beads:** new task, depends on T1, independent of T2/T3 — can run in parallel.

- [ ] **Step 1: Locate `chunkOversizedNode`**

```bash
sed -n '190,225p' src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
```

Confirm the function body matches the spec's quoted L194-219 (subChunks loop
without symbolId/chunkType).

- [ ] **Step 2: Find or define the `buildSymbolId` helper**

```bash
grep -n "buildSymbolId\|symbolId:" src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
```

Two outcomes:

- If `buildSymbolId(parentName)` exists as a private method, reuse it.
- If symbolId is currently inlined inside `chunkSingleNode` /
  `chunkWithChildExtraction`, extract it into a
  `private buildSymbolId(parentName: string | undefined): string | undefined`
  helper first — its body must be identical to the inlined expression. Run
  `npx vitest run tests/core/domains/ingest/pipeline/chunker/` after extraction;
  all existing tests must still pass before proceeding.

- [ ] **Step 3: Write the failing regression test**

```typescript
// tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";

describe("TreeSitterChunker oversized method symbolId inheritance", () => {
  it("split chunks of one oversized function share the same symbolId and report chunkType=function", async () => {
    const fnName = "doWork";
    const body = "  console.log('x');\n".repeat(500); // ~10KB > default maxChunkSize
    const code = `export function ${fnName}() {\n${body}}\n`;

    const chunker = new TreeSitterChunker({ maxChunkSize: 1500 });
    const chunks = await chunker.chunk(code, "src/big.ts", "typescript");

    const splits = chunks.filter((c) => c.metadata.parentSymbolId === fnName);
    expect(splits.length).toBeGreaterThan(1);
    for (const c of splits) {
      expect(c.metadata.symbolId).toBe(fnName);
      expect(c.metadata.chunkType).toBe("function");
    }
  });
});
```

Adjust the constructor invocation to match `TreeSitterChunker`'s actual factory
shape (it may take `(config, fallbackChunker)` — check the head of
`tree-sitter.ts`). The assertion (symbolId + chunkType invariant) is the
contract.

- [ ] **Step 4: Run test to verify it fails**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts
```

Expected: FAIL — `metadata.symbolId` is `undefined`, `metadata.chunkType` is
`"block"`.

- [ ] **Step 5: Apply the surgical fix to `chunkOversizedNode`**

Replace the metadata block (L211-217) inside the `chunks.push({...})` call with:

```typescript
        metadata: {
          ...subChunk.metadata,
          chunkIndex: chunks.length,
          symbolId: this.buildSymbolId(parentName),
          chunkType: "function",
          parentSymbolId: parentName,
          parentType,
          methodLines: nodeMethodLines,
        },
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full chunker test suite to guarantee no regression**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/tree-sitter.ts tests/core/domains/ingest/pipeline/chunker/tree-sitter.oversized-symbolid.test.ts
git commit -m "fix(chunker): inherit symbolId + chunkType in chunkOversizedNode subChunks"
```

---

## Task 5: TypeScript extraction walker + `ExtractionSink` wiring

**Description:** Dedicated walker (not a `ChunkingHook`) that walks the full TS
file AST after parse, collects `ImportRef[]` from top-level `import_statement`
nodes and `CallRef[]` per chunk by scanning `call_expression` nodes within each
chunk's line range. Wired through `TreeSitterChunker` → chunker pool →
`processFiles` → `EnrichmentCoordinator`. Optional dependency — the chunker
still works when `extractionSink` is undefined.

**Files:**

- Create:
  `src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` (add
  `extractionSink` option + per-file emit call)
- Modify: `src/core/domains/ingest/pipeline/file-processor.ts` (thread sink from
  options through)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (additive
  single-line injection — HIGH-CHURN active-work file, no refactor)
- Test:
  `tests/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.test.ts`

**Beads:** new task, depends on T1, blocks T7. Label: `architecture`.
**Coordinator note** in the beads description:
`coordinator.ts has 18-commit churn and active in-flight work — change must be a single additive injection.`

- [ ] **Step 1: Write the failing walker test**

```typescript
// tests/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.test.ts
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.js";

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript as unknown as Parser.Language);
  return parser.parse(code);
}

describe("extractFromTypescriptFile", () => {
  it("extracts top-level imports with text and startLine", () => {
    const code = `import { Foo } from "./foo";\nimport React from "react";\nfunction main() { Foo.bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 3, endLine: 3, scope: [] }],
    });
    expect(extraction.imports.map((i) => i.importText).sort()).toEqual([
      "./foo",
      "react",
    ]);
    expect(extraction.imports[0].startLine).toBeGreaterThan(0);
  });

  it("attaches calls inside a chunk's line range to that chunk", () => {
    const code = `function main() {\n  Foo.bar();\n  baz();\n}\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 1, endLine: 4, scope: [] }],
    });
    const calls = extraction.chunks[0]?.calls ?? [];
    expect(calls.map((c) => c.member).sort()).toEqual(["bar", "baz"]);
    const fooCall = calls.find((c) => c.member === "bar");
    expect(fooCall?.receiver).toBe("Foo");
    const bazCall = calls.find((c) => c.member === "baz");
    expect(bazCall?.receiver).toBeNull();
  });

  it("ignores calls outside any chunk", () => {
    const code = `Foo.outside();\nfunction main() { bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 2, endLine: 2, scope: [] }],
    });
    const memberCalls = extraction.chunks[0].calls.map((c) => c.member);
    expect(memberCalls).toContain("bar");
    expect(memberCalls).not.toContain("outside");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractFromTypescriptFile`**

```typescript
// src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.ts
import type Parser from "tree-sitter";

import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
} from "../../../../../contracts/types/codegraph.js";

export interface ExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  /** Sorted by startLine ascending. */
  chunks: {
    symbolId: string;
    startLine: number;
    endLine: number;
    scope: string[];
  }[];
}

export function extractFromTypescriptFile(input: ExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  const calls = collectCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    calls: calls.filter(
      (cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine,
    ),
  }));
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_statement") return;
    const src = node.children.find((c) => c.type === "string");
    if (!src) return;
    const text = src.text.replace(/^["']|["']$/g, "");
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    if (callee.type === "member_expression") {
      const obj = callee.childForFieldName("object");
      const prop = callee.childForFieldName("property");
      if (!obj || !prop) return;
      out.push({
        callText: node.text,
        receiver: obj.text,
        member: prop.text,
        startLine,
      });
    } else {
      out.push({
        callText: node.text,
        receiver: null,
        member: callee.text,
        startLine,
      });
    }
  });
  return out;
}

function walk(
  node: Parser.SyntaxNode,
  visit: (n: Parser.SyntaxNode) => void,
): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.test.ts
```

Expected: PASS — 3 tests green.

- [ ] **Step 5: Plumb the sink through `TreeSitterChunker`**

In `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`:

1. Extend `TreeSitterChunkerOptions` (or whatever the constructor config type is
   named — locate it at the top of the file) with
   `extractionSink?: import("../../../../contracts/types/codegraph.js").ExtractionSink`.
2. In the file-level chunk method (the public
   `chunk(code, filePath, language): Promise<CodeChunk[]>`), after the chunks
   array is built but before return, if `extractionSink` is provided AND
   `language === "typescript"`, call the walker:

```typescript
if (this.options.extractionSink && language === "typescript") {
  const extraction = extractFromTypescriptFile({
    tree,
    code,
    relPath: filePath,
    language,
    chunks: chunks
      .filter((c) => typeof c.metadata.symbolId === "string")
      .map((c) => ({
        symbolId: c.metadata.symbolId as string,
        startLine: c.startLine,
        endLine: c.endLine,
        scope: [],
      })),
  });
  await this.options.extractionSink.write(extraction);
}
```

The `tree` variable must already exist in scope from the parser call. The hook
chain is untouched.

- [ ] **Step 6: Thread sink through `processFiles`**

In `src/core/domains/ingest/pipeline/file-processor.ts`:

1. Extend `FileProcessorOptions` with `extractionSink?: ExtractionSink`.
2. Forward to the chunker pool: when constructing the per-worker
   `TreeSitterChunker`, pass `extractionSink` through the existing options
   pipeline.
3. After all files are chunked (look for the `await chunker.chunk(...)` loop
   completion), call `extractionSink?.finish()` once.

- [ ] **Step 7: Inject sink at the coordinator — SURGICAL**

In `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`:

Add ONE LINE that reads `extractionSink?` from a new optional
`EnrichmentCoordinatorDeps.extractionSink` field and forwards it through
`FileProcessorOptions.extractionSink`. **Do not** rearrange existing logic.
Match the additive style of recent `coordinator.ts` commits (#1, #2).

If the coordinator does not have a clean way to pass options into
`processFiles`, surface a new optional input on whatever struct it forwards.
Single-line additive change; if it requires more, file a follow-up beads issue
and skip the integration here — the sink is optional and codegraph can be wired
later in T10.

- [ ] **Step 8: Run the existing ingest test suite for regression**

```bash
npx vitest run tests/core/domains/ingest/
```

Expected: all green (sink is optional, no behavior change when undefined).

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/extraction src/core/domains/ingest/pipeline/chunker/tree-sitter.ts src/core/domains/ingest/pipeline/file-processor.ts src/core/domains/ingest/pipeline/enrichment/coordinator.ts tests/core/domains/ingest/pipeline/chunker/extraction
git commit -m "feat(chunker): add TypeScript extraction walker and ExtractionSink wiring"
```

---

## Task 6: TypeScript CallResolver

**Description:** Language-specific resolver that translates a `CallRef` +
`CallContext` into a `ResolvedTarget`. Three components: `ts-config-loader`
(parses `tsconfig.json` `compilerOptions.paths` / `baseUrl`), `ts-path-mapper`
(applies aliases + relative resolution), `ts-resolver` (orchestrates the lookup
against `GlobalSymbolTable`). **Resolution depth for Slice 1: relative paths +
tsconfig `paths`/`baseUrl`** — full TS resolver (node_modules, conditional
exports) is out of scope.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/resolvers/base.ts`
- Create:
  `src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.ts`
- Create:
  `src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-config-loader.ts`
- Create:
  `src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.ts`
- Create: `src/core/domains/trajectory/codegraph/symbols/resolvers/ts/index.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.test.ts`

**Beads:** depends on T1, blocks T7.

- [ ] **Step 1: Write the failing path-mapper test**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.test.ts
import { describe, expect, it } from "vitest";

import { mapImportToFile } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.js";

describe("mapImportToFile", () => {
  it("resolves relative paths against caller file", () => {
    const result = mapImportToFile("./bar", "src/foo.ts", {
      baseUrl: ".",
      paths: {},
    });
    expect(result).toBe("src/bar.ts");
  });

  it("resolves parent-relative paths", () => {
    const result = mapImportToFile("../utils/x", "src/a/b/foo.ts", {
      baseUrl: ".",
      paths: {},
    });
    expect(result).toBe("src/a/utils/x.ts");
  });

  it("applies tsconfig paths aliases", () => {
    const result = mapImportToFile("@/lib/foo", "src/foo.ts", {
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    });
    expect(result).toBe("src/lib/foo.ts");
  });

  it("returns null for bare npm imports", () => {
    expect(
      mapImportToFile("react", "src/foo.ts", { baseUrl: ".", paths: {} }),
    ).toBeNull();
    expect(
      mapImportToFile("@anthropic/sdk", "src/foo.ts", {
        baseUrl: ".",
        paths: {},
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `ts-path-mapper.ts`**

```typescript
import { posix } from "node:path";

export interface TsCompilerOptions {
  baseUrl: string;
  paths: Record<string, string[]>;
}

const BARE_SPECIFIER = /^[a-zA-Z@]/;

export function mapImportToFile(
  importText: string,
  callerFile: string,
  options: TsCompilerOptions,
): string | null {
  if (importText.startsWith(".")) {
    const dir = posix.dirname(callerFile);
    const joined = posix.normalize(posix.join(dir, importText));
    return appendTsExtension(joined);
  }
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "@/"
      if (importText.startsWith(prefix)) {
        const suffix = importText.slice(prefix.length);
        const target = targets[0]?.replace("/*", `/${suffix}`);
        if (!target) return null;
        return appendTsExtension(
          posix.normalize(posix.join(options.baseUrl, target)),
        );
      }
    } else if (pattern === importText) {
      const target = targets[0];
      if (!target) return null;
      return appendTsExtension(
        posix.normalize(posix.join(options.baseUrl, target)),
      );
    }
  }
  if (BARE_SPECIFIER.test(importText)) return null;
  return null;
}

function appendTsExtension(path: string): string {
  if (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".js") ||
    path.endsWith(".jsx")
  )
    return path;
  return `${path}.ts`;
}
```

- [ ] **Step 3: Run mapper test, expect PASS**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.test.ts
```

- [ ] **Step 4: Write the failing resolver test**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.test.ts
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
} from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("TSCallResolver", () => {
  it("resolves Foo.bar() via the imports list", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      {
        symbolId: "Foo.bar",
        fqName: "Foo.bar",
        shortName: "bar",
        relPath: "src/foo.ts",
        scope: ["Foo"],
      },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const call: CallRef = {
      callText: "Foo.bar()",
      receiver: "Foo",
      member: "bar",
      startLine: 5,
    };
    const ctx: CallContext = {
      callerFile: "src/main.ts",
      callerScope: [],
      imports: [{ importText: "./foo", startLine: 1 }],
      symbolTable,
    };
    const result = resolver.resolve(call, ctx);
    expect(result).toEqual({
      targetRelPath: "src/foo.ts",
      targetSymbolId: "Foo.bar",
    });
  });

  it("returns null when symbol is not in the table", () => {
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "Zzz.gone()", receiver: "Zzz", member: "gone", startLine: 1 },
      {
        callerFile: "src/a.ts",
        callerScope: [],
        imports: [],
        symbolTable: new InMemoryGlobalSymbolTable(),
      },
    );
    expect(result).toBeNull();
  });

  it("falls back to short-name lookup when no import matches", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/util.ts", [
      {
        symbolId: "helper",
        fqName: "helper",
        shortName: "helper",
        relPath: "src/util.ts",
        scope: [],
      },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const result = resolver.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      { callerFile: "src/main.ts", callerScope: [], imports: [], symbolTable },
    );
    expect(result).toEqual({
      targetRelPath: "src/util.ts",
      targetSymbolId: "helper",
    });
  });
});
```

- [ ] **Step 5: Implement `ts-resolver.ts`**

```typescript
// src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.ts
import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";
  constructor(private readonly tsOptions: TsCompilerOptions) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) =>
        importMatchesReceiver(imp.importText, call.receiver as string),
      );
      if (match) {
        const targetFile = mapImportToFile(
          match.importText,
          ctx.callerFile,
          this.tsOptions,
        );
        if (targetFile) {
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath === targetFile);
          const target = candidates[0];
          if (target)
            return {
              targetRelPath: target.relPath,
              targetSymbolId: target.symbolId,
            };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return {
        targetRelPath: fallback[0].relPath,
        targetSymbolId: fallback[0].symbolId,
      };
    }
    return null;
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.toLowerCase() === receiver.toLowerCase();
}
```

- [ ] **Step 6: Implement `ts-config-loader.ts`**

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TsCompilerOptions } from "./ts-path-mapper.js";

export function loadTsConfig(repoRoot: string): TsCompilerOptions {
  const path = join(repoRoot, "tsconfig.json");
  if (!existsSync(path)) return { baseUrl: ".", paths: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const co = parsed.compilerOptions ?? {};
    return { baseUrl: co.baseUrl ?? ".", paths: co.paths ?? {} };
  } catch {
    return { baseUrl: ".", paths: {} };
  }
}
```

- [ ] **Step 7: Barrels**

```typescript
// src/core/domains/trajectory/codegraph/symbols/resolvers/ts/index.ts
export { TSCallResolver } from "./ts-resolver.js";
export { loadTsConfig } from "./ts-config-loader.js";
export { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";
```

```typescript
// src/core/domains/trajectory/codegraph/symbols/resolvers/base.ts
export type { CallResolver } from "../../../../contracts/types/codegraph.js";
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/resolvers/
```

Expected: PASS — 7 tests green.

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/resolvers tests/core/domains/trajectory/codegraph/symbols/resolvers
git commit -m "feat(codegraph): add TypeScript CallResolver with tsconfig path mapping"
```

---

## Task 7: `CodegraphEnrichmentProvider`

**Description:** `EnrichmentProvider` implementation for the codegraph symbols
sub-graph. Implements both ingest-side (`asExtractionSink`, buffer-and-flush on
`finish`, write to `GraphDbClient`) and query-side (`buildFileSignals` reads
fanIn/fanOut/instability/isHub/isLeaf; `buildChunkSignals` reads
calledByCount/callSiteCount).

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/payload-signals.ts`
- Create: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`

**Beads:** depends on T2, T3, T5, T6. Blocks T8, T9.

- [ ] **Step 1: Author payload-signal descriptors**

```typescript
// src/core/domains/trajectory/codegraph/symbols/payload-signals.ts
import type { PayloadSignalDescriptor } from "../../../../contracts/types/trajectory.js";

export const CODEGRAPH_SYMBOLS_FILE_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "codegraph.file.fanIn",
    type: "number",
    description: "Number of files importing this file",
  },
  {
    key: "codegraph.file.fanOut",
    type: "number",
    description: "Number of files this file imports",
  },
  {
    key: "codegraph.file.instability",
    type: "number",
    description: "Martin instability = fanOut / (fanIn + fanOut)",
  },
  {
    key: "codegraph.file.isHub",
    type: "boolean",
    description: "True when fanIn exceeds collection p95",
  },
  {
    key: "codegraph.file.isLeaf",
    type: "boolean",
    description: "True when fanOut == 0",
  },
];

export const CODEGRAPH_SYMBOLS_CHUNK_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "codegraph.chunk.calledByCount",
    type: "number",
    description: "Number of distinct call sites invoking this symbol",
  },
  {
    key: "codegraph.chunk.callSiteCount",
    type: "number",
    description: "Number of outgoing calls from this symbol",
  },
];
```

- [ ] **Step 2: Write the failing provider test**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const MIG_DIR = resolve(
  __dirname,
  "../../../../../../src/core/infra/migration/database/migrations",
);

describe("CodegraphEnrichmentProvider", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([
        ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
      ]),
    });
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes the correct provider key and signal descriptors", () => {
    expect(provider.key).toBe("codegraph.symbols");
    expect(provider.signals.map((s) => s.key)).toContain(
      "codegraph.file.fanIn",
    );
    expect(provider.signals.map((s) => s.key)).toContain(
      "codegraph.chunk.callSiteCount",
    );
  });

  it("sink → finish → graphDb populated with file + method edges", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [
            {
              callText: "Foo.bar()",
              receiver: "Foo",
              member: "bar",
              startLine: 4,
            },
          ],
        },
      ],
      fileScope: [],
    });
    await sink.finish();
    expect(await client.getFanIn("src/foo.ts")).toBe(1);
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getCalledByCount("Foo.bar")).toBe(1);
  });

  it("buildFileSignals returns fanIn/fanOut/instability/isLeaf based on graph state", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/leaf.ts",
      language: "typescript",
      imports: [],
      chunks: [],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./leaf", startLine: 1 }],
      chunks: [],
      fileScope: [],
    });
    await sink.finish();
    const overlays = await provider.buildFileSignals("/", {
      paths: ["src/leaf.ts", "src/main.ts"],
    });
    const leafOverlay = overlays.get("src/leaf.ts");
    expect(leafOverlay?.["codegraph.file.fanIn"]).toBe(1);
    expect(leafOverlay?.["codegraph.file.isLeaf"]).toBe(true);
    const mainOverlay = overlays.get("src/main.ts");
    expect(mainOverlay?.["codegraph.file.fanOut"]).toBe(1);
    expect(mainOverlay?.["codegraph.file.instability"]).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 3: Implement `provider.ts`**

```typescript
// src/core/domains/trajectory/codegraph/symbols/provider.ts
import type {
  CallResolver,
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
} from "../../../../contracts/types/codegraph.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOverlay,
  FilterDescriptor,
} from "../../../../contracts/types/provider.js";
import type {
  DerivedSignalDescriptor,
  RerankPreset,
} from "../../../../contracts/types/reranker.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "./payload-signals.js";

export interface CodegraphProviderDeps {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
  resolvers: Map<string, CallResolver>;
  derivedSignals?: DerivedSignalDescriptor[]; // wired from T8
  presets?: RerankPreset[]; // wired from T8
}

export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = [
    ...CODEGRAPH_SYMBOLS_FILE_SIGNALS,
    ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  ];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[] = [];
  readonly presets: RerankPreset[];

  private readonly buffer: FileExtraction[] = [];

  constructor(private readonly deps: CodegraphProviderDeps) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
  }

  resolveRoot(absolutePath: string): string {
    return absolutePath;
  }

  asExtractionSink(): ExtractionSink {
    return {
      write: async (extraction) => {
        this.deps.symbolTable.upsertFile(
          extraction.relPath,
          extraction.chunks.map((c) => ({
            symbolId: c.symbolId,
            fqName: c.symbolId,
            shortName: lastSegment(c.symbolId),
            relPath: extraction.relPath,
            scope: c.scope,
          })),
        );
        this.buffer.push(extraction);
      },
      finish: async () => {
        for (const extraction of this.buffer) {
          const edges = this.resolveExtraction(extraction);
          await this.deps.graphDb.upsertFile(
            { relPath: extraction.relPath, language: extraction.language },
            edges,
          );
        }
        this.buffer.length = 0;
      },
    };
  }

  async buildFileSignals(
    _root: string,
    options?: { paths?: string[] },
  ): Promise<Map<string, FileSignalOverlay>> {
    const paths = options?.paths ?? [];
    const result = new Map<string, FileSignalOverlay>();
    for (const relPath of paths) {
      const fanIn = await this.deps.graphDb.getFanIn(relPath);
      const fanOut = await this.deps.graphDb.getFanOut(relPath);
      const denom = fanIn + fanOut;
      result.set(relPath, {
        "codegraph.file.fanIn": fanIn,
        "codegraph.file.fanOut": fanOut,
        "codegraph.file.instability": denom === 0 ? 0 : fanOut / denom,
        "codegraph.file.isHub": false, // p95 wiring in T8 derived signal; payload field stays stable here
        "codegraph.file.isLeaf": fanOut === 0 && fanIn > 0,
      });
    }
    return result;
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    _options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const [relPath, entries] of chunkMap) {
      const perChunk = new Map<string, ChunkSignalOverlay>();
      for (const entry of entries) {
        const symbolId = (entry as { symbolId?: string }).symbolId;
        if (!symbolId) continue;
        const calledByCount =
          await this.deps.graphDb.getCalledByCount(symbolId);
        const callSiteCount =
          await this.deps.graphDb.getCallSiteCount(symbolId);
        const chunkKey =
          (entry as { id?: string; chunkId?: string }).id ??
          (entry as { chunkId?: string }).chunkId ??
          symbolId;
        perChunk.set(chunkKey, {
          "codegraph.chunk.calledByCount": calledByCount,
          "codegraph.chunk.callSiteCount": callSiteCount,
        });
      }
      out.set(relPath, perChunk);
    }
    return out;
  }

  private resolveExtraction(extraction: FileExtraction): GraphEdges {
    const resolver = this.deps.resolvers.get(extraction.language);
    const fileEdges: GraphEdges["fileEdges"] = [];
    const methodEdges: GraphEdges["methodEdges"] = [];
    if (!resolver) return { fileEdges, methodEdges };

    // File edges from imports.
    for (const imp of extraction.imports) {
      const target = resolver.resolve(
        {
          callText: imp.importText,
          receiver: lastSegment(imp.importText),
          member: lastSegment(imp.importText),
          startLine: imp.startLine,
        },
        {
          callerFile: extraction.relPath,
          callerScope: extraction.fileScope,
          imports: extraction.imports,
          symbolTable: this.deps.symbolTable,
        },
      );
      if (target)
        fileEdges.push({
          targetRelPath: target.targetRelPath,
          importText: imp.importText,
        });
    }

    // Method edges from calls.
    for (const chunk of extraction.chunks) {
      for (const call of chunk.calls) {
        const target = resolver.resolve(call, {
          callerFile: extraction.relPath,
          callerScope: chunk.scope,
          imports: extraction.imports,
          symbolTable: this.deps.symbolTable,
        });
        if (!target) continue;
        methodEdges.push({
          sourceSymbolId: chunk.symbolId,
          targetSymbolId: target.targetSymbolId,
          targetRelPath: target.targetRelPath,
          callExpression: call.callText,
        });
      }
    }

    return { fileEdges, methodEdges };
  }
}

function lastSegment(name: string): string {
  const idx = Math.max(name.lastIndexOf("."), name.lastIndexOf("/"));
  return idx === -1 ? name : name.slice(idx + 1);
}
```

- [ ] **Step 4: Run provider tests, expect PASS**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/payload-signals.ts src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
git commit -m "feat(codegraph): add CodegraphEnrichmentProvider with sink + file/chunk signals"
```

---

## Task 8: Derived signals + `blastRadius` preset

**Description:** Seven derived signals normalising raw payload values for the
reranker, plus a `blastRadius` preset that combines them with similarity +
churn.

**Files:**

- Create:
  `src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.ts`
- Create: `.../fan-out.ts`, `.../instability.ts`, `.../is-hub.ts`,
  `.../is-leaf.ts`, `.../called-by-count.ts`, `.../call-site-count.ts`
- Create: `.../derived-signals/index.ts`
- Create:
  `src/core/domains/trajectory/codegraph/symbols/rerank/presets/blast-radius.ts`
- Create: `.../presets/index.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.test.ts`

**Beads:** depends on T7, blocks T10.

- [ ] **Step 1: Reference template**

`src/core/domains/trajectory/static/rerank/derived-signals/imports.ts` —
canonical shape (`name`, `description`, `sources`, `defaultBound`, `extract`).

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.test.ts
import { describe, expect, it } from "vitest";

import { FanInSignal } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.js";

describe("FanInSignal", () => {
  it("normalizes raw codegraph.file.fanIn against defaultBound", () => {
    const sig = new FanInSignal();
    expect(
      sig.extract(
        { "codegraph.file.fanIn": 10 },
        { bounds: { "file.fanIn": 20 } },
      ),
    ).toBeCloseTo(0.5, 5);
  });
  it("returns 0 for missing values", () => {
    expect(new FanInSignal().extract({}, {})).toBe(0);
  });
});
```

```typescript
// tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.test.ts
import { describe, expect, it } from "vitest";

import { InstabilitySignal } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.js";

describe("InstabilitySignal", () => {
  it("passes through raw instability value clamped to [0,1]", () => {
    const sig = new InstabilitySignal();
    expect(sig.extract({ "codegraph.file.instability": 0.42 }, {})).toBe(0.42);
    expect(sig.extract({ "codegraph.file.instability": 1.5 }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.instability": -0.1 }, {})).toBe(0);
  });
});
```

```typescript
// tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.test.ts
import { describe, expect, it } from "vitest";

import { IsHubSignal } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.js";

describe("IsHubSignal", () => {
  it("returns 1 when codegraph.file.isHub is true", () => {
    const sig = new IsHubSignal();
    expect(sig.extract({ "codegraph.file.isHub": true }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.isHub": false }, {})).toBe(0);
  });
});
```

- [ ] **Step 3: Implement each derived signal**

```typescript
// fan-in.ts
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../../infra/signal-utils.js";

export class FanInSignal implements DerivedSignalDescriptor {
  readonly name = "fanIn";
  readonly description = "Normalized number of files importing this file";
  readonly sources = ["codegraph.file.fanIn"];
  readonly defaultBound = 20;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.file.fanIn"] ?? 0);
    const bound = ctx?.bounds?.["file.fanIn"] ?? this.defaultBound;
    return normalize(v, bound);
  }
}
```

Mirror for `fan-out.ts`, `called-by-count.ts`, `call-site-count.ts` — adjust
key, sources, defaultBound (~20 for fanOut/fanIn, ~30 for callSiteCount, ~40 for
calledByCount).

```typescript
// instability.ts — pass-through clamp
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";

export class InstabilitySignal implements DerivedSignalDescriptor {
  readonly name = "instability";
  readonly description =
    "Martin instability ratio (already normalized to [0,1])";
  readonly sources = ["codegraph.file.instability"];
  readonly defaultBound = 1;
  extract(raw: Record<string, unknown>, _ctx?: ExtractContext): number {
    const v = Number(raw["codegraph.file.instability"] ?? 0);
    if (Number.isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
}
```

```typescript
// is-hub.ts
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";

export class IsHubSignal implements DerivedSignalDescriptor {
  readonly name = "isHub";
  readonly description = "1 when file is a hub (fanIn > collection p95)";
  readonly sources = ["codegraph.file.isHub"];
  readonly defaultBound = 1;
  extract(raw: Record<string, unknown>, _ctx?: ExtractContext): number {
    return raw["codegraph.file.isHub"] === true ? 1 : 0;
  }
}
```

Mirror `is-leaf.ts` reading `codegraph.file.isLeaf`.

- [ ] **Step 4: Barrel `derived-signals/index.ts`**

```typescript
import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import { CallSiteCountSignal } from "./call-site-count.js";
import { CalledByCountSignal } from "./called-by-count.js";
import { FanInSignal } from "./fan-in.js";
import { FanOutSignal } from "./fan-out.js";
import { InstabilitySignal } from "./instability.js";
import { IsHubSignal } from "./is-hub.js";
import { IsLeafSignal } from "./is-leaf.js";

export const CODEGRAPH_SYMBOLS_DERIVED_SIGNALS: DerivedSignalDescriptor[] = [
  new FanInSignal(),
  new FanOutSignal(),
  new InstabilitySignal(),
  new IsHubSignal(),
  new IsLeafSignal(),
  new CalledByCountSignal(),
  new CallSiteCountSignal(),
];

export {
  FanInSignal,
  FanOutSignal,
  InstabilitySignal,
  IsHubSignal,
  IsLeafSignal,
  CalledByCountSignal,
  CallSiteCountSignal,
};
```

- [ ] **Step 5: Implement `blast-radius.ts` preset**

```typescript
// src/core/domains/trajectory/codegraph/symbols/rerank/presets/blast-radius.ts
import type {
  OverlayMask,
  RerankPreset,
} from "../../../../../../contracts/types/reranker.js";

export class BlastRadiusPreset implements RerankPreset {
  readonly name = "blastRadius";
  readonly description =
    "Rank by blast radius — files imported by many others ranked higher, similarity stays modest";
  readonly tools: string[] = [
    "semantic_search",
    "hybrid_search",
    "rank_chunks",
  ];
  readonly weights = {
    similarity: 0.25,
    fanIn: 0.25,
    instability: 0.15,
    isHub: 0.15,
    churn: 0.1,
    calledByCount: 0.1,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["fanIn", "fanOut", "instability", "isHub", "calledByCount"],
    raw: {
      file: [
        "codegraph.file.fanIn",
        "codegraph.file.fanOut",
        "codegraph.file.instability",
        "codegraph.file.isHub",
      ],
    },
  };
}
```

- [ ] **Step 6: Barrel `presets/index.ts`**

```typescript
import type { RerankPreset } from "../../../../../../contracts/types/reranker.js";
import { BlastRadiusPreset } from "./blast-radius.js";

export { BlastRadiusPreset };
export const CODEGRAPH_SYMBOLS_PRESETS: RerankPreset[] = [
  new BlastRadiusPreset(),
];
```

- [ ] **Step 7: Run tests, expect PASS**

```bash
npx vitest run tests/core/domains/trajectory/codegraph/symbols/rerank/
```

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/rerank tests/core/domains/trajectory/codegraph/symbols/rerank
git commit -m "feat(codegraph): add 7 derived signals and blastRadius preset"
```

---

## Task 9: `SymbolsTrajectory` + L1 family factory

**Description:** Wraps the codegraph symbols provider + signals + presets in a
single `Trajectory` instance, plus the L1 `createCodegraphTrajectories(deps)`
factory that returns the array of L2 trajectories. `TrajectoryRegistry`
registers each L2 directly — no L1 entry, no contract change.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/index.ts`
- Create: `src/core/domains/trajectory/codegraph/symbols/index.ts`

**Beads:** depends on T7, T8.

- [ ] **Step 1: Implement `symbols/index.ts`**

```typescript
// src/core/domains/trajectory/codegraph/symbols/index.ts
import type { Trajectory } from "../../../../contracts/types/trajectory.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "./payload-signals.js";
import {
  CodegraphEnrichmentProvider,
  type CodegraphProviderDeps,
} from "./provider.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "./rerank/derived-signals/index.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "./rerank/presets/index.js";

export interface SymbolsTrajectoryDeps extends CodegraphProviderDeps {}

export function createSymbolsTrajectory(
  deps: SymbolsTrajectoryDeps,
): Trajectory {
  const provider = new CodegraphEnrichmentProvider({
    ...deps,
    derivedSignals: CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    presets: CODEGRAPH_SYMBOLS_PRESETS,
  });
  return {
    key: "codegraph.symbols",
    name: "CodegraphSymbols",
    description: "Symbol-level dependency graph and metrics (Tier 1)",
    payloadSignals: [
      ...CODEGRAPH_SYMBOLS_FILE_SIGNALS,
      ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
    ],
    derivedSignals: CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    filters: [],
    presets: CODEGRAPH_SYMBOLS_PRESETS,
    enrichment: provider,
  };
}

export { CodegraphEnrichmentProvider };
```

- [ ] **Step 2: Implement `codegraph/index.ts` factory**

```typescript
// src/core/domains/trajectory/codegraph/index.ts
import type {
  CallResolver,
  GlobalSymbolTable,
  GraphDbClient,
} from "../../../contracts/types/codegraph.js";
import type { Trajectory } from "../../../contracts/types/trajectory.js";
import { createSymbolsTrajectory } from "./symbols/index.js";

export interface CodegraphDeps {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
  resolvers: Map<string, CallResolver>;
}

/**

 * L1 codegraph family factory. Slice 1 returns SymbolsTrajectory only.
 * Slice 5+ appends additional L2 trajectories (TemporalTrajectory, …).

 */
export function createCodegraphTrajectories(deps: CodegraphDeps): Trajectory[] {
  return [createSymbolsTrajectory(deps)];
}

export { createSymbolsTrajectory } from "./symbols/index.js";
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/trajectory/codegraph
git commit -m "feat(codegraph): add SymbolsTrajectory and L1 family factory"
```

---

## Task 10: GraphFacade + MCP tools + composition + bootstrap + drift (integration Task)

**Description:** Final integration. Adds `GraphFacade` (thin facade per
facade-discipline rule). Wires `App` interface, `composition.ts`,
`bootstrap/factory.ts`, schema-drift, and registers `codegraph-tools.ts` in
`mcp/tools/index.ts`. **`src/core/api/public/app.ts` is DEEP-SILO (Arthur
100%)** — commit MUST include `Why:` line per `.claude/rules/silo-pairing.md`.

**Files:**

- Create: `src/core/api/public/dto/graph.ts`
- Create: `src/core/api/internal/facades/graph-facade.ts`
- Create: `src/mcp/tools/codegraph.ts`
- Modify: `src/core/api/public/app.ts` (add `getCallers`, `getCallees` to `App`
  and `AppDeps.graphFacade`)
- Modify: `src/core/api/public/dto/index.ts` (re-export graph DTOs)
- Modify: `src/core/api/internal/composition.ts` (call
  `createCodegraphTrajectories`, register each L2; pass GraphDbClient through)
- Modify: `src/core/bootstrap/factory.ts` (construct DuckDbGraphClient + run
  migrations)
- Modify: `src/core/infra/schema-drift-monitor.ts` (add `checkCodegraphBackfill`
  method)
- Modify: `src/mcp/tools/index.ts` (call `registerCodegraphTools`)
- Test: `tests/core/api/internal/facades/graph-facade.test.ts`
- Test: `tests/mcp/tools/codegraph.test.ts`
- Test: `tests/integration/codegraph-vertical-slice.test.ts`

**Beads:** depends on T3, T8, T9. Closes Slice 1. Labels: `api`, `architecture`.

- [ ] **Step 1: Author DTOs**

```typescript
// src/core/api/public/dto/graph.ts
import type { RelPath, SymbolId } from "../../../contracts/types/codegraph.js";

export interface GetCallersRequest {
  path: string;
  symbolId: SymbolId;
  limit?: number;
}

export interface CallerResult {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
}

export interface GetCallersResponse {
  callers: CallerResult[];
}

export interface GetCalleesRequest {
  path: string;
  symbolId: SymbolId;
  limit?: number;
}

export interface CalleeResult {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
}

export interface GetCalleesResponse {
  callees: CalleeResult[];
}
```

- [ ] **Step 2: Write the failing facade test**

```typescript
// tests/core/api/internal/facades/graph-facade.test.ts
import { describe, expect, it, vi } from "vitest";

import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";

describe("GraphFacade", () => {
  it("getCallers delegates to GraphDbClient and shapes response", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([
        {
          sourceSymbolId: "A.f",
          sourceRelPath: "src/a.ts",
          callExpression: "B.x()",
        },
        {
          sourceSymbolId: "C.g",
          sourceRelPath: "src/c.ts",
          callExpression: "B.x()",
        },
      ]),
      getCallees: vi.fn(),
    } as never;
    const facade = new GraphFacade({ graphDb });
    const response = await facade.getCallers({
      path: "/proj",
      symbolId: "B.x",
      limit: 50,
    });
    expect(graphDb.getCallers).toHaveBeenCalledWith("B.x");
    expect(response.callers).toHaveLength(2);
  });

  it("getCallers honors limit", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          sourceSymbolId: `A${i}.f`,
          sourceRelPath: `src/a${i}.ts`,
          callExpression: "B.x()",
        })),
      ),
      getCallees: vi.fn(),
    } as never;
    const facade = new GraphFacade({ graphDb });
    const response = await facade.getCallers({
      path: "/proj",
      symbolId: "B.x",
      limit: 3,
    });
    expect(response.callers).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Implement `graph-facade.ts`**

```typescript
// src/core/api/internal/facades/graph-facade.ts
import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import type {
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
} from "../../public/dto/graph.js";

export interface GraphFacadeDeps {
  graphDb: GraphDbClient;
}

export class GraphFacade {
  constructor(private readonly deps: GraphFacadeDeps) {}

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    const edges = await this.deps.graphDb.getCallers(req.symbolId);
    return { callers: edges.slice(0, req.limit ?? 50) };
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    const edges = await this.deps.graphDb.getCallees(req.symbolId);
    return { callees: edges.slice(0, req.limit ?? 50) };
  }
}
```

When result shaping (attaching `ChunkPreview`) grows past 20 lines, extract into
a `GraphOps` class per facade-discipline rule. For Slice 1 the body is small
enough to live in the facade.

- [ ] **Step 4: Wire `App` interface (DEEP-SILO file — Why: in commit)**

In `src/core/api/public/app.ts`:

1. Import DTOs into the existing `import type { ... } from "./dto/index.js";`
   block:

   ```typescript
   GetCallersRequest, GetCallersResponse, GetCalleesRequest, GetCalleesResponse,
   ```

2. Import `GraphFacade`:

   ```typescript
   import type { GraphFacade } from "../internal/facades/graph-facade.js";
   ```

3. Add to `App` interface:

   ```typescript
   getCallers: (request: GetCallersRequest) => Promise<GetCallersResponse>;
   getCallees: (request: GetCalleesRequest) => Promise<GetCalleesResponse>;
   ```

4. Add to `AppDeps`:

   ```typescript
   graphFacade: GraphFacade;
   ```

5. Update `wireFacades` return type and body:

   ```typescript
   function wireFacades(deps: AppDeps): {
     explore: ExploreFacade;
     ingest: IngestFacade;
     graph: GraphFacade;
   } {
     return {
       explore: deps.explore,
       ingest: deps.ingest,
       graph: deps.graphFacade,
     };
   }
   ```

6. In `createApp`'s returned object:

   ```typescript
   getCallers: async (req) => facades.graph.getCallers(req),
   getCallees: async (req) => facades.graph.getCallees(req),
   ```

- [ ] **Step 5: Update DTO barrel**

In `src/core/api/public/dto/index.ts`, add:

```typescript
export type * from "./graph.js";
```

- [ ] **Step 6: Wire composition**

In `src/core/api/internal/composition.ts`:

```typescript
import {
  createCodegraphTrajectories,
  type CodegraphDeps,
} from "../../domains/trajectory/codegraph/index.js";

export function createComposition(options?: {
  codegraph?: CodegraphDeps;
}): CompositionResult {
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory());
  if (options?.codegraph) {
    for (const trajectory of createCodegraphTrajectories(options.codegraph))
      registry.register(trajectory);
  }
  // …rest of body unchanged
}
```

- [ ] **Step 7: Wire bootstrap**

In `src/core/bootstrap/factory.ts` (the function that constructs the App):

```typescript
import { resolve } from "node:path";

import { DuckDbGraphClient } from "../core/adapters/duckdb/index.js";
import { GraphFacade } from "../core/api/internal/facades/graph-facade.js";
import {
  loadTsConfig,
  TSCallResolver,
} from "../core/domains/trajectory/codegraph/symbols/resolvers/ts/index.js";
import { InMemoryGlobalSymbolTable } from "../core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../core/infra/migration/database/runner.js";

let graphFacade: GraphFacade | undefined;
let composition: CompositionResult;
if (!config.codegraphDisabled) {
  const dbPath = resolve(
    config.dataDir,
    `${config.collectionName}.codegraph.duckdb`,
  );
  const graphDb = new DuckDbGraphClient({ path: dbPath });
  await graphDb.init();
  await runMigrations(
    graphDb,
    resolve(import.meta.dirname, "../core/infra/migration/database/migrations"),
  );
  const tsOptions = loadTsConfig(config.repoRoot);
  composition = createComposition({
    codegraph: {
      graphDb,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([["typescript", new TSCallResolver(tsOptions)]]),
    },
  });
  graphFacade = new GraphFacade({ graphDb });
} else {
  composition = createComposition();
  graphFacade = new GraphFacade({ graphDb: noopGraphDbClient() });
}
```

If `config.codegraphDisabled` field does not exist, add it to the config schema
with default `false`, sourced from env `CODEGRAPH_DISABLED`.
`noopGraphDbClient()` is a small in-file helper returning empty results for all
methods — used when codegraph is disabled but the App still needs a
`graphFacade` instance.

- [ ] **Step 8: Add codegraph drift check to `SchemaDriftMonitor`**

In `src/core/infra/schema-drift-monitor.ts`, add a new method:

```typescript
async checkCodegraphBackfill(codegraphEnabled: boolean, graphDb?: GraphDbClient): Promise<string | null> {
  if (this._warned) return null;
  if (!codegraphEnabled || !graphDb) return null;
  const hasData = await graphDb.hasData();
  if (hasData) return null;
  this._warned = true;
  return "Codegraph is enabled but graph database is empty. Run index_codebase with forceReindex=true to populate it.";
}
```

Add `GraphDbClient` import at the top. Caller site (in `App.checkSchemaDrift` or
`IngestOps.run`) invokes this when relevant.

- [ ] **Step 9: Author MCP tools**

```typescript
// src/mcp/tools/codegraph.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../core/api/index.js";
import type { createRegisterTool } from "../middleware/error-handler.js";

const GetCallersSchema = z.object({
  path: z.string().describe("Project path"),
  symbolId: z.string().describe("Target symbol id (e.g. Foo.bar)"),
  limit: z.number().int().positive().max(500).optional(),
});

const GetCalleesSchema = z.object({
  path: z.string().describe("Project path"),
  symbolId: z.string().describe("Source symbol id"),
  limit: z.number().int().positive().max(500).optional(),
});

export function registerCodegraphTools(
  server: McpServer,
  deps: { app: App; register: ReturnType<typeof createRegisterTool> },
): void {
  deps.register(server, {
    name: "get_callers",
    description:
      "Return symbols that invoke the given symbolId. Backed by the codegraph DuckDB.",
    schema: GetCallersSchema,
    handler: async (input) => deps.app.getCallers(input),
  });
  deps.register(server, {
    name: "get_callees",
    description:
      "Return symbols invoked by the given symbolId. Backed by the codegraph DuckDB.",
    schema: GetCalleesSchema,
    handler: async (input) => deps.app.getCallees(input),
  });
}
```

Adapt to the actual `register` signature found in
`src/mcp/middleware/error-handler.ts` / existing tools (see
`src/mcp/tools/code.ts` for canonical example).

- [ ] **Step 10: Register in `src/mcp/tools/index.ts`**

```typescript
import { registerCodegraphTools } from "./codegraph.js";

// inside registerAllTools, after registerCodeTools:
registerCodegraphTools(server, { app: deps.app, register });
```

- [ ] **Step 11: Write MCP tool test**

```typescript
// tests/mcp/tools/codegraph.test.ts
import { describe, expect, it, vi } from "vitest";

import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

describe("registerCodegraphTools", () => {
  it("registers get_callers and get_callees on the server", () => {
    const register = vi.fn();
    const server = {} as never;
    const app = { getCallers: vi.fn(), getCallees: vi.fn() } as never;
    registerCodegraphTools(server, { app, register });
    const names = register.mock.calls
      .map(([, descriptor]) => descriptor.name)
      .sort();
    expect(names).toEqual(["get_callees", "get_callers"]);
  });
});
```

- [ ] **Step 12: Write the integration test**

```typescript
// tests/integration/codegraph-vertical-slice.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/index.js";
import { createCodegraphTrajectories } from "../../src/core/domains/trajectory/codegraph/index.js";
import { TSCallResolver } from "../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/index.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../src/core/infra/migration/database/runner.js";

describe("codegraph slice 1 — vertical", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-vert-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
    await runMigrations(
      graphDb,
      resolve(__dirname, "../../src/core/infra/migration/database/migrations"),
    );
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers SymbolsTrajectory and flows extractions to file/chunk signals", async () => {
    const [trajectory] = createCodegraphTrajectories({
      graphDb,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([
        ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
      ]),
    });
    expect(trajectory.key).toBe("codegraph.symbols");
    const provider = trajectory.enrichment;
    expect(provider).toBeDefined();
    const sink = (
      provider as { asExtractionSink: () => unknown }
    ).asExtractionSink() as {
      write: (e: unknown) => Promise<void>;
      finish: () => Promise<void>;
    };
    await sink.write({
      relPath: "src/leaf.ts",
      language: "typescript",
      imports: [],
      chunks: [],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./leaf", startLine: 1 }],
      chunks: [],
      fileScope: [],
    });
    await sink.finish();
    const signals = await provider!.buildFileSignals("/", {
      paths: ["src/leaf.ts", "src/main.ts"],
    });
    expect(signals.get("src/leaf.ts")?.["codegraph.file.fanIn"]).toBe(1);
    expect(signals.get("src/main.ts")?.["codegraph.file.fanOut"]).toBe(1);
  });
});
```

- [ ] **Step 13: Run everything**

```bash
npm run build && npx vitest run
```

Expected: all tests pass, no TS errors.

- [ ] **Step 14: Commit — INCLUDE `Why:` LINE PER SILO-PAIRING RULE**

```bash
git add src/core/api src/core/bootstrap src/core/infra/schema-drift-monitor.ts src/mcp/tools tests/core/api tests/mcp/tools tests/integration/codegraph-vertical-slice.test.ts
git commit -m "feat(api)!: integrate codegraph symbols slice 1 — App, composition, MCP tools, drift check

Why: app.ts is a deep-silo file (Arthur Korochansky 100% blame). The
codegraph integration is additive (new App methods getCallers/getCallees,
new AppDeps.graphFacade) and follows the existing flat App-method pattern
rather than the spec's sub-object proposal. Bootstrap gains a DuckDB
client construction step gated on CODEGRAPH_DISABLED; drift monitor adds
a backfill check; composition acquires an L1 factory call. Trade-off:
adds @duckdb/node-api runtime dep — accepted because Slice 4 reuses the
same GraphDbClient interface for PostgreSQL.

BREAKING CHANGE: adds new App methods getCallers/getCallees and new
required @duckdb/node-api dependency. Users on bare embedded Qdrant
without the new dep must disable codegraph via CODEGRAPH_DISABLED=true
until they upgrade."
```

---

## Risks (drawn from tea-rags impact enrichment)

| Risk                        | File(s)                                                      | Source signal                                   | Mitigation                                                                                                               |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Coordinator regression      | `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` | 18 commits / 0d / active #1, #2                 | T5 touches only the injection point — no refactor; full ingest test suite re-run in T5 Step 8.                           |
| Deep-silo edit              | `src/core/api/public/app.ts`                                 | blameDominantAuthorPct 100% (deep-silo)         | T10 commit includes `Why:` body per `.claude/rules/silo-pairing.md`.                                                     |
| Chunker symbolId fallout    | `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`    | 8 commits / 3d / shared (3 authors)             | T4 is its own commit + focused regression test + full chunker suite (T4 Step 7).                                         |
| New runtime dep             | `package.json`                                               | n/a                                             | `@duckdb/node-api` chosen for typed async API; default `CODEGRAPH_DISABLED` flippable to `true` if rollout shows issues. |
| MCP tool registry collision | `src/mcp/tools/index.ts`                                     | 12 commits / 2d / 3 authors (Martin Halder 46%) | T10 adds one `registerCodegraphTools(...)` call — no edit to existing registrations.                                     |

## Out of scope (Slice 2-5)

- `get_dependencies`, `get_dependents`, `find_cycles` MCP tools (Slice 2)
- `transitiveImpact`, `pageRank` derived signals + recursive CTE (Slice 2 —
  betweenness cut 2026-05-21, see Slice 2 plan Task B4)
- `cg_symbols_cycles` table (Slice 2)
- Python, Ruby, Elixir chunker hooks + resolvers (Slice 3)
- Regex-fallback hook for unsupported languages (Slice 3)
- `PostgresGraphClient` (Slice 4)
- `cg_temporal_*` sub-graph + `TemporalTrajectory` (Slice 5)
- Path-tracing + cluster detection (Slice 6 — `tea-rags-mcp-uxsr`)
- Auto background backfill on activation (Slice 2 candidate)
- Removing legacy `imports[]` payload field (separate epic ticket)

If pressure arises to expand scope mid-slice: stop, file a new beads task,
defer.

## Self-Review checklist

- [x] **Spec coverage:** every block in
      `2026-04-25-codegraph-symbols-vertical-slice.md` maps to a Task (T1
      contracts, T2 symbol table, T3 DuckDB + migrations, T4 symbolId fix, T5
      extraction walker, T6 TS resolver, T7 provider + signals, T8 derived
      signals + preset, T9 trajectory + factory, T10 facade + MCP +
      composition + bootstrap + drift).
- [x] **Placeholder scan:** no `TBD`/`TODO`/`implement later`. Code blocks
      complete. The one "investigate at impl time" callout in T4 Step 2 has a
      concrete diagnostic command and defined branches per outcome.
- [x] **Type consistency:** `FileExtraction`, `ImportRef`, `CallRef`,
      `ChunkExtraction`, `CallContext`, `ResolvedTarget`, `GraphDbClient`,
      `GraphEdges`, `GraphFileNode`, `CallerEdge`, `CalleeEdge`,
      `SymbolDefinition`, `RelPath`, `SymbolId` introduced in T1 and used
      identically in T2/T5/T6/T7/T9/T10. `CODEGRAPH_SYMBOLS_FILE_SIGNALS` /
      `..._CHUNK_SIGNALS` / `..._DERIVED_SIGNALS` / `..._PRESETS` consistent
      across T7/T8/T9.
- [x] **Beads sync:** plan instructs creating one beads task per Task (1:1).
      Done as a separate post-plan step.
