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

describe("tsNameOf — const-bound function expressions (bd tea-rags-mcp-grz07, widened by 29m75)", () => {
  it("names a module-level const arrow so a bare call has something to target", () => {
    // The measured gap: on the taxdome React corpus the checker resolved 179
    // bare calls to a module-level const arrow the symbol table could not name,
    // so no edge could be emitted however good the resolver chain got.
    expect(idsOf("export const genValidationSchema = (msg: string) => msg.trim();\n")).toContain("genValidationSchema");
  });

  it("names a module-level const bound to a function expression", () => {
    expect(idsOf("const legacy = function (value: number) {\n  return value;\n};\n")).toContain("legacy");
  });

  it("names a function-scoped const arrow UNDER its enclosing scope, never bare", () => {
    // bd tea-rags-mcp-29m75 inverts grz07's module-level restriction, and the
    // SCOPED id is what makes that safe. grz07 declined these because a bare
    // `handler` would have handed `globalShortName` the 452 `handleClick` /
    // `renderContent` / `setRef` candidates bd tea-rags-mcp-w7qv4's guard
    // exists to withhold. Composing under the declaring scope keeps the bare
    // name out of the table entirely, so that guard still sees nothing to
    // fabricate from while the same-file and checker-narrowed lookups gain a
    // real target.
    const ids = idsOf("export function render(id: string): void {\n  const handler = () => id;\n  handler();\n}\n");
    expect(ids).toContain("render");
    expect(ids).toContain("render.handler");
    expect(ids).not.toContain("handler");
  });

  it("composes a const arrow declared inside a class method under the `#` method form", () => {
    // The enclosing chain carries the instance separator through, exactly as
    // `Registry#register.handle` already does for a call-argument object
    // member (bd tea-rags-mcp-cv4k1). A `.` here would name a symbol nothing
    // resolves.
    const ids = idsOf(
      "export class Panel {\n  open(): void {\n    const onClose = () => undefined;\n    onClose();\n  }\n}\n",
    );
    expect(ids).toContain("Panel#open");
    expect(ids).toContain("Panel#open.onClose");
    expect(ids).not.toContain("Panel.open.onClose");
  });

  it("scopes the nested closure under its declaring symbol so same-name closures stay distinct", () => {
    // `handleChange` occurs 112 times across the taxdome corpus and `checkGuards`
    // 202 times. The scope entry is what keeps two of them in ONE file
    // distinguishable — and what lets the same-file pass narrow to the one the
    // call site can actually see.
    const src = [
      "export const RowEditor = () => {",
      "  const handleChange = (v: string) => v;",
      "  return handleChange;",
      "};",
      "export const CellEditor = () => {",
      "  const handleChange = (v: string) => v.trim();",
      "  return handleChange;",
      "};",
    ].join("\n");
    const symbols = collect(src);
    const ids = symbols.map((s) => s.symbolId);
    expect(ids).toContain("RowEditor.handleChange");
    expect(ids).toContain("CellEditor.handleChange");
    expect(symbols.find((s) => s.symbolId === "RowEditor.handleChange")?.scope).toEqual(["RowEditor"]);
  });

  it("names a closure a factory returns, which is the cross-file half of the gap", () => {
    // 573 of the 3,944 missed rows call the closure from ANOTHER file — a hook
    // returns it and a component invokes it. Those can only ever be pinned if
    // the declaration carries an id at all.
    const ids = idsOf("export function useThing() {\n  const doIt = (n: number) => n + 1;\n  return { doIt };\n}\n");
    expect(ids).toContain("useThing.doIt");
  });

  it("lets an ANONYMOUS callback contribute no scope segment of its own", () => {
    // Oracle class D (`anonymousCallable`) is explicitly out of scope: the
    // callback itself gets no symbol, so a named closure inside it composes
    // under the nearest NAMED ancestor rather than under an invented one.
    const ids = idsOf(
      "export function mount(): void {\n  effect(() => {\n    const tick = () => 1;\n    tick();\n  });\n}\n",
    );
    expect(ids).toContain("mount.tick");
    expect(ids).not.toContain("tick");
  });

  it("still declines a destructured binding and a call-valued const inside a function body", () => {
    // The oracle's BindingElement class (781 rows on taxdome) and the
    // call-valued bucket stay unnamed — this bead widens the SCOPE the shape
    // gate accepts, never the shape itself.
    const ids = idsOf(
      [
        "export function useRow(): void {",
        "  const { onRemove } = props;",
        "  const t = useTranslation();",
        "  onRemove();",
        "  t();",
        "}",
      ].join("\n"),
    );
    expect(ids).not.toContain("useRow.onRemove");
    expect(ids).not.toContain("useRow.t");
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

/**
 * bd tea-rags-mcp-5ldqu — the CLASS-PROPERTY arrow:
 *
 *   class AdminentrypointPostFetcher { request = async () => {…} }
 *
 * A `public_field_definition`, not a `variable_declarator`, so neither the
 * const-object gate nor the const-bound-function gate reaches it, and bd
 * tea-rags-mcp-29m75 left it explicitly out of scope. The cost was measured:
 * `fetcher.request()` had no `AdminentrypointPostFetcher#request` row to land
 * on, so pass 4 (`localBinding`) could not pin it and the call fell through to a
 * same-named symbol in an unrelated file.
 *
 * The member KIND is what makes this different from every other gate in this
 * file: a field is invoked on an INSTANCE unless `static` says otherwise, so it
 * has to carry `methodKind` and compose `#` / `.` exactly as a
 * `method_definition` does.
 */
describe("tsNameOf — class-property arrows (bd tea-rags-mcp-5ldqu)", () => {
  const FETCHER = [
    "export class AdminentrypointPostFetcher {",
    "  request = async (url: string): Promise<Response> => {",
    "    return fetch(url);",
    "  };",
    "",
    "  static build = (): AdminentrypointPostFetcher => {",
    "    return new AdminentrypointPostFetcher();",
    "  };",
    "}",
  ].join("\n");

  it("composes an instance field arrow with `#`, exactly as it composes a method", () => {
    expect(idsOf(FETCHER)).toContain("AdminentrypointPostFetcher#request");
  });

  it("composes a `static` field arrow with `.`", () => {
    expect(idsOf(FETCHER)).toContain("AdminentrypointPostFetcher.build");
  });

  it("never emits the member as a bare top-level id", () => {
    // A bare `request` is the ambiguous short-name candidate bd
    // tea-rags-mcp-w7qv4's guard exists to withhold from `globalShortName`, and
    // scoping under the declaring class is what keeps it out of the table.
    const ids = idsOf(FETCHER);
    expect(ids).not.toContain("request");
    expect(ids).not.toContain("build");
  });

  it("scopes the member under its class so FQN-narrowing can pin the right one", () => {
    const member = collect(FETCHER).find((s) => s.symbolId === "AdminentrypointPostFetcher#request");
    expect(member?.scope).toEqual(["AdminentrypointPostFetcher"]);
  });

  it("keeps two same-named fields in different classes distinguishable", () => {
    const ids = idsOf(
      [
        "export class PostFetcher {",
        "  request = async (url: string) => fetch(url);",
        "}",
        "export class GetFetcher {",
        "  request = async (url: string) => fetch(url);",
        "}",
      ].join("\n"),
    );
    expect(ids).toContain("PostFetcher#request");
    expect(ids).toContain("GetFetcher#request");
  });

  it("declines the shapes that declare no callable value", () => {
    // A datum, a call's return, and a value-less FUNCTION TYPE. The last is the
    // oracle's `FunctionType` class — a type, not a declaration, and naming it
    // would put a row in cg_symbols with no body behind it.
    const ids = idsOf(
      [
        "export class Config {",
        "  retries = 3;",
        "  translate = useTranslation('ns');",
        "  declare later: () => void;",
        "}",
      ].join("\n"),
    );
    expect(ids).not.toContain("Config#retries");
    expect(ids).not.toContain("Config#translate");
    expect(ids).not.toContain("Config#later");
  });

  it("leaves an ordinary method's id untouched", () => {
    // Regression guard: the new branch must not intercept `method_definition`.
    const ids = idsOf(
      "export class Fetcher {\n  send(url: string) {\n    return url;\n  }\n  static make() {\n    return new Fetcher();\n  }\n}\n",
    );
    expect(ids).toContain("Fetcher#send");
    expect(ids).toContain("Fetcher.make");
  });

  it("composes a closure declared INSIDE the field arrow under the field", () => {
    // Mirrors bd tea-rags-mcp-29m75: the arrow is a container, and what it
    // declares composes beneath it rather than leaking to file level.
    const ids = idsOf(
      [
        "export class Fetcher {",
        "  request = async (url: string) => {",
        "    const parse = (raw: string) => raw.trim();",
        "    return parse(url);",
        "  };",
        "}",
      ].join("\n"),
    );
    expect(ids).toContain("Fetcher#request.parse");
    expect(ids).not.toContain("parse");
  });
});

/**
 * bd tea-rags-mcp-llgrz — the WRAPPER-EXPORTED component:
 *
 *   function CardInner(props) { … }
 *   const refForwarded = forwardRef(CardInner);
 *   export { refForwarded as Card };          // ui-kit: every icon, Checkbox, Modal
 *
 * A `variable_declarator` whose value is a CALL, which every existing gate in
 * this file declines: `constObjectNamespaceName` wants an object literal and
 * `functionValuedDeclaratorName` wants a function expression. So `Card` — the
 * name the tag writes and the importer imports — had no row anywhere, bd
 * tea-rags-mcp-ex28m's tag-name fallback found nothing to pin, and the
 * null-target edge that resulted was dropped at write time by the primary-key
 * constraint on `target_symbol_id`.
 *
 * Two decisions were settled by measurement against
 * `scripts/ts-codegraph-typechecker-oracle.ts` rather than by argument, and the
 * cases below pin both: the EXPORTED name is recorded rather than the local
 * binding, and only a name a JSX tag could reference is recorded at all. What
 * naming the wider populations cost is in `call-valued-export.ts`.
 */
describe("tsNameOf — wrapper-exported components (bd tea-rags-mcp-llgrz)", () => {
  it("names an exported component bound to a wrapper call", () => {
    const ids = idsOf("export const Card = memo(CardBase);\n");
    expect(ids).toContain("Card");
  });

  it("declines a wrapped export no JSX tag could reference", () => {
    // `memoize(fn)` binds a callable, but the checker resolves calls THROUGH it
    // to lodash's own signature, so an in-project edge for it is a fabricated
    // one: naming this population moved taxdome's phantom defects 303 → 664
    // while the JSX population added none (jsx phantom 88 → 88).
    const ids = idsOf("export const getRenderableContent = memoize(renderContent);\n");
    expect(ids).not.toContain("getRenderableContent");
  });

  it("carries the EXPORTED alias — the name importers and JSX tags reference", () => {
    const ids = idsOf(
      [
        "function CardInner(props: { wide: boolean }) {",
        "  return null;",
        "}",
        "const refForwarded = forwardRef(CardInner);",
        "export { refForwarded as Card };",
      ].join("\n"),
    );
    expect(ids).toContain("Card");
  });

  it("leaves the internal wrapper binding unnamed", () => {
    // `refForwarded` is not the module's public name for anything, and putting
    // it in the table is measurably worse than leaving it out: it preempts
    // `TSJsxComponentSymbolResolutionStrategy#pinSymbol`'s tag-name branch,
    // which the taxdome oracle scores as the better of the two answers.
    const ids = idsOf(
      [
        "function CardInner(props: { wide: boolean }) {",
        "  return null;",
        "}",
        "const refForwarded = forwardRef(CardInner);",
        "export { refForwarded as Card };",
      ].join("\n"),
    );
    expect(ids).not.toContain("refForwarded");
  });

  it("declines a call-valued const the file never exports", () => {
    // The precision gate. An internal binding is not the module's public name,
    // and naming every one of them would put a row in the short-name index for
    // each `const parsed = parse(raw)` in the corpus.
    const ids = idsOf("const memoized = memo(Panel);\nfunction Panel() {\n  return null;\n}\n");
    expect(ids).not.toContain("memoized");
  });

  it("does not fabricate a symbol for a name the file only RE-exports", () => {
    // A barrel declares nothing. `export { Card } from "./card.js"` names a
    // symbol whose declaration lives in the other file, and claiming it here is
    // how a barrel becomes a namesake competing with the real declaration.
    const ids = idsOf('export { Card } from "./card.js";\nexport { Icon as Glyph } from "./icon.js";\n');
    expect(ids).not.toContain("Card");
    expect(ids).not.toContain("Glyph");
  });

  it("never emits `default` as a symbol name", () => {
    // `export { x as default }` publishes the module's default binding, not a
    // symbol called `default` — a row under that name would answer for every
    // default-exporting module in the short-name index at once.
    const ids = idsOf("const wrapped = memo(Panel);\nexport { wrapped as default };\n");
    expect(ids).not.toContain("default");
    expect(ids).not.toContain("wrapped");
  });

  it("declines a data constant a member call builds", () => {
    // The measured fabrication class. `UNSUPPORTED_FALLBACK = [...].map(f)` in
    // this repo's own `capability/fallback.ts` is the shape: naming it put
    // `UNSUPPORTED_FALLBACK.map(…)` — whose target is `Array.prototype.map` —
    // on an in-project edge, two fabricated edges on `src` alone.
    expect(idsOf("export const OPTIONS = ITEMS.map((item) => item.id);\n")).not.toContain("OPTIONS");
    expect(idsOf("export const KEYS = Object.keys(SHAPE);\n")).not.toContain("KEYS");
  });

  it("declines a factory call that is handed no callable", () => {
    // `createContext(null)` / `z.object({…})` produce a value the module did not
    // declare, and every call THROUGH such a binding targets the library that
    // made it. On taxdome, naming this population moved phantom defects
    // 303 → 710.
    expect(idsOf("export const Ctx = createContext(null);\n")).not.toContain("Ctx");
    expect(idsOf("export const schema = z.object({ id: 1 });\n")).not.toContain("schema");
  });

  it("leaves what the call CONTAINS composed exactly where it was", () => {
    // The lockstep guard. The chunker composes an object-literal method inside a
    // call argument from its own classifier; if naming the declarator re-scoped
    // that member to `Enhanced.onClick`, the chunker's `onClick` id would have
    // no cg_symbols row and `get_callers` on it would return [].
    const ids = idsOf(
      [
        "export const Enhanced = withHandlers(BaseCard, {",
        "  onClick(event: number) {",
        "    return event;",
        "  },",
        "});",
      ].join("\n"),
    );
    expect(ids).toContain("Enhanced");
    expect(ids).toContain("onClick");
    expect(ids).not.toContain("Enhanced.onClick");
  });

  it("emits one row when the exported alias repeats a name the file already declares", () => {
    // taxdome's `Modal.tsx` shape: the inner component and the export alias are
    // both `Modal`. `collectSymbols` dedups by symbolId, so the declaration's
    // own row wins — what must not happen is two rows racing to answer
    // `lookup("Modal")` with different line ranges.
    const ids = idsOf(
      [
        "function Modal(props: { open: boolean }) {",
        "  return null;",
        "}",
        "const memoized = memo(Modal);",
        "export { memoized as Modal };",
      ].join("\n"),
    );
    expect(ids.filter((id) => id === "Modal")).toHaveLength(1);
  });

  it("names each declarator of a comma list independently", () => {
    const ids = idsOf("export const First = memo(A),\n  Second = memo(B);\n");
    expect(ids).toContain("First");
    expect(ids).toContain("Second");
  });

  it("sees the call through a type assertion", () => {
    const ids = idsOf("export const Card = forwardRef(CardInner) as ComponentType;\n");
    expect(ids).toContain("Card");
  });
});
