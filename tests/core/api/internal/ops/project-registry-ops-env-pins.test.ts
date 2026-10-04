/**
 * `tea-rags projects set-env` is the ONE way a throughput-tuned key becomes a
 * per-project ceiling (bd tea-rags-mcp-y1ynz): the edit records an operator
 * pin, and replay honours a tuned key only when it is pinned. A value an index
 * run stamped is replayed for nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { resolveRegistryEnv } from "../../../../../src/core/domains/maintenance/registry/env-resolution.js";

describe("ProjectRegistryOps — operator pins of throughput-tuned keys", () => {
  let dir: string;
  let repo: string;
  let ops: ProjectRegistryOps;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pro-pins-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    ops = new ProjectRegistryOps({ registry: new CollectionRegistry(dir) });
    await ops.register({ path: repo, name: "alpha" });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const onDisk = () => new CollectionRegistry(dir).findByName("alpha");

  it("replays a set-env pinned INGEST_PIPELINE_CONCURRENCY into the next run", () => {
    ops.editEnv({ name: "alpha", set: { EMBEDDING_CONCURRENCY: "4" } });
    expect(onDisk()?.operatorPinnedEnvKeys).toEqual(["INGEST_PIPELINE_CONCURRENCY"]);
    expect(resolveRegistryEnv(onDisk(), {}).INGEST_PIPELINE_CONCURRENCY).toBe("4");
  });

  it("stops replaying it once the operator unsets it", () => {
    ops.editEnv({ name: "alpha", set: { INGEST_PIPELINE_CONCURRENCY: "4" } });
    ops.editEnv({ name: "alpha", unset: ["INGEST_PIPELINE_CONCURRENCY"] });
    expect(onDisk()?.operatorPinnedEnvKeys).toEqual([]);
    expect(resolveRegistryEnv(onDisk(), {})).not.toHaveProperty("INGEST_PIPELINE_CONCURRENCY");
  });

  it("register({ env }) pins what it sets, like set-env", async () => {
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, ".keep"), "");
    await ops.register({ path: other, name: "beta", env: { EMBEDDING_TUNE_BATCH_TIMEOUT_MS: "500" } });
    const beta = new CollectionRegistry(dir).findByName("beta");
    expect(resolveRegistryEnv(beta, {}).EMBEDDING_TUNE_BATCH_TIMEOUT_MS).toBe("500");
  });
});
