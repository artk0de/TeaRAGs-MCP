/**
 * NamingLexiconOps — one request's concept searches share
 * one {@link ExploreRequestScope} (bd tea-rags-mcp-89k7k.1.18): a review that
 * runs dozens of concept searches measures the working tree once, not once
 * per search.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import {
  NamingLexiconOps,
  type NamingLexiconExplore,
} from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import type { ExploreResponse } from "../../../../../src/core/api/public/dto/index.js";
import type { TypeDeclarationRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import { ExploreRequestScope } from "../../../../../src/core/domains/explore/request-scope.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
]);

const EMPTY: ExploreResponse = { results: [], driftWarning: null };

const MARKER: WorkingTreeMarker = {
  tree: "",
  indexedCommit: null,
  treeCommit: null,
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
};

describe("NamingLexiconOps — request-scoped explore reads", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const decl = (typeId: string): TypeDeclarationRow => ({
    language: "typescript",
    typeId,
    shortName: typeId,
    symbolKind: "class",
    line: 1,
    reopens: false,
    supertypes: [],
  });
  const typeDraft = (name: string) => ({ name, kind: "type" as const, path: `src/drafts/${name}.ts` });

  function build(explore: NamingLexiconExplore, view = vi.fn(async () => ({ marker: MARKER }))): NamingLexiconOps {
    vi.spyOn(db, "close").mockResolvedValue(undefined);
    return new NamingLexiconOps({
      pool: { acquireReader: vi.fn(async () => ({ graphDb: db, symbolTable: {} })) } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (name: string) => name as never,
      explore,
      namingConventions: NAMING,
      workingTreeOverlay: { view } as never,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-scope-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceTypeDeclarationsBulk(
      Array.from({ length: 20 }, (_, i) => ({ relPath: `src/f${i}/x.ts`, rows: [decl(`Filler${i}Thing`)] })),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A port whose request-bound searches record the scope they were bound to. */
  const scopedPort = () => {
    const scoped = vi.fn(async (_req: unknown, _scope: ExploreRequestScope) => EMPTY);
    const unscoped = vi.fn(async (_req: unknown) => EMPTY);
    const withRequestScope = vi.fn((scope: ExploreRequestScope) => ({
      semanticSearch: async (req: Parameters<NamingLexiconExplore["semanticSearch"]>[0]) => scoped(req, scope),
    }));
    return { explore: { semanticSearch: unscoped, withRequestScope }, scoped, unscoped, withRequestScope };
  };

  it("runs every concept search of one request through one request scope", async () => {
    const { explore, scoped, unscoped, withRequestScope } = scopedPort();
    const ops = build(explore);

    await ops.getNamingLexicon({
      collection: "c",
      names: [typeDraft("LedgerBook"), typeDraft("InvoiceRow"), typeDraft("PaymentSlip")],
    });

    expect(withRequestScope).toHaveBeenCalledTimes(1);
    expect(withRequestScope.mock.calls[0][0]).toBeInstanceOf(ExploreRequestScope);
    expect(scoped).toHaveBeenCalledTimes(3);
    expect(new Set(scoped.mock.calls.map(([, scope]) => scope)).size).toBe(1);
    expect(unscoped).not.toHaveBeenCalled();
  });

  it("gives separate requests separate scopes", async () => {
    const { explore, scoped } = scopedPort();
    const ops = build(explore);

    await ops.getNamingLexicon({ collection: "c", names: [typeDraft("LedgerBook")] });
    await ops.getNamingLexicon({ collection: "c", names: [typeDraft("LedgerBook")] });

    expect(scoped).toHaveBeenCalledTimes(2);
    expect(scoped.mock.calls[0][1]).not.toBe(scoped.mock.calls[1][1]);
  });

  it("searches through the plain port when it cannot bind a scope", async () => {
    const semanticSearch = vi.fn(async (_req: unknown) => EMPTY);
    const ops = build({ semanticSearch });

    await ops.getNamingLexicon({ collection: "c", names: [typeDraft("LedgerBook")] });

    expect(semanticSearch).toHaveBeenCalledTimes(1);
  });
});
