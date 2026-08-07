import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { createIngestDependencies } from "../../../../src/core/api/internal/ingest-dependencies.js";
import type { PayloadBuilder } from "../../../../src/core/contracts/types/provider.js";

/**
 * Guards the migration sweep's composition: a pipeline that Migrator does not
 * know about throws on run(), so a missing registration is a runtime failure of
 * every reindex rather than a type error. These assertions are the cheap way to
 * catch that — no collection, no indexing, no build output required.
 */
describe("createIngestDependencies — migration pipelines", () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "ingest-deps-"));
  });

  afterEach(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  function migrator() {
    const deps = createIngestDependencies(
      {} as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );
    return deps.createMigrator("code_test", "/project");
  }

  it("registers every pipeline the reindex sweep runs", async () => {
    const m = migrator();
    // No stats file in a fresh directory — the runner reports the latest
    // version and the sweep is a no-op, which is the point: registration must
    // hold even when there is nothing to migrate.
    await expect(m.run("stats")).resolves.toMatchObject({ pipeline: "stats", steps: [] });
  });

  it("rejects a pipeline nobody registered", async () => {
    const m = migrator();
    await expect(m.run("nope" as "stats")).rejects.toThrow(/Unknown migration pipeline/);
  });
});
