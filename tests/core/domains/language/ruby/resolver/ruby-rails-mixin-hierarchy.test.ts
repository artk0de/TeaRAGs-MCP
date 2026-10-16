/**
 * bd tea-rags-mcp-2m83f.48 — the Rails-member rule (2m83f.24) claims a call on
 * an untyped receiver only when no project namesake is reachable from an AR
 * model instance. A model hierarchy carrying a mixin the walker could not read
 * may reach ANY module, so the rule then never claims a module namesake.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const resolver = new RubyCallResolver();

function sym(symbolId: string, relPath: string, symbolKind?: SymbolDefinitionKind): SymbolDefinition {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  const owner = cut === -1 ? [] : symbolId.slice(0, cut).split("::");
  const shortName = cut === -1 ? (symbolId.split("::").at(-1) ?? symbolId) : symbolId.slice(cut + 1);
  return { symbolId, fqName: symbolId, shortName, relPath, scope: owner, ...(symbolKind ? { symbolKind } : {}) };
}

function table(defs: SymbolDefinition[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, SymbolDefinition[]>();
  for (const def of defs) byFile.set(def.relPath, [...(byFile.get(def.relPath) ?? []), def]);
  for (const [relPath, fileDefs] of byFile) t.upsertFile(relPath, fileDefs);
  return t;
}

/** The ancestry the walker records for `src`. */
function walkedAncestors(src: string): Pick<CallContext, "classAncestors" | "unresolvedMixinClasses"> {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const out = extractFromRubyFile({
    tree: parser.parse(src),
    code: src,
    relPath: "x.rb",
    language: "ruby",
    chunks: [],
  });
  return {
    classAncestors: { ApplicationRecord: ["ActiveRecord::Base"], ...out.classAncestors },
    unresolvedMixinClasses: new Set(out.unresolvedMixinClasses ?? []),
  };
}

function ctx(symbolTable: InMemoryGlobalSymbolTable, extra: Partial<CallContext>): CallContext {
  return {
    callerFile: "app/services/billing.rb",
    callerScope: ["Billing"],
    imports: [],
    symbolTable,
    declaredDependencies: new Set(["rails"]),
    ...extra,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}`,
  receiver,
  member,
  startLine: 10,
});

const lockable = (): InMemoryGlobalSymbolTable =>
  table([sym("Lockable", "app/lib/lockable.rb", "module"), sym("Lockable#with_lock", "app/lib/lockable.rb", "method")]);

describe("incomplete mixin hierarchy keeps the Rails-member rule conservative (2m83f.48)", () => {
  it("`include A, B` with B defining with_lock: x.with_lock is not external", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\n  include Auditable, Lockable\nend\n");
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(false);
  });

  it("`send(:include, Helper)` in a model reaches Helper's namesake", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\n  send(:include, Lockable)\nend\n");
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(false);
  });

  it("`include some_var` in a model: no module namesake is claimed", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\n  include some_var\nend\n");
    expect(walked.unresolvedMixinClasses).toEqual(new Set(["Invoice"]));
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(false);
  });

  it("an opaque mixin in a model still lets a plain class's namesake be claimed", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\n  include some_var\nend\n");
    const t = table([
      sym("Reports::Form", "app/forms/form.rb", "class"),
      sym("Reports::Form#save!", "app/forms/form.rb"),
    ]);
    expect(resolver.targetsExternalImport(call("form", "save!"), ctx(t, walked))).toBe(true);
  });

  it("a concern's `included do; include X; end` makes X reachable through the concern's includers", () => {
    const walked = walkedAncestors(
      "module Trackable\n  extend ActiveSupport::Concern\n  included do\n    include Lockable\n  end\nend\n" +
        "class Invoice < ApplicationRecord\n  include Trackable\nend\n",
    );
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(false);
  });

  it("an opaque mixin outside the model hierarchy changes nothing", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\nend\nclass Report\n  include some_var\nend\n");
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(true);
  });

  it("a module included nowhere stays externalSkipped", () => {
    const walked = walkedAncestors("class Invoice < ApplicationRecord\n  include Auditable\nend\n");
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(lockable(), walked))).toBe(true);
  });
});
