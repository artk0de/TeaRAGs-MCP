import { describe, expect, it } from "vitest";

import {
  TEST_SCOPE_PARENT_TYPE,
  type TestExample,
  type TestScope,
  type TestScopeLine,
} from "../../../../../src/core/contracts/types/chunker.js";
import { produceTestScopeChunks } from "../../../../../src/core/domains/language/kernel/test-scope-chunks.js";

const CONFIG = { maxChunkSize: 2500 };

function line(text: string, sourceLine: number, delegatesExamples?: boolean): TestScopeLine {
  return delegatesExamples ? { text, sourceLine, delegatesExamples } : { text, sourceLine };
}

function example(name: string, startLine: number, body = "expect(subject.value).to eq(42)"): TestExample {
  const text = `  ${name} do\n    ${body}\n  end`;
  return { name, text, startLine, endLine: startLine + 2 };
}

function scope(name: string, startLine: number, endLine: number, parts: Partial<TestScope> = {}): TestScope {
  return {
    name,
    startLine,
    endLine,
    setupLines: [],
    otherLines: [],
    examples: [],
    children: [],
    ...parts,
  };
}

describe("produceTestScopeChunks", () => {
  describe("one chunk per example", () => {
    it("addresses every example of a leaf root as <top>.<scope>.<example>", () => {
      const root = scope("RSpec.describe Worker", 1, 12, {
        setupLines: [line("  let(:worker) { described_class.new }", 2)],
        examples: [example("it 'performs the operation'", 4), example("it 'finalizes the operation'", 8)],
      });

      const chunks = produceTestScopeChunks(root, "Worker", CONFIG);

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "Worker.RSpec.describe Worker.it 'performs the operation'",
        "Worker.RSpec.describe Worker.it 'finalizes the operation'",
      ]);
      expect(chunks.map((c) => c.name)).toEqual(["it 'performs the operation'", "it 'finalizes the operation'"]);
      expect(chunks.every((c) => c.parentSymbolId === "Worker.RSpec.describe Worker")).toBe(true);
      expect(chunks.every((c) => c.chunkType === "test")).toBe(true);
      expect(chunks.every((c) => c.parentType === TEST_SCOPE_PARENT_TYPE)).toBe(true);
    });

    it("gives an example chunk the inherited setup, its scope's setup and other lines, then the example", () => {
      const root = scope("describe User", 1, 20, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        children: [
          scope("context 'when admin'", 4, 12, {
            setupLines: [line("    before { user.update!(admin: true) }", 5)],
            otherLines: [line("    ROLE = :admin", 6)],
            examples: [example("it 'can manage accounts'", 8)],
          }),
        ],
      });

      const [chunk] = produceTestScopeChunks(root, "User", CONFIG);

      expect(chunk.content).toBe(
        [
          "let(:user) { create(:user) }",
          "    before { user.update!(admin: true) }",
          "    ROLE = :admin",
          "  it 'can manage accounts' do",
          "    expect(subject.value).to eq(42)",
          "  end",
        ].join("\n"),
      );
      expect(chunk.symbolId).toBe("User.context 'when admin'.it 'can manage accounts'");
      expect(chunk.parentSymbolId).toBe("User.context 'when admin'");
    });

    it("takes an example chunk's line range from the example alone, never from inherited setup", () => {
      const root = scope("describe User", 1, 20, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        examples: [example("it 'is valid with defaults'", 10)],
      });

      const [chunk] = produceTestScopeChunks(root, "User", CONFIG);

      expect([chunk.startLine, chunk.endLine]).toEqual([10, 12]);
    });

    it("chunks an intermediate scope's own examples with the setup its ancestors give them", () => {
      const root = scope("describe User", 1, 30, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        children: [
          scope("context 'with a team'", 4, 28, {
            setupLines: [line("    let(:team) { create(:team, owner: user) }", 5)],
            examples: [example("it 'owns the team'", 7)],
            children: [scope("context 'when archived'", 11, 20, { examples: [example("it 'is read-only'", 13)] })],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "User.context 'with a team'.it 'owns the team'",
        "User.context 'when archived'.it 'is read-only'",
      ]);
      expect(chunks[0].content.startsWith("let(:user) { create(:user) }\n")).toBe(true);
      expect(chunks[1].content).toContain("let(:team) { create(:team, owner: user) }");
    });

    it("emits chunks in source order across sibling scopes and a scope's own examples", () => {
      const root = scope("describe Cart", 1, 40, {
        examples: [example("it 'starts empty'", 2), example("it 'totals line items'", 30)],
        children: [scope("context 'with a coupon'", 10, 20, { examples: [example("it 'applies the discount'", 12)] })],
      });

      const chunks = produceTestScopeChunks(root, "Cart", CONFIG);

      expect(chunks.map((c) => c.startLine)).toEqual([2, 12, 30]);
    });

    it("drops an example chunk shorter than 50 characters", () => {
      const tiny: TestExample = { name: "it 'x'", text: "it 'x' {}", startLine: 2, endLine: 2 };
      const root = scope("describe A", 1, 3, { examples: [tiny] });

      expect(produceTestScopeChunks(root, "A", CONFIG)).toEqual([]);
    });
  });

  describe("repeated descriptions (~N)", () => {
    it("suffixes a repeated example description within one scope with ~N, first occurrence unchanged", () => {
      const root = scope("describe Parser", 1, 20, {
        examples: [example("it 'parses'", 2), example("it 'parses'", 6), example("it 'parses'", 10)],
      });

      const chunks = produceTestScopeChunks(root, "Parser", CONFIG);

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "Parser.describe Parser.it 'parses'",
        "Parser.describe Parser.it 'parses'~2",
        "Parser.describe Parser.it 'parses'~3",
      ]);
    });

    it("suffixes a repeated scope name with ~N and addresses that scope's examples under the suffixed id", () => {
      const root = scope("describe Parser", 1, 40, {
        children: [
          scope("describe '#parse'", 2, 18, {
            children: [scope("context 'when empty'", 3, 9, { examples: [example("it 'returns nil'", 4)] })],
          }),
          scope("describe '#render'", 20, 38, {
            children: [scope("context 'when empty'", 21, 27, { examples: [example("it 'returns nil'", 22)] })],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "Parser", CONFIG);

      expect(chunks.map((c) => [c.symbolId, c.parentSymbolId])).toEqual([
        ["Parser.context 'when empty'.it 'returns nil'", "Parser.context 'when empty'"],
        ["Parser.context 'when empty'~2.it 'returns nil'", "Parser.context 'when empty'~2"],
      ]);
    });
  });

  describe("setup-only scopes", () => {
    it("emits a leaf without examples as one test_setup chunk under the top-level name", () => {
      const root = scope("describe Mailer", 1, 20, {
        children: [
          scope("context 'shared fixtures'", 2, 8, {
            setupLines: [line("    let(:recipient) { build(:user, email: 'a@example.com') }", 3)],
          }),
        ],
      });

      const [chunk] = produceTestScopeChunks(root, "Mailer", CONFIG);

      expect(chunk).toMatchObject({
        symbolId: "Mailer.context 'shared fixtures'",
        name: "context 'shared fixtures'",
        parentSymbolId: "Mailer",
        chunkType: "test_setup",
        startLine: 3,
        endLine: 3,
      });
      expect(chunk.parentType).toBeUndefined();
    });

    it("types a setup-only leaf as test when a setup line delegates to shared examples", () => {
      const root = scope("describe Mailer", 1, 20, {
        children: [
          scope("context 'as a notifier'", 2, 8, {
            setupLines: [line("    it_behaves_like 'a notifier that retries delivery'", 3, true)],
          }),
        ],
      });

      const [chunk] = produceTestScopeChunks(root, "Mailer", CONFIG);

      expect(chunk.chunkType).toBe("test");
    });

    it("emits nothing for an intermediate scope that has setup but no examples of its own", () => {
      const root = scope("describe Mailer", 1, 20, {
        children: [
          scope("context 'with a recipient'", 2, 18, {
            setupLines: [line("    let(:recipient) { build(:user, email: 'a@example.com') }", 3)],
            children: [scope("context 'when opted out'", 5, 12, { examples: [example("it 'skips delivery'", 6)] })],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "Mailer", CONFIG);

      expect(chunks.map((c) => c.symbolId)).toEqual(["Mailer.context 'when opted out'.it 'skips delivery'"]);
    });
  });

  describe("size budget", () => {
    it("drops inherited setup outermost-first until the example fits maxChunkSize, keeping the example whole", () => {
      const outer = line(`  let(:outer) { ${"a".repeat(120)} }`, 2);
      const inner = line(`    let(:inner) { ${"b".repeat(40)} }`, 5);
      const root = scope("describe Budget", 1, 30, {
        setupLines: [outer],
        children: [scope("context 'nested'", 4, 20, { setupLines: [inner], examples: [example("it 'fits'", 7)] })],
      });
      const exampleText = example("it 'fits'", 7).text;

      const [chunk] = produceTestScopeChunks(root, "Budget", {
        maxChunkSize: inner.text.length + exampleText.length + 1,
      });

      expect(chunk.content).not.toContain("let(:outer)");
      expect(chunk.content).toContain("let(:inner)");
      expect(chunk.content.endsWith(exampleText.trim().split("\n").at(-1) ?? "")).toBe(true);
    });

    it("keeps an example larger than maxChunkSize with no setup prefix — the engine's hard cap splits it", () => {
      const big = example("it 'is huge'", 5, "x".repeat(400));
      const root = scope("describe Budget", 1, 10, {
        setupLines: [line("  let(:setup) { build(:thing) }", 2)],
        examples: [big],
      });

      const [chunk] = produceTestScopeChunks(root, "Budget", { maxChunkSize: 100 });

      expect(chunk.content).toBe(big.text.trim());
    });

    it("reserves the container header the engine prepends, so header + chunk fits maxChunkSize (pi1cl)", () => {
      const setup = line(`  let(:setup) { ${"s".repeat(60)} }`, 2);
      const fits = example("it 'fits'", 4);
      const root = scope("describe Budget", 1, 10, { setupLines: [setup], examples: [fits] });
      const maxChunkSize = setup.text.length + 1 + fits.text.length;
      const bodyChunkPrefixLength = "RSpec.describe Budget do\n".length;

      const [chunk] = produceTestScopeChunks(root, "Budget", { maxChunkSize, bodyChunkPrefixLength });

      expect(bodyChunkPrefixLength + chunk.content.length).toBeLessThanOrEqual(maxChunkSize);
      expect(chunk.content).toBe(fits.text.trim());
    });
  });
});
