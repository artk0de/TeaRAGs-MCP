/**
 * Naming-convention receiver typing picks the namesake the caller's LEXICAL
 * scope reaches (bd tea-rags-mcp-2m83f.32.1). `time_entry` inside
 * `GettingPaid::TimeEntriesCsvExporter` is a `GettingPaid::TimeEntry` even
 * though `Workflow::Pipeline::StageClient::TimeEntry` exists too: the caller's
 * namespaces are walked innermost first, then the top level, and the first one
 * declaring the CLASS wins. A namespace module of the same name is not a class
 * an instance can carry, and namesakes no scope reaches stay silent. The
 * subtype gate is asked about the reached class only.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { HierarchyView, InheritanceEdge } from "../../../../../../src/core/contracts/types/codegraph-hierarchy.js";
import type {
  CallContext,
  ChunkExtraction,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const pathOf = (fq: string) =>
  `app/models/${fq
    .split("::")
    .map((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/")}.rb`;

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

/** A class declaring the given instance methods, in its Zeitwerk file. */
function declareClass(table: InMemoryGlobalSymbolTable, fq: string, members: string[]): void {
  const relPath = pathOf(fq);
  table.upsertFile(relPath, [sym(fq, relPath, [], "class"), ...members.map((m) => sym(`${fq}#${m}`, relPath, [fq]))]);
}

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  declareClass(t, "GettingPaid::TimeEntry", ["assignee"]);
  declareClass(t, "Workflow::Pipeline::StageClient::TimeEntry", ["assignee"]);
  declareClass(t, "Item", ["label"]);
  declareClass(t, "X::Y::Item", ["label"]);
  declareClass(t, "A::Item", ["label"]);
  declareClass(t, "P::Widget", ["spin"]);
  declareClass(t, "Q::Widget", ["spin"]);
  declareClass(t, "GettingPaid::Payment", ["refund"]);
  declareClass(t, "Billing::Payment", ["refund"]);
  declareClass(t, "GettingPaid::RecurringInvoice", ["assignee"]);
  const ns = "app/services/getting_paid/templates/recurring_invoice.rb";
  t.upsertFile(ns, [sym("GettingPaid::Templates::RecurringInvoice", ns, [], "module")]);
  return t;
})();

/** `Workflow::…::TimeEntry` and `GettingPaid::Payment` are specialised; nothing else is. */
const DESCENDANTS: Record<string, string[]> = {
  "Workflow::Pipeline::StageClient::TimeEntry": ["Workflow::Pipeline::StageClient::BillableTimeEntry"],
  "GettingPaid::Payment": ["GettingPaid::CardPayment"],
};

const hierarchy: HierarchyView = {
  getAncestors: () => [],
  getDescendants: (fq) =>
    (DESCENDANTS[fq] ?? []).map((source) => ({ source, target: fq }) as unknown as InheritanceEdge),
};

const resolver = new RubyCallResolver();

/** Resolve `<receiver>.<member>` written in `def run(<receiver>)` of the compact `class <callerFq>`. */
function attempt(callerFq: string, receiver: string, member: string) {
  const src = [`class ${callerFq}`, `  def run(${receiver})`, `    ${receiver}.${member}`, "  end", "end"].join("\n");
  const relPath = "app/services/caller.rb";
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath,
    language: "ruby",
    chunks: [{ symbolId: `${callerFq}#run`, startLine: 2, endLine: 4, scope: [callerFq] }],
  });
  const chunk: ChunkExtraction | undefined = extraction.chunks[0];
  const site = chunk?.calls.find((c) => c.member === member);
  if (chunk === undefined || site === undefined) throw new Error(`walker emitted no call to ${member}`);
  const ctx: CallContext = {
    callerFile: relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    hierarchy,
  };
  return resolver.resolve(site, ctx)?.targetSymbolId ?? null;
}

describe("convention typing reaches the namesake nearest the caller's scope (2m83f.32.1)", () => {
  it("the caller's own namespace wins over a namesake elsewhere, whose subtypes do not count", () => {
    expect(attempt("GettingPaid::TimeEntriesCsvExporter", "time_entry", "assignee")).toBe(
      "GettingPaid::TimeEntry#assignee",
    );
  });

  it("the innermost declaring scope wins over the top level", () => {
    expect(attempt("X::Y::Svc", "item", "label")).toBe("X::Y::Item#label");
  });

  it("falls back to an outer namespace", () => {
    expect(attempt("A::B::C::Svc", "item", "label")).toBe("A::Item#label");
  });

  it("falls back to the top level", () => {
    expect(attempt("Z::Svc", "item", "label")).toBe("Item#label");
  });

  it("skips a namespace MODULE of the same name — an instance is never a module", () => {
    expect(attempt("GettingPaid::Templates::RecurringInvoice::Create", "recurring_invoice", "assignee")).toBe(
      "GettingPaid::RecurringInvoice#assignee",
    );
  });

  it("stays silent on namesakes no scope reaches", () => {
    expect(attempt("R::Svc", "widget", "spin")).toBeNull();
  });

  it("stays silent when the reached class has subtypes", () => {
    expect(attempt("GettingPaid::Svc", "payment", "refund")).toBeNull();
  });
});
