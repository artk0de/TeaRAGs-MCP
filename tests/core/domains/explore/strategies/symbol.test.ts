/**
 * SymbolSearchStrategy — behavioral tests for find_symbol extraction.
 *
 * The strategy scrolls chunks by symbolId (primary) and parentSymbolId
 * (members), deduplicates by id, and resolves via resolveSymbols().
 * Filter building lives here (not in the facade).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

describe("SymbolSearchStrategy", () => {
  const mockScrollFiltered = vi.fn();
  const mockRerank = vi.fn((r: any[]) => r);

  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = {
    rerank: mockRerank,
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
  } as any;

  const buildRegistry = (mergedFilter: Record<string, unknown> | undefined = undefined) =>
    ({
      buildMergedFilter: vi.fn().mockReturnValue(mergedFilter),
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls primary symbolId filter + parallel parentSymbolId filter", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
      symbol: "Reranker",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(mockScrollFiltered).toHaveBeenCalledTimes(2);
    expect(mockScrollFiltered).toHaveBeenNthCalledWith(
      1,
      "c",
      expect.objectContaining({ must: expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }]) }),
      200,
    );
    expect(mockScrollFiltered).toHaveBeenNthCalledWith(
      2,
      "c",
      expect.objectContaining({
        must: expect.arrayContaining([{ key: "parentSymbolId", match: { text: "Reranker" } }]),
      }),
      200,
    );
  });

  it("includes language condition in both scroll filters when provided", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
      symbol: "validate",
      language: "typescript",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    const primaryCall = mockScrollFiltered.mock.calls[0][1];
    const parentCall = mockScrollFiltered.mock.calls[1][1];
    expect(primaryCall.must).toEqual(
      expect.arrayContaining([
        { key: "symbolId", match: { text: "validate" } },
        { key: "language", match: { value: "typescript" } },
      ]),
    );
    expect(parentCall.must).toEqual(
      expect.arrayContaining([
        { key: "parentSymbolId", match: { text: "validate" } },
        { key: "language", match: { value: "typescript" } },
      ]),
    );
  });

  it("merges pathPattern filter into both scrolls via registry", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const pathMust = [{ key: "relativePath", match: { text: "tests/" } }];
    const registry = buildRegistry({ must: pathMust });
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], registry, {
      symbol: "Reranker",
      pathPattern: "**/tests/**",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(registry.buildMergedFilter).toHaveBeenCalled();
    const primary = mockScrollFiltered.mock.calls[0][1];
    const parent = mockScrollFiltered.mock.calls[1][1];
    expect(primary.must).toEqual(
      expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }, ...pathMust]),
    );
    expect(parent.must).toEqual(
      expect.arrayContaining([{ key: "parentSymbolId", match: { text: "Reranker" } }, ...pathMust]),
    );
  });

  it("propagates must_not from registry into both scroll filters (negation)", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const mustNot = [{ key: "relativePath", match: { text: "ingest/" } }];
    const registry = buildRegistry({ must_not: mustNot });
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], registry, {
      symbol: "Pipeline",
      pathPattern: "!**/ingest/**",
    });

    await strategy.execute({ collectionName: "c", limit: 50 });

    expect(mockScrollFiltered.mock.calls[0][1].must_not).toEqual(mustNot);
    expect(mockScrollFiltered.mock.calls[1][1].must_not).toEqual(mustNot);
  });

  it("deduplicates chunks by id across the two scrolls", async () => {
    // Same chunk appears in both primary and parent scrolls — must appear once
    const shared = {
      id: "shared-id",
      payload: {
        symbolId: "Foo#bar",
        parentSymbolId: "Foo",
        chunkType: "function",
        relativePath: "src/foo.ts",
        content: "",
        startLine: 1,
        endLine: 5,
      },
    };
    mockScrollFiltered.mockResolvedValueOnce([shared]).mockResolvedValueOnce([shared]);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 50 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shared-id");
  });

  it("applies pagination (offset then limit)", async () => {
    const makeChunk = (i: number) => ({
      id: `id-${i}`,
      payload: {
        symbolId: `Foo#m${i}`,
        // Real chunker payload for an instance method always carries
        // parentSymbolId — required by the short-name post-filter to
        // stitch members on a class-name query (xnfv).
        parentSymbolId: "Foo",
        chunkType: "function",
        relativePath: "src/foo.ts",
        content: "",
        startLine: i,
        endLine: i + 1,
      },
    });
    mockScrollFiltered
      .mockResolvedValueOnce([makeChunk(1), makeChunk(2), makeChunk(3), makeChunk(4)])
      .mockResolvedValueOnce([]);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 2, offset: 1 });

    expect(result.map((r) => r.id)).toEqual(["id-2", "id-3"]);
  });

  it("returns empty when no scroll results", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "nope" });

    const result = await strategy.execute({ collectionName: "c", limit: 50 });

    expect(result).toEqual([]);
  });

  it("applies reranker when rerank option is set in context", async () => {
    mockScrollFiltered
      .mockResolvedValueOnce([
        {
          id: "a",
          payload: {
            symbolId: "Foo",
            chunkType: "function",
            relativePath: "src/a.ts",
            content: "",
            startLine: 1,
            endLine: 2,
          },
        },
      ])
      .mockResolvedValueOnce([]);
    mockRerank.mockImplementation((results: any[]) => results.map((r) => ({ ...r, score: 42 })));

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
    const result = await strategy.execute({ collectionName: "c", limit: 50, rerank: "techDebt" });

    expect(mockRerank).toHaveBeenCalled();
    expect(result[0].score).toBe(42);
  });

  describe("metaOnly git filtering (contract parity with semantic/hybrid)", () => {
    const essentialKeys = ["git.file.commitCount", "git.file.ageDays", "git.file.taskIds"];

    const buildChunkWithFullGit = () => ({
      id: "fn-1",
      payload: {
        symbolId: "QdrantManager#list",
        name: "list",
        // Real chunker output for an instance method always sets
        // parentSymbolId to the container class. Including it here
        // mirrors production payload so the short-name post-filter
        // (xnfv) can stitch the chunk to a `QdrantManager` query.
        parentSymbolId: "QdrantManager",
        chunkType: "function",
        relativePath: "src/qdrant.ts",
        language: "typescript",
        content: "function list() {}",
        startLine: 10,
        endLine: 12,
        git: {
          file: {
            // Essential — should remain
            commitCount: 27,
            ageDays: 0,
            taskIds: [],
            // Internal — should NOT leak at metaOnly=true without rerank
            recentDominantAuthor: "Alice",
            recentDominantAuthorEmail: "alice@example.com",
            lastCommitHash: "abc123",
            lastModifiedAt: 1776952725,
            firstCreatedAt: 1772631366,
            enrichedAt: "2026-04-23T14:29:08.845Z",
            linesAdded: 1028,
            linesDeleted: 356,
            fileChurnCount: 1384,
            relativeChurn: 1.09,
            bugFixRate: 27,
            recentContributorCount: 2,
            recentDominantAuthorPct: 79,
          },
          chunk: {
            commitCount: 2,
            ageDays: 28,
            taskIds: [],
            relativeChurn: 0.5,
            bugFixRate: 10,
          },
        },
      },
    });

    it("strips non-essential git fields when metaOnly=true and no rerank (contract parity)", async () => {
      mockScrollFiltered.mockResolvedValueOnce([buildChunkWithFullGit()]).mockResolvedValueOnce([]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], essentialKeys, buildRegistry(), {
        symbol: "QdrantManager",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50, metaOnly: true });

      expect(result).toHaveLength(1);
      const git = result[0].payload?.git as Record<string, Record<string, unknown>> | undefined;
      expect(git).toBeDefined();
      // File-level: only essential
      expect(Object.keys(git!.file).sort()).toEqual(["ageDays", "commitCount", "taskIds"]);
      // Internal fields gone
      expect(git!.file.recentDominantAuthorEmail).toBeUndefined();
      expect(git!.file.enrichedAt).toBeUndefined();
      expect(git!.file.lastCommitHash).toBeUndefined();
      expect(git!.file.firstCreatedAt).toBeUndefined();
      expect(git!.file.lastModifiedAt).toBeUndefined();
      expect(git!.file.linesAdded).toBeUndefined();
      expect(git!.file.linesDeleted).toBeUndefined();
      expect(git!.file.fileChurnCount).toBeUndefined();
      expect(git!.file.bugFixRate).toBeUndefined();
      expect(git!.file.recentDominantAuthorPct).toBeUndefined();
    });

    it("leaves full git payload intact when metaOnly=false (no change to raw path)", async () => {
      mockScrollFiltered.mockResolvedValueOnce([buildChunkWithFullGit()]).mockResolvedValueOnce([]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], essentialKeys, buildRegistry(), {
        symbol: "QdrantManager",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50, metaOnly: false });

      expect(result).toHaveLength(1);
      const git = result[0].payload?.git as Record<string, Record<string, unknown>> | undefined;
      // Full payload preserved when metaOnly=false
      expect(git!.file.recentDominantAuthor).toBe("Alice");
      expect(git!.file.enrichedAt).toBeDefined();
    });

    it("preserves outline-specific fields (content, startLine, endLine) at metaOnly=true", async () => {
      mockScrollFiltered.mockResolvedValueOnce([buildChunkWithFullGit()]).mockResolvedValueOnce([]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], essentialKeys, buildRegistry(), {
        symbol: "QdrantManager",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50, metaOnly: true });

      // resolveSymbols already strips content on metaOnly; outline scaffolding stays
      expect(result[0].payload?.symbolId).toBe("QdrantManager#list");
      expect(result[0].payload?.startLine).toBe(10);
      expect(result[0].payload?.endLine).toBe(12);
      expect(result[0].payload?.content).toBeUndefined();
    });
  });

  /**
   * Bug tea-rags-mcp-yx10:
   *   find_symbol returned [] for fully qualified symbolIds (containing `#`,
   *   `.`, `::`) and for short names with non-alphanumeric suffixes (`=`, `!`,
   *   `?`).
   *
   * Root cause: Qdrant `match: { text }` uses the `word` tokenizer on the
   *   `symbolId` text index. Punctuation characters (`#`, `.`, `::`, `=`,
   *   `!`, `?`) are token separators. Submitting the full FQN as the text
   *   query joins multiple tokens with AND, which under certain index states
   *   (stopword filtering, missing tokens, stale shards) fails to match.
   *
   * Fix: SymbolSearchStrategy must reduce the query to its last name segment
   *   for the Qdrant text-match (single reliable token) AND post-filter the
   *   scroll results to keep only chunks whose stored `symbolId` exactly
   *   matches the original query (case-sensitive). Short bare names keep
   *   their existing behaviour.
   */
  describe("symbolId tokenization fix (yx10)", () => {
    it("matches by last segment only when query contains '#' separator", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Reranker#score",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      // Filter must use the *last segment* of the FQN, not the full query.
      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "score" } }]),
        }),
        200,
      );
    });

    it("matches by last segment only when query contains '.' separator (static method)", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo.bar",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "bar" } }]),
        }),
        200,
      );
    });

    it("matches by last segment only when query contains '::' Ruby namespace separator", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "ScenarioImport::AgentDiff::FieldDiff#incoming",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "incoming" } }]),
        }),
        200,
      );
    });

    it("strips '=' suffix from the text token for setter symbolIds", async () => {
      // payload symbolId "Foo#updated=" tokenizes to [foo, updated] (the `=`
      // is a token separator). To hit it reliably, the text query must also
      // tokenize to a subset of that, i.e. "updated" — NOT "updated=".
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo#updated=",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "updated" } }]),
        }),
        200,
      );
    });

    it("strips '?' suffix from the text token for predicate methods", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo#valid?",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "valid" } }]),
        }),
        200,
      );
    });

    it("strips '!' suffix from the text token for bang methods", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo#save!",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "save" } }]),
        }),
        200,
      );
    });

    it("keeps short bare names unchanged when no separator is present", async () => {
      mockScrollFiltered.mockResolvedValue([]);
      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "createNote",
      });

      await strategy.execute({ collectionName: "c", limit: 50 });

      // Bare name → unchanged. No separator → no last-segment extraction.
      expect(mockScrollFiltered).toHaveBeenNthCalledWith(
        1,
        "c",
        expect.objectContaining({
          must: expect.arrayContaining([{ key: "symbolId", match: { text: "createNote" } }]),
        }),
        200,
      );
    });

    it("post-filters scroll results to keep only chunks whose symbolId exactly matches the FQN query", async () => {
      // Qdrant returns a SUPERSET when matched by last-segment token. The
      // strategy must filter that superset down to exact symbolId matches
      // (and their direct members) so the caller sees ONLY the requested
      // symbol, not unrelated chunks that happened to share the last token.
      const exactMatch = {
        id: "exact",
        payload: {
          symbolId: "Foo#bar",
          chunkType: "function",
          name: "bar",
          parentSymbolId: "Foo",
          relativePath: "src/foo.rb",
          content: "def bar; end",
          startLine: 1,
          endLine: 1,
          language: "ruby",
        },
      };
      const unrelatedMatch = {
        id: "noise",
        payload: {
          symbolId: "Other#bar",
          chunkType: "function",
          name: "bar",
          parentSymbolId: "Other",
          relativePath: "src/other.rb",
          content: "def bar; end",
          startLine: 1,
          endLine: 1,
          language: "ruby",
        },
      };
      mockScrollFiltered.mockResolvedValueOnce([exactMatch, unrelatedMatch]).mockResolvedValueOnce([]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo#bar",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50 });

      // Only the exact symbolId match survives the post-filter.
      expect(result).toHaveLength(1);
      expect(result[0].payload?.symbolId).toBe("Foo#bar");
    });

    it("post-filters with setter '=' suffix preserved in exact match check", async () => {
      // The payload's stored symbolId is "Foo#updated=" — the strategy must
      // distinguish the getter (Foo#updated) from the setter (Foo#updated=)
      // even though both share the last-segment token "updated".
      const getter = {
        id: "getter",
        payload: {
          symbolId: "Foo#updated",
          chunkType: "function",
          name: "updated",
          parentSymbolId: "Foo",
          relativePath: "src/foo.rb",
          content: "def updated; end",
          startLine: 1,
          endLine: 1,
          language: "ruby",
        },
      };
      const setter = {
        id: "setter",
        payload: {
          symbolId: "Foo#updated=",
          chunkType: "function",
          name: "updated=",
          parentSymbolId: "Foo",
          relativePath: "src/foo.rb",
          content: "def updated=(v); end",
          startLine: 2,
          endLine: 2,
          language: "ruby",
        },
      };
      mockScrollFiltered.mockResolvedValueOnce([getter, setter]).mockResolvedValueOnce([]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo#updated=",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50 });

      expect(result).toHaveLength(1);
      expect(result[0].payload?.symbolId).toBe("Foo#updated=");
    });

    /**
     * Bug tea-rags-mcp-xnfv (follow-up to yx10):
     *   Short-name navigation returns too many false positives because the
     *   bare query is fed to Qdrant `match: { text }` without any
     *   post-filter — the tokenized index returns every chunk containing
     *   the token, regardless of WHERE it appears in the symbolId.
     *
     *   `find_symbol(symbol="set")` should return symbols whose LAST
     *   segment is `set` (top-level `set`, or `*.set` / `*#set` / `*::set`
     *   /  `*.set=` / `*#set=`) — not every chunk that happens to mention
     *   the token "set" anywhere.
     */
    describe("short-name navigation (xnfv)", () => {
      const baseChunk = (overrides: Record<string, unknown>) => ({
        id: overrides.id ?? "id",
        payload: {
          chunkType: "function",
          relativePath: "src/anywhere.ts",
          content: "",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          ...overrides,
        },
      });

      it("keeps chunks whose last segment after '.' equals the short query", async () => {
        const appSet = baseChunk({ id: "app-set", symbolId: "app.set", name: "set", parentSymbolId: "app" });
        const noise = baseChunk({ id: "set-method-of-other", symbolId: "fooSet", name: "fooSet" });
        mockScrollFiltered.mockResolvedValueOnce([appSet, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "set" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("app.set");
        expect(symbolIds).not.toContain("fooSet");
      });

      it("keeps chunks whose last segment after '#' equals the short query", async () => {
        const fooBar = baseChunk({ id: "foo-bar", symbolId: "Foo#bar", name: "bar", parentSymbolId: "Foo" });
        const noise = baseChunk({ id: "baroque", symbolId: "Baroque", name: "Baroque" });
        mockScrollFiltered.mockResolvedValueOnce([fooBar, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "bar" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Foo#bar");
        expect(symbolIds).not.toContain("Baroque");
      });

      it("keeps chunks whose last segment after '::' equals the short query", async () => {
        const aclWrite = baseChunk({
          id: "acl",
          symbolId: "Acme::Acl::Write",
          name: "Write",
          parentSymbolId: "Acme::Acl",
        });
        const noise = baseChunk({ id: "writes", symbolId: "writeAll", name: "writeAll" });
        mockScrollFiltered.mockResolvedValueOnce([aclWrite, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Write" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Acme::Acl::Write");
        expect(symbolIds).not.toContain("writeAll");
      });

      it("keeps the top-level symbol whose symbolId equals the short query", async () => {
        const bare = baseChunk({ id: "bare-set", symbolId: "set", name: "set" });
        const noise = baseChunk({ id: "noise", symbolId: "setX", name: "setX" });
        mockScrollFiltered.mockResolvedValueOnce([bare, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "set" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("set");
        expect(symbolIds).not.toContain("setX");
      });

      it("keeps Ruby setter chunks whose last segment ends with '=' on a short setter query", async () => {
        // `find_symbol(symbol="updated=")` — bare token, but the trailing
        // `=` is a Ruby setter marker. Last-segment match accepts both
        // `Foo#updated=` (member) and `updated=` (top-level setter).
        const memberSetter = baseChunk({
          id: "member-setter",
          symbolId: "Foo#updated=",
          name: "updated=",
          parentSymbolId: "Foo",
        });
        const noise = baseChunk({ id: "noise", symbolId: "Foo#updated", name: "updated", parentSymbolId: "Foo" });
        mockScrollFiltered.mockResolvedValueOnce([memberSetter, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "updated=" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Foo#updated=");
        // The getter must NOT survive — different last segment.
        expect(symbolIds).not.toContain("Foo#updated");
      });

      it("keeps Ruby predicate chunks whose last segment ends with '?' on a short predicate query", async () => {
        const memberPred = baseChunk({
          id: "member-pred",
          symbolId: "Foo#valid?",
          name: "valid?",
          parentSymbolId: "Foo",
        });
        const noise = baseChunk({ id: "noise", symbolId: "Foo#valid", name: "valid", parentSymbolId: "Foo" });
        mockScrollFiltered.mockResolvedValueOnce([memberPred, noise]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "valid?" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Foo#valid?");
        expect(symbolIds).not.toContain("Foo#valid");
      });

      it("drops chunks whose last segment merely starts with the short query (no prefix matching)", async () => {
        const exact = baseChunk({ id: "exact", symbolId: "Foo#set", name: "set", parentSymbolId: "Foo" });
        const prefix = baseChunk({ id: "prefix", symbolId: "Foo#setValue", name: "setValue", parentSymbolId: "Foo" });
        mockScrollFiltered.mockResolvedValueOnce([exact, prefix]).mockResolvedValueOnce([]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "set" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Foo#set");
        expect(symbolIds).not.toContain("Foo#setValue");
      });

      it("admits member chunks when the parentSymbolId's last segment equals the short query", async () => {
        // find_symbol(symbol="Foo") with parent scroll returning members
        // of Foo. Members must survive the post-filter so resolveSymbols
        // can stitch them into the outline.
        const member = baseChunk({
          id: "member",
          symbolId: "Foo#bar",
          name: "bar",
          parentSymbolId: "Foo",
        });
        const noise = baseChunk({ id: "noise", symbolId: "Other#bar", name: "bar", parentSymbolId: "Other" });
        mockScrollFiltered.mockResolvedValueOnce([]).mockResolvedValueOnce([member, noise]);

        const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Foo" });
        const result = await strategy.execute({ collectionName: "c", limit: 50 });

        const symbolIds = result.map((r) => r.payload?.symbolId);
        expect(symbolIds).toContain("Foo#bar");
        expect(symbolIds).not.toContain("Other#bar");
      });
    });

    it("includes member chunks (whose parentSymbolId matches the FQN class) when query has '#'", async () => {
      // find_symbol on a class FQN should keep member chunks even though
      // the post-filter on exact symbolId would otherwise drop them.
      const classChunk = {
        id: "cls",
        payload: {
          symbolId: "Foo::Bar",
          chunkType: "class",
          name: "Bar",
          parentSymbolId: "Foo",
          relativePath: "src/foo.rb",
          content: "class Bar; end",
          startLine: 1,
          endLine: 10,
          language: "ruby",
        },
      };
      const memberChunk = {
        id: "mem",
        payload: {
          symbolId: "Foo::Bar#baz",
          chunkType: "function",
          name: "baz",
          parentSymbolId: "Bar",
          relativePath: "src/foo.rb",
          content: "def baz; end",
          startLine: 2,
          endLine: 3,
          language: "ruby",
        },
      };
      // Member scroll returns the member; primary scroll returns the class.
      mockScrollFiltered.mockResolvedValueOnce([classChunk]).mockResolvedValueOnce([memberChunk]);

      const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), {
        symbol: "Foo::Bar",
      });
      const result = await strategy.execute({ collectionName: "c", limit: 50 });

      // resolveSymbols returns the outline (class+members). The class chunk
      // emerges as one outline result that incorporates the member via
      // CodeChunkGrouper. Exact-symbolId post-filter must NOT drop the
      // member before resolveSymbols runs.
      expect(result.length).toBeGreaterThanOrEqual(1);
      const symbolIds = result.map((r) => r.payload?.symbolId);
      expect(symbolIds).toContain("Foo::Bar");
    });
  });
});
