import { describe, expect, it } from "vitest";

import {
  EMBEDDING_MODEL_CATALOG,
  type EmbeddingModelCatalogEntry,
} from "../../../../src/core/adapters/embeddings/model-catalog.js";
import {
  MUNINN_COVERAGE_THRESHOLD,
  RUBY_SHARE_THRESHOLD,
  selectEmbeddingModelForLanguages,
  SWIFT_SHARE_THRESHOLD,
} from "../../../../src/core/adapters/embeddings/model-choice.js";

/** The shipped catalog with Muninn-small published, as it will be once its GGUF is on Hugging Face. */
const CATALOG_WITH_MUNINN_PUBLISHED: readonly EmbeddingModelCatalogEntry[] = EMBEDDING_MODEL_CATALOG.map((entry) =>
  entry.id === "brokkai/Muninn-small"
    ? {
        ...entry,
        gguf: {
          repo: "tea-rags/Muninn-small-GGUF",
          file: "muninn-small-f16.gguf",
          revision: "a".repeat(40),
          sha256: "b".repeat(64),
          bytes: 1,
        },
      }
    : entry,
);

describe("selectEmbeddingModelForLanguages", () => {
  it("exposes the installer thresholds", () => {
    expect(RUBY_SHARE_THRESHOLD).toBe(0.05);
    expect(SWIFT_SHARE_THRESHOLD).toBe(0.05);
    expect(MUNINN_COVERAGE_THRESHOLD).toBe(0.8);
  });

  it("picks CodeRankEmbed when Ruby reaches 5% of code LOC", () => {
    const choice = selectEmbeddingModelForLanguages({ ruby: 0.06, typescript: 0.94 });
    expect(choice.model.id).toBe("nomic-ai/CodeRankEmbed");
    expect(choice.rule).toContain("ruby");
  });

  it("picks CodeRankEmbed when Swift reaches 5% of code LOC", () => {
    const choice = selectEmbeddingModelForLanguages({ swift: 0.5, python: 0.5 });
    expect(choice.model.id).toBe("nomic-ai/CodeRankEmbed");
    expect(choice.rule).toContain("swift");
  });

  it("falls through to CodeRankEmbed while Muninn-small is unpublished, naming the fall-through", () => {
    const choice = selectEmbeddingModelForLanguages({ typescript: 0.9, python: 0.1 });
    expect(choice.model.id).toBe("nomic-ai/CodeRankEmbed");
    expect(choice.rule).toContain("Muninn");
    expect(choice.rule).toContain("not published");
  });

  it("picks Muninn-small for Muninn-covered languages once it is published", () => {
    const choice = selectEmbeddingModelForLanguages({ typescript: 0.9, python: 0.1 }, CATALOG_WITH_MUNINN_PUBLISHED);
    expect(choice.model.id).toBe("brokkai/Muninn-small");
  });

  it("picks jina otherwise", () => {
    const choice = selectEmbeddingModelForLanguages({ elixir: 0.7, typescript: 0.3 });
    expect(choice.model.id).toBe("jinaai/jina-embeddings-v2-base-code");
  });

  it("applies the rules in spec order: Ruby beats Muninn coverage", () => {
    const choice = selectEmbeddingModelForLanguages({ ruby: 0.05, typescript: 0.95 }, CATALOG_WITH_MUNINN_PUBLISHED);
    expect(choice.model.id).toBe("nomic-ai/CodeRankEmbed");
  });

  it("stays below a threshold until it is reached", () => {
    const choice = selectEmbeddingModelForLanguages({ ruby: 0.04, elixir: 0.96 });
    expect(choice.model.id).toBe("jinaai/jina-embeddings-v2-base-code");
  });
});
