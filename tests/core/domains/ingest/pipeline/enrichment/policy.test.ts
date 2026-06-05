import { describe, it, expect } from "vitest";

import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import { enrichmentScope } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/policy.js";

function providerWith(shouldEnrich?: EnrichmentProvider["shouldEnrich"]): EnrichmentProvider {
  return { key: "x", shouldEnrich } as unknown as EnrichmentProvider;
}

describe("enrichmentScope", () => {
  it("defaults to full when the provider has no shouldEnrich", () => {
    expect(enrichmentScope(providerWith(undefined), "app/models/user.rb")).toBe("full");
  });

  it("classifies and delegates: generated → provider decides none", () => {
    const p = providerWith((f) => (f.classification.isGenerated ? "none" : "full"));
    expect(enrichmentScope(p, "db/schema.rb")).toBe("none");
    expect(enrichmentScope(p, "app/models/user.rb")).toBe("full");
  });

  it("derives isDocumentation from the file language (markdown → file-only)", () => {
    const p = providerWith((f) => (f.classification.isDocumentation ? "file-only" : "full"));
    expect(enrichmentScope(p, "README.md")).toBe("file-only");
  });
});
