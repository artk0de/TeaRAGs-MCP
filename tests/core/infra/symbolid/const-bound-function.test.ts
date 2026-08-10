/**
 * The shared MODULE-LEVEL const-bound-function gate (bd tea-rags-mcp-grz07).
 *
 * Same reason `const-object-namespace.test.ts` exists next door: two producers
 * ask this question about the same physical AST node — the codegraph walker
 * (`tsNameOf`) and the chunker's TypeScript declaration filter — and a drift
 * between them is a silent ghost row. The gate is tested directly so both
 * callers are pinned by one set of examples.
 */

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../src/core/contracts/types/ast.js";
import { materializeTree } from "../../../../src/core/infra/materialize.js";
import {
  isFunctionValuedExpression,
  moduleLevelFunctionDeclaratorName,
} from "../../../../src/core/infra/symbolid/const-bound-function.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript as unknown as Parser.Language);
  return materializeTree(parser.parse(src).rootNode, src);
}

/** Every node of `type`, in source order. */
function nodesOfType(root: AstNode, type: string): AstNode[] {
  const out: AstNode[] = [];
  const walk = (n: AstNode): void => {
    if (n.type === type) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return out;
}

/** The names the gate accepts across every declarator in `src`. */
function acceptedNames(src: string): string[] {
  return nodesOfType(parse(src), "variable_declarator")
    .map((d) => moduleLevelFunctionDeclaratorName(d))
    .filter((name): name is string => name !== null);
}

describe("moduleLevelFunctionDeclaratorName — accepts (bd tea-rags-mcp-grz07)", () => {
  it("names a module-level const bound to an arrow function", () => {
    expect(acceptedNames("export const genValidationSchema = (msg: string) => msg.trim();\n")).toEqual([
      "genValidationSchema",
    ]);
  });

  it("names a module-level const bound to a function expression", () => {
    expect(acceptedNames("const legacy = function (value: number) {\n  return value;\n};\n")).toEqual(["legacy"]);
  });

  it("names a module-level const bound to a generator function", () => {
    expect(acceptedNames("export const walk = function* () {\n  yield 1;\n};\n")).toEqual(["walk"]);
  });

  it("names an async arrow — `async` is a modifier on the same node type", () => {
    expect(acceptedNames("export const load = async (id: string) => id;\n")).toEqual(["load"]);
  });

  it("names `let` and `var` bindings too — the gate reads the VALUE, not the keyword", () => {
    // Consistent with the const-object namespace sibling, which likewise does
    // not inspect the declaration keyword. A reassignable module-level binding
    // is still the file's declaration of that name.
    expect(acceptedNames("let mutableHandler = () => 1;\nvar legacyHandler = () => 2;\n")).toEqual([
      "mutableHandler",
      "legacyHandler",
    ]);
  });

  it("names every declarator in a comma list independently", () => {
    expect(acceptedNames("const first = () => 1,\n  second = function () {\n    return 2;\n  };\n")).toEqual([
      "first",
      "second",
    ]);
  });

  it("names a const arrow inside a namespace block — not a function scope", () => {
    // Mirrors the resolver-side guard (bd tea-rags-mcp-w7qv4), which walks to
    // the file looking for a FUNCTION-like ancestor and treats a namespace
    // block as transparent. The two must agree or the walker would name what
    // the resolver declines.
    expect(acceptedNames("namespace Api {\n  export const send = (body: string) => body;\n}\n")).toEqual(["send"]);
  });
});

describe("moduleLevelFunctionDeclaratorName — declines (bd tea-rags-mcp-grz07)", () => {
  it("declines a const arrow declared inside a function body", () => {
    // THE load-bearing boundary. `tea-rags-mcp-w7qv4`'s resolver guard declines
    // a bare call whose callee is a function-scoped const, and it does so on the
    // DECLARATION's scope. Naming these would hand `globalShortName` exactly the
    // candidates that guard exists to keep it away from.
    expect(
      acceptedNames("export function render(id: string): void {\n  const handler = () => id;\n  handler();\n}\n"),
    ).toEqual([]);
  });

  it("declines a const arrow declared inside a class method body", () => {
    expect(
      acceptedNames(
        "export class Panel {\n  open(): void {\n    const onClose = () => undefined;\n    onClose();\n  }\n}\n",
      ),
    ).toEqual([]);
  });

  it("declines a const arrow nested inside another const arrow", () => {
    expect(acceptedNames("export const outer = () => {\n  const inner = () => 1;\n  return inner();\n};\n")).toEqual([
      "outer",
    ]);
  });

  it("declines a const arrow inside an arrow passed as a callback", () => {
    expect(acceptedNames("register(() => {\n  const cb = () => 1;\n  return cb;\n});\n")).toEqual([]);
  });

  it("declines a data-only object — the const-object namespace gate owns that shape", () => {
    expect(acceptedNames("export const PALETTE = { red: '#f00' };\n")).toEqual([]);
  });

  it("declines a const-object namespace — its members are named by their own gate", () => {
    expect(acceptedNames("export const Grouper = {\n  group(a: number) {\n    return a;\n  },\n};\n")).toEqual([]);
  });

  it("declines a const bound to a CALL result, however function-like it reads", () => {
    // `const t = useTranslation()` is the dominant React shape and the single
    // largest bucket of unpinnable bare-call targets. The value is a call, not a
    // function expression, so nothing here declares `t`.
    expect(acceptedNames("export const t = useTranslation();\n")).toEqual([]);
  });

  it("declines a destructuring pattern — it binds no single name", () => {
    expect(acceptedNames("export const { format, parse } = helpers;\nconst [first] = handlers;\n")).toEqual([]);
  });

  it("declines a const with no initializer", () => {
    expect(acceptedNames("declare const configure: () => void;\n")).toEqual([]);
  });

  it("declines a non-declarator node", () => {
    const root = parse("export function plain(): void {}\n");
    expect(moduleLevelFunctionDeclaratorName(root)).toBeNull();
    expect(moduleLevelFunctionDeclaratorName(nodesOfType(root, "function_declaration")[0])).toBeNull();
  });
});

describe("isFunctionValuedExpression (bd tea-rags-mcp-grz07)", () => {
  it("accepts the three syntactic function-value shapes", () => {
    const root = parse(
      "const a = () => 1;\nconst b = function () {\n  return 2;\n};\nconst c = function* () {\n  yield 3;\n};\n",
    );
    const values = nodesOfType(root, "variable_declarator").map((d) => d.childForFieldName("value"));
    expect(values.map((v) => v !== null && isFunctionValuedExpression(v))).toEqual([true, true, true]);
  });

  it("rejects a call, an object literal and a literal", () => {
    const root = parse("const a = useThing();\nconst b = { m() {} };\nconst c = 42;\n");
    const values = nodesOfType(root, "variable_declarator").map((d) => d.childForFieldName("value"));
    expect(values.map((v) => v !== null && isFunctionValuedExpression(v))).toEqual([false, false, false]);
  });
});
