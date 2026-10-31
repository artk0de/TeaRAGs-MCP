/**
 * Ruby container header chunks follow the contiguous runs of container rows
 * (bd tea-rags-mcp-9f0yn.3): an extracted child (a method, its leading
 * comment, a nested container) ends a run, so a header chunk never stretches
 * across a method — a member declared between two methods resolves to the rows
 * around it, not to a span covering half the class.
 *
 *   1. No header chunk's span covers a method row (sub-floor guests aside — a
 *      folded `private` joins its neighbour wherever it sits).
 *   2. A member id between two methods answers exactly its own run.
 *   3. A visibility-only group is sub-floor whatever the class header length:
 *      a lone `private` is never a chunk of its own.
 *   4–6. Method chunks, the member id union and row coverage do not move.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const OWNER = "Billing::Integrations::LedgerSynchronizer";
const PATH = "/repo/app/services/billing/integrations/ledger_synchronizer.rb";

const SYNCHRONIZER = [
  `class ${OWNER} < ApplicationService`, // 1
  "  include Billing::Integrations::RetryableConnection", // 2
  "  RETRY_LIMIT = 3", // 3
  "", // 4
  "  def call(account)", // 5
  "    account.entries.each { |entry| entry.update!(synced_at: Time.current) }", // 6
  "  end", // 7
  "", // 8
  "  BATCH_WINDOW = 15.minutes", // 9
  "  include Billing::Integrations::ThrottledConnection", // 10
  "", // 11
  "  def window_for(account)", // 12
  "    account.synced_at + BATCH_WINDOW + RETRY_LIMIT.minutes", // 13
  "  end", // 14
  "end", // 15
  "",
].join("\n");
const METHOD_ROWS = [5, 6, 7, 12, 13, 14];

const GUARDED = [
  `class ${OWNER} < ApplicationService`, // 1
  "  include Billing::Integrations::RetryableConnection", // 2
  "", // 3
  "  def call(account)", // 4
  "    account.entries.each { |entry| reconcile(entry) }", // 5
  "  end", // 6
  "", // 7
  "  private", // 8
  "", // 9
  "  def reconcile(entry)", // 10
  "    entry.update!(synced_at: Time.current, attempts: entry.attempts + 1)", // 11
  "  end", // 12
  "end", // 13
  "",
].join("\n");

function claimedRows(chunk: CodeChunk): number[] {
  const ranges = chunk.metadata.lineRanges ?? [{ start: chunk.startLine, end: chunk.endLine }];
  const rows: number[] = [];
  for (const { start, end } of ranges) for (let row = start; row <= end; row++) rows.push(row);
  return rows;
}

const headerChunks = (chunks: CodeChunk[]): CodeChunk[] =>
  chunks.filter((c) => c.metadata.symbolId === OWNER && c.metadata.chunkType === "block");

const nonBlankRows = (code: string): number[] =>
  code
    .split("\n")
    .map((text, i) => ({ text, row: i + 1 }))
    .filter(({ text }) => text.trim().length > 0)
    .map(({ row }) => row);

describe("Ruby container header runs (bd tea-rags-mcp-9f0yn.3)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("keeps every header chunk's span clear of method rows", async () => {
    const chunks = await chunker.chunk(SYNCHRONIZER, PATH, "ruby");
    const headers = headerChunks(chunks);

    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      const covered = METHOD_ROWS.filter((row) => row >= header.startLine && row <= header.endLine);
      expect(covered, `header ${header.startLine}–${header.endLine}`).toEqual([]);
    }
  });

  it("resolves a member declared between two methods to exactly its run", async () => {
    const chunks = await chunker.chunk(SYNCHRONIZER, PATH, "ruby");
    const owning = chunks.filter((c) => (c.metadata.memberSymbolIds ?? []).includes(`${OWNER}::BATCH_WINDOW`));

    expect(owning).toHaveLength(1);
    expect([owning[0].startLine, owning[0].endLine]).toEqual([9, 9]);
  });

  it("never makes a lone `private` a chunk of its own, even under a long class header", async () => {
    expect(`class ${OWNER} < ApplicationService\nprivate`.length).toBeGreaterThanOrEqual(50);
    const chunks = await chunker.chunk(GUARDED, PATH, "ruby");
    const bodies = headerChunks(chunks).map((c) =>
      c.content
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );

    expect(bodies).not.toContainEqual(["private"]);
    expect(chunks.filter((c) => claimedRows(c).includes(8))).toHaveLength(1);
  });

  it("leaves the method chunks byte-identical", async () => {
    const chunks = await chunker.chunk(SYNCHRONIZER, PATH, "ruby");
    const methods = chunks.filter((c) => c.metadata.chunkType === "function");

    expect(methods.map((c) => [c.metadata.symbolId, c.startLine, c.endLine])).toEqual([
      [`${OWNER}#call`, 5, 7],
      [`${OWNER}#window_for`, 12, 14],
    ]);
    expect(methods.map((c) => c.content)).toEqual([
      `class ${OWNER} < ApplicationService\ndef call(account)\n    account.entries.each { |entry| entry.update!(synced_at: Time.current) }\n  end`,
      `class ${OWNER} < ApplicationService\ndef window_for(account)\n    account.synced_at + BATCH_WINDOW + RETRY_LIMIT.minutes\n  end`,
    ]);
  });

  it("keeps the union of member ids", async () => {
    const chunks = await chunker.chunk(SYNCHRONIZER, PATH, "ruby");
    const members = chunks.flatMap((c) => c.metadata.memberSymbolIds ?? []).sort();

    expect(members).toEqual([
      `${OWNER}.include Billing::Integrations::RetryableConnection`,
      `${OWNER}.include Billing::Integrations::ThrottledConnection`,
      `${OWNER}::BATCH_WINDOW`,
      `${OWNER}::RETRY_LIMIT`,
    ]);
  });

  it("claims every non-blank row exactly once", async () => {
    for (const code of [SYNCHRONIZER, GUARDED]) {
      const chunks = await chunker.chunk(code, PATH, "ruby");
      const owners = new Map<number, number>();
      for (const chunk of chunks) for (const row of claimedRows(chunk)) owners.set(row, (owners.get(row) ?? 0) + 1);
      const container = nonBlankRows(code).filter((row) => row > 1 && row < code.split("\n").length - 1);

      for (const row of container) expect(owners.get(row), `row ${row}`).toBe(1);
    }
  });
});
