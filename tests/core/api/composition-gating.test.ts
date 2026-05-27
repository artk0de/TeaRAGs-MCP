/**
 * End-to-end integration tests for declarative provider gating —
 * exercise `createComposition` + `Reranker.getPresetNames` together to
 * assert the MCP-visible surface shrinks/grows in lockstep with
 * `TrajectoryRegistry.getRegisteredKeys()`.
 *
 * The existing composition.test.ts covers the codegraph branch
 * specifically. This file pins the declarative gating contract: the
 * preset enum that a future MCP `list_tools` consumer sees is exactly
 * the union of registered-trajectory presets + composites whose
 * `requires` is satisfied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../src/core/api/index.js";
import type { CallResolver } from "../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const NEW_CODEGRAPH_COMPOSITES = ["blastRadius", "architecturalHub", "entryPoint"];
const OVERRIDE_COMPOSITES = ["hotspots", "techDebt", "dangerous", "ownership", "securityAudit", "codeReview"];

function makeCodegraphDeps(graphDb: DuckDbGraphClient) {
  const resolvers = new Map<string, CallResolver>([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]);
  // Wrap the single graphDb in a stub pool that returns the same
  // handle for every collection. This test never exercises the
  // codegraph DB — it only checks preset gating — so the single-DB
  // stub is sufficient.
  return { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()), resolvers };
}

describe("Composition + Reranker — end-to-end provider gating", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "comp-gating-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registry.getRegisteredKeys() reflects the actual composition", () => {
    const off = createComposition();
    expect(new Set(off.registry.getRegisteredKeys())).toEqual(new Set(["static", "git"]));

    const on = createComposition({ codegraph: makeCodegraphDeps(graphDb) });
    expect(new Set(on.registry.getRegisteredKeys())).toEqual(new Set(["static", "git", "codegraph.symbols"]));
  });

  it("codegraph OFF: NEW composites (blastRadius, architecturalHub, entryPoint) absent from preset enum", () => {
    const { reranker } = createComposition();
    const semanticPresets = new Set(reranker.getPresetNames("semantic_search"));
    for (const name of NEW_CODEGRAPH_COMPOSITES) {
      expect(semanticPresets.has(name), `${name} must NOT be in preset enum when codegraph is OFF`).toBe(false);
    }
  });

  it("codegraph ON: NEW composites present in preset enum", () => {
    const { reranker } = createComposition({ codegraph: makeCodegraphDeps(graphDb) });
    const semanticPresets = new Set(reranker.getPresetNames("semantic_search"));
    for (const name of NEW_CODEGRAPH_COMPOSITES) {
      expect(semanticPresets.has(name), `${name} must be in preset enum when codegraph is ON`).toBe(true);
    }
  });

  it("codegraph OFF: override composites fall back to trajectory presets (resolved by name, not weighted with fanIn)", () => {
    const { resolvedPresets } = createComposition();
    for (const name of OVERRIDE_COMPOSITES) {
      const preset = resolvedPresets.find((p) => p.name === name);
      // The trajectory preset of the same name is still resolved — composite override is the one that's gone.
      expect(preset).toBeDefined();
      // Trajectory preset's weights MUST NOT include fanIn — that's the composite's contribution.
      expect(preset?.weights.fanIn ?? 0).toBe(0);
    }
  });

  it("codegraph ON: override composites win resolution (weights include fanIn)", () => {
    const { resolvedPresets } = createComposition({ codegraph: makeCodegraphDeps(graphDb) });
    for (const name of OVERRIDE_COMPOSITES) {
      const preset = resolvedPresets.find((p) => p.name === name);
      expect(preset).toBeDefined();
      // Composite override's weights MUST include a non-zero fanIn.
      expect(preset?.weights.fanIn ?? 0).toBeGreaterThan(0);
    }
  });

  it("codegraph OFF: codegraph-owned derived signals (pageRank, transitiveImpact) absent from descriptorInfo", () => {
    const { reranker } = createComposition();
    const names = new Set(reranker.getDescriptorInfo().map((d) => d.name));
    expect(names.has("pageRank")).toBe(false);
    expect(names.has("transitiveImpact")).toBe(false);
    expect(names.has("isHub")).toBe(false);
  });

  it("codegraph ON: codegraph-owned derived signals present in descriptorInfo", () => {
    const { reranker } = createComposition({ codegraph: makeCodegraphDeps(graphDb) });
    const names = new Set(reranker.getDescriptorInfo().map((d) => d.name));
    expect(names.has("pageRank")).toBe(true);
    expect(names.has("transitiveImpact")).toBe(true);
    expect(names.has("isHub")).toBe(true);
  });
});
