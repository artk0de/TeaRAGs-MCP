/**
 * find_symbol's codegraph hop is an OPTIONAL lookup (bd tea-rags-mcp-a43tr).
 *
 * The collapsed-symbol fallback (0rskm) only runs when both Qdrant scrolls
 * resolved nothing. When the codegraph store cannot be reached from this
 * process — a daemon from another build, build skew, a wedged or unreachable
 * daemon, a held lock — the lookup is skipped: find_symbol still answers with
 * its normal empty result and says, in a warning, what was skipped, why (the
 * error code) and how to repair it. Every OTHER failure still propagates.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
  DuckDbOpenFailedError,
} from "../../../../../src/core/adapters/duckdb/errors.js";
import { QdrantUnavailableError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

interface StrategyHarness {
  strategy: SymbolSearchStrategy;
  resolver: { resolveSymbolChunk: ReturnType<typeof vi.fn> };
  getPoint: ReturnType<typeof vi.fn>;
}

function makeStrategy(opts: {
  scroll?: unknown[];
  resolve: () => Promise<unknown>;
  getPoint?: () => Promise<unknown>;
}) {
  const getPoint = vi.fn(opts.getPoint ?? (async () => null));
  const qdrant = {
    scrollFiltered: vi.fn().mockResolvedValue(opts.scroll ?? []),
    getPoint,
  };
  const resolver = { resolveSymbolChunk: vi.fn(opts.resolve) };
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
  const strategy = new SymbolSearchStrategy(
    qdrant as never,
    {} as never,
    [],
    [],
    registry as never,
    { symbol: "Foo#bar" },
    resolver as never,
  );
  return { strategy, resolver, getPoint } satisfies StrategyHarness;
}

const ctx = { collectionName: "col", limit: 10, metaOnly: false };

function warningOf(strategy: SymbolSearchStrategy): string | undefined {
  return (strategy as unknown as { codegraphWarning?: string }).codegraphWarning;
}

const staleBuild = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT-OLD", "DAEMON-NEW", [
  "DAEMON-NEW",
  "DAEMON-NEW",
  "DAEMON-NEW",
]);

const unavailable: readonly [string, Error & { code: string }][] = [
  ["stale daemon build", staleBuild],
  ["daemon build skew", new CodegraphDaemonBuildSkewError({ socketPath: "/tmp/cg/daemon.sock", missingOps: ["x"] })],
  ["daemon exit timeout", new CodegraphDaemonExitTimeoutError("/tmp/cg/daemon.sock", 3000)],
  ["DuckDB lock held", new DuckDbOpenFailedError("/tmp/cg/code_x.duckdb", new Error("Conflicting lock is held"))],
];

describe("SymbolSearchStrategy — codegraph unavailable (a43tr)", () => {
  it.each(unavailable)(
    "%s: the fallback is skipped, find_symbol answers empty and warns with the error code",
    async (_label, err) => {
      const { strategy, getPoint } = makeStrategy({ resolve: async () => Promise.reject(err) });

      const results = await strategy.execute(ctx);

      expect(results).toEqual([]);
      expect(getPoint).not.toHaveBeenCalled();
      const warning = warningOf(strategy);
      expect(warning).toMatch(/codegraph fallback/i);
      expect(warning).toMatch(/skipped/i);
      expect(warning).toContain(err.code);
    },
  );

  it("stale daemon build: the warning names the remedy — reconnect the MCP server", async () => {
    const { strategy } = makeStrategy({ resolve: async () => Promise.reject(staleBuild) });

    await strategy.execute(ctx);

    expect(warningOf(strategy)).toContain("/mcp reconnect");
  });

  it("a failure that is not a codegraph-unavailable error still propagates, with no warning", async () => {
    const boom = new Error("programming error inside the resolver");
    const { strategy } = makeStrategy({ resolve: async () => Promise.reject(boom) });

    await expect(strategy.execute(ctx)).rejects.toBe(boom);
    expect(warningOf(strategy)).toBeUndefined();
  });

  it("a Qdrant failure on the covering-chunk fetch still propagates", async () => {
    const qdrantDown = new QdrantUnavailableError("http://localhost:6333");
    const { strategy } = makeStrategy({
      resolve: async () => ({ relPath: "foo.rb", chunkId: "chunk_cls" }),
      getPoint: async () => Promise.reject(qdrantDown),
    });

    await expect(strategy.execute(ctx)).rejects.toBe(qdrantDown);
    expect(warningOf(strategy)).toBeUndefined();
  });

  it("when the Qdrant scrolls resolve the symbol, codegraph is not touched and nothing is warned", async () => {
    const { strategy, resolver } = makeStrategy({
      scroll: [
        {
          id: "c1",
          payload: {
            symbolId: "Foo#bar",
            chunkType: "function",
            relativePath: "foo.rb",
            content: "def bar; end",
            startLine: 5,
            endLine: 6,
          },
        },
      ],
      resolve: async () => Promise.reject(staleBuild),
    });

    const results = await strategy.execute(ctx);

    expect(results).toHaveLength(1);
    expect(resolver.resolveSymbolChunk).not.toHaveBeenCalled();
    expect(warningOf(strategy)).toBeUndefined();
  });
});
