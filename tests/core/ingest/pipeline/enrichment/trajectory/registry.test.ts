import { describe, expect, it } from "vitest";

import { createEnrichmentProviders } from "../../../../../../src/core/ingest/pipeline/enrichment/trajectory/registry.js";
import type { CodeConfig } from "../../../../../../src/core/types.js";

describe("createEnrichmentProviders", () => {
  it("returns GitEnrichmentProvider when enableGitMetadata is true", () => {
    const config = { enableGitMetadata: true } as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(1);
    expect(providers[0].key).toBe("git");
  });

  it("returns empty array when enableGitMetadata is false", () => {
    const config = { enableGitMetadata: false } as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(0);
  });

  it("returns empty array when enableGitMetadata is undefined", () => {
    const config = {} as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(0);
  });
});
