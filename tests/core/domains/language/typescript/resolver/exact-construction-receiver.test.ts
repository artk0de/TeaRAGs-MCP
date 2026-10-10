/**
 * A local bound by an exact construction has a known runtime class
 * (bd tea-rags-mcp-0qaht.66): `const finder = new Finder(); finder.inboxes()`
 * dispatches to `Finder`'s own declaration, never to the subclass override the
 * CHA cone fans to for a declared type. A typed parameter, an annotated local
 * and a reassigned `let` keep the cone: each may hold a subclass instance.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  HierarchyView,
  InheritanceEdge,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TsCompilerOptions } from "../../../../../../src/core/domains/language/typescript/resolver/program/ts-path-mapper.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions: TsCompilerOptions = { baseUrl: ".", paths: {} };

const def = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
  symbolKind: scope.length === 0 ? "class" : "method",
});

/** `Finder` declares `inboxes`; `SubFinder extends Finder` overrides it. */
const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("src/finder.ts", [
    def("Finder", "Finder", "src/finder.ts", []),
    def("Finder#inboxes", "inboxes", "src/finder.ts", ["Finder"]),
  ]);
  t.upsertFile("src/sub-finder.ts", [
    def("SubFinder", "SubFinder", "src/sub-finder.ts", []),
    def("SubFinder#inboxes", "inboxes", "src/sub-finder.ts", ["SubFinder"]),
  ]);
  return t;
})();

const subEdge: InheritanceEdge = {
  sourceFqName: "SubFinder",
  ancestorFqName: "Finder",
  ancestorSymbolId: null,
  kind: "super",
  depth: 1,
};
const hierarchy: HierarchyView = {
  getAncestors: (fqName) => (fqName === "SubFinder" ? [subEdge] : []),
  getDescendants: (fqName) => (fqName === "Finder" ? [subEdge] : []),
};

const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

/** Dispatch the `finder.inboxes()` call on `callLine` of `src`, typed by the walker's own bindings. */
function dispatch(src: string, callLine: number): string[] {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  const extraction = extractFromTypescriptFile({
    tree: parser.parse(src),
    code: src,
    relPath: "src/svc.ts",
    language: "typescript",
    chunks: [{ symbolId: "run", startLine: 1, endLine: src.split("\n").length, scope: [] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  const call: CallRef = { callText: "finder.inboxes", receiver: "finder", member: "inboxes", startLine: callLine };
  const ctx: CallContext = {
    callerFile: "src/svc.ts",
    callerScope: [],
    imports: [],
    symbolTable,
    hierarchy,
    ...(chunk.localBindings ? { localBindings: chunk.localBindings } : {}),
    ...(chunk.constructedLocals ? { constructedLocals: chunk.constructedLocals } : {}),
  };
  return edgesOf(new TSCallResolver(tsOptions).resolveDispatch(call, ctx)).map(
    (e) => `${e.targetSymbolId}:${e.edgeKind}`,
  );
}

describe("TypeScript exact-construction receiver (bd 0qaht.66)", () => {
  it("dispatches `const x = new X(); x.m()` to X's own declaration, not the subclass override", () => {
    const src = ["function run() {", "  const finder = new Finder(account);", "  finder.inboxes();", "}"].join("\n");
    expect(dispatch(src, 3)).toEqual(["Finder#inboxes:exact"]);
  });

  it("keeps the cone for a typed parameter", () => {
    const src = ["function run(finder: Finder) {", "  finder.inboxes();", "}"].join("\n");
    expect(dispatch(src, 2)).toContain("SubFinder#inboxes:cone");
  });

  it("keeps the cone for an annotated local, whatever its initializer", () => {
    const src = ["function run() {", "  const finder: Finder = new Finder();", "  finder.inboxes();", "}"].join("\n");
    expect(dispatch(src, 3)).toContain("SubFinder#inboxes:cone");
  });

  it("keeps the cone when the local is reassigned in the function", () => {
    const src = [
      "function run() {",
      "  let finder = new Finder();",
      "  if (swap) finder = pick();",
      "  finder.inboxes();",
      "}",
    ].join("\n");
    expect(dispatch(src, 4)).toContain("SubFinder#inboxes:cone");
  });
});
