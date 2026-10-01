import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildScopeTree,
  produceScopeChunks,
} from "../../../../../../src/core/domains/language/javascript/chunking/test-scope-chunker.js";

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

// ── buildScopeTree: scope-tree shapes the flat suite does not cover ──

// INVARIANT CHANGED (bd tea-rags-mcp-dppnr): buildScopeTree returns the
// language-neutral `TestScope` of contracts/types/chunker.ts. A leaf is
// `children.length === 0` (was `isLeaf`) and a scope's own examples are
// `examples` (was `ownItBlocks`); the tree each case builds is unchanged.
describe("buildScopeTree — deeper scope shapes", () => {
  it("collects it blocks at the intermediate scope level", () => {
    const code = `describe('User', () => {
  it('is constructable with sensible defaults everywhere', () => {
    expect(new User()).toBeDefined();
  });

  describe('when admin', () => {
    it('has admin role', () => {
      expect(user.role).toBe('admin');
    });
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    // The intermediate scope keeps its own example; the child is separate.
    expect(scope.children.length).toBeGreaterThan(0);
    expect(scope.examples).toHaveLength(1);
    expect(scope.examples[0].text).toContain("is constructable");
    expect(scope.children).toHaveLength(1);
    expect(scope.children[0].examples).toHaveLength(1);
  });

  it("handles three-level nesting: only the innermost scope is a leaf", () => {
    const code = `describe('User', () => {
  describe('authenticated', () => {
    describe('admin', () => {
      it('can manage every resource in the system', () => {
        expect(user.can('manage')).toBe(true);
      });
    });
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.children.length).toBeGreaterThan(0);
    const mid = scope.children[0];
    expect(mid.name).toBe("describe 'authenticated'");
    expect(mid.children.length).toBeGreaterThan(0);
    const leaf = mid.children[0];
    expect(leaf.name).toBe("describe 'admin'");
    expect(leaf.children).toHaveLength(0);
    expect(leaf.examples).toHaveLength(1);
  });

  it("keeps a container call without any callback a childless leaf scope", () => {
    const code = `describe('User');`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.name).toBe("describe 'User'");
    expect(scope.children).toHaveLength(0);
    expect(scope.examples).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });

  it("names a no-argument container call after the method alone", () => {
    const code = `describe();`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.name).toBe("describe");
  });

  it("collects non-call statements in the body as otherLines", () => {
    const code = `describe('User', () => {
  const repo = buildRepo();

  it('validates name with full assertion coverage', () => {
    expect(repo.validate()).toBe(true);
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.children).toHaveLength(0);
    expect(scope.otherLines).toHaveLength(1);
    expect(scope.otherLines[0].text).toContain("const repo = buildRepo();");
    expect(scope.otherLines[0].sourceLine).toBe(2);
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): a parametrized example is read
  // through its parametrizer callee and claimed as ONE example named with
  // `.each` (was absorbed as otherLines and pasted into sibling examples).
  it("claims chained-call DSL (test.each) whose callee is a parametrizer call as an example", () => {
    const code = `describe('User', () => {
  test.each([1, 2])('handles case %d with a meaningful assertion body', () => {
    expect(true).toBe(true);
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.examples).toHaveLength(1);
    expect(scope.examples[0].name).toBe("test.each 'handles case %d with a meaningful assertion body'");
    expect(scope.otherLines.some((l) => l.text.includes("test.each"))).toBe(false);
  });
});

// ── produceScopeChunks: composition rules ────────────────────────────

describe("produceScopeChunks — composition rules", () => {
  it("includes a leaf's own setup and own statements in its chunk and in its line range", () => {
    const code = `describe('User', () => {
  beforeEach(() => { signIn(user); });

  const repo = buildRepo();

  it('validates name with full assertion coverage', () => {
    expect(repo.validate()).toBe(true);
  });

  it('validates email with full assertion coverage', () => {
    expect(user.email).toMatch(/@/);
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): one chunk per example, each
    // carrying the leaf's own setup and statements; its line range is the
    // example's own rows (was one leaf chunk spanning setup through last it).
    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the leaf's own setup and
    // non-DSL statements are ONE test_setup chunk the examples reference.
    const [setup, ...examples] = chunks;
    expect(setup.chunkType).toBe("test_setup");
    expect(setup.content).toContain("signIn(user)");
    expect(setup.content).toContain("const repo = buildRepo();");
    expect(examples).toHaveLength(2);
    for (const chunk of examples) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.content).not.toContain("signIn(user)");
      expect(chunk.setupScopeIds).toEqual(["User.describe 'User'"]);
    }
    expect([examples[0].startLine, examples[0].endLine]).toEqual([6, 8]);
    expect([examples[1].startLine, examples[1].endLine]).toEqual([10, 12]);
  });

  it("emits a test_setup chunk for a leaf scope holding only setup and other lines", () => {
    const code = `describe('database', () => {
  beforeAll(() => { migrateSchema(); });

  const pool = createPool();
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("migrateSchema()");
    expect(chunks[0].content).toContain("const pool = createPool();");
    expect(chunks[0].startLine).toBe(2);
    expect(chunks[0].endLine).toBe(4);
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): the root's own it is an example
  // chunk carrying the root's setup and statements (was a test_setup chunk
  // under the root scope id); the nested example inherits the root setup only.
  it("emits the root scope's own it as an example beside the nested describe's example", () => {
    const code = `describe('User', () => {
  beforeEach(() => { resetDb(); });

  const factory = makeFactory();

  it('is constructable with sensible defaults everywhere', () => {
    expect(new User()).toBeDefined();
  });

  describe('when admin', () => {
    it('has admin role and full permission set for management ops', () => {
      expect(user.role).toBe('admin');
    });
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the root's setup and
    // statements are its own test_setup chunk; both examples reference it.
    const [setup, root, nested] = chunks;
    expect(setup).toMatchObject({ chunkType: "test_setup", symbolId: "User.describe 'User'" });
    expect(setup.content).toContain("resetDb()");
    expect(setup.content).toContain("const factory = makeFactory();");

    expect(root.parentSymbolId).toBe("User.describe 'User'");
    expect(root.content).not.toContain("resetDb()");
    expect(root.content).toContain("is constructable");
    expect(root.content).not.toContain("has admin role");
    expect(root.setupScopeIds).toEqual(["User.describe 'User'"]);
    expect([root.startLine, root.endLine]).toEqual([6, 8]);

    expect(nested.parentSymbolId).toBe("User.describe 'when admin'");
    expect(nested.content).not.toContain("resetDb()");
    expect(nested.content).toContain("has admin role");
    expect(nested.setupScopeIds).toEqual(["User.describe 'User'"]);
    expect(chunks).toHaveLength(3);
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): an intermediate scope's own it
  // is an example chunk (was a test_setup chunk of the scope); the deepest
  // example inherits the intermediate setup and is addressed by its own id.
  it("emits an intermediate scope's own it as an example beside the deeper example", () => {
    const code = `describe('User', () => {
  describe('validations', () => {
    beforeEach(() => { loadFixtures(); });

    const validator = buildValidator();

    it('rejects an empty name with a meaningful validation message', () => {
      expect(validateName('')).toBe(false);
    });

    describe('when admin', () => {
      it('has admin role and full permission set for management ops', () => {
        expect(user.role).toBe('admin');
      });
    });
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the intermediate scope's setup
    // and statements are its own test_setup chunk; both examples reference it.
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].symbolId).toBe("User.describe 'validations'");
    expect(setupChunks[0].content).toContain("loadFixtures()");
    expect(setupChunks[0].content).toContain("const validator = buildValidator();");
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(2);
    // The intermediate 'validations' scope's own example…
    expect(testChunks[0].symbolId).toBe(
      "User.describe 'validations'.it 'rejects an empty name with a meaningful validation message'",
    );
    expect(testChunks[0].setupScopeIds).toEqual(["User.describe 'validations'"]);
    // …and the deepest example still chunks separately, referencing ancestor setup.
    expect(testChunks[1].symbolId).toBe(
      "User.describe 'when admin'.it 'has admin role and full permission set for management ops'",
    );
    expect(testChunks[1].setupScopeIds).toEqual(["User.describe 'validations'"]);
    expect(testChunks[1].content).toContain("has admin role");
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): an example under the minimum
  // size is never dropped — a lone one stays its own chunk.
  it("keeps a lone example whose content sits under the minimum size", () => {
    const code = `describe('tiny', () => {
  it('x', () => {});
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    expect(chunks.map((c) => c.symbolId)).toEqual(["tiny.describe 'tiny'.it 'x'"]);
  });

  it("splits an oversized leaf without shared setup into bare per-it chunks, skipping fragments under the floor", () => {
    const longBody = "    expect(result).toBe('x');\n".repeat(6);
    const code = `describe('User', () => {
  describe('validations', () => {
    it('validates name', () => {
${longBody}    });

    it('x', () => {});

    it('validates email', () => {
${longBody}    });
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, { maxChunkSize: 100 });

    // No setup/other lines exist, so each split part is just its it block.
    // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): the per-it chunks are
    // addressed by their own example ids under the shared scope parent.
    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the tiny it ('x') is kept as
    // its own chunk — it has no tiny sibling to group with.
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.parentSymbolId).toBe("User.describe 'validations'");
      expect(chunk.content).not.toContain("beforeEach");
    }
    expect(chunks.map((c) => c.symbolId)).toEqual([
      "User.describe 'validations'.it 'validates name'",
      "User.describe 'validations'.it 'x'",
      "User.describe 'validations'.it 'validates email'",
    ]);
  });

  it("falls back to the full scope name for parentSymbolId when the first arg is neither a string nor an identifier", () => {
    const code = `describe(loadRole(), () => {
  it('returns a role with permissions of meaningful length', () => {
    expect(role.permissions.length).toBeGreaterThan(0);
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): the chunk is the example; the
    // degraded top-level name still repeats the full scope name in its parent
    // scope id (was the scope chunk itself).
    expect(chunks).toHaveLength(1);
    // Both the top-level name and the scope's own name degrade to the full
    // formatted scope name, so the composed scope id repeats it.
    expect(chunks[0].parentSymbolId).toBe("describe loadRole().describe loadRole()");
    expect(chunks[0].name).toBe("it 'returns a role with permissions of meaningful length'");
    expect(chunks[0].symbolId).toBe(
      "describe loadRole().describe loadRole().it 'returns a role with permissions of meaningful length'",
    );
  });

  it("uses an identifier first arg as parentSymbolId (describe(User, ...) idiom)", () => {
    const code = `describe(User, () => {
  it('validates name with full assertion coverage', () => {
    expect(user.name).toBeDefined();
  });
});`;

    const tree = parseJs(code);
    const chunks = produceScopeChunks(findTopLevelCall(tree), code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-dppnr): the example's parent is its
    // scope id, whose first segment is the identifier top-level name `User`.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentSymbolId).toBe("User.describe User");
    expect(chunks[0].name).toBe("it 'validates name with full assertion coverage'");
  });
});
