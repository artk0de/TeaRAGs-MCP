/**
 * Association → model inflection (bd tea-rags-mcp-0qaht.53).
 *
 * Rails derives an association's target class as `name.camelize` for the
 * SINGULAR macros (`belongs_to` / `has_one`) and `name.singularize.camelize`
 * for the COLLECTION macros (`has_many` / `has_and_belongs_to_many`). Both
 * walker derivations — the `associationTypes` channel
 * (`collectRubyAssociationTypes` → `associationModelConstant`) and the G1a
 * return-type source (`rubyAssociationTypeSource`) — used to singularize every
 * macro's name, turning `belongs_to :status` into the phantom `Statu`.
 *
 * The singularizer itself follows ActiveSupport's singular rules, so
 * `-us` / `-ss` / `-is` / `-se` words (status, address, analysis, bus, process,
 * response) singularize as Rails does.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { singularizeAssociation } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";
import { RubyChainTypeSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-chain-type.js";
import { rubyAssociationTypeSource } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/associations.js";
import { collectRubyAssociationTypes } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const assocTypes = (src: string) => collectRubyAssociationTypes(parse(src).rootNode);

const returnTypes = (src: string) =>
  Object.fromEntries(
    rubyAssociationTypeSource
      .extract({ code: src, relPath: "test.rb", language: "ruby", tree: parse(src), chunks: [] })
      .filter((f) => f.kind === "return")
      .map((f) => [f.methodName, f.type]),
  );

const MODEL = [
  "class Holder",
  "  belongs_to :status",
  "  has_one :address",
  "  has_many :statuses",
  "  has_many :addresses",
  "  has_many :responses",
  "  has_and_belongs_to_many :analyses",
  '  belongs_to :bus, class_name: "Vehicle"',
  "end",
].join("\n");

describe("association model derivation — singular macros camelize, collection macros singularize", () => {
  it("associationTypes channel: belongs_to/has_one keep the singular name, has_many/habtm singularize", () => {
    expect(assocTypes(MODEL)).toEqual({
      Holder: {
        status: "Status",
        address: "Address",
        statuses: "Status",
        addresses: "Address",
        responses: "Response",
        analyses: "Analysis",
        bus: "Vehicle",
      },
    });
  });

  it("return-type source: same derivation, instance vs container shape", () => {
    const inst = (name: string) => ({ form: "instance", name });
    const coll = (name: string) => ({ form: "container", element: inst(name) });
    expect(returnTypes(MODEL)).toEqual({
      status: inst("Status"),
      address: inst("Address"),
      statuses: coll("Status"),
      addresses: coll("Address"),
      responses: coll("Response"),
      analyses: coll("Analysis"),
      bus: inst("Vehicle"),
    });
  });
});

describe("singularizeAssociation — ActiveSupport singular rules", () => {
  it.each([
    ["posts", "post"],
    ["categories", "category"],
    ["boxes", "box"],
    ["matches", "match"],
    ["wishes", "wish"],
    ["statuses", "status"],
    ["status", "status"],
    ["addresses", "address"],
    ["address", "address"],
    ["analyses", "analysis"],
    ["buses", "bus"],
    ["bus", "bus"],
    ["processes", "process"],
    ["responses", "response"],
    ["cases", "case"],
    ["aliases", "alias"],
    ["wives", "wife"],
    ["halves", "half"],
    ["people", "person"],
    ["children", "child"],
    ["news", "news"],
    ["series", "series"],
    ["blog_posts", "blog_post"],
    ["media_attachments", "media_attachment"],
    ["status_pins", "status_pin"],
  ])("%s → %s", (plural, singular) => {
    expect(singularizeAssociation(plural)).toBe(singular);
  });
});

describe("association typing reaches the resolver — `trend.status.account`", () => {
  const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName,
    relPath,
    scope,
  });

  it("resolves through `belongs_to :status` to Status#account, never a phantom `Statu`", () => {
    const associationTypes = assocTypes("class StatusTrend\n  belongs_to :status\nend\n");
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/status_trend.rb", [
      sym("StatusTrend", "StatusTrend", "app/models/status_trend.rb", []),
    ]);
    symbolTable.upsertFile("app/models/status.rb", [
      sym("Status", "Status", "app/models/status.rb", []),
      sym("Status#account", "account", "app/models/status.rb", ["Status"]),
    ]);
    // Decoy: the singularized-singular name. The old derivation landed here.
    symbolTable.upsertFile("app/models/statu.rb", [
      sym("Statu", "Statu", "app/models/statu.rb", []),
      sym("Statu#account", "account", "app/models/statu.rb", ["Statu"]),
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/trends/statuses.rb",
      callerScope: [],
      imports: [],
      symbolTable,
      localBindings: { trend: [{ line: 1, type: "StatusTrend" }] },
      associationTypes,
    };
    const outcome = new RubyChainTypeSymbolResolutionStrategy({ mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE }).attempt(
      { callText: "trend.status.account", receiver: "trend.status", member: "account", startLine: 5 },
      ctx,
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/status.rb", targetSymbolId: "Status#account" },
    });
    expect(outcome).not.toMatchObject({ target: { targetSymbolId: "Statu#account" } });
  });
});
