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
    expect(scope.isLeaf).toBe(false);
    expect(scope.ownItBlocks).toHaveLength(1);
    expect(scope.ownItBlocks[0].text).toContain("is constructable");
    expect(scope.children).toHaveLength(1);
    expect(scope.children[0].ownItBlocks).toHaveLength(1);
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

    expect(scope.isLeaf).toBe(false);
    const mid = scope.children[0];
    expect(mid.name).toBe("describe 'authenticated'");
    expect(mid.isLeaf).toBe(false);
    const leaf = mid.children[0];
    expect(leaf.name).toBe("describe 'admin'");
    expect(leaf.isLeaf).toBe(true);
    expect(leaf.ownItBlocks).toHaveLength(1);
  });

  it("keeps a container call without any callback a childless leaf scope", () => {
    const code = `describe('User');`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    expect(scope.name).toBe("describe 'User'");
    expect(scope.isLeaf).toBe(true);
    expect(scope.children).toHaveLength(0);
    expect(scope.ownItBlocks).toHaveLength(0);
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

    expect(scope.isLeaf).toBe(true);
    expect(scope.otherLines).toHaveLength(1);
    expect(scope.otherLines[0].text).toContain("const repo = buildRepo();");
    expect(scope.otherLines[0].sourceLine).toBe(2);
  });

  it("absorbs chained-call DSL (test.each) whose callee is itself a call as otherLines", () => {
    const code = `describe('User', () => {
  test.each([1, 2])('handles case %d with a meaningful assertion body', () => {
    expect(true).toBe(true);
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);

    // The outermost callee is a call_expression, so no method name is readable:
    // the statement is preserved as otherLines rather than claimed as an example.
    expect(scope.ownItBlocks).toHaveLength(0);
    expect(scope.otherLines.some((l) => l.text.includes("test.each"))).toBe(true);
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
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    // Own setup is part of the content…
    expect(chunks[0].content).toContain("signIn(user)");
    // …and so are the leaf's own non-DSL statements.
    expect(chunks[0].content).toContain("const repo = buildRepo();");
    // Line range spans the leaf's own lines — the beforeEach at line 2 through
    // the closing row of the last it block.
    expect(chunks[0].startLine).toBe(2);
    expect(chunks[0].endLine).toBe(12);
  });

  it("emits a test_setup chunk for a leaf scope holding only setup and other lines", () => {
    const code = `describe('database', () => {
  beforeAll(() => { migrateSchema(); });

  const pool = createPool();
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("migrateSchema()");
    expect(chunks[0].content).toContain("const pool = createPool();");
    expect(chunks[0].startLine).toBe(2);
    expect(chunks[0].endLine).toBe(4);
  });

  it("emits a test_setup chunk for a root scope holding its own it blocks beside nested describes", () => {
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
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // One test chunk for the leaf, plus a test_setup chunk for the root's own
    // its — with the root's own setup and statements along for the ride.
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].symbolId).toBe("User.describe 'User'");
    expect(setupChunks[0].content).toContain("resetDb()");
    expect(setupChunks[0].content).toContain("const factory = makeFactory();");
    expect(setupChunks[0].content).toContain("is constructable");
    expect(setupChunks[0].content).not.toContain("has admin role");
    expect(setupChunks[0].startLine).toBe(2);
    expect(setupChunks[0].endLine).toBe(8);

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0].content).toContain("has admin role");
  });

  it("emits a test_setup chunk for an intermediate scope holding its own it blocks", () => {
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
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // The intermediate 'validations' scope gets its own test_setup chunk…
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].symbolId).toBe("User.describe 'validations'");
    expect(setupChunks[0].content).toContain("loadFixtures()");
    expect(setupChunks[0].content).toContain("const validator = buildValidator();");
    expect(setupChunks[0].content).toContain("rejects an empty name");
    // …and the deepest leaf still chunks separately, inheriting ancestor setup.
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0].symbolId).toBe("User.describe 'when admin'");
    expect(testChunks[0].content).toContain("loadFixtures()");
    expect(testChunks[0].content).toContain("has admin role");
  });

  it("produces no chunks when a scope's composed content sits under the minimum size", () => {
    const code = `describe('tiny', () => {
  it('x', () => {});
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(0);
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
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, { maxChunkSize: 100 });

    // No setup/other lines exist, so each split part is just its it block —
    // and the tiny it ('x') drops below the minimum-size floor and is skipped.
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.symbolId).toBe("User.describe 'validations'");
      expect(chunk.content).not.toContain("beforeEach");
    }
    expect(chunks.map((c) => c.content)).not.toContain("it('x', () => {});");
  });

  it("falls back to the full scope name for parentSymbolId when the first arg is neither a string nor an identifier", () => {
    const code = `describe(loadRole(), () => {
  it('returns a role with permissions of meaningful length', () => {
    expect(role.permissions.length).toBeGreaterThan(0);
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentSymbolId).toBe("describe loadRole()");
    // Both the top-level name and the scope's own name degrade to the full
    // formatted scope name, so the composed symbolId repeats it.
    expect(chunks[0].name).toBe("describe loadRole()");
    expect(chunks[0].symbolId).toBe("describe loadRole().describe loadRole()");
  });

  it("uses an identifier first arg as parentSymbolId (describe(User, ...) idiom)", () => {
    const code = `describe(User, () => {
  it('validates name with full assertion coverage', () => {
    expect(user.name).toBeDefined();
  });
});`;

    const tree = parseJs(code);
    const scope = buildScopeTree(findTopLevelCall(tree), code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentSymbolId).toBe("User");
    expect(chunks[0].name).toBe("describe User");
  });
});
