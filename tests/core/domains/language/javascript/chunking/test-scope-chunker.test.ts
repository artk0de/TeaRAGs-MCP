import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { beforeAll, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { javascriptHooks } from "../../../../../../src/core/domains/language/javascript/chunking/index.js";
import { jsTestDslFilterHook } from "../../../../../../src/core/domains/language/javascript/chunking/test-dsl-filter.js";
import {
  buildScopeTree,
  isDslContainerCall,
  jsTestScopeChunkerHook,
  produceScopeChunks,
} from "../../../../../../src/core/domains/language/javascript/chunking/test-scope-chunker.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

let jsParser: Parser;

beforeAll(() => {
  jsParser = new Parser();
  jsParser.setLanguage(JsLang);
});

function parseJs(code: string): Parser.Tree {
  return jsParser.parse(code);
}

/** Find the first top-level call_expression (the describe/context/suite at file root). */
function findTopLevelCall(tree: Parser.Tree): Parser.SyntaxNode {
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "expression_statement") {
      const inner = child.namedChildren.find((c) => c.type === "call_expression");
      if (inner) return inner;
    }
    if (child.type === "call_expression") return child;
  }
  throw new Error("No top-level call_expression found");
}

const defaultConfig = { maxChunkSize: 5000 };

// ── Hook chain composition (bd tea-rags-mcp-1etj8) ──────────────────

describe("javascriptHooks composition", () => {
  it("composes the test DSL filter and the test-scope chunker alongside the assignment filter", () => {
    const names = javascriptHooks.map((h) => h.name);
    expect(names).toContain("js-test-dsl-filter");
    expect(names).toContain("js-test-scope-chunker");
  });

  it("orders filter hooks first, then the scope chunker (chunker-hooks.md canonical order)", () => {
    const names = javascriptHooks.map((h) => h.name);
    const dslFilter = names.indexOf("js-test-dsl-filter");
    const assignmentFilter = names.indexOf("js-assignment-filter");
    const scopeChunker = names.indexOf("js-test-scope-chunker");
    expect(dslFilter).toBeGreaterThanOrEqual(0);
    expect(assignmentFilter).toBeGreaterThan(dslFilter);
    expect(scopeChunker).toBeGreaterThan(assignmentFilter);
  });
});

// ── jsTestDslFilterHook (filterNode) ─────────────────────────────────

describe("jsTestDslFilterHook filterNode", () => {
  it("accepts DSL calls in test files", () => {
    const code = `describe('User', () => { it('works with a reasonably long assertion', () => { expect(1).toBe(1); }); });`;
    const tree = parseJs(code);
    const call = findTopLevelCall(tree);
    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(true);
  });

  it("rejects DSL calls in non-test files", () => {
    const code = `describe('User', () => { it('works with a reasonably long assertion', () => { expect(1).toBe(1); }); });`;
    const tree = parseJs(code);
    const call = findTopLevelCall(tree);
    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "src/user/service.js")).toBe(false);
  });

  it("rejects non-DSL calls in test files", () => {
    const code = `renderNothing(here);`;
    const tree = parseJs(code);
    const call = findTopLevelCall(tree);
    expect(jsTestDslFilterHook.filterNode?.(call as never, code, "tests/user.test.js")).toBe(false);
  });

  it("has no opinion on non-call_expression nodes (undefined — other filters decide)", () => {
    const code = `class User { render() {} }`;
    const tree = parseJs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();
    expect(jsTestDslFilterHook.filterNode?.(classDecl as never, code, "tests/user.test.js")).toBeUndefined();
  });
});

// ── buildScopeTree ───────────────────────────────────────────────────

describe("buildScopeTree", () => {
  it("builds a single leaf scope from describe with only it blocks", () => {
    const code = `describe('User', () => {
  it('validates name', () => {
    expect(user.name).toBeDefined();
  });

  it('validates email', () => {
    expect(user.email).toBeDefined();
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.name).toBe("describe 'User'");
    expect(scope.isLeaf).toBe(true);
    expect(scope.ownItBlocks).toHaveLength(2);
    expect(scope.children).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });

  it("builds intermediate + leaf scopes (describe/it nesting)", () => {
    const code = `describe('User', () => {
  describe('when admin', () => {
    it('has admin role', () => {
      expect(user.role).toBe('admin');
    });
  });

  describe('when guest', () => {
    it('has guest role', () => {
      expect(user.role).toBe('guest');
    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.isLeaf).toBe(false);
    expect(scope.children).toHaveLength(2);
    expect(scope.children[0].name).toBe("describe 'when admin'");
    expect(scope.children[0].isLeaf).toBe(true);
    expect(scope.children[1].name).toBe("describe 'when guest'");
    expect(scope.children[1].isLeaf).toBe(true);
  });

  it("collects setup lines (beforeEach, beforeAll) at each level", () => {
    const code = `describe('User', () => {
  beforeEach(() => { signIn(user); });
  beforeAll(() => { setupDb(); });

  describe('when admin', () => {
    beforeEach(() => { user.role = 'admin'; });

    it('returns true', () => {
      expect(user.isAdmin()).toBe(true);
    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.setupLines).toHaveLength(2);
    expect(scope.setupLines[0].text).toContain("beforeEach");

    const childScope = scope.children[0];
    expect(childScope.setupLines).toHaveLength(1);
    expect(childScope.setupLines[0].text).toContain("user.role = 'admin'");
  });

  it("recognises member-expression DSL calls (it.skip, describe.only) as scope members", () => {
    const code = `describe('User', () => {
  describe.only('focused suite', () => {
    it.skip('pending', () => {
      expect(1).toBe(1);
    });

    it('runs', () => {
      expect(true).toBe(true);
    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.children).toHaveLength(1);
    const focused = scope.children[0];
    expect(focused.isLeaf).toBe(true);
    expect(focused.ownItBlocks).toHaveLength(2);
  });

  it("handles function-expression callbacks (Jest/Mocha idiom)", () => {
    const code = `describe('User', function () {
  it('validates name', function () {
    expect(user.name).toBeDefined();
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.ownItBlocks).toHaveLength(1);
  });
});

// ── produceScopeChunks ───────────────────────────────────────────────

describe("produceScopeChunks", () => {
  it("produces a single test chunk for a leaf scope", () => {
    const code = `describe('User', () => {
  it('validates name correctly with full assertion coverage', () => {
    expect(user.name).toBeDefined();
    expect(user.name.length).toBeGreaterThan(0);
  });

  it('validates email correctly with full assertion coverage', () => {
    expect(user.email).toBeDefined();
    expect(user.email).toMatch(/@/);
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].content).toContain("validates name");
    expect(chunks[0].content).toContain("validates email");
    expect(chunks[0].parentSymbolId).toBe("User");
  });

  it("injects parent setup into leaf chunks (scope preserved)", () => {
    const code = `describe('User', () => {
  beforeEach(() => { signIn(user); });
  beforeAll(() => { setupDatabase(); });

  describe('when admin', () => {
    it('has admin role and full permission set for management ops', () => {
      expect(user.role).toBe('admin');
      expect(user.permissions).toContain('manage');
    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].content).toContain("signIn(user)");
    expect(chunks[0].content).toContain("setupDatabase()");
    expect(chunks[0].content).toContain("has admin role");
    // Line range must NOT include ancestor setup lines — only own scope lines.
    // Ancestor setup is at lines 2-3, child describe starts at line 5.
    expect(chunks[0].startLine).toBeGreaterThanOrEqual(5);
  });

  it("uses 2-level symbolId format: TopLevelName.leafScopeName", () => {
    const code = `describe('User', () => {
  describe('when admin', () => {
    it('has permissions for managing all system resources globally', () => {
      expect(user.isAdmin()).toBe(true);
      expect(user.permissions).toContain('manage');
    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toBe("User.describe 'when admin'");
    expect(chunks[0].parentSymbolId).toBe("User");
    expect(chunks[0].name).toBe("describe 'when admin'");
  });

  it("produces no chunks for empty describe block", () => {
    const code = `describe('User', () => {});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(0);
  });

  it("splits oversized leaf by it blocks when exceeding maxChunkSize", () => {
    const longBody = "    expect(result).toBe('x');\n".repeat(20);
    const code = `describe('User', () => {
  describe('validations', () => {
    it('validates name', () => {
${longBody}    });

    it('validates email', () => {
${longBody}    });

    it('validates phone', () => {
${longBody}    });
  });
});`;

    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, { maxChunkSize: 300 });

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.symbolId).toBe("User.describe 'validations'");
    }
  });
});

// ── jsTestScopeChunkerHook (process) guards ──────────────────────────

describe("jsTestScopeChunkerHook process guards", () => {
  function makeCtx(containerNode: Parser.SyntaxNode, code: string, filePath: string) {
    return {
      containerNode,
      validChildren: [] as Parser.SyntaxNode[],
      code,
      codeLines: code.split("\n"),
      config: { maxChunkSize: 5000 },
      filePath,
      excludedRows: new Set<number>(),
      methodPrefixes: new Map<number, string>(),
      methodStartLines: new Map<number, number>(),
      bodyChunks: [] as unknown[],
      skipChildren: false,
    };
  }

  it("no-ops on non-test files (does not touch bodyChunks)", () => {
    const code = `describe('User', () => { it('validates name correctly with full coverage', () => { expect(user.name).toBeDefined(); expect(user.name.length).toBeGreaterThan(0); }); });`;
    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "src/foo/bar.js");

    jsTestScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks).toHaveLength(0);
    expect(ctx.skipChildren).toBe(false);
  });

  it("no-ops when containerNode is not a call_expression (e.g. class_declaration)", () => {
    const code = `class Foo { method() {} }`;
    const tree = parseJs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();
    const ctx = makeCtx(classDecl!, code, "tests/foo.test.js");

    jsTestScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks).toHaveLength(0);
    expect(ctx.skipChildren).toBe(false);
  });

  it("no-ops when containerNode is a non-container DSL call (it()) — only describe/context/suite produce scopes", () => {
    const code = `it('top-level it call outside describe — should not produce a scope', () => { expect(true).toBe(true); });`;
    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "tests/foo.test.js");

    jsTestScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks).toHaveLength(0);
    expect(ctx.skipChildren).toBe(false);
  });

  it("populates bodyChunks and sets skipChildren on valid describe in test file", () => {
    const code = `describe('User', () => {
  it('validates name and ensures correct behaviour across the suite', () => {
    expect(user.name).toBeDefined();
    expect(user.name).not.toBe('');
  });
});`;
    const tree = parseJs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "tests/foo.test.js");

    jsTestScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks.length).toBeGreaterThan(0);
    expect(ctx.skipChildren).toBe(true);
  });
});

// ── isDslContainerCall ───────────────────────────────────────────────

describe("isDslContainerCall", () => {
  it("returns false for non-call_expression nodes (defensive guard)", () => {
    const code = `class Foo { method() {} }`;
    const tree = parseJs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();

    expect(isDslContainerCall(classDecl as never, code)).toBe(false);
  });

  it("returns true for describe/context/suite calls", () => {
    for (const name of ["describe", "context", "suite"]) {
      const code = `${name}('x', () => {})`;
      const tree = parseJs(code);
      const call = findTopLevelCall(tree);
      expect(isDslContainerCall(call, code), `${name} should be container`).toBe(true);
    }
  });

  it("returns false for example methods (it/test) at top level", () => {
    const code = `it('x', () => {})`;
    const tree = parseJs(code);
    const call = findTopLevelCall(tree);
    expect(isDslContainerCall(call, code)).toBe(false);
  });
});

// ── End-to-end through TreeSitterChunker ─────────────────────────────

describe("TreeSitterChunker JS test-scope chunking (end-to-end)", () => {
  const config: ChunkerConfig = {
    chunkSize: 500,
    chunkOverlap: 50,
    maxChunkSize: 1000,
  };
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());

  it("produces test chunks with parent setup injection for a nested .test.js file", async () => {
    const code = `describe('UserService', () => {
  beforeEach(() => { signIn(user); });

  describe('when admin', () => {
    it('has admin access and can manage every resource in the system', () => {
      expect(user).toBeAdmin();
      expect(user.permissions).toContain('manage');
    });
  });

  describe('when regular', () => {
    it('has limited access and cannot manage any resource globally', () => {
      expect(user).not.toBeAdmin();
    });
  });
});`;

    const chunks = await chunker.chunk(code, "tests/unit/user.test.js", "javascript");

    // One test chunk per leaf scope, preserving the scope hierarchy.
    const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
    expect(testChunks).toHaveLength(2);

    // 'when admin' leaf should contain injected beforeEach from parent scope.
    const adminChunk = testChunks.find((c) => c.content.includes("admin access"));
    expect(adminChunk).toBeDefined();
    expect(adminChunk!.content).toContain("signIn(user)");
    expect(adminChunk!.metadata.chunkType).toBe("test");
    // 2-level symbolId: TopLevel.leafScope
    expect(adminChunk!.metadata.symbolId).toContain("UserService");

    // 'when regular' leaf also gets the injected parent setup.
    const regularChunk = testChunks.find((c) => c.content.includes("limited access"));
    expect(regularChunk).toBeDefined();
    expect(regularChunk!.content).toContain("signIn(user)");
  });

  it("does not claim DSL containers in non-test JS files", async () => {
    const code = `function renderUser(user) {
  describe('stray describe in production code', () => {
    it('would be an unexpected test chunk in a source file', () => {
      expect(user).toBeDefined();
    });
  });
  return user;
}`;

    const chunks = await chunker.chunk(code, "src/render/user.js", "javascript");

    expect(chunks.filter((c) => c.metadata.chunkType === "test")).toHaveLength(0);
  });
});
