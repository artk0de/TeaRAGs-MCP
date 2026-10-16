/**
 * ActiveRecord relation chains resolve the next scope on the MODEL (bd
 * tea-rags-mcp-2m83f.32.3). A relation forwards every member it does not define
 * to its model's class, so in
 *
 *     ::Firm.without_deleted.available_for(actor)
 *     ::Communication::Chat::Channel::Message.select(1).without_deleted.unread_by_fm
 *     document.resolved_doc_dir.documents.ordered
 *
 * the last member is a scope on `Firm`, on the chat `Message`, on
 * `TaxPreparation::Document` — never on a namesake elsewhere (`.ordered` used to
 * be read as `TaxPreparation::DocDir.ordered`). A scope declared in a concern's
 * `included do` (`SoftDeletable.without_deleted`) is stated over the concern;
 * on a chain it ranges over the receiver's model.
 *
 * Gates: the Rails vocabulary must be active, the model (or a concern of it) must
 * declare the member, and an untyped hop (polymorphic / non-literal association)
 * stays silent.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ChunkExtraction,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { typeOfReceiver } from "../../../../../../src/core/domains/language/ruby/resolver/strategies/type-propagation.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

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

const FIRM = "app/models/firm.rb";
const PARTNER = "app/models/partner.rb";
const SOFT = "lib/concerns/soft_deletable.rb";
const CHAT_MESSAGE = "app/models/communication/chat/channel/message.rb";
const SMS_MESSAGE = "app/models/communication/sms_thread/message.rb";
const DOCUMENT = "app/models/tax_preparation/document.rb";
const DOC_DIR = "app/models/tax_preparation/doc_dir.rb";

const CHAT = "Communication::Chat::Channel::Message";
const SMS = "Communication::SmsThread::Message";

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(SOFT, [sym("SoftDeletable", SOFT, [], "module")]);
  t.upsertFile(FIRM, [sym("Firm", FIRM, [], "class"), sym("Firm.available_for", FIRM, ["Firm"])]);
  t.upsertFile(PARTNER, [
    sym("Partner", PARTNER, [], "class"),
    sym("Partner.available_for", PARTNER, ["Partner"]),
    sym("Partner.partner_only", PARTNER, ["Partner"]),
  ]);
  t.upsertFile(CHAT_MESSAGE, [sym(CHAT, CHAT_MESSAGE, [], "class"), sym(`${CHAT}.unread_by_fm`, CHAT_MESSAGE, [CHAT])]);
  t.upsertFile(SMS_MESSAGE, [sym(SMS, SMS_MESSAGE, [], "class"), sym(`${SMS}.unread_by_fm`, SMS_MESSAGE, [SMS])]);
  t.upsertFile(DOCUMENT, [
    sym("TaxPreparation::Document", DOCUMENT, [], "class"),
    sym("TaxPreparation::Document#resolved_doc_dir", DOCUMENT, ["TaxPreparation::Document"]),
    sym("TaxPreparation::Document.ordered", DOCUMENT, ["TaxPreparation::Document"]),
  ]);
  t.upsertFile(DOC_DIR, [
    sym("TaxPreparation::DocDir", DOC_DIR, [], "class"),
    sym("TaxPreparation::DocDir.ordered", DOC_DIR, ["TaxPreparation::DocDir"]),
  ]);
  return t;
})();

const relationOf = (name: string): RubyTypeRef => ({ form: "container", element: { form: "instance", name } });

/** What the walker states: a concern's `included do` scope ranges over the CONCERN. */
const STRUCTURED_RETURNS: Record<string, RubyTypeRef> = {
  "SoftDeletable#without_deleted": relationOf("SoftDeletable"),
  "Firm#available_for": relationOf("Firm"),
  "Partner#available_for": relationOf("Partner"),
  "Partner#partner_only": relationOf("Partner"),
  [`${CHAT}#unread_by_fm`]: relationOf(CHAT),
  [`${SMS}#unread_by_fm`]: relationOf(SMS),
  "TaxPreparation::Document#resolved_doc_dir": { form: "instance", name: "TaxPreparation::DocDir" },
  "TaxPreparation::Document#ordered": relationOf("TaxPreparation::Document"),
  "TaxPreparation::DocDir#documents": relationOf("TaxPreparation::Document"),
  "TaxPreparation::DocDir#ordered": relationOf("TaxPreparation::DocDir"),
};

const CLASS_ANCESTORS = {
  Firm: ["ApplicationRecord", "SoftDeletable"],
  Partner: ["ApplicationRecord"],
  [CHAT]: ["ApplicationRecord", "SoftDeletable"],
  [SMS]: ["ApplicationRecord", "SoftDeletable"],
  "TaxPreparation::Document": ["ApplicationRecord"],
  "TaxPreparation::DocDir": ["ApplicationRecord"],
  ApplicationRecord: ["ActiveRecord::Base"],
};

const RAILS = new Set(["rails"]);

function chunkOf(src: string): ChunkExtraction {
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath: "app/services/holder.rb",
    language: "ruby",
    chunks: [{ symbolId: "Holder#run", startLine: 2, endLine: src.split("\n").length - 1, scope: ["Holder"] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  return chunk;
}

function contextFor(chunk: ChunkExtraction, declaredDependencies: ReadonlySet<string> = RAILS): CallContext {
  return {
    callerFile: "app/services/holder.rb",
    callerScope: ["Holder"],
    callerSymbolId: "Holder#run",
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    structuredReturnTypes: STRUCTURED_RETURNS,
    classAncestors: CLASS_ANCESTORS,
    declaredDependencies,
  };
}

function siteOf(chunk: ChunkExtraction, member: string, line: number): CallRef {
  const site = chunk.calls.find((c) => c.member === member && c.startLine === line);
  if (site === undefined) throw new Error(`walker emitted no call to ${member} on line ${line}`);
  return site;
}

const resolver = new RubyCallResolver();

function attempt(body: string[], member: string, declaredDependencies?: ReadonlySet<string>) {
  const src = ["class Holder", "  def run(actor, id)", ...body.map((l) => `    ${l}`), "  end", "end"].join("\n");
  const chunk = chunkOf(src);
  const line = 2 + body.length;
  const target = resolver.resolve(siteOf(chunk, member, line), contextFor(chunk, declaredDependencies));
  return target === null ? null : { targetSymbolId: target.targetSymbolId, targetRelPath: target.targetRelPath };
}

const pinnedOn = (targetSymbolId: string, targetRelPath: string) => ({ targetSymbolId, targetRelPath });

describe("an AR relation chain resolves the next scope on the model (2m83f.32.3)", () => {
  it("a concern scope on a model keeps the relation over THAT model", () => {
    const chunk = chunkOf(
      ["class Holder", "  def run", "    ::Firm.without_deleted.available_for(1)", "  end", "end"].join("\n"),
    );
    expect(typeOfReceiver("::Firm.without_deleted", 3, contextFor(chunk))).toEqual(relationOf("Firm"));
  });

  it("Firm.without_deleted.available_for → the scope on Firm", () => {
    expect(attempt(["::Firm.without_deleted.available_for(actor)"], "available_for")).toEqual(
      pinnedOn("Firm.available_for", FIRM),
    );
  });

  it("Message.select(1).without_deleted.unread_by_fm → the scope on that Message, not its namesake", () => {
    expect(attempt([`::${CHAT}.select(1).without_deleted.unread_by_fm`], "unread_by_fm")).toEqual(
      pinnedOn(`${CHAT}.unread_by_fm`, CHAT_MESSAGE),
    );
  });

  it("document.resolved_doc_dir.documents.ordered → the scope on Document, not DocDir", () => {
    expect(
      attempt(
        ["document = TaxPreparation::Document.find(id)", "document.resolved_doc_dir.documents.ordered"],
        "ordered",
      ),
    ).toEqual(pinnedOn("TaxPreparation::Document.ordered", DOCUMENT));
  });

  it("silent when the Rails vocabulary is not active", () => {
    expect(attempt(["::Firm.without_deleted.available_for(actor)"], "available_for", new Set(["sinatra"]))).toBeNull();
  });

  it("silent when neither the model nor a concern of it declares the member — never the namesake", () => {
    expect(attempt(["::Firm.without_deleted.partner_only"], "partner_only")).toBeNull();
  });

  it("silent past an association the walker could not type (polymorphic / non-literal class_name)", () => {
    expect(
      attempt(
        ["document = TaxPreparation::Document.find(id)", "document.resolved_doc_dir.attachable.ordered"],
        "ordered",
      ),
    ).toBeNull();
  });
});
