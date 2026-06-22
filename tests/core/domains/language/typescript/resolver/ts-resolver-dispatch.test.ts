import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  HierarchyView,
  InheritanceEdge,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TsCompilerOptions } from "../../../../../../src/core/domains/language/typescript/resolver/ts-path-mapper.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions: TsCompilerOptions = { baseUrl: ".", paths: {} };

const tableWith = (
  ...files: [string, { symbolId: string; fqName: string; shortName: string; relPath: string; scope: string[] }[]][]
): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]) => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/** Minimal HierarchyView: a flat descendants map keyed by fqName. */
function hierarchyOf(descendants: Record<string, string[]>): HierarchyView {
  const toEdges = (names: string[]): InheritanceEdge[] =>
    names.map((sourceFqName) => ({
      sourceFqName,
      ancestorFqName: "",
      ancestorSymbolId: null,
      kind: "implements" as const,
      depth: 1,
    }));
  return {
    getAncestors: () => [],
    getDescendants: (fqName) => toEdges(descendants[fqName] ?? []),
  };
}

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

describe("TSCallResolver.resolveDispatch — CHA cone fan-out for interface-typed receivers (k4wpn)", () => {
  const resolver = new TSCallResolver(tsOptions);

  it("CONE WINS: an interface-typed receiver fans out to its implementers' checkHealth (confidence 1/N)", () => {
    const symbolTable = tableWith(
      [
        "src/embeddings/ollama.ts",
        [
          sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
          sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
        ],
      ],
      [
        "src/embeddings/jina.ts",
        [
          sym("JinaProvider", "JinaProvider", "src/embeddings/jina.ts", []),
          sym("JinaProvider#checkHealth", "checkHealth", "src/embeddings/jina.ts", ["JinaProvider"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "embeddings.checkHealth",
      receiver: "embeddings",
      member: "checkHealth",
      startLine: 1,
    };
    const edges = sortEdges(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
          hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider", "JinaProvider"] }),
        }),
      ),
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/embeddings/jina.ts",
        targetSymbolId: "JinaProvider#checkHealth",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "src/embeddings/ollama.ts",
        targetSymbolId: "OllamaProvider#checkHealth",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("returns [] for an interface with no implementers (external never cones)", () => {
    const symbolTable = tableWith([
      "src/embeddings/types.ts",
      [sym("EmbeddingProvider", "EmbeddingProvider", "src/embeddings/types.ts", [])],
    ]);
    const call: CallRef = {
      callText: "embeddings.checkHealth",
      receiver: "embeddings",
      member: "checkHealth",
      startLine: 1,
    };
    const edges = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
        hierarchy: hierarchyOf({}),
      }),
    );
    expect(edges).toEqual([]);
  });

  it("skips a descendant whose type is not in the symbol table (unknown file → no override pin)", () => {
    // `GhostProvider` is named as a descendant but declared nowhere — the
    // locator cannot resolve its file, so it contributes no cone edge. Only
    // the real `OllamaProvider` remains, fanning out solo.
    const symbolTable = tableWith([
      "src/embeddings/ollama.ts",
      [
        sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
        sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
      ],
    ]);
    const call: CallRef = {
      callText: "embeddings.checkHealth",
      receiver: "embeddings",
      member: "checkHealth",
      startLine: 1,
    };
    const edges = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
        hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider", "GhostProvider"] }),
      }),
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/embeddings/ollama.ts",
        targetSymbolId: "OllamaProvider#checkHealth",
        edgeKind: "cone",
        confidence: 1,
      },
    ]);
  });

  it("disambiguates an implementer declared in multiple files via the caller's imports", () => {
    // `OllamaProvider` is declared in two files; only the imported one is the
    // real implementer the cone should pin (resolveTypeFile import-narrowing).
    const symbolTable = tableWith(
      [
        "src/embeddings/ollama.ts",
        [
          sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
          sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
        ],
      ],
      [
        "src/vendor/ollama.ts",
        [
          sym("OllamaProvider", "OllamaProvider", "src/vendor/ollama.ts", []),
          sym("OllamaProvider#checkHealth", "checkHealth", "src/vendor/ollama.ts", ["OllamaProvider"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "embeddings.checkHealth",
      receiver: "embeddings",
      member: "checkHealth",
      startLine: 1,
    };
    const edges = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        callerFile: "src/app.ts",
        imports: [{ importText: "./embeddings/ollama", importedNames: ["OllamaProvider"] }],
        localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
        hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider"] }),
      }),
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/embeddings/ollama.ts",
        targetSymbolId: "OllamaProvider#checkHealth",
        edgeKind: "cone",
        confidence: 1,
      },
    ]);
  });

  it("returns [] when an implementer's type name is ambiguous and no import narrows it", () => {
    // Two files declare `OllamaProvider` and the caller imports neither — the
    // locator refuses to guess, so the cone yields nothing for that subtype.
    const symbolTable = tableWith(
      [
        "src/embeddings/ollama.ts",
        [
          sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
          sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
        ],
      ],
      [
        "src/vendor/ollama.ts",
        [
          sym("OllamaProvider", "OllamaProvider", "src/vendor/ollama.ts", []),
          sym("OllamaProvider#checkHealth", "checkHealth", "src/vendor/ollama.ts", ["OllamaProvider"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "embeddings.checkHealth",
      receiver: "embeddings",
      member: "checkHealth",
      startLine: 1,
    };
    const edges = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        callerFile: "src/app.ts",
        localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
        hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider"] }),
      }),
    );
    expect(edges).toEqual([]);
  });

  it("falls back to the default cone cap when CODEGRAPH_TS_CONE_MAX is invalid", () => {
    process.env.CODEGRAPH_TS_CONE_MAX = "not-a-number";
    try {
      const coneResolver = new TSCallResolver(tsOptions);
      const symbolTable = tableWith(
        [
          "src/embeddings/ollama.ts",
          [
            sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
            sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
          ],
        ],
        [
          "src/embeddings/jina.ts",
          [
            sym("JinaProvider", "JinaProvider", "src/embeddings/jina.ts", []),
            sym("JinaProvider#checkHealth", "checkHealth", "src/embeddings/jina.ts", ["JinaProvider"]),
          ],
        ],
      );
      const call: CallRef = {
        callText: "embeddings.checkHealth",
        receiver: "embeddings",
        member: "checkHealth",
        startLine: 1,
      };
      const edges = coneResolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
          hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider", "JinaProvider"] }),
        }),
      );
      // Default cap (8) > 2 implementers → fans out, never poly-base.
      expect(edges).toHaveLength(2);
      for (const e of edges) expect(e.edgeKind).toBe("cone");
    } finally {
      delete process.env.CODEGRAPH_TS_CONE_MAX;
    }
  });

  it("collapses to one poly-base edge when |implementers| > coneMax", () => {
    process.env.CODEGRAPH_TS_CONE_MAX = "1";
    try {
      const coneResolver = new TSCallResolver(tsOptions);
      const symbolTable = tableWith(
        [
          "src/embeddings/types.ts",
          [
            sym("EmbeddingProvider", "EmbeddingProvider", "src/embeddings/types.ts", []),
            sym("EmbeddingProvider#checkHealth", "checkHealth", "src/embeddings/types.ts", ["EmbeddingProvider"]),
          ],
        ],
        [
          "src/embeddings/ollama.ts",
          [
            sym("OllamaProvider", "OllamaProvider", "src/embeddings/ollama.ts", []),
            sym("OllamaProvider#checkHealth", "checkHealth", "src/embeddings/ollama.ts", ["OllamaProvider"]),
          ],
        ],
        [
          "src/embeddings/jina.ts",
          [
            sym("JinaProvider", "JinaProvider", "src/embeddings/jina.ts", []),
            sym("JinaProvider#checkHealth", "checkHealth", "src/embeddings/jina.ts", ["JinaProvider"]),
          ],
        ],
      );
      const call: CallRef = {
        callText: "embeddings.checkHealth",
        receiver: "embeddings",
        member: "checkHealth",
        startLine: 1,
      };
      const edges = coneResolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { embeddings: [{ line: 1, type: "EmbeddingProvider" }] },
          hierarchy: hierarchyOf({ EmbeddingProvider: ["OllamaProvider", "JinaProvider"] }),
        }),
      );
      expect(edges).toEqual([
        {
          sourceSymbolId: null,
          targetRelPath: "src/embeddings/types.ts",
          targetSymbolId: "EmbeddingProvider#checkHealth",
          edgeKind: "poly-base",
          confidence: 1,
        },
      ]);
    } finally {
      delete process.env.CODEGRAPH_TS_CONE_MAX;
    }
  });
});
