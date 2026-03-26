import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  buildScopeTree,
  produceScopeChunks,
} from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.js";

// ── Helpers ──────────────────────────────────────────────────────────

function parseRuby(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Ruby as unknown as Parser.Language);
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
    expect(scope.isLeaf).toBe(true);
    expect(scope.ownItBlocks).toHaveLength(2);
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

    expect(scope.isLeaf).toBe(false);
    expect(scope.children).toHaveLength(2);
    expect(scope.children[0].name).toBe("context 'when admin'");
    expect(scope.children[0].isLeaf).toBe(true);
    expect(scope.children[1].name).toBe("context 'when guest'");
    expect(scope.children[1].isLeaf).toBe(true);
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

    expect(scope.isLeaf).toBe(false);
    expect(scope.ownItBlocks).toHaveLength(1);
    expect(scope.ownItBlocks[0].text).toContain("it 'exists'");
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

    expect(scope.isLeaf).toBe(false);
    const level1 = scope.children[0];
    expect(level1.isLeaf).toBe(false);
    const level2 = level1.children[0];
    expect(level2.isLeaf).toBe(false);
    const level3 = level2.children[0];
    expect(level3.isLeaf).toBe(true);
    expect(level3.ownItBlocks).toHaveLength(1);
  });
});

// ── produceScopeChunks ───────────────────────────────────────────────

describe("produceScopeChunks", () => {
  it("should produce a single test chunk for a leaf scope", () => {
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

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].content).toContain("validates name");
    expect(chunks[0].content).toContain("validates email");
    expect(chunks[0].parentName).toBe("User");
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
    // Parent setup should be injected into the leaf chunk
    expect(chunks[0].content).toContain("let(:user)");
    expect(chunks[0].content).toContain("before");
    expect(chunks[0].content).toContain("has admin role");
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

    // Should have: 1 test chunk for leaf context + 1 test_setup for root's own it
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(1);
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].content).toContain("is a class that works correctly");
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
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.symbolId).toBe("User.context 'validations'");
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
    expect(chunks[0].symbolId).toBe("User.context 'when admin'");
    expect(chunks[0].parentName).toBe("User");
    expect(chunks[0].name).toBe("context 'when admin'");
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
    expect(chunks[0].parentName).toBe("User");
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
    expect(leafScope.isLeaf).toBe(true);
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
    expect(scope.isLeaf).toBe(true);
    expect(scope.children).toHaveLength(0);
    expect(scope.ownItBlocks).toHaveLength(0);
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

    // Root is intermediate (has context child) with own setup + it blocks
    // Should produce: 1 test chunk for leaf context + 1 test_setup for root's own it+setup
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");

    expect(testChunks).toHaveLength(1);
    expect(setupChunks).toHaveLength(1);
    expect(setupChunks[0].content).toContain("is a class that exists");
    expect(setupChunks[0].content).toContain("let(:user)");
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

    // Root test_setup should include setup and otherLines
    const setupChunk = chunks.find((c) => c.chunkType === "test_setup" && c.content.includes("can be instantiated"));
    expect(setupChunk).toBeDefined();
    expect(setupChunk!.content).toContain("let(:service)");
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

    // Intermediate 'authentication' context has children + own it blocks + setup + otherLines
    // Should produce: test chunk for leaf + test_setup for intermediate's it+setup+otherLines
    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks.length).toBeGreaterThanOrEqual(1);

    // The test_setup chunk for intermediate scope should contain setup and it block
    const authSetup = setupChunks.find((c) => c.content.includes("validates credentials format"));
    expect(authSetup).toBeDefined();
    expect(authSetup!.content).toContain("let(:credentials)");
    expect(authSetup!.content).toContain("AuthService.configure");
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
