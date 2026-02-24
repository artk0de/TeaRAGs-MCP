import { describe, expect, it } from "vitest";

import { GitEnrichmentProvider } from "../../../src/core/ingest/pipeline/enrichment/trajectory/git/provider.js";

describe("GitEnrichmentProvider", () => {
  it("has key 'git'", () => {
    const provider = new GitEnrichmentProvider();
    expect(provider.key).toBe("git");
  });

  it("implements EnrichmentProvider interface", () => {
    const provider = new GitEnrichmentProvider();
    expect(typeof provider.buildFileMetadata).toBe("function");
    expect(typeof provider.buildChunkMetadata).toBe("function");
    expect(typeof provider.resolveRoot).toBe("function");
  });

  it("has fileTransform for computeFileMetadata", () => {
    const provider = new GitEnrichmentProvider();
    expect(typeof provider.fileTransform).toBe("function");
  });
});
