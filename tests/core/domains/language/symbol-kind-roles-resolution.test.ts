/**
 * A call resolves against the CALLING language's kind roles (bd
 * tea-rags-mcp-jqvbn, spec §1a).
 *
 * Which declaration kinds a bare call can land on is a property of the
 * language: Ruby never calls a class by its bare name (`Money(x)` is a method),
 * Go calls interfaces and type aliases (`Stringer(x)` is a conversion), Swift
 * calls enums (`Color(rawValue:)`). So a same-named declaration the language
 * cannot call is no second candidate — the bare call still commits to the
 * callable — while a kind the language DOES call stays a call target.
 *
 * Driven through each language's facade resolver, the surface production
 * reads, so a lookup a strategy makes outside the policy shows up here.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../src/core/contracts/types/codegraph.js";
import type { LanguageSymbolResolver } from "../../../../src/core/contracts/types/language.js";
import { BashLanguage } from "../../../../src/core/domains/language/bash/index.js";
import { GoLanguage } from "../../../../src/core/domains/language/go/index.js";
import { JavaLanguage } from "../../../../src/core/domains/language/java/index.js";
import { JavaScriptLanguage } from "../../../../src/core/domains/language/javascript/index.js";
import { PythonLanguage } from "../../../../src/core/domains/language/python/index.js";
import { RubyLanguage } from "../../../../src/core/domains/language/ruby/index.js";
import { RustLanguage } from "../../../../src/core/domains/language/rust/index.js";
import { SwiftLanguage } from "../../../../src/core/domains/language/swift/index.js";
import { TypeScriptLanguage } from "../../../../src/core/domains/language/typescript/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const def = (
  relPath: string,
  symbolId: string,
  scope: string[],
  symbolKind: SymbolDefinitionKind,
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope,
  symbolKind,
});

const bareCall = (member: string, args = "(x)"): CallRef => ({
  callText: `${member}${args}`,
  receiver: null,
  member,
  startLine: 3,
});

const ctx = (callerFile: string, symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable,
});

interface BareCallCase {
  readonly language: string;
  readonly resolver: () => LanguageSymbolResolver;
  readonly callerFile: string;
  /** The callable the bare call must land on: [relPath, symbolId, kind]. */
  readonly callable: readonly [string, string, SymbolDefinitionKind];
  /** Where the same-named declaration lives. */
  readonly namesakeFile: string;
  /** The kinds this language cannot call (its `symbolKindRoles.callee` complement). */
  readonly nonCallable: readonly SymbolDefinitionKind[];
}

const resolverOf = (provider: { resolver?: LanguageSymbolResolver }): LanguageSymbolResolver => {
  if (provider.resolver === undefined) throw new Error("language has no resolver");
  return provider.resolver;
};

const CASES: readonly BareCallCase[] = [
  {
    language: "typescript",
    resolver: () => resolverOf(new TypeScriptLanguage()),
    callerFile: "src/main.ts",
    callable: ["src/walk.ts", "walk", "function"],
    namesakeFile: "src/types.ts",
    nonCallable: ["module", "interface", "enum", "type_alias", "constant"],
  },
  {
    language: "javascript",
    resolver: () => resolverOf(new JavaScriptLanguage()),
    callerFile: "src/main.js",
    callable: ["src/walk.js", "walk", "function"],
    namesakeFile: "src/types.js",
    nonCallable: ["module", "interface", "enum", "type_alias", "constant"],
  },
  {
    language: "java",
    resolver: () => resolverOf(new JavaLanguage()),
    callerFile: "src/Main.java",
    callable: ["src/Walk.java", "walk", "method"],
    namesakeFile: "src/Types.java",
    nonCallable: ["module", "interface", "enum", "type_alias", "constant"],
  },
  {
    language: "swift",
    resolver: () => resolverOf(new SwiftLanguage()),
    callerFile: "Sources/App/Main.swift",
    callable: ["Sources/App/Walk.swift", "walk", "function"],
    namesakeFile: "Sources/App/Types.swift",
    nonCallable: ["module", "interface", "constant"],
  },
  {
    language: "go",
    resolver: () => resolverOf(new GoLanguage()),
    callerFile: "pkg/main.go",
    callable: ["pkg/walk.go", "walk", "function"],
    namesakeFile: "pkg/types.go",
    nonCallable: ["module", "enum", "constant"],
  },
  {
    language: "rust",
    resolver: () => resolverOf(new RustLanguage()),
    callerFile: "src/main.rs",
    callable: ["src/walk.rs", "walk", "function"],
    namesakeFile: "src/types.rs",
    nonCallable: ["module", "interface", "enum", "type_alias", "constant"],
  },
  {
    language: "python",
    resolver: () => resolverOf(new PythonLanguage()),
    callerFile: "pkg/main.py",
    callable: ["pkg/walk.py", "walk", "function"],
    namesakeFile: "pkg/types.py",
    nonCallable: ["module", "interface", "constant"],
  },
  {
    language: "ruby",
    resolver: () => resolverOf(new RubyLanguage()),
    callerFile: "lib/main.rb",
    callable: ["lib/money_helper.rb", "Money", "method"],
    namesakeFile: "lib/money.rb",
    nonCallable: ["class", "module", "interface", "enum", "type_alias", "constant"],
  },
  {
    language: "bash",
    resolver: () => resolverOf(new BashLanguage()),
    callerFile: "bin/main.sh",
    callable: ["bin/walk.sh", "walk", "function"],
    namesakeFile: "bin/types.sh",
    nonCallable: ["class", "module", "interface", "enum", "type_alias", "constant", "method"],
  },
];

const KIND_CASES = CASES.flatMap((c) => c.nonCallable.map((kind) => [c.language, kind, c] as const));

describe("a declaration the calling language cannot call is no bare-call candidate (bd tea-rags-mcp-jqvbn)", () => {
  it.each(KIND_CASES)("%s: a %s namesake leaves the bare call on the callable", (_language, kind, c) => {
    const [callableFile, callableId, callableKind] = c.callable;
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile(callableFile, [def(callableFile, callableId, [], callableKind)]);
    table.upsertFile(c.namesakeFile, [def(c.namesakeFile, callableId, [], kind)]);
    const target = c.resolver().resolve(bareCall(callableId), ctx(c.callerFile, table));
    expect(target).toEqual({ targetRelPath: callableFile, targetSymbolId: callableId });
  });
});

describe("a kind the calling language does call stays a call target (bd tea-rags-mcp-jqvbn)", () => {
  it("ruby: a bare `Money(x)` no longer resolves to `class Money`", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("lib/money.rb", [def("lib/money.rb", "Money", [], "class")]);
    const target = resolverOf(new RubyLanguage()).resolve(bareCall("Money"), ctx("lib/main.rb", table));
    expect(target).toBeNull();
  });

  it("ruby: `Money.new` still resolves to the class file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("lib/money.rb", [def("lib/money.rb", "Money", [], "class")]);
    const target = resolverOf(new RubyLanguage()).resolve(
      { callText: "Money.new(x)", receiver: "Money", member: "new", startLine: 3 },
      ctx("lib/main.rb", table),
    );
    expect(target?.targetRelPath).toBe("lib/money.rb");
  });

  // The walker's constant-REFERENCE shape `{receiver: C, member: C}` — an
  // association's model, a registry value, a CanCanCan subject — names the
  // class itself, which Ruby's receiver row keeps. Measured: huginn's
  // `belongs_to :user` and mastodon's `INDEXES = [InstancesIndex, …]` sites
  // decayed from the class symbol to a file-only edge under the callee row.
  it("ruby: a constant reference `{receiver: Money, member: Money}` still lands on the class symbol", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("lib/money.rb", [def("lib/money.rb", "Money", [], "class")]);
    const target = resolverOf(new RubyLanguage()).resolve(
      { callText: "belongs_to :money", receiver: "Money", member: "Money", startLine: 3 },
      ctx("lib/main.rb", table),
    );
    expect(target).toEqual({ targetRelPath: "lib/money.rb", targetSymbolId: "Money" });
  });

  it("go: a conversion `Stringer(x)` still resolves to the interface", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/types.go", [def("pkg/types.go", "Stringer", [], "interface")]);
    const target = resolverOf(new GoLanguage()).resolve(bareCall("Stringer"), ctx("pkg/main.go", table));
    expect(target).toEqual({ targetRelPath: "pkg/types.go", targetSymbolId: "Stringer" });
  });

  it("swift: `Color(rawValue:)` still resolves to the enum", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Sources/App/Color.swift", [def("Sources/App/Color.swift", "Color", [], "enum")]);
    const target = resolverOf(new SwiftLanguage()).resolve(
      bareCall("Color", "(rawValue: 1)"),
      ctx("Sources/App/Main.swift", table),
    );
    expect(target?.targetRelPath).toBe("Sources/App/Color.swift");
  });
});
