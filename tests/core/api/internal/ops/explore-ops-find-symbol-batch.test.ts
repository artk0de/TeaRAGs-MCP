/**
 * find_symbol batch drill (N1) and directory outline (N2) through the facade:
 * input exclusivity, the lean batch payload and its overrides, the miss list,
 * ONE working-tree marker for the whole batch, and the directory / unknown-path
 * answers reaching the response.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import { InvalidParameterError } from "../../../../../src/core/api/public/errors.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";
import { codeRow, fakeWorkingTreeView } from "../../../domains/explore/__fixtures__/working-tree-view.js";

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A word-tokenized text index: every condition's tokens must be in the field's. */
function qdrantHolding(rows: ScrollChunk[]) {
  const scrollFiltered = vi.fn(async (_c: string, filter: { must: any[] }) =>
    rows.filter((row) =>
      filter.must.every(({ key, match }) => {
        const raw = row.payload[key];
        const value = typeof raw === "string" ? raw : "";
        if (match.text !== undefined) {
          const have = new Set(tokens(value));
          return tokens(match.text).every((t) => have.has(t));
        }
        return value === match.value;
      }),
    ),
  );
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered,
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    getPoint: vi.fn().mockResolvedValue(null),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const reranker = {
  hasCollectionStatsFor: vi.fn().mockReturnValue(false),
  setCollectionStats: vi.fn(),
  getCollectionStats: vi.fn().mockReturnValue(undefined),
  getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
  getFullPreset: vi.fn().mockReturnValue(undefined),
  getDescriptors: vi.fn().mockReturnValue([]),
  rerank: vi.fn((results: any[]) => results),
} as any;

const registry = {
  buildFilter: vi.fn().mockReturnValue(undefined),
  buildMergedFilter: vi.fn().mockImplementation((_typed: any, raw?: any) => raw),
  getAllFilters: vi.fn().mockReturnValue([]),
  getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
  getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
} as any;

const INDEX = [
  codeRow("m1", {
    symbolId: "Foo#bar",
    name: "bar",
    parentSymbolId: "Foo",
    relativePath: "src/lib/foo.ts",
    content: "bar body",
    git: { file: { commitCount: 3 } },
  }),
  codeRow("f1", { symbolId: "helper", name: "helper", relativePath: "src/lib/h.ts", content: "helper body" }),
];

describe("ExploreFacade.findSymbol batch and directory modes", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "find-symbol-batch-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const facade = (view?: WorkingTreeView) =>
    new ExploreFacade({
      qdrant: qdrantHolding(INDEX),
      embeddings: { embed: vi.fn() } as any,
      reranker,
      registry,
      collectionRegistry,
      driftReporter: {
        checkAndConsume: vi.fn().mockResolvedValue(null),
        checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
      } as any,
      payloadSignals: [],
      essentialKeys: [],
      ...(view ? { workingTreeOverlay: { view: vi.fn().mockResolvedValue(view) } } : {}),
    });

  describe("input", () => {
    it.each([
      ["symbol", { symbols: ["helper"], symbol: "helper" }],
      ["relativePath", { symbols: ["helper"], relativePath: "src/lib/h.ts" }],
      ["21 addresses", { symbols: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
      ["no address", { symbols: [] }],
    ])("rejects symbols with %s", async (_case, extra) => {
      await expect(facade().findSymbol({ collection: "code_x", ...extra })).rejects.toBeInstanceOf(
        InvalidParameterError,
      );
    });
  });

  describe("batch", () => {
    it("answers lean rows with the request column and lists misses", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbols: ["Foo.bar", "helper", "Nope#x"] });

      expect(response.results.map((r) => r.payload)).toEqual([
        {
          request: "Foo.bar",
          resolvedAs: "Foo#bar",
          symbolId: "Foo#bar",
          relativePath: "src/lib/foo.ts",
          startLine: 1,
          endLine: 3,
          content: "bar body",
        },
        {
          request: "helper",
          symbolId: "helper",
          relativePath: "src/lib/h.ts",
          startLine: 1,
          endLine: 3,
          content: "helper body",
        },
      ]);
      expect(response.missing).toEqual([{ request: "Nope#x", message: expect.any(String) }]);
    });

    it("keeps exactly the explicit fields, plus the request", async () => {
      const response = await facade().findSymbol({
        collection: "code_x",
        symbols: ["helper"],
        fields: ["relativePath"],
      });

      expect(response.results.map((r) => r.payload)).toEqual([{ request: "helper", relativePath: "src/lib/h.ts" }]);
    });

    it("restores the full payload under rerank", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbols: ["Foo#bar"], rerank: "relevance" });

      expect(response.results[0].payload).toMatchObject({ request: "Foo#bar", git: { file: { commitCount: 3 } } });
    });

    it("carries ONE working-tree marker for the batch, with the floors every address claimed", async () => {
      const view = fakeWorkingTreeView({
        changed: ["src/lib/h.ts"],
        rows: [codeRow("t1", { symbolId: "helper", name: "helper", relativePath: "src/lib/h.ts", content: "tree" })],
      });

      const response = await facade(view).findSymbol({ collection: "code_x", symbols: ["helper", "Foo#bar"] });

      expect(response.results.map((r) => r.payload?.content)).toEqual(["tree", "bar body"]);
      expect(response.workingTree?.floors).toContain("chunks");
      expect(response.results.every((r) => !("workingTree" in (r.payload ?? {})))).toBe(true);
    });
  });

  describe("batch with file paths (q1g6s.4)", () => {
    const files = { "src/lib/h.ts": "export function helper() {}\n", "src/lib/foo.ts": "class Foo {}\n" };

    it("answers two path entries with one file row each, kind file", async () => {
      const response = await facade(fakeWorkingTreeView({ files })).findSymbol({
        collection: "code_x",
        symbols: ["src/lib/h.ts", "src/lib/foo.ts"],
      });

      expect(response.results.map((r) => [r.payload?.request, r.payload?.kind, r.payload?.relativePath])).toEqual([
        ["src/lib/h.ts", "file", "src/lib/h.ts"],
        ["src/lib/foo.ts", "file", "src/lib/foo.ts"],
      ]);
      expect(response.results[0].payload?.content).toBe(files["src/lib/h.ts"]);
      expect(response.missing).toEqual([]);
    });

    it("answers path and symbol entries mixed, in request order", async () => {
      const response = await facade(fakeWorkingTreeView({ files })).findSymbol({
        collection: "code_x",
        symbols: ["Foo#bar", "src/lib/h.ts", "helper"],
      });

      expect(response.results.map((r) => [r.payload?.request, r.payload?.kind ?? r.payload?.symbolId])).toEqual([
        ["Foo#bar", "Foo#bar"],
        ["src/lib/h.ts", "file"],
        ["helper", "helper"],
      ]);
    });

    it("lists an unknown path entry in missing with the nearest indexed paths", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbols: ["src/lib/nope/h.ts", "helper"] });

      expect(response.results.map((r) => r.payload?.request)).toEqual(["helper"]);
      expect(response.missing).toEqual([
        {
          request: "src/lib/nope/h.ts",
          message: expect.stringContaining("unknown path"),
          suggestions: ["src/lib/h.ts", "src/lib/foo.ts"],
        },
      ]);
    });

    // bd tea-rags-mcp-yz10n: a batch is not `cat` — a path entry answers its
    // outline (member ids to drill), only a file of ≤60 lines its text.
    describe("path entries answer outlines, not text (yz10n)", () => {
      const linesOf = (n: number): string =>
        `${Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

      it("answers a file over 60 lines with its outline, though relativePath mode answers its text", async () => {
        const view = () => fakeWorkingTreeView({ files: { "src/lib/h.ts": linesOf(80) } });

        const batch = await facade(view()).findSymbol({ collection: "code_x", symbols: ["src/lib/h.ts"] });
        const single = await facade(view()).findSymbol({ collection: "code_x", relativePath: "src/lib/h.ts" });

        expect(batch.results).toHaveLength(1);
        expect(batch.results[0].payload?.kind).toBeUndefined();
        expect(batch.results[0].payload?.content).toContain("helper");
        expect(batch.results[0].payload?.content).not.toContain("export const v0");
        expect(single.results[0].payload?.kind).toBe("file");
        expect(batch.batchNotice).toMatch(/outline/);
      });

      it("answers a file of exactly 60 lines with its full text and no notice", async () => {
        const text = linesOf(60);
        const response = await facade(fakeWorkingTreeView({ files: { "src/lib/h.ts": text } })).findSymbol({
          collection: "code_x",
          symbols: ["src/lib/h.ts"],
        });

        expect(response.results[0].payload).toMatchObject({ kind: "file", content: text, endLine: 60 });
        expect(response.batchNotice).toBeUndefined();
      });

      it("refuses a directory entry into missing with a relativePath hint, answering the rest", async () => {
        const response = await facade().findSymbol({ collection: "code_x", symbols: ["src/lib", "helper"] });

        expect(response.results.map((r) => r.payload?.request)).toEqual(["helper"]);
        expect(response.missing).toEqual([
          {
            request: "src/lib",
            message: "directory — call find_symbol(relativePath: src/lib) on its own",
          },
        ]);
        expect(response.directory).toBeUndefined();
        expect(response.batchNotice).toMatch(/directory/);
      });

      it("adds no notice to a batch of symbol ids", async () => {
        const response = await facade().findSymbol({ collection: "code_x", symbols: ["helper", "Foo#bar"] });

        expect(response.batchNotice).toBeUndefined();
      });
    });

    it("keeps FQN entries with ::, # or . as symbols", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbols: ["Foo.bar", "A::B#c"] });

      expect(response.results.map((r) => [r.payload?.request, r.payload?.symbolId])).toEqual([["Foo.bar", "Foo#bar"]]);
      expect(response.missing).toEqual([{ request: "A::B#c", message: expect.stringContaining("unknown symbol") }]);
    });
  });

  describe("directory", () => {
    it("answers a directory path with file rows and the directory frame", async () => {
      const response = await facade().findSymbol({ collection: "code_x", relativePath: "src/lib/" });

      expect(response.results.map((r) => r.payload?.relativePath)).toEqual(["src/lib/foo.ts", "src/lib/h.ts"]);
      expect(response.directory).toEqual({
        kind: "directory",
        dir: "src/lib",
        subdirs: [],
        total: 2,
        truncated: false,
      });
      expect(response.empty).toBeUndefined();
    });

    it("keeps each file row's top-level symbols through the default payload projection", async () => {
      const response = await facade().findSymbol({ collection: "code_x", relativePath: "src/lib/" });

      expect(response.results.every((r) => Array.isArray(r.payload?.symbols))).toBe(true);
    });

    // bd tea-rags-mcp-03yel: the file row's `kind` must survive the default
    // content projection (N4), or the caller cannot tell text from outline.
    it("answers a small file with its full text through the default payload projection", async () => {
      const text = "export function helper() {}\n";
      const view = fakeWorkingTreeView({ files: { "src/lib/h.ts": text } });

      const response = await facade(view).findSymbol({ collection: "code_x", relativePath: "src/lib/h.ts" });

      expect(response.results).toHaveLength(1);
      expect(response.results[0].payload).toMatchObject({
        kind: "file",
        relativePath: "src/lib/h.ts",
        content: text,
        startLine: 1,
        endLine: 1,
      });
    });

    it("explains an unknown path with the nearest indexed paths", async () => {
      const response = await facade().findSymbol({ collection: "code_x", relativePath: "src/lib/nope/h.ts" });

      expect(response.results).toEqual([]);
      expect(response.empty).toMatchObject({ reason: "unknownPath", suggestions: ["src/lib/h.ts", "src/lib/foo.ts"] });
    });
  });

  describe("single symbol miss (N6)", () => {
    it("an unknown symbol answers empty.unknownSymbol with a message", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbol: "NoSuchThingAtAll" });

      expect(response.results).toEqual([]);
      expect(response.empty).toMatchObject({
        reason: "unknownSymbol",
        message: expect.stringContaining("NoSuchThingAtAll"),
      });
    });

    it("the wrong separator suggests the swapped id", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbol: "Foo.bar" });

      expect(response.empty).toMatchObject({ reason: "unknownSymbol", suggestions: ["Foo#bar"] });
    });

    it("a #partN id of an existing parent suggests the parent", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbol: "Foo#bar#part2" });

      expect(response.empty).toMatchObject({ reason: "unknownSymbol", suggestions: ["Foo#bar"] });
    });

    it("a found symbol carries no empty block", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbol: "helper" });

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.empty).toBeUndefined();
    });

    it("a batch miss stays in missing[] and adds no empty block", async () => {
      const response = await facade().findSymbol({ collection: "code_x", symbols: ["Nope#x"] });

      expect(response.missing).toHaveLength(1);
      expect(response.empty).toBeUndefined();
    });
  });
});
