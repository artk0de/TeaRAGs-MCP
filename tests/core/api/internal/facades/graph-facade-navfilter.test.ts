import { describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade, isNavigationVisibleEdge } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

// ── truth-table for the predicate itself ────────────────────────────────────

describe("navigation edge filter (xlnub)", () => {
  const cases = [
    { edgeKind: "exact", confidence: 1.0, visible: true },
    { edgeKind: "cone", confidence: 0.33, visible: true },
    { edgeKind: "poly-base", confidence: 1.0, visible: true },
    { edgeKind: "dynamic", confidence: 1.0, visible: true }, // narrowed-unique
    { edgeKind: "dynamic", confidence: 0.5, visible: false }, // irreducible residual
    { edgeKind: undefined, confidence: undefined, visible: true }, // legacy edge → visible
  ];
  for (const c of cases) {
    it(`${c.edgeKind}@${c.confidence} → ${c.visible ? "shown" : "hidden"}`, () => {
      expect(isNavigationVisibleEdge(c)).toBe(c.visible);
    });
  }
});

// ── facade integration — mixed edge bag filtered before slice ────────────────

function fakePool(graphDb: Record<string, unknown>): GraphDbClientPool {
  if (typeof graphDb.close !== "function") graphDb.close = vi.fn().mockResolvedValue(undefined);
  const handle = { graphDb, symbolTable: {} as unknown as never };
  return {
    acquireReader: vi.fn().mockResolvedValue(handle),
    peek: vi.fn().mockReturnValue(handle),
  } as unknown as GraphDbClientPool;
}

function fakeRegistry(entries: Record<string, { collectionName: string; path: string }>): CollectionRegistry {
  return {
    findByName: vi.fn((name: string) => {
      const entry = entries[name];
      return entry ? { ...entry, name } : null;
    }),
    findByPath: vi.fn((path: string) => {
      for (const [name, entry] of Object.entries(entries)) {
        if (entry.path === path) return { ...entry, name };
      }
      return null;
    }),
    list: vi.fn(() => Object.entries(entries).map(([name, e]) => ({ ...e, name }))),
  } as unknown as CollectionRegistry;
}

describe("GraphFacade navigation filter — getCallers", () => {
  it("hides dynamic@<1 edges and keeps cone/exact/dynamic@1.0/legacy edges", async () => {
    const mixed = [
      { sourceSymbolId: "A#run", sourceRelPath: "a.rb", callExpression: "x.m", edgeKind: "exact", confidence: 1.0 },
      { sourceSymbolId: "B#run", sourceRelPath: "b.rb", callExpression: "x.m", edgeKind: "cone", confidence: 0.33 },
      { sourceSymbolId: "C#run", sourceRelPath: "c.rb", callExpression: "x.m", edgeKind: "poly-base", confidence: 1.0 },
      { sourceSymbolId: "D#run", sourceRelPath: "d.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 1.0 },
      // HIDDEN — irreducible residual
      { sourceSymbolId: "E#run", sourceRelPath: "e.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 0.5 },
      // legacy (no edgeKind) → always visible
      { sourceSymbolId: "F#run", sourceRelPath: "f.rb", callExpression: "x.m" },
    ];
    const graphDb = { getCallers: vi.fn().mockResolvedValue(mixed) };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const { callers } = await facade.getCallers({ path: "/proj", symbolId: "T#m" });
    const ids = callers.map((c) => c.sourceSymbolId);
    expect(ids).toContain("A#run"); // exact
    expect(ids).toContain("B#run"); // cone
    expect(ids).toContain("C#run"); // poly-base
    expect(ids).toContain("D#run"); // dynamic@1.0 narrowed-unique
    expect(ids).not.toContain("E#run"); // dynamic@0.5 residual → hidden
    expect(ids).toContain("F#run"); // legacy
    expect(callers).toHaveLength(5);
  });

  it("filter runs before slice — slice limit counts only visible edges", async () => {
    // 5 visible + 3 hidden; limit=4 should yield first 4 visible, not 4 from unfiltered
    const edges = [
      { sourceSymbolId: "V1#m", sourceRelPath: "v1.rb", callExpression: "x.m", edgeKind: "exact", confidence: 1.0 },
      { sourceSymbolId: "H1#m", sourceRelPath: "h1.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 0.3 },
      { sourceSymbolId: "V2#m", sourceRelPath: "v2.rb", callExpression: "x.m", edgeKind: "cone", confidence: 0.5 },
      { sourceSymbolId: "H2#m", sourceRelPath: "h2.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 0.2 },
      { sourceSymbolId: "V3#m", sourceRelPath: "v3.rb", callExpression: "x.m" },
      { sourceSymbolId: "H3#m", sourceRelPath: "h3.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 0.1 },
      { sourceSymbolId: "V4#m", sourceRelPath: "v4.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 1.0 },
      { sourceSymbolId: "V5#m", sourceRelPath: "v5.rb", callExpression: "x.m", edgeKind: "exact", confidence: 1.0 },
    ];
    const graphDb = { getCallers: vi.fn().mockResolvedValue(edges) };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const { callers } = await facade.getCallers({ path: "/proj", symbolId: "T#m", limit: 4 });
    expect(callers).toHaveLength(4);
    const ids = callers.map((c) => c.sourceSymbolId);
    // All returned must be visible
    for (const id of ids) {
      expect(id).not.toMatch(/^H/);
    }
  });
});

describe("GraphFacade navigation filter — getCallees", () => {
  it("hides dynamic@<1 edges and keeps all other edge kinds", async () => {
    const mixed = [
      { targetSymbolId: "A#m", targetRelPath: "a.rb", callExpression: "x.m", edgeKind: "exact", confidence: 1.0 },
      { targetSymbolId: "B#m", targetRelPath: "b.rb", callExpression: "x.m", edgeKind: "cone", confidence: 0.5 },
      // HIDDEN
      { targetSymbolId: "C#m", targetRelPath: "c.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 0.5 },
      { targetSymbolId: "D#m", targetRelPath: "d.rb", callExpression: "x.m", edgeKind: "dynamic", confidence: 1.0 },
      // legacy
      { targetSymbolId: "E#m", targetRelPath: "e.rb", callExpression: "x.m" },
    ];
    const graphDb = { getCallees: vi.fn().mockResolvedValue(mixed) };
    const facade = new GraphFacade({ pool: fakePool(graphDb), collectionRegistry: fakeRegistry({}) });
    const { callees } = await facade.getCallees({ path: "/proj", symbolId: "Src#run" });
    const ids = callees.map((c) => c.targetSymbolId);
    expect(ids).toContain("A#m");
    expect(ids).toContain("B#m");
    expect(ids).not.toContain("C#m"); // dynamic@0.5 → hidden
    expect(ids).toContain("D#m"); // dynamic@1.0 → shown
    expect(ids).toContain("E#m");
    expect(callees).toHaveLength(4);
  });
});
