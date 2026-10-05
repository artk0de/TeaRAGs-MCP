/**
 * A modifier's condition runs BEFORE the assignment it guards
 * (bd tea-rags-mcp-0qaht.55).
 *
 *     record = model_name.constantize.find_by(id: record_id)
 *     record = record.status if record.respond_to?(:status)
 *
 * `record.respond_to?` reads the `find_by` result, never what the line
 * assigns. The walker records the condition's span on the binding the
 * statement establishes and the column of a call inside it; a call positioned
 * inside the span does not see that binding — it reads exactly what it would
 * read if the statement were absent. Every other call, the right-hand side on
 * the same line included, reads as before, and a call without a column (or a
 * binding without a span) reads as before too.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
  type ChunkExtraction,
  type LocalBinding,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyLocalTypeSymbolResolutionStrategy,
  RubyReturnTypeBindingSymbolResolutionStrategy,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { typeOfReceiver } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
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
  t.upsertFile("app/models/status.rb", [
    sym("Status", "Status", "app/models/status.rb", []),
    sym("Status#visible?", "visible?", "app/models/status.rb", ["Status"]),
    sym("Status#present?", "present?", "app/models/status.rb", ["Status"]),
  ]);
  t.upsertFile("app/models/account.rb", [
    sym("Account", "Account", "app/models/account.rb", []),
    sym("Account#present?", "present?", "app/models/account.rb", ["Account"]),
  ]);
  t.upsertFile("app/models/collection_item.rb", [
    sym("CollectionItem", "CollectionItem", "app/models/collection_item.rb", []),
    sym("CollectionItem#empty_for?", "empty_for?", "app/models/collection_item.rb", ["CollectionItem"]),
    sym("CollectionItem#accepted_items", "accepted_items", "app/models/collection_item.rb", ["CollectionItem"]),
  ]);
  return t;
})();

/** The chunk extraction the walker produces for `Lookup#lookup` in `src`. */
function chunkOf(src: string, startLine: number, endLine: number): ChunkExtraction {
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath: "lib/lookup.rb",
    language: "ruby",
    chunks: [{ symbolId: "Lookup#lookup", startLine, endLine, scope: ["Lookup"] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  return chunk;
}

function contextFor(chunk: ChunkExtraction, functionReturnTypes: Record<string, string>): CallContext {
  return {
    callerFile: "lib/lookup.rb",
    callerScope: ["Lookup"],
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    functionReturnTypes,
  };
}

/** The walker's own CallRef for `callText` on `line`. */
function siteOf(chunk: ChunkExtraction, callText: string, line: number): CallRef {
  const site = chunk.calls.find((c) => c.callText === callText && c.startLine === line);
  if (site === undefined) throw new Error(`walker emitted no call ${callText} on line ${line}`);
  return site;
}

const withoutColumn = (site: CallRef): CallRef => {
  const { startColumn: _dropped, ...rest } = site;
  return rest;
};

const returnBinding = new RubyReturnTypeBindingSymbolResolutionStrategy({ mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE });
const localType = new RubyLocalTypeSymbolResolutionStrategy({ mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE });

describe("Ruby walker — modifier condition positions (0qaht.55)", () => {
  const SRC = [
    "class Lookup",
    "  def lookup(id)",
    "    record = Account.find(id)",
    "    record = Status.new unless record.present?",
    "    record.visible?",
    "  end",
    "end",
  ].join("\n");
  const chunk = chunkOf(SRC, 2, 6);

  it("a call inside a modifier condition carries its column", () => {
    expect(siteOf(chunk, "record.present?", 4).startColumn).toBe(31);
  });

  it("a call outside every modifier condition carries none", () => {
    expect(siteOf(chunk, "record.visible?", 5).startColumn).toBeUndefined();
  });

  it("the binding the modifier guards carries the condition's span", () => {
    const bindings = chunk.localBindings?.record ?? [];
    const guarded = bindings.find((b) => b.line === 4);
    expect(guarded?.conditionSpan).toEqual({ startLine: 4, startColumn: 31, endLine: 4, endColumn: 46 });
    expect(bindings.find((b) => b.line === 3)?.conditionSpan).toBeUndefined();
  });

  it("the call-result binding a modifier guards carries the condition's span", () => {
    const src = SRC.replace("Status.new", "record.status");
    const guarded = (chunkOf(src, 2, 6).callResultBindings?.record ?? []).find((b) => b.line === 4);
    expect(guarded?.conditionSpan).toEqual({ startLine: 4, startColumn: 34, endLine: 4, endColumn: 49 });
  });

  it("a condition continued onto the next line spans both lines", () => {
    const src = [
      "class Lookup",
      "  def lookup(id)",
      "    record = Status.new if record.nil? ||",
      "                           record.blank?",
      "  end",
      "end",
    ].join("\n");
    const guarded = (chunkOf(src, 2, 5).localBindings?.record ?? []).find((b) => b.line === 3);
    expect(guarded?.conditionSpan).toEqual({ startLine: 3, startColumn: 27, endLine: 4, endColumn: 40 });
  });
});

describe("resolveLocalBinding — a call inside the condition span does not see the binding (0qaht.55)", () => {
  const span = { startLine: 4, startColumn: 31, endLine: 4, endColumn: 46 };
  const bindings: Record<string, LocalBinding[]> = {
    record: [
      { line: 3, type: "Account" },
      { line: 4, type: "Status", conditionSpan: span },
    ],
  };

  it("inside the span → the binding above", () => {
    expect(resolveLocalBinding(bindings, "record", 4, 31)?.type).toBe("Account");
    expect(resolveLocalBinding(bindings, "record", 4, 45)?.type).toBe("Account");
  });

  it("outside the span on the same line → the guarded binding, as before", () => {
    expect(resolveLocalBinding(bindings, "record", 4, 13)?.type).toBe("Status");
    expect(resolveLocalBinding(bindings, "record", 4, 46)?.type).toBe("Status");
  });

  it("no column → the guarded binding, as before", () => {
    expect(resolveLocalBinding(bindings, "record", 4)?.type).toBe("Status");
  });

  it("inside the span with nothing above → no binding", () => {
    const only = { record: [{ line: 4, type: "Status", conditionSpan: span }] };
    expect(resolveLocalBinding(only, "record", 4, 31)).toBeUndefined();
  });
});

describe("localBindings channel — `record = Status.new unless record.present?` (0qaht.55)", () => {
  const SRC = [
    "class Lookup",
    "  def lookup(id)",
    "    record = Account.find(id)",
    "    record = Status.new unless record.present?",
    "    record.visible?",
    "  end",
    "end",
  ].join("\n");
  const chunk = chunkOf(SRC, 2, 6);
  const ctx = contextFor(chunk, {});

  it("the condition's call reads the binding above the statement", () => {
    expect(localType.attempt(siteOf(chunk, "record.present?", 4), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/account.rb", targetSymbolId: "Account#present?" },
    });
    expect(typeOfReceiver("record", 4, ctx, siteOf(chunk, "record.present?", 4).startColumn)).toEqual({
      form: "instance",
      name: "Account",
    });
  });

  it("without a column the call reads the guarded binding, as before", () => {
    expect(localType.attempt(withoutColumn(siteOf(chunk, "record.present?", 4)), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#present?" },
    });
  });

  it("the line after the statement reads the guarded binding", () => {
    expect(localType.attempt(siteOf(chunk, "record.visible?", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#visible?" },
    });
  });
});

describe("localCallBindings channel — the condition reads the call binding above (0qaht.55)", () => {
  const MEDIA = [
    "class Lookup",
    "  def lookup(model_name, record_id)",
    "    record = model_name.constantize.find_by(id: record_id)",
    "    record = record.status unless record.visible?",
    "    record.visible?",
    "  end",
    "end",
  ].join("\n");
  const chunk = chunkOf(MEDIA, 2, 6);
  const ctx = contextFor(chunk, { status: "Status" });

  it("a condition call does not see the call binding its statement establishes", () => {
    expect(returnBinding.attempt(siteOf(chunk, "record.visible?", 4), ctx).kind).toBe("continue");
  });

  it("without a column the condition call reads the chunk-wide binding, as before", () => {
    expect(returnBinding.attempt(withoutColumn(siteOf(chunk, "record.visible?", 4)), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#visible?" },
    });
  });

  it("the right-hand side does not type its own receiver with the member Status lacks (0qaht.57)", () => {
    // `record.status` runs BEFORE `record` is rebound, so `record` there is the
    // `find_by` result. Reading the statement's own binding typed it as `status`'s
    // return — `Status`, which declares no `status`: a fabricated file-only edge.
    const rhs = siteOf(chunk, "record.status", 4);
    expect(rhs.startColumn).toBeUndefined();
    expect(returnBinding.attempt(rhs, ctx).kind).toBe("continue");
  });

  it("the line after the statement reads the guarded call binding", () => {
    expect(returnBinding.attempt(siteOf(chunk, "record.visible?", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#visible?" },
    });
  });

  it("the previous call binding answers inside the condition", () => {
    const src = [
      "class Lookup",
      "  def lookup(account)",
      "    result = collection_items",
      "    result = result.accepted_items if account",
      "    result = result.not_blocked_by(account) unless result.empty_for?(account)",
      "    result",
      "  end",
      "end",
    ].join("\n");
    const chainChunk = chunkOf(src, 2, 7);
    const chainCtx = contextFor(chainChunk, { accepted_items: "CollectionItem", not_blocked_by: "Unrelated" });
    expect(returnBinding.attempt(siteOf(chainChunk, "result.empty_for?(account)", 5), chainCtx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/collection_item.rb", targetSymbolId: "CollectionItem#empty_for?" },
    });
  });
});

describe("localCallBindings channel — the right-hand side of a self-referential reassignment (0qaht.57)", () => {
  // The right-hand side of `x = x.m(…)` runs before the assignment, so reading
  // the statement's own binding types `x` as `m`'s return. That holds only when
  // the type it yields declares `m` (a type-preserving scope chain); a type that
  // does not declare `m` is a circular guess, and the pass declines it — but
  // only where an earlier positioned write shows `x` held something else.
  const ctxWith = (src: string, startLine: number, endLine: number, returns: Record<string, string>) => {
    const chunk = chunkOf(src, startLine, endLine);
    return { chunk, ctx: contextFor(chunk, returns) };
  };

  it("a plain reassignment declines the member its own binding's type lacks", () => {
    const src = [
      "class Lookup",
      "  def lookup(model_name, record_id)",
      "    record = model_name.constantize.find_by(id: record_id)",
      "    record = record.status",
      "    record.visible?",
      "  end",
      "end",
    ].join("\n");
    const { chunk, ctx } = ctxWith(src, 2, 6, { status: "Status" });
    expect(returnBinding.attempt(siteOf(chunk, "record.status", 4), ctx).kind).toBe("continue");
    expect(returnBinding.attempt(siteOf(chunk, "record.visible?", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#visible?" },
    });
  });

  it("a type-preserving chain keeps its exact edge", () => {
    const src = [
      "class Lookup",
      "  def lookup(account)",
      "    result = collection_items",
      "    result = result.with_accounts",
      "    result = result.accepted_items(account) if account",
      "    result",
      "  end",
      "end",
    ].join("\n");
    const { chunk, ctx } = ctxWith(src, 2, 7, { accepted_items: "CollectionItem" });
    expect(returnBinding.attempt(siteOf(chunk, "result.accepted_items(account)", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/collection_item.rb", targetSymbolId: "CollectionItem#accepted_items" },
    });
  });

  it("with no earlier positioned write the statement's own binding answers, as before", () => {
    const src = [
      "class Lookup",
      "  def lookup(record)",
      "    record = record.status",
      "    record",
      "  end",
      "end",
    ].join("\n");
    const { chunk, ctx } = ctxWith(src, 2, 5, { status: "Status" });
    expect(returnBinding.attempt(siteOf(chunk, "record.status", 3), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: null },
    });
  });

  it("a later call on the same name, outside the right-hand side, reads as before", () => {
    const src = [
      "class Lookup",
      "  def lookup(model_name)",
      "    record = model_name.constantize.find_by(id: 1)",
      "    record = record.status; record.archived",
      "  end",
      "end",
    ].join("\n");
    const { chunk, ctx } = ctxWith(src, 2, 5, { status: "Status" });
    expect(returnBinding.attempt(siteOf(chunk, "record.archived", 4), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: null },
    });
  });
});
