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
      "  firstName: string;",
      "  lastName: string;",
      "  emailAddress: string;",
      "  phoneNumber: string;",
      "  homeAddress: string;",
      "  postalCode: string;",
      "  countryName: string;",
      "  dateOfBirth: Date;",
      "",
      "  static DEFAULT_FIRST_NAME = 'John';",
      "  static DEFAULT_LAST_NAME = 'Doe';",
      "  static DEFAULT_EMAIL = 'john.doe@example.com';",
      "  static DEFAULT_PHONE = '+1-555-0100';",
      "  static DEFAULT_ADDRESS = '123 Main Street';",
      "  static DEFAULT_POSTAL = '10001';",
      "  static DEFAULT_COUNTRY = 'United States';",
      "  static MAX_NAME_LENGTH = 100;",
      "",
      "  getValue() {",
      "    return this.firstName;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Should have at least 2 body chunks: properties and static_members
    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(2);

    const propsChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("firstName: string") && !c.content.includes("static"),
    );
    const staticChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("static DEFAULT_FIRST_NAME") && c.content.includes("static MAX_NAME_LENGTH"),
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
      "  firstName: string;",
      "  lastName: string;",
      "  emailAddress: string;",
      "  phoneNumber: string;",
      "  homeAddress: string;",
      "  postalCode: string;",
      "  countryName: string;",
      "  dateOfBirth: Date;",
      "",
      "  @Inject()",
      "  private loggerService: LoggerService;",
      "",
      "  @Inject()",
      "  private databaseConnection: DatabaseConnection;",
      "",
      "  @Inject()",
      "  private configurationManager: ConfigurationManager;",
      "",
      "  @Inject()",
      "  private authenticationService: AuthenticationService;",
      "",
      "  @Inject()",
      "  private notificationService: NotificationService;",
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

    const decoratedChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("@Inject()") && c.content.includes("loggerService"),
    );
    expect(decoratedChunk).toBeDefined();

    // Plain property should not be in the decorated chunk
    const propsChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("firstName: string") && !c.content.includes("@Inject"),
    );
    expect(propsChunk).toBeDefined();
    expect(propsChunk).not.toBe(decoratedChunk);
  });

  it("should group abstract members separately", () => {
    const code = [
      "export abstract class Shape {",
      "  colorValue: string;",
      "  lineWidth: number;",
      "  fillOpacity: number;",
      "  strokeColor: string;",
      "  strokeWidth: number;",
      "  rotationAngle: number;",
      "  scaleFactorX: number;",
      "  scaleFactorY: number;",
      "",
      "  abstract calculateArea(): number;",
      "  abstract calculatePerimeter(): number;",
      "  abstract calculateBoundingBox(): { x: number; y: number; width: number; height: number };",
      "  abstract calculateCentroid(): { x: number; y: number };",
      "  abstract transformMatrix(): number[];",
      "  abstract intersectsWith(other: Shape): boolean;",
      "",
      "  describe() {",
      "    return `Shape: ${this.colorValue}`;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThanOrEqual(2);

    const abstractChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("abstract calculateArea") && c.content.includes("abstract calculatePerimeter"),
    );
    expect(abstractChunk).toBeDefined();

    const propsChunk = ctx.bodyChunks.find(
      (c) => c.content.includes("colorValue: string") && !c.content.includes("abstract calculateArea"),
    );
    expect(propsChunk).toBeDefined();
    expect(propsChunk).not.toBe(abstractChunk);
  });

  it("should produce 3 separate body chunks for mixed: properties + static + decorated", () => {
    const code = [
      "export class MixedService {",
      "  firstName: string;",
      "  lastName: string;",
      "  emailAddress: string;",
      "  phoneNumber: string;",
      "  homeAddress: string;",
      "  postalCode: string;",
      "  countryName: string;",
      "  dateOfBirth: Date;",
      "",
      "  static VERSION_STRING = '1.0.0-beta.42';",
      "  static TIMEOUT_MILLISECONDS = 3000;",
      "  static MAX_RETRY_ATTEMPTS = 5;",
      "  static DEFAULT_LOCALE = 'en-US';",
      "  static CACHE_DURATION_SECONDS = 3600;",
      "  static API_BASE_URL = 'https://api.example.com/v2';",
      "  static CONNECTION_POOL_SIZE = 10;",
      "",
      "  @Inject()",
      "  private loggerService: LoggerService;",
      "  @Inject()",
      "  private configManager: ConfigurationManager;",
      "  @Inject()",
      "  private databaseService: DatabaseService;",
      "  @Inject()",
      "  private cacheProvider: CacheProvider;",
      "  @Inject()",
      "  private authService: AuthenticationService;",
      "",
      "  process() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // 3 groups: properties, static_members, decorated_members — all large enough to stay separate
    expect(ctx.bodyChunks.length).toBe(3);

    expect(ctx.bodyChunks[0].content).toContain("firstName: string");
    expect(ctx.bodyChunks[1].content).toContain("static VERSION_STRING");
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
      "  firstName: string;",
      "  lastName: string;",
      "  emailAddress: string;",
      "  phoneNumber: string;",
      "  homeAddress: string;",
      "  postalCode: string;",
      "  countryName: string;",
      "  dateOfBirth: Date;",
      "",
      "  @Inject()",
      "  static instance: Prioritized;",
      "",
      "  static DEFAULT_CONFIG_VALUE = 'default-configuration-value-for-application';",
      "  static FALLBACK_CONFIG_VALUE = 'fallback-configuration-value-for-application';",
      "  static SECONDARY_FALLBACK = 'secondary-fallback-configuration-override';",
      "  static TERTIARY_FALLBACK = 'tertiary-fallback-configuration-override';",
      "  static QUATERNARY_FALLBACK = 'quaternary-fallback-configuration-value';",
      "  static QUINARY_FALLBACK = 'quinary-fallback-configuration-value-final';",
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
      (c) => c.content.includes("static DEFAULT_CONFIG_VALUE") && !c.content.includes("@Inject"),
    );
    expect(staticChunk).toBeDefined();
  });

  it("should guarantee endLine > startLine for single-line groups", () => {
    const code = [
      "export class SingleProp {",
      "  readonly id: string = 'default-value-to-make-it-long-enough-for-50-char-threshold';",
      "",
      "  run() { return this.id; }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Single property on one row → should still have endLine > startLine
    for (const chunk of ctx.bodyChunks) {
      expect(chunk.endLine).toBeGreaterThan(chunk.startLine);
    }
  });

  it("should merge small adjacent body chunks into one", () => {
    // 3 different group types, each >50 chars (above tiny threshold) but <200 chars (merge candidate)
    const code = [
      "export class SmallGroups {",
      "  userName: string;",
      "  userEmail: string;",
      "",
      "  static DEFAULT_TAG_VALUE = 'small-default-tag';",
      "  static FALLBACK_TAG_VALUE = 'small-fallback-tag';",
      "",
      "  @Inject()",
      "  private loggerService: LoggerService;",
      "",
      "  run() { return true; }",
      "}",
    ].join("\n");

    const ctx = buildContext(code);
    typescriptBodyChunkingHook.process(ctx);

    // Without merge: 3 chunks (properties, static_members, decorated_members)
    // With merge: all are small (<200 chars), should merge into 1
    expect(ctx.bodyChunks).toHaveLength(1);

    // Merged chunk should contain all groups
    const merged = ctx.bodyChunks[0];
    expect(merged.content).toContain("userName: string");
    expect(merged.content).toContain("static DEFAULT_TAG_VALUE");
    expect(merged.content).toContain("@Inject()");

    // Should have class header
    expect(merged.content).toMatch(/^export class SmallGroups/);
  });

  it("should not merge chunks that would exceed maxChunkSize", () => {
    // Build properties and static members, each group large enough to not merge
    const props = Array.from({ length: 8 }, (_, i) => `  property${i}: string;`);
    const statics = Array.from({ length: 8 }, (_, i) => `  static CONST_${i} = 'value-${i}';`);
    const code = ["export class BigGroups {", ...props, "", ...statics, "", "  run() { return true; }", "}"].join("\n");

    // maxChunkSize small enough that combined would exceed
    const ctx = buildContext(code, { maxChunkSize: 300 });
    typescriptBodyChunkingHook.process(ctx);

    // Should stay as separate chunks (may be split further)
    expect(ctx.bodyChunks.length).toBeGreaterThan(1);
  });

  it("should assign distinct startLine/endLine to each sub-chunk after splitting oversized group", () => {
    // Build a class with many long properties that will exceed a small maxChunkSize
    const props = Array.from({ length: 20 }, (_, i) => `  property${i}: string; // ${"x".repeat(40)}`);
    const code = ["export class SplitTest {", ...props, "", "  run() { return true; }", "}"].join("\n");

    // Use a small maxChunkSize so the properties group needs splitting into multiple sub-chunks
    const ctx = buildContext(code, { maxChunkSize: 250 });
    typescriptBodyChunkingHook.process(ctx);

    // Should produce more than 1 chunk due to splitting
    expect(ctx.bodyChunks.length).toBeGreaterThan(1);

    // Each sub-chunk must have different startLine
    for (let i = 1; i < ctx.bodyChunks.length; i++) {
      expect(ctx.bodyChunks[i].startLine).not.toBe(ctx.bodyChunks[0].startLine);
    }

    // startLines should be in strictly ascending order
    for (let i = 1; i < ctx.bodyChunks.length; i++) {
      expect(ctx.bodyChunks[i].startLine).toBeGreaterThan(ctx.bodyChunks[i - 1].startLine);
    }

    // endLine of each chunk should be >= its startLine
    for (const chunk of ctx.bodyChunks) {
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }

    // endLine of chunk i should be < startLine of chunk i+1 (no overlap)
    for (let i = 0; i < ctx.bodyChunks.length - 1; i++) {
      expect(ctx.bodyChunks[i].endLine).toBeLessThan(ctx.bodyChunks[i + 1].startLine);
    }
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
