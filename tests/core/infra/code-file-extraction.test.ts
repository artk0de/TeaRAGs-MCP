/**
 * `extractCodeFileFromText` — the one parse → inert gate → materialize →
 * collect → walk sequence both codegraph extraction entry points delegate to
 * (bd tea-rags-mcp-raohg). Every runtime collaborator is injected, so the
 * walker, symbol collector and composer here are fakes; the parser is a real
 * tree-sitter parser because the inert gate and the materializer read the
 * native tree.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it, vi } from "vitest";

import type { FileExtraction } from "../../../src/core/contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageWalker,
  SymbolIdComposer,
  WalkInput,
} from "../../../src/core/contracts/types/language.js";
import {
  extractCodeFileFromText,
  type CodeFileExtractionRequest,
} from "../../../src/core/infra/code-file-extraction.js";

function pythonParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser;
}

const WALKED: FileExtraction = { relPath: "walked.py", language: "python", imports: [], chunks: [], fileScope: [] };
const CHUNKS = [{ symbolId: "run", startLine: 1, endLine: 2, scope: [] }];
const composer = { compose: vi.fn() } as unknown as SymbolIdComposer;

function fakeWalker(extractionBearingNodeTypes?: readonly string[]) {
  const walk = vi.fn((_input: WalkInput) => WALKED);
  const nameOf = vi.fn(() => null);
  const walker: LanguageWalker = { walk, nameOf, extractionBearingNodeTypes };
  return { walker, walk, nameOf };
}

function request(text: string, extra: Partial<CodeFileExtractionRequest> = {}): CodeFileExtractionRequest {
  return {
    relPath: "pkg/job.py",
    text,
    language: "python",
    scopeSeparator: ".",
    disambiguateOverloads: false,
    ...extra,
  };
}

describe("extractCodeFileFromText", () => {
  it("answers the empty extraction for an inert file without collecting or walking", () => {
    const { walker, walk } = fakeWalker(["function_definition", "call"]);
    const collectSymbols = vi.fn<CollectSymbolsFn>(() => CHUNKS);

    const extraction = extractCodeFileFromText(
      { parser: pythonParser(), walker, collectSymbols, composer },
      request('CODES = {"AD": "Andorra"}\n'),
    );

    expect(extraction).toEqual({ relPath: "pkg/job.py", language: "python", imports: [], chunks: [], fileScope: [] });
    expect(collectSymbols).not.toHaveBeenCalled();
    expect(walk).not.toHaveBeenCalled();
  });

  it("collects symbols over the materialized tree and walks that same tree with the run context", () => {
    const { walker, walk, nameOf } = fakeWalker(["function_definition", "call"]);
    const collectSymbols = vi.fn<CollectSymbolsFn>(() => CHUNKS);
    const declaredDependencies = new Set(["django"]);
    const text = "def run():\n    go()\n";

    const extraction = extractCodeFileFromText(
      { parser: pythonParser(), walker, collectSymbols, composer },
      request(text, {
        disambiguateOverloads: true,
        gemfileContent: "gem 'rails'",
        declaredDependencies,
      }),
    );

    expect(extraction).toBe(WALKED);
    expect(collectSymbols).toHaveBeenCalledTimes(1);
    const [tree, boundNameOf, separator, disambiguate, passedComposer] = collectSymbols.mock.calls[0];
    expect(separator).toBe(".");
    expect(disambiguate).toBe(true);
    expect(passedComposer).toBe(composer);
    // Materialized, not native: the plain-JS tree slices text off the source.
    expect(tree.rootNode.type).toBe("module");
    expect(tree.rootNode.text).toBe(text);
    // A native SyntaxNode carries a back-reference to its Tree; the materialized node does not.
    expect(tree.rootNode).not.toHaveProperty("tree");

    boundNameOf(tree.rootNode);
    expect(nameOf).toHaveBeenCalledWith(tree.rootNode, "gem 'rails'");

    expect(walk).toHaveBeenCalledTimes(1);
    const input = walk.mock.calls[0][0];
    expect(input.tree).toBe(tree);
    expect(input).toMatchObject({
      code: text,
      relPath: "pkg/job.py",
      language: "python",
      chunks: CHUNKS,
      gemfileContent: "gem 'rails'",
      declaredDependencies,
    });
  });

  it("walks every file when the walker makes no inertness claim", () => {
    const { walker, walk } = fakeWalker(undefined);
    const collectSymbols = vi.fn<CollectSymbolsFn>(() => []);

    extractCodeFileFromText({ parser: pythonParser(), walker, collectSymbols, composer }, request("X = 1\n"));

    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("propagates what the parser throws", () => {
    const { walker } = fakeWalker(undefined);
    const parser = {
      parse: () => {
        throw new Error("parse exploded");
      },
    };
    expect(() =>
      extractCodeFileFromText({ parser, walker, collectSymbols: vi.fn(), composer }, request("def run(): pass\n")),
    ).toThrow("parse exploded");
  });

  it("propagates what the walker throws", () => {
    const { walker, walk } = fakeWalker(undefined);
    walk.mockImplementation(() => {
      throw new Error("walk exploded");
    });
    expect(() =>
      extractCodeFileFromText(
        { parser: pythonParser(), walker, collectSymbols: vi.fn(() => []), composer },
        request("def run(): pass\n"),
      ),
    ).toThrow("walk exploded");
  });
});
