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

function facadeOver(db: object): GraphFacade {
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
    expect(message).toMatch(/confirm with a literal text search for the name/);
    expect(message).not.toMatch(/never report/);
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

/** A Rust graph whose `Engine#run` has one caller and one callee — a NON-empty answer. */
function populatedGraphDb(driver: RustcDriverStatus | null, relPath = "src/engine.rs") {
  const rows: SymbolVisibilityRow[] = [{ relPath, symbolId: "Engine#run", visibility: null }];
  return {
    ...graphDb(driver),
    getCallers: vi.fn(async () => [
      { sourceSymbolId: "main", sourceRelPath: "src/main.rs", callExpression: "engine.run()" },
    ]),
    getCallees: vi.fn(async () => [
      {
        sourceSymbolId: "Engine#run",
        sourceRelPath: relPath,
        targetSymbolId: "Engine#step",
        targetRelPath: relPath,
        callExpression: "self.step()",
      },
    ]),
    getCallersBulk: vi.fn(async () => new Map()),
    getSymbolVisibilities: vi.fn(async (ids: readonly string[]) => rows.filter((r) => ids.includes(r.symbolId))),
  };
}

const SKIPPED: RustcDriverStatus = { outcome: "skipped", reason: "noBulkNoCache" };

describe("GraphFacade — non-empty Rust caller/callee answers carry the lower-bound notice", () => {
  it("callers listed + driver skipped → notices holds the driver line", async () => {
    const res = await facadeOver(populatedGraphDb(SKIPPED)).getCallers({ collection: "c", symbolId: "Engine#run" });
    expect("callers" in res && res.callers).toHaveLength(1);
    const notices = "notices" in res ? res.notices : undefined;
    expect(notices).toHaveLength(1);
    expect(notices?.[0]).toMatch(/^rustc driver: skipped — noBulkNoCache/);
    expect(notices?.[0]).toMatch(/static-only, so this is a lower bound/);
  });

  it("callees listed + driver unavailable → notices holds the driver line", async () => {
    const db = populatedGraphDb({ outcome: "unavailable", hint: "cargo install tea-rags-rustc-driver" });
    const res = await facadeOver(db).getCallees({ collection: "c", symbolId: "Engine#run" });
    expect("notices" in res ? res.notices?.[0] : undefined).toMatch(/rustc driver: unavailable/);
  });

  it("depth 2 call tree + driver skipped → notices holds the driver line", async () => {
    const res = await facadeOver(populatedGraphDb(SKIPPED)).getCallers({
      collection: "c",
      symbolId: "Engine#run",
      depth: 2,
    });
    expect("notices" in res ? res.notices?.[0] : undefined).toMatch(/lower bound/);
  });

  it("driver indexed → no notices field", async () => {
    const res = await facadeOver(populatedGraphDb({ outcome: "indexed" })).getCallers({
      collection: "c",
      symbolId: "Engine#run",
    });
    expect(res).not.toHaveProperty("notices");
  });

  it("non-Rust symbol in a project whose Rust driver skipped → no notices field", async () => {
    const res = await facadeOver(populatedGraphDb(SKIPPED, "src/engine.ts")).getCallers({
      collection: "c",
      symbolId: "Engine#run",
    });
    expect(res).not.toHaveProperty("notices");
  });

  it("a failing driver-status read never fails the answer — callers returned, no notices", async () => {
    const db = {
      ...populatedGraphDb(SKIPPED),
      getRustcDriverStatus: vi.fn(async () => Promise.reject(new Error("daemon down"))),
    };
    const res = await facadeOver(db).getCallers({ collection: "c", symbolId: "Engine#run" });
    expect("callers" in res && res.callers).toHaveLength(1);
    expect(res).not.toHaveProperty("notices");
  });

  it("empty Rust answer keeps the note in empty.message only (no duplicate notices)", async () => {
    const res = await facadeOver(graphDb(SKIPPED)).getCallers({ collection: "c", symbolId: "Engine#run" });
    expect(res).not.toHaveProperty("notices");
  });
});

describe("GraphFacade#findCycles — empty answer over Rust carries the lower-bound notice", () => {
  function cyclesFacade(driver: RustcDriverStatus | null): GraphFacade {
    return facadeOver({ ...graphDb(driver), findCycles: vi.fn(async () => []) });
  }

  it("no cycles + driver skipped + whole project → notices says the empty list is a lower bound", async () => {
    const res = await cyclesFacade(SKIPPED).findCycles({ collection: "c", scope: "method" });
    expect(res.cycles).toEqual([]);
    expect(res.notices?.[0]).toMatch(/^rustc driver: skipped/);
    expect(res.notices?.[0]).toMatch(/lower bound/);
  });

  it("no cycles + driver skipped + pathPattern selecting Rust → notices", async () => {
    const res = await cyclesFacade(SKIPPED).findCycles({ collection: "c", scope: "file", pathPattern: "crates/**" });
    expect(res.notices).toHaveLength(1);
  });

  it("no cycles + driver skipped + pathPattern selecting only TypeScript → no notices", async () => {
    const res = await cyclesFacade(SKIPPED).findCycles({ collection: "c", scope: "file", pathPattern: "src/**/*.ts" });
    expect(res).not.toHaveProperty("notices");
  });

  it("no cycles + driver indexed → no notices", async () => {
    const res = await cyclesFacade({ outcome: "indexed" }).findCycles({ collection: "c", scope: "method" });
    expect(res).not.toHaveProperty("notices");
  });

  it("no cycles + no Rust in the project (no driver record) → no notices", async () => {
    const res = await cyclesFacade(null).findCycles({ collection: "c", scope: "method" });
    expect(res).not.toHaveProperty("notices");
  });
});
