/**
 * A class reopened across several files, and the file-only fallback of the
 * self/super class-chain walk (bd tea-rags-mcp-89k7k.35.32).
 *
 * graphql-ruby's `GraphQL::Schema::Resolver` is declared in `resolver.rb` and
 * reopened in `resolver/has_payload_type.rb`. With two declarers and no
 * conventional path (`GraphQL` does not snake_case to `graphql`) the class has
 * no single file, so the walk skipped the class's own members and drifted to
 * the nearest mixin whose file it could resolve: `super` in a subclass and
 * `self.class` in the class itself landed as file-only edges in the file of a
 * module that defines neither.
 *
 *   1. A reopened class's members are pinned through the symbol table — the
 *      member's definer is whichever reopening declares it.
 *   2. A module reached through `include` / `extend` / `prepend` never becomes
 *      the file-only fallback: it either defines the member or is not where the
 *      call goes. Only the class chain (the class and its superclasses) may
 *      stand in for an out-of-project definer.
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

const RESOLVER = "lib/graphql/resolver.rb";
const REOPENING = "lib/graphql/resolver/has_payload_type.rb";
const HELPERS = "lib/graphql/helpers.rb";
const CLASS_DSL = "lib/graphql/class_dsl.rb";
const SUBSCRIPTION = "lib/graphql/subscription.rb";
const APP_RECORD = "app/models/application_record.rb";
const POST = "app/models/post.rb";

const FILES: Record<string, string> = {
  [HELPERS]: ["module GraphQL", "  module Helpers", "    def helper", "    end", "  end", "end"].join("\n"),
  [CLASS_DSL]: ["module GraphQL", "  module ClassDsl", "    def description", "    end", "  end", "end"].join("\n"),
  [RESOLVER]: [
    "module GraphQL",
    "  class Resolver",
    "    include Helpers",
    "    extend ClassDsl",
    "",
    "    def initialize(object)",
    "      self.class",
    "    end",
    "",
    "    def call_resolve",
    "    end",
    "",
    "    def self.configure",
    "      self.graphql_name",
    "    end",
    "  end",
    "end",
  ].join("\n"),
  [REOPENING]: [
    "module GraphQL",
    "  class Resolver",
    "    module HasPayloadType",
    "      def payload_type",
    "      end",
    "    end",
    "",
    "    def load_secondary",
    "    end",
    "",
    "    def graphql_name",
    "    end",
    "  end",
    "end",
  ].join("\n"),
  [SUBSCRIPTION]: [
    "module GraphQL",
    "  class Subscription < GraphQL::Resolver",
    "    def initialize(object)",
    "      super",
    "    end",
    "",
    "    def call_resolve",
    "      super",
    "    end",
    "",
    "    def load_secondary",
    "      super",
    "    end",
    "",
    "    def to_s",
    "      super",
    "    end",
    "  end",
    "end",
  ].join("\n"),
  [APP_RECORD]: ["class ApplicationRecord < ActiveRecord::Base", "  include GraphQL::Helpers", "end"].join("\n"),
  [POST]: [
    "class Post < ApplicationRecord",
    "  include GraphQL::Helpers",
    "  def save",
    "    super",
    "  end",
    "  def touch_all",
    "    self.touch",
    "  end",
    "end",
  ].join("\n"),
};

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(HELPERS, [
    sym("GraphQL::Helpers", "Helpers", HELPERS, ["GraphQL"]),
    sym("GraphQL::Helpers#helper", "helper", HELPERS, ["GraphQL", "Helpers"]),
    // Two defs of one name in the mixin's file: the walk cannot pick one, so the
    // honest answer is the file itself — a member genuinely defined there.
    sym("GraphQL::Helpers#twin", "twin", HELPERS, ["GraphQL", "Helpers"]),
    sym("GraphQL::Helpers::Inner#twin", "twin", HELPERS, ["GraphQL", "Helpers", "Inner"]),
  ]);
  t.upsertFile(CLASS_DSL, [
    sym("GraphQL::ClassDsl", "ClassDsl", CLASS_DSL, ["GraphQL"]),
    sym("GraphQL::ClassDsl#description", "description", CLASS_DSL, ["GraphQL", "ClassDsl"]),
  ]);
  t.upsertFile(RESOLVER, [
    sym("GraphQL::Resolver", "Resolver", RESOLVER, ["GraphQL"]),
    sym("GraphQL::Resolver#initialize", "initialize", RESOLVER, ["GraphQL", "Resolver"]),
    sym("GraphQL::Resolver#call_resolve", "call_resolve", RESOLVER, ["GraphQL", "Resolver"]),
    sym("GraphQL::Resolver.configure", "configure", RESOLVER, ["GraphQL", "Resolver"]),
  ]);
  t.upsertFile(REOPENING, [
    sym("GraphQL::Resolver", "Resolver", REOPENING, ["GraphQL"]),
    sym("GraphQL::Resolver::HasPayloadType", "HasPayloadType", REOPENING, ["GraphQL", "Resolver"]),
    sym("GraphQL::Resolver::HasPayloadType#payload_type", "payload_type", REOPENING, [
      "GraphQL",
      "Resolver",
      "HasPayloadType",
    ]),
    sym("GraphQL::Resolver#load_secondary", "load_secondary", REOPENING, ["GraphQL", "Resolver"]),
    sym("GraphQL::Resolver#graphql_name", "graphql_name", REOPENING, ["GraphQL", "Resolver"]),
  ]);
  t.upsertFile(SUBSCRIPTION, [
    sym("GraphQL::Subscription", "Subscription", SUBSCRIPTION, ["GraphQL"]),
    sym("GraphQL::Subscription#initialize", "initialize", SUBSCRIPTION, ["GraphQL", "Subscription"]),
    sym("GraphQL::Subscription#call_resolve", "call_resolve", SUBSCRIPTION, ["GraphQL", "Subscription"]),
    sym("GraphQL::Subscription#load_secondary", "load_secondary", SUBSCRIPTION, ["GraphQL", "Subscription"]),
    sym("GraphQL::Subscription#to_s", "to_s", SUBSCRIPTION, ["GraphQL", "Subscription"]),
  ]);
  t.upsertFile(APP_RECORD, [sym("ApplicationRecord", "ApplicationRecord", APP_RECORD, [])]);
  t.upsertFile(POST, [
    sym("Post", "Post", POST, []),
    sym("Post#save", "save", POST, ["Post"]),
    sym("Post#touch_all", "touch_all", POST, ["Post"]),
  ]);
  return t;
})();

function extract(relPath: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const code = FILES[relPath];
  return extractFromRubyFile({ tree: parser.parse(code), code, relPath, language: "ruby", chunks: [] });
}

const extractions = Object.keys(FILES).map(extract);
const merged = <V>(pick: (e: FileExtraction) => Record<string, V> | undefined): Record<string, V> =>
  Object.assign({}, ...extractions.map((e) => pick(e) ?? {}));
const hierarchy = new MapHierarchyView(
  buildHierarchySnapshot(extractions.flatMap((e) => normalizeInheritanceEdges(e, () => null))),
);

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
  };
  return new RubyCallResolver().resolve(call, ctx);
}

const selfCall = (member: string, startLine: number): CallRef => ({
  callText: `self.${member}`,
  receiver: "self",
  member,
  startLine,
});
const superCall = (member: string, startLine: number): CallRef => ({
  callText: "super",
  receiver: SUPER_RECEIVER_SENTINEL,
  member,
  startLine,
});

const inSubscription = (method: string, call: CallRef) =>
  resolve(call, `GraphQL::Subscription#${method}`, ["GraphQL", "Subscription"], SUBSCRIPTION);

const MIXIN_FILES = [HELPERS, CLASS_DSL, REOPENING];

describe("Ruby reopened class + file-only fallback (bd 89k7k.35.32)", () => {
  it("pins the precondition: the class is declared in two files", () => {
    expect(new Set(symbolTable.lookup("GraphQL::Resolver").map((def) => def.relPath))).toEqual(
      new Set([RESOLVER, REOPENING]),
    );
  });

  it("`super` from a subclass reaches the reopened superclass's method in its primary file", () => {
    expect(inSubscription("initialize", superCall("initialize", 4))).toEqual({
      targetRelPath: RESOLVER,
      targetSymbolId: "GraphQL::Resolver#initialize",
    });
    expect(inSubscription("call_resolve", superCall("call_resolve", 8))).toEqual({
      targetRelPath: RESOLVER,
      targetSymbolId: "GraphQL::Resolver#call_resolve",
    });
  });

  it("`super` from a subclass reaches the reopened superclass's method declared in a secondary file", () => {
    expect(inSubscription("load_secondary", superCall("load_secondary", 12))).toEqual({
      targetRelPath: REOPENING,
      targetSymbolId: "GraphQL::Resolver#load_secondary",
    });
  });

  it("`super` to a core method with no project definer takes no file-only edge into a mixin's file", () => {
    const target = inSubscription("to_s", superCall("to_s", 16));
    expect(MIXIN_FILES).not.toContain(target?.targetRelPath ?? null);
  });

  it("`self.class` in an instance method of a reopened class takes no file-only edge into a mixin's file", () => {
    const target = resolve(selfCall("class", 7), "GraphQL::Resolver#initialize", ["GraphQL", "Resolver"], RESOLVER);
    expect(MIXIN_FILES).not.toContain(target?.targetRelPath ?? null);
  });

  it("class-side `self.x` with no project definer takes no file-only edge into an extended module's file", () => {
    const target = resolve(
      selfCall("graphql_name", 14),
      "GraphQL::Resolver.configure",
      ["GraphQL", "Resolver"],
      RESOLVER,
    );
    expect(MIXIN_FILES).not.toContain(target?.targetRelPath ?? null);
    // The reopening's INSTANCE `graphql_name` is not what a class-side `self` reaches.
    expect(target?.targetSymbolId ?? null).not.toBe("GraphQL::Resolver#graphql_name");
  });

  it("an instance `self.x` reaches the instance method a reopening declares", () => {
    expect(
      resolve(selfCall("graphql_name", 7), "GraphQL::Resolver#initialize", ["GraphQL", "Resolver"], RESOLVER),
    ).toEqual({ targetRelPath: REOPENING, targetSymbolId: "GraphQL::Resolver#graphql_name" });
  });

  it("keeps the file-only edge into the class's own file when its superclass leaves the project", () => {
    expect(resolve(selfCall("touch", 7), "Post#touch_all", ["Post"], POST)).toEqual({
      targetRelPath: POST,
      targetSymbolId: null,
    });
  });

  it("keeps the file-only `super` edge into a project superclass whose own superclass leaves the project", () => {
    expect(resolve(superCall("save", 4), "Post#save", ["Post"], POST)).toEqual({
      targetRelPath: APP_RECORD,
      targetSymbolId: null,
    });
  });

  it("an included module that DOES define the member is still the method-level answer", () => {
    expect(resolve(selfCall("helper", 7), "GraphQL::Resolver#initialize", ["GraphQL", "Resolver"], RESOLVER)).toEqual({
      targetRelPath: HELPERS,
      targetSymbolId: "GraphQL::Helpers#helper",
    });
  });

  it("keeps the file-only edge into a mixin's file that genuinely defines the member (ambiguously)", () => {
    expect(resolve(selfCall("twin", 7), "GraphQL::Resolver#initialize", ["GraphQL", "Resolver"], RESOLVER)).toEqual({
      targetRelPath: HELPERS,
      targetSymbolId: null,
    });
  });
});
