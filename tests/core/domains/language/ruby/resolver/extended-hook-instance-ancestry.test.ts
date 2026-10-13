/**
 * A singleton-only `extend M` leaves the instance ancestry, but what M's
 * `self.extended` hook includes / prepends into the extender joins it (bd
 * tea-rags-mcp-89k7k.35.31).
 *
 * graphql-ruby's measured shape: `GraphQL::Schema::Resolver` extends
 * `Member::HasArguments`, whose hook runs `cls.include(ArgumentObjectLoader)`,
 * so `super` in `Subscription#load_application_object_failed` (Subscription <
 * Resolver) reaches `HasArguments::ArgumentObjectLoader#load_application_object_failed`.
 * A hook that only `cls.extend`s stays on the singleton side.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import {
  extractFromRubyFile,
  SUPER_RECEIVER_SENTINEL,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view/index.js";
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

const HOOKS = "app/has_arguments.rb";
const ONLY_EXTENDS = "app/only_extends.rb";

const FILES: Record<string, string> = {
  [HOOKS]: [
    "module Outer",
    "  module HasArguments",
    "    def self.extended(cls)",
    "      cls.include(ArgumentObjectLoader)",
    "      cls.prepend(Wrapping)",
    "    end",
    "    module ArgumentObjectLoader",
    "      def load_application_object_failed(err)",
    "      end",
    "    end",
    "    module Wrapping",
    "      def wrapped",
    "      end",
    "    end",
    "  end",
    "end",
  ].join("\n"),
  [ONLY_EXTENDS]: [
    "module OnlyExtends",
    "  def self.extended(cls)",
    "    cls.extend(ClassSide)",
    "  end",
    "  def load_application_object_failed(err)",
    "  end",
    "  module ClassSide",
    "    def class_side",
    "    end",
    "  end",
    "end",
  ].join("\n"),
  "app/resolver.rb": ["class Resolver", "  extend Outer::HasArguments", "end"].join("\n"),
  "app/subscription.rb": [
    "class Subscription < Resolver",
    "  def load_application_object_failed(err)",
    "    super",
    "  end",
    "",
    "  def run",
    "    self.wrapped",
    "  end",
    "end",
  ].join("\n"),
  "app/plain.rb": [
    "class Plain",
    "  extend OnlyExtends",
    "",
    "  def load_application_object_failed(err)",
    "    super",
    "  end",
    "",
    "  def go",
    "    class_side",
    "  end",
    "end",
  ].join("\n"),
  // Namesakes, so a member is AMBIGUOUS by short name and only the caller's MRO
  // can pick it.
  "app/noise.rb": [
    "class Noise",
    "  def load_application_object_failed(err)",
    "  end",
    "  def wrapped",
    "  end",
    "  def class_side",
    "  end",
    "end",
  ].join("\n"),
};

const LOADER = "Outer::HasArguments::ArgumentObjectLoader";
const WRAPPING = "Outer::HasArguments::Wrapping";

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(HOOKS, [
    sym("Outer", "Outer", HOOKS, []),
    sym("Outer::HasArguments", "HasArguments", HOOKS, ["Outer"]),
    sym(LOADER, "ArgumentObjectLoader", HOOKS, ["Outer", "HasArguments"]),
    sym(`${LOADER}#load_application_object_failed`, "load_application_object_failed", HOOKS, [
      "Outer",
      "HasArguments",
      "ArgumentObjectLoader",
    ]),
    sym(WRAPPING, "Wrapping", HOOKS, ["Outer", "HasArguments"]),
    sym(`${WRAPPING}#wrapped`, "wrapped", HOOKS, ["Outer", "HasArguments", "Wrapping"]),
  ]);
  t.upsertFile(ONLY_EXTENDS, [
    sym("OnlyExtends", "OnlyExtends", ONLY_EXTENDS, []),
    sym("OnlyExtends#load_application_object_failed", "load_application_object_failed", ONLY_EXTENDS, ["OnlyExtends"]),
    sym("OnlyExtends::ClassSide", "ClassSide", ONLY_EXTENDS, ["OnlyExtends"]),
    sym("OnlyExtends::ClassSide#class_side", "class_side", ONLY_EXTENDS, ["OnlyExtends", "ClassSide"]),
  ]);
  t.upsertFile("app/resolver.rb", [sym("Resolver", "Resolver", "app/resolver.rb", [])]);
  t.upsertFile("app/subscription.rb", [
    sym("Subscription", "Subscription", "app/subscription.rb", []),
    sym("Subscription#load_application_object_failed", "load_application_object_failed", "app/subscription.rb", [
      "Subscription",
    ]),
    sym("Subscription#run", "run", "app/subscription.rb", ["Subscription"]),
  ]);
  t.upsertFile("app/plain.rb", [
    sym("Plain", "Plain", "app/plain.rb", []),
    sym("Plain#load_application_object_failed", "load_application_object_failed", "app/plain.rb", ["Plain"]),
    sym("Plain#go", "go", "app/plain.rb", ["Plain"]),
  ]);
  t.upsertFile("app/noise.rb", [
    sym("Noise", "Noise", "app/noise.rb", []),
    sym("Noise#load_application_object_failed", "load_application_object_failed", "app/noise.rb", ["Noise"]),
    sym("Noise#wrapped", "wrapped", "app/noise.rb", ["Noise"]),
    sym("Noise#class_side", "class_side", "app/noise.rb", ["Noise"]),
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

function resolve(call: CallRef, callerSymbolId: string, callerScope: string[], callerFile: string) {
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
    extendedHookMixins: merged((e) => e.extendedHookMixins),
  };
  return new RubyCallResolver().resolve(call, ctx);
}

const superCall = (member: string, startLine: number): CallRef => ({
  callText: "super",
  receiver: SUPER_RECEIVER_SENTINEL,
  member,
  startLine,
});
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

describe("Ruby instance ancestry substitutes an extended module's hook mixins (bd 89k7k.35.31)", () => {
  it("instance `super` reaches the module the extended module's hook includes", () => {
    expect(
      resolve(
        superCall("load_application_object_failed", 3),
        "Subscription#load_application_object_failed",
        ["Subscription"],
        "app/subscription.rb",
      ),
    ).toEqual({ targetRelPath: HOOKS, targetSymbolId: `${LOADER}#load_application_object_failed` });
  });

  it("an instance `self.` call reaches the module the extended module's hook prepends", () => {
    expect(resolve(selfCall("wrapped", 7), "Subscription#run", ["Subscription"], "app/subscription.rb")).toEqual({
      targetRelPath: HOOKS,
      targetSymbolId: `${WRAPPING}#wrapped`,
    });
  });

  it("a hook that only `cls.extend`s contributes nothing to the instance side", () => {
    const sup = resolve(
      superCall("load_application_object_failed", 5),
      "Plain#load_application_object_failed",
      ["Plain"],
      "app/plain.rb",
    );
    expect(sup?.targetSymbolId ?? null).not.toBe("OnlyExtends#load_application_object_failed");
    expect(sup?.targetRelPath ?? null).not.toBe(ONLY_EXTENDS);
    const bare = resolve(bareCall("class_side", 9), "Plain#go", ["Plain"], "app/plain.rb");
    expect(bare?.targetSymbolId ?? null).not.toBe("OnlyExtends::ClassSide#class_side");
    expect(bare?.targetRelPath ?? null).not.toBe(ONLY_EXTENDS);
  });
});
