/**
 * SymbolBatchDrill (agent turn economy N1): several find_symbol addresses in
 * one call. Each address resolves through the SAME SymbolSearchStrategy path a
 * single `symbol:` takes — working-tree substitution included — and the drill
 * only adds what a batch needs: the request per row, the `#`↔`.` swap reported
 * as `resolvedAs`, an ambiguity cap, and a miss list.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath } from "../../../../src/core/contracts/types/codegraph.js";
import type { ScrollChunk } from "../../../../src/core/domains/explore/chunk-grouping/types.js";
import { SymbolSearchStrategy } from "../../../../src/core/domains/explore/strategies/symbol.js";
import { SymbolBatchDrill } from "../../../../src/core/domains/explore/symbol-batch.js";
import type { WorkingTreeView } from "../../../../src/core/domains/explore/working-tree/index.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { codeRow, fakeWorkingTreeView } from "./__fixtures__/working-tree-view.js";

describe("SymbolBatchDrill", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered, getPoint: vi.fn() } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  /** The index: answers each scroll with the rows whose key carries the queried token. */
  const indexHolds = (rows: ScrollChunk[]) => {
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) => {
      const [{ key, match }] = filter.must;
      return rows.filter((r) => {
        const v = r.payload[key];
        return (
          typeof v === "string" &&
          match.text !== undefined &&
          v.toLowerCase().includes(String(match.text).toLowerCase())
        );
      });
    });
  };

  const created: string[] = [];
  const drill = new SymbolBatchDrill((symbol) => {
    created.push(symbol);
    return new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol });
  });
  const run = async (addresses: string[], view?: WorkingTreeView) =>
    drill.execute(addresses, { collectionName: "c", limit: 50, ...(view ? { workingTreeView: view } : {}) });

  const FOO = "src/foo.ts";
  const method = (id: string, symbolId: string, content: string, relativePath = FOO) =>
    codeRow(id, {
      symbolId,
      name: symbolId.split(/[#.]/).pop(),
      parentSymbolId: symbolId.split(/[#.]/)[0],
      relativePath,
      content,
    });
  const index = [
    method("m1", "Foo#bar", "bar body"),
    method("m2", "Foo.create", "create body"),
    codeRow("f1", { symbolId: "helper", name: "helper", relativePath: "src/h.ts", content: "helper body" }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    created.length = 0;
  });

  it("answers every address with its own row, in request order", async () => {
    indexHolds(index);

    const answer = await run(["helper", "Foo#bar"]);

    expect(answer.rows.map((r) => [r.request, r.result.payload?.symbolId, r.result.payload?.content])).toEqual([
      ["helper", "helper", "helper body"],
      ["Foo#bar", "Foo#bar", "bar body"],
    ]);
    expect(answer.missing).toEqual([]);
  });

  it("answers a class address with its outline", async () => {
    indexHolds([
      codeRow("c1", { symbolId: "Foo", name: "Foo", chunkType: "class", relativePath: FOO, content: "class Foo" }),
      ...index,
    ]);

    const answer = await run(["Foo"]);

    expect(answer.rows).toHaveLength(1);
    expect(String(answer.rows[0].result.payload?.content)).toContain("Foo#bar");
  });

  it("merges the #partN windows of a split method into one body", async () => {
    const part = (n: number, startLine: number) =>
      codeRow(`p${n}`, {
        symbolId: `Foo#big#part${n}`,
        name: "big",
        parentSymbolId: "Foo#big",
        relativePath: FOO,
        content: `part ${n}`,
        startLine,
        endLine: startLine,
      });
    indexHolds([part(1, 10), part(2, 11)]);

    const answer = await run(["Foo#big"]);

    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0].result.payload?.symbolId).toBe("Foo#big");
  });

  it("retries the other separator and reports the id it resolved as", async () => {
    indexHolds(index);

    const answer = await run(["Foo.bar", "Foo#create"]);

    expect(answer.rows.map((r) => [r.request, r.resolvedAs, r.result.payload?.symbolId])).toEqual([
      ["Foo.bar", "Foo#bar", "Foo#bar"],
      ["Foo#create", "Foo.create", "Foo.create"],
    ]);
  });

  it("turns an address matching more than five symbols into an ambiguous miss", async () => {
    indexHolds(Array.from({ length: 6 }, (_, i) => method(`r${i}`, `C${i}#run`, "x", `src/c${i}.ts`)));

    const answer = await run(["run"]);

    expect(answer.rows).toEqual([]);
    expect(answer.missing).toEqual([
      { request: "run", message: "ambiguous: 6 matches — qualify with Class# or pathPattern" },
    ]);
  });

  it("lists an address no symbol answers as missing", async () => {
    indexHolds(index);

    const answer = await run(["NoSuch#thing"]);

    expect(answer.rows).toEqual([]);
    expect(answer.missing).toHaveLength(1);
    expect(answer.missing[0].request).toBe("NoSuch#thing");
    expect(answer.missing[0].treeState).toBeUndefined();
  });

  describe("on a linked working tree", () => {
    it("answers a modified symbol with the tree's body", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ changed: [FOO], rows: [method("t1", "Foo#bar", "tree bar body")] });

      const answer = await run(["Foo#bar"], view);

      expect(answer.rows[0].result.payload?.content).toBe("tree bar body");
      expect(view.marker.floors).toContain("chunks");
    });

    it("answers a symbol the tree added", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({
        changed: ["src/new.ts"],
        rows: [codeRow("n1", { symbolId: "fresh", name: "fresh", relativePath: "src/new.ts", content: "fresh body" })],
      });

      const answer = await run(["fresh", "helper"], view);

      expect(answer.rows.map((r) => r.result.payload?.content)).toEqual(["fresh body", "helper body"]);
    });

    it("lists a symbol whose file the tree deleted as missing with treeState deleted", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ deleted: ["src/h.ts"], rows: [] });

      const answer = await run(["helper"], view);

      expect(answer.rows).toEqual([]);
      expect(answer.missing).toEqual([{ request: "helper", message: expect.any(String), treeState: "deleted" }]);
    });

    it("keeps treeState on the row of a file still pending in the tree", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ indexServed: ["src/h.ts"], rows: [] });

      const answer = await run(["helper"], view);

      expect(answer.rows[0].result.treeState).toBe("modified");
    });
  });
});

// bd tea-rags-mcp-ll0s8 — through the codegraph hop: the Qdrant scroll misses
// both FQNs, so each address resolves via the real DuckDB symbol store. The
// nonexistent one must land in `missing`, never as another class's `#update`.
describe("SymbolBatchDrill — codegraph hop with a nonexistent FQN", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists a nonexistent FQN as missing instead of answering with a same-tail member of another class", async () => {
    dir = mkdtempSync(join(tmpdir(), "batch-ll0s8-"));
    const graph = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await graph.init();
    await runMigrations(graph, DATABASE_MIGRATIONS);
    const client = "app/controllers/client/signature_requests_controller.rb" as RelPath;
    const sites = "app/controllers/admin/sites_controller.rb" as RelPath;
    const clientUpdate = "Api::Client::SignatureRequestsController#update";
    const sitesUpdate = "Api::Admin::SitesController#update";
    for (const [rel, symbolId, chunkId] of [
      [client, clientUpdate, "chunk_client_update"],
      [sites, sitesUpdate, "chunk_sites_update"],
    ] as const) {
      await graph.upsertSymbols(rel, [
        { symbolId, fqName: symbolId, shortName: "update", relPath: rel, scope: symbolId.split(/#|::/).slice(0, -1) },
      ]);
      await graph.updateSymbolChunkIds(rel, new Map([[symbolId, chunkId]]));
    }

    const chunks: Record<string, { symbolId: string; relativePath: string }> = {
      chunk_client_update: { symbolId: clientUpdate, relativePath: client },
      chunk_sites_update: { symbolId: sitesUpdate, relativePath: sites },
    };
    const qdrant = {
      scrollFiltered: vi.fn().mockResolvedValue([]),
      getPoint: vi.fn(async (_c: string, id: string) => ({
        id,
        payload: { ...chunks[id], chunkType: "function", content: `${id} body`, startLine: 1, endLine: 3 },
      })),
    } as any;
    const resolver = { resolveSymbolChunk: async (_c: string, symbolId: string) => graph.findSymbolChunk(symbolId) };
    const drill = new SymbolBatchDrill(
      (symbol) =>
        new SymbolSearchStrategy(
          qdrant,
          { rerank: (r: any[]) => r } as any,
          [],
          [],
          { buildMergedFilter: () => undefined } as any,
          { symbol },
          resolver,
        ),
    );

    const guestUpdate = "Api::Guest::SignatureRequestsController#update";
    const answer = await drill.execute([clientUpdate, guestUpdate], { collectionName: "c", limit: 50 });
    await graph.close();

    expect(answer.rows.map((r) => [r.request, r.result.payload?.symbolId])).toEqual([[clientUpdate, clientUpdate]]);
    expect(answer.missing.map((m) => m.request)).toEqual([guestUpdate]);
  });
});
