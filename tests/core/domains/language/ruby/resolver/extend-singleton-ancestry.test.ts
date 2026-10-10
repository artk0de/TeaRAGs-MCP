/**
 * `extend M` mixes M into the SINGLETON class, not into the instances' ancestry
 * (bd tea-rags-mcp-89k7k.35.31).
 *
 * The walker's flat `classAncestors` list holds superclass + `include` + `extend`
 * alike; the kind-precise `inheritanceEdges` say which entry is which. A lookup
 * whose `self` is an INSTANCE — `self.x` / a bare `x` / `super` inside a `#`
 * method, a receiver typed by `X.new` — walks superclass + include/prepend only,
 * so a module the class only `extend`s can neither answer it nor become its
 * file-only fallback. A lookup whose `self` is the class object (`def self.x`,
 * `class << self`) still reaches the extended module.
 *
 * graphql-ruby's `GraphQL::Schema::Directive` is the measured shape: it extends
 * `HasValidators`, so `self.class` in `Directive#initialize` took a file-only edge
 * into `has_validators.rb`, and `super` in a subclass's `initialize` reached an
 * extended module's `initialize` instead of `Directive#initialize`.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolDefinition,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import {
  extractFromRubyFile,
  SUPER_RECEIVER_SENTINEL,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import {
  buildHierarchySnapshot,
  normalizeInheritanceEdges,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const FILES: Record<string, string> = {
  "app/base.rb": ["class Base", "  def initialize(owner)", "  end", "end"].join("\n"),
  "app/validators.rb": [
    "module Validators",
    "  def validators",
    "  end",
    "  def initialize(*args)",
    "  end",
    "end",
  ].join("\n"),
  "app/helpers.rb": ["module Helpers", "  def helper", "  end", "end"].join("\n"),
  "app/both.rb": ["module Both", "  def both", "  end", "end"].join("\n"),
  // A namesake for every bare-called member, so a bare call is AMBIGUOUS by short
  // name and has to be narrowed through the caller's MRO — the path under test.
  "app/other.rb": ["class Other", "  def validators", "  end", "  def both", "  end", "end"].join("\n"),
  "app/directive.rb": [
    "class Directive < Base",
    "  extend Validators",
    "  include Helpers",
    "  include Both",
    "  extend Both",
    "",
    "  def initialize(owner)",
    "    super",
    "    self.validators",
    "    validators",
    "    self.helper",
    "    both",
    "  end",
    "",
    "  def self.check",
    "    self.validators",
    "    validators",
    "  end",
    "end",
  ].join("\n"),
  "app/svc.rb": ["class Svc", "  def call", "    d = Directive.new(1)", "    d.validators", "  end", "end"].join("\n"),
};

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/base.rb", [
    sym("Base", "Base", "app/base.rb", []),
    sym("Base#initialize", "initialize", "app/base.rb", ["Base"]),
  ]);
  t.upsertFile("app/validators.rb", [
    sym("Validators", "Validators", "app/validators.rb", []),
    sym("Validators#validators", "validators", "app/validators.rb", ["Validators"]),
    sym("Validators#initialize", "initialize", "app/validators.rb", ["Validators"]),
  ]);
  t.upsertFile("app/helpers.rb", [
    sym("Helpers", "Helpers", "app/helpers.rb", []),
    sym("Helpers#helper", "helper", "app/helpers.rb", ["Helpers"]),
  ]);
  t.upsertFile("app/both.rb", [
    sym("Both", "Both", "app/both.rb", []),
    sym("Both#both", "both", "app/both.rb", ["Both"]),
  ]);
  t.upsertFile("app/other.rb", [
    sym("Other", "Other", "app/other.rb", []),
    sym("Other#validators", "validators", "app/other.rb", ["Other"]),
    sym("Other#both", "both", "app/other.rb", ["Other"]),
  ]);
  t.upsertFile("app/directive.rb", [
    sym("Directive", "Directive", "app/directive.rb", []),
    sym("Directive#initialize", "initialize", "app/directive.rb", ["Directive"]),
    sym("Directive.check", "check", "app/directive.rb", ["Directive"]),
  ]);
  t.upsertFile("app/svc.rb", [sym("Svc", "Svc", "app/svc.rb", []), sym("Svc#call", "call", "app/svc.rb", ["Svc"])]);
  return t;
})();

function extract(relPath: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const code = FILES[relPath];
  const chunks = relPath === "app/svc.rb" ? [{ symbolId: "Svc#call", startLine: 2, endLine: 5, scope: ["Svc"] }] : [];
  return extractFromRubyFile({ tree: parser.parse(code), code, relPath, language: "ruby", chunks });
}

const extractions = Object.keys(FILES).map(extract);
const merged = <V>(pick: (e: FileExtraction) => Record<string, V> | undefined): Record<string, V> =>
  Object.assign({}, ...extractions.map((e) => pick(e) ?? {}));
const hierarchy = new MapHierarchyView(
  buildHierarchySnapshot(extractions.flatMap((e) => normalizeInheritanceEdges(e, () => null))),
);
const svcChunk = extractions.find((e) => e.relPath === "app/svc.rb")?.chunks[0];

function resolve(
  call: CallRef,
  callerSymbolId: string,
  callerScope: string[],
  callerFile: string,
): SymbolResolutionTarget | null {
  const ctx: CallContext = {
    callerFile,
    callerScope,
    callerSymbolId,
    imports: [],
    symbolTable,
    hierarchy,
    classAncestors: merged((e) => e.classAncestors),
    classPrependedAncestors: merged((e) => e.classPrependedAncestors),
    classExtends: merged((e) => e.classExtends),
    ...(callerFile === "app/svc.rb" && svcChunk?.localBindings ? { localBindings: svcChunk.localBindings } : {}),
    ...(callerFile === "app/svc.rb" && svcChunk?.constructedLocals
      ? { constructedLocals: svcChunk.constructedLocals }
      : {}),
  };
  return new RubyCallResolver().resolve(call, ctx);
}

const selfCall = (member: string, startLine: number): CallRef => ({
  callText: `self.${member}`,
  receiver: "self",
  member,
  startLine,
});
const bareCall = (member: string, startLine: number): CallRef => ({
  callText: member,
  receiver: null,
  member,
  startLine,
});
const superCall = (member: string, startLine: number): CallRef => ({
  callText: "super",
  receiver: SUPER_RECEIVER_SENTINEL,
  member,
  startLine,
});

const inInstanceMethod = (call: CallRef) => resolve(call, "Directive#initialize", ["Directive"], "app/directive.rb");
const inClassMethod = (call: CallRef) => resolve(call, "Directive.check", ["Directive"], "app/directive.rb");

describe("Ruby `extend M` is singleton ancestry, not instance ancestry (bd 89k7k.35.31)", () => {
  it("records the extended module beside the includes in the flat walker list", () => {
    // Pins the precondition: the flat list still conflates, so the separation
    // has to come from the kind-precise hierarchy, not from the list.
    expect(merged((e) => e.classAncestors).Directive).toEqual(["Base", "Validators", "Helpers", "Both", "Both"]);
  });

  it("an instance `self.x` does not reach a method of a module the class only extends", () => {
    const target = inInstanceMethod(selfCall("validators", 9));
    expect(target?.targetSymbolId).not.toBe("Validators#validators");
    expect(target?.targetRelPath).not.toBe("app/validators.rb");
  });

  it("an instance bare call does not reach a method of a module the class only extends", () => {
    const target = inInstanceMethod(bareCall("validators", 10));
    expect(target?.targetSymbolId).not.toBe("Validators#validators");
    expect(target?.targetRelPath ?? null).not.toBe("app/validators.rb");
  });

  it("a receiver typed by `X.new` does not reach a method of a module X only extends", () => {
    const target = resolve(
      { callText: "d.validators", receiver: "d", member: "validators", startLine: 4 },
      "Svc#call",
      ["Svc"],
      "app/svc.rb",
    );
    expect(target?.targetSymbolId).not.toBe("Validators#validators");
    expect(target?.targetRelPath ?? null).not.toBe("app/validators.rb");
  });

  it("a class-method `self.x` still reaches the extended module", () => {
    expect(inClassMethod(selfCall("validators", 16))).toEqual({
      targetRelPath: "app/validators.rb",
      targetSymbolId: "Validators#validators",
    });
  });

  it("a class-method bare call still reaches the extended module", () => {
    expect(inClassMethod(bareCall("validators", 17))).toEqual({
      targetRelPath: "app/validators.rb",
      targetSymbolId: "Validators#validators",
    });
  });

  it("`super` from an instance `initialize` reaches the superclass, past an extended module defining it", () => {
    expect(inInstanceMethod(superCall("initialize", 8))).toEqual({
      targetRelPath: "app/base.rb",
      targetSymbolId: "Base#initialize",
    });
  });

  it("`include` still contributes to instance lookup", () => {
    expect(inInstanceMethod(selfCall("helper", 11))).toEqual({
      targetRelPath: "app/helpers.rb",
      targetSymbolId: "Helpers#helper",
    });
  });

  it("a module both included and extended stays in the instance ancestry", () => {
    expect(inInstanceMethod(bareCall("both", 12))).toEqual({
      targetRelPath: "app/both.rb",
      targetSymbolId: "Both#both",
    });
  });
});
