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
      QDRANT_URL: "http://127.0.0.1:6333",
      CODEGRAPH_ENABLED: "true",
    });
  });

  it("omits keys the entry does not carry", () => {
    const env = resolveRegistryEnv(entry({ embeddingBaseUrl: undefined, embeddingFallbackUrl: undefined }));
    expect(env).toEqual({ EMBEDDING_MODEL: "jina-v2", QDRANT_URL: "http://127.0.0.1:6333" });
    expect("CODEGRAPH_ENABLED" in env).toBe(false);
  });

  it("returns an empty object for a null entry (empty registry)", () => {
    expect(resolveRegistryEnv(null)).toEqual({});
  });

  it("injects the tuning snapshot keys verbatim so the worker runs with index-time tuning", () => {
    const env = resolveRegistryEnv(
      entry({
        tuning: {
          TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
          INGEST_TUNE_FILE_CONCURRENCY: "25",
          QDRANT_TUNE_UPSERT_BATCH_SIZE: "512",
        },
      }),
    );
    expect(env.TRAJECTORY_GIT_CHUNK_CONCURRENCY).toBe("5");
    expect(env.INGEST_TUNE_FILE_CONCURRENCY).toBe("25");
    expect(env.QDRANT_TUNE_UPSERT_BATCH_SIZE).toBe("512");
  });

  it("adds no tuning keys when the entry has no tuning snapshot (legacy entry)", () => {
    const env = resolveRegistryEnv(entry({ embeddingBaseUrl: undefined, embeddingFallbackUrl: undefined }));
    expect(env).toEqual({ EMBEDDING_MODEL: "jina-v2", QDRANT_URL: "http://127.0.0.1:6333" });
  });

  it("skips empty-string tuning values (hand-edited registry) so they don't poison the env", () => {
    const env = resolveRegistryEnv(entry({ tuning: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "" } }));
    expect("TRAJECTORY_GIT_CHUNK_CONCURRENCY" in env).toBe(false);
  });

  it("maps qdrantUrl to a QDRANT_URL env var so the worker reuses the last backend", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://192.168.1.71:6333" }));
    expect(env.QDRANT_URL).toBe("http://192.168.1.71:6333");
  });

  it("omits QDRANT_URL when qdrantUrl is an empty string (recovered stub)", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "" }));
    expect("QDRANT_URL" in env).toBe(false);
  });

  it("seeds the embedded marker (not the frozen port) for an embedded entry so the worker re-resolves the daemon", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://127.0.0.1:57331", qdrantEmbedded: true }));
    expect(env.QDRANT_URL).toBe("embedded");
  });

  it("seeds the literal qdrantUrl for an external (non-embedded) entry", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://remote-host:6333", qdrantEmbedded: false }));
    expect(env.QDRANT_URL).toBe("http://remote-host:6333");
  });

  it("seeds the embedded marker for a legacy entry (no qdrantEmbedded flag) on a 127.0.0.1 ephemeral port", () => {
    // Pre-flag registry entry: qdrantEmbedded absent, qdrantUrl frozen at the
    // embedded daemon's old ephemeral port. The daemon rebinds on restart, so
    // pinning the frozen port fails with "not reachable". Re-seed the marker.
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://127.0.0.1:57331", qdrantEmbedded: undefined }));
    expect(env.QDRANT_URL).toBe("embedded");
  });

  it("keeps 127.0.0.1:6333 literal for a legacy entry (external Docker default, not the embedded daemon)", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://127.0.0.1:6333", qdrantEmbedded: undefined }));
    expect(env.QDRANT_URL).toBe("http://127.0.0.1:6333");
  });

  it("keeps a loopback ephemeral port literal when qdrantEmbedded is explicitly false (flag wins over heuristic)", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://127.0.0.1:6334", qdrantEmbedded: false }));
    expect(env.QDRANT_URL).toBe("http://127.0.0.1:6334");
  });

  it("keeps localhost (non-127.0.0.1) literal for a legacy entry — shim is scoped to the daemon's 127.0.0.1 shape", () => {
    const env = resolveRegistryEnv(entry({ qdrantUrl: "http://localhost:6334", qdrantEmbedded: undefined }));
    expect(env.QDRANT_URL).toBe("http://localhost:6334");
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
