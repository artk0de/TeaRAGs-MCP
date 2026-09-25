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
      expect(part1!.content.trimStart().startsWith("/**")).toBe(true);
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
      expect(part1!.content.trimStart().startsWith("# Renders")).toBe(true);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChunkSize);
      expectUniqueSymbolIds(chunks);
    });
  });
});
