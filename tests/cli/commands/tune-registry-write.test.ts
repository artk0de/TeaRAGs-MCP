/**
 * tune → registry env write (tea-rags-mcp-9vpnz follow-through, user spec):
 * `tea-rags tune --project X` persists the envs it MEASURED directly into the
 * project registry (`entry.env`), so the next indexing run picks them up
 * registry-first without the operator copy-pasting the env file.
 *
 * Known caveat (documented, accepted): an MCP-driven index run rebuilds the
 * snapshot from the MCP server's env, which can overwrite tuned values that
 * the MCP env sets differently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeTunedEnvIntoRegistry, parseTunedEnvFile } from "../../../src/cli/commands/tune-registry-write.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

const ENV_FILE = `# Tea Rags MCP - Tuned Environment Variables
# Generated: 2026-07-05T00:00:00.000Z
# Hardware: http://localhost:11434 (jina)

# Embedding configuration
EMBEDDING_BATCH_SIZE=512
EMBEDDING_CONCURRENCY=4

# Qdrant storage configuration
QDRANT_UPSERT_BATCH_SIZE=256
QDRANT_BATCH_ORDERING=weak

# Pipeline concurrency
INGEST_TUNE_CHUNKER_POOL_SIZE=3
# INGEST_TUNE_FILE_CONCURRENCY=<skipped>
NOT_A_TEA_RAGS_KEY=1
`;

describe("parseTunedEnvFile", () => {
  it("parses KEY=VALUE lines, skipping comments, blanks and non-registry keys", () => {
    expect(parseTunedEnvFile(ENV_FILE)).toEqual({
      EMBEDDING_BATCH_SIZE: "512",
      EMBEDDING_CONCURRENCY: "4",
      QDRANT_UPSERT_BATCH_SIZE: "256",
      QDRANT_BATCH_ORDERING: "weak",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "3",
    });
  });

  it("returns an empty map for a file with no recognized keys", () => {
    expect(parseTunedEnvFile("# only comments\nFOO=bar\n")).toEqual({});
  });
});

describe("mergeTunedEnvIntoRegistry", () => {
  let dir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tea-rags-tune-registry-"));
    registry = new CollectionRegistry(dir);
    registry.record({
      collectionName: "code_x",
      path: "/repo",
      embeddingModel: "jina",
      embeddingDimensions: 768,
      qdrantUrl: "embedded",
      env: { GIT_ADAPTER: "es-git", EMBEDDING_CONCURRENCY: "1" },
      indexedAt: "2026-07-01T00:00:00.000Z",
      teaRagsVersion: "1.34.0",
      chunksCount: 10,
    });
    registry.setName("code_x", "proj");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges measured keys into entry.env, measured values overwriting stale ones", () => {
    const applied = mergeTunedEnvIntoRegistry(registry, "proj", ENV_FILE);
    expect(applied).toBe(5);
    const entry = registry.findByName("proj");
    expect(entry!.env).toMatchObject({
      GIT_ADAPTER: "es-git", // untouched — tune did not measure it
      EMBEDDING_CONCURRENCY: "4", // measured value wins over the old snapshot
      EMBEDDING_BATCH_SIZE: "512",
      QDRANT_UPSERT_BATCH_SIZE: "256",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "3",
    });
  });

  it("preserves the entry's sticky name and identity fields", () => {
    mergeTunedEnvIntoRegistry(registry, "proj", ENV_FILE);
    const entry = registry.findByName("proj");
    expect(entry!.name).toBe("proj");
    expect(entry!.qdrantUrl).toBe("embedded");
    expect(entry!.embeddingModel).toBe("jina");
  });

  it("seeds env from the legacy tuning map when the entry pre-dates entry.env", () => {
    registry.record({
      collectionName: "code_y",
      path: "/legacy",
      embeddingModel: "jina",
      embeddingDimensions: 768,
      qdrantUrl: "http://localhost:6333",
      tuning: { GIT_ADAPTER: "git" },
      indexedAt: "2026-07-01T00:00:00.000Z",
      teaRagsVersion: "1.30.0",
      chunksCount: 5,
    });
    registry.setName("code_y", "legacy");
    mergeTunedEnvIntoRegistry(registry, "legacy", ENV_FILE);
    const entry = registry.findByName("legacy");
    expect(entry!.env).toMatchObject({ GIT_ADAPTER: "git", EMBEDDING_BATCH_SIZE: "512" });
  });

  it("is a no-op returning 0 for an unknown project or an empty env file", () => {
    expect(mergeTunedEnvIntoRegistry(registry, "ghost", ENV_FILE)).toBe(0);
    expect(mergeTunedEnvIntoRegistry(registry, "proj", "# nothing\n")).toBe(0);
  });
});
