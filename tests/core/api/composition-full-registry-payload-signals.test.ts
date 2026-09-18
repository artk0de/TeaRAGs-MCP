/**
 * The payload keys the FULL trajectory registry declares — the set a stale
 * Qdrant payload index is judged against (bd tea-rags-mcp-q34ic).
 *
 * Two properties make that judgement safe. The set must not depend on the flags
 * of the process that computes it: a run with codegraph off must not see the
 * codegraph keys as orphans. And it must cover every key a running composition
 * can register, or a new trajectory's lazily-created indexes read as orphans.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition, fullRegistryPayloadSignalDescriptors } from "../../../src/core/api/internal/composition.js";
import { toPhysicalPayloadKey } from "../../../src/core/contracts/signal-utils.js";
import { RankModule } from "../../../src/core/domains/explore/index.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function physicalKeys(descriptors: { key: string }[]): Set<string> {
  return new Set(descriptors.map((d) => toPhysicalPayloadKey(d.key)));
}

describe("fullRegistryPayloadSignalDescriptors", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "full-registry-"));
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

  it("covers every payload signal a composition with every trajectory registers", () => {
    const declared = physicalKeys(fullRegistryPayloadSignalDescriptors());
    const registered = physicalKeys(compositionWithEveryTrajectory().allPayloadSignalDescriptors);

    expect([...registered].filter((key) => !declared.has(key))).toEqual([]);
  });

  it("declares the codegraph keys even when the running composition leaves codegraph out", () => {
    const withoutCodegraph = physicalKeys(createComposition().allPayloadSignalDescriptors);
    const declared = physicalKeys(fullRegistryPayloadSignalDescriptors());

    expect(withoutCodegraph.has("codegraph.symbols.chunk.pageRank")).toBe(false);
    expect(declared.has("codegraph.symbols.chunk.pageRank")).toBe(true);
    expect(declared.has("codegraph.symbols.file.transitiveImpact")).toBe(true);
  });

  // The seven legacy `git.*` indexes came from RankModule's `git.` fallback: it
  // built `git.file.fanIn` for a codegraph source, and rank_chunks created a
  // payload index on whatever key it was about to order by. Every order_by key a
  // registered composition can produce must be a declared key, or rank_chunks
  // is still minting orphan indexes.
  // The historical shape of the bug: codegraph's derived signals resolved
  // without codegraph's payload descriptors. RankModule used to guess
  // `git.file.fanIn` there; it must order by nothing instead.
  it("orders by nothing when a derived signal's payload descriptors are absent", () => {
    const withCodegraph = compositionWithEveryTrajectory();
    const withoutCodegraph = createComposition();
    const codegraphOnly = withCodegraph.allDerivedSignals.filter(
      (signal) => !withoutCodegraph.allDerivedSignals.some((other) => other.name === signal.name),
    );
    const rankModule = new RankModule(
      withCodegraph.reranker,
      codegraphOnly,
      withoutCodegraph.allPayloadSignalDescriptors,
    );

    expect(codegraphOnly.length).toBeGreaterThan(0);
    for (const signal of codegraphOnly) {
      for (const level of ["chunk", "file"] as const) {
        expect(rankModule.resolveOrderByFields({ [signal.name]: 1 }, level), `${signal.name} @${level}`).toEqual([]);
      }
    }
  });

  it("leaves rank_chunks no order_by key outside the declared set, codegraph on or off", () => {
    const declared = physicalKeys(fullRegistryPayloadSignalDescriptors());

    for (const composition of [createComposition(), compositionWithEveryTrajectory()]) {
      const rankModule = new RankModule(
        composition.reranker,
        composition.allDerivedSignals,
        composition.allPayloadSignalDescriptors,
      );
      for (const signal of composition.allDerivedSignals) {
        for (const level of ["chunk", "file"] as const) {
          for (const { key } of rankModule.resolveOrderByFields({ [signal.name]: 1 }, level)) {
            expect(declared.has(key), `${signal.name} @${level} orders by undeclared ${key}`).toBe(true);
          }
        }
      }
    }
  });
});
