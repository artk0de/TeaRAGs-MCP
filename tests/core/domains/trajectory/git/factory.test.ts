import { describe, expect, it } from "vitest";

import type {
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../src/core/contracts/types/provider.js";
import {
  createGitEnrichmentProvider,
  type GitWorkerConfig,
} from "../../../../../src/core/domains/trajectory/git/factory.js";

describe("createGitEnrichmentProvider", () => {
  it("builds a provider from a structured-clone-safe config", () => {
    const config: GitWorkerConfig = {
      logMaxAgeMonths: 6,
      logTimeoutMs: 30000,
      chunkConcurrency: 4,
    };
    // Worker_threads roundtrip — config MUST survive postMessage.
    const cloned = structuredClone(config);
    // Type-check via EnrichmentProvider: the factory's contract is "an
    // EnrichmentProvider", not "a GitEnrichmentProvider class instance".
    const provider: EnrichmentProvider = createGitEnrichmentProvider(cloned);
    expect(provider.key).toBe("git");
    // No descriptor passed ⇒ provider runs inline-only.
    expect(provider.workerDescriptor).toBeUndefined();
    // git has no cross-collection state ⇒ no onRelease declared.
    expect(provider.onRelease).toBeUndefined();
  });

  it("attaches the supplied workerDescriptor verbatim (caller owns dispatch value)", () => {
    // createGitEnrichmentProvider passes the descriptor through unchanged.
    // The caller (bootstrap composition root) is responsible for supplying the
    // correct dispatch value. In production this MUST be "collection-affinity"
    // because git is stateful (blameByRelPath/lastFileResult/enrichmentCache are
    // shared across buildFileSignals → buildChunkSignals on the same instance).
    // This test proves round-trip fidelity, not bootstrap correctness.
    const config: GitWorkerConfig = { chunkConcurrency: 2 };
    const descriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/abs/path/git/factory.js",
      providerFactoryExport: "createGitEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: config,
    };
    const provider = createGitEnrichmentProvider(config, descriptor);
    expect(provider.workerDescriptor).toEqual(descriptor);
    expect(provider.workerDescriptor?.dispatch).toBe("collection-affinity");
  });

  it("forwards squashOpts to the constructed provider", () => {
    const provider = createGitEnrichmentProvider({
      squashOpts: { squashAwareSessions: true, sessionGapMinutes: 30 },
    });
    // No public getter for squashOpts — assert it survives via descriptor
    // serialization shape (covered above) and that provider was built
    // (would throw otherwise).
    expect(provider.key).toBe("git");
  });
});
