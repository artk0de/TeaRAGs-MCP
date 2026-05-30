import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../src/core/api/index.js";
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

  describe("when git deps are supplied", () => {
    // Registry-driven IngestFacade refactor: GitEnrichmentProvider is no
    // longer constructed inline by the facade. Composition owns it via
    // GitTrajectory and the registry surfaces it through
    // getAllEnrichmentProviders(). This test pins the new contract: a
    // git provider is always present, with or without explicit config.
    it("returns a git enrichment provider from the registry without config", () => {
      const { registry } = createComposition();
      const providers = registry.getAllEnrichmentProviders();
      expect(providers.some((p) => p.key === "git")).toBe(true);
    });

    it("threads git config through GitTrajectory to the registered provider", () => {
      // The provider should construct without throwing; full config
      // round-trip is verified by GitTrajectory unit tests. Here we only
      // verify the option plumbing accepts the shape and the resulting
      // composition is well-formed.
      const { registry } = createComposition({
        git: {
          config: { logMaxAgeMonths: 6, chunkMaxAgeMonths: 6 },
          squashOpts: { squashAwareSessions: true, sessionGapMinutes: 30 },
        },
      });
      expect(registry.getAllEnrichmentProviders().some((p) => p.key === "git")).toBe(true);
    });
  });

  // Regression guard (tea-rags-mcp-dz7f): the production composition wires a
  // WorkerEnrichmentDescriptor onto BOTH enrichment providers so the
  // WorkerPoolEnrichmentExecutor dispatches off-thread instead of silently
  // falling back to inline (which blocks the embedding event loop with git
  // blame). A regression that drops the descriptor would make every dispatch
  // method hit the `!provider.workerDescriptor` inline branch unnoticed.
  describe("worker-pool descriptor wiring (regression guard)", () => {
    let tmp: string;
    let graphDb: DuckDbGraphClient;
    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), "comp-wd-"));
      graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
      await graphDb.init();
    });
    afterAll(async () => {
      await graphDb.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it("surfaces a defined workerDescriptor on the git provider when supplied", () => {
      const gitDescriptor = {
        providerModulePath: "/abs/git/factory.js",
        providerFactoryExport: "createGitEnrichmentProvider",
        dispatch: "stateless" as const,
        serializableConfig: {},
      };
      const { registry } = createComposition({ git: { workerDescriptor: gitDescriptor } });
      const git = registry.getAllEnrichmentProviders().find((p) => p.key === "git");
      expect(git?.workerDescriptor).toBeDefined();
      expect(git?.workerDescriptor?.dispatch).toBe("stateless");
    });

    it("surfaces a defined workerDescriptor on the codegraph provider when supplied", () => {
      const codegraphDescriptor = {
        providerModulePath: "/abs/codegraph/factory.js",
        providerFactoryExport: "createCodegraphEnrichmentProvider",
        dispatch: "collection-affinity" as const,
        serializableConfig: {},
      };
      const { registry } = createComposition({
        codegraph: {
          pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()),
          workerDescriptor: codegraphDescriptor,
        },
      });
      const codegraph = registry.getAllEnrichmentProviders().find((p) => p.key === "codegraph.symbols");
      expect(codegraph?.workerDescriptor).toBeDefined();
      expect(codegraph?.workerDescriptor?.dispatch).toBe("collection-affinity");
    });
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
      const { registry, allPayloadSignalDescriptors, resolvedPresets } = createComposition({
        codegraph: {
          pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()),
        },
      });
      expect(registry.has("codegraph.symbols")).toBe(true);
      // Codegraph-owned payload signals are now part of the aggregated set.
      expect(allPayloadSignalDescriptors.find((s) => s.key === "codegraph.file.fanIn")).toBeDefined();
      expect(allPayloadSignalDescriptors.find((s) => s.key === "codegraph.chunk.fanOut")).toBeDefined();
      // Resolved presets include the codegraph family's contributions —
      // checking the count is robust to preset renames.
      expect(resolvedPresets.length).toBeGreaterThan(0);
    });

    // Slice 2 / Phase D foundation — composite presets (e.g. blastRadius
    // weights codegraph.fanIn + git.churn) live in their own namespace at
    // `domains/trajectory/composite/presets/` and are passed as the
    // SECOND arg to resolvePresets. Trajectory presets stay pure
    // (single-trajectory data). The override-by-(name,tools[i]) rule
    // means a composite with the same name as a trajectory preset wins,
    // without modifying the trajectory file. This test pins the new
    // contract: codegraph enabled → composite blastRadius reaches the
    // resolved set; codegraph disabled → blastRadius absent (its
    // signals would be unpopulated).
    it("composite blastRadius is in resolved presets only when codegraph is wired", () => {
      const withCodegraph = createComposition({
        codegraph: { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) },
      });
      const withoutCodegraph = createComposition();

      const blastRadiusWith = withCodegraph.resolvedPresets.find((p) => p.name === "blastRadius");
      const blastRadiusWithout = withoutCodegraph.resolvedPresets.find((p) => p.name === "blastRadius");
      expect(blastRadiusWith).toBeDefined();
      expect(blastRadiusWithout).toBeUndefined();
      // Retuned (Slice 2) weights — process metrics dominate per Yatish 2020.
      expect(blastRadiusWith?.weights.churn).toBe(0.2);
      expect(blastRadiusWith?.weights.fanIn).toBe(0.3);
    });

    // Phase D4 — composite presets that override trajectory presets by
    // (name, tools[i]). When codegraph is wired, every override below
    // wins resolution — the resolved preset's overlayMask contains
    // codegraph.file.fanIn (a key the trajectory preset never lists)
    // and the weights include a non-zero `fanIn` entry. Without
    // codegraph, the override is skipped and the trajectory preset
    // wins unchanged.
    it("composite overrides supersede trajectory presets for hotspots / techDebt / dangerous / ownership / securityAudit / codeReview", () => {
      const withCodegraph = createComposition({
        codegraph: { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) },
      });
      const withoutCodegraph = createComposition();
      const overriddenNames = ["hotspots", "techDebt", "dangerous", "ownership", "securityAudit", "codeReview"];

      for (const name of overriddenNames) {
        const compositeWeights = withCodegraph.resolvedPresets.find((p) => p.name === name)?.weights;
        const trajectoryWeights = withoutCodegraph.resolvedPresets.find((p) => p.name === name)?.weights;
        // Composite override adds a non-zero fanIn weight; trajectory
        // preset has no fanIn key at all (the override is the only
        // place where the codegraph signal participates in scoring).
        expect(compositeWeights?.fanIn, `composite ${name} should have fanIn weight`).toBeGreaterThan(0);
        expect(trajectoryWeights?.fanIn, `trajectory ${name} should NOT have fanIn weight`).toBeUndefined();
      }
    });

    it("architecturalHub is a new composite — present only when codegraph is wired", () => {
      const withCodegraph = createComposition({
        codegraph: { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) },
      });
      const withoutCodegraph = createComposition();

      const hub = withCodegraph.resolvedPresets.find((p) => p.name === "architecturalHub");
      expect(hub).toBeDefined();
      expect(hub?.weights.isHub).toBe(0.35);
      expect(hub?.weights.fanIn).toBe(0.2);
      expect(withoutCodegraph.resolvedPresets.find((p) => p.name === "architecturalHub")).toBeUndefined();
    });
  });
});
