import { describe, expect, it } from "vitest";

import {
  catalogEntryFor,
  EMBEDDING_MODEL_CATALOG,
  huggingFaceGgufSource,
} from "../../../../src/core/adapters/embeddings/model-catalog.js";
import { getModelDimensions } from "../../../../src/core/adapters/embeddings/utils/model-dimensions.js";

describe("EMBEDDING_MODEL_CATALOG", () => {
  it("lists jina, CodeRankEmbed and Muninn-small by their Hugging Face ids", () => {
    expect(EMBEDDING_MODEL_CATALOG.map((entry) => entry.id).sort()).toEqual([
      "brokkai/Muninn-small",
      "jinaai/jina-embeddings-v2-base-code",
      "nomic-ai/CodeRankEmbed",
    ]);
  });

  it.each(EMBEDDING_MODEL_CATALOG.map((entry) => [entry.id, entry] as const))(
    "%s: dimensions equal the model-dimensions registry",
    (id, entry) => {
      expect(entry.dimensions).toBe(getModelDimensions(id));
    },
  );

  it("carries the per-slot window of each model", () => {
    expect(catalogEntryFor("nomic-ai/CodeRankEmbed")?.window).toBe(2048);
    expect(catalogEntryFor("jinaai/jina-embeddings-v2-base-code")?.window).toBe(8192);
    expect(catalogEntryFor("brokkai/Muninn-small")?.window).toBe(8192);
  });

  it("pins every published GGUF by full revision, sha256 and byte size", () => {
    for (const entry of EMBEDDING_MODEL_CATALOG) {
      if (entry.gguf === null) continue;
      expect(entry.gguf.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.gguf.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.gguf.bytes).toBeGreaterThan(0);
      expect(entry.gguf.file).toMatch(/\.gguf$/);
    }
    expect(catalogEntryFor("jinaai/jina-embeddings-v2-base-code")?.gguf).toEqual({
      repo: "ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF",
      file: "jina-embeddings-v2-base-code-q8_0.gguf",
      revision: "05e79e9a6c8b99491e92ebb28d753268f8601e3c",
      sha256: "3bd1722f09350209aa3ada93df55882666c58194bfbbbe81c30545d731cb4e7a",
      bytes: 172869280,
    });
    expect(catalogEntryFor("nomic-ai/CodeRankEmbed")?.gguf).toEqual({
      repo: "brandtcormorant/CodeRankEmbed-Q8_0-GGUF",
      file: "coderankembed-q8_0.gguf",
      revision: "33bd774d16ed49b07e79e89c192751d11f47fec0",
      sha256: "666db8df27c88570cdc07adca28646260038b8ca65354911d57b936ebf56efaa",
      bytes: 146029792,
    });
  });

  it("marks Muninn-small unpublished until its GGUF is on Hugging Face", () => {
    expect(catalogEntryFor("brokkai/Muninn-small")?.gguf).toBeNull();
  });

  it("records the trained languages of each model card", () => {
    expect(catalogEntryFor("nomic-ai/CodeRankEmbed")?.trainedLanguages).toEqual([
      "python",
      "java",
      "javascript",
      "go",
      "php",
      "ruby",
    ]);
    expect(catalogEntryFor("brokkai/Muninn-small")?.trainedLanguages).toContain("typescript");
    expect(catalogEntryFor("jinaai/jina-embeddings-v2-base-code")?.trainedLanguages).toHaveLength(30);
  });

  it("answers undefined for an id outside the catalog", () => {
    expect(catalogEntryFor("unclemusclez/jina-embeddings-v2-base-code:latest")).toBeUndefined();
  });
});

describe("huggingFaceGgufSource", () => {
  it("builds the pinned resolve URL with the catalog sha256", () => {
    const entry = catalogEntryFor("nomic-ai/CodeRankEmbed");
    expect(entry?.gguf).not.toBeNull();
    expect(huggingFaceGgufSource(entry!.gguf!)).toEqual({
      url: "https://huggingface.co/brandtcormorant/CodeRankEmbed-Q8_0-GGUF/resolve/33bd774d16ed49b07e79e89c192751d11f47fec0/coderankembed-q8_0.gguf",
      sha256: "666db8df27c88570cdc07adca28646260038b8ca65354911d57b936ebf56efaa",
      fileName: "coderankembed-q8_0.gguf",
    });
  });
});
