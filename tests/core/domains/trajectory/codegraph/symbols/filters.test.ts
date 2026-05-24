/**
 * Codegraph filter descriptor tests.
 *
 * Verifies that codegraph payload signals are addressable via typed filter
 * params and that each `toCondition` translates the logical param name to the
 * actual nested Qdrant payload path created by EnrichmentApplier (see
 * `src/core/domains/ingest/pipeline/enrichment/applier.ts:122-124` — payload is
 * written under `key: "codegraph.symbols.${level}"`, and inner keys keep their
 * literal dotted form, so the addressable Qdrant path is
 * `codegraph.symbols.${level}.codegraph.${level}.<suffix>`).
 *
 * bd tea-rags-mcp-tr5k.
 */
import { describe, expect, it } from "vitest";

import { codegraphFilters } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/filters.js";

const findFilter = (param: string) => codegraphFilters.find((f) => f.param === param)!;

describe("codegraph filter descriptors", () => {
  it("exports the expected typed filter params", () => {
    const params = codegraphFilters.map((f) => f.param).sort();
    expect(params).toEqual([
      "isHub",
      "isLeaf",
      "minConnectionCount",
      "minFanIn",
      "minFanOut",
      "minInstability",
      "minPageRank",
      "minTransitiveImpact",
    ]);
  });

  it("each filter declares the required fields", () => {
    for (const f of codegraphFilters) {
      expect(f.param).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(typeof f.toCondition).toBe("function");
      expect(["string", "number", "boolean", "string[]"]).toContain(f.type);
    }
  });

  describe("level-aware fanIn/fanOut filters", () => {
    it("minFanIn defaults to file level", () => {
      const result = findFilter("minFanIn").toCondition(3);
      expect(result.must).toEqual([{ key: "codegraph.symbols.file.codegraph.file.fanIn", range: { gte: 3 } }]);
    });

    it("minFanIn respects chunk level", () => {
      const result = findFilter("minFanIn").toCondition(3, "chunk");
      expect(result.must).toEqual([{ key: "codegraph.symbols.chunk.codegraph.chunk.fanIn", range: { gte: 3 } }]);
    });

    it("minFanOut defaults to file level", () => {
      const result = findFilter("minFanOut").toCondition(5);
      expect(result.must).toEqual([{ key: "codegraph.symbols.file.codegraph.file.fanOut", range: { gte: 5 } }]);
    });

    it("minFanOut respects chunk level", () => {
      const result = findFilter("minFanOut").toCondition(5, "chunk");
      expect(result.must).toEqual([{ key: "codegraph.symbols.chunk.codegraph.chunk.fanOut", range: { gte: 5 } }]);
    });
  });

  describe("chunk-only signal filters", () => {
    it("minPageRank is chunk-scoped regardless of level param", () => {
      const result = findFilter("minPageRank").toCondition(0.001);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.chunk.codegraph.chunk.pageRank",
          range: { gte: 0.001 },
        },
      ]);
    });
  });

  describe("file-only signal filters", () => {
    it("minInstability is file-scoped", () => {
      const result = findFilter("minInstability").toCondition(0.5);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.instability",
          range: { gte: 0.5 },
        },
      ]);
    });

    it("minTransitiveImpact is file-scoped", () => {
      const result = findFilter("minTransitiveImpact").toCondition(10);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.transitiveImpact",
          range: { gte: 10 },
        },
      ]);
    });

    it("minConnectionCount is file-scoped (the support signal for instability)", () => {
      const result = findFilter("minConnectionCount").toCondition(5);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.connectionCount",
          range: { gte: 5 },
        },
      ]);
    });
  });

  describe("boolean filters", () => {
    it("isHub matches file-level isHub == true when value is true", () => {
      const result = findFilter("isHub").toCondition(true);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.isHub",
          match: { value: true },
        },
      ]);
    });

    it("isHub matches file-level isHub == false when value is false", () => {
      const result = findFilter("isHub").toCondition(false);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.isHub",
          match: { value: false },
        },
      ]);
    });

    it("isLeaf matches file-level isLeaf == true", () => {
      const result = findFilter("isLeaf").toCondition(true);
      expect(result.must).toEqual([
        {
          key: "codegraph.symbols.file.codegraph.file.isLeaf",
          match: { value: true },
        },
      ]);
    });
  });
});
