/**
 * A local bound to an ActiveRecord RELATION carries the relation through the
 * call-result binding (bd tea-rags-mcp-89k7k.35.29).
 *
 *     result = collection_items              # has_many → container(CollectionItem)
 *     result = result.with_accounts          # scope on CollectionItem → container(CollectionItem)
 *     result.not_blocked_by(account)         # scope on CollectionItem
 *
 * A relation delegates to its model's class-level methods (scopes, `def self.`),
 * so a member call on it resolves on the ELEMENT class — never on whichever
 * class the owner-less flat `functionReturnTypes` map happens to name for a
 * namesake (mastodon: `scope.not_excluded_by_account` read as `Status`'s scope
 * when `scope` was an `Account` relation). The single-target bound-call path
 * used to decline every container answer; a relation over a project AR model is
 * now pinned on the element class, and a scope declared there keeps the
 * relation for the next link. A non-relation local reads exactly as before.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ChunkExtraction,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/models/collection_item.rb", [
    sym("CollectionItem", "CollectionItem", "app/models/collection_item.rb", []),
    sym("CollectionItem.with_accounts", "with_accounts", "app/models/collection_item.rb", ["CollectionItem"]),
    sym("CollectionItem.not_blocked_by", "not_blocked_by", "app/models/collection_item.rb", ["CollectionItem"]),
    sym("CollectionItem.ordered", "ordered", "app/models/collection_item.rb", ["CollectionItem"]),
  ]);
  t.upsertFile("app/models/account.rb", [
    sym("Account", "Account", "app/models/account.rb", []),
    sym("Account.not_excluded_by_account", "not_excluded_by_account", "app/models/account.rb", ["Account"]),
  ]);
  t.upsertFile("app/models/status.rb", [
    sym("Status", "Status", "app/models/status.rb", []),
    sym("Status.not_excluded_by_account", "not_excluded_by_account", "app/models/status.rb", ["Status"]),
    sym("Status.with_accounts", "with_accounts", "app/models/status.rb", ["Status"]),
    sym("Status.ordered", "ordered", "app/models/status.rb", ["Status"]),
  ]);
  t.upsertFile("app/models/listing.rb", [
    sym("Listing", "Listing", "app/models/listing.rb", []),
    sym("Listing.ordered", "ordered", "app/models/listing.rb", ["Listing"]),
  ]);
  t.upsertFile("app/services/report_builder.rb", [
    sym("ReportBuilder", "ReportBuilder", "app/services/report_builder.rb", []),
    sym("ReportBuilder#run", "run", "app/services/report_builder.rb", ["ReportBuilder"]),
  ]);
  return t;
})();

const relationOf = (name: string): RubyTypeRef => ({ form: "container", element: { form: "instance", name } });

/**
 * Owner-less flat facts naming the WRONG namesake for every scope below — the
 * shape that made the bare reading pick `Status` for an `Account` relation.
 */
const FLAT_RETURNS = {
  not_excluded_by_account: "Status",
  with_accounts: "Status",
  not_blocked_by: "Status",
  build_report: "ReportBuilder",
};

const STRUCTURED_RETURNS: Record<string, RubyTypeRef> = {
  "Holder#collection_items": relationOf("CollectionItem"),
  "Holder#default_accounts": relationOf("Account"),
  "Holder#plain_listings": relationOf("Listing"),
  "Holder#build_report": { form: "instance", name: "ReportBuilder" },
  "CollectionItem#with_accounts": relationOf("CollectionItem"),
  "CollectionItem#not_blocked_by": relationOf("CollectionItem"),
  "CollectionItem#ordered": relationOf("CollectionItem"),
  "Account#not_excluded_by_account": relationOf("Account"),
  "Status#not_excluded_by_account": relationOf("Status"),
  "Status#with_accounts": relationOf("Status"),
};

/** `CollectionItem` / `Account` / `Status` are AR models; `Listing` is not. */
const CLASS_ANCESTORS = {
  CollectionItem: ["ApplicationRecord"],
  Account: ["ApplicationRecord"],
  Status: ["ApplicationRecord"],
  ApplicationRecord: ["ActiveRecord::Base"],
};

function chunkOf(src: string, startLine: number, endLine: number): ChunkExtraction {
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath: "app/models/holder.rb",
    language: "ruby",
    chunks: [{ symbolId: "Holder#items", startLine, endLine, scope: ["Holder"] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  return chunk;
}

function contextFor(chunk: ChunkExtraction): CallContext {
  return {
    callerFile: "app/models/holder.rb",
    callerScope: ["Holder"],
    callerSymbolId: "Holder#items",
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    functionReturnTypes: FLAT_RETURNS,
    structuredReturnTypes: STRUCTURED_RETURNS,
    classAncestors: CLASS_ANCESTORS,
  };
}

function siteOf(chunk: ChunkExtraction, callText: string, line: number): CallRef {
  const site = chunk.calls.find((c) => c.callText === callText && c.startLine === line);
  if (site === undefined) throw new Error(`walker emitted no call ${callText} on line ${line}`);
  return site;
}

const resolver = new RubyCallResolver();

const pinnedOn = (targetSymbolId: string, targetRelPath: string) => ({ targetSymbolId, targetRelPath });

/** The resolver chain's answer for one call site, reduced to where it points. */
function attempt(src: string, callText: string, line: number) {
  const lines = src.split("\n").length;
  const chunk = chunkOf(src, 2, lines - 1);
  const target = resolver.resolve(siteOf(chunk, callText, line), contextFor(chunk));
  return target === null ? null : { targetSymbolId: target.targetSymbolId, targetRelPath: target.targetRelPath };
}

describe("a relation-typed call-result local resolves on the element class (89k7k.35.29)", () => {
  it("a has_many association local reaches a scope declared on the element class", () => {
    const src = [
      "class Holder",
      "  def items",
      "    result = collection_items",
      "    result.with_accounts",
      "  end",
      "end",
    ].join("\n");
    expect(attempt(src, "result.with_accounts", 4)).toEqual(
      pinnedOn("CollectionItem.with_accounts", "app/models/collection_item.rb"),
    );
  });

  it("a scope-returning method local reaches the chained scope on ITS element, not the flat namesake", () => {
    const src = [
      "class Holder",
      "  def items(viewer)",
      "    scope = default_accounts",
      "    scope = scope.not_excluded_by_account(viewer) unless viewer.nil?",
      "    scope.merge(viewer)",
      "  end",
      "end",
    ].join("\n");
    expect(attempt(src, "scope.not_excluded_by_account(viewer)", 4)).toEqual(
      pinnedOn("Account.not_excluded_by_account", "app/models/account.rb"),
    );
  });

  it("keeps the relation across a type-preserving scope chain", () => {
    const src = [
      "class Holder",
      "  def items(account)",
      "    result = collection_items",
      "    result = result.with_accounts",
      "    result = result.not_blocked_by(account)",
      "    result.ordered",
      "  end",
      "end",
    ].join("\n");
    expect(attempt(src, "result.ordered", 6)).toEqual(
      pinnedOn("CollectionItem.ordered", "app/models/collection_item.rb"),
    );
    expect(attempt(src, "result.not_blocked_by(account)", 5)).toEqual(
      pinnedOn("CollectionItem.not_blocked_by", "app/models/collection_item.rb"),
    );
  });

  it("a non-relation call-result local keeps its nominal reading", () => {
    const src = ["class Holder", "  def items", "    report = build_report", "    report.run", "  end", "end"].join(
      "\n",
    );
    expect(attempt(src, "report.run", 4)).toEqual(pinnedOn("ReportBuilder#run", "app/services/report_builder.rb"));
  });

  it("a container over a class that is NOT an AR model is not threaded as a relation", () => {
    const src = [
      "class Holder",
      "  def items",
      "    listed = plain_listings",
      "    listed.ordered",
      "  end",
      "end",
    ].join("\n");
    expect(attempt(src, "listed.ordered", 4)?.targetSymbolId).not.toBe("Listing.ordered");
  });
});
