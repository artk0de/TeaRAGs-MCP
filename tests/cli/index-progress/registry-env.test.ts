import { describe, expect, it } from "vitest";

import { pickRegistryEntry, resolveRegistryEnv } from "../../../src/cli/index-progress/registry-env.js";
import type { CollectionEntry } from "../../../src/core/infra/registry/types.js";

function entry(over: Partial<CollectionEntry>): CollectionEntry {
  return {
    collectionName: "code_x",
    path: "/repo",
    name: null,
    embeddingModel: "jina-v2",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-06-01T00:00:00Z",
    teaRagsVersion: "1.31.1",
    chunksCount: 10,
    ...over,
  };
}

interface FakeRegistry {
  findByName: (n: string) => CollectionEntry | null;
  findByPath: (p: string) => CollectionEntry | null;
  list: () => CollectionEntry[];
}

describe("resolveRegistryEnv", () => {
  it("maps registry fields to embedding + codegraph env vars", () => {
    const env = resolveRegistryEnv(
      entry({
        embeddingModel: "m1",
        embeddingBaseUrl: "http://host:11434",
        embeddingFallbackUrl: "http://localhost:11434",
        codegraphEnabled: true,
      }),
    );
    expect(env).toEqual({
      EMBEDDING_MODEL: "m1",
      EMBEDDING_BASE_URL: "http://host:11434",
      EMBEDDING_FALLBACK_URL: "http://localhost:11434",
      CODEGRAPH_ENABLED: "true",
    });
  });

  it("omits keys the entry does not carry", () => {
    const env = resolveRegistryEnv(entry({ embeddingBaseUrl: undefined, embeddingFallbackUrl: undefined }));
    expect(env).toEqual({ EMBEDDING_MODEL: "jina-v2" });
    expect("CODEGRAPH_ENABLED" in env).toBe(false);
  });

  it("returns an empty object for a null entry (empty registry)", () => {
    expect(resolveRegistryEnv(null)).toEqual({});
  });
});

describe("pickRegistryEntry", () => {
  const named = entry({ name: "alpha", path: "/a" });
  const byPath = entry({ name: "beta", path: "/b" });
  const older = entry({ name: "old", path: "/old", indexedAt: "2026-01-01T00:00:00Z" });
  const newer = entry({ name: "new", path: "/new", indexedAt: "2026-06-20T00:00:00Z" });

  const registry: FakeRegistry = {
    findByName: (n) => (n === "alpha" ? named : null),
    findByPath: (p) => (p === "/b" ? byPath : null),
    list: () => [older, newer],
  };

  it("resolves by project name when given", () => {
    expect(pickRegistryEntry(registry, { project: "alpha", path: "/whatever" })).toBe(named);
  });

  it("resolves a known path", () => {
    expect(pickRegistryEntry(registry, { path: "/b" })).toBe(byPath);
  });

  it("falls back to the most recently indexed project for a new path", () => {
    expect(pickRegistryEntry(registry, { path: "/unknown-new-project" })).toBe(newer);
  });

  it("returns null when the registry is empty and the path is unknown", () => {
    const empty: FakeRegistry = { findByName: () => null, findByPath: () => null, list: () => [] };
    expect(pickRegistryEntry(empty, { path: "/x" })).toBeNull();
  });
});
