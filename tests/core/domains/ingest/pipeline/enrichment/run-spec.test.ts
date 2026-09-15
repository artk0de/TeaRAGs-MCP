import { describe, expect, it } from "vitest";

import {
  ALL_LANGUAGES,
  finalizeOnlyRunSpec,
  fullIndexRunSpec,
  recomputeRunSpec,
  reindexRunSpec,
  runCoverageOf,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";

/**
 * bd tea-rags-mcp-39xca.3 — one factory per entry point that opens an enrichment
 * run, so each call site states what part of the corpus its run resolves instead
 * of leaning on positional defaults. Run coverage is derived from the scope, and
 * "the whole collection" is spelled out as `ALL_LANGUAGES`, never implied.
 */
describe("EnrichmentRunSpec factories", () => {
  it("a full index resolves the whole corpus of every language, cross-pass as the pipeline decides", () => {
    const spec = fullIndexRunSpec({ absolutePath: "/repo", collection: "code_v2", fileCount: 12, crossPass: true });

    expect(spec.scope).toEqual({ kind: "wholeCorpus", languages: ALL_LANGUAGES });
    expect(spec).toMatchObject({ absolutePath: "/repo", collection: "code_v2", fileCount: 12, crossPass: true });
    expect(runCoverageOf(spec.scope)).toBe("wholeCorpus");
  });

  it("a reindex resolves a subset and never runs the cross-pass", () => {
    const spec = reindexRunSpec({ absolutePath: "/repo", collection: "code_v2", fileCount: 3 });

    expect(spec.scope).toEqual({ kind: "subset", languages: ALL_LANGUAGES });
    expect(spec.crossPass).toBe(false);
    expect(runCoverageOf(spec.scope)).toBe("subset");
  });

  it("a recompute resolves the whole corpus of the languages it was asked for, with its providers", () => {
    const spec = recomputeRunSpec({
      absolutePath: "/repo",
      collection: "code_v2",
      fileCount: 40,
      onlyProviderKeys: ["codegraph.symbols"],
      languages: ["typescript"],
    });

    expect(spec.scope).toEqual({ kind: "wholeCorpus", languages: ["typescript"] });
    expect(spec.onlyProviderKeys).toEqual(["codegraph.symbols"]);
    expect(spec.crossPass).toBe(false);
  });

  it("a finalize-only close resolves a subset over no streamed files", () => {
    const spec = finalizeOnlyRunSpec({ absolutePath: "/repo", collection: "code_v2" });

    expect(spec.scope).toEqual({ kind: "subset", languages: ALL_LANGUAGES });
    expect(spec).toMatchObject({ fileCount: 0, crossPass: false });
  });
});
