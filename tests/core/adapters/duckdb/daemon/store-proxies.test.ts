import { describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { DaemonOpCaller } from "../../../../../src/core/adapters/duckdb/daemon/op-channel.js";
import {
  DaemonGraphAnalyticsStoreProxy,
  DaemonGraphReadStoreProxy,
  DaemonStorageMaintenanceProxy,
  DaemonTemporalStoreProxy,
  UnsupportedDaemonReadError,
} from "../../../../../src/core/adapters/duckdb/daemon/store-proxies/index.js";
import { CodegraphSnapshotExportFailedError } from "../../../../../src/core/adapters/duckdb/errors.js";

/** A tolerated op meeting a daemon that predates it: the fallback answers. */
async function answerFromFallback<T>(
  _op: unknown,
  _params: unknown,
  _decode: unknown,
  fallback: () => T | Promise<T>,
): Promise<T> {
  return fallback();
}

/** An op caller whose tolerated ops always meet a daemon that predates them. */
function legacyDaemonCaller(answer: (op: string, params: unknown) => unknown): DaemonOpCaller {
  return {
    call: vi.fn(async (op: string, params: unknown) => answer(op, params)),
    callTolerated: answerFromFallback,
  };
}

describe("DaemonGraphReadStoreProxy", () => {
  it("degrades getFileMetricsBulk to the per-file reads, dropping all-zero roots", async () => {
    const answers: Record<string, Record<string, number>> = {
      getFanIn: { "a.ts": 2, "b.ts": 0 },
      getFanOut: { "a.ts": 1, "b.ts": 0 },
      getTransitiveImpact: { "a.ts": 3, "b.ts": 0 },
    };
    const caller = legacyDaemonCaller((op, params) => answers[op]?.[(params as { relPath: string }).relPath]);
    const proxy = new DaemonGraphReadStoreProxy(caller);

    const metrics = await proxy.getFileMetricsBulk(["a.ts", "b.ts"], 4);

    expect([...metrics.entries()]).toEqual([["a.ts", { fanIn: 2, fanOut: 1, transitiveImpact: 3 }]]);
    expect(caller.call).toHaveBeenCalledWith("getTransitiveImpact", { relPath: "a.ts", maxDepth: 4 });
  });

  it("rebuilds the callee-edge Map from the wire entries", async () => {
    const caller = legacyDaemonCaller(() => [["s", ["t1", "t2"]]]);
    const proxy = new DaemonGraphReadStoreProxy(caller);

    expect(await proxy.getCalleeEdges(["s"])).toEqual(new Map([["s", ["t1", "t2"]]]));
  });
});

describe("DaemonGraphAnalyticsStoreProxy", () => {
  it("streamAdjacency never crosses IPC — it throws on first iteration", async () => {
    const caller = legacyDaemonCaller(() => null);
    const proxy = new DaemonGraphAnalyticsStoreProxy(caller);

    await expect(proxy.streamAdjacency("file").next()).rejects.toBeInstanceOf(UnsupportedDaemonReadError);
    expect(caller.call).not.toHaveBeenCalled();
  });

  it("answers 'nothing moved' when the daemon predates diffSymbolSignals", async () => {
    const proxy = new DaemonGraphAnalyticsStoreProxy(legacyDaemonCaller(() => null));
    expect(await proxy.diffSymbolSignals()).toEqual({ symbols: [], files: [] });
  });
});

describe("DaemonStorageMaintenanceProxy", () => {
  it("refuses exportSnapshot with a typed error when the daemon predates the op", async () => {
    const proxy = new DaemonStorageMaintenanceProxy(
      legacyDaemonCaller(() => null),
      fixturePhysicalCollectionName("code_x_v1"),
    );
    await expect(proxy.exportSnapshot("/tmp/snap.duckdb")).rejects.toBeInstanceOf(CodegraphSnapshotExportFailedError);
  });

  it("reports compaction as skipped and leaves database file ops to the caller on a legacy daemon", async () => {
    const proxy = new DaemonStorageMaintenanceProxy(
      legacyDaemonCaller(() => null),
      fixturePhysicalCollectionName("code_x_v1"),
    );
    expect(await proxy.compactStorage()).toEqual({ kind: "skipped", reason: "unsupported" });
    expect(await proxy.removeCollectionDatabase(fixturePhysicalCollectionName("code_y_v1"))).toBeUndefined();
    expect(
      await proxy.cloneCollectionDatabase(
        fixturePhysicalCollectionName("code_x_v1"),
        fixturePhysicalCollectionName("code_y_v1"),
      ),
    ).toBe(false);
  });
});

describe("DaemonTemporalStoreProxy", () => {
  it("keeps an absent bundle map absent and rebuilds a present one", async () => {
    const proxy = new DaemonTemporalStoreProxy(
      legacyDaemonCaller(() => ({ files: [], pairs: [], bundles: [[1, ["a.ts"]]] })),
    );
    const graph = await proxy.readTemporalCochangeGraph();
    expect(graph.bundles).toEqual(new Map([[1, ["a.ts"]]]));
    expect("bundleCommits" in graph).toBe(false);
  });
});
