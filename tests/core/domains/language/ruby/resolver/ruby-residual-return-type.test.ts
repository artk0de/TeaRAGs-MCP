/**
 * The return type a residual class target carries (bd tea-rags-mcp-2m83f.51):
 * an accepted class for `record` types `record.firm` through the same return
 * channel static resolution reads, so `record.firm.name` can be edged.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { CallContext, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const CLIENT = "app/models/client.rb";
const FIRM = "app/models/firm.rb";
const CLIENT_SRC = [
  "class Client < ApplicationRecord",
  "  belongs_to :firm",
  "  def label",
  "    name.upcase",
  "  end",
  "  def self.lookup",
  "    first",
  "  end",
  "end",
].join("\n");

const cls = (symbolId: string, relPath: string): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId,
  relPath,
  scope: [],
  symbolKind: "class",
});

function context(): CallContext {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const extraction = extractFromRubyFile({
    tree: parser.parse(CLIENT_SRC),
    code: CLIENT_SRC,
    relPath: CLIENT,
    language: "ruby",
    chunks: [],
  });
  const symbolTable = new InMemoryGlobalSymbolTable();
  symbolTable.upsertFile(CLIENT, [cls("Client", CLIENT)]);
  symbolTable.upsertFile(FIRM, [cls("Firm", FIRM)]);
  return {
    callerFile: "app/services/sync.rb",
    callerScope: [],
    callerSymbolId: "Sync#run",
    imports: [],
    symbolTable,
    structuredReturnTypes: extraction.structuredReturnTypes ?? {},
    classAncestors: { Client: ["ApplicationRecord"], ApplicationRecord: ["ActiveRecord::Base"] },
  };
}

describe("RubyCallResolver#residualReturnType", () => {
  const resolver = new RubyCallResolver();

  it("names the class a `belongs_to` reader returns on its owner", () => {
    expect(resolver.residualReturnType("Client", "firm", context())).toBe("Firm");
  });

  it("answers nothing for a member whose return no fact carries", () => {
    expect(resolver.residualReturnType("Client", "label", context())).toBeUndefined();
  });
});
