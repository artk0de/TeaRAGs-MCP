/**
 * `document.resolved_doc_dir.documents.ordered` in
 * `TaxPreparation::Documents::Show#meta_legacy(document)` resolves to the scope on
 * `TaxPreparation::Document` end to end (bd tea-rags-mcp-2m83f.32.5):
 *
 *  - `document` is an untyped parameter; the naming convention reaches
 *    `TaxPreparation::Document` from the caller's namespace, past a namesake
 *    elsewhere. That guess roots the chain for the relation-chain strategy ONLY,
 *    which demands a pinned member on the model — `typeOfReceiver` stays silent.
 *  - `resolved_doc_dir` is an if/else over two `belongs_to` readers of `DocDir`.
 *  - `documents` is `has_many … class_name: 'TaxPreparation::Document'`, and
 *    `ordered` a scope on that model.
 *
 * The model facts come from running the walker over the model sources.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { HierarchyView } from "../../../../../../src/core/contracts/types/codegraph-hierarchy.js";
import type {
  CallContext,
  ChunkExtraction,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import {
  typeOfConventionRootedReceiver,
  typeOfReceiver,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/type-propagation.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const DOCUMENT = "app/models/tax_preparation/document.rb";
const DOC_DIR = "app/models/tax_preparation/doc_dir.rb";
const WORKFLOW_DOCUMENT = "app/models/workflow/document.rb";
const SHOW = "app/services/tax_preparation/documents/show.rb";

const DOCUMENT_SRC = [
  "class TaxPreparation::Document < ApplicationRecord",
  "  belongs_to :doc_dir, optional: false, class_name: 'TaxPreparation::DocDir'",
  "  belongs_to :doc_dir_with_granular_access_attr, -> { with_sealed }, optional: true, class_name: 'TaxPreparation::DocDir', foreign_key: :doc_dir_id",
  "  scope :ordered, -> { order(name: :asc) }",
  "  def resolved_doc_dir",
  "    if association(:doc_dir_with_granular_access_attr).loaded?",
  "      doc_dir_with_granular_access_attr",
  "    else",
  "      doc_dir",
  "    end",
  "  end",
  "end",
].join("\n");

const DOC_DIR_SRC = [
  "class TaxPreparation::DocDir < ApplicationRecord",
  "  has_many :documents, -> { persistent }, class_name: 'TaxPreparation::Document', dependent: :destroy",
  "  scope :ordered, -> { order(:name) }",
  "end",
].join("\n");

/** The walker's structured return facts for one model file. */
function modelReturns(src: string, relPath: string): Record<string, RubyTypeRef> {
  const extraction = extractFromRubyFile({ tree: parse(src), code: src, relPath, language: "ruby", chunks: [] });
  return extraction.structuredReturnTypes ?? {};
}

const STRUCTURED_RETURNS: Record<string, RubyTypeRef> = {
  ...modelReturns(DOCUMENT_SRC, DOCUMENT),
  ...modelReturns(DOC_DIR_SRC, DOC_DIR),
};

const sym = (
  symbolId: string,
  relPath: string,
  scope: string[],
  symbolKind?: SymbolDefinitionKind,
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/::|\.|#/).at(-1) ?? symbolId,
  relPath,
  scope,
  ...(symbolKind === undefined ? {} : { symbolKind }),
});

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(DOCUMENT, [
    sym("TaxPreparation::Document", DOCUMENT, [], "class"),
    sym("TaxPreparation::Document#resolved_doc_dir", DOCUMENT, ["TaxPreparation::Document"]),
    sym("TaxPreparation::Document.ordered", DOCUMENT, ["TaxPreparation::Document"]),
  ]);
  t.upsertFile(DOC_DIR, [
    sym("TaxPreparation::DocDir", DOC_DIR, [], "class"),
    sym("TaxPreparation::DocDir.ordered", DOC_DIR, ["TaxPreparation::DocDir"]),
  ]);
  t.upsertFile(WORKFLOW_DOCUMENT, [
    sym("Workflow::Document", WORKFLOW_DOCUMENT, [], "class"),
    sym("Workflow::Document#resolved_doc_dir", WORKFLOW_DOCUMENT, ["Workflow::Document"]),
  ]);
  return t;
})();

const CLASS_ANCESTORS = {
  "TaxPreparation::Document": ["ApplicationRecord"],
  "TaxPreparation::DocDir": ["ApplicationRecord"],
  ApplicationRecord: ["ActiveRecord::Base"],
};

const hierarchy: HierarchyView = { getAncestors: () => [], getDescendants: () => [] };

const resolver = new RubyCallResolver();

function showChunk(line: string): ChunkExtraction {
  const src = [
    "class TaxPreparation::Documents::Show",
    "  def meta_legacy(document)",
    `    ${line}`,
    "  end",
    "end",
  ].join("\n");
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath: SHOW,
    language: "ruby",
    chunks: [
      {
        symbolId: "TaxPreparation::Documents::Show#meta_legacy",
        startLine: 2,
        endLine: 4,
        scope: ["TaxPreparation::Documents::Show"],
      },
    ],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  return chunk;
}

function contextFor(chunk: ChunkExtraction): CallContext {
  return {
    callerFile: SHOW,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    structuredReturnTypes: STRUCTURED_RETURNS,
    classAncestors: CLASS_ANCESTORS,
    declaredDependencies: new Set(["rails"]),
    hierarchy,
  };
}

function attempt(line: string, member: string) {
  const chunk = showChunk(line);
  const site = chunk.calls.find((c) => c.member === member);
  if (site === undefined) throw new Error(`walker emitted no call to ${member}`);
  const target = resolver.resolve(site, contextFor(chunk));
  return target === null ? null : { targetSymbolId: target.targetSymbolId, targetRelPath: target.targetRelPath };
}

describe("a convention-rooted relation chain resolves the scope on the model (2m83f.32.5)", () => {
  it("the walker types resolved_doc_dir from its if/else association arms", () => {
    expect(STRUCTURED_RETURNS["TaxPreparation::Document#resolved_doc_dir"]).toEqual({
      form: "instance",
      name: "TaxPreparation::DocDir",
    });
  });

  it("document.resolved_doc_dir.documents.ordered → TaxPreparation::Document.ordered", () => {
    expect(attempt("document.resolved_doc_dir.documents.ordered", "ordered")).toEqual({
      targetSymbolId: "TaxPreparation::Document.ordered",
      targetRelPath: DOCUMENT,
    });
  });

  it("silent when the convention model does not declare the member — never a file-only edge", () => {
    expect(attempt("document.resolved_doc_dir.documents.archived", "archived")).toBeNull();
  });

  it("the convention root stays out of typeOfReceiver, which chainType and the dispatch deferral read", () => {
    const chunk = showChunk("document.resolved_doc_dir.documents.ordered");
    expect(typeOfReceiver("document.resolved_doc_dir.documents", 3, contextFor(chunk))).toBeUndefined();
  });

  it("the convention-rooted typing threads the chain to a relation over Document", () => {
    const chunk = showChunk("document.resolved_doc_dir.documents.ordered");
    expect(typeOfConventionRootedReceiver("document.resolved_doc_dir.documents", 3, contextFor(chunk))).toEqual({
      form: "container",
      element: { form: "instance", name: "TaxPreparation::Document" },
    });
  });

  it("silent on a scope called on the convention instance itself — an instance is not a relation", () => {
    expect(attempt("document.ordered", "ordered")).toBeNull();
  });
});
