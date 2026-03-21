import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rspecFilterHook } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-filter.js";

// Helper: parse Ruby code and find all `call` nodes at any depth
function parseAndFindCalls(code: string): { node: Parser.SyntaxNode; code: string }[] {
  const parser = new Parser();
  parser.setLanguage(Ruby as unknown as Parser.Language);
  const tree = parser.parse(code);
  const calls: Parser.SyntaxNode[] = [];
  const traverse = (n: Parser.SyntaxNode) => {
    if (n.type === "call") calls.push(n);
    for (const child of n.children) traverse(child);
  };
  traverse(tree.rootNode);
  return calls.map((node) => ({ node, code }));
}

describe("rspecFilterHook", () => {
  describe("filterNode", () => {
    it("should return undefined for non-call nodes", () => {
      const parser = new Parser();
      parser.setLanguage(Ruby as unknown as Parser.Language);
      const tree = parser.parse("class Foo; end");
      const classNode = tree.rootNode.children[0];
      expect(classNode.type).toBe("class");

      const result = rspecFilterHook.filterNode!(classNode, "class Foo; end", "spec/models/foo_spec.rb");
      expect(result).toBeUndefined();
    });

    it("should reject call nodes in non-spec Ruby files", () => {
      const calls = parseAndFindCalls("describe User do\nend");
      expect(calls.length).toBeGreaterThan(0);

      const result = rspecFilterHook.filterNode!(calls[0].node, calls[0].code, "app/models/user.rb");
      expect(result).toBe(false);
    });

    it("should accept describe call in spec files", () => {
      const code = "describe User do\nend";
      const calls = parseAndFindCalls(code);
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should accept context call in spec files", () => {
      const code = "context 'when admin' do\nend";
      const calls = parseAndFindCalls(code);
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should accept it call with do block in spec files", () => {
      const code = "it 'works' do\n  expect(true).to be true\nend";
      const calls = parseAndFindCalls(code);
      // Find the `it` call (not `expect`)
      const itCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "it";
      });
      expect(itCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(itCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should reject shoulda one-liner it { is_expected.to ... }", () => {
      const code = "it { is_expected.to validate_presence_of(:name) }";
      const calls = parseAndFindCalls(code);
      const itCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "it";
      });
      expect(itCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(itCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(false);
    });

    it("should reject random method calls in spec files", () => {
      const code = "puts 'hello'";
      const calls = parseAndFindCalls(code);
      expect(calls.length).toBeGreaterThan(0);
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/models/user_spec.rb");
      expect(result).toBe(false);
    });

    it("should accept RSpec.describe (method call on constant)", () => {
      const code = "RSpec.describe User do\nend";
      const calls = parseAndFindCalls(code);
      // Top-level call is RSpec.describe
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should accept shared_examples in spec files", () => {
      const code = "shared_examples 'authenticable' do\nend";
      const calls = parseAndFindCalls(code);
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/support/shared_examples.rb");
      expect(result).toBe(true);
    });

    it("should accept feature call in spec files", () => {
      const code = "feature 'User login' do\nend";
      const calls = parseAndFindCalls(code);
      const result = rspecFilterHook.filterNode!(calls[0].node, code, "spec/features/login_spec.rb");
      expect(result).toBe(true);
    });

    it("should accept specify call in spec files", () => {
      const code = "specify 'something works' do\n  expect(true).to be true\nend";
      const calls = parseAndFindCalls(code);
      const specifyCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "specify";
      });
      expect(specifyCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(specifyCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should detect spec files by _spec.rb suffix", () => {
      const code = "describe User do\nend";
      const calls = parseAndFindCalls(code);
      expect(rspecFilterHook.filterNode!(calls[0].node, code, "test/user_spec.rb")).toBe(true);
    });

    it("should detect spec files by spec/ directory prefix", () => {
      const code = "describe User do\nend";
      const calls = parseAndFindCalls(code);
      expect(rspecFilterHook.filterNode!(calls[0].node, code, "spec/support/helpers.rb")).toBe(true);
    });

    it("should not detect non-spec files", () => {
      const code = "describe User do\nend";
      const calls = parseAndFindCalls(code);
      expect(rspecFilterHook.filterNode!(calls[0].node, code, "lib/rspec_helper.rb")).toBe(false);
    });

    it("should accept xit (pending) in spec files", () => {
      const code = "xit 'pending test' do\nend";
      const calls = parseAndFindCalls(code);
      const xitCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "xit";
      });
      expect(xitCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(xitCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should accept it with string arg and brace block (not shoulda)", () => {
      const code = "it 'works' { expect(true).to be true }";
      const calls = parseAndFindCalls(code);
      const itCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "it";
      });
      expect(itCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(itCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(true);
    });

    it("should reject let/before/after calls (they are body, not containers)", () => {
      const code = "let(:user) { create(:user) }";
      const calls = parseAndFindCalls(code);
      const letCall = calls.find((c) => {
        const id = c.node.children.find((ch: Parser.SyntaxNode) => ch.type === "identifier");
        return id && c.code.substring(id.startIndex, id.endIndex) === "let";
      });
      expect(letCall).toBeDefined();
      const result = rspecFilterHook.filterNode!(letCall!.node, code, "spec/models/user_spec.rb");
      expect(result).toBe(false);
    });
  });

  describe("process", () => {
    it("should be a no-op", () => {
      // rspecFilterHook.process is a no-op — it only provides filterNode
      expect(rspecFilterHook.process).toBeDefined();
      // Should not throw
      rspecFilterHook.process({} as any);
    });
  });
});
