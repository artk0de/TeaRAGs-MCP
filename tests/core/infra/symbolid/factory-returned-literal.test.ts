/**
 * Behavioral tests for the factory-returned object literal gate (bd
 * tea-rags-mcp-39xca.19). A method of the literal a NAMED function returns is
 * instance-bound — `classifyMethod` answers `instance`, so both the chunker and
 * the codegraph walker compose `createX#m`. Every other object-literal method
 * keeps the namespace `.` (classification `null`).
 *
 * Mocked SyntaxNode shapes, as in `classify.test.ts` — only the fields the gate
 * consults, with `parent` links wired by {@link tree}.
 */

import { describe, expect, it } from "vitest";

import { classifyMethod } from "../../../../src/core/infra/symbolid/classify.js";
import {
  enclosingFactoryScopeNames,
  isFactoryReturnedLiteral,
} from "../../../../src/core/infra/symbolid/factory-returned-literal.js";

interface MockNode {
  type: string;
  text: string;
  isNamed: boolean;
  children: MockNode[];
  namedChildren: MockNode[];
  parent: MockNode | null;
  fields: Record<string, MockNode>;
  childForFieldName: (name: string) => MockNode | null;
}

/** A node whose `fields` are also its children, parent links wired both ways. */
function tree(type: string, fields: Record<string, MockNode> = {}, extra: MockNode[] = [], text = ""): MockNode {
  const children = [...Object.values(fields), ...extra];
  const self: MockNode = {
    type,
    text,
    isNamed: true,
    children,
    namedChildren: children,
    parent: null,
    fields,
    childForFieldName: (name) => fields[name] ?? null,
  };
  for (const child of children) child.parent = self;
  return self;
}

const ident = (text: string, type = "identifier"): MockNode => tree(type, {}, [], text);

/** `{ m() {} }` — returns the object and its method. */
function literal(): { object: MockNode; method: MockNode } {
  const method = tree("method_definition", { name: ident("m", "property_identifier") });
  return { object: tree("object", {}, [method]), method };
}

describe("isFactoryReturnedLiteral", () => {
  it("accepts the literal a function declaration returns", () => {
    const { object, method } = literal();
    tree("function_declaration", {
      name: ident("createOutcome"),
      body: tree("statement_block", {}, [tree("return_statement", {}, [object])]),
    });
    expect(isFactoryReturnedLiteral(object as never)).toBe(true);
    expect(classifyMethod(method as never)).toBe("instance");
  });

  it("accepts an arrow factory's expression body, seen through parentheses", () => {
    const { object, method } = literal();
    const arrow = tree("arrow_function", { body: tree("parenthesized_expression", {}, [object]) });
    tree("variable_declarator", { name: ident("createCounter"), value: arrow });
    expect(isFactoryReturnedLiteral(object as never)).toBe(true);
    expect(classifyMethod(method as never)).toBe("instance");
  });

  it("accepts a return inside a nested block of a declarator-bound function expression", () => {
    const { object } = literal();
    const ret = tree("return_statement", {}, [tree("as_expression", {}, [object])]);
    const fn = tree("function_expression", { body: tree("statement_block", {}, [tree("if_statement", {}, [ret])]) });
    tree("variable_declarator", { name: ident("make"), value: fn });
    expect(isFactoryReturnedLiteral(object as never)).toBe(true);
  });

  it("declines an anonymous callback's returned literal", () => {
    const { object, method } = literal();
    tree("arguments", {}, [tree("arrow_function", { body: tree("parenthesized_expression", {}, [object]) })]);
    expect(isFactoryReturnedLiteral(object as never)).toBe(false);
    expect(classifyMethod(method as never)).toBeNull();
  });

  it("declines a named local literal — the const-object namespace form", () => {
    const { object, method } = literal();
    tree("variable_declarator", { name: ident("api"), value: object });
    expect(isFactoryReturnedLiteral(object as never)).toBe(false);
    expect(classifyMethod(method as never)).toBeNull();
  });

  it("declines a call-argument literal and a module-level return", () => {
    const argument = literal();
    tree("arguments", {}, [argument.object]);
    expect(isFactoryReturnedLiteral(argument.object as never)).toBe(false);

    const orphan = literal();
    tree("program", {}, [tree("return_statement", {}, [orphan.object])]);
    expect(isFactoryReturnedLiteral(orphan.object as never)).toBe(false);
  });

  it("declines a destructuring-bound arrow and a non-object node", () => {
    const { object } = literal();
    const arrow = tree("arrow_function", { body: object });
    tree("variable_declarator", { name: ident("{ a }", "object_pattern"), value: arrow });
    expect(isFactoryReturnedLiteral(object as never)).toBe(false);
    expect(isFactoryReturnedLiteral(ident("x") as never)).toBe(false);
  });
});

describe("enclosingFactoryScopeNames", () => {
  it("names a declarator-bound factory strictly below the container", () => {
    const { object, method } = literal();
    const arrow = tree("arrow_function", { body: tree("parenthesized_expression", {}, [object]) });
    const declaration = tree("lexical_declaration", {}, [
      tree("variable_declarator", { name: ident("make"), value: arrow }),
    ]);
    expect(enclosingFactoryScopeNames(method as never, declaration as never)).toEqual(["make"]);
    expect(enclosingFactoryScopeNames(method as never, null)).toEqual(["make"]);
  });

  it("adds nothing once the container is the factory or lies below it", () => {
    const { object, method } = literal();
    const arrow = tree("arrow_function", { body: object });
    tree("variable_declarator", { name: ident("make"), value: arrow });
    expect(enclosingFactoryScopeNames(method as never, arrow as never)).toEqual([]);
    expect(enclosingFactoryScopeNames(method as never, object as never)).toEqual([]);
  });

  it("adds nothing for a function-declaration factory — it is its own container", () => {
    const { object, method } = literal();
    tree("function_declaration", {
      name: ident("create"),
      body: tree("statement_block", {}, [tree("return_statement", {}, [object])]),
    });
    expect(enclosingFactoryScopeNames(method as never, null)).toEqual([]);
  });

  it("adds nothing for a non-member, an unbound arrow, or a call-argument literal", () => {
    expect(enclosingFactoryScopeNames(ident("x") as never, null)).toEqual([]);

    const unbound = literal();
    tree("arguments", {}, [tree("arrow_function", { body: unbound.object })]);
    expect(enclosingFactoryScopeNames(unbound.method as never, null)).toEqual([]);

    const argument = literal();
    tree("arguments", {}, [argument.object]);
    expect(enclosingFactoryScopeNames(argument.method as never, null)).toEqual([]);
  });
});
