import { describe, expect, it } from "vitest";

import type { EnrichmentProvider, WorkerEnrichmentDescriptor } from "../../../../src/core/contracts/types/provider.js";

describe("WorkerEnrichmentDescriptor + EnrichmentProvider.onRelease", () => {
  it("is structured-clone-safe with stateless dispatch (git-shape config)", () => {
    const desc: WorkerEnrichmentDescriptor = {
      providerModulePath: "/abs/path/to/git-provider.js",
      providerFactoryExport: "createGitEnrichmentProvider",
      dispatch: "stateless",
      serializableConfig: {
        repoRoot: "/repo",
        logMaxAgeMonths: 12,
        logTimeoutMs: 60000,
        chunkConcurrency: 10,
      },
    };
    // structuredClone is the worker_threads transport — descriptor MUST survive it.
    expect(structuredClone(desc)).toEqual(desc);
  });

  it("is structured-clone-safe with collection-affinity dispatch (codegraph-shape config)", () => {
    const desc: WorkerEnrichmentDescriptor = {
      providerModulePath: "/abs/path/to/codegraph-provider.js",
      providerFactoryExport: "createCodegraphEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: {
        languageModulePath: "/abs/path/to/language-module.js",
        daemonSocketPath: "/tmp/tea-rags-codegraph.sock",
        collectionName: "code_8b243ffe",
        excludedPaths: ["**/test/**", "**/node_modules/**"],
      },
    };
    expect(structuredClone(desc)).toEqual(desc);
  });

  it("accepts an EnrichmentProvider that omits workerDescriptor and onRelease (inline-only)", () => {
    const minimal: Pick<
      EnrichmentProvider,
      | "key"
      | "signals"
      | "derivedSignals"
      | "filters"
      | "presets"
      | "resolveRoot"
      | "buildFileSignals"
      | "buildChunkSignals"
    > = {
      key: "test",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: (p) => p,
      buildFileSignals: async () => new Map(),
      buildChunkSignals: async () => new Map(),
    };
    const valid: EnrichmentProvider = minimal;
    expect(valid.workerDescriptor).toBeUndefined();
    expect(valid.onRelease).toBeUndefined();
  });

  it("attaches workerDescriptor + onRelease as optional members of EnrichmentProvider", async () => {
    let released = 0;
    const provider: EnrichmentProvider = {
      key: "fake",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: (p) => p,
      buildFileSignals: async () => new Map(),
      buildChunkSignals: async () => new Map(),
      workerDescriptor: {
        providerModulePath: "/abs/factory.js",
        providerFactoryExport: "createFakeProvider",
        dispatch: "stateless",
        serializableConfig: { ok: true },
      },
      onRelease: async () => {
        released++;
      },
    };
    expect(provider.workerDescriptor?.dispatch).toBe("stateless");
    await provider.onRelease?.();
    expect(released).toBe(1);
  });
});
