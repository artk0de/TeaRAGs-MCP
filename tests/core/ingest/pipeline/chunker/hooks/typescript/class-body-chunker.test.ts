import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import { createHookContext } from "../../../../../../../src/core/ingest/pipeline/chunker/hooks/types.js";
import { typescriptBodyChunkingHook } from "../../../../../../../src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.js";

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
  if (!node) return results;
  if (node.type === type) results.push(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) results.push(...findNodesByType(child, type));
  }
  return results;
}

/** Find a class declaration node (handles both class_declaration and abstract_class_declaration) */
function findClassDecl(root: Parser.SyntaxNode): Parser.SyntaxNode {
  const regular = findNodesByType(root, "class_declaration");
  if (regular.length > 0) return regular[0];
  const abstract = findNodesByType(root, "abstract_class_declaration");
  if (abstract.length > 0) return abstract[0];
  throw new Error("No class declaration found in AST");
}

function buildContext(code: string, opts?: { maxChunkSize?: number; excludedRows?: Set<number> }) {
  const tree = parse(code);
  const classDecl = findClassDecl(tree.rootNode);
  const methods = findNodesByType(classDecl, "method_definition");
  const ctx = createHookContext(classDecl, methods, code, {
    maxChunkSize: opts?.maxChunkSize ?? 4000,
  });
  if (opts?.excludedRows) {
    ctx.excludedRows = opts.excludedRows;
  }
  return ctx;
}

// --- tests ---

describe("typescriptBodyChunkingHook", () => {
  it("should have the correct hook name", () => {
    expect(typescriptBodyChunkingHook.name).toBe("typescriptBodyChunking");
  });

  it("should group regular properties into one body chunk", () => {
    const code = [
      "export class User {",
      "  name: string;",
      "  email: string;",
      "  age: number;",
      "",
      "  greet() {",
      "    return 'hi';",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(1);

    // Should contain the properties
    const propsChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("name: string") && c.content.includes("email: string"),
    );
    expect(propsChunk).toBeDefined();

    // Should have class header prepended for context
    expect(propsChunk!.content).toMatch(/^export class User/);
  });

  it("should group static members separately from regular properties", () => {
    const code = [
      "export class Config {",
      "  name: string;",
      "  value: number;",
      "",
      "  static DEFAULT_NAME = 'config';",
      "  static MAX_VALUE = 100;",
      "",
      "  getValue() {",
      "    return this.value;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Should have at least 2 body chunks: properties and static_members
    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(2);

    const propsChunk = ctx.bodyChunks.find((c) => c.content.includes("name: string") && !c.content.includes("static"));
    const staticChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("static DEFAULT_NAME") && c.content.includes("static MAX_VALUE"),
    );

    expect(propsChunk).toBeDefined();
    expect(staticChunk).toBeDefined();

    // They should be separate chunks
    expect(propsChunk).not.toBe(staticChunk);
  });

  it("should group static block with static members", () => {
    const code = [
      "export class Registry {",
      "  static instances: Map<string, Registry> = new Map();",
      "",
      "  static {",
      "    Registry.instances.set('default', new Registry());",
      "  }",
      "",
      "  lookup() {",
      "    return Registry.instances;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Static field and static block should be in the same group (adjacent same-type)
    const staticChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("static instances") || c.content.includes("static {"),
    );
    expect(staticChunk).toBeDefined();
  });

  it("should group decorated members separately", () => {
    const code = [
      "export class Service {",
      "  name: string;",
      "  description: string;",
      "  isActive: boolean;",
      "",
      "  @Inject()",
      "  private logger: Logger;",
      "",
      "  @Inject()",
      "  private db: Database;",
      "",
      "  run() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Should produce separate chunks for properties vs decorated members
    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(2);

    const decoratedChunk = ctx.bodyChunks.find((c) => c.content.includes("@Inject()") && c.content.includes("logger"));
    expect(decoratedChunk).toBeDefined();

    // Plain property should not be in the decorated chunk
    const propsChunk = ctx.bodyChunks.find((c) => c.content.includes("name: string") && !c.content.includes("@Inject"));
    expect(propsChunk).toBeDefined();
    expect(propsChunk).not.toBe(decoratedChunk);
  });

  it("should group abstract members separately", () => {
    const code = [
      "export abstract class Shape {",
      "  color: string;",
      "  lineWidth: number;",
      "",
      "  abstract area(): number;",
      "  abstract perimeter(): number;",
      "",
      "  describe() {",
      "    return `Shape: ${this.color}`;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(2);

    const abstractChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("abstract area") && c.content.includes("abstract perimeter"),
    );
    expect(abstractChunk).toBeDefined();

    const propsChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("color: string") && !c.content.includes("abstract area"),
    );
    expect(propsChunk).toBeDefined();
    expect(propsChunk).not.toBe(abstractChunk);
  });

  it("should produce 3 separate body chunks for mixed: properties + static + decorated", () => {
    const code = [
      "export class MixedService {",
      "  name: string;",
      "  value: number;",
      "",
      "  static VERSION = '1.0';",
      "  static TIMEOUT = 3000;",
      "",
      "  @Inject()",
      "  private logger: Logger;",
      "  @Inject()",
      "  private config: Config;",
      "",
      "  process() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // 3 groups: properties, static_members, decorated_members
    expect(ctx.bodyChunks.length).toBe(3);

    expect(ctx.bodyChunks[0].content).toContain("name: string");
    expect(ctx.bodyChunks[1].content).toContain("static VERSION");
    expect(ctx.bodyChunks[2].content).toContain("@Inject()");
  });

  it("should prepend class header to each body chunk", () => {
    const code = [
      "export class Foo extends Bar {",
      "  name: string;",
      "  email: string;",
      "  age: number;",
      "",
      "  greet() {",
      "    return 'hi';",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    for (const chunk of ctx.bodyChunks) {
      expect(chunk.content).toMatch(/^export class Foo extends Bar \{/);
    }
  });

  it("should produce no body chunks when class has only methods", () => {
    const code = [
      "export class Calculator {",
      "  add(a: number, b: number) {",
      "    return a + b;",
      "  }",
      "",
      "  subtract(a: number, b: number) {",
      "    return a - b;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    expect(ctx.bodyChunks).toHaveLength(0);
  });

  it("should skip groups smaller than 50 characters", () => {
    const code = ["export class Tiny {", "  x: number;", "", "  run() {", "    return this.x;", "  }", "}"].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // "export class Tiny {\n  x: number;" is about 31 chars — under 50
    // Should be skipped
    expect(ctx.bodyChunks).toHaveLength(0);
  });

  it("should respect excludedRows from comment capture hook", () => {
    const code = [
      "export class Svc {",
      "  name: string;",
      "  value: number;",
      "",
      "  // This comment was captured by comment-capture hook",
      "  process() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    // Row 4 (0-based) is the comment line, pre-excluded by comment capture hook
    const ctx = buildContext(code, { excludedRows: new Set([4]) });
    typescriptBodyChunkingHook.process(ctx);

    // Body chunks should NOT contain the excluded comment
    for (const chunk of ctx.bodyChunks) {
      expect(chunk.content).not.toContain("This comment was captured");
    }
  });

  it("should split oversized groups when exceeding maxChunkSize", () => {
    // Build a class with many properties that will exceed a small maxChunkSize
    const props = Array.from({ length: 20 }, (_, i) => `  property${i}: string;`);
    const code = ["export class BigClass {", ...props, "", "  run() { return true; }", "}"].join("\n");

    // Use a small maxChunkSize so the properties group needs splitting
    const ctx = buildContext(code, { maxChunkSize: 200 });
    typescriptBodyChunkingHook.process(ctx);

    // Should produce more than 1 chunk due to splitting
    expect(ctx.bodyChunks.length).toBeGreaterThan(1);

    // Each chunk should have class header
    for (const chunk of ctx.bodyChunks) {
      expect(chunk.content).toMatch(/^export class BigClass/);
    }
  });

  it("should include preceding property comments in the body chunk", () => {
    const code = [
      "export class Documented {",
      "  // The user's display name",
      "  name: string;",
      "  // The user's email address for notifications",
      "  email: string;",
      "",
      "  greet() {",
      "    return 'hi';",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Comment before property should be included (it's not in excludedRows)
    const propsChunk = ctx.bodyChunks.find((c) => c.content.includes("name: string"));
    expect(propsChunk).toBeDefined();
    expect(propsChunk!.content).toContain("The user's display name");
  });

  it("should classify decorated static field as decorated_members, not static_members", () => {
    const code = [
      "export class Prioritized {",
      "  name: string;",
      "  value: number;",
      "",
      "  @Inject()",
      "  static instance: Prioritized;",
      "",
      "  static DEFAULT_CONFIG = 'default-configuration-value';",
      "  static FALLBACK_CONFIG = 'fallback-configuration-value';",
      "",
      "  run() { return true; }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // The @Inject() static instance should be in decorated_members
    const decoratedChunk = ctx.bodyChunks.find((c) => c.content.includes("@Inject()"));
    expect(decoratedChunk).toBeDefined();
    expect(decoratedChunk!.content).toContain("static instance");

    // The plain static fields should be in a separate chunk
    const staticChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("static DEFAULT_CONFIG") && !c.content.includes("@Inject"),
    );
    expect(staticChunk).toBeDefined();
  });

  it("should set correct startLine and endLine on body chunks", () => {
    const code = [
      "export class Lined {", // row 0, line 1
      "  name: string;", // row 1, line 2
      "  email: string;", // row 2, line 3
      "  age: number;", // row 3, line 4
      "", // row 4
      "  run() { return true; }", // row 5
      "}", // row 6
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(1);
    const chunk = ctx.bodyChunks[0];

    // Properties are on lines 2-4 (1-based)
    expect(chunk.startLine).toBe(2);
    expect(chunk.endLine).toBe(4);
  });
});
