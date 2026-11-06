import { describe, expect, it } from "vitest";

import type { CallContext, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { KotlinCallResolver } from "../../../../../../src/core/domains/language/kotlin/resolver/kotlin-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function def(partial: Pick<SymbolDefinition, "symbolId" | "relPath" | "scope" | "symbolKind">): SymbolDefinition {
  const shortName = partial.symbolId.split(/[#.]/).at(-1) ?? partial.symbolId;
  return { ...partial, fqName: partial.symbolId, shortName };
}

function ctx(callerFile: string, callerScope: string[], table: InMemoryGlobalSymbolTable): CallContext {
  return { callerFile, callerScope, imports: [], symbolTable: table };
}

describe("KotlinCallResolver", () => {
  it("resolves this.method() to the same-file instance member", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Widget.kt", [
      def({ symbolId: "Widget#paint", relPath: "Widget.kt", scope: ["Widget"], symbolKind: "method" }),
    ]);
    const target = resolver.resolve(
      { callText: "this.paint()", receiver: "this", member: "paint", startLine: 3 },
      ctx("Widget.kt", ["Widget"], table),
    );
    expect(target).toEqual({ targetRelPath: "Widget.kt", targetSymbolId: "Widget#paint" });
  });

  it("resolves a same-file bare call to a top-level function", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Widget.kt", [
      def({ symbolId: "topLevel", relPath: "Widget.kt", scope: [], symbolKind: "function" }),
    ]);
    const target = resolver.resolve(
      { callText: "topLevel()", receiver: null, member: "topLevel", startLine: 1 },
      ctx("Widget.kt", [], table),
    );
    expect(target).toEqual({ targetRelPath: "Widget.kt", targetSymbolId: "topLevel" });
  });

  it("lets an enclosing member shadow a same-named top-level function", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Widget.kt", [
      def({ symbolId: "Widget#save", relPath: "Widget.kt", scope: ["Widget"], symbolKind: "method" }),
      def({ symbolId: "save", relPath: "Widget.kt", scope: [], symbolKind: "function" }),
    ]);
    const target = resolver.resolve(
      { callText: "save()", receiver: null, member: "save", startLine: 4 },
      ctx("Widget.kt", ["Widget"], table),
    );
    expect(target?.targetSymbolId).toBe("Widget#save");
  });

  it("does not resolve another file's function or a receiver other than this", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Other.kt", [def({ symbolId: "run", relPath: "Other.kt", scope: [], symbolKind: "function" })]);
    expect(
      resolver.resolve({ callText: "run()", receiver: null, member: "run", startLine: 1 }, ctx("Widget.kt", [], table)),
    ).toBeNull();
    expect(
      resolver.resolve(
        { callText: "Other.run()", receiver: "Other", member: "run", startLine: 2 },
        ctx("Widget.kt", ["Widget"], table),
      ),
    ).toBeNull();
  });

  it("falls back to a companion member spelled with a dot", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Widget.kt", [
      def({
        symbolId: "Widget.Factory.build",
        relPath: "Widget.kt",
        scope: ["Widget", "Factory"],
        symbolKind: "method",
      }),
    ]);
    const target = resolver.resolve(
      { callText: "build()", receiver: null, member: "build", startLine: 4 },
      ctx("Widget.kt", ["Widget", "Factory"], table),
    );
    expect(target?.targetSymbolId).toBe("Widget.Factory.build");
  });
});

describe("KotlinCallResolver typed receiver", () => {
  it("resolves repo.save() from a local binding", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Repo.kt", [
      def({ symbolId: "Repo#save", relPath: "Repo.kt", scope: ["Repo"], symbolKind: "method" }),
    ]);
    const target = resolver.resolve(
      { callText: "repo.save()", receiver: "repo", member: "save", startLine: 4 },
      {
        ...ctx("App.kt", ["App"], table),
        localBindings: { repo: [{ line: 3, type: "Repo" }] },
      },
    );
    expect(target).toEqual({ targetRelPath: "Repo.kt", targetSymbolId: "Repo#save" });
  });

  it("resolves this.repo.save() from the enclosing field type", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Repo.kt", [
      def({ symbolId: "Repo#save", relPath: "Repo.kt", scope: ["Repo"], symbolKind: "method" }),
    ]);
    const target = resolver.resolve(
      { callText: "this.repo.save()", receiver: "this.repo", member: "save", startLine: 4 },
      {
        ...ctx("App.kt", ["App"], table),
        classFieldTypes: { App: { repo: "Repo" } },
      },
    );
    expect(target?.targetSymbolId).toBe("Repo#save");
  });

  it("returns null when the bound type is not in the index", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("App.kt", [def({ symbolId: "App#run", relPath: "App.kt", scope: ["App"], symbolKind: "method" })]);
    const target = resolver.resolve(
      { callText: "repo.save()", receiver: "repo", member: "save", startLine: 4 },
      {
        ...ctx("App.kt", ["App"], table),
        localBindings: { repo: [{ line: 3, type: "Missing" }] },
      },
    );
    expect(target).toBeNull();
  });
});

describe("KotlinCallResolver import file edges", () => {
  it("edges an import that names one project file and leaves an unknown import alone", () => {
    const resolver = new KotlinCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/main/kotlin/com/acme/Repo.kt", [
      def({ symbolId: "Repo", relPath: "src/main/kotlin/com/acme/Repo.kt", scope: [], symbolKind: "class" }),
    ]);
    table.upsertFile("App.kt", []);
    const edges = resolver.resolveFileEdges(
      {
        relPath: "App.kt",
        language: "kotlin",
        imports: [
          { importText: "com.acme.Repo", startLine: 1 },
          { importText: "kotlin.collections.List", startLine: 2 },
          { importText: "com.acme.*", startLine: 3 },
        ],
        chunks: [],
        fileScope: [],
      },
      ctx("App.kt", [], table),
    );
    expect(edges).toEqual([{ targetRelPath: "src/main/kotlin/com/acme/Repo.kt", importText: "com.acme.Repo" }]);
  });
});
