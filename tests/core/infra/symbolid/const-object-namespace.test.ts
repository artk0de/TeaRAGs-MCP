/**
 * Behavioral tests for the const-object namespace oracle (bd tea-rags-mcp-62hzr).
 *
 * `export const X = { m() {} }` is a static-only-class stand-in whose members are
 * invoked as `X.m()`. Two sides must answer "who declares this method?"
 * identically or they drift: the codegraph walker names the declarator so
 * `cg_symbols.symbol_id` holds `X.m` (bd tea-rags-mcp-2jhwk), and the chunker
 * writes the SAME id into the Qdrant payload `symbolId`. When only the walker
 * knew the shape, `get_callers` on an id copied out of a search hit returned [].
 *
 * The test mocks SyntaxNode shapes rather than importing real grammars —
 * importing them in a unit test crashes the worker pool (same reasoning as
 * `classify.test.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  constObjectNamespaceName,
  constObjectNamespaceOwner,
} from "../../../../src/core/infra/symbolid/const-object-namespace.js";

/**
 * Build a minimal SyntaxNode-like object — only the fields the module consults:
 * `type`, `text`, `children`, `namedChildren`, `parent`, `childForFieldName`.
 */
interface MockNode {
  type: string;
  text?: string;
  children?: MockNode[];
  namedChildren?: MockNode[];
  parent?: MockNode | null;
  childForFieldName?: (name: string) => MockNode | null;
}

function node(spec: MockNode): MockNode {
  return {
    text: "",
    children: [],
    namedChildren: [],
    parent: null,
    childForFieldName: () => null,
    ...spec,
  };
}

/** `const <name> = <value>` as a declarator whose fields resolve by name. */
function declarator(name: MockNode | null, value: MockNode | null): MockNode {
  return node({
    type: "variable_declarator",
    childForFieldName: (field) => (field === "name" ? name : field === "value" ? value : null),
  });
}

function methodDefinition(): MockNode {
  return node({ type: "method_definition" });
}

/** An object literal wrapping the given members, parented to each of them. */
function objectLiteral(members: MockNode[]): MockNode {
  const object = node({ type: "object", children: members });
  for (const member of members) member.parent = object;
  return object;
}

describe("constObjectNamespaceName", () => {
  it("names a declarator whose value is an object literal carrying a method", () => {
    const d = declarator(node({ type: "identifier", text: "FileLevelGrouper" }), objectLiteral([methodDefinition()]));
    expect(constObjectNamespaceName(d as never)).toBe("FileLevelGrouper");
  });

  it("declines a data-only object — it declares nothing callable", () => {
    // `const PALETTE = { red: "#f00" }`: naming it would add symbols that no
    // call site can ever target.
    const d = declarator(
      node({ type: "identifier", text: "PALETTE" }),
      objectLiteral([node({ type: "pair", text: 'red: "#f00"' })]),
    );
    expect(constObjectNamespaceName(d as never)).toBeNull();
  });

  it("declines a destructuring pattern, which names no namespace", () => {
    // `const { a, b } = …` binds an `object_pattern`, not an identifier.
    const d = declarator(node({ type: "object_pattern" }), objectLiteral([methodDefinition()]));
    expect(constObjectNamespaceName(d as never)).toBeNull();
  });

  it("declines a declarator with no value and a non-object value", () => {
    const nameNode = node({ type: "identifier", text: "handler" });
    expect(constObjectNamespaceName(declarator(nameNode, null) as never)).toBeNull();
    expect(constObjectNamespaceName(declarator(nameNode, node({ type: "arrow_function" })) as never)).toBeNull();
  });

  it("declines any node that is not a declarator", () => {
    expect(constObjectNamespaceName(node({ type: "class_declaration" }) as never)).toBeNull();
  });

  it("sees through `as const`, `satisfies` and parentheses to the object", () => {
    for (const wrapper of ["as_expression", "satisfies_expression", "parenthesized_expression"]) {
      const object = objectLiteral([methodDefinition()]);
      const wrapped = node({ type: wrapper, namedChildren: [object] });
      const d = declarator(node({ type: "identifier", text: "Registry" }), wrapped);
      expect(constObjectNamespaceName(d as never), `${wrapper} not unwrapped`).toBe("Registry");
    }
  });

  it("stops unwrapping a wrapper that has no inner expression", () => {
    // Defensive: a degraded parse can leave `as_expression` with no named
    // child. The walk must terminate rather than spin.
    const d = declarator(node({ type: "identifier", text: "Broken" }), node({ type: "as_expression" }));
    expect(constObjectNamespaceName(d as never)).toBeNull();
  });

  it("stops unwrapping when a wrapper's inner expression is itself", () => {
    const selfReferential: MockNode = node({ type: "as_expression" });
    selfReferential.namedChildren = [selfReferential];
    const d = declarator(node({ type: "identifier", text: "Cyclic" }), selfReferential);
    expect(constObjectNamespaceName(d as never)).toBeNull();
  });
});

describe("constObjectNamespaceOwner", () => {
  it("returns the namespace that declares a direct object-literal member", () => {
    const method = methodDefinition();
    const object = objectLiteral([method]);
    const d = declarator(node({ type: "identifier", text: "FileLevelGrouper" }), object);
    object.parent = d;
    expect(constObjectNamespaceOwner(method as never)).toBe("FileLevelGrouper");
  });

  it("looks through a wrapped value to reach the declarator", () => {
    const method = methodDefinition();
    const object = objectLiteral([method]);
    const wrapped = node({ type: "as_expression", namedChildren: [object] });
    const d = declarator(node({ type: "identifier", text: "Registry" }), wrapped);
    object.parent = wrapped;
    wrapped.parent = d;
    expect(constObjectNamespaceOwner(method as never)).toBe("Registry");
  });

  it("declines a class method — it binds an instance, so `#` applies instead", () => {
    const method = methodDefinition();
    method.parent = node({ type: "class_body" });
    expect(constObjectNamespaceOwner(method as never)).toBeNull();
  });

  it("declines a node that is not a method definition", () => {
    expect(constObjectNamespaceOwner(node({ type: "function_declaration" }) as never)).toBeNull();
  });

  it("declines a method whose object literal is not assigned to anything", () => {
    // An object literal passed inline as an argument has no declarator above it.
    const method = methodDefinition();
    objectLiteral([method]);
    expect(constObjectNamespaceOwner(method as never)).toBeNull();
  });

  it("declines a NESTED object literal, matching the walker", () => {
    // `const outer = { inner: { deep() {} } }` — naming `outer` would claim a
    // member it does not own, so both sides decline and `deep` stays bare.
    const method = methodDefinition();
    const innerObject = objectLiteral([method]);
    const pair = node({ type: "pair", children: [innerObject] });
    innerObject.parent = pair;
    const outerObject = objectLiteral([pair]);
    const d = declarator(node({ type: "identifier", text: "outer" }), outerObject);
    outerObject.parent = d;
    expect(constObjectNamespaceOwner(method as never)).toBeNull();
  });
});
