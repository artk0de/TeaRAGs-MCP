/**
 * Behavioral tests for the symbolId classification helper —
 * `classifyMethod` is the cross-language oracle that the chunker
 * (Qdrant `symbolId`) and the codegraph provider (`cg_symbols.symbol_id`)
 * BOTH consult to agree on the `#` vs `.` separator. Drift between the
 * two sides means `get_callers`/`get_callees` silently return empty.
 *
 * The test mocks `tree-sitter` SyntaxNode shapes per-language because
 * importing real grammars in the unit test crashes the worker pool.
 */

import { describe, expect, it } from "vitest";

import { classifyMethod, isStaticMethodNode } from "../../../../src/core/infra/symbolid/classify.js";

/**
 * Build a minimal SyntaxNode-like object — only the fields classify.ts
 * consults: `type`, `text`, `children`, `parent`, `childForFieldName`.
 */
interface MockNode {
  type: string;
  text?: string;
  children?: MockNode[];
  parent?: MockNode | null;
  childForFieldName?: (name: string) => MockNode | null;
}

function node(spec: MockNode): MockNode {
  return {
    text: "",
    children: [],
    parent: null,
    childForFieldName: () => null,
    ...spec,
  };
}

describe("classifyMethod — TypeScript / JavaScript `method_definition`", () => {
  it("treats method_definition without `static` keyword as instance", () => {
    const n = node({ type: "method_definition", children: [node({ type: "property_identifier", text: "foo" })] });
    expect(classifyMethod(n as never)).toBe("instance");
    expect(isStaticMethodNode(n as never)).toBe(false);
  });

  it("treats method_definition with `static` keyword child as static", () => {
    const n = node({
      type: "method_definition",
      children: [node({ type: "static", text: "static" }), node({ type: "property_identifier", text: "make" })],
    });
    expect(classifyMethod(n as never)).toBe("static");
    expect(isStaticMethodNode(n as never)).toBe(true);
  });

  it("matches the keyword via child.text fallback when child.type differs", () => {
    // Some grammar versions tag the static keyword node differently —
    // text === "static" still flips to static. Covers the `||` branch.
    const n = node({
      type: "method_definition",
      children: [node({ type: "keyword", text: "static" })],
    });
    expect(classifyMethod(n as never)).toBe("static");
  });
});

describe("classifyMethod — Java `method_declaration` + `constructor_declaration`", () => {
  it("treats method_declaration without modifiers as instance", () => {
    const n = node({ type: "method_declaration", children: [] });
    expect(classifyMethod(n as never)).toBe("instance");
  });

  it("treats method_declaration with `static` in modifiers child as static", () => {
    const n = node({
      type: "method_declaration",
      children: [
        node({
          type: "modifiers",
          children: [node({ type: "static", text: "static" })],
        }),
      ],
    });
    expect(classifyMethod(n as never)).toBe("static");
  });

  it("matches Java static modifier via text fallback", () => {
    const n = node({
      type: "method_declaration",
      children: [
        node({
          type: "modifiers",
          children: [node({ type: "modifier", text: "static" })],
        }),
      ],
    });
    expect(classifyMethod(n as never)).toBe("static");
  });

  it("returns instance when modifiers exist but no `static` keyword", () => {
    const n = node({
      type: "method_declaration",
      children: [
        node({
          type: "modifiers",
          children: [node({ type: "public", text: "public" })],
        }),
      ],
    });
    expect(classifyMethod(n as never)).toBe("instance");
  });

  it("treats constructor_declaration as instance (initializes an instance)", () => {
    const n = node({ type: "constructor_declaration", children: [] });
    expect(classifyMethod(n as never)).toBe("instance");
  });
});

describe("classifyMethod — Ruby `method` vs `singleton_method`", () => {
  it("treats `method` as instance", () => {
    expect(classifyMethod(node({ type: "method" }) as never)).toBe("instance");
  });

  it("treats `singleton_method` (def self.foo) as static", () => {
    expect(classifyMethod(node({ type: "singleton_method" }) as never)).toBe("static");
  });
});

describe("classifyMethod — Python `function_definition` decorator detection", () => {
  it("returns instance when not nested under decorated_definition", () => {
    const n = node({ type: "function_definition", parent: null });
    expect(classifyMethod(n as never)).toBe("instance");
  });

  it("returns instance when parent is decorated_definition but no decorators match", () => {
    const parent = node({
      type: "decorated_definition",
      children: [node({ type: "decorator", text: "@property" }), node({ type: "decorator", text: "@cached_property" })],
    });
    const fn = node({ type: "function_definition", parent });
    expect(classifyMethod(fn as never)).toBe("instance");
  });

  it("returns static when @classmethod decorator is present", () => {
    const parent = node({
      type: "decorated_definition",
      children: [node({ type: "decorator", text: "@classmethod" })],
    });
    const fn = node({ type: "function_definition", parent });
    expect(classifyMethod(fn as never)).toBe("static");
  });

  it("returns static when @staticmethod decorator is present", () => {
    const parent = node({
      type: "decorated_definition",
      children: [node({ type: "decorator", text: "@staticmethod" })],
    });
    const fn = node({ type: "function_definition", parent });
    expect(classifyMethod(fn as never)).toBe("static");
  });

  it("ignores non-decorator children in decorated_definition", () => {
    // The function_definition itself is a child of decorated_definition;
    // it must be filtered by `child.type !== "decorator"`.
    const parent = node({
      type: "decorated_definition",
      children: [
        node({ type: "comment", text: "# @classmethod" }), // decoy text — wrong type
        node({ type: "decorator", text: "@classmethod" }),
      ],
    });
    const fn = node({ type: "function_definition", parent });
    expect(classifyMethod(fn as never)).toBe("static");
  });
});

describe("classifyMethod — Rust `function_item` self-parameter detection", () => {
  function rustFn(params: MockNode | null): MockNode {
    return node({
      type: "function_item",
      childForFieldName: (name: string) => (name === "parameters" ? params : null),
    });
  }

  it("returns static when no parameters field is present (associated fn)", () => {
    expect(classifyMethod(rustFn(null) as never)).toBe("static");
  });

  it("returns static when parameters has no self_parameter", () => {
    const params = node({
      type: "parameters",
      children: [
        node({
          type: "parameter",
          childForFieldName: (name: string) => (name === "pattern" ? node({ type: "identifier", text: "x" }) : null),
        }),
      ],
    });
    expect(classifyMethod(rustFn(params) as never)).toBe("static");
  });

  it("returns instance when parameters contain self_parameter node", () => {
    const params = node({
      type: "parameters",
      children: [node({ type: "self_parameter", text: "&self" })],
    });
    expect(classifyMethod(rustFn(params) as never)).toBe("instance");
  });

  it("returns instance when a `parameter` child has pattern text === 'self'", () => {
    // Some Rust grammars represent `self` as parameter+identifier rather
    // than a dedicated `self_parameter` node. Covers the fallback.
    const selfParam = node({
      type: "parameter",
      childForFieldName: (name: string) => (name === "pattern" ? node({ type: "identifier", text: "self" }) : null),
    });
    const params = node({ type: "parameters", children: [selfParam] });
    expect(classifyMethod(rustFn(params) as never)).toBe("instance");
  });

  it("returns static when parameter pattern field is missing", () => {
    const param = node({
      type: "parameter",
      childForFieldName: () => null,
    });
    const params = node({ type: "parameters", children: [param] });
    expect(classifyMethod(rustFn(params) as never)).toBe("static");
  });
});

describe("classifyMethod — Go and unknown nodes", () => {
  it("treats method_declaration_go as instance (receivers always present)", () => {
    expect(classifyMethod(node({ type: "method_declaration_go" }) as never)).toBe("instance");
  });

  it("returns null for unknown node types (caller falls back to scope separator)", () => {
    expect(classifyMethod(node({ type: "class_declaration" }) as never)).toBeNull();
    expect(classifyMethod(node({ type: "function_declaration" }) as never)).toBeNull();
    expect(classifyMethod(node({ type: "program" }) as never)).toBeNull();
  });

  it("isStaticMethodNode returns false for non-method nodes", () => {
    expect(isStaticMethodNode(node({ type: "program" }) as never)).toBe(false);
  });
});
