/**
 * `review_changes` and `get_naming_lexicon` carry the `workingTree` marker
 * (bd tea-rags-mcp-xi2r9, live probe P2-4): the spec puts it on every read
 * answer, and these two — called with `path` — answered without it. Pinned on
 * each return path: a built answer, and the one where the codegraph store is
 * unreachable. `indexLag` stays as it is beside it (the spec retires it later).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { NamingLexiconOps } from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { ReviewChangesOps } from "../../../../../src/core/api/internal/ops/review-changes-ops.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 4,
  deletedFiles: 2,
  floors: [],
};

const overlay = () => ({
  view: vi.fn().mockResolvedValue({ marker: MARKER, touchedPaths: new Set(), deletedPaths: new Set() }),
});

describe("NamingLexiconOps workingTree marker", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-wt-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (acquireReader: () => Promise<unknown>, workingTreeOverlay = overlay()) => ({
    ops: new NamingLexiconOps({
      pool: { acquireReader } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (name: string) => name as never,
      explore: { semanticSearch: vi.fn(async () => ({ results: [], driftWarning: null })) },
      namingConventions: new Map(),
      workingTreeOverlay,
    }),
    workingTreeOverlay,
  });

  it("should attach the marker to an answer read from the codegraph store", async () => {
    const graphDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "close") return async () => undefined;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { ops, workingTreeOverlay } = build(async () => ({ graphDb, symbolTable: {} }));

    const result = await ops.getNamingLexicon({ collection: "c", types: ["TaxDocument"] });

    expect(result.workingTree).toEqual(MARKER);
    expect(workingTreeOverlay.view).toHaveBeenCalledWith(
      { root: "", baseIndex: { collectionName: "c", root: undefined } },
      undefined,
    );
  });

  it("should attach the marker when the codegraph store is unreachable", async () => {
    const { ops } = build(async () => Promise.reject(new Error("daemon down")));

    const result = await ops.getNamingLexicon({ collection: "c", types: ["TaxDocument"] });

    expect(result.notices).toEqual(["codegraph store unavailable: daemon down"]);
    expect(result.workingTree).toEqual(MARKER);
  });
});

describe("ReviewChangesOps workingTree marker", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const lexiconOps = {
    getNamingLexicon: vi.fn().mockResolvedValue({
      scope: "",
      byType: [],
      names: [],
      review: {
        workTree: "",
        base: "HEAD",
        mergeBase: "",
        changedFiles: 0,
        checked: 0,
        conforming: 0,
        novel: 0,
        findings: [],
        notJudged: 0,
      },
    }),
  };

  const build = (acquireReader: () => Promise<unknown>, hasDatabase = true) => {
    const workingTreeOverlay = overlay();
    const ops = new ReviewChangesOps({
      pool: { acquireReader, hasDatabase: vi.fn(() => hasDatabase) } as never,
      collectionRegistry: { get: () => ({}) } as unknown as CollectionRegistry,
      lexiconOps,
      windowMonths: 6,
      workingTreeOverlay,
    });
    return { ops, workingTreeOverlay };
  };

  it("should attach the marker to a built review, measured for the tree the review read", async () => {
    const graphDb = {
      close: vi.fn(async () => undefined),
      readTemporalCochangeGraph: vi.fn(async () => ({ meta: { head: "h" }, edges: [] })),
      readTemporalSymbolCommits: vi.fn(async (relPath: string) => ({ relPath, symbols: [] })),
    };
    const { ops, workingTreeOverlay } = build(async () => ({ graphDb, symbolTable: {} }));

    const result = await ops.reviewChanges({ collection: "code_test", path: fixture.mainRoot, sections: ["naming"] });

    expect(result.review.sections.naming?.built).toBe(true);
    expect(result.workingTree).toEqual(MARKER);
    expect(workingTreeOverlay.view.mock.calls[0][0]).toMatchObject({ baseIndex: { collectionName: "code_test" } });
  });

  it("should attach the marker when the collection has no codegraph database", async () => {
    const { ops } = build(async () => Promise.reject(new Error("no database")), false);

    const result = await ops.reviewChanges({ collection: "code_test", path: fixture.mainRoot, sections: ["naming"] });

    expect(result.workingTree).toEqual(MARKER);
  });
});
