/**
 * The payload index set a build declares (bd tea-rags-mcp-mimq0): what the
 * `payloadIndexes` reconcile creates on every collection, and what it accepts
 * as present without reporting it undeclared.
 *
 * The REQUIRED half must cover every field rank_chunks can order by, codegraph
 * on or off — those are the indexes `ScrollRankStrategy` used to create lazily,
 * so each collection held only the ones its own query history had touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import {
  payloadFieldIndexSchema,
  SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS,
} from "../../../src/core/adapters/qdrant/schema-manager.js";
import {
  createComposition,
  declaredPayloadIndexSet,
  fullRegistryDerivedSignals,
  fullRegistryFilterPresets,
  fullRegistryFilters,
  fullRegistryPayloadSignalDescriptors,
} from "../../../src/core/api/internal/composition.js";
import { toPhysicalPayloadKey } from "../../../src/core/contracts/signal-utils.js";
import type { FilterDescriptor } from "../../../src/core/contracts/types/provider.js";
import { RankModule } from "../../../src/core/domains/explore/index.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { filterPayloadKeys } from "../../../src/core/domains/trajectory/filter-payload-keys.js";
import { compileFilterPreset } from "../../../src/core/domains/trajectory/filter-presets/compiler.js";

describe("declaredPayloadIndexSet", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "declared-indexes-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function compositionWithEveryTrajectory() {
    return createComposition({ codegraph: { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) } });
  }

  it("fullRegistryDerivedSignals covers every derived signal a composition with every trajectory registers", () => {
    const declared = new Set(fullRegistryDerivedSignals().map((signal) => signal.name));
    const registered = compositionWithEveryTrajectory().allDerivedSignals.map((signal) => signal.name);

    expect(registered.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("requires every field rank_chunks can order by, with the schema its declaration implies", () => {
    const { required } = declaredPayloadIndexSet();

    for (const composition of [createComposition(), compositionWithEveryTrajectory()]) {
      const rankModule = new RankModule(
        composition.reranker,
        composition.allDerivedSignals,
        composition.allPayloadSignalDescriptors,
      );
      const types = new Map(
        composition.allPayloadSignalDescriptors.map((d) => [toPhysicalPayloadKey(d.key), d.type] as const),
      );
      for (const signal of composition.allDerivedSignals) {
        for (const level of ["chunk", "file"] as const) {
          for (const { key } of rankModule.resolveOrderByFields({ [signal.name]: 1 }, level)) {
            expect(required.get(key), `${signal.name} @${level} → ${key}`).toBe(
              payloadFieldIndexSchema(key, types.get(key)!),
            );
          }
        }
      }
    }
  });

  // Qdrant answers order_by only over a range index, so a key rank_chunks
  // orders by but no index schema serves (an unpinned `timestamp`) would fail
  // the scroll instead of ranking — the age/recency legs order by the pinned
  // `git.*.lastModifiedAt` integer indexes (bd tea-rags-mcp-xi2r9).
  it("orders only by keys some index schema serves", () => {
    const composition = compositionWithEveryTrajectory();
    const rankModule = new RankModule(
      composition.reranker,
      composition.allDerivedSignals,
      composition.allPayloadSignalDescriptors,
    );
    const types = new Map(
      composition.allPayloadSignalDescriptors.map((d) => [toPhysicalPayloadKey(d.key), d.type] as const),
    );
    const unserved: string[] = [];
    for (const signal of composition.allDerivedSignals) {
      for (const level of ["chunk", "file"] as const) {
        for (const { key } of rankModule.resolveOrderByFields({ [signal.name]: 1 }, level)) {
          if (payloadFieldIndexSchema(key, types.get(key)!) === undefined) unserved.push(key);
        }
      }
    }

    expect(unserved).toEqual([]);
    expect(
      rankModule
        .resolveOrderByFields({ recency: 1 }, "chunk")
        .map(({ key }) => payloadFieldIndexSchema(key, "timestamp")),
    ).toEqual(["integer"]);
  });

  // The keys the bead measured: taxdome lacked the first five, the self-index
  // the last — each collection had only what its rank_chunks history created.
  it("requires every key the two live collections disagreed on", () => {
    const { required } = declaredPayloadIndexSet();

    expect(
      Object.fromEntries(
        [
          "methodLines",
          "methodDensity",
          "moduleMethodCount",
          "git.chunk.relativeChurn",
          "git.file.recencyWeightedFreq",
          "git.file.recentDominantAuthorPct",
        ].map((key) => [key, required.get(key)]),
      ),
    ).toEqual({
      methodLines: "float",
      methodDensity: "float",
      moduleMethodCount: "float",
      "git.chunk.relativeChurn": "float",
      "git.file.recencyWeightedFreq": "float",
      "git.file.recentDominantAuthorPct": "float",
    });
  });

  it("fullRegistryFilters and fullRegistryFilterPresets cover what a composition with every trajectory registers", () => {
    const composition = compositionWithEveryTrajectory();
    const params = new Set(fullRegistryFilters().map((filter) => filter.param));
    const presets = new Set(fullRegistryFilterPresets().map((preset) => preset.name));

    expect(composition.registry.getAllFilters().filter((filter) => !params.has(filter.param))).toEqual([]);
    expect(composition.registry.filterPresetNames().filter((name) => !presets.has(name))).toEqual([]);
  });

  // bd tea-rags-mcp-18xh5: a filter never created an index, so every key only
  // a filter reads was a full payload scan on every collection — `isTest`
  // among them, which the default production filter preset reads on nearly
  // every search. The oracle probes each registered filter with a battery of
  // its own, independent of the values a descriptor declares.
  it("requires every key a registered filter or filter preset can condition on", () => {
    const { required } = declaredPayloadIndexSet();
    const battery: Record<FilterDescriptor["type"], unknown[]> = {
      string: ["only", "exclude", "include", "x", "!x", "src/**", "2024-01-01"],
      number: [0, 1, 0.5],
      boolean: [true, false],
      "string[]": [["x"], []],
    };

    for (const composition of [createComposition(), compositionWithEveryTrajectory()]) {
      const types = new Map(fullRegistryPayloadSignalDescriptors().map((d) => [toPhysicalPayloadKey(d.key), d.type]));
      const emitted = new Set<string>();
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) collect(item);
          return;
        }
        if (node === null || typeof node !== "object") return;
        const condition = node as Record<string, unknown>;
        if (typeof condition.key === "string") emitted.add(condition.key);
        const isEmpty = condition.is_empty as { key?: unknown } | undefined;
        if (typeof isEmpty?.key === "string") emitted.add(isEmpty.key);
        for (const clause of ["must", "must_not", "should"]) collect(condition[clause]);
      };
      for (const filter of composition.registry.getAllFilters()) {
        for (const level of [undefined, "file", "chunk"] as const) {
          for (const value of battery[filter.type]) collect(filter.toCondition(value, level));
        }
      }
      for (const name of composition.registry.filterPresetNames()) {
        collect(compileFilterPreset(composition.registry.getFilterPresetDef(name)!, undefined, "chunk"));
      }

      for (const key of emitted) {
        const type = types.get(key);
        expect(required.has(key), key).toBe(true);
        if (type !== undefined) expect(required.get(key), key).toBe(payloadFieldIndexSchema(key, type));
      }
    }
  });

  // A descriptor whose toCondition branches on an enumeration must declare its
  // `values`, or the probe learns nothing from it.
  it("learns at least one key from every registered filter descriptor", () => {
    for (const filter of compositionWithEveryTrajectory().registry.getAllFilters()) {
      expect(filterPayloadKeys([filter], []).size, filter.param).toBeGreaterThan(0);
    }
  });

  // The four keys the bead measured missing on both live collections, plus
  // the email arm of recentAuthor, which no payload signal descriptor names.
  it("requires the filter-only keys both live collections lacked", () => {
    const { required } = declaredPayloadIndexSet();

    expect(
      Object.fromEntries(
        [
          "isTest",
          "isDocumentation",
          "git.file.recentContributorCount",
          "git.file.recentDominantAuthor",
          "git.file.recentDominantAuthorEmail",
        ].map((key) => [key, required.get(key)]),
      ),
    ).toEqual({
      isTest: "bool",
      isDocumentation: "bool",
      "git.file.recentContributorCount": "float",
      "git.file.recentDominantAuthor": "keyword",
      "git.file.recentDominantAuthorEmail": "keyword",
    });
  });

  it("requires the schema pipeline's own indexes, with the schema initializeSchema creates them with", () => {
    const { required } = declaredPayloadIndexSet();

    for (const key of SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS) {
      expect(required.get(key), key).toBe(payloadFieldIndexSchema(key, "number"));
    }
  });

  // A declared payload signal nothing orders by (`startLine`) is not created,
  // but an index on it is not undeclared either — v16 kept it on the same
  // grounds.
  it("knows every full-registry payload key without requiring the ones nothing orders by", () => {
    const { required, known } = declaredPayloadIndexSet();

    for (const descriptor of fullRegistryPayloadSignalDescriptors()) {
      expect(known.has(toPhysicalPayloadKey(descriptor.key)), descriptor.key).toBe(true);
    }
    expect(required.has("startLine")).toBe(false);
  });
});
