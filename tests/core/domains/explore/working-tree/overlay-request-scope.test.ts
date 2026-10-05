import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import type { WorkingTree } from "../../../../../src/core/contracts/types/working-tree.js";
import {
  createWorkingTreeDeltaReader,
  WorkingTreeMeasurements,
  WorkingTreeOverlay,
  type WorkingTreeDeltaReader,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

/**
 * `WorkingTreeOverlay#view` with request-scoped {@link WorkingTreeMeasurements}
 * (bd tea-rags-mcp-89k7k.1.18): the views one request asks for measure the
 * tree once — the delta read (`git status` + the change list) is the cost of a
 * view — while every view keeps its own marker, paths and answer deadline.
 */
describe("WorkingTreeOverlay — request-scoped measurements", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let registry: CollectionRegistry;
  let tree: string;

  const COLLECTION = "code_overlay_scope";

  const accepts = async (): Promise<(relativePath: string) => boolean> => (path) => path.endsWith(".ts");

  const countingReader = (): { reader: WorkingTreeDeltaReader; read: ReturnType<typeof vi.fn> } => {
    const inner = createWorkingTreeDeltaReader();
    const read = vi.fn(inner.read);
    return { reader: { read }, read };
  };

  const overlayWith = (deltaReader: WorkingTreeDeltaReader): WorkingTreeOverlay =>
    new WorkingTreeOverlay({ registry, deltaReader, createFileFilter: accepts });

  const workingTree = (): WorkingTree => ({
    root: tree,
    baseIndex: { collectionName: COLLECTION, root: fixture.mainRoot },
  });

  const record = (indexedCommit: string | undefined): void => {
    registry.record({
      collectionName: COLLECTION,
      path: fixture.mainRoot,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
      ...(indexedCommit ? { git: { indexedBranch: "main", indexedCommit, indexedDirty: false } } : {}),
    });
    registry.setName(COLLECTION, "proj");
  };

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture([
      { commit: { "src/keep.ts": "export const keep = 1;\n" }, message: "A" },
      { addWorktree: "feature" },
    ]);
    tree = fixture.seeded.worktrees.feature;
    registryDir = mkdtempSync(join(tmpdir(), "wto-scope-registry-"));
    registry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  it("should read the delta once for every view of one request", async () => {
    record(fixture.seeded.commits[0]);
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    const { reader, read } = countingReader();
    const overlay = overlayWith(reader);
    const measurements = new WorkingTreeMeasurements();

    const views = await Promise.all([
      overlay.view(workingTree(), "proj", measurements),
      overlay.view(workingTree(), "proj", measurements),
    ]);
    const later = await overlay.view(workingTree(), "proj", measurements);

    expect(read).toHaveBeenCalledTimes(1);
    expect(views[1].marker).toEqual(views[0].marker);
    expect(later.marker).toEqual(views[0].marker);
    expect(views[0].marker.changedFiles).toBe(1);
    expect([...later.touchedPaths]).toEqual(["src/keep.ts"]);
  });

  it("should keep each view's marker its own when the measurement is shared", async () => {
    record(fixture.seeded.commits[0]);
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    const overlay = overlayWith(createWorkingTreeDeltaReader());
    const measurements = new WorkingTreeMeasurements();

    const first = await overlay.view(workingTree(), "proj", measurements);
    first.marker.floors = ["dense"];
    const second = await overlay.view(workingTree(), "proj", measurements);

    expect(second.marker).not.toBe(first.marker);
    expect(second.marker.floors).toEqual([]);
  });

  it("should give each view of a shared degraded measurement its own marker", async () => {
    record(undefined);
    const overlay = overlayWith(createWorkingTreeDeltaReader());
    const measurements = new WorkingTreeMeasurements();

    const first = await overlay.view(workingTree(), "proj", measurements);
    first.marker.floors = ["codegraph"];
    const second = await overlay.view(workingTree(), "proj", measurements);

    expect(first.marker.degraded).toBeDefined();
    expect(second.marker).not.toBe(first.marker);
    expect(second.marker.floors).toEqual([]);
    expect(second.marker.degraded).toEqual(first.marker.degraded);
  });

  it("should measure a tree per alias it is named by", async () => {
    record(fixture.seeded.commits[0]);
    const { reader, read } = countingReader();
    const overlay = overlayWith(reader);
    const measurements = new WorkingTreeMeasurements();

    await overlay.view(workingTree(), "proj", measurements);
    await overlay.view(workingTree(), undefined, measurements);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("should read the delta per view without request-scoped measurements", async () => {
    record(fixture.seeded.commits[0]);
    const { reader, read } = countingReader();
    const overlay = overlayWith(reader);

    await overlay.view(workingTree(), "proj");
    await overlay.view(workingTree(), "proj");

    expect(read).toHaveBeenCalledTimes(2);
  });
});
