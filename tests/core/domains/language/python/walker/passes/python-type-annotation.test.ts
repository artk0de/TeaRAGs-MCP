/**
 * The Python annotation → kernel `TypeRef` mapping table (E2 seam 2, bd
 * tea-rags-mcp-mt2q0 / 9fgdi).
 *
 * The table is the specification. Every form the corpora carry gets a row, and
 * the declined rows matter as much as the mapped ones: a site annotated `Any`
 * or `Callable[...]` must produce SILENCE, because a fact there would bind a
 * receiver the call site does not have.
 *
 * A second, smaller describe parses real annotations through
 * `pythonTypeRefFromNode` and asserts it agrees with the text parser on the
 * same input — the two entry points share one rule table and a divergence
 * between them is the bug this file exists to catch.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import type { TypeRef } from "../../../../../../../src/core/contracts/types/language.js";
import {
  pythonBareTypeName,
  pythonNominalReceiverName,
  pythonTypeRefFromNode,
  pythonTypeRefFromText,
} from "../../../../../../../src/core/domains/language/python/walker/passes/python-type-annotation.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

const instance = (name: string): TypeRef => ({ form: "instance", name });

const CASES: [string, TypeRef | undefined][] = [
  ["Foo", instance("Foo")],
  ["pkg.mod.Foo", instance("Foo")],
  ["type[Foo]", { form: "class", name: "Foo" }],
  ["Type[Foo]", { form: "class", name: "Foo" }],
  ["Optional[Foo]", { form: "union", members: [instance("Foo"), { form: "nil" }] }],
  ["Foo | None", { form: "union", members: [instance("Foo"), { form: "nil" }] }],
  ["Foo | Bar", { form: "union", members: [instance("Foo"), instance("Bar")] }],
  ["Union[Foo, Bar]", { form: "union", members: [instance("Foo"), instance("Bar")] }],
  ["list[Foo]", { form: "container", element: instance("Foo") }],
  ["List[Foo]", { form: "container", element: instance("Foo") }],
  ["Sequence[Foo]", { form: "container", element: instance("Foo") }],
  ["set[Foo]", { form: "container", element: instance("Foo") }],
  ["tuple[Foo, ...]", { form: "container", element: instance("Foo") }],
  ["dict[str, Foo]", { form: "container", element: instance("Foo") }],
  ["Mapping[str, Foo]", { form: "container", element: instance("Foo") }],
  ['"Foo"', instance("Foo")],
  ["'pkg.Foo'", instance("Foo")],
  ['Optional["Foo"]', { form: "union", members: [instance("Foo"), { form: "nil" }] }],
  ["ClassVar[Foo]", instance("Foo")],
  ["Annotated[Foo, Depends()]", instance("Foo")],
  ["Awaitable[Foo]", instance("Foo")],
  ["QuerySet[Foo]", instance("QuerySet")],
  // SQLAlchemy's `Mapped[T]` is transparent: the column's VALUE is a T, and a
  // receiver typed `Mapped` names a class no project declares (bd
  // tea-rags-mcp-w205u, E4.2a).
  ["Mapped[Tiers]", instance("Tiers")],
  ["Mapped[EncryptedString | None]", { form: "union", members: [instance("EncryptedString"), { form: "nil" }] }],
  ["Mapped[list[Order]]", { form: "container", element: instance("Order") }],
  ['Mapped["Customer"]', instance("Customer")],
  ["Mapped[dict[str, Address]]", { form: "container", element: instance("Address") }],
  ["Mapped[datetime]", instance("datetime")],
  // The BARE wrapper names no receiver, exactly as bare `Annotated` does.
  ["Mapped", undefined],
  ["None", { form: "nil" }],
  ["Any", undefined],
  ["object", undefined],
  ["Callable[[int], Foo]", undefined],
  ["Literal['a', 'b']", undefined],
  ["", undefined],
];

describe("pythonTypeRefFromText — the mapping table", () => {
  it.each(CASES)("maps %j", (annotation, expected) => {
    expect(pythonTypeRefFromText(annotation)).toEqual(expected);
  });
});

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return materializeTree(parser.parse(src).rootNode, src);
}

/** The `type` node of a module-level `x: <annotation>` assignment. */
function annotationNode(annotation: string): AstNode {
  const src = `x: ${annotation}\n`;
  const node = parse(src).namedChild(0)?.namedChild(0)?.childForFieldName("type");
  if (node === null || node === undefined) throw new Error(`no annotation node for ${annotation}`);
  return node;
}

describe("pythonTypeRefFromNode — agrees with the text parser", () => {
  it.each(CASES.filter(([annotation]) => annotation.length > 0))("reads %j off the subtree", (annotation, expected) => {
    expect(pythonTypeRefFromNode(annotationNode(annotation))).toEqual(expected);
  });

  it("reads a parameter annotation and a return annotation off a real def", () => {
    const root = parse("def f(x: Optional[Foo]) -> pkg.Baz: pass\n");
    const def = root.namedChild(0);
    const param = def?.childForFieldName("parameters")?.namedChild(0);
    const paramType = param?.childForFieldName("type") ?? null;
    const returnType = def?.childForFieldName("return_type") ?? null;
    expect(paramType).not.toBeNull();
    expect(returnType).not.toBeNull();
    expect(pythonTypeRefFromNode(paramType as AstNode)).toEqual({
      form: "union",
      members: [instance("Foo"), { form: "nil" }],
    });
    expect(pythonTypeRefFromNode(returnType as AstNode)).toEqual(instance("Baz"));
  });

  it("resolves `Self` from the class the caller supplies", () => {
    expect(pythonTypeRefFromNode(annotationNode("Self"))).toBeUndefined();
    expect(pythonTypeRefFromNode(annotationNode("Self"), "Svc")).toEqual(instance("Svc"));
  });
});

describe("pythonTypeRefFromText — Self needs the enclosing class", () => {
  it("declines `Self` at module level, where no class name is in scope", () => {
    expect(pythonTypeRefFromText("Self")).toBeUndefined();
  });

  it("resolves `Self` to the class the caller supplies", () => {
    expect(pythonTypeRefFromText("Self", "Svc")).toEqual(instance("Svc"));
  });

  it("resolves `Self` inside a wrapper too", () => {
    expect(pythonTypeRefFromText("Optional[Self]", "Svc")).toEqual({
      form: "union",
      members: [instance("Svc"), { form: "nil" }],
    });
  });
});

describe("pythonBareTypeName", () => {
  it.each([
    ["pkg.mod.Foo", "Foo"],
    ["Foo", "Foo"],
    ["  pkg.Foo  ", "Foo"],
    ["", ""],
  ])("reduces %j to its last segment", (input, expected) => {
    expect(pythonBareTypeName(input)).toBe(expected);
  });
});

describe("pythonNominalReceiverName — the single-arm gate", () => {
  it.each([
    ["Foo", "Foo"],
    ["Optional[Foo]", "Foo"],
    ["Foo | None", "Foo"],
    ["type[Foo]", "Foo"],
    // The collapse the `ivar` channel depends on: polar's
    // `slack_app.py:97 Mapped[EncryptedString | None]` is resolvable only if the
    // wrapper is gone before the single-arm gate runs (bd tea-rags-mcp-w205u).
    ["Mapped[EncryptedString | None]", "EncryptedString"],
  ])("answers for %j — one reachable nominal arm", (annotation, expected) => {
    const ref = pythonTypeRefFromText(annotation);
    expect(ref).toBeDefined();
    expect(pythonNominalReceiverName(ref as TypeRef)).toBe(expected);
  });

  it.each([["list[Foo]"], ["dict[str, Foo]"], ["Foo | Bar"], ["None"]])(
    "declines %j — the bound string would name a receiver the site lacks",
    (annotation) => {
      const ref = pythonTypeRefFromText(annotation);
      expect(ref).toBeDefined();
      expect(pythonNominalReceiverName(ref as TypeRef)).toBeUndefined();
    },
  );
});
