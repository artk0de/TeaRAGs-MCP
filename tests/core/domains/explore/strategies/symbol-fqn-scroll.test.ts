/**
 * SymbolSearchStrategy — fully-qualified queries against a corpus larger than
 * one scroll page (bd tea-rags-mcp-hditp).
 *
 * The scroll filter used to carry only the query's LAST segment token, so a
 * class whose short name is common (`Client`, `Contact`) shared its scroll
 * window with hundreds of namesakes and lost members to the cap in arbitrary
 * order. The fake Qdrant below evaluates `match.text` / `match.value`
 * conditions the way the `word` tokenizer does and truncates at the requested
 * limit, so a filter that is not selective loses rows exactly as it does live.
 */

import { describe, expect, it } from "vitest";

import { matchesTextIndexed } from "../../../../../src/core/adapters/qdrant/filters/symbolid-text-token.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

interface Row {
  id: string;
  payload: Record<string, unknown>;
}

function holds(payload: Record<string, unknown>, condition: Record<string, unknown>): boolean {
  const key = condition.key as string;
  const match = condition.match as { text?: string; value?: unknown };
  if (match.text !== undefined) return matchesTextIndexed(payload[key], match.text);
  return payload[key] === match.value;
}

/** A scroll over `corpus` that honours `must` and stops at `limit`, decoys first. */
function fakeQdrant(corpus: readonly Row[]) {
  return {
    scrollFiltered: async (_collection: string, filter: { must?: Record<string, unknown>[] }, limit: number) =>
      corpus.filter((row) => (filter.must ?? []).every((condition) => holds(row.payload, condition))).slice(0, limit),
  } as any;
}

const reranker = {
  rerank: (r: unknown[]) => r,
  hasCollectionStats: false,
  setCollectionStats: () => undefined,
  getDescriptors: () => [],
  getFullPreset: () => undefined,
} as any;

const registry = { buildMergedFilter: () => undefined } as any;

function classRows(fqn: string, path: string, memberCount: number): Row[] {
  const head: Row = {
    id: `${fqn}-head`,
    payload: { symbolId: fqn, chunkType: "class", relativePath: path, startLine: 10, endLine: 400, language: "ruby" },
  };
  const members = Array.from({ length: memberCount }, (_, i) => ({
    id: `${fqn}-m${i}`,
    payload: {
      symbolId: `${fqn}#member_${i}`,
      parentSymbolId: fqn,
      chunkType: "function",
      relativePath: path,
      startLine: 20 + i * 10,
      endLine: 25 + i * 10,
      language: "ruby",
    },
  }));
  return [head, ...members];
}

/** 250 namesake members per scroll key: every row carries the `client` token, none the target namespace. */
function namesakeDecoys(): Row[] {
  return Array.from({ length: 250 }, (_, i) => ({
    id: `decoy-${i}`,
    payload: {
      symbolId: `Vendor${i}::Client#call`,
      parentSymbolId: `Vendor${i}::Client`,
      chunkType: "function",
      relativePath: `lib/vendor${i}/client.rb`,
      startLine: 1,
      endLine: 5,
      language: "ruby",
    },
  }));
}

async function lookup(corpus: readonly Row[], symbol: string) {
  const strategy = new SymbolSearchStrategy(fakeQdrant(corpus), reranker, [], [], registry, { symbol });
  const results = await strategy.execute({ collectionName: "c", limit: 50 });
  return { strategy, results };
}

describe("SymbolSearchStrategy — FQN lookup over a corpus larger than one scroll page (hditp)", () => {
  it("outlines every member of a class whose short name 250 namesakes share", async () => {
    const corpus = [...namesakeDecoys(), ...classRows("Billing::Ledger::Client", "lib/billing/ledger/client.rb", 16)];

    const { results } = await lookup(corpus, "Billing::Ledger::Client");

    expect(results).toHaveLength(1);
    expect(results[0].payload?.startLine).toBe(10);
    const outline = String(results[0].payload?.content);
    for (let i = 0; i < 16; i++) expect(outline).toContain(`Billing::Ledger::Client#member_${i}`);
  });

  it("answers a partial namespace path with the one class it is a segment-boundary suffix of", async () => {
    const corpus = [
      ...namesakeDecoys(),
      ...classRows("Tax::Automations::Ledger::Client", "lib/tax/automations/ledger/client.rb", 16),
    ];

    const { results } = await lookup(corpus, "Ledger::Client");

    expect(results).toHaveLength(1);
    expect(results[0].payload?.symbolId).toBe("Tax::Automations::Ledger::Client");
    const outline = String(results[0].payload?.content);
    for (let i = 0; i < 16; i++) expect(outline).toContain(`Tax::Automations::Ledger::Client#member_${i}`);
  });

  it("never matches a suffix inside a segment", async () => {
    const corpus = classRows("Tax::SubLedger::Client", "lib/tax/sub_ledger/client.rb", 2);

    const { results } = await lookup(corpus, "Ledger::Client");

    expect(results).toEqual([]);
  });

  it("answers several suffix matches with an ambiguous empty answer naming each", async () => {
    const corpus = [
      ...classRows("Tax::Ledger::Client", "lib/tax/ledger/client.rb", 2),
      ...classRows("Payroll::Ledger::Client", "lib/payroll/ledger/client.rb", 2),
    ];

    const { strategy, results } = await lookup(corpus, "Ledger::Client");

    expect(results).toEqual([]);
    expect(strategy.emptyAnswer?.reason).toBe("ambiguous");
    expect(strategy.emptyAnswer?.suggestions).toEqual(["Payroll::Ledger::Client", "Tax::Ledger::Client"]);
  });
});
