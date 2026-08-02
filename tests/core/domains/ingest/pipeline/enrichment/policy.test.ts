import { describe, expect, it } from "vitest";

import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import {
  enrichmentScope,
  enrichmentSkipReason,
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

describe("enrichmentSkipReason", () => {
  const declineGenerated = providerWith((f) => (f.classification.isGenerated ? "none" : "full"));
  const gitLike = providerWith((f) => {
    if (f.classification.isGenerated) return "none";
    if (f.classification.isDocumentation) return "file-only";
    return "full";
  });

  it("declines nothing when the provider has no shouldEnrich", () => {
    const p = providerWith(undefined);
    expect(enrichmentSkipReason(p, "db/schema.rb", "file")).toBeNull();
    expect(enrichmentSkipReason(p, "README.md", "chunk")).toBeNull();
  });

  it("returns null for a path the provider enriches at that level", () => {
    expect(enrichmentSkipReason(declineGenerated, "app/models/user.rb", "file")).toBeNull();
    expect(enrichmentSkipReason(declineGenerated, "app/models/user.rb", "chunk")).toBeNull();
  });

  it("names the classification behind the decline: generated", () => {
    expect(enrichmentSkipReason(declineGenerated, "db/schema.rb", "file")).toBe("generated");
    expect(enrichmentSkipReason(declineGenerated, "db/schema.rb", "chunk")).toBe("generated");
  });

  it("is level-aware: file-only leaves the file level owed and declines only the chunk level", () => {
    expect(enrichmentSkipReason(gitLike, "README.md", "file")).toBeNull();
    expect(enrichmentSkipReason(gitLike, "README.md", "chunk")).toBe("documentation");
  });

  it("names test when the provider declines test files", () => {
    const p = providerWith((f) => (f.classification.isTest ? "none" : "full"));
    expect(enrichmentSkipReason(p, "spec/models/user_spec.rb", "file")).toBe("test");
  });

  it("falls back to 'policy' when no classification flag explains the decline", () => {
    // A provider may decline for a reason of its own; the point still has to be
    // stamped, otherwise it stays in the recovery scan forever.
    const p = providerWith(() => "none");
    expect(enrichmentSkipReason(p, "app/models/user.rb", "file")).toBe("policy");
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
