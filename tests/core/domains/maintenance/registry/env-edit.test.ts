/**
 * Editing a project's registry env from configuration rather than from an
 * indexing run (bd tea-rags-mcp-5uk75).
 *
 * The registry stores ONE canonical spelling per alias family, and a few keys
 * live in dedicated `CollectionEntry` fields instead of the `env` map
 * (`DEDICATED_FIELD_ENV_KEYS`). An edit must land where replay reads it, or
 * the next run never sees it.
 */
import { describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import {
  applyRegistryEnvEdit,
  editRegistryEnv,
  INDEX_RECORDED_ENV_KEYS,
} from "../../../../../src/core/domains/maintenance/registry/env-edit.js";

function entry(overrides: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_a",
    path: "/repo/a",
    name: "alpha",
    embeddingModel: "m",
    embeddingDimensions: 768,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-09-01T00:00:00.000Z",
    teaRagsVersion: "1.44.2",
    chunksCount: 10,
    ...overrides,
  };
}

describe("editRegistryEnv", () => {
  it("stores a deprecated spelling under its canonical key and evicts the family's other spellings", () => {
    const next = editRegistryEnv(
      { EMBEDDING_CONCURRENCY: "2", INGEST_PIPELINE_CONCURRENCY: "3", GIT_ADAPTER: "cli" },
      { set: { EMBEDDING_CONCURRENCY: "8" } },
    );
    expect(next).toEqual({ INGEST_PIPELINE_CONCURRENCY: "8", GIT_ADAPTER: "cli" });
  });

  it("unsets every spelling of the family a key belongs to", () => {
    const next = editRegistryEnv(
      { INGEST_CHUNK_SIZE: "2000", CODE_CHUNK_SIZE: "1500", GIT_ADAPTER: "cli" },
      { unset: ["CODE_CHUNK_SIZE"] },
    );
    expect(next).toEqual({ GIT_ADAPTER: "cli" });
  });

  it("does not mutate its input", () => {
    const current = { GIT_ADAPTER: "cli" };
    editRegistryEnv(current, { set: { GIT_ADAPTER: "es-git" } });
    expect(current).toEqual({ GIT_ADAPTER: "cli" });
  });
});

describe("applyRegistryEnvEdit", () => {
  it("writes general keys into the env map, keeping the rest of the entry", () => {
    const next = applyRegistryEnvEdit(entry({ env: { GIT_ADAPTER: "cli" } }), {
      set: { INGEST_CHUNK_SIZE: "2500" },
    });
    expect(next.env).toEqual({ GIT_ADAPTER: "cli", INGEST_CHUNK_SIZE: "2500" });
    expect(next.chunksCount).toBe(10);
  });

  it("seeds the env map from a legacy `tuning` snapshot", () => {
    const next = applyRegistryEnvEdit(entry({ tuning: { GIT_ADAPTER: "cli" } }), { set: { INGEST_CHUNK_SIZE: "1" } });
    expect(next.env).toEqual({ GIT_ADAPTER: "cli", INGEST_CHUNK_SIZE: "1" });
  });

  it("maps CODEGRAPH_ENABLED to the dedicated codegraphEnabled field, never the env map", () => {
    const on = applyRegistryEnvEdit(entry(), { set: { CODEGRAPH_ENABLED: "true" } });
    expect(on.codegraphEnabled).toBe(true);
    expect(on.env?.CODEGRAPH_ENABLED).toBeUndefined();

    const off = applyRegistryEnvEdit(entry({ codegraphEnabled: true }), { set: { CODEGRAPH_ENABLED: "0" } });
    expect(off.codegraphEnabled).toBe(false);

    const unset = applyRegistryEnvEdit(entry({ codegraphEnabled: true }), { unset: ["CODEGRAPH_ENABLED"] });
    expect("codegraphEnabled" in unset).toBe(false);
  });

  it("maps the embedding endpoints (and their deprecated spellings) to their dedicated fields", () => {
    const next = applyRegistryEnvEdit(entry(), {
      set: { OLLAMA_URL: "http://gpu:11434", EMBEDDING_FALLBACK_URL: "http://cpu:11434" },
    });
    expect(next.embeddingBaseUrl).toBe("http://gpu:11434");
    expect(next.embeddingFallbackUrl).toBe("http://cpu:11434");
    expect(next.env).toBeUndefined();

    const unset = applyRegistryEnvEdit(next, { unset: ["EMBEDDING_BASE_URL", "OLLAMA_FALLBACK_URL"] });
    expect("embeddingBaseUrl" in unset).toBe(false);
    expect("embeddingFallbackUrl" in unset).toBe(false);
  });

  it("refuses the keys the index run records about the indexed data", () => {
    expect([...INDEX_RECORDED_ENV_KEYS].sort()).toEqual(["EMBEDDING_MODEL", "QDRANT_URL"]);
    expect(() => applyRegistryEnvEdit(entry(), { set: { EMBEDDING_MODEL: "x" } })).toThrow();
    expect(() => applyRegistryEnvEdit(entry(), { unset: ["QDRANT_URL"] })).toThrow();
  });
});
