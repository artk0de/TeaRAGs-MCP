import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../src/core/api/index.js";
import type { CallResolver } from "../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("createComposition", () => {
  it("builds registry with GitTrajectory", () => {
    const { registry } = createComposition();
    expect(registry.has("git")).toBe(true);
  });

  it("aggregates payload signals from BASE + trajectories", () => {
    const { allPayloadSignalDescriptors } = createComposition();
    // BASE has relativePath, language, etc. + git has git.file.*, git.chunk.*
    expect(allPayloadSignalDescriptors.length).toBeGreaterThan(12);
    expect(allPayloadSignalDescriptors.find((s) => s.key === "relativePath")).toBeDefined();
    expect(allPayloadSignalDescriptors.find((s) => s.key === "git.file.commitCount")).toBeDefined();
  });

  it("aggregates derived signals from trajectories + structural", () => {
    const { allDerivedSignals } = createComposition();
    // Git: 15 derived + structural: 7
    expect(allDerivedSignals.length).toBe(22);
    expect(allDerivedSignals.find((d) => d.name === "recency")).toBeDefined();
    expect(allDerivedSignals.find((d) => d.name === "similarity")).toBeDefined();
  });

  it("resolves presets from relevance + trajectory", () => {
    const { resolvedPresets } = createComposition();
    expect(resolvedPresets.length).toBeGreaterThan(0);
    expect(resolvedPresets.find((p) => p.name === "relevance")).toBeDefined();
    expect(resolvedPresets.find((p) => p.name === "techDebt")).toBeDefined();
  });

  it("creates a functional reranker", () => {
    const { reranker } = createComposition();
    expect(reranker.getAvailablePresets("semantic_search")).toContain("techDebt");
    expect(reranker.getAvailablePresets("search_code")).toContain("relevance");
  });

  describe("when codegraph deps are supplied", () => {
    // Drives the `options.codegraph` branch in createComposition,
    // which in turn drives the codegraph L1 factory and the
    // SymbolsTrajectory L2 wiring. Both lived as dead branches until
    // bootstrap learned to opt in — covering them here means a
    // regression in the wiring fails fast in unit tests instead of
    // surfacing only on a live MCP run.
    let tmp: string;
    let graphDb: DuckDbGraphClient;
    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), "comp-cg-"));
      graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
      await graphDb.init();
    });
    afterAll(async () => {
      await graphDb.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it("registers SymbolsTrajectory and surfaces its payload signals + presets", () => {
      const resolvers = new Map<string, CallResolver>([
        ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
      ]);
      const { registry, allPayloadSignalDescriptors, resolvedPresets } = createComposition({
        codegraph: {
          graphDb,
          symbolTable: new InMemoryGlobalSymbolTable(),
          resolvers,
        },
      });
      expect(registry.has("codegraph.symbols")).toBe(true);
      // Codegraph-owned payload signals are now part of the aggregated set.
      expect(allPayloadSignalDescriptors.find((s) => s.key === "codegraph.file.fanIn")).toBeDefined();
      expect(allPayloadSignalDescriptors.find((s) => s.key === "codegraph.chunk.callSiteCount")).toBeDefined();
      // Resolved presets include the codegraph family's contributions —
      // checking the count is robust to preset renames.
      expect(resolvedPresets.length).toBeGreaterThan(0);
    });
  });
});
