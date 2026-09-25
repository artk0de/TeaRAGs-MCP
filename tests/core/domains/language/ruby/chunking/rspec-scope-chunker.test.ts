import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  buildScopeTree,
  produceScopeChunks,
} from "../../../../../../src/core/domains/language/ruby/chunking/rspec-scope-chunker.js";

// ── Helpers ──────────────────────────────────────────────────────────

function parseRuby(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Ruby);
  return parser.parse(code);
}

/** Find the first top-level `call` node (describe/shared_examples/etc.) */
function findTopLevelCall(tree: Parser.Tree): Parser.SyntaxNode {
  for (const child of tree.rootNode.children) {
    if (child.type === "call") return child;
  }
  throw new Error("No top-level call node found");
}

const defaultConfig = { maxChunkSize: 5000 };

// ── buildScopeTree ───────────────────────────────────────────────────

describe("buildScopeTree", () => {
  it("should build a single leaf scope from describe with only it blocks", () => {
    const code = `describe User do
  it 'validates name' do
    expect(user.name).to be_present
  end

  it 'validates email' do
    expect(user.email).to be_present
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.name).toBe("describe User");
    expect(scope.children).toHaveLength(0);
    expect(scope.examples).toHaveLength(2);
    expect(scope.children).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });

  it("should build intermediate + leaf scopes", () => {
    const code = `describe User do
  context 'when admin' do
    it 'has admin role' do
      expect(user.role).to eq('admin')
    end
  end

  context 'when guest' do
    it 'has guest role' do
      expect(user.role).to eq('guest')
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.children.length).toBeGreaterThan(0);
    expect(scope.children).toHaveLength(2);
    expect(scope.children[0].name).toBe("context 'when admin'");
    expect(scope.children[0].children).toHaveLength(0);
    expect(scope.children[1].name).toBe("context 'when guest'");
    expect(scope.children[1].children).toHaveLength(0);
  });

  it("should collect setup lines (let, before, subject) at each level", () => {
    const code = `describe User do
  let(:user) { create(:user) }
  before { sign_in(user) }

  context 'when admin' do
    subject { user.admin? }

    it 'returns true' do
      is_expected.to be true
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.setupLines).toHaveLength(2);
    expect(scope.setupLines[0].text).toContain("let(:user)");
    expect(scope.setupLines[1].text).toContain("before");

    const childScope = scope.children[0];
    expect(childScope.setupLines).toHaveLength(1);
    expect(childScope.setupLines[0].text).toContain("subject");
  });

  it("should collect it blocks at intermediate scope level", () => {
    const code = `describe User do
  it 'exists' do
    expect(User).to be_truthy
  end

  context 'when admin' do
    it 'has admin role' do
      expect(user.role).to eq('admin')
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    expect(scope.children.length).toBeGreaterThan(0);
    expect(scope.examples).toHaveLength(1);
    expect(scope.examples[0].text).toContain("it 'exists'");
    expect(scope.children).toHaveLength(1);
  });

  it("should handle deep nesting (3+ levels)", () => {
    const code = `describe User do
  context 'when authenticated' do
    context 'as admin' do
      context 'with permissions' do
        it 'can manage' do
          expect(true).to be true
        end
      end
    end
  end
end`;

    const tree = parseRuby(code);
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
});

// ── produceScopeChunks ───────────────────────────────────────────────

describe("produceScopeChunks", () => {
  it("should produce one test chunk per example of a leaf scope", () => {
    const code = `describe User do
  it 'validates name' do
    expect(user.name).to be_present
    expect(user).to be_valid
  end

  it 'validates email' do
    expect(user.email).to be_present
    expect(user).to be_valid
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): the unit is the example, not
    // the leaf scope — two `it` blocks are two chunks, each parented to the
    // scope id instead of the bare top-level name (kernel emission, msv3l).
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.chunkType === "test")).toBe(true);
    expect(chunks[0].content).toContain("validates name");
    expect(chunks[1].content).toContain("validates email");
    expect(chunks[0].parentSymbolId).toBe("User.describe User");
  });

  it("should inject parent setup into leaf chunks", () => {
    const code = `describe User do
  let(:user) { create(:user) }
  before { sign_in(user) }

  context 'when admin' do
    it 'has admin role' do
      expect(user.role).to eq('admin')
      expect(user).to be_admin
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    // Parent setup should be injected into the leaf chunk content
    expect(chunks[0].content).toContain("let(:user)");
    expect(chunks[0].content).toContain("before");
    expect(chunks[0].content).toContain("has admin role");
    // But line range should NOT span back to parent setup lines
    // Parent setup is at lines 2-3, context starts at line 5
    expect(chunks[0].startLine).toBeGreaterThanOrEqual(5);
  });

  it("should produce test_setup chunk for intermediate scope with own it blocks", () => {
    const code = `describe User do
  it 'is a class that works correctly and has many features' do
    expect(User).to be_truthy
    expect(User.new).to be_a(User)
  end

  context 'when admin' do
    it 'has admin role and permissions for everything' do
      expect(user.role).to eq('admin')
      expect(user).to be_admin
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): an intermediate scope's own
    // `it` is an example like any other — a `test` chunk, not a `test_setup`
    // block of the scope. Two examples → two test chunks, no setup chunk.
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(2);
    expect(setupChunks).toHaveLength(0);
    expect(testChunks[0].content).toContain("is a class that works correctly");
  });

  it("should split oversized leaf by it blocks when exceeding maxChunkSize", () => {
    const longAssertion = "    expect(result).to eq('x')\n".repeat(20);
    const code = `describe User do
  context 'validations' do
    it 'validates name' do
${longAssertion}    end

    it 'validates email' do
${longAssertion}    end

    it 'validates phone' do
${longAssertion}    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    // Use a small maxChunkSize to trigger splitting
    const chunks = produceScopeChunks(scope, code, { maxChunkSize: 300 });

    // Each it block should become its own chunk
    expect(chunks.length).toBe(3);
    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): each example chunk carries its
    // OWN id under the scope, no longer the shared scope id (test-spec-chunking.md).
    expect(chunks.map((c) => c.symbolId)).toEqual([
      "User.context 'validations'.it 'validates name'",
      "User.context 'validations'.it 'validates email'",
      "User.context 'validations'.it 'validates phone'",
    ]);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.parentSymbolId).toBe("User.context 'validations'");
    }
  });

  it("should produce test_setup for setup-only leaf scope", () => {
    const code = `describe User do
  context 'shared setup for all user tests with many configurations' do
    let(:user) { create(:user, role: 'admin', active: true, verified: true) }
    before { sign_in(user) }
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("let(:user)");
  });

  it("should use 2-level symbolId format: TopLevelName.leafScopeName", () => {
    const code = `describe User do
  context 'when admin' do
    it 'has permissions for managing all system resources' do
      expect(user).to be_admin
      expect(user.permissions).to include(:manage)
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): the chunk is the EXAMPLE —
    // `<Top>.<scope>.<example>`, parented to the `<Top>.<scope>` leaf-scope id
    // that search-cascade drill-downs already address.
    expect(chunks[0].symbolId).toBe("User.context 'when admin'.it 'has permissions for managing all system resources'");
    expect(chunks[0].parentSymbolId).toBe("User.context 'when admin'");
    expect(chunks[0].name).toBe("it 'has permissions for managing all system resources'");
  });

  it("should handle RSpec.describe form (receiver-qualified call)", () => {
    const code = `RSpec.describe User do
  it 'validates name and ensures correct behavior overall' do
    expect(user.name).to be_present
    expect(user).to be_valid
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toContain("User");
    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): an example's parent is its
    // scope id (`<Top>.<root scope>`), not the bare top-level name.
    expect(chunks[0].parentSymbolId).toBe("User.RSpec.describe User");
  });

  it("should handle shared_examples at file root (symbolId fallback)", () => {
    const code = `shared_examples 'authenticable resource with standard behavior' do
  it 'responds to authenticate method and validates credentials' do
    expect(subject).to respond_to(:authenticate)
    expect(subject.authenticate('password')).to be_truthy
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    // shared_examples uses string arg as name
    expect(chunks[0].symbolId).toContain("authenticable resource with standard behavior");
  });

  it("should include shoulda one-liners as content in leaf scope", () => {
    const code = `describe User do
  context 'validations' do
    it { is_expected.to validate_presence_of(:name) }
    it { is_expected.to validate_presence_of(:email) }
    it { is_expected.to validate_uniqueness_of(:username) }
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    // Shoulda one-liners might not be parsed as `it` calls with do blocks
    // They should still appear in the scope tree somehow
    const leafScope = scope.children[0];
    expect(leafScope.children).toHaveLength(0);
  });

  it("should produce no chunks for empty describe block", () => {
    const code = `describe User do
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(0);
  });

  it("should capture let! as setup", () => {
    const code = `describe User do
  context 'with eager loaded data and complex test setup' do
    let!(:user) { create(:user, name: 'John', email: 'john@example.com') }

    it 'finds the user in the database automatically' do
      expect(User.find_by(name: 'John')).to eq(user)
      expect(User.count).to eq(1)
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    const leafScope = scope.children[0];
    // let! should be captured as setup
    expect(leafScope.setupLines.length).toBeGreaterThanOrEqual(1);
    const setupTexts = leafScope.setupLines.map((s) => s.text);
    expect(setupTexts.some((t) => t.includes("let!"))).toBe(true);
  });

  it("should use scope name fallback when no named argument found in extractTopLevelName", () => {
    // describe with a method call argument instead of constant/string
    const code = `describe some_helper_method do
  it 'works correctly and returns expected values' do
    expect(subject).to be_truthy
    expect(subject.valid?).to be true
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // extractTopLevelName falls back to scope.name when no constant/string arg
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toBeDefined();
  });

  it("should collect otherLines for non-call statements in block body", () => {
    const code = `describe User do
  ROLES = %w[admin user guest].freeze

  it 'validates name' do
    expect(user.name).to be_present
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    // ROLES assignment is not a call node (it's an assignment), should be in otherLines
    expect(scope.otherLines.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle describe with no block body (empty call)", () => {
    // A describe call that has no do_block/block child
    const code = `describe(User)`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);

    // Should return scope with isLeaf=true and no children/setup/it blocks
    expect(scope.children).toHaveLength(0);
    expect(scope.children).toHaveLength(0);
    expect(scope.examples).toHaveLength(0);
    expect(scope.setupLines).toHaveLength(0);
  });
});

// ── produceScopeChunks edge cases ────────────────────────────────────

describe("produceScopeChunks edge cases", () => {
  it("should skip chunks with content shorter than 50 characters", () => {
    const code = `describe User do
  context 'tiny' do
    it 'ok' do
      expect(1).to eq(1)
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // Content is very short — should be filtered out (< 50 chars)
    expect(chunks).toHaveLength(0);
  });

  it("should include otherLines in leaf scope test chunk content", () => {
    const code = `describe User do
  context 'with constants and configuration settings' do
    TIMEOUT = 30
    MAX_RETRIES = 3
    DEFAULT_ROLE = 'user'

    it 'uses correct timeout for all API operations' do
      expect(described_class::TIMEOUT).to eq(30)
      expect(described_class::MAX_RETRIES).to eq(3)
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // otherLines should appear in the content
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle intermediate scope with setup, it blocks, and child contexts", () => {
    const code = `describe User do
  let(:user) { create(:user, name: 'Test', email: 'test@example.com') }
  before { DatabaseCleaner.clean }

  it 'is a class that exists and can be instantiated properly' do
    expect(User).to be_a(Class)
    expect(User.new).to be_a(User)
  end

  context 'when admin with elevated privileges and full access' do
    it 'has admin role and can manage all system resources' do
      expect(user.role).to eq('admin')
      expect(user).to be_admin
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): the root's own `it` is an
    // example chunk (`test`) carrying the root's setup, and the nested example
    // inherits that setup too — no `test_setup` block for the root.
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(2);
    expect(setupChunks).toHaveLength(0);
    expect(testChunks[0].content).toContain("is a class that exists");
    expect(testChunks[0].content).toContain("let(:user)");
    expect(testChunks[1].content).toContain("let(:user)");
    expect(testChunks[1].content).toContain("has admin role and can manage");
  });

  it("should produce test_setup for leaf scope with only setup lines", () => {
    const code = `describe User do
  context 'shared configuration for test suite with extensive setup' do
    let(:user) { create(:user, role: 'admin', active: true, verified: true) }
    let(:config) { { timeout: 30, retries: 3, cache: true, debug: false } }
    before { sign_in(user) }
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].content).toContain("let(:user)");
    expect(chunks[0].content).toContain("let(:config)");
  });

  it("should use scope name as fallback when no named argument found", () => {
    // shared_examples with string arg should use the string as name
    const code = `shared_examples 'a sortable collection with pagination support' do
  it 'responds to sort method and returns ordered results' do
    expect(subject).to respond_to(:sort)
    expect(subject.sort).to eq(subject.sort)
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolId).toContain("a sortable collection with pagination support");
  });

  it("should handle root scope with own it blocks, setup, and otherLines when non-leaf", () => {
    const code = `describe AuthenticationService do
  let(:service) { described_class.new(config: test_config) }
  TIMEOUT = 30

  it 'can be instantiated with default configuration settings' do
    expect(service).to be_a(AuthenticationService)
    expect(service.config).to eq(test_config)
  end

  context 'when authenticating with valid credentials and tokens' do
    it 'returns a valid authentication token for the user' do
      result = service.authenticate(username: 'admin', password: 'secret')
      expect(result).to be_a(String)
      expect(result.length).to be > 20
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // Root is non-leaf (has context child) but also has own it block + setup + otherLines
    // Should produce: test chunk for leaf + test_setup for root's it block
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("can be instantiated");
    expect(allContent).toContain("returns a valid authentication token");

    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): the root's own example is a
    // `test` chunk carrying the root's setup and otherLines (was `test_setup`).
    const rootExample = chunks.find((c) => c.chunkType === "test" && c.content.includes("can be instantiated"));
    expect(rootExample).toBeDefined();
    expect(rootExample!.content).toContain("let(:service)");
    expect(rootExample!.content).toContain("TIMEOUT = 30");
  });

  it("should produce test_setup for intermediate scope with setup, otherLines, it blocks, and children", () => {
    const code = `describe User do
  context 'authentication with various credential types' do
    let(:credentials) { { username: 'admin', password: 'secret123' } }
    before { AuthService.configure(timeout: 30, retries: 3) }
    RETRY_COUNT = 3

    it 'validates credentials format before authentication attempt' do
      expect(AuthService.valid_format?(credentials)).to be true
      expect(credentials[:username]).to be_present
    end

    context 'with valid credentials and active session' do
      it 'authenticates successfully and returns token' do
        result = AuthService.authenticate(credentials)
        expect(result).to be_a(String)
        expect(result.length).to be > 20
      end
    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // INVARIANT CHANGED (bd tea-rags-mcp-99gkm): the intermediate scope's own
    // example is a `test` chunk with that scope's setup + otherLines; the
    // nested leaf example inherits the intermediate setup. No `test_setup`.
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks).toHaveLength(0);

    const authExample = chunks.find((c) => c.content.includes("validates credentials format"));
    expect(authExample).toBeDefined();
    expect(authExample!.chunkType).toBe("test");
    expect(authExample!.content).toContain("let(:credentials)");
    expect(authExample!.content).toContain("AuthService.configure");
    expect(authExample!.content).toContain("RETRY_COUNT = 3");

    const leafExample = chunks.find((c) => c.content.includes("authenticates successfully"));
    expect(leafExample!.content).toContain("let(:credentials)");
  });

  it("should handle leaf scope with setup, otherLines, but no it blocks producing test_setup", () => {
    const code = `describe User do
  context 'comprehensive shared test configuration and helpers' do
    let(:user) { create(:user, role: 'admin', active: true, verified: true) }
    let(:config) { { timeout: 30, retries: 3, cache_enabled: true, debug: false } }
    before { sign_in(user) }
    subject { described_class.new(user: user, config: config) }
    CONSTANT = 'test_value'
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    // Leaf with only setup lines → test_setup with correct line ranges
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
    expect(chunks[0].startLine).toBeGreaterThan(0);
    expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
  });

  it("should classify leaf scope with include_examples as test, not test_setup", () => {
    const code = `describe User do
  context 'when using shared behavior for authentication and authorization' do
    include_examples 'authenticable resource'
    include_examples 'authorizable resource'
    it_behaves_like 'a trackable entity with audit logging'
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    // Should be "test" because include_examples/it_behaves_like delegate to actual tests
    expect(chunks[0].chunkType).toBe("test");
  });

  it("should keep test_setup for leaf scope with only let/before (no shared examples)", () => {
    const code = `describe User do
  context 'comprehensive shared test configuration and helpers' do
    let(:user) { create(:user, role: 'admin', active: true, verified: true) }
    let(:config) { { timeout: 30, retries: 3, cache_enabled: true, debug: false } }
    before { sign_in(user) }
    subject { described_class.new(user: user, config: config) }
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    const chunks = produceScopeChunks(scope, code, defaultConfig);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test_setup");
  });

  it("should skip sub-chunks shorter than 50 chars during oversized split", () => {
    const longAssertion = "    expect(result).to eq('x')\n".repeat(20);
    const code = `describe User do
  context 'validations' do
    it 'validates name thoroughly' do
${longAssertion}    end

    it 'ok' do
      expect(1).to eq(1)
    end

    it 'validates email thoroughly' do
${longAssertion}    end
  end
end`;

    const tree = parseRuby(code);
    const node = findTopLevelCall(tree);
    const scope = buildScopeTree(node, code);
    // Trigger oversized split
    const chunks = produceScopeChunks(scope, code, { maxChunkSize: 300 });

    // The 'ok' it block is very short — should be skipped (< 50 chars after trim)
    // Only the two long it blocks should produce chunks
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(50);
    }
  });
});

// ── Example-level emission through the kernel (bd tea-rags-mcp-99gkm) ─

describe("produceScopeChunks — addressable examples (bd tea-rags-mcp-99gkm)", () => {
  function chunksOf(code: string, config = defaultConfig) {
    const node = findTopLevelCall(parseRuby(code));
    return produceScopeChunks(buildScopeTree(node, code), code, config);
  }

  it("gives every example of a root leaf its own id (taxdome worker_spec reproducer shape)", () => {
    const examples = Array.from(
      { length: 16 },
      (_, i) => `  it 'handles operation case number ${i}' do\n    expect(worker.perform(${i})).to be_truthy\n  end\n`,
    ).join("\n");
    const code = `RSpec.describe Platform::Async::Operation::Worker do\n  let(:worker) { described_class.new }\n\n${examples}end`;

    const chunks = chunksOf(code);

    expect(chunks).toHaveLength(16);
    expect(new Set(chunks.map((c) => c.symbolId)).size).toBe(16);
    expect(chunks[0].symbolId).toBe(
      "Platform::Async::Operation::Worker.RSpec.describe Platform::Async::Operation::Worker.it 'handles operation case number 0'",
    );
    for (const chunk of chunks) {
      expect(chunk.parentSymbolId).toBe(
        "Platform::Async::Operation::Worker.RSpec.describe Platform::Async::Operation::Worker",
      );
      expect(chunk.parentType).toBe("test_scope");
      expect(chunk.content).toContain("let(:worker)");
    }
  });

  it("disambiguates repeated example descriptions with ~N in source order", () => {
    const code = `describe User do
  it 'is valid with the factory defaults and all attributes' do
    expect(build(:user)).to be_valid
  end

  it 'is valid with the factory defaults and all attributes' do
    expect(build(:user, :admin)).to be_valid
  end
end`;

    const ids = chunksOf(code).map((c) => c.symbolId);

    expect(ids).toEqual([
      "User.describe User.it 'is valid with the factory defaults and all attributes'",
      "User.describe User.it 'is valid with the factory defaults and all attributes'~2",
    ]);
  });

  it("names a description-less one-liner by its own line, a multi-line block by its call", () => {
    const code = `describe User do
  let(:user) { create(:user, name: 'John', email: 'john@example.com') }

  it { is_expected.to validate_presence_of(:name) }
  its(:email) { is_expected.to eq('john@example.com') }
  specify do
    expect(user).to be_persisted
  end
end`;

    const names = chunksOf(code).map((c) => c.name);

    expect(names).toEqual([
      "it { is_expected.to validate_presence_of(:name) }",
      "its(:email) { is_expected.to eq('john@example.com') }",
      "specify",
    ]);
  });

  it("keeps each example's line range on the example's own rows", () => {
    const code = `describe User do
  let(:user) { create(:user) }

  context 'when admin' do
    before { user.update!(role: 'admin', verified: true) }

    it 'can invite other members to the workspace' do
      expect(user.can_invite?).to be true
    end
  end
end`;

    const [chunk] = chunksOf(code);

    expect(chunk.startLine).toBe(7);
    expect(chunk.endLine).toBe(9);
  });

  it("marks it_behaves_like / include_examples setup lines as delegating examples", () => {
    const code = `describe User do
  context 'with shared behaviour' do
    let(:resource) { create(:user) }
    it_behaves_like 'an auditable resource'
    include_examples 'a searchable resource'
  end
end`;

    const tree = buildScopeTree(findTopLevelCall(parseRuby(code)), code);
    const lines = tree.children[0].setupLines;

    expect(lines.map((l) => l.delegatesExamples === true)).toEqual([false, true, true]);
  });

  it("does not classify a let whose text merely mentions a shared-example call as delegating", () => {
    const code = `describe User do
  context 'with a helper named after shared examples' do
    let(:include_examples_flag) { true }
    let(:it_behaves_like_label) { 'shared examples label for the user' }
  end
end`;

    const [chunk] = chunksOf(code);

    // Only a real it_behaves_like / include_examples CALL delegates; a let name
    // containing the word does not (the pre-kernel text.includes() check did).
    expect(chunk.chunkType).toBe("test_setup");
  });
});
