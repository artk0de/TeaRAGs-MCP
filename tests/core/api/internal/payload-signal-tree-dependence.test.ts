/**
 * Every payload signal declares how it depends on the working tree
 * (bd tea-rags-mcp-39xca.20) — derived from the LIVE registry, never from a
 * hand-kept list: the overlay serves a dirty or linked tree's rows by applying
 * each descriptor's `treeDependence`, so an unclassified key would silently
 * inherit a possibly stale base value. The type makes the field required; this
 * pins the runtime half — a value outside the vocabulary (a cast, a JS
 * fixture) and a `line-count` signal its owning trajectory gives no formula.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import {
  createComposition,
  fullRegistryPayloadSignalTreeRecompute,
} from "../../../../src/core/api/internal/composition.js";
import type {
  PayloadSignalTreeDependence,
  PayloadSignalTreeRecompute,
} from "../../../../src/core/contracts/types/trajectory.js";
import { collectSymbols, DefaultSymbolIdComposer } from "../../../../src/core/domains/language/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const TREE_DEPENDENCES: ReadonlySet<PayloadSignalTreeDependence> = new Set([
  "history-only",
  "line-count",
  "tree-content",
  "tree-graph",
]);

/**
 * The `line-count` signals — the ones the overlay RECOMPUTES for a tree row.
 * Pinned so a reclassification is a reviewed diff, not a silent drift.
 */
const PINNED_LINE_COUNT_KEYS = ["git.file.relativeChurn"];

describe("payload signal tree dependence (registry-derived)", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "tree-dependence-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function liveRecompute(): PayloadSignalTreeRecompute {
    const composition = createComposition({
      codegraph: {
        pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()),
        composer: new DefaultSymbolIdComposer(),
        collectSymbols,
        exclusion: { customPatterns: [] },
      },
    });
    return composition.registry.getPayloadSignalTreeRecompute();
  }

  it("every registered payload signal declares a known tree dependence", () => {
    const { descriptors } = liveRecompute();
    expect(descriptors.length).toBeGreaterThan(0);
    const unclassified = descriptors
      .filter((descriptor) => !TREE_DEPENDENCES.has(descriptor.treeDependence))
      .map((descriptor) => descriptor.key);
    expect(unclassified).toEqual([]);
  });

  it("every line-count signal has its owning trajectory's formula, and every formula a line-count signal", () => {
    const { descriptors, lineCountFormulas } = liveRecompute();
    const lineCountKeys = descriptors.filter((d) => d.treeDependence === "line-count").map((d) => d.key);
    expect([...lineCountKeys].sort()).toEqual(PINNED_LINE_COUNT_KEYS);
    expect([...lineCountFormulas.keys()].sort()).toEqual([...lineCountKeys].sort());
  });

  it("the full-registry recompute the overlay is wired with matches a composition with every trajectory", () => {
    const live = liveRecompute();
    const full = fullRegistryPayloadSignalTreeRecompute();
    const policyOf = (recompute: PayloadSignalTreeRecompute) =>
      Object.fromEntries(recompute.descriptors.map((d) => [d.key, d.treeDependence]));
    expect(policyOf(full)).toEqual(policyOf(live));
    expect([...full.lineCountFormulas.keys()].sort()).toEqual([...live.lineCountFormulas.keys()].sort());
  });
});
