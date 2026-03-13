import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import { createHookContext } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/types.js";
import { typescriptCommentCaptureHook } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/typescript/comment-capture.js";

// --- helpers ---

let tsLang: unknown;

beforeAll(async () => {
  const tsModule = await import("tree-sitter-typescript");
  tsLang = (tsModule.default as any)?.typescript ?? (tsModule as any).typescript;
});

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLang as any);
  return parser.parse(code);
}

function findNodesByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  if (node.type === type) results.push(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    results.push(...findNodesByType(node.namedChild(i)!, type));
  }
  return results;
}

function buildContext(code: string) {
  const tree = parse(code);
  const classDecl = findNodesByType(tree.rootNode, "class_declaration")[0];
  const methods = findNodesByType(classDecl, "method_definition");
  return createHookContext(classDecl, methods, code, { maxChunkSize: 2000 });
}

// --- tests ---

describe("typescriptCommentCaptureHook", () => {
  it("should capture a single-line // comment before a method", () => {
    const code = ["class Foo {", "  // greet the user", "  greet() {", "    return 'hi';", "  }", "}"].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // Row 1 (0-based) is the comment line
    expect(ctx.excludedRows.has(1)).toBe(true);
    expect(ctx.excludedRows.size).toBe(1);

    // Method index 0 should have the prefix
    expect(ctx.methodPrefixes.get(0)).toBe("// greet the user");

    // Start line is 1-based → row 1 + 1 = 2
    expect(ctx.methodStartLines.get(0)).toBe(2);
  });

  it("should capture a multi-line /** JSDoc */ comment before a method", () => {
    const code = [
      "class Foo {",
      "  /**",
      "   * Does something important.",
      "   * @returns number",
      "   */",
      "  compute() {",
      "    return 42;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // JSDoc spans rows 1-4 (0-based), but it's a single comment node
    expect(ctx.excludedRows.has(1)).toBe(true);
    expect(ctx.excludedRows.has(2)).toBe(true);
    expect(ctx.excludedRows.has(3)).toBe(true);
    expect(ctx.excludedRows.has(4)).toBe(true);
    expect(ctx.excludedRows.size).toBe(4);

    expect(ctx.methodPrefixes.get(0)).toBe("/**\n   * Does something important.\n   * @returns number\n   */");
    expect(ctx.methodStartLines.get(0)).toBe(2); // 1-based line of JSDoc start
  });

  it("should capture a chain of // comments before a method", () => {
    const code = [
      "class Foo {",
      "  // first line",
      "  // second line",
      "  // third line",
      "  doWork() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // Rows 1, 2, 3 are comments
    expect(ctx.excludedRows.has(1)).toBe(true);
    expect(ctx.excludedRows.has(2)).toBe(true);
    expect(ctx.excludedRows.has(3)).toBe(true);
    expect(ctx.excludedRows.size).toBe(3);

    // Prefix should be in source order (top to bottom)
    expect(ctx.methodPrefixes.get(0)).toBe("// first line\n// second line\n// third line");

    // Start line is 1-based row of first comment
    expect(ctx.methodStartLines.get(0)).toBe(2);
  });

  it("should NOT capture a comment before a property (not a method)", () => {
    const code = [
      "class Foo {",
      "  // this is a property comment",
      "  name: string;",
      "",
      "  greet() {",
      "    return 'hi';",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // The comment before `name` should NOT be captured (it's before a property, not a method)
    // The method `greet` has no comment before it (previous sibling is public_field_definition)
    expect(ctx.excludedRows.size).toBe(0);
    expect(ctx.methodPrefixes.size).toBe(0);
    expect(ctx.methodStartLines.size).toBe(0);
  });

  it("should not capture anything when no comment precedes a method", () => {
    const code = [
      "class Foo {",
      "  doWork() {",
      "    return 1;",
      "  }",
      "",
      "  doMore() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    expect(ctx.excludedRows.size).toBe(0);
    expect(ctx.methodPrefixes.size).toBe(0);
    expect(ctx.methodStartLines.size).toBe(0);
  });

  it("should capture comments for multiple methods independently", () => {
    const code = [
      "class Foo {",
      "  // comment for first",
      "  first() {",
      "    return 1;",
      "  }",
      "",
      "  /** comment for second */",
      "  second() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // Two methods, each with a comment
    expect(ctx.methodPrefixes.size).toBe(2);

    // First method (index 0)
    expect(ctx.excludedRows.has(1)).toBe(true);
    expect(ctx.methodPrefixes.get(0)).toBe("// comment for first");
    expect(ctx.methodStartLines.get(0)).toBe(2);

    // Second method (index 1)
    expect(ctx.excludedRows.has(6)).toBe(true);
    expect(ctx.methodPrefixes.get(1)).toBe("/** comment for second */");
    expect(ctx.methodStartLines.get(1)).toBe(7);
  });

  it("should handle a mix: one method with comment, one without", () => {
    const code = [
      "class Foo {",
      "  // documented method",
      "  documented() {",
      "    return 1;",
      "  }",
      "",
      "  undocumented() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptCommentCaptureHook.process(ctx);

    // Only the first method has a comment
    expect(ctx.methodPrefixes.size).toBe(1);
    expect(ctx.methodPrefixes.has(0)).toBe(true);
    expect(ctx.methodPrefixes.has(1)).toBe(false);
    expect(ctx.excludedRows.size).toBe(1);
    expect(ctx.excludedRows.has(1)).toBe(true);
  });

  it("should handle hook name correctly", () => {
    expect(typescriptCommentCaptureHook.name).toBe("typescriptCommentCapture");
  });
});
