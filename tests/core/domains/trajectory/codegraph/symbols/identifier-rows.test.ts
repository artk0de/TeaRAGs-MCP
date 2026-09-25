/**
 * `buildIdentifierRows` (bd tea-rags-mcp-4p3sb.9) — the sink-time join from a
 * file's `identifierDeclarations` and type channels to `cg_identifiers` rows.
 *
 * Invariant pinned last: rows come ONLY from declarations and the three type
 * channels. A receiver a naming convention could type (`tax_automation_document`
 * → `TaxAutomationDocument`) produces no row when nothing declares it — a lexicon
 * fed by its own convention would confirm itself.
 */

import { describe, expect, it } from "vitest";

import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  IdentifierDeclaration,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  LanguageFactoryDescriptor,
  LanguageProvider,
} from "../../../../../../src/core/contracts/types/language.js";
import {
  buildIdentifierRows,
  collectIdentifierFinderVocabulary,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/identifier-rows.js";

function chunk(partial: Partial<ChunkExtraction> & Pick<ChunkExtraction, "symbolId">): ChunkExtraction {
  return { scope: [], calls: [], ...partial };
}

function extraction(partial: Partial<FileExtraction>): FileExtraction {
  return {
    relPath: "app/services/process_event.rb",
    language: "ruby",
    imports: [],
    chunks: [],
    fileScope: [],
    ...partial,
  };
}

function decl(partial: Partial<IdentifierDeclaration> & Pick<IdentifierDeclaration, "name">): IdentifierDeclaration {
  return { kind: "local", line: 5, ownerSymbolId: "ProcessEvent#call", ...partial };
}

function call(partial: Partial<CallRef> & Pick<CallRef, "member" | "startLine">): CallRef {
  return { callText: `${partial.member}()`, receiver: null, ...partial };
}

const RUBY_FINDERS = new Map([["ruby", new Set(["find", "find_by!"])]]);

describe("buildIdentifierRows", () => {
  it("keeps a syntactic type with its source", () => {
    const rows = buildIdentifierRows(
      extraction({
        language: "typescript",
        chunks: [chunk({ symbolId: "Svc#run" })],
        identifierDeclarations: [
          decl({ name: "doc", kind: "param", ownerSymbolId: "Svc#run", typeName: "Doc", typeSource: "annotation" }),
        ],
      }),
    );
    expect(rows).toEqual([
      { ownerSymbolId: "Svc#run", kind: "param", name: "doc", line: 5, typeName: "Doc", typeSource: "annotation" },
    ]);
  });

  it("types an untyped Ruby local from the owner chunk's binding on its line", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            localBindings: { row: [{ line: 5, type: "TaxAutomationDocument" }] },
          }),
        ],
        identifierDeclarations: [decl({ name: "row" })],
      }),
    );
    expect(rows).toEqual([
      {
        ownerSymbolId: "ProcessEvent#call",
        kind: "local",
        name: "row",
        line: 5,
        typeName: "TaxAutomationDocument",
        typeSource: "binding",
      },
    ]);
  });

  it("falls back to the nearest preceding binding when none sits on the declaration's line", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            localBindings: {
              row: [
                { line: 2, type: "Early" },
                { line: 4, type: "Nearest" },
                { line: 9, type: "Later" },
              ],
            },
          }),
        ],
        identifierDeclarations: [decl({ name: "row", line: 6 })],
      }),
    );
    expect(rows[0]).toMatchObject({ typeName: "Nearest", typeSource: "binding" });
  });

  it("ignores a binding with an empty type", () => {
    const rows = buildIdentifierRows(
      extraction({
        language: "go",
        chunks: [chunk({ symbolId: "run", localBindings: { err: [{ line: 5, type: "" }] } })],
        identifierDeclarations: [decl({ name: "err", ownerSymbolId: "run" })],
      }),
    );
    expect(rows).toEqual([{ ownerSymbolId: "run", kind: "local", name: "err", line: 5 }]);
  });

  it("types a field from the enclosing class's ivar types", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "Acme::Importer#initialize", scope: ["Acme", "Importer"] })],
        ivarTypes: { "Acme::Importer": { "@account": "Account" } },
        identifierDeclarations: [decl({ name: "@account", kind: "field", ownerSymbolId: "Acme::Importer#initialize" })],
      }),
    );
    expect(rows[0]).toMatchObject({ name: "@account", typeName: "Account", typeSource: "field-type" });
  });

  it("types a field from the short-name class field types, with or without the sigil", () => {
    const rows = buildIdentifierRows(
      extraction({
        language: "python",
        chunks: [chunk({ symbolId: "Importer.__init__", scope: ["Importer"] })],
        classFieldTypes: { Importer: { client: "HttpClient" } },
        identifierDeclarations: [decl({ name: "self.client", kind: "field", ownerSymbolId: "Importer.__init__" })],
      }),
    );
    expect(rows[0]).toMatchObject({ typeName: "HttpClient", typeSource: "field-type" });
  });

  it("builds a return row from a structured return type", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "ProcessEvent#find_tax_automation_document!", startLine: 12 })],
        structuredReturnTypes: {
          "ProcessEvent#find_tax_automation_document!": { form: "instance", name: "TaxAutomationDocument" },
        },
      }),
    );
    expect(rows).toEqual([
      {
        ownerSymbolId: "ProcessEvent#find_tax_automation_document!",
        kind: "return",
        name: "find_tax_automation_document!",
        line: 12,
        typeName: "TaxAutomationDocument",
        typeSource: "return-type",
      },
    ]);
  });

  it("names a container return by its element and skips a return with no single nominal name", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "Repo.all", startLine: 3 }), chunk({ symbolId: "Repo.maybe", startLine: 8 })],
        structuredReturnTypes: {
          "Repo.all": { form: "container", element: { form: "instance", name: "Doc" } },
          "Repo.maybe": { form: "union", members: [{ form: "instance", name: "Doc" }, { form: "nil" }] },
        },
      }),
    );
    expect(rows).toEqual([
      { ownerSymbolId: "Repo.all", kind: "return", name: "all", line: 3, typeName: "Doc", typeSource: "return-type" },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.21 — a return row for every function whose return type is knowable.
  describe("return rows from every producer", () => {
    it("persists a syntactic return declaration as a return-type row", () => {
      const rows = buildIdentifierRows(
        extraction({
          language: "typescript",
          chunks: [chunk({ symbolId: "loadDocument", startLine: 1 })],
          identifierDeclarations: [
            decl({
              name: "loadDocument",
              kind: "return",
              line: 2,
              ownerSymbolId: "loadDocument",
              typeName: "Document",
              typeSource: "annotation",
            }),
          ],
        }),
      );
      expect(rows).toEqual([
        {
          ownerSymbolId: "loadDocument",
          kind: "return",
          name: "loadDocument",
          line: 2,
          typeName: "Document",
          typeSource: "return-type",
        },
      ]);
    });

    it("keeps one return row per owner: syntactic, then structured, then the flat channel", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [
            chunk({ symbolId: "Svc#a", startLine: 1 }),
            chunk({ symbolId: "Svc#b", startLine: 5 }),
            chunk({ symbolId: "Svc#c", startLine: 9 }),
          ],
          identifierDeclarations: [
            decl({
              name: "a",
              kind: "return",
              line: 1,
              ownerSymbolId: "Svc#a",
              typeName: "A",
              typeSource: "annotation",
            }),
          ],
          structuredReturnTypes: {
            "Svc#a": { form: "instance", name: "Structured" },
            "Svc#b": { form: "instance", name: "B" },
          },
          functionReturnTypes: { a: "Flat", b: "Flat", c: "C" },
        }),
      );
      expect(rows.map((r) => [r.ownerSymbolId, r.typeName, r.typeSource])).toEqual([
        ["Svc#a", "A", "return-type"],
        ["Svc#b", "B", "return-type"],
        ["Svc#c", "C", "return-type"],
      ]);
    });

    it("maps a flat key — bare or package-qualified — onto the one chunk of the file naming it", () => {
      const rows = buildIdentifierRows(
        extraction({
          relPath: "pkg/engine/engine.go",
          language: "go",
          chunks: [
            chunk({ symbolId: "New", startLine: 3 }),
            chunk({ symbolId: "Engine.Client", startLine: 8 }),
            chunk({ symbolId: "Engine.Run", startLine: 12 }),
            chunk({ symbolId: "Other.Run", startLine: 20 }),
          ],
          functionReturnTypes: {
            "pkg/engine::New": "Engine",
            Client: "net/http.Client",
            Run: "Result",
            "pkg/engine::missing": "Ghost",
          },
        }),
      );
      expect(rows).toEqual([
        { ownerSymbolId: "New", kind: "return", name: "New", line: 3, typeName: "Engine", typeSource: "return-type" },
        {
          ownerSymbolId: "Engine.Client",
          kind: "return",
          name: "Client",
          line: 8,
          typeName: "http.Client",
          typeSource: "return-type",
        },
      ]);
    });

    it("names a `::`-scoped owner by its member", () => {
      const rows = buildIdentifierRows(
        extraction({
          language: "rust",
          chunks: [chunk({ symbolId: "Repo::load", startLine: 4 })],
          structuredReturnTypes: { "Repo::load": { form: "instance", name: "Doc" } },
        }),
      );
      expect(rows[0]).toMatchObject({ ownerSymbolId: "Repo::load", name: "load" });
    });
  });

  it("strips a leading root-namespace :: from type names", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "ProcessEvent#call" })],
        identifierDeclarations: [decl({ name: "sys", typeName: "::System", typeSource: "constructor" })],
      }),
    );
    expect(rows[0]).toMatchObject({ typeName: "System", typeSource: "constructor" });
  });

  describe("bound callee", () => {
    it("copies the callee and the callText of the first matching call at or after the declaration", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [
            chunk({
              symbolId: "ProcessEvent#call",
              calls: [
                call({ member: "find_doc!", startLine: 3, callText: "find_doc!(earlier)" }),
                call({ member: "find_doc!", startLine: 9, callText: "find_doc!(later)" }),
                call({ member: "find_doc!", startLine: 6, callText: "find_doc!(id)" }),
                call({ member: "find_doc!", receiver: "Other", startLine: 5, callText: "Other.find_doc!(x)" }),
              ],
            }),
          ],
          identifierDeclarations: [decl({ name: "document", line: 5, boundCallee: { member: "find_doc!" } })],
        }),
      );
      expect(rows).toEqual([
        {
          ownerSymbolId: "ProcessEvent#call",
          kind: "local",
          name: "document",
          line: 5,
          boundMember: "find_doc!",
          boundCallExpression: "find_doc!(id)",
        },
      ]);
    });

    it("keeps the callee but no call expression when no call matches", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call", calls: [call({ member: "other", startLine: 5 })] })],
          identifierDeclarations: [decl({ name: "x", boundCallee: { member: "make", receiver: "Factory" } })],
        }),
      );
      expect(rows).toEqual([
        {
          ownerSymbolId: "ProcessEvent#call",
          kind: "local",
          name: "x",
          line: 5,
          boundMember: "make",
          boundReceiver: "Factory",
        },
      ]);
    });

    it("types a local bound to a finder on a constant receiver as that constant (finder stage)", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [
            chunk({
              symbolId: "ProcessEvent#call",
              calls: [
                call({
                  member: "find_by!",
                  receiver: "::Tax::Doc",
                  startLine: 5,
                  callText: "::Tax::Doc.find_by!(id: 1)",
                }),
              ],
            }),
          ],
          identifierDeclarations: [decl({ name: "doc", boundCallee: { member: "find_by!", receiver: "::Tax::Doc" } })],
        }),
        RUBY_FINDERS,
      );
      expect(rows[0]).toMatchObject({
        typeName: "Tax::Doc",
        typeSource: "finder",
        boundCallExpression: "::Tax::Doc.find_by!(id: 1)",
      });
    });

    it("does not treat a non-finder member, a non-constant receiver, or another language's call as a finder", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call" })],
          identifierDeclarations: [
            decl({ name: "a", boundCallee: { member: "where", receiver: "Doc" } }),
            decl({ name: "b", boundCallee: { member: "find", receiver: "repo" } }),
            decl({ name: "c", boundCallee: { member: "find", receiver: "Doc.where(x)" } }),
            decl({ name: "d", boundCallee: { member: "find" } }),
          ],
        }),
        RUBY_FINDERS,
      );
      expect(rows.every((r) => r.typeName === undefined)).toBe(true);

      const python = buildIdentifierRows(
        extraction({
          language: "python",
          chunks: [chunk({ symbolId: "run" })],
          identifierDeclarations: [
            decl({ name: "doc", ownerSymbolId: "run", boundCallee: { member: "find", receiver: "Doc" } }),
          ],
        }),
        RUBY_FINDERS,
      );
      expect(python[0]?.typeName).toBeUndefined();
    });

    it("prefers a resolver binding over the finder stage", () => {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call", localBindings: { doc: [{ line: 5, type: "Draft" }] } })],
          identifierDeclarations: [decl({ name: "doc", boundCallee: { member: "find", receiver: "Doc" } })],
        }),
        RUBY_FINDERS,
      );
      expect(rows[0]).toMatchObject({ typeName: "Draft", typeSource: "binding" });
    });
  });

  it("produces no row for a convention-typable receiver nothing declares", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            calls: [
              call({
                member: "provider",
                receiver: "tax_automation_document",
                startLine: 7,
                callText: "tax_automation_document.provider",
              }),
            ],
          }),
        ],
      }),
    );
    expect(rows).toEqual([]);
  });
});

describe("collectIdentifierFinderVocabulary", () => {
  it("collects each language's finder methods, skipping languages that declare none", () => {
    const providers: Record<string, Partial<LanguageProvider>> = {
      ruby: { identifierFinderMethods: ["find", "first"] },
      typescript: {},
    };
    const factory = {
      supported: () => Object.keys(providers),
      create: (lang: string) => providers[lang] as LanguageProvider,
    } as unknown as LanguageFactoryDescriptor;

    const vocabulary = collectIdentifierFinderVocabulary(factory);

    expect([...vocabulary.keys()]).toEqual(["ruby"]);
    expect([...(vocabulary.get("ruby") ?? [])]).toEqual(["find", "first"]);
    expect(collectIdentifierFinderVocabulary(undefined).size).toBe(0);
  });
});

describe("buildIdentifierRows — owner chunk resolution", () => {
  it("a symbol split into several chunks reads the chunk holding the declaration's line", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            startLine: 1,
            endLine: 10,
            localBindings: { doc: [{ line: 5, type: "Draft" }] },
          }),
          chunk({
            symbolId: "ProcessEvent#call",
            startLine: 11,
            endLine: 20,
            localBindings: { doc: [{ line: 15, type: "Invoice" }] },
            calls: [call({ member: "load", startLine: 15, callText: "load(id)" })],
          }),
        ],
        identifierDeclarations: [
          decl({ name: "doc", line: 5 }),
          decl({ name: "doc", line: 15, boundCallee: { member: "load" } }),
        ],
      }),
    );
    expect(rows).toEqual([
      {
        ownerSymbolId: "ProcessEvent#call",
        kind: "local",
        name: "doc",
        line: 5,
        typeName: "Draft",
        typeSource: "binding",
      },
      {
        ownerSymbolId: "ProcessEvent#call",
        kind: "local",
        name: "doc",
        line: 15,
        typeName: "Invoice",
        typeSource: "binding",
        boundMember: "load",
        boundCallExpression: "load(id)",
      },
    ]);
  });

  it("a declaration whose owner has no chunk keeps its syntax but recovers no field type or call text", () => {
    const rows = buildIdentifierRows(
      extraction({
        classFieldTypes: { Orphan: { client: "HttpClient" } },
        identifierDeclarations: [
          decl({ name: "client", kind: "field", ownerSymbolId: "Orphan" }),
          decl({ name: "row", ownerSymbolId: "Orphan#run", boundCallee: { member: "fetch", receiver: "api" } }),
        ],
      }),
    );
    expect(rows).toEqual([
      { ownerSymbolId: "Orphan", kind: "field", name: "client", line: 5 },
      { ownerSymbolId: "Orphan#run", kind: "local", name: "row", line: 5, boundMember: "fetch", boundReceiver: "api" },
    ]);
  });
});

// Live taxdome recompute (2026-09-25) died with `Worker error: (bindings ?? [])
// is not iterable`: a declared name that is also an `Object.prototype` member
// (`constructor`, `toString`, `hasOwnProperty`) looked up a plain-object channel
// map and got the inherited FUNCTION back. The binding channel then threw, and
// the field channel would have written that function as the row's type.
describe("buildIdentifierRows — names shared with Object.prototype", () => {
  const PROTOTYPE_NAMES = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];

  it("a local named like a prototype member stays untyped instead of throwing", () => {
    for (const name of PROTOTYPE_NAMES) {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call", localBindings: { row: [{ line: 5, type: "Doc" }] } })],
          identifierDeclarations: [decl({ name })],
        }),
      );
      expect(rows, name).toEqual([{ ownerSymbolId: "ProcessEvent#call", kind: "local", name, line: 5 }]);
    }
  });

  it("a field named like a prototype member takes no inherited function as its type", () => {
    for (const name of PROTOTYPE_NAMES) {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call", scope: ["ProcessEvent"] })],
          ivarTypes: { ProcessEvent: { "@row": "Doc" } },
          classFieldTypes: { ProcessEvent: { row: "Doc" } },
          identifierDeclarations: [decl({ name, kind: "field" })],
        }),
      );
      expect(rows, name).toEqual([{ ownerSymbolId: "ProcessEvent#call", kind: "field", name, line: 5 }]);
    }
  });

  it("a declaration still reads its own entry when the map also holds a prototype-named one", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            localBindings: { constructor: [{ line: 5, type: "Builder" }] },
          }),
        ],
        identifierDeclarations: [decl({ name: "constructor" })],
      }),
    );
    expect(rows).toEqual([
      {
        ownerSymbolId: "ProcessEvent#call",
        kind: "local",
        name: "constructor",
        line: 5,
        typeName: "Builder",
        typeSource: "binding",
      },
    ]);
  });
});
