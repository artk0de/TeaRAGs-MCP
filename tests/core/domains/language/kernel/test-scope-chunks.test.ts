import { describe, expect, it } from "vitest";

import { setupChainOf } from "../__helpers__/setup-chain.js";
import {
  TEST_SCOPE_PARENT_TYPE,
  type BodyChunkResult,
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

/** A one-line example whose own chunk is under the 50-character floor. */
function tiny(name: string, startLine: number): TestExample {
  return { name, text: `${name} { is_expected.to be_valid }`, startLine, endLine: startLine };
}

function exampleChunks(chunks: BodyChunkResult[]): BodyChunkResult[] {
  return chunks.filter((c) => c.parentType === TEST_SCOPE_PARENT_TYPE);
}

function setupChunks(chunks: BodyChunkResult[]): BodyChunkResult[] {
  return chunks.filter((c) => c.parentType !== TEST_SCOPE_PARENT_TYPE);
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

      const chunks = exampleChunks(produceTestScopeChunks(root, "Worker", CONFIG));

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "Worker.RSpec.describe Worker.it 'performs the operation'",
        "Worker.RSpec.describe Worker.it 'finalizes the operation'",
      ]);
      expect(chunks.map((c) => c.name)).toEqual(["it 'performs the operation'", "it 'finalizes the operation'"]);
      expect(chunks.every((c) => c.parentSymbolId === "Worker.RSpec.describe Worker")).toBe(true);
      expect(chunks.every((c) => c.chunkType === "test")).toBe(true);
      expect(chunks.every((c) => c.parentType === TEST_SCOPE_PARENT_TYPE)).toBe(true);
    });

    it("gives an example chunk its scope title path and the example, never the setup (5xpq4)", () => {
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

      const [chunk] = exampleChunks(produceTestScopeChunks(root, "User", CONFIG));

      expect(chunk.content).toBe(
        ["context 'when admin'", "  it 'can manage accounts' do", "    expect(subject.value).to eq(42)", "  end"].join(
          "\n",
        ),
      );
      expect(chunk.symbolId).toBe("User.context 'when admin'.it 'can manage accounts'");
      expect(chunk.parentSymbolId).toBe("User.context 'when admin'");
    });

    it("takes an example chunk's line range from the example alone, never from inherited setup", () => {
      const root = scope("describe User", 1, 20, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        examples: [example("it 'is valid with defaults'", 10)],
      });

      const [chunk] = exampleChunks(produceTestScopeChunks(root, "User", CONFIG));

      expect([chunk.startLine, chunk.endLine]).toEqual([10, 12]);
    });

    it("chunks an intermediate scope's own examples under their scope title path, without setup", () => {
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

      const chunks = exampleChunks(produceTestScopeChunks(root, "User", CONFIG));

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "User.context 'with a team'.it 'owns the team'",
        "User.context 'when archived'.it 'is read-only'",
      ]);
      expect(chunks[0].content.startsWith("context 'with a team'\n  it 'owns the team' do")).toBe(true);
      expect(chunks[1].content.startsWith("context 'with a team'\ncontext 'when archived'\n")).toBe(true);
      expect(chunks.some((c) => c.content.includes("let("))).toBe(false);
    });

    it("emits chunks in source order across sibling scopes and a scope's own examples", () => {
      const root = scope("describe Cart", 1, 40, {
        examples: [example("it 'starts empty'", 2), example("it 'totals line items'", 30)],
        children: [scope("context 'with a coupon'", 10, 20, { examples: [example("it 'applies the discount'", 12)] })],
      });

      const chunks = produceTestScopeChunks(root, "Cart", CONFIG);

      expect(chunks.map((c) => c.startLine)).toEqual([2, 12, 30]);
    });

    it("keeps a lone example shorter than 50 characters as its own chunk (5xpq4)", () => {
      const lone: TestExample = { name: "it 'x'", text: "it 'x' {}", startLine: 2, endLine: 2 };
      const root = scope("describe A", 1, 3, { examples: [lone] });

      expect(produceTestScopeChunks(root, "A", CONFIG)).toMatchObject([
        { symbolId: "A.describe A.it 'x'", content: "it 'x' {}", chunkType: "test" },
      ]);
    });
  });

  describe("setup as its own chunk (5xpq4)", () => {
    it("emits one test_setup chunk per setup-bearing scope, holding only that scope's own lines", () => {
      const root = scope("describe User", 1, 30, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        children: [
          scope("context 'when admin'", 4, 20, {
            setupLines: [line("    before { user.update!(admin: true) }", 5)],
            otherLines: [line("    ROLE = :admin", 6)],
            children: [scope("context 'bare'", 8, 18, { examples: [example("it 'can manage accounts'", 9)] })],
          }),
        ],
      });

      const setups = setupChunks(produceTestScopeChunks(root, "User", CONFIG));

      expect(setups).toEqual([
        {
          content: "let(:user) { create(:user) }",
          startLine: 2,
          endLine: 2,
          chunkType: "test_setup",
          symbolId: "User.describe User",
          name: "describe User",
          parentSymbolId: "User",
          scopeLineRange: { start: 1, end: 30 },
        },
        {
          content: "before { user.update!(admin: true) }\n    ROLE = :admin",
          startLine: 5,
          endLine: 6,
          chunkType: "test_setup",
          symbolId: "User.context 'when admin'",
          name: "context 'when admin'",
          parentSymbolId: "User",
          scopeLineRange: { start: 4, end: 20 },
        },
      ]);
    });

    it("links every example to the setup-bearing scopes whose span contains it, outermost first", () => {
      const root = scope("describe User", 1, 60, {
        setupLines: [line("  let(:user) { create(:user) }", 2)],
        children: [
          scope("context 'v1.2 api'", 4, 20, {
            setupLines: [line("    let(:version) { '1.2' }", 5)],
            children: [
              scope("context 'bare'", 7, 18, {
                examples: [example("it 'answers'", 8)],
              }),
            ],
          }),
          scope("context 'v1.2 api'", 22, 40, {
            setupLines: [line("    let(:version) { '1.2-beta' }", 23)],
            examples: [example("it 'answers in beta'", 25)],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);
      const examples = exampleChunks(chunks);

      expect(examples.map((c) => [c.symbolId, setupChainOf(chunks, c)])).toEqual([
        ["User.context 'bare'.it 'answers'", ["User.describe User", "User.context 'v1.2 api'"]],
        ["User.context 'v1.2 api'~2.it 'answers in beta'", ["User.describe User", "User.context 'v1.2 api'~2"]],
      ]);
    });

    it("never links an example to a sibling scope's setup", () => {
      const root = scope("describe User", 1, 40, {
        children: [
          scope("context 'as guest'", 2, 12, {
            setupLines: [line("    let(:user) { build(:user, role: :guest) }", 3)],
            examples: [example("it 'cannot manage accounts'", 5)],
          }),
          scope("context 'as admin'", 14, 24, {
            setupLines: [line("    let(:user) { build(:user, role: :admin) }", 15)],
            examples: [example("it 'manages accounts'", 17)],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);

      expect(exampleChunks(chunks).map((c) => setupChainOf(chunks, c))).toEqual([
        ["User.context 'as guest'"],
        ["User.context 'as admin'"],
      ]);
    });

    it("stores the setup link on the setup chunk only — an example carries no setup reference", () => {
      const root = scope("describe A", 1, 10, {
        setupLines: [line("  let(:a) { 1 }", 2)],
        examples: [example("it 'reads a'", 4)],
      });

      const [example1] = exampleChunks(produceTestScopeChunks(root, "A", CONFIG));

      expect(example1).not.toHaveProperty("scopeLineRange");
      expect(example1).not.toHaveProperty("setupScopeIds");
    });

    it("keeps a short setup chunk an example depends on, so hydration can render it", () => {
      const root = scope("describe A", 1, 10, {
        setupLines: [line("  let(:a) { 1 }", 2)],
        examples: [example("it 'reads a'", 4)],
      });

      const chunks = produceTestScopeChunks(root, "A", CONFIG);

      expect(setupChunks(chunks).map((c) => c.content)).toEqual(["let(:a) { 1 }"]);
      expect(setupChainOf(chunks, exampleChunks(chunks)[0])).toEqual(["A.describe A"]);
    });

    it("inherits no setup when no scope above the example has setup", () => {
      const root = scope("describe A", 1, 10, { examples: [example("it 'stands alone'", 4)] });

      const chunks = produceTestScopeChunks(root, "A", CONFIG);

      expect(setupChainOf(chunks, chunks[0])).toEqual([]);
    });

    it("types a scope's setup chunk as test when a setup line delegates to shared examples", () => {
      const root = scope("describe Mailer", 1, 20, {
        setupLines: [line("  it_behaves_like 'a notifier that retries delivery'", 2, true)],
        examples: [example("it 'delivers'", 4)],
      });

      const [setup] = setupChunks(produceTestScopeChunks(root, "Mailer", CONFIG));

      expect(setup).toMatchObject({ symbolId: "Mailer.describe Mailer", chunkType: "test" });
    });
  });

  describe("tiny examples are grouped, never dropped (5xpq4)", () => {
    it("merges consecutive tiny sibling examples into one chunk that names every member", () => {
      const root = scope("describe User", 1, 10, {
        examples: [tiny("it", 2), tiny("it", 3), tiny("it", 4)],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        symbolId: "User.describe User.it",
        chunkType: "test",
        parentSymbolId: "User.describe User",
        parentType: TEST_SCOPE_PARENT_TYPE,
        startLine: 2,
        endLine: 4,
        exampleSymbolIds: ["User.describe User.it", "User.describe User.it~2", "User.describe User.it~3"],
      });
      expect(chunks[0].content).toBe(
        ["it { is_expected.to be_valid }", "it { is_expected.to be_valid }", "it { is_expected.to be_valid }"].join(
          "\n",
        ),
      );
    });

    it("folds a lone tiny example into the nearest tiny group of its scope", () => {
      const root = scope("describe User", 1, 30, {
        examples: [tiny("it 'a'", 2), example("it 'is a real example'", 4), tiny("it 'b'", 10), tiny("it 'c'", 11)],
      });

      const chunks = exampleChunks(produceTestScopeChunks(root, "User", CONFIG));

      expect(chunks.map((c) => c.symbolId)).toEqual([
        "User.describe User.it 'a'",
        "User.describe User.it 'is a real example'",
      ]);
      expect(chunks[0].exampleSymbolIds).toEqual([
        "User.describe User.it 'a'",
        "User.describe User.it 'b'",
        "User.describe User.it 'c'",
      ]);
      expect(chunks[0].lineRanges).toEqual([
        { start: 2, end: 2 },
        { start: 10, end: 10 },
        { start: 11, end: 11 },
      ]);
    });

    it("never groups tiny examples across scopes", () => {
      const root = scope("describe User", 1, 30, {
        examples: [tiny("it 'a'", 2), tiny("it 'b'", 3)],
        children: [scope("context 'nested'", 5, 9, { examples: [tiny("it 'c'", 6), tiny("it 'd'", 7)] })],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);

      expect(chunks.map((c) => c.exampleSymbolIds)).toEqual([
        ["User.describe User.it 'a'", "User.describe User.it 'b'"],
        ["User.context 'nested'.it 'c'", "User.context 'nested'.it 'd'"],
      ]);
      expect(chunks[1].content.startsWith("context 'nested'\n")).toBe(true);
    });

    it("splits a tiny group at the content budget, keeping every example in some chunk", () => {
      const examples = Array.from({ length: 6 }, (_, i) => tiny(`it '${i}'`, 2 + i));
      const root = scope("describe User", 1, 10, { examples });

      const chunks = produceTestScopeChunks(root, "User", { maxChunkSize: 80 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.content.length <= 80)).toBe(true);
      expect(chunks.flatMap((c) => c.exampleSymbolIds ?? [c.symbolId])).toEqual(
        examples.map((e) => `User.describe User.${e.name}`),
      );
    });

    it("links a tiny group to its scope's setup chain", () => {
      const root = scope("describe User", 1, 10, {
        setupLines: [line("  subject { build(:user) }", 2)],
        examples: [tiny("it", 3), tiny("it", 4)],
      });

      const chunks = produceTestScopeChunks(root, "User", CONFIG);

      expect(setupChainOf(chunks, exampleChunks(chunks)[0])).toEqual(["User.describe User"]);
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

    it("emits an intermediate scope's own setup as a test_setup chunk named after the scope (5xpq4)", () => {
      const root = scope("describe Mailer", 1, 20, {
        children: [
          scope("context 'with a recipient'", 2, 18, {
            setupLines: [line("    let(:recipient) { build(:user, email: 'a@example.com') }", 3)],
            children: [scope("context 'when opted out'", 5, 12, { examples: [example("it 'skips delivery'", 6)] })],
          }),
        ],
      });

      const chunks = produceTestScopeChunks(root, "Mailer", CONFIG);

      expect(chunks.map((c) => [c.symbolId, c.chunkType])).toEqual([
        ["Mailer.context 'with a recipient'", "test_setup"],
        ["Mailer.context 'when opted out'.it 'skips delivery'", "test"],
      ]);
    });
  });

  describe("size budget", () => {
    it("drops scope title rows outermost-first until the example fits maxChunkSize, keeping the example whole", () => {
      const root = scope("describe Budget", 1, 30, {
        children: [
          scope(`context '${"o".repeat(60)}'`, 3, 28, {
            children: [scope("context 'nested'", 4, 20, { examples: [example("it 'fits'", 7)] })],
          }),
        ],
      });
      const exampleText = example("it 'fits'", 7).text;

      const [chunk] = produceTestScopeChunks(root, "Budget", {
        maxChunkSize: "context 'nested'".length + exampleText.length + 1,
      });

      expect(chunk.content).not.toContain("ooo");
      expect(chunk.content.startsWith("context 'nested'\n")).toBe(true);
      expect(chunk.content.endsWith(exampleText.trim().split("\n").at(-1) ?? "")).toBe(true);
    });

    it("keeps an example larger than maxChunkSize with no setup prefix — the engine's hard cap splits it", () => {
      const big = example("it 'is huge'", 5, "x".repeat(400));
      const root = scope("describe Budget", 1, 10, {
        setupLines: [line("  let(:setup) { build(:thing) }", 2)],
        examples: [big],
      });

      const [chunk] = exampleChunks(produceTestScopeChunks(root, "Budget", { maxChunkSize: 100 }));

      expect(chunk.content).toBe(big.text.trim());
    });

    it("reserves the container header the engine prepends, so header + chunk fits maxChunkSize (pi1cl)", () => {
      const setup = line(`  let(:setup) { ${"s".repeat(60)} }`, 2);
      const fits = example("it 'fits'", 4);
      const root = scope("describe Budget", 1, 10, { setupLines: [setup], examples: [fits] });
      const maxChunkSize = setup.text.length + 1 + fits.text.length;
      const bodyChunkPrefixLength = "RSpec.describe Budget do\n".length;

      const [chunk] = exampleChunks(produceTestScopeChunks(root, "Budget", { maxChunkSize, bodyChunkPrefixLength }));

      expect(bodyChunkPrefixLength + chunk.content.length).toBeLessThanOrEqual(maxChunkSize);
      expect(chunk.content).toBe(fits.text.trim());
    });
  });
});
