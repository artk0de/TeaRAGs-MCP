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

// INVARIANT CHANGED (bd tea-rags-mcp-b55x2): buildScopeTree returns the
// language-neutral `TestScope` of contracts/types/chunker.ts. A leaf is
// `children.length === 0` (was `isLeaf`) and a scope's own examples are
// `examples` (was `ownItBlocks`); the tree each case builds is unchanged.
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
    expect(scope.children).toHaveLength(0);
    expect(scope.examples).toHaveLength(2);
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

    expect(scope.children.length).toBeGreaterThan(0);
    expect(scope.children).toHaveLength(2);
    expect(scope.children[0].name).toBe("describe 'when admin'");
    expect(scope.children[0].children).toHaveLength(0);
    expect(scope.children[1].name).toBe("describe 'when guest'");
    expect(scope.children[1].children).toHaveLength(0);
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

    expect(scope.children.length).toBeGreaterThan(0);
    expect(scope.examples).toHaveLength(1);
    expect(scope.examples[0].text).toContain("it('exists'");
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

    expect(scope.children.length).toBeGreaterThan(0);
    const level1 = scope.children[0];
    expect(level1.children.length).toBeGreaterThan(0);
    const level2 = level1.children[0];
    expect(level2.children.length).toBeGreaterThan(0);
    const level3 = level2.children[0];
    expect(level3.children).toHaveLength(0);
    expect(level3.examples).toHaveLength(1);
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
    expect(focused.children).toHaveLength(0);
    expect(focused.examples).toHaveLength(2);
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
  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): the unit is the example — a
  // leaf with two its yields two test chunks, each parented by its scope id.
  it("produces one test chunk per example of a leaf scope", () => {
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.chunkType)).toEqual(["test", "test"]);
    expect(chunks[0].content).toContain("validates name");
    expect(chunks[1].content).toContain("validates email");
    expect(chunks.map((c) => c.parentSymbolId)).toEqual(["User.describe 'User'", "User.describe 'User'"]);
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the parent hooks are the root
    // scope's own test_setup chunk, referenced by the example, not copied in.
    expect(chunks).toHaveLength(2);
    const [setup, example] = chunks;
    expect(setup).toMatchObject({ chunkType: "test_setup", symbolId: "User.describe 'User'" });
    expect(setup.content).toContain("signIn(user)");
    expect(setup.content).toContain("setupDatabase()");
    expect(example.chunkType).toBe("test");
    expect(example.content).not.toContain("signIn(user)");
    expect(example.content).toContain("has admin role");
    expect(example.setupScopeIds).toEqual(["User.describe 'User'"]);
    // Line range must NOT include ancestor setup lines — only own scope lines.
    // Ancestor setup is at lines 2-3, child describe starts at line 5.
    expect(example.startLine).toBeGreaterThanOrEqual(5);
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): an intermediate scope's own it
  // is an example chunk like any other, not a test_setup chunk of the scope.
  it("emits an intermediate scope's own it as a test example chunk", () => {
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(2);
    expect(setupChunks).toHaveLength(0);
    expect(testChunks[0].content).toContain("constructable class");
    expect(testChunks[0].parentSymbolId).toBe("User.describe 'User'");
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): the three per-it chunks no
  // longer share the scope id — each is addressed by its own example id.
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
    const chunks = produceScopeChunks(node, code, { maxChunkSize: 300 });

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.parentSymbolId).toBe("User.describe 'validations'");
    }
    expect(chunks.map((c) => c.symbolId)).toEqual([
      "User.describe 'validations'.it 'validates name'",
      "User.describe 'validations'.it 'validates email'",
      "User.describe 'validations'.it 'validates phone'",
    ]);
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("signIn(user)");
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): 3-level example id
  // TopLevelName.scopeName.exampleName, parented by the scope id.
  it("uses 3-level symbolId format: TopLevelName.scopeName.exampleName", () => {
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toBe(
      "User.describe 'when admin'.it 'has permissions for managing all system resources globally'",
    );
    expect(chunks[0].parentSymbolId).toBe("User.describe 'when admin'");
    expect(chunks[0].name).toBe("it 'has permissions for managing all system resources globally'");
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): the example's parent is its
    // scope id; the top-level name `User` is that id's first segment.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentSymbolId).toBe("User.describe User");
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    // Backticks stripped, interpolation placeholder preserved literally.
    expect(chunks[0].parentSymbolId).toContain("User");
    expect(chunks[0].parentSymbolId).toMatch(/\$\{role\}/);
  });

  it("produces no chunks for empty describe block", () => {
    const code = `describe('User', () => {});`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const chunks = produceScopeChunks(node, code, defaultConfig);

    expect(chunks).toHaveLength(0);
  });

  it("handles describe with no callback at all (just (User))", () => {
    const code = `describe(User);`;

    const tree = parseTs(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): neutral TestScope fields
    // (`children` / `examples` replace `isLeaf` / `ownItBlocks`).
    expect(scope.children).toHaveLength(0);
    expect(scope.examples).toHaveLength(0);
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

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
    const chunks = produceScopeChunks(node, code, defaultConfig);

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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): a short example is never
    // dropped — a lone one stays its own chunk.
    expect(chunks.map((c) => c.symbolId)).toEqual(["U.describe 't'.it 'ok'"]);
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): the root's own it is an
    // example chunk carrying the root's setup, and the nested example
    // inherits that setup too — no test_setup chunk for a scope with examples.
    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): that setup is the root's own
    // test_setup chunk, which both examples reference instead of carrying.
    expect(testChunks).toHaveLength(2);
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].content).toContain("signIn(user)");
    expect(testChunks[0].content).toContain("is a class that exists");
    expect(testChunks[1].content).toContain("has admin role");
    for (const example of testChunks) {
      expect(example.content).not.toContain("signIn(user)");
      expect(example.setupScopeIds).toEqual(["User.describe 'User'"]);
    }
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
  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): a middle scope's own it is an
  // example chunk (was a test_setup chunk of the scope); the grandchild's
  // example inherits the middle scope's setup.
  it("emits a middle scope's own it as an example beside its grandchild describe's example", () => {
    // Structure: User → 'authenticated' (middle: own it + child) → 'admin' (leaf: it)
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the middle scope's hook is its
    // own test_setup chunk; both examples reference it instead of carrying it.
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].symbolId).toBe("User.describe 'authenticated'");
    expect(setupChunks[0].content).toContain("signIn(user)");
    expect(testChunks).toHaveLength(2);

    const middle = testChunks.find((c) => c.content.includes("has a token assigned"));
    expect(middle).toBeDefined();
    expect(middle!.setupScopeIds).toEqual(["User.describe 'authenticated'"]);
    expect(middle!.parentSymbolId).toBe("User.describe 'authenticated'");

    const leaf = testChunks.find((c) => c.content.includes("admin role"));
    expect(leaf!.setupScopeIds).toEqual(["User.describe 'authenticated'"]);
    expect(leaf!.parentSymbolId).toBe("User.describe 'admin'");
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): root otherLines reach the index
  // inside the root's own example chunk (was a root test_setup chunk).
  it("includes root-level otherLines in the root's own example chunk", () => {
    // Root has: const declaration (otherLines), own it, AND child describe.
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the root otherLines (const
    // ROLES, const DEFAULT_TIMEOUT) are the root's own setup chunk, which the
    // root example references.
    const rootExample = chunks.find((c) => c.content.includes("sensible defaults"));
    expect(rootExample).toBeDefined();
    expect(rootExample!.setupScopeIds).toEqual(["User.describe 'User'"]);
    const rootSetup = chunks.find((c) => c.symbolId === "User.describe 'User'");
    expect(rootSetup!.content).toContain("ROLES");
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
    const chunks = produceScopeChunks(node, code, defaultConfig);

    // Zero-arg-but-with-callback case: arrow_function IS a namedChild, so
    // extractTopLevelName iterates it (not identifier/string), then falls
    // back to scope.name. The scope still emits a chunk (callback body
    // has it).
    // INVARIANT CHANGED (bd tea-rags-mcp-b55x2): the fallback name is the call
    // alone (`describe`, never the callback text), and it is the first segment
    // of the example's parent scope id.
    expect(chunks.length).toBeGreaterThan(0);
    expect(scope.name).toBe("describe");
    expect(chunks[0].parentSymbolId).toBe(`${scope.name}.${scope.name}`);
  });
});
