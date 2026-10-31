/**
 * find_symbol `table:<name>` and `migration:<id>` through the facade
 * (bd tea-rags-mcp-nplgm): the migration corpus companion is read by payload
 * scroll, the table's operations folded into its current state, `#partN`
 * points reassembled, and absence answered with a reason distinct from a
 * missing corpus.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import { TreeSitterChunker } from "../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import { chunkRailsMigration } from "../../../../../src/core/domains/language/ruby/chunking/migration-chunker.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";
import { OAUTH_MIGRATIONS } from "../../../domains/language/ruby/fixtures/oauth-migrations.js";

type Row = { id: string; payload: Record<string, unknown> };

/** The corpus points ingest writes for the fixture migrations. */
async function corpusRows(): Promise<Row[]> {
  const parser = new TreeSitterChunker(
    { chunkSize: 4500, chunkOverlap: 0, maxChunkSize: 4500 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  const rows: Row[] = [];
  for (const [relativePath, code] of Object.entries(OAUTH_MIGRATIONS)) {
    const { tree } = await parser.chunkWithTree(code, relativePath, "ruby");
    for (const chunk of chunkRailsMigration(tree!.rootNode, code, relativePath)) {
      rows.push({ id: chunk.symbolId, payload: { ...chunk, relativePath } });
    }
  }
  return rows;
}

/** Split one point into two `#partN` points the way the corpus writer does (header line prefixed). */
function splitIntoParts(rows: Row[], symbolId: string): Row[] {
  return rows.flatMap((row) => {
    if (row.payload.symbolId !== symbolId) return [row];
    const lines = String(row.payload.content).split("\n");
    const cut = Math.floor(lines.length / 2);
    const header = lines[0];
    return [
      {
        id: `${symbolId}#part1`,
        payload: { ...row.payload, symbolId: `${symbolId}#part1`, content: lines.slice(0, cut).join("\n") },
      },
      {
        id: `${symbolId}#part2`,
        payload: {
          ...row.payload,
          symbolId: `${symbolId}#part2`,
          content: `${header}\n${lines.slice(cut).join("\n")}`,
        },
      },
    ];
  });
}

function qdrantHolding(rows: Row[], { corpus = true } = {}) {
  return {
    collectionExists: vi.fn(async (name: string) => corpus || !name.endsWith("_migrations")),
    // `match.text` (the text-indexed half of `exactMatchOnTextIndexed`) is modelled as a substring test.
    scrollFiltered: vi.fn(
      async (collection: string, filter: { must: { key: string; match: { value?: string; text?: string } }[] }) =>
        collection.endsWith("_migrations")
          ? rows.filter((row) =>
              filter.must.every(({ key, match }) =>
                match.text !== undefined
                  ? String(row.payload[key]).includes(match.text)
                  : row.payload[key] === match.value,
              ),
            )
          : [],
    ),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    getPoint: vi.fn().mockResolvedValue({ id: 1, payload: { indexingComplete: true } }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("ExploreFacade.findSymbol migration addresses", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "find-symbol-table-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const facade = (qdrant: unknown) =>
    new ExploreFacade({
      qdrant: qdrant as any,
      embeddings: { embed: vi.fn() } as any,
      reranker: { getDescriptors: vi.fn().mockReturnValue([]), rerank: vi.fn((rows: unknown[]) => rows) } as any,
      registry: {
        getAllFilters: vi.fn().mockReturnValue([]),
        getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
        getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      } as any,
      collectionRegistry,
      payloadSignals: [],
      essentialKeys: [],
    });

  it("answers table:<name> with the folded current state from the companion collection", async () => {
    const qdrant = qdrantHolding(await corpusRows());
    const response = await facade(qdrant).findSymbol({ collection: "code_x", symbol: "table:oauth_connections" });

    expect(qdrant.scrollFiltered.mock.calls.every(([collection]: [string]) => collection === "code_x_migrations")).toBe(
      true,
    );
    expect(response.results).toEqual([]);
    expect(response.empty).toBeUndefined();
    expect(response.table?.table).toBe("oauth_connections");
    expect(response.table?.columns.find((column) => column.name === "creator_type")?.renamedFrom).toBe("actor_type");
    expect(response.table?.indexes.map((index) => index.name)).toEqual([
      "idx_oauth_connections_on_firm",
      "idx_oauth_connections_on_refresh_expires_at",
    ]);
  });

  it("reassembles #partN points before folding", async () => {
    const create = "migration:db/migrate/20260731110423_create_oauth_documents.rb:create_table:1";
    const qdrant = qdrantHolding(splitIntoParts(await corpusRows(), create));
    const response = await facade(qdrant).findSymbol({ collection: "code_x", symbol: "table:oauth_documents" });

    expect(response.table?.provenance[0]).toBe(create);
    expect(response.table?.columns.map((column) => column.name)).toContain("path");
    expect(response.table?.foreignKeys.map((key) => key.toTable)).toEqual([
      "tax_automations_documents",
      "oauth_entities",
    ]);
    expect(response.table?.unfolded).toEqual([]);
  });

  it("answers a table no migration names with an explicit empty reason", async () => {
    const response = await facade(qdrantHolding(await corpusRows())).findSymbol({
      collection: "code_x",
      symbol: "table:invoices",
    });

    expect(response.table).toBeUndefined();
    expect(response.empty?.reason).toBe("noTableOperations");
    expect(response.empty?.message).toContain("invoices");
  });

  it("answers notBuilt when the project has no migration corpus", async () => {
    const response = await facade(qdrantHolding([], { corpus: false })).findSymbol({
      collection: "code_x",
      symbol: "table:oauth_connections",
    });

    expect(response.empty?.reason).toBe("notBuilt");
  });

  it("drills a provenance id to its migration operation chunk", async () => {
    const id = "migration:db/migrate/20260806132558_make_oauth_connections_unique_per_firm.rb:remove_index:2";
    const response = await facade(qdrantHolding(await corpusRows())).findSymbol({ collection: "code_x", symbol: id });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].payload).toMatchObject({ symbolId: id, operation: "remove_index", direction: "change" });
    expect(String(response.results[0].payload?.content)).toContain("idx_oauth_connections_on_firm_creator");

    const meta = await facade(qdrantHolding(await corpusRows())).findSymbol({
      collection: "code_x",
      symbol: id,
      metaOnly: true,
    });
    expect(meta.results[0].payload?.content).toBeUndefined();
  });
});
