/**
 * Every read tool answers a path whose resolved index does not exist with the
 * same typed not-found error (live round-3 D3, bd tea-rags-mcp-xi2r9). The
 * search tools threw `EXPLORE_COLLECTION_NOT_FOUND`; the graph tools answered
 * an empty result with a fabricated `workingTree.degraded` ("index has no
 * indexedCommit stamp", remedy naming the path-hash collection nobody
 * created) — an empty edge list there reads as "this symbol has no callers".
 * The check sits at the one seam every reader resolves its tree through
 * (`resolveIndexedWorkingTree`), BEFORE the overlay measures anything.
 *
 * An index that EXISTS but carries no commit stamp is still answered, with the
 * marker degraded as before.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphFacade } from "../../../../src/core/api/internal/facades/graph-facade.js";
import { NamingLexiconOps } from "../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { OntologyReportOps } from "../../../../src/core/api/internal/ops/ontology-report-ops.js";
import { ReviewChangesOps } from "../../../../src/core/api/internal/ops/review-changes-ops.js";
import { TracePathOps } from "../../../../src/core/api/internal/ops/trace-path-ops.js";
import { CollectionNotFoundError } from "../../../../src/core/domains/explore/errors.js";
import {
  createWorkingTreeDeltaReader,
  WorkingTreeOverlay,
} from "../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../src/core/domains/maintenance/registry/index.js";

describe("read tools on a path whose index does not exist (D3)", () => {
  let registryDir: string;
  let nonGitTree: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "unindexed-registry-"));
    nonGitTree = mkdtempSync(join(tmpdir(), "unindexed-tree-"));
    writeFileSync(join(nonGitTree, "a.ts"), "export function helperB() { return 1; }\n");
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
    rmSync(nonGitTree, { recursive: true, force: true });
  });

  /** A pool with no graph database — the codegraph-optional fallback path. */
  const pool = () =>
    ({
      acquireReader: vi.fn().mockRejectedValue(new Error("no such file")),
      acquireFileReader: vi.fn().mockRejectedValue(new Error("no such file")),
      hasDatabase: vi.fn().mockReturnValue(false),
    }) as never;

  const realOverlay = () =>
    new WorkingTreeOverlay({
      registry: collectionRegistry,
      deltaReader: createWorkingTreeDeltaReader(),
      createFileFilter: async () => () => true,
    });

  const graphFacade = (indexExists: (name: string) => Promise<boolean>, overlay = realOverlay()) =>
    new GraphFacade({
      pool: pool(),
      collectionRegistry,
      resolveActiveCollection: async (c: string) => c as never,
      workingTreeOverlay: overlay,
      indexExists,
    });

  const missing = async () => false;

  it("should refuse every graph tool with the typed not-found error, never measuring the tree", async () => {
    const overlay = { view: vi.fn() };
    const facade = graphFacade(missing, overlay as never);
    const path = nonGitTree;

    await expect(facade.getCallers({ path, symbolId: "helperB" })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(facade.getCallees({ path, symbolId: "helperB" })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(facade.findCycles({ path })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(facade.getArchitectureReport({ path })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(facade.findCoChanged({ path, files: ["a.ts"] })).rejects.toBeInstanceOf(CollectionNotFoundError);
    expect(overlay.view).not.toHaveBeenCalled();
  });

  it("should refuse trace_path, the ontology report, the naming lexicon and review_changes the same way", async () => {
    const overlay = { view: vi.fn() };
    const path = nonGitTree;
    const trace = new TracePathOps({
      pool: pool(),
      qdrant: {} as never,
      reranker: {} as never,
      collectionRegistry,
      workingTreeOverlay: overlay,
      indexExists: missing,
    });
    const ontology = new OntologyReportOps({
      pool: pool(),
      collectionRegistry,
      languages: [],
      workingTreeOverlay: overlay,
      indexExists: missing,
    });
    const lexicon = new NamingLexiconOps({
      pool: pool(),
      collectionRegistry,
      explore: {} as never,
      namingConventions: new Map(),
      workingTreeOverlay: overlay,
      indexExists: missing,
    });
    const review = new ReviewChangesOps({
      pool: pool(),
      collectionRegistry,
      lexiconOps: lexicon,
      windowMonths: 6,
      workingTreeOverlay: overlay,
      indexExists: missing,
    });

    await expect(trace.tracePath({ path, from: "a", to: "b" })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(ontology.report({ path })).rejects.toBeInstanceOf(CollectionNotFoundError);
    await expect(lexicon.getNamingLexicon({ path, types: ["Service"] })).rejects.toBeInstanceOf(
      CollectionNotFoundError,
    );
    await expect(review.reviewChanges({ path })).rejects.toBeInstanceOf(CollectionNotFoundError);
    expect(overlay.view).not.toHaveBeenCalled();
  });

  it("should still answer an EXISTING index without a commit stamp, its marker degraded as before", async () => {
    const response = await graphFacade(async () => true).getCallers({ path: nonGitTree, symbolId: "helperB" });

    expect(response.callers).toEqual([]);
    expect(response.workingTree?.degraded?.reason).toBe("index has no indexedCommit stamp");
  });
});
