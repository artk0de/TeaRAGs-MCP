/**
 * `buildIdentifierRows` (bd tea-rags-mcp-4p3sb.9) — the sink-time join from a
 * file's `identifierDeclarations` and type channels to `cg_identifiers` rows.
 *
 * Invariant pinned last: rows come ONLY from declarations and the three type
 * channels. A receiver a naming convention could type (`tax_automation_document`
 * → `TaxAutomationDocument`) produces no row when nothing declares it — a lexicon
 * fed by its own convention would confirm itself.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
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
import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";
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
      {
        ownerSymbolId: "Repo.all",
        kind: "return",
        name: "all",
        line: 3,
        typeName: "Doc",
        typeSource: "return-type",
        // bd tea-rags-mcp-4p3sb.26: the container is read as its element AND as many of it.
        typeMultiplicity: "many",
      },
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

// Live taxdome: byType for GrowthBilling::Subscription listed `return` rows named
// `initialize`. A constructor's "return" is its own class, not a naming choice.
describe("buildIdentifierRows — constructors publish no return row", () => {
  const cases: readonly { language: string; symbolId: string }[] = [
    { language: "ruby", symbolId: "GrowthBilling::Subscription#initialize" },
    { language: "typescript", symbolId: "Subscription#constructor" },
    { language: "javascript", symbolId: "Subscription#constructor" },
    { language: "python", symbolId: "Subscription#__init__" },
    { language: "swift", symbolId: "Subscription#init" },
    { language: "swift", symbolId: "Billing.Subscription.init" },
    { language: "java", symbolId: "billing.Subscription#Subscription" },
  ];

  it.each(cases)("$language $symbolId: no row from any return producer", ({ language, symbolId }) => {
    const member = symbolId.slice(Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf(".")) + 1);
    const rows = buildIdentifierRows(
      extraction({
        language,
        chunks: [chunk({ symbolId, startLine: 3 })],
        identifierDeclarations: [
          decl({ name: member, kind: "return", ownerSymbolId: symbolId, line: 3, typeName: "Subscription" }),
        ],
        structuredReturnTypes: { [symbolId]: { form: "instance", name: "Subscription" } },
        functionReturnTypes: { [member]: "Subscription" },
      }),
    );
    expect(rows).toEqual([]);
  });

  it("a constructor's params and locals still produce rows", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "Subscription#initialize" })],
        identifierDeclarations: [decl({ name: "plan", kind: "param", ownerSymbolId: "Subscription#initialize" })],
        structuredReturnTypes: { "Subscription#initialize": { form: "instance", name: "Subscription" } },
      }),
    );
    expect(rows).toEqual([{ ownerSymbolId: "Subscription#initialize", kind: "param", name: "plan", line: 5 }]);
  });

  it("a constructor name of ANOTHER language is an ordinary method, and Rust `new` keeps its return row", () => {
    const tsInitialize = buildIdentifierRows(
      extraction({
        language: "typescript",
        chunks: [chunk({ symbolId: "Boot#initialize", startLine: 2 })],
        structuredReturnTypes: { "Boot#initialize": { form: "instance", name: "Session" } },
      }),
    );
    expect(tsInitialize.map((r) => [r.kind, r.name, r.typeName])).toEqual([["return", "initialize", "Session"]]);

    const rustNew = buildIdentifierRows(
      extraction({
        language: "rust",
        chunks: [chunk({ symbolId: "Subscription.new", startLine: 2 })],
        structuredReturnTypes: { "Subscription.new": { form: "instance", name: "Subscription" } },
      }),
    );
    expect(rustNew.map((r) => [r.kind, r.name, r.typeName])).toEqual([["return", "new", "Subscription"]]);
  });
});

// Known Defect 4 (live taxdome): the `binding` source typed local `matching_root`
// as `APP_ROOTS_FOR_DOMAIN_LOOKUP`. A value constant is not a type.
describe("buildIdentifierRows — a SCREAMING_SNAKE constant is never a type", () => {
  it("leaves a binding-, field- and finder-typed row untyped when the type is a value constant", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "Lookup#call",
            scope: ["Lookup"],
            localBindings: { matching_root: [{ line: 5, type: "APP_ROOTS_FOR_DOMAIN_LOOKUP" }] },
            calls: [call({ member: "find", receiver: "Config::DEFAULT_ROOTS", startLine: 6 })],
          }),
        ],
        ivarTypes: { Lookup: { "@root": "Config::DEFAULT_ROOT_PATH" } },
        identifierDeclarations: [
          decl({ name: "matching_root", ownerSymbolId: "Lookup#call" }),
          decl({ name: "@root", kind: "field", ownerSymbolId: "Lookup#call" }),
          decl({
            name: "fallback",
            ownerSymbolId: "Lookup#call",
            line: 6,
            boundCallee: { member: "find", receiver: "Config::DEFAULT_ROOTS" },
          }),
        ],
      }),
      RUBY_FINDERS,
    );
    expect(rows.map((r) => [r.name, r.typeName, r.typeSource])).toEqual([
      ["matching_root", undefined, undefined],
      ["@root", undefined, undefined],
      ["fallback", undefined, undefined],
    ]);
  });

  it("publishes no channel return row typed by a value constant", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "Lookup#roots" }), chunk({ symbolId: "Lookup#limit" })],
        structuredReturnTypes: { "Lookup#roots": { form: "instance", name: "APP_ROOTS" } },
        functionReturnTypes: { limit: "MAX_LIMIT" },
      }),
    );
    expect(rows).toEqual([]);
  });

  it("keeps acronym and namespaced acronym types", () => {
    for (const type of ["URI", "IO", "HTTP", "API::V1", "Net::HTTP", "X"]) {
      const rows = buildIdentifierRows(
        extraction({
          chunks: [chunk({ symbolId: "ProcessEvent#call", localBindings: { v: [{ line: 5, type }] } })],
          identifierDeclarations: [decl({ name: "v" })],
        }),
      );
      expect(rows[0], type).toMatchObject({ typeName: type, typeSource: "binding" });
    }
  });
});

// bd tea-rags-mcp-4p3sb.26 — a row keeps whether its type names ONE value or MANY of them.
describe("buildIdentifierRows — type multiplicity", () => {
  it("carries a syntactic many onto the row; a non-collection annotation stays one", () => {
    const rows = buildIdentifierRows(
      extraction({
        language: "typescript",
        chunks: [chunk({ symbolId: "Svc#pick" })],
        identifierDeclarations: [
          decl({
            name: "candidates",
            kind: "param",
            ownerSymbolId: "Svc#pick",
            typeName: "SymbolDefinition",
            typeSource: "annotation",
            typeMultiplicity: "many",
          }),
          decl({
            name: "fallback",
            kind: "param",
            ownerSymbolId: "Svc#pick",
            typeName: "SymbolDefinition",
            typeSource: "annotation",
          }),
        ],
      }),
    );
    expect(rows.map((r) => [r.name, r.typeName, r.typeMultiplicity ?? "one"])).toEqual([
      ["candidates", "SymbolDefinition", "many"],
      ["fallback", "SymbolDefinition", "one"],
    ]);
  });

  it("reads many off a container binding fact, one off a plain binding", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [
          chunk({
            symbolId: "ProcessEvent#call",
            localBindings: {
              posts: [
                { line: 5, type: "Post", typeRef: { form: "container", element: { form: "instance", name: "Post" } } },
              ],
              post: [{ line: 6, type: "Post" }],
            },
          }),
        ],
        identifierDeclarations: [decl({ name: "posts" }), decl({ name: "post", line: 6 })],
      }),
    );
    expect(rows.map((r) => [r.name, r.typeName, r.typeSource, r.typeMultiplicity ?? "one"])).toEqual([
      ["posts", "Post", "binding", "many"],
      ["post", "Post", "binding", "one"],
    ]);
  });

  it("does not let a value-constant type leave a many behind on an untyped row", () => {
    const rows = buildIdentifierRows(
      extraction({
        chunks: [chunk({ symbolId: "ProcessEvent#call" })],
        identifierDeclarations: [
          decl({ name: "roots", typeName: "APP_ROOTS", typeSource: "annotation", typeMultiplicity: "many" }),
        ],
      }),
    );
    expect(rows).toEqual([{ ownerSymbolId: "ProcessEvent#call", kind: "local", name: "roots", line: 5 }]);
  });

  it("Ruby end to end: a relation-returning finder types many, a record finder one", () => {
    const src = [
      "class Post < ApplicationRecord",
      "end",
      "class S",
      "  def call",
      "    posts = Post.where(a: 1)",
      "    post = Post.find(1)",
      "  end",
      "end",
    ].join("\n");
    const parser = new Parser();
    parser.setLanguage(RbLang);
    const rubyExtraction = new RubyLanguage().walker.walk({
      tree: parser.parse(src),
      code: src,
      relPath: "app/services/s.rb",
      language: "ruby",
      chunks: [
        { symbolId: "Post", startLine: 1, endLine: 2, scope: [] },
        { symbolId: "S", startLine: 3, endLine: 8, scope: [] },
        { symbolId: "S#call", startLine: 4, endLine: 7, scope: ["S"] },
      ],
    });
    const locals = buildIdentifierRows(rubyExtraction).filter((r) => r.kind === "local");
    expect(locals.map((r) => [r.name, r.typeName, r.typeMultiplicity ?? "one"])).toEqual([
      ["posts", "Post", "many"],
      ["post", "Post", "one"],
    ]);
  });
});
