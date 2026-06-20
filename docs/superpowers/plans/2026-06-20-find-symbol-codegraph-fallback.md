# find_symbol Codegraph-Aware Fallback (cg_symbols.chunk_id) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. At execution time invoke the
> dinopowers wrappers (`dinopowers:executing-plans`,
> `dinopowers:test-driven-development`) per the session chaining rule.

**Goal:** When the Ruby chunker collapses a small class so an inner method has
no own Qdrant chunk, make `find_symbol("Foo#bar")` return the covering class
chunk by storing each symbol's covering-chunk id on its `cg_symbols` row and
consulting it as a graceful fallback after the Qdrant scroll yields nothing.

**Architecture:** D-store. Add a nullable `cg_symbols.chunk_id` column. Populate
it in the codegraph deferred chunk pass (`buildChunkSignals`) via a store-time
containment join between the walker's per-symbol line map (`chunkSymbolByLine`)
and the ingest chunker's `chunkMap` — codegraph stays DuckDB-only, no
`QdrantManager` threading. `find_symbol`'s `SymbolSearchStrategy` gains an
optional injected `SymbolChunkResolver` (DIP interface in `contracts/`,
implemented by `GraphFacade`, wired in bootstrap). Fallback is a two-hop read:
`symbol_id → chunk_id → qdrant.getPoint(chunkId) → content`. Reader undefined
(codegraph off) or `chunkId` null (stale index) → exactly today's empty result.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), DuckDB (via
`adapters/duckdb`, in-process `DuckDbGraphClient` + daemon-routed
`DaemonGraphDbClient` + `server.ts` dispatch), Qdrant
(`adapters/qdrant/client.ts`), Vitest.

## Global Constraints

- **Spec:**
  `docs/superpowers/specs/2026-06-20-find-symbol-codegraph-fallback-design.md`
  (committed `c0ffad8a`). Every task implements part of its §Components.
- **TDD mandatory** — failing test first, watch it fail, minimal code to green.
  No production code without a failing test.
- **Typed errors only** — never `throw new Error(...)` for user-facing paths;
  use the hierarchy in `contracts/errors.ts`. Programming-invariant violations
  (caller bugs) may use plain `Error` (matches existing `getStore` pool-mode
  guard).
- **symbolId convention** (`.claude/rules/symbolid-convention.md`) — the join
  matches by **line-range containment**, never by re-deriving `#`/`.`; the
  chunker and codegraph already agree on `symbolId`.
- **Domain boundaries** (`.claude/rules/domain-boundaries.md`) —
  `domains/explore` MUST NOT import `api/internal`, `domains/trajectory`, or
  `adapters/duckdb` internals. The reader reaches the strategy only through a
  `contracts/` interface injected via DI. `contracts/` stays pure (no Zod, zero
  `core/` deps).
- **Naming** (`.claude/rules/naming.md`) — domain-qualified names:
  `SymbolChunkResolver`, `SymbolChunkLocation`, `resolveSymbolChunk`,
  `findSymbolChunk`, `updateSymbolChunkIds`.
- **Deep-silo files touched** — `domains/explore/symbol-resolve.ts` (not edited
  here), `domains/explore/strategies/symbol.ts`,
  `api/internal/facades/explore-facade.ts`, `codegraph/symbols/provider.ts`
  carry 100%/EXTREME-churn signals. Every commit touching a deep-silo file
  (`.claude/rules/silo-pairing.md`) needs a `Why:` line. Flag `symbol.ts` +
  `explore-facade.ts` changes for owner (Korochansky) review.
- **Commit scope/types** (`.claude/rules/commit-rules.md`) — `feat(trajectory)`
  / `feat(explore)` for capabilities, `feat(contracts)` for the interface,
  `test(...)` for test-only. Conventional, header ≤100 chars. End every commit
  with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Ephemeral branch** — commit, never push. No merge to main inside this plan.
- **Forward-compat with q383b** — the reader method `resolveSymbolChunk` is the
  seam q383b promotes to primary; do not couple it to the "fallback-only" call
  order beyond the strategy.

---

## File Structure

| File                                                                      | Responsibility                                                                                                      | Create/Modify |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| `src/core/infra/migration/database/migrations/007-cg-symbols-chunk-id.ts` | DDL: `ALTER TABLE cg_symbols ADD COLUMN chunk_id VARCHAR` + `idx_cg_symbols_symbol`                                 | Create        |
| `src/core/infra/migration/database/migrations/index.ts`                   | Register migration 007                                                                                              | Modify        |
| `src/core/contracts/types/codegraph.ts`                                   | `SymbolChunkLocation` type, `SymbolChunkResolver` interface, `GraphDbClient.{updateSymbolChunkIds,findSymbolChunk}` | Modify        |
| `src/core/adapters/duckdb/client.ts`                                      | `DuckDbGraphClient.{updateSymbolChunkIds,findSymbolChunk}` impls                                                    | Modify        |
| `src/core/adapters/duckdb/daemon/client.ts`                               | `DaemonGraphDbClient.{updateSymbolChunkIds,findSymbolChunk}` RPC                                                    | Modify        |
| `src/core/adapters/duckdb/daemon/server.ts`                               | dispatch cases for the two new ops                                                                                  | Modify        |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`               | containment join in `buildChunkSignals` + `computeSymbolChunkIds` helper                                            | Modify        |
| `src/core/api/internal/facades/graph-facade.ts`                           | `resolveSymbolChunk(addr, symbolId)` via `withReadHandle`                                                           | Modify        |
| `src/core/api/internal/ops/explore-ops.ts`                                | thread optional `SymbolChunkResolver` into `buildFindSymbolStrategy`                                                | Modify        |
| `src/core/domains/explore/strategies/symbol.ts`                           | optional reader field + two-hop fallback in `executeExplore`                                                        | Modify        |
| `src/core/api/public/dto/explore.ts`                                      | additive `fromCodegraphFallback?: boolean` on `SearchResult`                                                        | Modify        |
| `src/bootstrap/factory.ts`                                                | adapt `graphFacade` → `SymbolChunkResolver`, thread into `ExploreFacade`                                            | Modify        |
| `src/core/api/internal/facades/explore-facade.ts`                         | pass reader from facade deps to `ExploreOps`                                                                        | Modify        |

---

## Task 1: Schema migration — `cg_symbols.chunk_id` column + symbol index

**Files:**

- Create:
  `src/core/infra/migration/database/migrations/007-cg-symbols-chunk-id.ts`
- Modify: `src/core/infra/migration/database/migrations/index.ts`
- Test: `tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts`

**Interfaces:**

- Consumes: nothing (foundation).
- Produces: a `cg_symbols.chunk_id VARCHAR` nullable column and
  `idx_cg_symbols_symbol` index, applied by `runMigrations` when
  `DuckDbGraphClient.init()` runs. `DATABASE_MIGRATIONS` array gains a 7th
  entry.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";

describe("migration 007 — cg_symbols.chunk_id", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a nullable chunk_id column and a symbol_id index after init", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunkid-"));
    const client = new DuckDbGraphClient(join(dir, "graph.duckdb"));
    await client.init();

    const cols = await client.queryAll<{
      column_name: string;
      is_nullable: string;
    }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'cg_symbols'",
    );
    const chunkId = cols.find((c) => c.column_name === "chunk_id");
    expect(chunkId).toBeDefined();
    expect(chunkId!.is_nullable).toBe("YES");

    const idx = await client.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols'",
    );
    expect(idx.map((r) => r.index_name)).toContain("idx_cg_symbols_symbol");

    await client.close();
  });
});
```

> Note: if `queryAll` is not `public` on `DuckDbGraphClient`, the implementer
> adds a minimal read in the test via `client`'s existing public surface, or
> marks `queryAll` test-visible. Do NOT add a production-only test method —
> prefer querying through an existing public read if one exposes raw SQL;
> otherwise assert indirectly by `updateSymbolChunkIds` round-trip in Task 2 and
> keep Task 1's assertion to column existence via `listAllSymbols` not throwing.
> (Decide at GREEN; the column+index DDL is the deliverable either way.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts`
Expected: FAIL — `chunk_id` column not found (migration 007 doesn't exist yet).

- [ ] **Step 3: Create the migration file**

```typescript
// src/core/infra/migration/database/migrations/007-cg-symbols-chunk-id.ts
/**
 * Adds the covering-chunk reference to each symbol row. `chunk_id` is the
 * `chunk_<hash16>` form (pre-normalizeId) of the tightest Qdrant chunk that
 * contains the symbol's declaration — populated in the codegraph deferred
 * chunk pass via a line-range containment join. Nullable: NULL when a symbol
 * has no covering chunk (excluded file) or the row predates this migration /
 * its backfill. `idx_cg_symbols_symbol` backs the new lookup-by-symbol_id
 * read path (`findSymbolChunk`); pre-existing reads were full-scan only.
 */
export const SQL_007_CG_SYMBOLS_CHUNK_ID = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS chunk_id VARCHAR;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_symbol ON cg_symbols (symbol_id);
`;
```

> `ADD COLUMN IF NOT EXISTS` keeps the migration idempotent across re-runs (the
> runner re-applies the full list on every init). Confirm DuckDB supports
> `IF NOT EXISTS` on `ADD COLUMN` for the pinned version; if not, the runner
> already guards each migration by filename — fall back to bare
> `ADD COLUMN chunk_id VARCHAR` and rely on the runner's applied-set.

- [ ] **Step 4: Register the migration**

```typescript
// src/core/infra/migration/database/migrations/index.ts — add import + array entry
import { SQL_007_CG_SYMBOLS_CHUNK_ID } from "./007-cg-symbols-chunk-id.js";

// ...inside DATABASE_MIGRATIONS, append as the last entry:
  { filename: "007-cg-symbols-chunk-id.sql", sql: SQL_007_CG_SYMBOLS_CHUNK_ID },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/migration/database/migrations/007-cg-symbols-chunk-id.ts \
        src/core/infra/migration/database/migrations/index.ts \
        tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts
git commit -m "feat(trajectory): cg_symbols.chunk_id column + symbol_id index (0rskm)"
```

---

## Task 2: `GraphDbClient` write + read — `updateSymbolChunkIds` / `findSymbolChunk` (in-process)

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (interface +
  `SymbolChunkLocation`)
- Modify: `src/core/adapters/duckdb/client.ts` (`DuckDbGraphClient` impls)
- Test: `tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts` (extend)

**Interfaces:**

- Consumes: Task 1's `chunk_id` column.
- Produces:
  - `interface SymbolChunkLocation { relPath: RelPath; chunkId: string }`
  - `GraphDbClient.updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void>`
    — UPDATE-only; never touches identity columns.
  - `GraphDbClient.findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null>`
    — indexed lookup; returns null when no row OR `chunk_id IS NULL`.

- [ ] **Step 1: Write the failing test (append to the Task 1 file)**

```typescript
import {
  RelPath,
  SymbolId,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("DuckDbGraphClient — chunk_id read/write", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips chunk_id: upsert symbols, backfill chunk_id, find by symbolId", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-rw-"));
    const client = new DuckDbGraphClient(join(dir, "graph.duckdb"));
    await client.init();

    const rel = "app/models/foo.rb" as RelPath;
    await client.upsertSymbols(rel, [
      {
        symbolId: "Foo" as SymbolId,
        fqName: "Foo",
        shortName: "Foo",
        relPath: rel,
        scope: [],
      },
      {
        symbolId: "Foo#bar" as SymbolId,
        fqName: "Foo#bar",
        shortName: "bar",
        relPath: rel,
        scope: ["Foo"],
      },
    ]);

    // Before backfill: no covering chunk → null.
    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toBeNull();

    await client.updateSymbolChunkIds(
      rel,
      new Map([["Foo#bar" as SymbolId, "chunk_abc123def456"]]),
    );

    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toEqual({
      relPath: rel,
      chunkId: "chunk_abc123def456",
    });
    // Symbol with no backfilled chunk_id stays null.
    expect(await client.findSymbolChunk("Foo" as SymbolId)).toBeNull();
    // Unknown symbol → null.
    expect(await client.findSymbolChunk("Nope#x" as SymbolId)).toBeNull();

    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts`
Expected: FAIL — `client.updateSymbolChunkIds is not a function` /
`findSymbolChunk is not a function`.

- [ ] **Step 3: Extend the contract**

```typescript
// src/core/contracts/types/codegraph.ts — add near SymbolDefinition
export interface SymbolChunkLocation {
  relPath: RelPath;
  chunkId: string;
}
```

```typescript
// src/core/contracts/types/codegraph.ts — add to interface GraphDbClient,
// next to upsertSymbols / listAllSymbols (Symbol-table persistence block):

/**
 * Backfill the covering-chunk reference for symbols of one file. UPDATE-only
 * — never rewrites identity columns. Keyed by symbolId; symbols absent from
 * the map keep their prior chunk_id (which a preceding upsertSymbols set to
 * NULL). Written in the codegraph deferred chunk pass once chunk ids exist.
 */
updateSymbolChunkIds: (
  relPath: RelPath,
  chunkIds: ReadonlyMap<SymbolId, string>,
) => Promise<void>;

/**
 * Resolve a symbol to its covering Qdrant chunk. Indexed lookup by
 * symbol_id. Returns null when no row matches OR the row's chunk_id is NULL
 * (symbol exists but no covering chunk was recorded). Used by the
 * find_symbol codegraph fallback (0rskm) and promotable to primary (q383b).
 */
findSymbolChunk: (symbolId: SymbolId) => Promise<SymbolChunkLocation | null>;
```

- [ ] **Step 4: Implement in `DuckDbGraphClient`**

```typescript
// src/core/adapters/duckdb/client.ts — add SymbolChunkLocation to the import
// from contracts/types/codegraph.js, then add these methods near upsertSymbols.

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    if (chunkIds.size === 0) return;
    return this.serialize(async () => {
      // One UPDATE per (symbolId) row; bounded by the file's symbol count.
      // Wrapped in a transaction so a partial failure leaves the file's
      // chunk_id set fully old or fully new — consistent with upsertSymbols.
      await this.exec("BEGIN");
      try {
        for (const [symbolId, chunkId] of chunkIds) {
          await this.run("UPDATE cg_symbols SET chunk_id = ? WHERE rel_path = ? AND symbol_id = ?", [
            chunkId,
            relPath,
            symbolId,
          ]);
        }
        await this.exec("COMMIT");
      } catch (err) {
        await this.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    const rows = await this.queryAll<{ rel_path: string; chunk_id: string | null }>(
      "SELECT rel_path, chunk_id FROM cg_symbols WHERE symbol_id = ? AND chunk_id IS NOT NULL LIMIT 1",
      [symbolId],
    );
    if (rows.length === 0) return null;
    return { relPath: rows[0].rel_path as RelPath, chunkId: rows[0].chunk_id as string };
  }
```

> `this.run` / `this.exec` / `this.queryAll` / `this.serialize` already exist
> (used by `upsertSymbols`, `listAllSymbols`). Match the exact private helper
> names found in `client.ts`. The `WHERE symbol_id = ? AND chunk_id IS NOT NULL`
> bakes the "null chunk_id → no fallback" rule into the query.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc --noEmit
git add src/core/contracts/types/codegraph.ts src/core/adapters/duckdb/client.ts \
        tests/core/adapters/duckdb/cg-symbols-chunk-id.test.ts
git commit -m "feat(contracts): GraphDbClient updateSymbolChunkIds + findSymbolChunk (0rskm)"
```

---

## Task 3: Daemon routing for the two new ops

**Files:**

- Modify: `src/core/adapters/duckdb/daemon/client.ts` (`DaemonGraphDbClient`)
- Modify: `src/core/adapters/duckdb/daemon/server.ts` (dispatch)
- Test: `tests/core/adapters/duckdb/daemon/daemon-graph-client.test.ts` (extend
  existing if present; else create)

**Interfaces:**

- Consumes: Task 2's `GraphDbClient` methods (the daemon delegates to a real
  `DuckDbGraphClient`).
- Produces: `DaemonGraphDbClient.updateSymbolChunkIds` / `findSymbolChunk` that
  satisfy the same interface so `acquireWrite`/`acquireReader` hand back a
  fully-typed client in daemon mode. A `Map` cannot JSON-serialise, so
  `updateSymbolChunkIds` rides the wire as `[symbolId, chunkId][]` entries
  (mirrors `replacePageRanks`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/adapters/duckdb/daemon/daemon-ops-chunk-id.test.ts
import { describe, expect, it, vi } from "vitest";

import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { SymbolId } from "../../../../../src/core/contracts/types/codegraph.js";

describe("DaemonGraphDbClient — chunk_id ops", () => {
  it("serialises updateSymbolChunkIds Map as entries over the wire", async () => {
    const client = new DaemonGraphDbClient(
      /* socket path, collection */ "x",
      "col" as never,
    );
    const call = vi
      .spyOn(
        client as never as {
          call: (op: string, p: unknown) => Promise<unknown>;
        },
        "call",
      )
      .mockResolvedValue(null);

    await client.updateSymbolChunkIds(
      "a.rb" as never,
      new Map([["Foo#bar" as SymbolId, "chunk_x"]]),
    );

    expect(call).toHaveBeenCalledWith("updateSymbolChunkIds", {
      relPath: "a.rb",
      chunkIds: [["Foo#bar", "chunk_x"]],
    });
  });

  it("passes findSymbolChunk result through unchanged", async () => {
    const client = new DaemonGraphDbClient("x", "col" as never);
    vi.spyOn(
      client as never as { call: (op: string, p: unknown) => Promise<unknown> },
      "call",
    ).mockResolvedValue({ relPath: "a.rb", chunkId: "chunk_x" });

    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toEqual({
      relPath: "a.rb",
      chunkId: "chunk_x",
    });
  });
});
```

> Match `DaemonGraphDbClient`'s real constructor signature (socket/collection)
> found in `daemon/client.ts`; adjust the `new DaemonGraphDbClient(...)` args to
> it. The point of the test is the wire shape, not the socket.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/adapters/duckdb/daemon/daemon-ops-chunk-id.test.ts`
Expected: FAIL — methods missing on `DaemonGraphDbClient`.

- [ ] **Step 3: Implement the daemon client methods**

```typescript
// src/core/adapters/duckdb/daemon/client.ts — near upsertSymbols
  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    // Map → entries: structured JSON framing can't carry a Map (mirrors replacePageRanks).
    await this.call("updateSymbolChunkIds", { relPath, chunkIds: [...chunkIds.entries()] });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return (await this.call("findSymbolChunk", { symbolId })) as SymbolChunkLocation | null;
  }
```

> Add `SymbolChunkLocation` to the contracts import in `daemon/client.ts`.

- [ ] **Step 4: Implement the daemon server dispatch**

```typescript
// src/core/adapters/duckdb/daemon/server.ts — add to the switch in dispatch()

      // ── write (near "upsertSymbols") ──
      case "updateSymbolChunkIds": {
        const { graphDb } = await this.pool.acquire(collection);
        // entries → Map (mirrors replacePageRanks rebuild).
        await graphDb.updateSymbolChunkIds(
          p.relPath as RelPath,
          new Map(p.chunkIds as [SymbolId, string][]),
        );
        return null;
      }

      // ── full-proxy read (near "getCallers") ──
      case "findSymbolChunk": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.findSymbolChunk(p.symbolId as SymbolId);
      }
```

> If the daemon op name is a typed union (`DaemonOp`), add
> `"updateSymbolChunkIds"` and `"findSymbolChunk"` to that union wherever it's
> declared (grep the daemon dir for `DaemonOp`).

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/adapters/duckdb/daemon/daemon-ops-chunk-id.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc --noEmit
git add src/core/adapters/duckdb/daemon/client.ts src/core/adapters/duckdb/daemon/server.ts \
        tests/core/adapters/duckdb/daemon/daemon-ops-chunk-id.test.ts
git commit -m "feat(trajectory): daemon routing for chunk_id ops (0rskm)"
```

---

## Task 4: Containment join in `buildChunkSignals` (write side)

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/symbol-chunk-join.test.ts`

**Interfaces:**

- Consumes: Task 2's `GraphDbClient.updateSymbolChunkIds`; the existing
  `chunkSymbolByLine` map
  (`Map<collKey, Map<relPath, Map<startLine, symbolId>>>`) and the
  `chunkMap: Map<relPath, ChunkLookupEntry[]>` parameter of `buildChunkSignals`.
  `ChunkLookupEntry = { chunkId, startLine, endLine, lineRanges? }`.
- Produces: a pure static helper

  `computeSymbolChunkIds(symbolStartLines: ReadonlyMap<SymbolId, number>, entries: readonly ChunkLookupEntry[]): Map<SymbolId, string>`

  selecting per symbol the **tightest covering chunk** (smallest line span whose
  range — or any of its `lineRanges` — contains the symbol's start line).
  `buildChunkSignals` calls it per file and persists via `updateSymbolChunkIds`.

- [ ] **Step 1: Write the failing test (pure helper — no mocks)**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/symbol-chunk-join.test.ts
import { describe, expect, it } from "vitest";

import { SymbolId } from "../../../../../../src/core/contracts/types/codegraph.js";
import { computeSymbolChunkIds } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";

describe("computeSymbolChunkIds — symbol→covering-chunk containment", () => {
  it("collapsed method with no own chunk maps to the containing class chunk", () => {
    // Class Foo chunk spans 1..20; method Foo#bar declared at line 5 has no own chunk.
    const symbols = new Map<SymbolId, number>([
      ["Foo" as SymbolId, 1],
      ["Foo#bar" as SymbolId, 5],
    ]);
    const entries = [{ chunkId: "chunk_cls", startLine: 1, endLine: 20 }];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Foo" as SymbolId)).toBe("chunk_cls");
    expect(out.get("Foo#bar" as SymbolId)).toBe("chunk_cls");
  });

  it("normal method maps to its own (tightest) chunk, not the enclosing class", () => {
    const symbols = new Map<SymbolId, number>([["Foo#bar" as SymbolId, 5]]);
    const entries = [
      { chunkId: "chunk_cls", startLine: 1, endLine: 20 }, // class chunk
      { chunkId: "chunk_bar", startLine: 5, endLine: 9 }, // method's own chunk (tighter)
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Foo#bar" as SymbolId)).toBe("chunk_bar");
  });

  it("#partN split: symbol maps to the part whose range contains its start line", () => {
    const symbols = new Map<SymbolId, number>([["Big#run" as SymbolId, 50]]);
    const entries = [
      { chunkId: "chunk_p1", startLine: 40, endLine: 49 },
      { chunkId: "chunk_p2", startLine: 50, endLine: 70 },
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Big#run" as SymbolId)).toBe("chunk_p2");
  });

  it("uncovered symbol (excluded file region) is absent from the result", () => {
    const symbols = new Map<SymbolId, number>([["Orphan" as SymbolId, 100]]);
    const entries = [{ chunkId: "chunk_a", startLine: 1, endLine: 20 }];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.has("Orphan" as SymbolId)).toBe(false);
  });

  it("honours non-contiguous lineRanges (Ruby body groups) for containment", () => {
    const symbols = new Map<SymbolId, number>([["Mod#m" as SymbolId, 30]]);
    const entries = [
      {
        chunkId: "chunk_grp",
        startLine: 10,
        endLine: 40,
        lineRanges: [
          { start: 10, end: 15 },
          { start: 28, end: 33 },
        ],
      },
      { chunkId: "chunk_wide", startLine: 1, endLine: 50 },
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    // 30 ∈ [28,33] of chunk_grp (span 6 effective) is tighter than chunk_wide (span 49).
    expect(out.get("Mod#m" as SymbolId)).toBe("chunk_grp");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/symbol-chunk-join.test.ts`
Expected: FAIL — `computeSymbolChunkIds` is not exported.

- [ ] **Step 3: Implement the pure helper + wire it into `buildChunkSignals`**

```typescript
// src/core/domains/trajectory/codegraph/symbols/provider.ts — module-scope export

/**
 * Symbol→covering-chunk containment join (0rskm). For each symbol start line,
 * pick the tightest chunk whose range (or any of its non-contiguous
 * `lineRanges`) contains that line. "Tightest" = smallest covering span, so a
 * method's own chunk wins over the enclosing class chunk, and a `#partN` part
 * wins over a wide fallback. Symbols with no covering chunk are omitted (their
 * cg_symbols.chunk_id stays NULL → find_symbol fallback is a no-op for them).
 */
export function computeSymbolChunkIds(
  symbolStartLines: ReadonlyMap<SymbolId, number>,
  entries: readonly ChunkLookupEntry[],
): Map<SymbolId, string> {
  const out = new Map<SymbolId, string>();
  for (const [symbolId, line] of symbolStartLines) {
    let bestId: string | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const e of entries) {
      const span = coveringSpan(e, line);
      if (span !== undefined && span < bestSpan) {
        bestSpan = span;
        bestId = e.chunkId;
      }
    }
    if (bestId !== undefined) out.set(symbolId, bestId);
  }
  return out;
}

/**
 * Effective covering span of `entry` for `line`, or undefined if `line` is not
 * covered. When `lineRanges` is present, containment is checked against the
 * sub-range that holds the line and the span is that sub-range's width (Ruby
 * body groups: a tight group beats a wide whole-chunk span).
 */
function coveringSpan(
  entry: ChunkLookupEntry,
  line: number,
): number | undefined {
  if (entry.lineRanges && entry.lineRanges.length > 0) {
    let best: number | undefined;
    for (const r of entry.lineRanges) {
      if (line >= r.start && line <= r.end) {
        const w = r.end - r.start;
        if (best === undefined || w < best) best = w;
      }
    }
    return best;
  }
  if (line >= entry.startLine && line <= entry.endLine)
    return entry.endLine - entry.startLine;
  return undefined;
}
```

```typescript
// src/core/domains/trajectory/codegraph/symbols/provider.ts — inside buildChunkSignals,
// after the existing per-chunk fanIn/pageRank loop, before `out.set(relPath, perChunk)`:

// 0rskm — store-time symbol→covering-chunk join. The walker's per-file
// line map (relPath → startLine → symbolId) holds EVERY extracted symbol,
// including methods of a collapsed class that got no own Qdrant chunk.
// Invert it to symbol→startLine, run the containment join against this
// file's chunk entries, and backfill cg_symbols.chunk_id.
const lineMap = this.chunkSymbolByLine
  .get(this.collectionKey(options?.collectionName))
  ?.get(relPath);
if (lineMap && lineMap.size > 0) {
  const symbolStartLines = new Map<SymbolId, number>();
  for (const [startLine, symbolId] of lineMap)
    symbolStartLines.set(symbolId as SymbolId, startLine);
  const chunkIds = computeSymbolChunkIds(symbolStartLines, entries);
  if (chunkIds.size > 0)
    await graphDb.updateSymbolChunkIds(relPath as RelPath, chunkIds);
}
```

> `graphDb` is already in scope (from `getStore`, which is `acquireWrite` in
> pool mode — write-capable, same handle `replacePageRanks` uses at
> `sink.finish`). `entries` is the loop's `ChunkLookupEntry[]`. `collectionKey`
> / `chunkSymbolByLine` already exist. Do NOT thread a `QdrantManager` —
> codegraph stays DuckDB-only.

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/symbol-chunk-join.test.ts`
Expected: PASS (all 5 cases). Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
Expected: PASS (existing provider tests unaffected — new write is additive and
guarded by `chunkIds.size > 0`).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts \
        tests/core/domains/trajectory/codegraph/symbols/symbol-chunk-join.test.ts
git commit -m "feat(trajectory): symbol→covering-chunk containment join in deferred pass (0rskm)

Why: collapsed-class methods get no own Qdrant chunk; store the tightest
covering chunk id on cg_symbols so find_symbol can fall back to it. Trade-off:
one bounded UPDATE per file in the deferred chunk pass, on the write handle the
pass already holds (acquireWrite, same as replacePageRanks)."
```

---

## Task 5: `SymbolChunkResolver` contract + `GraphFacade.resolveSymbolChunk`

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (`SymbolChunkResolver`
  interface)
- Modify: `src/core/api/internal/facades/graph-facade.ts`
- Test: `tests/core/api/internal/facades/graph-facade.test.ts` (extend)

**Interfaces:**

- Consumes: Task 2's `findSymbolChunk` (via the read handle); `withReadHandle`
  (existing).
- Produces:
  - `interface SymbolChunkResolver { resolveSymbolChunk(collectionName: string, symbolId: SymbolId): Promise<SymbolChunkLocation | null> }`
    — the narrow DIP seam `domains/explore` depends on. Lives in `contracts/` so
    explore never imports `api/internal`.
  - `GraphFacade.resolveSymbolChunk(addr: GraphAddressing, symbolId: SymbolId): Promise<SymbolChunkLocation | null>`
    — mirrors `getCallers`; returns null when no codegraph handle resolves.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/internal/facades/graph-facade.test.ts — new describe
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import { SymbolId } from "../../../../../src/core/contracts/types/codegraph.js";

describe("GraphFacade#resolveSymbolChunk", () => {
  it("resolves via the read handle and returns the location", async () => {
    const graphDb = {
      findSymbolChunk: vi
        .fn()
        .mockResolvedValue({ relPath: "a.rb", chunkId: "chunk_x" }),
      close: vi.fn(),
    };
    const pool = { acquireReader: vi.fn().mockResolvedValue({ graphDb }) };
    const facade = new GraphFacade({
      pool: pool as never,
      collectionRegistry: {
        /* minimal registry resolving to "col" */
      } as never,
      resolveActiveCollection: async (c: string) => c,
    });

    const res = await facade.resolveSymbolChunk(
      { collection: "col" },
      "Foo#bar" as SymbolId,
    );
    expect(res).toEqual({ relPath: "a.rb", chunkId: "chunk_x" });
    expect(graphDb.findSymbolChunk).toHaveBeenCalledWith("Foo#bar");
  });

  it("returns null when the read handle cannot be acquired (codegraph absent)", async () => {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(new Error("no daemon")),
    };
    const facade = new GraphFacade({
      pool: pool as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (c: string) => c,
    });
    expect(
      await facade.resolveSymbolChunk(
        { collection: "col" },
        "Foo#bar" as SymbolId,
      ),
    ).toBeNull();
  });
});
```

> Mirror the existing `graph-facade.test.ts` setup for `getCallers` (the
> collectionRegistry mock shape, `resolveCollection` resolution). Reuse its
> helper if one exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/internal/facades/graph-facade.test.ts`
Expected: FAIL — `resolveSymbolChunk` not a function.

- [ ] **Step 3: Add the contract interface**

```typescript
// src/core/contracts/types/codegraph.ts — after SymbolChunkLocation
/**
 * Narrow read seam for the find_symbol codegraph fallback (0rskm). Lives in
 * contracts so domains/explore can depend on it without importing api/internal
 * or adapters. Implemented by GraphFacade (adapted to a bare collectionName in
 * bootstrap). Undefined injection = codegraph disabled = fallback no-op.
 */
export interface SymbolChunkResolver {
  resolveSymbolChunk(
    collectionName: string,
    symbolId: SymbolId,
  ): Promise<SymbolChunkLocation | null>;
}
```

- [ ] **Step 4: Implement on `GraphFacade`**

```typescript
// src/core/api/internal/facades/graph-facade.ts — after getCallees, mirroring getCallers
  async resolveSymbolChunk(addr: GraphAddressing, symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.withReadHandle(addr, async (handle) => handle.graphDb.findSymbolChunk(symbolId), null);
  }
```

> Add `SymbolChunkLocation` / `SymbolId` to the contracts import in
> `graph-facade.ts`. The `null` is the `withReadHandle` fallback when no handle
> resolves.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/api/internal/facades/graph-facade.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc --noEmit
git add src/core/contracts/types/codegraph.ts src/core/api/internal/facades/graph-facade.ts \
        tests/core/api/internal/facades/graph-facade.test.ts
git commit -m "feat(contracts): SymbolChunkResolver + GraphFacade.resolveSymbolChunk (0rskm)"
```

---

## Task 6: Provenance flag on `SearchResult`

**Files:**

- Modify: `src/core/api/public/dto/explore.ts`
- Test: covered by Task 7's strategy test (the flag is asserted there). This
  task is the additive DTO change only.

**Interfaces:**

- Consumes: nothing.
- Produces: `SearchResult.fromCodegraphFallback?: boolean` — additive,
  backward-compatible. `true` marks a result that is the covering chunk resolved
  via the codegraph fallback (queried symbol is collapsed into it), not an exact
  symbol chunk.

- [ ] **Step 1: Add the field**

```typescript
// src/core/api/public/dto/explore.ts — extend SearchResult
export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
  /**
   * 0rskm — true when this result is the covering chunk a collapsed symbol
   * lives in, resolved via the codegraph fallback rather than an exact symbol
   * chunk. Lets agent consumers distinguish a class-granular answer from a
   * precise method chunk. Absent on all normal (Qdrant-primary) results.
   */
  fromCodegraphFallback?: boolean;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit` Expected: PASS (purely additive optional field).

- [ ] **Step 3: Commit**

```bash
git add src/core/api/public/dto/explore.ts
git commit -m "feat(explore): additive fromCodegraphFallback provenance flag on SearchResult (0rskm)"
```

---

## Task 7: find_symbol two-hop fallback in `SymbolSearchStrategy`

**Files:**

- Modify: `src/core/domains/explore/strategies/symbol.ts`
- Test:
  `tests/core/domains/explore/strategies/symbol-codegraph-fallback.test.ts`

**Interfaces:**

- Consumes: `SymbolChunkResolver` (Task 5), `SearchResult.fromCodegraphFallback`
  (Task 6), `qdrant.getPoint` (existing). The strategy gains an optional last
  constructor param `private readonly chunkResolver?: SymbolChunkResolver`.
- Produces: in `executeExplore`, after the primary+parent scroll + filter yields
  **zero** results, a two-hop fallback:
  `chunkResolver.resolveSymbolChunk(ctx.collectionName, this.input.symbol) → qdrant.getPoint(chunkId) → SearchResult`
  tagged `fromCodegraphFallback: true`. Reader undefined or location null or
  point missing → return the (empty) primary result unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/domains/explore/strategies/symbol-codegraph-fallback.test.ts
import { describe, expect, it, vi } from "vitest";

import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

function makeStrategy(opts: {
  scroll: unknown[];
  resolver?: { resolveSymbolChunk: ReturnType<typeof vi.fn> };
  getPoint?: ReturnType<typeof vi.fn>;
}) {
  const qdrant = {
    scrollFiltered: vi.fn().mockResolvedValue(opts.scroll),
    getPoint: opts.getPoint ?? vi.fn(),
  };
  const reranker = {} as never;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
  return new SymbolSearchStrategy(
    qdrant as never,
    reranker,
    [],
    [],
    registry as never,
    { symbol: "Foo#bar" },
    opts.resolver as never, // new optional last param
  );
}

const ctx = { collectionName: "col", limit: 10, metaOnly: false } as never;

describe("SymbolSearchStrategy — codegraph fallback", () => {
  it("falls back to the covering chunk when the Qdrant scroll is empty", async () => {
    const getPoint = vi.fn().mockResolvedValue({
      id: "uuid-1",
      payload: {
        symbolId: "Foo",
        chunkType: "class",
        relativePath: "foo.rb",
        content: "class Foo; def bar; end; end",
        startLine: 1,
        endLine: 3,
      },
    });
    const resolver = {
      resolveSymbolChunk: vi
        .fn()
        .mockResolvedValue({ relPath: "foo.rb", chunkId: "chunk_cls" }),
    };
    const strat = makeStrategy({ scroll: [], resolver, getPoint });

    const results = await (
      strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }
    ).executeExplore(ctx);

    expect(resolver.resolveSymbolChunk).toHaveBeenCalledWith("col", "Foo#bar");
    expect(getPoint).toHaveBeenCalledWith("col", "chunk_cls");
    expect(results).toHaveLength(1);
    expect(
      (results[0] as { fromCodegraphFallback?: boolean }).fromCodegraphFallback,
    ).toBe(true);
  });

  it("does NOT consult the resolver when the primary scroll already matched", async () => {
    const resolver = { resolveSymbolChunk: vi.fn() };
    const strat = makeStrategy({
      scroll: [
        {
          id: "c1",
          payload: {
            symbolId: "Foo#bar",
            chunkType: "function",
            relativePath: "foo.rb",
            content: "def bar; end",
            startLine: 5,
            endLine: 6,
          },
        },
      ],
      resolver,
    });
    await (
      strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }
    ).executeExplore(ctx);
    expect(resolver.resolveSymbolChunk).not.toHaveBeenCalled();
  });

  it("is a graceful no-op when no resolver is injected (codegraph disabled)", async () => {
    const strat = makeStrategy({ scroll: [] });
    const results = await (
      strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }
    ).executeExplore(ctx);
    expect(results).toEqual([]);
  });

  it("is a no-op when the resolver returns null (symbol absent / chunk_id null)", async () => {
    const resolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };
    const getPoint = vi.fn();
    const strat = makeStrategy({ scroll: [], resolver, getPoint });
    const results = await (
      strat as never as { executeExplore: (c: unknown) => Promise<unknown[]> }
    ).executeExplore(ctx);
    expect(getPoint).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/explore/strategies/symbol-codegraph-fallback.test.ts`
Expected: FAIL — strategy ctor has no 7th param / no fallback branch.

- [ ] **Step 3: Add the optional reader param + fallback branch**

```typescript
// src/core/domains/explore/strategies/symbol.ts — extend the constructor
import type { SymbolChunkResolver } from "../../../contracts/types/codegraph.js";

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryFilterBuilder,
    private readonly input: SymbolSearchInput,
    private readonly chunkResolver?: SymbolChunkResolver,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }
```

```typescript
// src/core/domains/explore/strategies/symbol.ts — at the end of executeExplore,
// replace the final `return resolveSymbols(...)` with:

    const resolved = resolveSymbols(filtered, this.input.symbol, ctx.metaOnly) as ExploreResult[];
    if (resolved.length > 0) return resolved;

    // 0rskm — Qdrant scroll found no chunk for this symbolId. If codegraph is
    // wired, the symbol may be collapsed into a covering class chunk that has a
    // different symbolId. Two-hop: symbol_id → chunk_id → getPoint → result.
    return this.resolveViaCodegraph(ctx);
  }

  private async resolveViaCodegraph(ctx: ExploreContext): Promise<ExploreResult[]> {
    if (!this.chunkResolver) return [];
    const location = await this.chunkResolver.resolveSymbolChunk(ctx.collectionName, this.input.symbol);
    if (!location) return [];
    const point = await this.qdrant.getPoint(ctx.collectionName, location.chunkId);
    if (!point) return [];
    const payload = point.payload ? { ...point.payload } : {};
    if (ctx.metaOnly) delete (payload as { content?: unknown }).content;
    return [
      {
        id: point.id,
        score: 1,
        payload,
        fromCodegraphFallback: true,
      } as ExploreResult,
    ];
  }
```

> `this.qdrant` is `protected` on `BaseExploreStrategy` (confirmed) — accessible
> here. `ExploreResult` must allow `fromCodegraphFallback` — it extends/aligns
> with `SearchResult` (Task 6 field). If `ExploreResult` is a distinct local
> type, add the same optional field to it. Keep `getPoint` returning the stored
> `chunk_<hash16>` id resolved through `normalizeId` internally — pass
> `location.chunkId` verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/explore/strategies/symbol-codegraph-fallback.test.ts`
Expected: PASS (all 4 cases). Run:
`npx vitest run tests/core/domains/explore/strategies/` Expected: PASS (existing
symbol strategy tests unaffected — fallback only fires on empty result +
injected resolver).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/explore/strategies/symbol.ts \
        tests/core/domains/explore/strategies/symbol-codegraph-fallback.test.ts
git commit -m "feat(explore): find_symbol two-hop codegraph fallback in SymbolSearchStrategy (0rskm)

Why: collapsed-class methods have no own Qdrant chunk; after an empty scroll,
resolve symbol_id → chunk_id → getPoint so find_symbol returns the covering
class chunk. Trade-off: one extra DuckDB read + one getPoint ONLY on a cache
miss with codegraph wired; no-op otherwise. symbol.ts is deep-silo — owner
review."
```

---

## Task 8: Thread the resolver through `ExploreOps` → strategy

**Files:**

- Modify: `src/core/api/internal/ops/explore-ops.ts`
- Test: `tests/core/api/internal/ops/explore-ops.test.ts` (extend — assert the
  strategy receives the reader)

**Interfaces:**

- Consumes: `SymbolChunkResolver` (Task 5).
- Produces: `ExploreOpsDeps` gains optional
  `chunkResolver?: SymbolChunkResolver`; `ExploreOps` stores it;
  `buildFindSymbolStrategy` passes it as the 7th arg to
  `new SymbolSearchStrategy(...)`. `FileOutlineStrategy` is unchanged (file-path
  lookups don't collapse).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/internal/ops/explore-ops.test.ts — new case
it("passes the codegraph chunkResolver into SymbolSearchStrategy", async () => {
  const resolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };
  const ops = makeExploreOps({ chunkResolver: resolver }); // test helper threads deps
  // findSymbol with a symbol (not relativePath) builds a SymbolSearchStrategy.
  // Drive a collapsed-miss: empty scroll → strategy consults the resolver.
  await ops.findSymbol({ symbol: "Foo#bar", project: "tea-rags" } as never);
  expect(resolver.resolveSymbolChunk).toHaveBeenCalledWith(
    expect.any(String),
    "Foo#bar",
  );
});
```

> Adapt `makeExploreOps` to the existing test's construction helper in
> `explore-ops.test.ts`; mock `qdrant.scrollFiltered` → `[]` so the fallback
> path triggers. If the existing test file builds `ExploreOps` inline, mirror
> that and add `chunkResolver` to the deps object.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/internal/ops/explore-ops.test.ts` Expected:
FAIL — resolver never consulted (not threaded).

- [ ] **Step 3: Thread the dep**

```typescript
// src/core/api/internal/ops/explore-ops.ts
import type { SymbolChunkResolver } from "../../../contracts/types/codegraph.js";

// 1) add to ExploreOpsDeps:
  /** Optional — present when codegraph is wired (bootstrap adapts GraphFacade). */
  chunkResolver?: SymbolChunkResolver;

// 2) store in the constructor (mirror an existing optional dep), e.g.:
    this.chunkResolver = deps.chunkResolver;
//    with `private readonly chunkResolver?: SymbolChunkResolver;` field.

// 3) pass it as the 7th arg in buildFindSymbolStrategy's SymbolSearchStrategy branch:
    return new SymbolSearchStrategy(
      this.qdrant,
      this.reranker,
      this.payloadSignals,
      this.essentialKeys,
      this.registry,
      {
        symbol: request.symbol as string,
        language: request.language,
        pathPattern: request.pathPattern,
      },
      this.chunkResolver,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/internal/ops/explore-ops.test.ts` Expected:
PASS.

- [ ] **Step 5: Type-check + commit**

```bash
npx tsc --noEmit
git add src/core/api/internal/ops/explore-ops.ts tests/core/api/internal/ops/explore-ops.test.ts
git commit -m "feat(explore): thread codegraph chunkResolver into find_symbol strategy (0rskm)"
```

---

## Task 9: Bootstrap wiring — adapt `GraphFacade` → `SymbolChunkResolver`

**Files:**

- Modify: `src/bootstrap/factory.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts` (accept + forward
  `chunkResolver`)
- Test: `tests/bootstrap/factory-codegraph-fallback.test.ts` (or extend existing
  factory test) — assert the resolver reaches ExploreOps when codegraph is wired
  and is undefined when disabled.

**Interfaces:**

- Consumes: `codegraphContext?.graphFacade` (existing optional),
  `SymbolChunkResolver` (Task 5), `ExploreOpsDeps.chunkResolver` (Task 8).
- Produces: when codegraph is wired, an adapter
  `{ resolveSymbolChunk: (coll, sym) => graphFacade.resolveSymbolChunk({ collection: coll }, sym) }`
  passed into `ExploreFacade` deps → `ExploreOps`. When `graphFacade` is
  undefined, the adapter is undefined → fallback no-op end to end.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bootstrap/factory-codegraph-fallback.test.ts
// Build the app context with codegraph enabled; assert that a find_symbol on a
// symbol with no Qdrant chunk but a populated cg_symbols.chunk_id returns the
// covering chunk with fromCodegraphFallback: true. Use the existing factory
// test harness / fixtures. If a full integration harness is heavy, assert the
// narrower wiring: ExploreFacade deps include a defined chunkResolver when
// codegraphContext is present, and undefined when CODEGRAPH_DISABLED is set.
```

> Prefer extending the existing bootstrap/factory test rather than a heavy new
> integration harness. The unit-level assertion (resolver defined ⇔ codegraph
> wired) is sufficient for RED/GREEN here; the true end-to-end proof is the live
> validation in Task 10.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bootstrap/` Expected: FAIL — `ExploreFacade` deps
carry no `chunkResolver`.

- [ ] **Step 3: Accept the resolver in `ExploreFacade`**

```typescript
// src/core/api/internal/facades/explore-facade.ts
import type { SymbolChunkResolver } from "../../../contracts/types/codegraph.js";

// add to ExploreFacadeDeps:
  chunkResolver?: SymbolChunkResolver;

// forward it where ExploreFacade builds/holds ExploreOps deps:
//   chunkResolver: deps.chunkResolver,
```

> Locate where `ExploreFacade` constructs `ExploreOps` (or holds its deps) and
> forward `chunkResolver` into that deps object alongside `qdrant` / `reranker`.

- [ ] **Step 4: Adapt + wire in `factory.ts`**

```typescript
// src/bootstrap/factory.ts — before `new ExploreFacade({...})`
const chunkResolver = codegraphContext?.graphFacade
  ? {
      resolveSymbolChunk: (collectionName: string, symbolId: SymbolId) =>
        codegraphContext.graphFacade.resolveSymbolChunk({ collection: collectionName }, symbolId),
    }
  : undefined;

// then add to the ExploreFacade deps object:
  chunkResolver,
```

> Import `SymbolId` type in `factory.ts` if not present. `codegraphContext` is
> already built before `new ExploreFacade(...)` (factory.ts ~line 508 vs ~606).
> The adapter is the ONLY place that bridges `api/internal` (`GraphFacade`) to
> the `contracts/` interface the explore domain consumes — keeps the boundary
> clean.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/bootstrap/` Expected: PASS.

- [ ] **Step 6: Full type-check + targeted suites + commit**

```bash
npx tsc --noEmit
npx vitest run tests/core/adapters/duckdb tests/core/domains/trajectory/codegraph tests/core/domains/explore/strategies tests/core/api/internal
git add src/bootstrap/factory.ts src/core/api/internal/facades/explore-facade.ts tests/bootstrap/
git commit -m "feat(trajectory): wire codegraph SymbolChunkResolver into find_symbol path (0rskm)

Why: bootstrap is the only layer allowed to bridge api/internal GraphFacade to
the contracts SymbolChunkResolver the explore domain consumes. Adapter is
undefined when codegraph is disabled, so the whole fallback degrades to today's
behaviour. explore-facade.ts is deep-silo — owner review."
```

---

## Task 10: Live validation (MCP, not a unit task)

**Files:** none (validation only). Follows `.claude/rules` MCP `npm link`
workflow.

**Goal:** Prove the fallback works end-to-end against a freshly-indexed payload
— the schema change means the index must be rebuilt (BREAKING for the index, not
the API).

- [ ] **Step 1: Build + link the worktree**

```bash
npm run build && npm link
# reconnect MCP servers in Claude Code
```

- [ ] **Step 2: Force-reindex the self-test index (schema drift guard)**

`mcp__tea-rags__force_reindex project=tea-rags` — full reset; the prior index
predates `chunk_id`. Confirm `get_index_status` shows codegraph.symbols
enrichment completing (not degraded after a clean run).

- [ ] **Step 3: Reindex huginn (Ruby collapsed-class case)**

`mcp__tea-rags__index_codebase project=huginn` (collection `code_d2c81d68`) —
Ruby exercises the collapsed small-class path the bug is about.

- [ ] **Step 4: Assert fallback behaviour**

- Pick a known collapsed Ruby method (a small class whose methods get no own
  chunk). `mcp__tea-rags__find_symbol project=huginn symbol="<Class>#<method>"`
  → returns the covering class chunk with `fromCodegraphFallback: true`.
- Pick a non-collapsed method (its own chunk exists) → returns its own chunk,
  `fromCodegraphFallback` absent (resolver never consulted).
- Pick a genuine typo (`Class#nonexistent`) → empty result, no false positive.
- On tea-rags self-test: spot-check a TS method still resolves exactly as before
  (no regression on the primary path).

- [ ] **Step 5: Record outcome**

Note in the bead (`bd update tea-rags-mcp-0rskm --notes=...`): which collapsed
symbol proved the fallback, and that the non-collapsed + typo controls held. Do
NOT push; do NOT merge to main inside this plan (separate, explicitly-authorised
step).

---

## Self-Review

**Spec coverage** (spec §Components 1–7):

1. Schema migration → Task 1. ✓
2. `SymbolDefinition` + write path → adjusted: `SymbolDefinition` left unchanged
   (chunk_id is not symbol identity and isn't known at file-write time); the
   write is a dedicated `updateSymbolChunkIds` (Task 2) populated in the
   deferred pass (Task 4). This is the spec's explicitly-allowed "dedicated
   method" option and satisfies the colocation rule (one writer for the column).
   ✓ (deviation documented — see note below)
3. Containment join reusing `chunkMap` → Task 4. ✓
4. Read API `findSymbolChunk` + `resolveSymbolChunk` → Tasks 2, 5. ✓
5. `SymbolSearchStrategy` fallback → Task 7. ✓
6. `FindSymbolResponse`/`SearchResult` provenance → Task 6. ✓
7. q383b seam (`resolveSymbolChunk` promotable) → preserved: the reader method
   is the seam; the strategy is the only place that encodes "fallback after
   empty". ✓

**Deviation from spec §2 (flagged for the user):** the spec text says
"`SymbolDefinition` gains `chunkId?`; `upsertSymbols` writes the column."
Because `upsertSymbols` runs in the file phase — _before_ the chunker's
`chunkMap` exists — `chunkId` is unknowable there and would always write NULL.
The plan instead leaves `SymbolDefinition` as pure symbol identity and gives
`chunk_id` a single writer (`updateSymbolChunkIds`) in the deferred pass that
_does_ hold `chunkMap`. The spec sanctioned this as the "dedicated method"
alternative; calling it out because it changes which spec sentence is literally
implemented.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. Test
bodies for Tasks 8–9 reference existing test harnesses (`makeExploreOps`,
factory harness) rather than inlining — flagged explicitly so the implementer
adapts to the real helper instead of inventing a divergent one.

**Type consistency:** `SymbolChunkLocation` `{ relPath, chunkId }` used
identically in Tasks 2/3/5/7.
`SymbolChunkResolver.resolveSymbolChunk(collectionName, symbolId)` (bare
collection) vs `GraphFacade.resolveSymbolChunk(addr, symbolId)` (addressing
triad) — intentionally different signatures; the bootstrap adapter (Task 9)
bridges them. `updateSymbolChunkIds(relPath, ReadonlyMap<SymbolId, string>)`
consistent across contract/in-process/daemon. `computeSymbolChunkIds` signature
identical in Task 4 helper + test. `fromCodegraphFallback` field name identical
in Tasks 6 + 7.

**Open implementation-time confirmations** (the implementer verifies against
real code, none block the design):

- DuckDB `ADD COLUMN IF NOT EXISTS` support on the pinned version (Task 1 Step 3
  note).
- Exact private helper names on `DuckDbGraphClient`
  (`run`/`exec`/`queryAll`/`serialize`) and `queryAll` visibility for the
  migration test.
- `DaemonGraphDbClient` constructor signature + whether `DaemonOp` is a closed
  union needing the two new op names (Task 3).
- Whether `ExploreResult` is `SearchResult` or a distinct type needing the same
  additive field (Task 7).
- The exact `ExploreFacade` → `ExploreOps` deps construction site (Task 9 Step
  3).
