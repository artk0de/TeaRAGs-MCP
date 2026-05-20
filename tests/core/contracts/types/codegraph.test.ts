import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CalleeEdge,
  CallerEdge,
  CallRef,
  CallResolver,
  ChunkExtraction,
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphChunkPreview,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  ImportRef,
  RelPath,
  ResolvedTarget,
  SymbolDefinition,
  SymbolId,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("codegraph contracts", () => {
  it("re-exports through the contracts barrel", async () => {
    const barrel = await import("../../../../src/core/contracts/index.js");
    expect(typeof barrel).toBe("object");
  });

  it("FileExtraction has the documented shape", () => {
    const sample: FileExtraction = {
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [{ importText: "./bar", startLine: 1 }],
      chunks: [
        {
          symbolId: "Foo.bar",
          scope: ["Foo"],
          calls: [{ callText: "Baz.qux()", receiver: "Baz", member: "qux", startLine: 4 }],
        },
      ],
      fileScope: [],
    };
    expect(sample.chunks[0].calls[0].member).toBe("qux");
  });

  it("GraphDbClient interface lists every required method", () => {
    const required: (keyof GraphDbClient)[] = [
      "init",
      "close",
      "upsertFile",
      "removeFile",
      "getFanIn",
      "getFanOut",
      "getCallers",
      "getCallees",
      "getCalledByCount",
      "getCallSiteCount",
      "hasData",
    ];
    expect(required.length).toBe(11);
  });

  it("type aliases RelPath and SymbolId resolve to string", () => {
    const p: RelPath = "src/a.ts";
    const s: SymbolId = "Foo.bar";
    expect(typeof p).toBe("string");
    expect(typeof s).toBe("string");
  });

  it("CallerEdge and CalleeEdge have the documented field sets", () => {
    const caller: CallerEdge = {
      sourceSymbolId: "A.f",
      sourceRelPath: "src/a.ts",
      callExpression: "B.x()",
    };
    const callee: CalleeEdge = {
      targetSymbolId: "B.x",
      targetRelPath: "src/b.ts",
      callExpression: "B.x()",
    };
    expect(caller.sourceSymbolId).toBe("A.f");
    expect(callee.targetSymbolId).toBe("B.x");
  });

  it("ResolvedTarget allows null targetSymbolId for file-only resolution", () => {
    const partial: ResolvedTarget = { targetRelPath: "src/dyn.ts", targetSymbolId: null };
    expect(partial.targetSymbolId).toBeNull();
  });

  it("GraphChunkPreview holds the minimal chunk shape returned by graph tools", () => {
    const preview: GraphChunkPreview = {
      symbolId: "Foo.bar",
      relPath: "src/foo.ts",
      startLine: 1,
      endLine: 10,
      preview: "function bar() {}",
    };
    expect(preview.preview.startsWith("function")).toBe(true);
  });

  // Type-only smoke: the named types exist and compile. The runtime asserts
  // are degenerate but pin the imports — if a type is removed, this file
  // fails type-check before vitest even runs.
  it("named types compile", () => {
    const _imp: ImportRef = { importText: "./x", startLine: 1 };
    const _chunkExt: ChunkExtraction = { symbolId: "f", scope: [], calls: [] };
    const _callRef: CallRef = { callText: "f()", receiver: null, member: "f", startLine: 1 };
    const _sink: ExtractionSink = {
      write: async () => undefined,
      finish: async () => undefined,
    };
    const _table: GlobalSymbolTable = {
      upsertFile: () => undefined,
      removeFile: () => undefined,
      lookup: () => [],
      lookupByShortName: () => [],
      size: () => 0,
    };
    const _def: SymbolDefinition = {
      symbolId: "s",
      fqName: "s",
      shortName: "s",
      relPath: "s.ts",
      scope: [],
    };
    const _resolver: CallResolver = {
      language: "typescript",
      resolve: () => null,
    };
    const _ctx: CallContext = {
      callerFile: "a.ts",
      callerScope: [],
      imports: [],
      symbolTable: _table,
    };
    const _node: GraphFileNode = { relPath: "a.ts", language: "typescript" };
    const _edges: GraphEdges = { fileEdges: [], methodEdges: [] };
    expect(_imp.importText).toBe("./x");
    expect(_chunkExt.symbolId).toBe("f");
    expect(_callRef.member).toBe("f");
    expect(_def.shortName).toBe("s");
    expect(_resolver.language).toBe("typescript");
    expect(_ctx.callerFile).toBe("a.ts");
    expect(_node.relPath).toBe("a.ts");
    expect(_edges.fileEdges).toEqual([]);
    expect(_sink).toBeDefined();
  });
});
