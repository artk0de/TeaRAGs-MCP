/**
 * Packed test setup round trip through the REAL engine (bd tea-rags-mcp-5xpq4):
 * chunk an RSpec file with `TreeSitterChunker` — container header prepended,
 * setup packed across contexts, a pack cut into `#partN` windows by the hard
 * cap — then hydrate every example from those chunks exactly as stored. Each
 * example must come back with its own context's setup and the root's, and
 * never a sibling context's packed beside them.
 */

import { describe, expect, it, vi } from "vitest";

import type { CodeChunk } from "../../../../src/core/contracts/types/chunker.js";
import { TestSetupHydrator } from "../../../../src/core/domains/explore/test-setup-hydration.js";
import { TreeSitterChunker } from "../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../src/core/domains/language/index.js";

const SPEC = "spec/policies/document_policy_spec.rb";
const CONTEXTS = 12;

const ROOT_LETS = Array.from(
  { length: 15 },
  (_, i) => `  let(:fixture_${i}) { build(:fixture, ordinal: ${i}, label: "root fixture ${i}") }`,
);

const specCode = (rootLets: string[]): string =>
  [
    "RSpec.describe DocumentPolicy do",
    "  let(:user) { create(:user, :firm_owner) }",
    ...rootLets,
    ...Array.from({ length: CONTEXTS }, (_, i) => [
      "",
      `  context 'when the document is in state ${i}' do`,
      `    let(:state) { :state_number_${i} }`,
      `    let(:document) { create(:document, state: state, marker: ${i}) }`,
      "",
      `    it 'permits the action for state ${i}' do`,
      `      expect(described_class.new(user, document).update?).to be(true)`,
      "    end",
      "  end",
    ]).flat(),
    "end",
    "",
  ].join("\n");

function payloadOf(chunk: CodeChunk): Record<string, unknown> {
  return { ...chunk.metadata, relativePath: SPEC, startLine: chunk.startLine, content: chunk.content };
}

async function chunkSpec(maxChunkSize: number, rootLets: string[]): Promise<CodeChunk[]> {
  const chunker = new TreeSitterChunker(
    { chunkSize: maxChunkSize, chunkOverlap: 0, maxChunkSize },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  return chunker.chunk(specCode(rootLets), `/repo/${SPEC}`, "ruby");
}

describe("packed test setup through the engine (5xpq4)", () => {
  it.each([
    ["packs fitting the budget", 2500, [] as string[]],
    ["an oversized root setup cut into #partN windows, the rest packed", 400, ROOT_LETS],
  ])("hydrates every example with exactly its own chain — %s", async (_label, maxChunkSize, rootLets) => {
    const chunks = await chunkSpec(maxChunkSize, rootLets);
    const setups = chunks.filter((c) => c.metadata.scopeLineRanges !== undefined);
    const examples = chunks.filter((c) => c.metadata.parentType === "test_scope");
    expect(examples).toHaveLength(CONTEXTS);
    // Packed: far fewer setup points than setup-bearing scopes.
    expect(setups.length).toBeLessThan(CONTEXTS + 1);
    if (maxChunkSize === 400) expect(setups.some((c) => /#part\d+$/.test(c.metadata.symbolId ?? ""))).toBe(true);

    const scrollFiltered = vi.fn().mockResolvedValue(setups.map((c, i) => ({ id: i, payload: payloadOf(c) })));
    const hydrated = await new TestSetupHydrator({ scrollFiltered }).hydrate(
      examples.map((c, i) => ({ id: i, score: 1, payload: payloadOf(c) })),
      "code_x",
    );

    expect(scrollFiltered).toHaveBeenCalledTimes(1);
    hydrated.forEach((result, i) => {
      const content = result.payload.content as string;
      const lines = content.split("\n");
      expect(lines[0]).toBe("RSpec.describe DocumentPolicy do");
      expect(content).toContain("let(:user) { create(:user, :firm_owner) }");
      for (const rootLet of rootLets) expect(content).toContain(rootLet.trim());
      expect(content).toContain(`let(:state) { :state_number_${i} }`);
      expect(content).toContain(`marker: ${i})`);
      expect(content).toContain(`it 'permits the action for state ${i}' do`);
      for (let other = 0; other < CONTEXTS; other++) {
        if (other !== i) expect(content).not.toContain(`:state_number_${other} }`);
      }
      // Setup (root first) sits between the header and the example.
      expect(lines.indexOf("let(:user) { create(:user, :firm_owner) }")).toBeLessThan(
        lines.findIndex((l) => l.includes(`:state_number_${i}`)),
      );
    });
  });
});
