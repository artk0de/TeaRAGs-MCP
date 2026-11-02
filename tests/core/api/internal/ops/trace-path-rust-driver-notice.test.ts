/**
 * An empty `trace_path` between Rust symbols is a lower bound while the rustc
 * driver did not index (bd tea-rags-mcp-nknkg.1 regression): Rust edges are
 * static-only, so "no path" is not proof the symbols are unconnected.
 */
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import type { RustcDriverStatus } from "../../../../../src/core/contracts/rustc-driver-status.js";

function makeOps(driver: RustcDriverStatus | null, ext = "rs", rustcDriverPresence?: () => boolean): TracePathOps {
  const graphDb = {
    getCalleeEdgesScoped: vi.fn(async () => new Map()),
    getSymbolRelPaths: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [`src/${id}.${ext}`]]))),
    getRustcDriverStatus: vi.fn(async () => (driver === null ? null : { status: driver, recordedAtMs: 1 })),
    close: vi.fn(async () => undefined),
  };
  return new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: { scrollBySymbolIds: vi.fn(async () => []) },
    reranker: { rerank: vi.fn() } as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    ...(rustcDriverPresence ? { rustcDriverPresence } : {}),
  });
}

describe("TracePathOps — empty Rust trace carries the rustc-driver lower-bound notice", () => {
  it("both endpoints Rust, no path, driver skipped → notices", async () => {
    const res = await makeOps({ outcome: "skipped", reason: "noBulkNoCache" }).tracePath({
      collection: "c",
      from: "main",
      to: "engine",
    });
    expect(res.paths).toEqual([]);
    expect(res).not.toHaveProperty("empty");
    expect(res.notices?.[0]).toMatch(/^rustc driver: skipped — noBulkNoCache/);
    expect(res.notices?.[0]).toMatch(/lower bound/);
  });

  // bd tea-rags-mcp-hjbow.9 — the driver appeared after the run: edges are still
  // static-only, and the notice names the recompute instead of the install.
  it("persisted unavailable, driver now on disk → installed-pending notice with the recompute hint", async () => {
    const res = await makeOps({ outcome: "unavailable", hint: "install it" }, "rs", () => true).tracePath({
      project: "repo",
      collection: "c",
      from: "main",
      to: "engine",
    });
    expect(res.notices?.[0]).toMatch(/^rustc driver: installed-pending — /);
    expect(res.notices?.[0]).toContain(
      "recompute: tea-rags index-codebase --project repo --force-enrichments codegraph --languages rust",
    );
    expect(res.notices?.[0]).toMatch(/lower bound/);
    expect(res.notices?.[0]).not.toContain("install it");
  });

  it("driver indexed → no notices", async () => {
    const res = await makeOps({ outcome: "indexed" }).tracePath({ collection: "c", from: "main", to: "engine" });
    expect(res).not.toHaveProperty("notices");
  });

  it("non-Rust endpoints → no notices", async () => {
    const res = await makeOps({ outcome: "skipped" }, "ts").tracePath({ collection: "c", from: "main", to: "engine" });
    expect(res).not.toHaveProperty("notices");
  });
});
