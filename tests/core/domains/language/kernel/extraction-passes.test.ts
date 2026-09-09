/**
 * The extraction pass-runner (E1 seam 0, bd tea-rags-mcp-pss0q). The load-bearing
 * assertion is the identity one: with no passes the composed walker must return
 * the native walker's OWN object, because that is what makes wiring Ruby and
 * Python through this engine a relocation rather than a behaviour change.
 */
import { describe, expect, it, vi } from "vitest";

import type { AstNode, MaterializedTree } from "../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WalkContext, WalkInput } from "../../../../../src/core/contracts/types/language.js";
import {
  composeExtractionWalker,
  runExtractionPasses,
  toWalkContext,
  type ExtractionFacetPass,
} from "../../../../../src/core/domains/language/kernel/extraction-passes.js";

function stubNode(type = "program"): AstNode {
  return {
    type,
    text: "",
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    children: [],
    namedChildren: [],
    childCount: 0,
    namedChildCount: 0,
    isNamed: true,
    child: () => null,
    namedChild: () => null,
    childForFieldName: () => null,
    parent: null,
    previousNamedSibling: null,
  };
}

function stubInput(overrides: Partial<WalkInput> = {}): WalkInput {
  const tree: MaterializedTree = { rootNode: stubNode() };
  return {
    tree,
    code: "class User; end",
    relPath: "app/models/user.rb",
    language: "ruby",
    chunks: [{ symbolId: "User", startLine: 1, endLine: 1, scope: [] }],
    ...overrides,
  };
}

function nativeExtraction(input: WalkInput): FileExtraction {
  return {
    relPath: input.relPath,
    language: input.language,
    imports: [],
    chunks: [],
    fileScope: ["User"],
  };
}

describe("runExtractionPasses", () => {
  it("returns the native extraction BY IDENTITY when there are no passes", () => {
    const native = nativeExtraction(stubInput());
    expect(runExtractionPasses(native, [], stubNode(), toWalkContext(stubInput()))).toBe(native);
  });

  it("folds each pass in order, so a later pass merges onto the earlier one's result", () => {
    const native = nativeExtraction(stubInput());
    const first: ExtractionFacetPass = {
      run: () => ({ fileScope: ["First"] }),
    };
    const second: ExtractionFacetPass = {
      run: () => ({ fileScope: ["Second"] }),
    };
    const merged = runExtractionPasses(native, [first, second], stubNode(), toWalkContext(stubInput()));
    expect(merged.fileScope).toEqual(["User", "First", "Second"]);
    expect(native.fileScope).toEqual(["User"]);
  });

  it("hands every pass the root node and the walk context", () => {
    const root = stubNode("module");
    const ctx = toWalkContext(stubInput());
    const run = vi.fn(() => ({}));
    runExtractionPasses(nativeExtraction(stubInput()), [{ run }], root, ctx);
    expect(run).toHaveBeenCalledWith(root, ctx);
  });
});

describe("toWalkContext", () => {
  it("carries code, relPath, language and chunks straight through", () => {
    const input = stubInput();
    expect(toWalkContext(input)).toMatchObject({
      code: input.code,
      relPath: input.relPath,
      language: input.language,
      chunks: input.chunks,
    });
  });

  it("omits gemfileContent entirely when the run has no Gemfile", () => {
    expect("gemfileContent" in toWalkContext(stubInput())).toBe(false);
  });

  it("threads gemfileContent when the run has one", () => {
    const ctx: WalkContext = toWalkContext(stubInput({ gemfileContent: "gem 'rails'" }));
    expect(ctx.gemfileContent).toBe("gem 'rails'");
  });

  it("leaves dispatchTableNames absent — the native walker owns that channel", () => {
    expect("dispatchTableNames" in toWalkContext(stubInput())).toBe(false);
  });
});

describe("composeExtractionWalker", () => {
  it("returns the native walker's own object when the pass list is empty", () => {
    const produced: FileExtraction[] = [];
    const walker = composeExtractionWalker({
      walk: (input) => {
        const out = nativeExtraction(input);
        produced.push(out);
        return out;
      },
      nameOf: () => null,
      passes: [],
    });
    const result = walker.walk(stubInput());
    expect(result).toBe(produced[0]);
    expect(produced).toHaveLength(1);
  });

  it("merges the pass output when the pass list is not empty", () => {
    const walker = composeExtractionWalker({
      walk: nativeExtraction,
      nameOf: () => null,
      passes: [{ run: () => ({ fileScope: ["FromPass"] }) }],
    });
    expect(walker.walk(stubInput()).fileScope).toEqual(["User", "FromPass"]);
  });

  it("passes nameOf through untouched", () => {
    const nameOf = vi.fn(() => null);
    expect(composeExtractionWalker({ walk: nativeExtraction, nameOf, passes: [] }).nameOf).toBe(nameOf);
  });
});
