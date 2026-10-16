/**
 * An `attr_reader` / `attr_accessor` answers exactly what its `@ivar` holds
 * (bd tea-rags-mcp-2m83f.36). The walker types `@model = model` from the
 * initializer's YARD `@param`, but a bare `model.x` — the reader, possibly
 * inherited — stayed untyped. The reader now carries the ivar's type as a
 * declared return fact, so a gem type classifies the call external and a
 * project type pins its member.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { collectRubyIvarReaderReturnTypes } from "../../../../../../src/core/domains/language/ruby/walker/local-bindings.js";
import {
  extractFromRubyFile,
  type RubyExtractInput,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

function extract(src: string, relPath: string, chunks: RubyExtractInput["chunks"]): FileExtraction {
  return extractFromRubyFile({ tree: parse(src), code: src, relPath, language: "ruby", chunks });
}

function sym(symbolId: string, fqName: string, relPath: string, scope: string[] = []) {
  return { symbolId, fqName, shortName: fqName.split(/[.#:]/).pop() ?? fqName, relPath, scope };
}

const BASE_ADAPTER = [
  "class Bookkeeping::QBO::Models::BaseAdapter",
  "  attr_reader :model",
  "",
  "  # Wraps QBO model's object",
  "  # @param [Quickbooks::Model] model",
  "  def initialize(model)",
  "    @model = model",
  "  end",
  "end",
].join("\n");

const ITEM_ADAPTER = [
  "class Bookkeeping::QBO::Models::ItemAdapter < Bookkeeping::QBO::Models::BaseAdapter",
  "  def attributes",
  "    { description: model.description }",
  "  end",
  "end",
].join("\n");

const BASE = "Bookkeeping::QBO::Models::BaseAdapter";
const ITEM = "Bookkeeping::QBO::Models::ItemAdapter";

/** Run-global view of both files, as pass-2 sees it. */
function siteContext(base: FileExtraction, item: FileExtraction, table: InMemoryGlobalSymbolTable) {
  const chunk = item.chunks[0];
  const ctx: CallContext = {
    callerFile: item.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: item.imports,
    symbolTable: table,
    localBindings: chunk.localBindings,
    callResultBindings: chunk.callResultBindings,
    classAncestors: { ...base.classAncestors, ...item.classAncestors },
    classExtends: { ...base.classExtends, ...item.classExtends },
    structuredReturnTypes: { ...base.structuredReturnTypes, ...item.structuredReturnTypes },
    classFieldTypes: { ...base.classFieldTypes, ...item.classFieldTypes },
  };
  return { chunk, ctx };
}

function projectTable(extra: ReturnType<typeof sym>[] = []): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/lib/bookkeeping/qbo/models/base_adapter.rb", [
    sym(BASE, BASE, "app/lib/bookkeeping/qbo/models/base_adapter.rb"),
    sym(`${BASE}#initialize`, `${BASE}#initialize`, "app/lib/bookkeeping/qbo/models/base_adapter.rb", [BASE]),
  ]);
  table.upsertFile("app/lib/bookkeeping/qbo/models/item_adapter.rb", [
    sym(ITEM, ITEM, "app/lib/bookkeeping/qbo/models/item_adapter.rb"),
    sym(`${ITEM}#attributes`, `${ITEM}#attributes`, "app/lib/bookkeeping/qbo/models/item_adapter.rb", [ITEM]),
  ]);
  table.upsertFile("app/models/ledger.rb", extra);
  return table;
}

describe("collectRubyIvarReaderReturnTypes", () => {
  const readers = (src: string, fields: Record<string, Record<string, string>>) =>
    collectRubyIvarReaderReturnTypes(parse(src).rootNode, fields);

  it("types attr_reader and attr_accessor operands from the class's own ivar types", () => {
    const src = "class Svc\n  attr_reader :model, :client\n  attr_accessor :ledger\nend";
    expect(readers(src, { Svc: { "@model": "Quickbooks::Model", "@ledger": "Ledger" } })).toEqual({
      "Svc#model": { form: "instance", name: "Quickbooks::Model" },
      "Svc#ledger": { form: "instance", name: "Ledger" },
    });
  });

  it("reads a reader wrapped in a visibility modifier", () => {
    const src = "class Svc\n  private attr_reader :model\nend";
    expect(readers(src, { Svc: { "@model": "Ledger" } })).toEqual({
      "Svc#model": { form: "instance", name: "Ledger" },
    });
  });

  it("types no writer and no class-level reader", () => {
    const src = "class Svc\n  attr_writer :model\n  cattr_reader :ledger\nend";
    expect(readers(src, { Svc: { "@model": "Ledger", "@ledger": "Ledger" } })).toEqual({});
  });

  it("does not lend a nested class's reader the outer class's ivar types", () => {
    const src = "class Outer\n  class Inner\n    attr_reader :model\n  end\nend";
    expect(readers(src, { Outer: { "@model": "Ledger" } })).toEqual({});
  });
});

describe("inherited attr_reader typed from the initializer's YARD @param (2m83f.36)", () => {
  const base = extract(BASE_ADAPTER, "app/lib/bookkeeping/qbo/models/base_adapter.rb", [
    { symbolId: `${BASE}#initialize`, scope: [BASE], startLine: 6, endLine: 8 },
  ]);

  it("classifies model.description in a subclass as external (gem type)", () => {
    const item = extract(ITEM_ADAPTER, "app/lib/bookkeeping/qbo/models/item_adapter.rb", [
      { symbolId: `${ITEM}#attributes`, scope: [ITEM], startLine: 2, endLine: 4 },
    ]);
    expect(base.structuredReturnTypes?.[`${BASE}#model`]).toEqual({ form: "instance", name: "Quickbooks::Model" });

    const { chunk, ctx } = siteContext(base, item, projectTable());
    const call = chunk.calls.find((c) => c.receiver === "model" && c.member === "description");
    expect(call).toBeDefined();

    const resolver = new RubyCallResolver();
    expect(resolver.resolve(call!, ctx)).toBeNull();
    expect(resolver.targetsExternalImport(call!, ctx)).toBe(true);
  });

  it("pins the member when the YARD @param names a project class", () => {
    const projectBase = extract(
      BASE_ADAPTER.replace("[Quickbooks::Model]", "[Ledger]"),
      "app/lib/bookkeeping/qbo/models/base_adapter.rb",
      [{ symbolId: `${BASE}#initialize`, scope: [BASE], startLine: 6, endLine: 8 }],
    );
    const item = extract(ITEM_ADAPTER, "app/lib/bookkeeping/qbo/models/item_adapter.rb", [
      { symbolId: `${ITEM}#attributes`, scope: [ITEM], startLine: 2, endLine: 4 },
    ]);
    const table = projectTable([
      sym("Ledger", "Ledger", "app/models/ledger.rb"),
      sym("Ledger#description", "Ledger#description", "app/models/ledger.rb", ["Ledger"]),
    ]);
    const { chunk, ctx } = siteContext(projectBase, item, table);
    const call = chunk.calls.find((c) => c.receiver === "model" && c.member === "description");

    const resolver = new RubyCallResolver();
    expect(resolver.resolve(call!, ctx)).toEqual({
      targetRelPath: "app/models/ledger.rb",
      targetSymbolId: "Ledger#description",
    });
    expect(resolver.targetsExternalImport(call!, ctx)).toBe(false);
  });

  it("lets a def of the reader's name keep its own return fact", () => {
    const src = BASE_ADAPTER.replace(
      "  attr_reader :model\n",
      "  attr_reader :model\n  def model\n    Ledger.new\n  end\n",
    );
    const own = extract(src, "app/lib/bookkeeping/qbo/models/base_adapter.rb", []);
    expect(own.structuredReturnTypes?.[`${BASE}#model`]).toEqual({ form: "instance", name: "Ledger" });
  });
});
