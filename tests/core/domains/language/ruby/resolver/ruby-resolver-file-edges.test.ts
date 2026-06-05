import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { ZEITWERK_PREFIX } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * `RubyCallResolver.resolveFileEdges` — Ruby file-level codegraph edges from
 * three channels (explicit require, Zeitwerk constant refs, inheritance/mixins),
 * folded into one `fileEdges[]`. Spec:
 * docs/superpowers/specs/2026-06-05-ruby-file-edges-zeitwerk-inheritance-design.md
 */

function sym(symbolId: string, fqName: string, relPath: string) {
  return { symbolId, fqName, shortName: fqName, relPath, scope: [] as string[] };
}

function ctxFor(extraction: FileExtraction, table: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: extraction.fileScope,
    imports: extraction.imports,
    symbolTable: table,
    classAncestors: extraction.classAncestors,
    classPrependedAncestors: extraction.classPrependedAncestors,
  };
}

function extraction(partial: Partial<FileExtraction> & { relPath: string }): FileExtraction {
  return {
    relPath: partial.relPath,
    language: "ruby",
    imports: partial.imports ?? [],
    chunks: partial.chunks ?? [],
    fileScope: partial.fileScope ?? [],
    classAncestors: partial.classAncestors,
    classPrependedAncestors: partial.classPrependedAncestors,
  };
}

describe("RubyCallResolver.resolveFileEdges", () => {
  it("resolves a Zeitwerk constant reference to a file edge", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [sym("User", "User", "app/models/user.rb")]);
    const ext = extraction({
      relPath: "app/services/sign_up.rb",
      imports: [{ importText: `${ZEITWERK_PREFIX}User`, startLine: 3 }],
      fileScope: ["SignUp"],
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toEqual([{ targetRelPath: "app/models/user.rb", importText: `${ZEITWERK_PREFIX}User` }]);
  });

  it("resolves an explicit require_relative to a file edge (parity with prior behaviour)", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const ext = extraction({
      relPath: "lib/acme/bar.rb",
      imports: [{ importText: "./foo", startLine: 1 }],
      fileScope: ["Bar"],
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toEqual([{ targetRelPath: "lib/acme/foo.rb", importText: "./foo" }]);
  });

  it("resolves a superclass reference to a file edge", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/abstract_policy.rb", [
      sym("AbstractPolicy", "AbstractPolicy", "app/policies/abstract_policy.rb"),
    ]);
    const ext = extraction({
      relPath: "app/policies/product_policy.rb",
      fileScope: ["ProductPolicy"],
      classAncestors: { ProductPolicy: ["AbstractPolicy"] },
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toEqual([
      { targetRelPath: "app/policies/abstract_policy.rb", importText: "AbstractPolicy" },
    ]);
  });

  it("resolves include and prepend mixin modules to file edges", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/trackable.rb", [sym("Trackable", "Trackable", "app/concerns/trackable.rb")]);
    table.upsertFile("app/concerns/auditable.rb", [sym("Auditable", "Auditable", "app/concerns/auditable.rb")]);
    const ext = extraction({
      relPath: "app/models/order.rb",
      fileScope: ["Order"],
      classAncestors: { Order: ["Trackable"] },
      classPrependedAncestors: { Order: ["Auditable"] },
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toEqual(
      expect.arrayContaining([
        { targetRelPath: "app/concerns/trackable.rb", importText: "Trackable" },
        { targetRelPath: "app/concerns/auditable.rb", importText: "Auditable" },
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  it("skips a self-loop edge when an ancestor is declared in the same file", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // Both the class and its sibling base live in the SAME file.
    table.upsertFile("app/models/order.rb", [
      sym("Order", "Order", "app/models/order.rb"),
      sym("BaseOrder", "BaseOrder", "app/models/order.rb"),
    ]);
    const ext = extraction({
      relPath: "app/models/order.rb",
      fileScope: ["Order", "BaseOrder"],
      classAncestors: { Order: ["BaseOrder"] },
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toEqual([]);
  });

  it("deduplicates a target reached via both constant use and inheritance into one edge", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/account.rb", [sym("Account", "Account", "app/models/account.rb")]);
    const ext = extraction({
      relPath: "app/services/billing.rb",
      imports: [{ importText: `${ZEITWERK_PREFIX}Account`, startLine: 2 }],
      fileScope: ["Billing"],
      classAncestors: { Billing: ["Account"] },
    });

    const edges = resolver.resolveFileEdges(ext, ctxFor(ext, table));

    expect(edges).toHaveLength(1);
    expect(edges[0].targetRelPath).toBe("app/models/account.rb");
  });
});
