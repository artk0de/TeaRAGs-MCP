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
  fullRegistryPayloadSignalDescriptors,
} from "../../../src/core/api/internal/composition.js";
import { toPhysicalPayloadKey } from "../../../src/core/contracts/signal-utils.js";
import { RankModule } from "../../../src/core/domains/explore/index.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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
