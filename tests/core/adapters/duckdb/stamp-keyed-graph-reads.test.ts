/**
 * `withStampKeyedGraphReads` (bd tea-rags-mcp-lnor0): the read handle
 * `GraphDbClientPool#acquireReader` hands out serves the whole-graph reads —
 * the ones that depend only on the index — from one `StampKeyedReadCache`
 * across handles, reviews and tools, keyed by the database write stamp. Every
 * other call reaches the real client unchanged, a path-scoped type-row read
 * is never held, and a held value is deep-frozen so no consumer can corrupt
 * what the next caller reads.
 */
import { describe, expect, it, vi } from "vitest";

import { withStampKeyedGraphReads } from "../../../../src/core/adapters/duckdb/stamp-keyed-graph-reads.js";
import type { GraphDbClient, TypeNameQuery } from "../../../../src/core/contracts/types/codegraph.js";
import { StampKeyedReadCache } from "../../../../src/core/primitives/collections/index.js";

const WHOLE_PROJECT: TypeNameQuery = {
  pathPrefixes: [],
  kinds: ["class"],
  nonProductionPaths: { caseInsensitive: [], caseSensitive: [] },
};

function stubClient() {
  return {
    name: "client",
    readFileDependencyGraph: vi.fn(async () => ({ files: [{ relPath: "a.ts" }], edges: [] })),
    readFileReexportEdges: vi.fn(async () => [
      { sourceRelPath: "i.ts", targetRelPath: "a.ts", reexportedExportNames: ["A"] },
    ]),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: null, edges: [] })),
    readNonPublicMemberEdges: vi.fn(async (languages: readonly string[]) => languages.map((l) => ({ l }))),
    loadHierarchySnapshot: vi.fn(async () => ({ ancestorsBySource: {}, descendantsByAncestor: {} })),
    readTypeNameRows: vi.fn(async (q: TypeNameQuery) => [{ symbolId: q.pathPrefixes.join(",") || "*" }]),
    listAllSymbols: vi.fn(async () => [{ relPath: "a.ts", fqName: "A" }]),
    listFileContentHashes: vi.fn(async () => [{ relPath: "a.ts", contentHash: null }]),
    getFanIn: vi.fn(async function (this: { name: string }) {
      return this.name;
    }),
    close: vi.fn(async () => undefined),
  };
}

function handles(stamp: () => string | undefined = () => "gen-1") {
  const client = stubClient();
  const cache = new StampKeyedReadCache();
  const open = () => withStampKeyedGraphReads(client as unknown as GraphDbClient, "code_a_v1", stamp, cache);
  return { client, open };
}

describe("withStampKeyedGraphReads (bd tea-rags-mcp-lnor0)", () => {
  it("serves every whole-graph read from the cache to a later handle under the same stamp", async () => {
    const { client, open } = handles();
    const readAll = async (graphDb: GraphDbClient) =>
      Promise.all([
        graphDb.readFileDependencyGraph(),
        graphDb.readTemporalCochangeGraph(),
        graphDb.readFileReexportEdges(),
        graphDb.readNonPublicMemberEdges(["python"]),
        graphDb.loadHierarchySnapshot(),
        graphDb.readTypeNameRows(WHOLE_PROJECT),
        graphDb.listAllSymbols(),
        graphDb.listFileContentHashes(),
      ]);

    const first = await readAll(open());
    const second = await readAll(open());

    second.forEach((value, i) => {
      expect(value).toBe(first[i]);
    });
    for (const read of [
      client.readFileDependencyGraph,
      client.readTemporalCochangeGraph,
      client.readFileReexportEdges,
      client.readNonPublicMemberEdges,
      client.loadHierarchySnapshot,
      client.readTypeNameRows,
      client.listAllSymbols,
      client.listFileContentHashes,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("re-reads after a write moved the stamp (the simulated index run)", async () => {
    let stamp = "gen-1";
    const { client, open } = handles(() => stamp);

    await open().readFileDependencyGraph();
    stamp = "gen-2";
    await open().readFileDependencyGraph();
    await open().readFileDependencyGraph();

    expect(client.readFileDependencyGraph).toHaveBeenCalledTimes(2);
  });

  it("keys the member edges by their languages and the type rows by their query", async () => {
    const { client, open } = handles();
    const graphDb = open();

    const python = await graphDb.readNonPublicMemberEdges(["python"]);
    const ruby = await graphDb.readNonPublicMemberEdges(["ruby"]);
    await graphDb.readNonPublicMemberEdges(["python"]);
    await graphDb.readTypeNameRows(WHOLE_PROJECT);
    await graphDb.readTypeNameRows({ ...WHOLE_PROJECT, languages: ["ruby"] });
    await graphDb.readTypeNameRows({ ...WHOLE_PROJECT, languages: ["ruby"] });

    expect(python).not.toEqual(ruby);
    expect(client.readNonPublicMemberEdges).toHaveBeenCalledTimes(2);
    expect(client.readTypeNameRows).toHaveBeenCalledTimes(2);
  });

  it("never holds a path-scoped type-row read — it is no whole-graph read", async () => {
    const { client, open } = handles();
    const scoped = { ...WHOLE_PROJECT, pathPrefixes: ["src/a.ts"] };

    await open().readTypeNameRows(scoped);
    await open().readTypeNameRows(scoped);

    expect(client.readTypeNameRows).toHaveBeenCalledTimes(2);
  });

  it("never holds a failed read", async () => {
    const { client, open } = handles();
    client.readFileDependencyGraph.mockRejectedValueOnce(new Error("daemon down"));

    await expect(open().readFileDependencyGraph()).rejects.toThrow("daemon down");
    await open().readFileDependencyGraph();
    await open().readFileDependencyGraph();

    expect(client.readFileDependencyGraph).toHaveBeenCalledTimes(2);
  });

  it("reads through without a stamp (no database file to stamp)", async () => {
    const { client, open } = handles(() => undefined);

    await open().readFileDependencyGraph();
    await open().readFileDependencyGraph();

    expect(client.readFileDependencyGraph).toHaveBeenCalledTimes(2);
  });

  it("hands out deep-frozen values: a consumer that mutates a held read throws instead of corrupting it", async () => {
    const { open } = handles();

    const graph = await open().readFileDependencyGraph();
    const symbols = await open().listAllSymbols();

    expect(Object.isFrozen(graph.files[0])).toBe(true);
    expect(() => graph.edges.push(graph.edges[0])).toThrow(TypeError);
    expect(() => symbols.splice(0, 1)).toThrow(TypeError);
  });

  it("passes every other member through to the client, bound to it", async () => {
    const { client, open } = handles();
    const graphDb = open();

    expect(await graphDb.getFanIn("a.ts")).toBe("client");
    await graphDb.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
