import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildScopeTree,
  isDslContainerCall,
  produceScopeChunks,
  testScopeChunkerHook,
} from "../../../../../../src/core/domains/language/typescript/chunking/test-scope-chunker.js";

let tsLang: unknown;

beforeAll(async () => {
  const tsModule = await import("tree-sitter-typescript");
  tsLang =
    (tsModule.default as { typescript?: unknown })?.typescript ?? (tsModule as { typescript?: unknown }).typescript;
});

function parseTs(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLang as Parser.Language);
  return parser.parse(code);
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.name).toBe("describe 'User'");
    expect(scope.isLeaf).toBe(true);
    expect(scope.ownItBlocks).toHaveLength(2);
    expect(scope.children).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });

  it("builds intermediate + leaf scopes", () => {
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

    const tree = parseTs(code);
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.setupLines).toHaveLength(2);
    expect(scope.setupLines[0].text).toContain("beforeEach");
    expect(scope.setupLines[1].text).toContain("beforeAll");

    const childScope = scope.children[0];
    expect(childScope.setupLines).toHaveLength(1);
    expect(childScope.setupLines[0].text).toContain("user.role = 'admin'");
  });

  it("collects it blocks at intermediate scope level", () => {
    const code = `describe('User', () => {
  it('exists', () => {
    expect(User).toBeDefined();
  });

  describe('when admin', () => {
    it('has admin role', () => {
      expect(user.role).toBe('admin');
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.isLeaf).toBe(false);
    expect(scope.ownItBlocks).toHaveLength(1);
    expect(scope.ownItBlocks[0].text).toContain("it('exists'");
    expect(scope.children).toHaveLength(1);
  });

  it("handles deep nesting (4 levels)", () => {
    const code = `describe('User', () => {
  describe('authenticated', () => {
    describe('admin', () => {
      describe('with permissions', () => {
        it('can manage', () => {
          expect(true).toBe(true);
        });
      });
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.isLeaf).toBe(false);
    const level1 = scope.children[0];
    expect(level1.isLeaf).toBe(false);
    const level2 = level1.children[0];
    expect(level2.isLeaf).toBe(false);
    const level3 = level2.children[0];
    expect(level3.isLeaf).toBe(true);
    expect(level3.ownItBlocks).toHaveLength(1);
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.children).toHaveLength(1);
    const focused = scope.children[0];
    expect(focused.isLeaf).toBe(true);
    expect(focused.ownItBlocks).toHaveLength(2);
  });

  it("collects context() (Mocha/Jest extension) as a container", () => {
    const code = `describe('Auth', () => {
  context('logged in', () => {
    it('shows dashboard', () => {
      expect(page).toBeDefined();
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.children).toHaveLength(1);
    expect(scope.children[0].name).toContain("context");
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].content).toContain("validates name");
    expect(chunks[0].content).toContain("validates email");
    expect(chunks[0].parentSymbolId).toBe("User");
  });

  it("injects parent setup into leaf chunks", () => {
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

    const tree = parseTs(code);
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

  it("produces test_setup chunk for intermediate scope with own it blocks", () => {
    const code = `describe('User', () => {
  it('is a constructable class with sensible defaults across all envs', () => {
    expect(User).toBeDefined();
    expect(new User()).toBeInstanceOf(User);
  });

  describe('when admin', () => {
    it('has admin role and full permission set for management ops', () => {
      expect(user.role).toBe('admin');
      expect(user).toMatchObject({ admin: true });
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(1);
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].content).toContain("constructable class");
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, { maxChunkSize: 300 });

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.symbolId).toBe("User.describe 'validations'");
    }
  });

  it("produces test_setup for setup-only leaf scope", () => {
    const code = `describe('User', () => {
  describe('shared setup for all user tests with comprehensive configuration', () => {
    beforeEach(() => { signIn(user); user.role = 'admin'; user.active = true; });
    beforeAll(() => { setupDb(); seedFixtures(); });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("signIn(user)");
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

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toBe("User.describe 'when admin'");
    expect(chunks[0].parentSymbolId).toBe("User");
    expect(chunks[0].name).toBe("describe 'when admin'");
  });

  it("handles identifier-name describe (describe(User, ...)) for topLevelName", () => {
    const code = `describe(User, () => {
  it('validates name and ensures correct behaviour across the suite', () => {
    expect(user.name).toBeDefined();
    expect(user.name).not.toBe('');
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentSymbolId).toBe("User");
  });

  it("handles template literal name (describe with backtick + interpolation) preserving literal text", () => {
    const code = `describe(\`User \${role}\`, () => {
  it('validates name and ensures correct behaviour across the suite', () => {
    expect(user.name).toBeDefined();
    expect(user.name).not.toBe('');
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    // Backticks stripped, interpolation placeholder preserved literally.
    expect(chunks[0].parentSymbolId).toContain("User");
    expect(chunks[0].parentSymbolId).toMatch(/\$\{role\}/);
  });

  it("produces no chunks for empty describe block", () => {
    const code = `describe('User', () => {});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(0);
  });

  it("handles describe with no callback at all (just (User))", () => {
    const code = `describe(User);`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.isLeaf).toBe(true);
    expect(scope.children).toHaveLength(0);
    expect(scope.ownItBlocks).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });

  it("collects otherLines for non-DSL statements in describe body", () => {
    const code = `describe('User', () => {
  const ROLES = ['admin', 'user', 'guest'];

  it('validates name on the user model with all assertions running', () => {
    expect(user.name).toBeDefined();
    expect(user.name).not.toBe('');
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.otherLines.length).toBeGreaterThanOrEqual(1);
  });

  it("handles async arrow function callbacks transparently", () => {
    const code = `describe('User', () => {
  it('loads user data asynchronously and validates the response shape', async () => {
    const data = await fetchUser();
    expect(data).toBeDefined();
    expect(data.id).toBeDefined();
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("await fetchUser");
  });

  it("handles function_expression callback (function () { ... })", () => {
    const code = `describe('User', function () {
  it('validates name and ensures correct behaviour across the suite', function () {
    expect(user.name).toBeDefined();
    expect(user.name).not.toBe('');
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("user.name");
  });
});

// ── produceScopeChunks edge cases ────────────────────────────────────

describe("produceScopeChunks edge cases", () => {
  it("skips chunks with content shorter than 50 characters", () => {
    const code = `describe('U', () => {
  describe('t', () => {
    it('ok', () => { expect(1).toBe(1); });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(0);
  });

  it("includes otherLines in leaf scope test chunk content", () => {
    const code = `describe('User', () => {
  describe('with constants and configuration settings throughout', () => {
    const TIMEOUT = 30;
    const MAX_RETRIES = 3;
    const DEFAULT_ROLE = 'user';

    it('uses the correct timeout for all API operations consistently', () => {
      expect(TIMEOUT).toBe(30);
      expect(MAX_RETRIES).toBe(3);
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks.length).toBeGreaterThanOrEqual(1);
    expect(testChunks[0].content).toContain("TIMEOUT");
  });

  it("handles intermediate scope with setup, it blocks, and child contexts", () => {
    const code = `describe('User', () => {
  beforeEach(() => { signIn(user); user.role = 'admin'; });
  beforeAll(() => { setupDatabase(); seedFixtures(); });

  it('is a class that exists and can be instantiated properly with defaults', () => {
    expect(User).toBeDefined();
    expect(new User()).toBeInstanceOf(User);
  });

  describe('when admin with elevated privileges and full system access', () => {
    it('has admin role and can manage all system resources globally', () => {
      expect(user.role).toBe('admin');
      expect(user.permissions).toContain('manage');
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(1);
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].content).toContain("is a class that exists");
    expect(setupChunks[0].content).toContain("signIn(user)");
  });
});

// ── testScopeChunkerHook (process) guards ─────────────────────────────

describe("testScopeChunkerHook process guards", () => {
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
    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "src/foo/bar.ts");

    testScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks).toHaveLength(0);
    expect(ctx.skipChildren).toBe(false);
  });

  it("no-ops when containerNode is not a call_expression (e.g. class_declaration)", () => {
    const code = `class Foo { method() {} }`;
    const tree = parseTs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();
    const ctx = makeCtx(classDecl!, code, "tests/foo.test.ts");

    testScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks).toHaveLength(0);
    expect(ctx.skipChildren).toBe(false);
  });

  it("no-ops when containerNode is a non-container DSL call (it()) — only describe/context/suite produce scopes", () => {
    const code = `it('top-level it call outside describe — should not produce a scope', () => { expect(true).toBe(true); });`;
    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "tests/foo.test.ts");

    testScopeChunkerHook.process(ctx as never);

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
    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const ctx = makeCtx(node, code, "tests/foo.test.ts");

    testScopeChunkerHook.process(ctx as never);

    expect(ctx.bodyChunks.length).toBeGreaterThan(0);
    expect(ctx.skipChildren).toBe(true);
  });
});

// ── isDslContainerCall ───────────────────────────────────────────────

describe("isDslContainerCall", () => {
  it("returns false for non-call_expression nodes (defensive guard)", () => {
    const code = `class Foo { method() {} }`;
    const tree = parseTs(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();

    expect(isDslContainerCall(classDecl!, code)).toBe(false);
  });

  it("returns true for describe/context/suite calls", () => {
    for (const name of ["describe", "context", "suite"]) {
      const code = `${name}('x', () => {})`;
      const tree = parseTs(code);
      const call = findTopLevelCall(tree);
      expect(isDslContainerCall(call, code), `${name} should be container`).toBe(true);
    }
  });

  it("returns false for example methods (it/test) at top level", () => {
    const code = `it('x', () => {})`;
    const tree = parseTs(code);
    const call = findTopLevelCall(tree);
    expect(isDslContainerCall(call, code)).toBe(false);
  });
});

// ── Multi-level intermediate scope walk ──────────────────────────────

describe("produceScopeChunks intermediate-scope branches", () => {
  it("emits test_setup for middle scope with own its AND grandchild describes (walk else-branch)", () => {
    // Structure: User → 'authenticated' (middle: own it + child) → 'admin' (leaf: it)
    // The middle scope must trigger the non-leaf walk branch where
    // scope.ownItBlocks.length > 0 — produces a test_setup chunk for the
    // middle level alongside the leaf test chunk.
    const code = `describe('User', () => {
  describe('authenticated', () => {
    beforeEach(() => { signIn(user); user.token = 'abc'; });

    it('has a token assigned at the authenticated middle level always', () => {
      expect(user.token).toBeDefined();
      expect(user.token.length).toBeGreaterThan(0);
    });

    describe('admin', () => {
      it('has admin role and can manage all system resources globally', () => {
        expect(user.role).toBe('admin');
        expect(user.permissions).toContain('manage');
      });
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    // One test chunk for the deep leaf 'admin'.
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0].content).toContain("admin role");

    // One test_setup chunk for the middle 'authenticated' scope with its
    // own it + setup (non-leaf walk else-branch with ownItBlocks > 0).
    expect(setupChunks.length).toBeGreaterThanOrEqual(1);
    const middleSetup = setupChunks.find((c) => c.content.includes("has a token assigned"));
    expect(middleSetup).toBeDefined();
    expect(middleSetup!.content).toContain("signIn(user)");
    expect(middleSetup!.symbolId).toContain("authenticated");
  });

  it("includes root-level otherLines in root non-leaf chunk content", () => {
    // Root has: const declaration (otherLines), own it, AND child describe.
    // Triggers the root non-leaf branch where rootScope.otherLines.length > 0
    // — exercises the otherLines.map((o) => o.text/sourceLine) callbacks.
    const code = `describe('User', () => {
  const ROLES = ['admin', 'user', 'guest'];
  const DEFAULT_TIMEOUT = 30000;

  it('is a class with sensible defaults exposed to all consumers globally', () => {
    expect(User).toBeDefined();
    expect(new User()).toBeInstanceOf(User);
  });

  describe('when admin', () => {
    it('has admin role and full management permissions across the system', () => {
      expect(user.role).toBe('admin');
      expect(user.permissions).toContain('manage');
    });
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks.length).toBeGreaterThanOrEqual(1);

    // Root setup chunk should include otherLines (const ROLES, const DEFAULT_TIMEOUT).
    const rootSetup = setupChunks.find((c) => c.content.includes("ROLES"));
    expect(rootSetup).toBeDefined();
    expect(rootSetup!.content).toContain("DEFAULT_TIMEOUT");
  });

  it("falls back to scope.name when no fitting top-level arg exists (extractTopLevelName)", () => {
    // describe() with zero args — no identifier, no string. Triggers
    // both extractScopeName fallback (no namedChildren) AND
    // extractTopLevelName fallback (return scope.name).
    const code = `describe(() => {
  it('runs anonymously with the full assertion coverage on each spec line', () => {
    expect(true).toBe(true);
    expect(false).toBe(false);
  });
});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // Zero-arg-but-with-callback case: arrow_function IS a namedChild, so
    // extractTopLevelName iterates it (not identifier/string), then falls
    // back to scope.name. The scope still emits a chunk (callback body
    // has it).
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].parentSymbolId).toBe(scope.name);
  });
});
