import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { CollectedSymbolRange } from "../../../../../../src/core/contracts/types/language.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { typescriptKernel } from "../../../../../../src/core/domains/language/typescript/kernel.js";
import { tsNameOf } from "../../../../../../src/core/domains/language/typescript/walker/name-of.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const composer = new DefaultSymbolIdComposer();

/**
 * Run the REAL symbol-collection pass over a TypeScript source, exactly as the
 * codegraph provider does: `tsNameOf` + the TypeScript kernel's `scopeSeparator`
 * + the cross-language `SymbolIdComposer`. Asserting on composed symbolIds
 * rather than on `tsNameOf`'s raw return is deliberate — the symbolId and its
 * `scope` are what the resolver and `cg_symbols` actually read, so that is the
 * invariant worth pinning.
 */
function collect(src: string): CollectedSymbolRange[] {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript as unknown as Parser.Language);
  const native = parser.parse(src);
  const root = materializeTree(native.rootNode, src);
  return collectSymbols(
    { rootNode: root },
    tsNameOf,
    typescriptKernel.scopeSeparator ?? ".",
    typescriptKernel.disambiguateOverloads ?? false,
    composer,
  );
}

const idsOf = (src: string): string[] => collect(src).map((s) => s.symbolId);

describe("tsNameOf — const-object namespaces (bd tea-rags-mcp-2jhwk)", () => {
  it("names the namespace itself so the symbol table can be asked where it is declared", () => {
    // The barrel re-export hop (hzsxy) gates on `symbolTable.lookup(receiver)`.
    // Without a symbol for the receiver name there is nothing to hop to, which
    // is why `FileLevelGrouper.group()` used to land on the barrel file.
    const ids = idsOf("export const FileLevelGrouper = {\n  group(a: number) {\n    return a;\n  },\n};\n");
    expect(ids).toContain("FileLevelGrouper");
  });

  it("composes a namespace member as `X.member`, not as a bare top-level `member`", () => {
    const ids = idsOf("export const FileLevelGrouper = {\n  group(a: number) {\n    return a;\n  },\n};\n");
    expect(ids).toContain("FileLevelGrouper.group");
    expect(ids).not.toContain("group");
  });

  it("scopes the member under the namespace so FQN-narrowing can pin the right export", () => {
    // `TSNamedImportSymbolResolutionStrategy` narrows candidates with
    // `def.scope[def.scope.length - 1] === call.receiver` before falling back
    // to short-name, so the scope entry is load-bearing, not cosmetic.
    const symbols = collect("export const CodeChunkGrouper = {\n  groupFile(a: number) {\n    return a;\n  },\n};\n");
    const member = symbols.find((s) => s.symbolId === "CodeChunkGrouper.groupFile");
    expect(member?.scope).toEqual(["CodeChunkGrouper"]);
  });

  it("keeps two same-named members in one file distinguishable by their namespace", () => {
    const ids = idsOf(
      [
        "export const DocChunkGrouper = {",
        "  group(a: number) {",
        "    return a;",
        "  },",
        "};",
        "export const CodeChunkGrouper = {",
        "  group(b: number) {",
        "    return b;",
        "  },",
        "};",
      ].join("\n"),
    );
    expect(ids).toContain("DocChunkGrouper.group");
    expect(ids).toContain("CodeChunkGrouper.group");
  });

  it("uses the namespace separator, never the instance-method `#`", () => {
    // A const-object member is invoked on the object itself (`X.m()`), never on
    // an instance — `.claude/rules/symbolid-convention.md` reserves `#` for
    // instance methods, and `Outer.Nested` is the namespace form.
    const ids = idsOf("export const Registry = {\n  lookup(a: number) {\n    return a;\n  },\n};\n");
    expect(ids).not.toContain("Registry#lookup");
    expect(ids).toContain("Registry.lookup");
  });

  it("sees through an `as const` assertion", () => {
    const ids = idsOf("export const Frozen = {\n  run(a: number) {\n    return a;\n  },\n} as const;\n");
    expect(ids).toContain("Frozen.run");
  });

  it("sees through a `satisfies` assertion", () => {
    const src = [
      "interface Shape {",
      "  run(a: number): number;",
      "}",
      "export const Checked = {",
      "  run(a: number) {",
      "    return a;",
      "  },",
      "} satisfies Shape;",
    ].join("\n");
    expect(idsOf(src)).toContain("Checked.run");
  });

  it("sees through explicit parentheses around the object literal", () => {
    const ids = idsOf("export const Parenthesized = ({\n  run(a: number) {\n    return a;\n  },\n});\n");
    expect(ids).toContain("Parenthesized.run");
  });

  it("names a namespace declared without `export`", () => {
    const ids = idsOf("const Local = {\n  helper(a: number) {\n    return a;\n  },\n};\n");
    expect(ids).toContain("Local.helper");
  });

  it("declines a nested object namespace rather than inventing a one-level id", () => {
    // `Outer.inner.deep()` is a TWO-level namespace: the callable hangs off a
    // `pair`, not off the declarator. Naming `Outer` here would compose
    // `Outer.deep` — an id no call site spells, and worse than the bare `deep`
    // it replaced. The declarator gate therefore requires a `method_definition`
    // DIRECTLY in the object literal, and the nested shape keeps its existing
    // behaviour until `pair`-valued namespaces are handled on their own terms.
    const src = [
      "export const Outer = {",
      "  inner: {",
      "    deep(a: number) {",
      "      return a;",
      "    },",
      "  },",
      "};",
    ].join("\n");
    expect(idsOf(src)).not.toContain("Outer.deep");
  });

  it("ignores a data-only object with no callable member", () => {
    // `const PALETTE = { red: "#f00" }` is data. Naming it would add symbols
    // that nothing can call and pollute short-name lookup.
    const ids = idsOf('export const PALETTE = {\n  red: "#f00",\n  green: "#0f0",\n};\n');
    expect(ids).not.toContain("PALETTE");
  });

  it("ignores a destructuring declarator, which binds no namespace name", () => {
    const ids = idsOf("const { alpha, beta } = require('./other');\n");
    expect(ids).not.toContain("alpha");
    expect(ids).not.toContain("beta");
  });

  it("ignores a declarator with no initializer", () => {
    expect(idsOf("let pending: { run(): void };\n")).toEqual([]);
  });

  it("does not synthesize a constructor for a namespace", () => {
    // `syntheticConstructorIfMissing` belongs to class declarations — a const
    // object is never `new`-ed.
    const ids = idsOf("export const Service = {\n  run(a: number) {\n    return a;\n  },\n};\n");
    expect(ids).not.toContain("Service#constructor");
  });

  it("leaves a function-valued declarator to its existing top-level form", () => {
    // `const foo = () => {}` has no object literal — it must not acquire a
    // NAMESPACE symbol. Since bd tea-rags-mcp-grz07 the declarator is named
    // (as a plain top-level `foo`), but naming it never composes members onto
    // it; that is still the const-object gate's job alone.
    expect(idsOf("export const foo = (a: number) => a;\n")).not.toContain("foo.a");
  });
});

describe("tsNameOf — class and function shapes stay put (bd tea-rags-mcp-2jhwk)", () => {
  it("still composes a class instance method with `#`", () => {
    const ids = idsOf("export class Widget {\n  render(a: number) {\n    return a;\n  }\n}\n");
    expect(ids).toContain("Widget#render");
  });

  it("still composes a class static method with `.`", () => {
    const ids = idsOf("export class Foo {\n  static staticBar(a: number) {\n    return a;\n  }\n}\n");
    expect(ids).toContain("Foo.staticBar");
  });

  it("still synthesizes an implicit class constructor", () => {
    expect(idsOf("export class Bare {\n  run(a: number) {\n    return a;\n  }\n}\n")).toContain("Bare#constructor");
  });

  it("still names a top-level function", () => {
    expect(idsOf("export function helper(a: number) {\n  return a;\n}\n")).toContain("helper");
  });
});

describe("tsNameOf — module-level const-bound function expressions (bd tea-rags-mcp-grz07)", () => {
  it("names a module-level const arrow so a bare call has something to target", () => {
    // The measured gap: on the taxdome React corpus the checker resolved 179
    // bare calls to a module-level const arrow the symbol table could not name,
    // so no edge could be emitted however good the resolver chain got.
    expect(idsOf("export const genValidationSchema = (msg: string) => msg.trim();\n")).toContain("genValidationSchema");
  });

  it("names a module-level const bound to a function expression", () => {
    expect(idsOf("const legacy = function (value: number) {\n  return value;\n};\n")).toContain("legacy");
  });

  it("does NOT name a function-scoped const arrow", () => {
    // bd tea-rags-mcp-w7qv4's guard declines a bare call on a function-scoped
    // const by inspecting the DECLARATION's scope. Naming these would fill the
    // symbol table with exactly the candidates it exists to keep away from
    // `globalShortName` — 452 of them on the measured corpus, named
    // `handleClick` / `renderContent` / `setRef` in hundreds of files apiece.
    const ids = idsOf("export function render(id: string): void {\n  const handler = () => id;\n  handler();\n}\n");
    expect(ids).toContain("render");
    expect(ids).not.toContain("render.handler");
    expect(ids).not.toContain("handler");
  });

  it("does NOT name a const arrow declared inside a class method", () => {
    const ids = idsOf(
      "export class Panel {\n  open(): void {\n    const onClose = () => undefined;\n    onClose();\n  }\n}\n",
    );
    expect(ids).toContain("Panel#open");
    expect(ids).not.toContain("Panel#open.onClose");
  });

  it("composes a nested declaration under the named arrow, like a function declaration", () => {
    // `function outer() { function inner() {} }` already composes `outer.inner`;
    // a named const arrow is the same kind of container and behaves the same.
    const ids = idsOf(
      "export const outer = () => {\n  function inner(a: number) {\n    return a;\n  }\n  return inner;\n};\n",
    );
    expect(ids).toContain("outer");
    expect(ids).toContain("outer.inner");
  });

  it("still declines a data-only const and a const bound to a call", () => {
    expect(idsOf("export const PALETTE = { red: '#f00' };\n")).not.toContain("PALETTE");
    expect(idsOf("export const t = useTranslation();\n")).not.toContain("t");
  });
});
