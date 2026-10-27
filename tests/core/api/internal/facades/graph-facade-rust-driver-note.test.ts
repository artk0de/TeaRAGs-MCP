/**
 * The rustc-driver note rides the Rust graph answer it qualifies (bd
 * tea-rags-mcp-nknkg.1): the agent digest no longer carries the driver line, so
 * an empty Rust `get_callers` / `get_callees` answer says itself that its edges
 * are static-only and a lower bound whenever the driver did not index.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { RustcDriverStatus } from "../../../../../src/core/contracts/rustc-driver-status.js";
import type { SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const SYMBOLS: SymbolVisibilityRow[] = [{ relPath: "src/engine.rs", symbolId: "Engine#run", visibility: null }];

function graphDb(driver: RustcDriverStatus | null) {
  return {
    getCallers: vi.fn(async () => []),
    getCallees: vi.fn(async () => []),
    getSupertypes: vi.fn(async () => []),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => SYMBOLS.filter((r) => ids.includes(r.symbolId))),
    lookupSymbolIdsByShortName: vi.fn(async () => []),
    getRunStats: vi.fn(async () => [
      { language: "rust", receiverKind: "member", attempted: 100, resolved: 98, externalSkipped: 0, unresolvable: 0 },
    ]),
    getRustcDriverStatus: vi.fn(async () => (driver === null ? null : { status: driver, recordedAtMs: 1 })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function facadeOver(db: ReturnType<typeof graphDb>): GraphFacade {
  const pool = {
    acquireReader: vi.fn().mockResolvedValue({ graphDb: db, symbolTable: {} }),
    hasDatabase: vi.fn().mockReturnValue(true),
  } as unknown as GraphDbClientPool;
  return new GraphFacade({ pool, collectionRegistry: {} as CollectionRegistry });
}

async function emptyMessage(driver: RustcDriverStatus | null): Promise<string | undefined> {
  const res = await facadeOver(graphDb(driver)).getCallers({ collection: "c", symbolId: "Engine#run" });
  return "empty" in res ? res.empty?.message : undefined;
}

describe("GraphFacade — Rust empty answers carry the rustc-driver lower-bound note", () => {
  it("driver unavailable → static-only lower bound, no 'no callers' claim", async () => {
    const message = await emptyMessage({ outcome: "unavailable", hint: "cargo install tea-rags-rustc-driver" });
    expect(message).toMatch(/rustc driver/);
    expect(message).toMatch(/static-only/);
    expect(message).toMatch(/lower bound/);
    expect(message).toMatch(/never report "no callers"/);
  });

  it("driver skipped → same lower-bound note", async () => {
    expect(await emptyMessage({ outcome: "skipped", reason: "noBulkNoCache" })).toMatch(/lower bound/);
  });

  it("driver indexed → no driver note (high resolve rate, no lower bound)", async () => {
    const message = await emptyMessage({ outcome: "indexed" });
    expect(message).not.toMatch(/rustc driver/);
    expect(message).not.toMatch(/lower bound/);
  });
});
