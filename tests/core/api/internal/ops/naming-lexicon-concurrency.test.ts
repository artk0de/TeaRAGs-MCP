/**
 * NamingLexiconOps — the request's independent remote reads run together, bounded,
 * and an identical concept search runs once per request.
 *
 * The type drafts' concept searches and the colliding names' holder lookups are
 * independent of each other; sequential awaits made a large review wait on each
 * round trip in turn. The answers must not move: the verdicts come back in draft
 * and name order whatever order the reads settle in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import {
  NAMING_LEXICON_READ_CONCURRENCY,
  NamingLexiconOps,
  type NamingLexiconExplore,
} from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import type { ExploreResponse, FindSymbolRequest } from "../../../../../src/core/api/public/dto/index.js";
import type { TypeDeclarationRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { capability as rubyCapability } from "../../../../../src/core/domains/language/ruby/capability.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["ruby", rubyCapability.naming as IdentifierNamingConvention],
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
]);

const EMPTY: ExploreResponse = { results: [], driftWarning: null };

/** A read the test settles by hand, with the in-flight high-water mark of its kind. */
function heldReads(): {
  fn: ReturnType<typeof vi.fn<(req: unknown) => Promise<ExploreResponse>>>;
  inFlight: () => number;
  peak: () => number;
  releaseAll: () => void;
} {
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  const fn = vi.fn(async (_req: unknown) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight--;
    return EMPTY;
  });
  return {
    fn,
    inFlight: () => inFlight,
    peak: () => peak,
    releaseAll: () => {
      for (const release of waiting.splice(0)) release();
    },
  };
}

describe("NamingLexiconOps — concurrent remote reads", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  function build(explore: NamingLexiconExplore): NamingLexiconOps {
    vi.spyOn(db, "close").mockResolvedValue(undefined);
    return new NamingLexiconOps({
      pool: { acquireReader: vi.fn(async () => ({ graphDb: db, symbolTable: {} })) } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (name: string) => name as never,
      explore,
      namingConventions: NAMING,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-concurrency-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("type drafts' concept searches", () => {
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

    beforeEach(async () => {
      await db.replaceTypeDeclarationsBulk(
        Array.from({ length: 20 }, (_, i) => ({ relPath: `src/f${i}/x.ts`, rows: [decl(`Filler${i}Thing`)] })),
      );
    });

    it("are in flight together, bounded, and the verdicts keep draft order", async () => {
      const search = heldReads();
      const ops = build({ semanticSearch: search.fn });
      const names = Array.from({ length: NAMING_LEXICON_READ_CONCURRENCY + 4 }, (_, i) => `Draft${i}Ledger`);
      const pending = ops.getNamingLexicon({ collection: "c", names: names.map(typeDraft) });

      await vi.waitFor(() => {
        expect(search.inFlight()).toBe(NAMING_LEXICON_READ_CONCURRENCY);
      });
      while (search.fn.mock.calls.length < names.length || search.inFlight() > 0) {
        search.releaseAll();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const result = await pending;

      expect(search.peak()).toBe(NAMING_LEXICON_READ_CONCURRENCY);
      expect(search.fn).toHaveBeenCalledTimes(names.length);
      expect(result.names.map((n) => n.name)).toEqual(names);
    });

    it("an identical search runs once per request", async () => {
      const semanticSearch = vi.fn(async () => EMPTY);
      const ops = build({ semanticSearch });
      const result = await ops.getNamingLexicon({
        collection: "c",
        names: [typeDraft("LedgerBook"), typeDraft("LedgerBook")],
      });
      expect(semanticSearch).toHaveBeenCalledTimes(1);
      expect(result.names[1]).toEqual(result.names[0]);
    });
  });

  describe("colliding names' holder lookups", () => {
    const symbol = async (relPath: string, symbolId: string, shortName: string): Promise<void> => {
      await db.run(
        "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '[]')",
        [relPath, symbolId, symbolId, shortName],
      );
    };

    it("are in flight together and land on their own names", async () => {
      const names = ["alpha_row!", "beta_row!", "gamma_row!"];
      for (const name of names) await symbol(`app/models/${name}.rb`, `Model#${name}`, name);
      const lookup = heldReads();
      const findSymbol = vi.fn(async (req: FindSymbolRequest) => {
        await lookup.fn(req);
        const symbolId = `Model#${req.symbol}`;
        return {
          driftWarning: null,
          results: [{ id: symbolId, score: 1, payload: { symbolId, relativePath: `app/models/${req.symbol}.rb` } }],
        };
      });
      const ops = build({ semanticSearch: vi.fn(async () => EMPTY), findSymbol });
      const pending = ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: names.map((name) => ({ name, kind: "return" as const })),
      });

      await vi.waitFor(() => {
        expect(lookup.inFlight()).toBe(names.length);
      });
      lookup.releaseAll();
      const result = await pending;

      expect(result.names.map((n) => [n.name, n.evidence?.collisions])).toEqual(
        names.map((name) => [name, [`Model#${name}`]]),
      );
    });
  });
});
