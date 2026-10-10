/**
 * A local bound by an exact construction has a known runtime class
 * (bd tea-rags-mcp-0qaht.66).
 *
 *     account_reach_finder = AccountReachFinder.new(@account)
 *     account_reach_finder.inboxes
 *
 * `account_reach_finder` holds an `AccountReachFinder`, never a subclass, so
 * `.inboxes` dispatches to the class's own definer — not to the overriding
 * `CollectionReachFinder#inboxes` the CHA cone fans to for a declared type. A
 * declared type (a YARD `@param`), a memoized `||=` and a reassigned local keep
 * the cone: each may hold a subclass instance.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
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
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** `Finder` declares `inboxes`; `SubFinder < Finder` overrides it; `Leaf < Finder` inherits it. */
const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/lib/finder.rb", [
    sym("Finder", "Finder", "app/lib/finder.rb", []),
    sym("Finder#inboxes", "inboxes", "app/lib/finder.rb", ["Finder"]),
  ]);
  t.upsertFile("app/lib/sub_finder.rb", [
    sym("SubFinder", "SubFinder", "app/lib/sub_finder.rb", []),
    sym("SubFinder#inboxes", "inboxes", "app/lib/sub_finder.rb", ["SubFinder"]),
  ]);
  t.upsertFile("app/lib/leaf.rb", [sym("Leaf", "Leaf", "app/lib/leaf.rb", [])]);
  return t;
})();

const edge = (source: string, ancestor: string): InheritanceEdge => ({
  sourceFqName: source,
  ancestorFqName: ancestor,
  ancestorSymbolId: null,
  kind: "super",
  depth: 1,
});

const hierarchy: HierarchyView = {
  getAncestors: (fqName) => (fqName === "SubFinder" || fqName === "Leaf" ? [edge(fqName, "Finder")] : []),
  getDescendants: (fqName) => (fqName === "Finder" ? [edge("SubFinder", "Finder"), edge("Leaf", "Finder")] : []),
};

const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

/** Dispatch the `<receiver>.inboxes` call `src` makes on `callLine`, typed by the walker's own bindings. */
function dispatch(src: string, receiver: string, callLine: number): string[] {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const lines = src.split("\n").length;
  const extraction = extractFromRubyFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/services/svc.rb",
    language: "ruby",
    chunks: [{ symbolId: "Svc#call", startLine: 2, endLine: lines - 1, scope: ["Svc"] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  const call: CallRef = { callText: `${receiver}.inboxes`, receiver, member: "inboxes", startLine: callLine };
  const ctx: CallContext = {
    callerFile: "app/services/svc.rb",
    callerScope: ["Svc"],
    imports: [],
    symbolTable,
    hierarchy,
    ...(chunk.localBindings ? { localBindings: chunk.localBindings } : {}),
    ...(chunk.constructedLocals ? { constructedLocals: chunk.constructedLocals } : {}),
  };
  return edgesOf(new RubyCallResolver().resolveDispatch(call, ctx)).map((e) => `${e.targetSymbolId}:${e.edgeKind}`);
}

describe("Ruby exact-construction receiver (bd 0qaht.66)", () => {
  it("dispatches `x = X.new; x.m` to X's own declaration, not the subclass override", () => {
    const src = [
      "class Svc",
      "  def call",
      "    finder = Finder.new(@account)",
      "    finder.inboxes",
      "  end",
      "end",
    ].join("\n");
    expect(dispatch(src, "finder", 4)).toEqual(["Finder#inboxes:exact"]);
  });

  it("dispatches a constructed non-overriding subclass to the declaration it inherits", () => {
    const src = ["class Svc", "  def call", "    leaf = Leaf.new", "    leaf.inboxes", "  end", "end"].join("\n");
    // `Leaf` has no descendants, so the cone never engages — the exact chain answers.
    expect(dispatch(src, "leaf", 4)).toEqual([]);
  });

  it("keeps the cone for a YARD-declared parameter type", () => {
    const src = [
      "class Svc",
      "  # @param finder [Finder]",
      "  def call(finder)",
      "    finder.inboxes",
      "  end",
      "end",
    ].join("\n");
    expect(dispatch(src, "finder", 4)).toContain("SubFinder#inboxes:cone");
  });

  it("keeps the cone when the local is reassigned in the method", () => {
    const src = [
      "class Svc",
      "  def call",
      "    finder = Finder.new(@account)",
      "    finder = other_finder if swap?",
      "    finder.inboxes",
      "  end",
      "end",
    ].join("\n");
    expect(dispatch(src, "finder", 5)).toContain("SubFinder#inboxes:cone");
  });

  it("keeps the cone for a memoized `||=` construction", () => {
    const src = [
      "class Svc",
      "  def call",
      "    @f ||= nil",
      "    finder ||= Finder.new",
      "    finder.inboxes",
      "  end",
      "end",
    ].join("\n");
    expect(dispatch(src, "finder", 5)).toContain("SubFinder#inboxes:cone");
  });
});
