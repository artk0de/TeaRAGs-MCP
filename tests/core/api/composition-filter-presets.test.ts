/**
 * End-to-end integration tests for filter-preset registry assembly +
 * gating at the composition root.
 *
 * Mirrors `composition-gating.test.ts` (rerank-preset gating) for the
 * filter-preset axis: `createComposition` assembles the per-trajectory
 * filter-preset lists, gates them by registered trajectory keys, and
 * loads them into the registry via `setFilterPresets`. The MCP-visible
 * surface is `registry.filterPresetNames()`.
 *
 * Static filter presets are always-on. Git presets gate on "git";
 * codegraph presets gate on "codegraph.symbols"; composites gate via
 * their `requires` (battleTested/abandonedHotspots require git).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../src/core/api/index.js";
import { assembleFilterPresets } from "../../../src/core/api/internal/composition.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const STATIC_NAMES = ["production", "coreLogic", "securityPaths"];
const GIT_NAMES = ["panicZone", "fragileSilo", "freshLegacyEdits", "godMethods"];
const CODEGRAPH_NAMES = ["hubs", "deadCandidates", "unstableCore"];
const COMPOSITE_NAMES = ["battleTested", "abandonedHotspots"];

function makeCodegraphDeps(graphDb: DuckDbGraphClient) {
  return { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) };
}

describe("Composition — filter-preset registry assembly + gating", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "comp-filter-presets-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("all trajectories registered: static + git + codegraph + composite names present", () => {
    const { registry } = createComposition({ codegraph: makeCodegraphDeps(graphDb) });
    const names = new Set(registry.filterPresetNames());
    for (const name of [...STATIC_NAMES, ...GIT_NAMES, ...CODEGRAPH_NAMES, ...COMPOSITE_NAMES]) {
      expect(names.has(name), `${name} must be registered when all trajectories are on`).toBe(true);
    }
  });

  it("codegraph OFF: codegraph filter-preset names absent; static + git + composite present", () => {
    const { registry } = createComposition();
    const names = new Set(registry.filterPresetNames());
    for (const name of CODEGRAPH_NAMES) {
      expect(names.has(name), `${name} must be ABSENT when codegraph is OFF`).toBe(false);
    }
    for (const name of [...STATIC_NAMES, ...GIT_NAMES, ...COMPOSITE_NAMES]) {
      expect(names.has(name), `${name} must be present when codegraph is OFF (git still on)`).toBe(true);
    }
  });

  // createComposition always registers git, so the git-off gating branch is
  // exercised directly on the pure assembly helper (per Task 13 fallback).
  describe("assembleFilterPresets gating (pure helper)", () => {
    it("git NOT registered: git + composite names absent, static still present", () => {
      const names = new Set(assembleFilterPresets(new Set(["static"])).map((p) => p.name));
      for (const name of [...GIT_NAMES, ...COMPOSITE_NAMES]) {
        expect(names.has(name), `${name} must be ABSENT when git is OFF`).toBe(false);
      }
      for (const name of STATIC_NAMES) {
        expect(names.has(name), `${name} must be present (static is always-on)`).toBe(true);
      }
    });

    it("codegraph NOT registered: codegraph names absent", () => {
      const names = new Set(assembleFilterPresets(new Set(["static", "git"])).map((p) => p.name));
      for (const name of CODEGRAPH_NAMES) {
        expect(names.has(name)).toBe(false);
      }
      for (const name of [...STATIC_NAMES, ...GIT_NAMES, ...COMPOSITE_NAMES]) {
        expect(names.has(name)).toBe(true);
      }
    });

    it("all keys registered: full catalog assembled", () => {
      const names = new Set(assembleFilterPresets(new Set(["static", "git", "codegraph.symbols"])).map((p) => p.name));
      for (const name of [...STATIC_NAMES, ...GIT_NAMES, ...CODEGRAPH_NAMES, ...COMPOSITE_NAMES]) {
        expect(names.has(name)).toBe(true);
      }
    });
  });
});
