/**
 * bd tea-rags-mcp-u7tjf / tea-rags-mcp-6wy02 — a comment a comment-capture hook
 * attached to a class member rides THAT member's chunk, whatever path the
 * engine emits the member through.
 *
 * Comment capture moves a member's leading comment rows into `excludedRows` and
 * hands the text over as `methodPrefixes[ci]`. Only the leaf path read the
 * prefix: an oversized member (split into `#partN`) and a member recursed as a
 * container (a method whose body returns an object literal with methods)
 * dropped it, while `excludedRows` told the container remainder the rows were
 * carried — so they were in no chunk. Separately, the TS class-body hook
 * skipped every `method_definition`, including methods under the 50-char child
 * floor that the engine never extracts, so in a class with fields such a method
 * and its comment were in no chunk either.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function coveredLines(chunks: CodeChunk[]): Set<number> {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  return covered;
}

/** 1-based lines of `code` whose text matches `pattern`. */
function linesMatching(code: string, pattern: RegExp): number[] {
  return code
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => pattern.test(text))
    .map(({ line }) => line);
}

function expectLinesCovered(code: string, chunks: CodeChunk[], lines: number[]): void {
  const covered = coveredLines(chunks);
  const text = code.split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => !covered.has(l)).map((l) => `${l}: ${text[l - 1]}`)).toEqual([]);
}

function expectUniqueSymbolIds(chunks: CodeChunk[]): void {
  const ids = chunks.map((c) => c.metadata.symbolId).filter((id): id is string => id !== undefined);
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
}

/** `count` distinct statements, each long enough that the method overflows the budget. */
function statements(count: number, indent: string): string {
  return Array.from(
    { length: count },
    (_, i) => `${indent}const value${i} = this.computeSomethingReasonablyLong(${i}, "argument number ${i}");`,
  ).join("\n");
}

describe("TreeSitterChunker — member comments ride the member's chunk (bd u7tjf, 6wy02)", () => {
  const maxChunkSize = 1000;
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  describe("typescript", () => {
    it("puts an oversized method's JSDoc at the head of its #part1", async () => {
      const code = `export class Reporter {
  constructor(private readonly sink: Sink) {}

  /**
   * Renders every phase of the run into the sink, one row per phase.
   * The JSDoc must stay searchable even though the method is split.
   */
  render(run: Run): void {
${statements(20, "    ")}
  }

  flush(): void {
    this.sink.flush();
    this.sink.close();
  }
}
`;
      const chunks = await chunker.chunk(code, "src/reporter.ts", "typescript");

      expectLinesCovered(code, chunks, linesMatching(code, /^\s*(\/\*\*|\*)/));
      const part1 = chunks.find((c) => c.metadata.symbolId === "Reporter#render#part1");
      expect(part1).toBeDefined();
      // bd tea-rags-mcp-jgb5a — the class hierarchy prefix opens every part;
      // the JSDoc follows it at the head of #part1.
      const [header, head] = part1!.content.split("\n");
      expect(header).toBe("class Reporter {");
      expect(head.trimStart().startsWith("/**")).toBe(true);
      expect(part1!.startLine).toBe(linesMatching(code, /^\s*\/\*\*/)[0]);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
      expectUniqueSymbolIds(chunks);
    });

    it("keeps a JSDoc larger than half the budget in the split method's parts without overflowing one", async () => {
      const doc = Array.from(
        { length: 12 },
        (_, i) => `   * Paragraph ${i}: the documentation of this method is deliberately long and verbose.`,
      ).join("\n");
      const code = `export class Reporter {
  /**
${doc}
   */
  render(run: Run): void {
${statements(20, "    ")}
  }
}
`;
      const chunks = await chunker.chunk(code, "src/reporter.ts", "typescript");

      expectLinesCovered(code, chunks, linesMatching(code, /^\s*(\/\*\*|\*)/));
      const part1 = chunks.find((c) => c.metadata.symbolId === "Reporter#render#part1");
      expect(part1?.startLine).toBe(2);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
      expectUniqueSymbolIds(chunks);
    });

    it("keeps the comment above a method recursed as a container (object literal with methods)", async () => {
      const code = `export class DaemonClient {
  async load(): Promise<Snapshot> {
    return (await this.call("loadSnapshot", {})) as Snapshot;
  }

  // ── daemon-internal (NOT proxied) ──
  // streamAdjacency stays daemon-internal: the graph analysis runs inside
  // the daemon, so streaming the adjacency over IPC is never correct.

  streamAdjacency(_scope: CycleScope): AsyncIterableIterator<[string, string]> {
    const error = new UnsupportedDaemonReadError("streamAdjacency");
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<[string, string]>> {
        throw error;
      },
    };
  }
}
`;
      const chunks = await chunker.chunk(code, "src/client.ts", "typescript");

      const commentLines = linesMatching(code, /^\s*\/\//);
      expectLinesCovered(code, chunks, commentLines);
      const carrier = chunks.find((c) => coveredLines([c]).has(commentLines[0]));
      expect(carrier?.metadata.symbolId).toBe("DaemonClient#streamAdjacency");
      expectUniqueSymbolIds(chunks);
    });

    it("keeps a short method and its comment in a class whose body chunker claims the container", async () => {
      const code = `export class JavaThisMemberStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  // Same-file lookups only — no ambiguous-mode pick needed here.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "this" || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
`;
      const chunks = await chunker.chunk(code, "src/strategy.ts", "typescript");

      expectLinesCovered(code, chunks, [...linesMatching(code, /^\s*\/\//), ...linesMatching(code, /constructor\(/)]);
      expectUniqueSymbolIds(chunks);
    });
  });

  describe("ruby (same engine path, text-scanning comment capture)", () => {
    it("puts an oversized method's leading comment at the head of its #part1", async () => {
      const body = Array.from(
        { length: 20 },
        (_, i) => `    value_${i} = compute_something_reasonably_long(${i}, "argument number ${i}")`,
      ).join("\n");
      const code = `class Reporter
  # Renders every phase of the run into the sink, one row per phase.
  # The comment must stay searchable even though the method is split.
  def render(run)
${body}
  end

  def flush
    @sink.flush
    @sink.close
  end
end
`;
      const chunks = await chunker.chunk(code, "lib/reporter.rb", "ruby");

      expectLinesCovered(code, chunks, linesMatching(code, /^\s*#/));
      const part1 = chunks.find((c) => c.metadata.symbolId === "Reporter#render#part1");
      expect(part1).toBeDefined();
      // bd tea-rags-mcp-jgb5a — class hierarchy prefix first, then the comment.
      const [header, head] = part1!.content.split("\n");
      expect(header).toBe("class Reporter");
      expect(head.trimStart().startsWith("# Renders")).toBe(true);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
      expectUniqueSymbolIds(chunks);
    });
  });
});

/**
 * bd tea-rags-mcp-ic5mv — a split method's leading doc comment never makes a
 * part of its own. A JSDoc larger than half the budget used to be cut as one
 * span, so `#part1` held the class header and the comment and no signature:
 * a hit on it named neither the method nor anything it does. The comment now
 * shares a part with the signature whenever the two fit together, and a
 * comment too large even for that repeats the signature on the comment-only
 * windows, the way every later part already repeats it.
 */
describe("TreeSitterChunker — a split method's doc comment stays with its signature (bd ic5mv)", () => {
  const maxChunkSize = 1000;
  const signature = "render(run: Run): void {";
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  function reporterWithDoc(paragraphs: number): string {
    const doc = Array.from(
      { length: paragraphs },
      (_, i) => `   * Paragraph ${i}: the documentation of this method is deliberately long and verbose.`,
    ).join("\n");
    return `export class Reporter {
  /**
${doc}
   */
  ${signature}
${statements(20, "    ")}
  }
}
`;
  }

  function renderParts(chunks: CodeChunk[]): CodeChunk[] {
    return chunks.filter((c) => /^Reporter#render#part\d+$/.test(c.metadata.symbolId ?? ""));
  }

  it("keeps a JSDoc over half the budget in the same part as the signature", async () => {
    const code = reporterWithDoc(7);
    const chunks = await chunker.chunk(code, "src/reporter.ts", "typescript");
    const parts = renderParts(chunks);

    expect(parts.length).toBeGreaterThan(1);
    const part1 = parts[0];
    expect(part1.content).toContain("/**");
    expect(part1.content.split("\n").map((l) => l.trim())).toContain(signature);
    expect(part1.startLine).toBe(2);
    for (const p of parts) expect(p.content.split("\n").map((l) => l.trim())).toContain(signature);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
    expectLinesCovered(code, chunks, linesMatching(code, /^\s*(\/\*\*|\*)/));
  });

  it("repeats the signature on the comment-only windows of a JSDoc larger than the budget", async () => {
    const code = reporterWithDoc(16);
    const chunks = await chunker.chunk(code, "src/reporter.ts", "typescript");
    const parts = renderParts(chunks);

    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.content.split("\n").map((l) => l.trim())).toContain(signature);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
    expect(parts[0].startLine).toBe(2);
    for (let i = 1; i < parts.length; i++) expect(parts[i].startLine).toBe(parts[i - 1].endLine + 1);
    expectLinesCovered(code, chunks, linesMatching(code, /^\s*(\/\*\*|\*)/));
  });
});
