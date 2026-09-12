/**
 * INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD (bd tea-rags-mcp-1v12o.2).
 *
 * The run-size share that decides how many enrichment threads a pass-1
 * extraction is worth spreading over. Sibling of
 * INGEST_TUNE_ENRICHMENT_POOL_SIZE, which stays the ceiling — this one only
 * says how much work has to exist before that ceiling is reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRegistryEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import {
  codegraphSchema,
  embeddingSchema,
  ingestSchema,
  qdrantTuneSchema,
  trajectoryGitSchema,
  vcsSchema,
} from "../../src/bootstrap/config/schemas.js";
import { REGISTRY_ENV_GROUPS } from "../../src/core/domains/maintenance/registry/env-groups.js";

const KEY = "INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD";

async function freshImport() {
  vi.resetModules();
  return await import("../../src/bootstrap/config/index.js");
}

const bareConfig = () => ({
  vcs: vcsSchema.parse({}),
  trajectoryGit: trajectoryGitSchema.parse({}),
  ingest: ingestSchema.parse({ tune: {} }),
  embedding: embeddingSchema.parse({ tune: {} }),
  codegraph: codegraphSchema.parse({}),
  qdrantTune: qdrantTuneSchema.parse({}),
  flags: {
    userSetBatchSize: false,
    userSetChunkSize: false,
    userSetDeleteBatchSize: false,
    userSetDeleteConcurrency: false,
  },
});

describe(KEY, () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved !== undefined) process.env[KEY] = saved;
    else delete process.env[KEY];
  });

  it("defaults to 400 files per extraction thread", async () => {
    const { parseAppConfigZod } = await freshImport();

    expect(parseAppConfigZod().ingest.tune.enrichmentFilesPerThread).toBe(400);
  });

  it("takes the operator's value from the env", async () => {
    process.env[KEY] = "1200";
    const { parseAppConfigZod } = await freshImport();

    expect(parseAppConfigZod().ingest.tune.enrichmentFilesPerThread).toBe(1200);
  });

  it("is a canonical registry env group with a runtime consequence", () => {
    const group = REGISTRY_ENV_GROUPS.find((g) => g.canonical === KEY);

    expect(group).toBeDefined();
    expect(group?.consequence).toBe("runtime");
  });

  it("is materialized into the registry env snapshot at its code default", () => {
    expect(buildRegistryEnvSnapshot(bareConfig())[KEY]).toBe("400");
  });
});
