import { describe, expect, it } from "vitest";

import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import {
  enrichmentScope,
  filterChunkEnrichMap,
  filterFileEnrichPaths,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/policy.js";

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

describe("filterFileEnrichPaths", () => {
  it("returns all paths unchanged when provider has no shouldEnrich", () => {
    const p = providerWith(undefined);
    const paths = ["app/models/user.rb", "db/schema.rb", "README.md"];
    expect(filterFileEnrichPaths(p, paths)).toEqual(paths);
  });

  it("excludes paths classified as 'none' by shouldEnrich", () => {
    const p = providerWith((f) => (f.classification.isGenerated ? "none" : "full"));
    const paths = ["app/models/user.rb", "db/schema.rb"]; // schema.rb → generated → none
    const result = filterFileEnrichPaths(p, paths);
    expect(result).toContain("app/models/user.rb");
    expect(result).not.toContain("db/schema.rb");
  });
});

describe("filterChunkEnrichMap", () => {
  it("returns map unchanged when provider has no shouldEnrich", () => {
    const p = providerWith(undefined);
    const map = new Map([
      ["src/a.ts", 1],
      ["db/schema.rb", 2],
    ]);
    expect(filterChunkEnrichMap(p, map)).toBe(map); // same reference
  });

  it("keeps only 'full'-scope entries, excluding 'none' and 'file-only'", () => {
    const p = providerWith((f) => {
      if (f.classification.isGenerated) return "none";
      if (f.classification.isDocumentation) return "file-only";
      return "full";
    });
    const map = new Map([
      ["app/models/user.rb", "code"], // full
      ["db/schema.rb", "schema"], // none (generated)
      ["README.md", "docs"], // file-only
    ]);
    const result = filterChunkEnrichMap(p, map);
    expect(result.get("app/models/user.rb")).toBe("code");
    expect(result.has("db/schema.rb")).toBe(false);
    expect(result.has("README.md")).toBe(false);
  });
});
