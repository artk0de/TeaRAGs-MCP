/**
 * `findIndexedFile` (bd tea-rags-mcp-ueplg): answers whether a file belongs to
 * the index snapshot that serves its working tree — the membership check the
 * plugin's PreToolUse(Read) hook asks through `tea-rags project indexed`. It
 * reads the registry and the sharded snapshot only: no Qdrant, no daemon.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createGitWorkingTreeFixture,
  prebuildGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { findFirstIndexedFile, findIndexedFile } from "../../../../../src/core/api/internal/ops/indexed-file-query.js";
import { ShardedSnapshotManager } from "../../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const SEED = [
  { commit: { "src/indexed.ts": "export const a = 1;\n", "data/skipped.json": "{}\n" }, message: "A" },
  { addWorktree: "feature" },
] satisfies readonly GitWorkingTreeSeedStep[];

const FILE_META = { mtime: 1, size: 1, hash: "h" };

describe("findIndexedFile", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let dataDir: string;
  let snapshotsDir: string;
  let registry: CollectionRegistry;

  const register = (collectionName: string, path: string, name: string): void => {
    registry.record({
      collectionName,
      path,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    });
    registry.setName(collectionName, name);
  };

  const snapshot = async (collectionName: string, root: string, files: string[]): Promise<void> => {
    await new ShardedSnapshotManager(snapshotsDir, collectionName).save(
      root,
      new Map(files.map((file) => [file, FILE_META])),
    );
  };

  beforeAll(() => {
    prebuildGitWorkingTreeFixture(SEED);
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture(SEED);
    dataDir = mkdtempSync(join(tmpdir(), "indexed-file-"));
    snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(snapshotsDir);
    registry = new CollectionRegistry(dataDir);
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers the alias and tree-relative path of a file the snapshot lists", async () => {
    register("code_repo", fixture.mainRoot, "repo");
    await snapshot("code_repo", fixture.mainRoot, ["src/indexed.ts"]);

    await expect(
      findIndexedFile({ registry, snapshotsDir }, join(fixture.mainRoot, "src/indexed.ts")),
    ).resolves.toEqual({ project: "repo", collectionName: "code_repo", relativePath: "src/indexed.ts" });
  });

  it("answers null for a file of the registered tree the snapshot does not list", async () => {
    register("code_repo", fixture.mainRoot, "repo");
    await snapshot("code_repo", fixture.mainRoot, ["src/indexed.ts"]);

    await expect(
      findIndexedFile({ registry, snapshotsDir }, join(fixture.mainRoot, "data/skipped.json")),
    ).resolves.toBeNull();
  });

  it("answers null for a file outside every registered project", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      const file = join(outside, "x.ts");
      writeFileSync(file, "export const x = 1;\n");
      await expect(findIndexedFile({ registry, snapshotsDir }, file)).resolves.toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers null when the registered project has no snapshot yet", async () => {
    register("code_repo", fixture.mainRoot, "repo");

    await expect(
      findIndexedFile({ registry, snapshotsDir }, join(fixture.mainRoot, "src/indexed.ts")),
    ).resolves.toBeNull();
  });

  it("reads a linked worktree's file against the base index, relative to the worktree root", async () => {
    register("code_repo", fixture.mainRoot, "repo");
    await snapshot("code_repo", fixture.mainRoot, ["src/indexed.ts"]);
    const tree = fixture.seeded.worktrees.feature;

    await expect(findIndexedFile({ registry, snapshotsDir }, join(tree, "src/indexed.ts"))).resolves.toEqual({
      project: "repo",
      collectionName: "code_repo",
      relativePath: "src/indexed.ts",
    });
  });

  it("answers null for a path that does not exist", async () => {
    register("code_repo", fixture.mainRoot, "repo");
    await snapshot("code_repo", fixture.mainRoot, ["src/indexed.ts"]);

    await expect(
      findIndexedFile({ registry, snapshotsDir }, join(fixture.mainRoot, "src/missing.ts")),
    ).resolves.toBeNull();
  });

  it("answers the first indexed file of a batch, skipping unindexed and missing paths", async () => {
    register("code_repo", fixture.mainRoot, "repo");
    await snapshot("code_repo", fixture.mainRoot, ["src/indexed.ts"]);
    const batch = ["data/skipped.json", "src/missing.ts", "src/indexed.ts"].map((p) => join(fixture.mainRoot, p));

    await expect(findFirstIndexedFile({ registry, snapshotsDir }, batch)).resolves.toEqual({
      project: "repo",
      collectionName: "code_repo",
      relativePath: "src/indexed.ts",
    });
    await expect(findFirstIndexedFile({ registry, snapshotsDir }, batch.slice(0, 2))).resolves.toBeNull();
  });
});
