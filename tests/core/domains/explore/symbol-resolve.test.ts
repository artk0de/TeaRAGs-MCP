import { describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

describe("resolveSymbols", () => {
  describe("function merge strategy", () => {
    it("merges multiple chunks of the same function into one result", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "function processData(input: string) {\n  const parsed = parse(input);",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "  return transform(parsed);\n}",
            startLine: 21,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("uuid-1");
      expect(results[0].score).toBe(1.0);
      expect(results[0].payload?.symbolId).toBe("processData");
      expect(results[0].payload?.startLine).toBe(10);
      expect(results[0].payload?.endLine).toBe(25);
      expect(results[0].payload?.mergedChunkIds).toEqual(["uuid-1", "uuid-2"]);
      expect(results[0].payload?.content).toContain("function processData");
      expect(results[0].payload?.content).toContain("return transform");
      expect(results[0].payload?.git).toEqual({ file: { commitCount: 5, ageDays: 30 } });
    });

    it("returns single chunk as-is without mergedChunkIds", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "simpleFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function simpleFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 10 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.mergedChunkIds).toBeUndefined();
    });

    it("strips content when metaOnly is true", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "myFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function myFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 5 } },
          },
        },
      ];

      const results = resolveSymbols(chunks, undefined, true);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBeUndefined();
      expect(results[0].payload?.symbolId).toBe("myFunc");
      expect(results[0].payload?.relativePath).toBe("src/utils.ts");
      expect(results[0].payload?.git).toBeDefined();
    });
  });

  describe("class outline strategy", () => {
    it("returns class outline via CodeChunkGrouper", () => {
      const chunks = [
        {
          id: "class-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {\n  constructor(deps: Deps) {}",
            startLine: 10,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-1",
          payload: {
            symbolId: "Reranker#score",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "score() { ... }",
            startLine: 30,
            endLine: 50,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-2",
          payload: {
            symbolId: "Reranker#rerank",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 55,
            endLine: 80,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.chunkType === "class");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.content).toContain("Reranker#score");
      expect(classResult!.payload?.content).toContain("Reranker#rerank");
      expect(classResult!.payload?.git).toEqual({ file: { commitCount: 15, ageDays: 60 } });
    });

    it("detects class from residual block with parentType=class_declaration", () => {
      const chunks = [
        {
          id: "residual-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "block",
            parentType: "class_declaration",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "export class Reranker {\n  private readonly descriptors;",
            startLine: 43,
            endLine: 46,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
        {
          id: "method-uuid",
          payload: {
            symbolId: "Reranker#rerank",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 76,
            endLine: 151,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.symbolId === "Reranker");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.content).toContain("Reranker#rerank");
    });
  });

  describe("sorting", () => {
    it("sorts exact symbolId matches before partial matches", () => {
      const chunks = [
        {
          id: "uuid-partial",
          payload: {
            symbolId: "Reranker#score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 30,
            endLine: 50,
            language: "typescript",
          },
        },
        {
          id: "uuid-exact",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "Reranker");

      expect(results[0].payload?.symbolId).toBe("Reranker");
    });

    it("sorts alphabetically by path for same match rank", () => {
      const chunks = [
        {
          id: "uuid-b",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/b/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-a",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/a/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "score");

      expect(results[0].payload?.relativePath).toBe("src/a/scorer.ts");
    });
  });

  describe("doc outline strategy", () => {
    it("groups doc chunks by parentSymbolId into outline with merged headingPath", () => {
      const chunks = [
        {
          id: "doc-1",
          payload: {
            symbolId: "doc:aaa111",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Introduction",
            headingPath: [{ depth: 1, text: "API" }],
            content: "Introduction text",
            startLine: 1,
            endLine: 10,
            language: "markdown",
            navigation: { nextSymbolId: "doc:bbb222" },
          },
        },
        {
          id: "doc-2",
          payload: {
            symbolId: "doc:bbb222",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Authentication",
            headingPath: [
              { depth: 1, text: "API" },
              { depth: 2, text: "Authentication" },
            ],
            content: "Auth content",
            startLine: 12,
            endLine: 25,
            language: "markdown",
            navigation: { prevSymbolId: "doc:aaa111", nextSymbolId: "doc:ccc333" },
          },
        },
        {
          id: "doc-3",
          payload: {
            symbolId: "doc:ccc333",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Usage",
            headingPath: [
              { depth: 1, text: "API" },
              { depth: 2, text: "Usage" },
            ],
            content: "Usage content",
            startLine: 27,
            endLine: 40,
            language: "markdown",
            navigation: { prevSymbolId: "doc:bbb222" },
          },
        },
      ];

      const results = resolveSymbols(chunks, "docs/api.md");

      expect(results).toHaveLength(1);
      const outline = results[0];
      expect(outline.payload?.relativePath).toBe("docs/api.md");
      expect(outline.payload?.content).toContain("doc:aaa111");
      expect(outline.payload?.content).toContain("doc:bbb222");
      expect(outline.payload?.content).toContain("doc:ccc333");
      expect(outline.payload?.headingPath).toEqual([
        { depth: 1, text: "API" },
        { depth: 2, text: "Authentication" },
        { depth: 2, text: "Usage" },
      ]);
    });

    it("returns doc outline with metaOnly (no content)", () => {
      const chunks = [
        {
          id: "doc-1",
          payload: {
            symbolId: "doc:aaa111",
            chunkType: "block",
            parentSymbolId: "docs/guide.md",
            relativePath: "docs/guide.md",
            isDocumentation: true,
            name: "Setup",
            headingPath: [{ depth: 2, text: "Setup" }],
            content: "Setup instructions",
            startLine: 1,
            endLine: 10,
            language: "markdown",
          },
        },
      ];

      const results = resolveSymbols(chunks, "docs/guide.md", true);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBeUndefined();
      expect(results[0].payload?.headingPath).toEqual([{ depth: 2, text: "Setup" }]);
    });
  });

  describe("split-method fragment collapse (tea-rags-mcp-lyv7k)", () => {
    // Real chunk shapes from graphql-ruby @ 28ea3ec — an oversized method whose
    // hard-cap split produced `#part1`/`#part2` fragments alongside the base
    // `#resolve` window. find_symbol must collapse all fragments of one method
    // into ONE result instead of leaking three.
    const baseSymbolId = "GraphQL::Schema::Field#resolve";
    const path = "lib/graphql/schema/field.rb";
    const splitFragments = [
      {
        id: "base-window",
        payload: {
          symbolId: baseSymbolId,
          parentSymbolId: "GraphQL::Schema::Field",
          chunkType: "function",
          relativePath: path,
          name: "resolve",
          // Base window is the most-complete single view (mirrors real
          // graphql-ruby where the base window's body is the longest fragment).
          content:
            "def resolve(object, args, query_ctx)\n  application_object = object.object\n  # ... full method body window ...\nrescue GraphQL::ExecutionError => err\n  err\nend",
          startLine: 760,
          endLine: 928,
          methodLines: 104,
          language: "ruby",
        },
      },
      {
        id: "part-2",
        payload: {
          symbolId: `${baseSymbolId}#part2`,
          parentSymbolId: baseSymbolId,
          chunkType: "function",
          relativePath: path,
          name: "resolve (part 2/2)",
          content: "rescue GraphQL::ExecutionError => err\n  err\nend",
          startLine: 869,
          endLine: 872,
          methodLines: 104,
          language: "ruby",
        },
      },
      {
        id: "part-1",
        payload: {
          symbolId: `${baseSymbolId}#part1`,
          parentSymbolId: baseSymbolId,
          chunkType: "function",
          relativePath: path,
          name: "resolve (part 1/2)",
          content: "def resolve(object, args, query_ctx)\n  application_object = object.object",
          startLine: 722,
          endLine: 869,
          methodLines: 104,
          language: "ruby",
        },
      },
    ];

    it("collapses #partN fragments and the base window into a single result", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe(baseSymbolId);
    });

    it("merged result carries the base name without the (part N/M) suffix", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results[0].payload?.name).toBe("resolve");
    });

    it("merged result lists every fragment id in mergedChunkIds", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results[0].payload?.mergedChunkIds).toEqual(expect.arrayContaining(["base-window", "part-1", "part-2"]));
    });

    it("uses the head fragment as content (begins at the signature, no duplicated overlap)", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      const content = results[0].payload?.content as string;
      // part-1 has the smallest startLine (722) — the method head, beginning at
      // `def resolve`. Exact equality proves the overlapping fragments were NOT
      // concatenated (which would duplicate the body).
      const head = splitFragments.find((c) => c.id === "part-1")!.payload.content;
      expect(content).toBe(head);
      expect(content.startsWith("def resolve")).toBe(true);
    });

    it("keeps a part fragment alone as a single result when the base window is absent", () => {
      // Only the parts survive the scroll (no separate `#resolve` window).
      const partsOnly = splitFragments.filter((c) => c.id !== "base-window");

      const results = resolveSymbols(partsOnly, baseSymbolId);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe(baseSymbolId);
    });
  });

  describe("mixed results", () => {
    it("handles functions from different files separately", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/auth.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/input.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "validate");

      expect(results).toHaveLength(2);
    });
  });

  describe("doc section reassembly from overlapping windows (D1)", () => {
    // Real payloads from the tea-rags self-index: find_symbol(symbol:
    // "doc:447d443a09c8") on search-cascade.md, in scroll order. The markdown
    // chunker sent one oversized h2 section through the character fallback:
    // every window got the "# Search Cascade" breadcrumb prepended (the first
    // one twice), consecutive windows overlap by text, and a later size cap cut
    // two windows again into "(part N/M)" pieces that keep the SAME symbolId —
    // no `#partN` suffix. Line ranges overlap and do not map 1:1 to content.
    const sectionId = "doc:447d443a09c8";
    const docPath = ".claude-plugin/tea-rags/rules/search-cascade.md";
    const sectionName = "After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)";
    const breadcrumb = "# Search Cascade";
    const sectionWindow = (
      id: string,
      chunkIndex: number,
      startLine: number,
      endLine: number,
      name: string,
      content: string,
    ) => ({
      id,
      payload: {
        symbolId: sectionId,
        parentSymbolId: docPath,
        relativePath: docPath,
        chunkType: "block",
        isDocumentation: true,
        language: "markdown",
        fileExtension: ".md",
        headingPath: [
          { depth: 1, text: "Search Cascade" },
          { depth: 2, text: sectionName },
        ],
        name,
        chunkIndex,
        startLine,
        endLine,
        content,
      },
    });
    const sectionWindows = [
      sectionWindow(
        "1c498713-9732-93cc-2125-8a55c6ee1af1",
        4,
        92,
        107,
        `${sectionName} (part 1/2)`,
        "# Search Cascade\n# Search Cascade\n## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)\n\n**First search rarely returns a complete answer.** A chunk shows where the\nsymbol lives — not the whole picture. Before synthesizing from a single chunk,\nask: _need full body / file structure / a neighbor / doc sections?_ If yes —\nnext call is `find_symbol`, NOT another search, NOT `Read`. `find_symbol` is\ninstant (no embedding), returns merged definitions, file outlines, or doc TOCs\nfrom the same index.\n\n| After search returns…                       | If you need…                            | Next call                                                                                                                                 |\n| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |\n| Chunk with method body truncated            | Full method body                        | `find_symbol(symbol: result.symbolId)`                                                                                                    |\n| Chunk whose `symbolId` ends in `#partN`     | The whole oversized symbol, reassembled | `find_symbol(symbol: result.parentSymbolId)` — collapses every `#partN` + base window into one (do NOT treat one part as the full symbol) |\n| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |\n| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |",
      ),
      sectionWindow(
        "dcfaae6a-5bc4-631c-eee3-78f2971f947b",
        6,
        106,
        117,
        `${sectionName} (part 1/2)`,
        '# Search Cascade\n| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |\n| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |\n| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |\n| Chunk from a `.md` doc                      | All sections of that doc (TOC)          | `find_symbol(symbol: result.parentSymbolId)` — parent is `doc:<hash>`                                                                     |\n| Just a doc path (no search yet)             | Table of contents of that doc           | `find_symbol(relativePath: "docs/file.md")` — heading TOC with hashes                                                                     |\n| Class chunk (constructor or one method)     | All methods / public API of the class   | `find_symbol(symbol: "ClassName")` → full class outline + bodies                                                                          |\n| Chunk from production src + diff context    | Tests describing affected scenarios     | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`                                                                                 |\n| Describe-it scope name from a stacktrace    | Leaf scope chunk with inherited setup   | `find_symbol(symbol: "<Parent>.<scope>")` + filter `chunkType: "test"`                                                                    |\n\n`find_symbol` accepts a `rerank` preset for single-call diagnostic (definition +',
      ),
      sectionWindow(
        "9c0b9385-67c3-4714-c04d-5a2c29e55d99",
        8,
        116,
        141,
        sectionName,
        '# Search Cascade\nrankingOverlay in one call). `offset` pagination works on every search tool;\nwhen a page is exhausted, retry with `offset: N` instead of inflating `limit`.\n\n**symbolId conventions (LANGUAGE-AGNOSTIC — same `#`/`.` rule for every\nlanguage; input contract for `find_symbol(symbol:)`):**\n\n- Code instance methods: `Class#method` (e.g., `Reranker#rerank`) — bound to\n  `this`/`self`. Constructors are instance-bound too (`Class#constructor`).\n- Code static / class / classmethod / associated methods: `Class.method` (e.g.,\n  `Reranker.create`)\n- Top-level functions: `functionName` (no class prefix)\n- Namespace separators are NOT a method hint: Ruby/Rust `::` (`Acme::User`) and\n  TS/JS/Python nested-class `.` (`Outer.Nested`) only scope the container —\n  methods on them still use `#`/`.` (`Acme::User#save`).\n- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results\n\nThe `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:\n`find_symbol(symbol: "Class.method")` for an instance method returns EMPTY (may\nsurface spurious drift warning) — empty result = WRONG-SEPARATOR signal, not a\nstale index. Irrelevant for `hybrid_search`\'s `symbolId` (partial substring\nmatch — pass a bare name). When unsure instance vs static, pass a **partial\nmatch** to `find_symbol` (`Class` alone, or bare `method`) and read the real\nseparator off `result.symbolId`; never downgrade an empty `find_symbol` to\nripgrep. Producer-side source of truth (how separator chosen per language at\nindex time): `.claude/rules/symbolid-convention.md` (`INSTANCE_METHOD_SEPARATOR`\nin `infra/symbolid/classify.ts`).',
      ),
      sectionWindow(
        "6f86bf3c-6b16-d1f7-d8e6-3862698a8f3c",
        5,
        107,
        108,
        `${sectionName} (part 2/2)`,
        '| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |',
      ),
      sectionWindow(
        "475a0c10-61ea-0930-cc8d-232edf32aacb",
        7,
        117,
        118,
        `${sectionName} (part 2/2)`,
        "rankingOverlay in one call). `offset` pagination works on every search tool;\nwhen a page is exhausted, retry with `offset: N` instead of inflating `limit`.",
      ),
    ];

    const sectionContent = () => resolveSymbols(sectionWindows, sectionId)[0].payload?.content as string;

    it("collapses windows sharing one doc symbolId into a single section result", () => {
      const results = resolveSymbols(sectionWindows, sectionId);

      expect(results).toHaveLength(1);
      const payload = results[0].payload!;
      expect(payload.symbolId).toBe(sectionId);
      expect(payload.isDocumentation).toBe(true);
      expect(payload.startLine).toBe(92);
      expect(payload.endLine).toBe(141);
      expect(payload.mergedChunkIds).toHaveLength(sectionWindows.length);
      expect(payload.mergedChunkIds).toEqual(expect.arrayContaining(sectionWindows.map((w) => w.id)));
    });

    it("emits every section line exactly once, however many windows repeat it", () => {
      const emitted = sectionContent().split("\n");
      const sectionLines = new Set(
        sectionWindows
          .flatMap((w) => w.payload.content.split("\n"))
          .filter((line) => line.trim() !== "" && line !== breadcrumb),
      );

      for (const line of sectionLines) {
        expect(
          emitted.filter((l) => l === line),
          line,
        ).toHaveLength(1);
      }
    });

    it("keeps the section in reading order across windows", () => {
      const content = sectionContent();
      const anchors = [
        "## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)",
        "| Chunk from one file ",
        "| Chunk that calls a helper / class ",
        "| Describe-it scope name from a stacktrace ",
        "`find_symbol` accepts a `rerank` preset",
        "rankingOverlay in one call).",
        "in `infra/symbolid/classify.ts`).",
      ];

      const positions = anchors.map((anchor) => content.indexOf(anchor));

      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it("keeps the injected breadcrumb once at the top instead of repeating it inside the body", () => {
      const content = sectionContent();

      expect(content.startsWith(`${breadcrumb}\n## After-Search Navigation`)).toBe(true);
      expect(content.split("\n").filter((line) => line === breadcrumb)).toHaveLength(1);
    });
  });

  describe("doc section stitched by text-level overlap at window seams", () => {
    // Real payloads from the tea-rags self-index (search-cascade.md at
    // 7064ff6bb): every window of find_symbol(symbol: "doc:447d443a09c8"),
    // chunkIndex 4..10. The character fallback overlaps windows by whole lines
    // and trims each window, so window 10 opens with "methods on them still use
    // …" while the text before it carries that line with its two-space
    // list-continuation indent — a whole-line comparison finds no overlap there.
    const sectionId = "doc:447d443a09c8";
    const docPath = ".claude-plugin/tea-rags/rules/search-cascade.md";
    const sectionName = "After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)";
    const breadcrumb = "# Search Cascade";
    const liveWindow = (
      id: string,
      chunkIndex: number,
      startLine: number,
      endLine: number,
      name: string,
      content: string,
    ) => ({
      id,
      payload: {
        symbolId: sectionId,
        parentSymbolId: docPath,
        relativePath: docPath,
        chunkType: "block",
        isDocumentation: true,
        language: "markdown",
        fileExtension: ".md",
        headingPath: [
          { depth: 1, text: "Search Cascade" },
          { depth: 2, text: sectionName },
        ],
        name,
        chunkIndex,
        startLine,
        endLine,
        content,
      },
    });
    const liveWindows = [
      liveWindow(
        "1c498713-9732-93cc-2125-8a55c6ee1af1",
        4,
        92,
        107,
        `${sectionName} (part 1/2)`,
        "# Search Cascade\n# Search Cascade\n## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)\n\n**First search rarely returns a complete answer.** A chunk shows where the\nsymbol lives — not the whole picture. Before synthesizing from a single chunk,\nask: _need full body / file structure / a neighbor / doc sections?_ If yes —\nnext call is `find_symbol`, NOT another search, NOT `Read`. `find_symbol` is\ninstant (no embedding), returns merged definitions, file outlines, or doc TOCs\nfrom the same index.\n\n| After search returns…                       | If you need…                            | Next call                                                                                                                                 |\n| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |\n| Chunk with method body truncated            | Full method body                        | `find_symbol(symbol: result.symbolId)`                                                                                                    |\n| Chunk whose `symbolId` ends in `#partN`     | The whole oversized symbol, reassembled | `find_symbol(symbol: result.parentSymbolId)` — collapses every `#partN` + base window into one (do NOT treat one part as the full symbol) |\n| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |\n| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |",
      ),
      liveWindow(
        "6f86bf3c-6b16-d1f7-d8e6-3862698a8f3c",
        5,
        107,
        108,
        `${sectionName} (part 2/2)`,
        '| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |',
      ),
      liveWindow(
        "11597208-1af0-b7b8-4b06-6b91141ba881",
        6,
        106,
        114,
        `${sectionName} (part 1/2)`,
        '# Search Cascade\n| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |\n| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |\n| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |\n| Chunk from a `.md` doc                      | All sections of that doc (TOC)          | `find_symbol(relativePath: result.relativePath)` — heading TOC; doc `parentSymbolId` = doc path, NOT a hash                               |\n| Just a doc path (no search yet)             | Table of contents of that doc           | `find_symbol(relativePath: "docs/file.md")` — heading TOC with hashes                                                                     |\n| Class chunk (constructor or one method)     | All methods / public API of the class   | `find_symbol(symbol: "ClassName")` → OUTLINE: member ids, NO bodies, tests excluded → drill member                                        |\n| Outline / TOC in hand (class, file, doc)    | One member / section                    | `find_symbol(symbol: <id from that line, verbatim>)` — every outline line = address. NOT `Read`, NOT grep                                 |\n| Result saved to file (too large)            | Anything inside it                      | NEVER grep / `Read` the dump — ids from preview → `find_symbol(symbol: <id>)`; no id → `find_symbol(relativePath:)` outline first         |',
      ),
      liveWindow(
        "fb3fa931-4cee-8ca6-24c5-146b8217f0f9",
        7,
        114,
        115,
        `${sectionName} (part 2/2)`,
        '| Class name, need its tests                  | Specs / test scopes of that class       | `hybrid_search(query: "ClassName", testFile: "only")` — class outline carries no tests                                                    |',
      ),
      liveWindow(
        "a282d1af-9898-d8a9-6073-7d682f6c08d7",
        8,
        113,
        136,
        `${sectionName} (part 1/2)`,
        '# Search Cascade\n| Result saved to file (too large)            | Anything inside it                      | NEVER grep / `Read` the dump — ids from preview → `find_symbol(symbol: <id>)`; no id → `find_symbol(relativePath:)` outline first         |\n| Class name, need its tests                  | Specs / test scopes of that class       | `hybrid_search(query: "ClassName", testFile: "only")` — class outline carries no tests                                                    |\n| Chunk from production src + diff context    | Tests describing affected scenarios     | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`                                                                                 |\n| Describe-it scope name from a stacktrace    | Leaf scope chunk with inherited setup   | `find_symbol(symbol: "<Top>.<scope>")` — leaf scope chunk (split scope parts share that id, merged)                                       |\n\n`find_symbol` accepts a `rerank` preset for single-call diagnostic (definition +\nrankingOverlay in one call). `offset` pagination works on every search tool;\nwhen a page is exhausted, retry with `offset: N` instead of inflating `limit`.\n\n**symbolId conventions (LANGUAGE-AGNOSTIC — same `#`/`.` rule for every\nlanguage; input contract for `find_symbol(symbol:)`):**\n\n- Code instance methods: `Class#method` (e.g., `Reranker#rerank`) — bound to\n  `this`/`self`. Constructors are instance-bound too (`Class#constructor`).\n- Code static / class / classmethod / associated methods: `Class.method` (e.g.,\n  `Reranker.create`)\n- Top-level functions: `functionName` (no class prefix)\n- Namespace separators are NOT a method hint: Ruby/Rust `::` (`Acme::User`) and\n  TS/JS/Python nested-class `.` (`Outer.Nested`) only scope the container —\n  methods on them still use `#`/`.` (`Acme::User#save`).\n- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results\n\nThe `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:',
      ),
      liveWindow(
        "09c39345-0efe-0f8e-1004-26b36b2ad89e",
        9,
        136,
        137,
        `${sectionName} (part 2/2)`,
        '`find_symbol(symbol: "Class.method")` for an instance method returns EMPTY (may',
      ),
      liveWindow(
        "1dc89a5e-374b-12c5-840a-b533e2ebfa44",
        10,
        132,
        144,
        sectionName,
        '# Search Cascade\nmethods on them still use `#`/`.` (`Acme::User#save`).\n- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results\n\nThe `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:\n`find_symbol(symbol: "Class.method")` for an instance method returns EMPTY (may\nsurface spurious drift warning) — empty result = WRONG-SEPARATOR signal, not a\nstale index. Irrelevant for `hybrid_search`\'s `symbolId` (partial substring\nmatch — pass a bare name). When unsure instance vs static, pass a **partial\nmatch** to `find_symbol` (`Class` alone, or bare `method`) and read the real\nseparator off `result.symbolId`; never downgrade an empty `find_symbol` to\nripgrep. Producer-side source of truth (how separator chosen per language at\nindex time): `.claude/rules/symbolid-convention.md` (`INSTANCE_METHOD_SEPARATOR`\nin `infra/symbolid/classify.ts`).',
      ),
    ];
    // Ground truth: search-cascade.md lines 92-143 at 7064ff6bb, from the
    // section heading through its last line. The range has no fenced code block
    // and no trailing whitespace, so it is compared byte for byte.
    const sourceSection =
      '## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)\n\n**First search rarely returns a complete answer.** A chunk shows where the\nsymbol lives — not the whole picture. Before synthesizing from a single chunk,\nask: _need full body / file structure / a neighbor / doc sections?_ If yes —\nnext call is `find_symbol`, NOT another search, NOT `Read`. `find_symbol` is\ninstant (no embedding), returns merged definitions, file outlines, or doc TOCs\nfrom the same index.\n\n| After search returns…                       | If you need…                            | Next call                                                                                                                                 |\n| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |\n| Chunk with method body truncated            | Full method body                        | `find_symbol(symbol: result.symbolId)`                                                                                                    |\n| Chunk whose `symbolId` ends in `#partN`     | The whole oversized symbol, reassembled | `find_symbol(symbol: result.parentSymbolId)` — collapses every `#partN` + base window into one (do NOT treat one part as the full symbol) |\n| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |\n| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |\n| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |\n| Chunk from a `.md` doc                      | All sections of that doc (TOC)          | `find_symbol(relativePath: result.relativePath)` — heading TOC; doc `parentSymbolId` = doc path, NOT a hash                               |\n| Just a doc path (no search yet)             | Table of contents of that doc           | `find_symbol(relativePath: "docs/file.md")` — heading TOC with hashes                                                                     |\n| Class chunk (constructor or one method)     | All methods / public API of the class   | `find_symbol(symbol: "ClassName")` → OUTLINE: member ids, NO bodies, tests excluded → drill member                                        |\n| Outline / TOC in hand (class, file, doc)    | One member / section                    | `find_symbol(symbol: <id from that line, verbatim>)` — every outline line = address. NOT `Read`, NOT grep                                 |\n| Result saved to file (too large)            | Anything inside it                      | NEVER grep / `Read` the dump — ids from preview → `find_symbol(symbol: <id>)`; no id → `find_symbol(relativePath:)` outline first         |\n| Class name, need its tests                  | Specs / test scopes of that class       | `hybrid_search(query: "ClassName", testFile: "only")` — class outline carries no tests                                                    |\n| Chunk from production src + diff context    | Tests describing affected scenarios     | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`                                                                                 |\n| Describe-it scope name from a stacktrace    | Leaf scope chunk with inherited setup   | `find_symbol(symbol: "<Top>.<scope>")` — leaf scope chunk (split scope parts share that id, merged)                                       |\n\n`find_symbol` accepts a `rerank` preset for single-call diagnostic (definition +\nrankingOverlay in one call). `offset` pagination works on every search tool;\nwhen a page is exhausted, retry with `offset: N` instead of inflating `limit`.\n\n**symbolId conventions (LANGUAGE-AGNOSTIC — same `#`/`.` rule for every\nlanguage; input contract for `find_symbol(symbol:)`):**\n\n- Code instance methods: `Class#method` (e.g., `Reranker#rerank`) — bound to\n  `this`/`self`. Constructors are instance-bound too (`Class#constructor`).\n- Code static / class / classmethod / associated methods: `Class.method` (e.g.,\n  `Reranker.create`)\n- Top-level functions: `functionName` (no class prefix)\n- Namespace separators are NOT a method hint: Ruby/Rust `::` (`Acme::User`) and\n  TS/JS/Python nested-class `.` (`Outer.Nested`) only scope the container —\n  methods on them still use `#`/`.` (`Acme::User#save`).\n- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results\n\nThe `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:\n`find_symbol(symbol: "Class.method")` for an instance method returns EMPTY (may\nsurface spurious drift warning) — empty result = WRONG-SEPARATOR signal, not a\nstale index. Irrelevant for `hybrid_search`\'s `symbolId` (partial substring\nmatch — pass a bare name). When unsure instance vs static, pass a **partial\nmatch** to `find_symbol` (`Class` alone, or bare `method`) and read the real\nseparator off `result.symbolId`; never downgrade an empty `find_symbol` to\nripgrep. Producer-side source of truth (how separator chosen per language at\nindex time): `.claude/rules/symbolid-convention.md` (`INSTANCE_METHOD_SEPARATOR`\nin `infra/symbolid/classify.ts`).';

    const mergedContent = (windows: ReturnType<typeof liveWindow>[], symbol: string) => {
      const results = resolveSymbols(windows, symbol);
      expect(results).toHaveLength(1);
      return results[0].payload?.content as string;
    };

    it("reassembles the live section exactly as the source file holds it, breadcrumb once on top", () => {
      expect(mergedContent(liveWindows, sectionId)).toBe(`${breadcrumb}\n${sourceSection}`);
    });

    it("emits each line at the trimmed-continuation seam exactly once", () => {
      const content = mergedContent(liveWindows, sectionId);
      const seam = [
        "  methods on them still use `#`/`.` (`Acme::User#save`).",
        "- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results",
        "",
        "The `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:",
      ].join("\n");

      expect(content.split(seam)).toHaveLength(2);
      expect(
        content.split("\n").filter((line) => line.trim() === "methods on them still use `#`/`.` (`Acme::User#save`)."),
      ).toHaveLength(1);
    });

    // Synthetic windows of one section: breadcrumb "# Guide", heading "## Setup".
    const guideId = "doc:0123456789ab";
    const guideWindow = (id: string, startLine: number, content: string) => ({
      id,
      payload: {
        symbolId: guideId,
        parentSymbolId: "docs/guide.md",
        relativePath: "docs/guide.md",
        chunkType: "block",
        isDocumentation: true,
        language: "markdown",
        headingPath: [
          { depth: 1, text: "Guide" },
          { depth: 2, text: "Setup" },
        ],
        name: "Setup",
        chunkIndex: startLine,
        startLine,
        endLine: startLine + 2,
        content,
      },
    });

    it("joins a window cut at a character offset on its overlap, without repeating or dropping text", () => {
      const windows = [
        guideWindow(
          "g1",
          1,
          "# Guide\n## Setup\nInstall the daemon first, then point the client at the socket path it prints",
        ),
        guideWindow(
          "g2",
          2,
          "# Guide\noint the client at the socket path it prints on startup.\nRestart the client after every upgrade.",
        ),
      ];

      expect(mergedContent(windows, guideId)).toBe(
        "# Guide\n## Setup\nInstall the daemon first, then point the client at the socket path it prints on startup.\nRestart the client after every upgrade.",
      );
    });

    it("joins a whole-line overlap shorter than the mid-line minimum, such as a trailing heading", () => {
      const windows = [
        guideWindow("g1", 1, "# Guide\n## Setup\nConfigure the socket path before the first run.\n### Notes"),
        guideWindow("g2", 2, "# Guide\n### Notes\nLogs rotate daily."),
      ];

      expect(mergedContent(windows, guideId)).toBe(
        "# Guide\n## Setup\nConfigure the socket path before the first run.\n### Notes\nLogs rotate daily.",
      );
    });

    it("does not take a short coincidental match between adjacent windows for an overlap", () => {
      const windows = [
        guideWindow("g1", 1, "# Guide\n## Setup\n| key | value |\n| --- | ----- |\n| retries | 3 |"),
        guideWindow("g2", 2, "| timeout | 30 |"),
      ];

      expect(mergedContent(windows, guideId)).toBe(
        "# Guide\n## Setup\n| key | value |\n| --- | ----- |\n| retries | 3 |\n| timeout | 30 |",
      );
    });

    it("keeps a short window whose text appears earlier only inside a longer line", () => {
      const windows = [
        guideWindow("g1", 1, "# Guide\n## Setup\nIf unsure, keep the defaults.\nProxies need a custom port."),
        guideWindow("g2", 2, "keep the defaults."),
      ];

      expect(mergedContent(windows, guideId)).toBe(
        "# Guide\n## Setup\nIf unsure, keep the defaults.\nProxies need a custom port.\nkeep the defaults.",
      );
    });
  });

  describe("doc TOC only for a document-path query (I2)", () => {
    const sections = [
      {
        id: "doc-setup",
        payload: {
          symbolId: "doc:aaa111",
          chunkType: "block",
          parentSymbolId: "docs/guide.md",
          relativePath: "docs/guide.md",
          isDocumentation: true,
          name: "Setup",
          headingPath: [{ depth: 2, text: "Setup" }],
          content: "## Setup\nSetup instructions",
          startLine: 1,
          endLine: 10,
          language: "markdown",
        },
      },
      {
        id: "doc-usage",
        payload: {
          symbolId: "doc:bbb222",
          chunkType: "block",
          parentSymbolId: "docs/guide.md",
          relativePath: "docs/guide.md",
          isDocumentation: true,
          name: "Usage",
          headingPath: [{ depth: 2, text: "Usage" }],
          content: "## Usage\nUsage content",
          startLine: 12,
          endLine: 20,
          language: "markdown",
        },
      },
    ];

    it("returns section bodies, not a TOC, when several sections of one document arrive without a document-path query", () => {
      const results = resolveSymbols(sections);

      expect(results).toHaveLength(2);
      const contents = results.map((r) => r.payload?.content);
      expect(contents).toContain("## Setup\nSetup instructions");
      expect(contents).toContain("## Usage\nUsage content");
    });
  });

  describe("class outline without a class-level chunk (D2 / I3)", () => {
    // Real shapes from the tea-rags self-index: TypeScript `StatsCache` has no
    // residual class block — find_symbol's scroll holds only method chunks
    // pointing at the class through parentSymbolId + parentType.
    const statsCacheMember = (id: string, method: string, startLine: number, endLine: number) => ({
      id,
      payload: {
        symbolId: `StatsCache#${method}`,
        name: method,
        chunkType: "function",
        parentSymbolId: "StatsCache",
        parentType: "class_declaration",
        relativePath: "src/core/infra/stats-cache.ts",
        fileExtension: ".ts",
        language: "typescript",
        content: `${method}() { /* ${method} body */ }`,
        startLine,
        endLine,
        git: { file: { commitCount: 7, ageDays: 0 }, chunk: { commitCount: 2, ageDays: 3 } },
        codegraph: { symbols: { file: { fanIn: 4, fanOut: 0 }, chunk: { fanIn: 3 } } },
      },
    });
    const statsCacheMembers = [
      statsCacheMember("save-id", "save", 92, 114),
      statsCacheMember("ctor-id", "constructor", 49, 50),
      statsCacheMember("load-id", "load", 51, 90),
    ];

    it("synthesises an outline from member chunks when the scroll holds no class chunk", () => {
      const results = resolveSymbols(statsCacheMembers, "StatsCache");

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe("StatsCache");
      expect(results[0].payload?.relativePath).toBe("src/core/infra/stats-cache.ts");
      expect(results[0].payload?.content).toBe(
        "StatsCache\n  StatsCache#constructor\n  StatsCache#load\n  StatsCache#save",
      );
    });

    it("keeps file-level git and codegraph on a synthesised outline", () => {
      const [outline] = resolveSymbols(statsCacheMembers, "StatsCache");

      expect(outline.payload?.git).toEqual({ file: { commitCount: 7, ageDays: 0 } });
      expect(outline.payload?.codegraph).toEqual({ symbols: { file: { fanIn: 4, fanOut: 0 } } });
    });

    it("emits one synthesised outline per relativePath", () => {
      const member = (id: string, symbolId: string, relativePath: string) => ({
        id,
        payload: {
          symbolId,
          chunkType: "function",
          parentSymbolId: "Foo",
          parentType: "class_declaration",
          relativePath,
          language: "typescript",
          content: `${symbolId} body`,
          startLine: 1,
          endLine: 5,
        },
      });

      const results = resolveSymbols(
        [member("a", "Foo#alpha", "src/foo.ts"), member("b", "Foo#beta", "src/foo-extra.ts")],
        "Foo",
      );

      expect(results).toHaveLength(2);
      const byPath = new Map(results.map((r) => [r.payload?.relativePath, r.payload?.content]));
      expect(byPath.get("src/foo.ts")).toBe("Foo\n  Foo#alpha");
      expect(byPath.get("src/foo-extra.ts")).toBe("Foo\n  Foo#beta");
    });

    it("matches members by the class chunk's symbolId as well as its name", () => {
      const chunks = [
        {
          id: "class-bar",
          payload: {
            symbolId: "Foo::Bar",
            name: "Bar",
            chunkType: "class",
            relativePath: "lib/foo/bar.rb",
            language: "ruby",
            content: "class Bar\nend",
            startLine: 1,
            endLine: 30,
          },
        },
        {
          id: "by-fqn",
          payload: {
            symbolId: "Foo::Bar#save",
            chunkType: "function",
            parentSymbolId: "Foo::Bar",
            parentType: "class",
            relativePath: "lib/foo/bar.rb",
            language: "ruby",
            content: "def save\nend",
            startLine: 5,
            endLine: 10,
          },
        },
        {
          id: "by-name",
          payload: {
            symbolId: "Foo::Bar#load",
            chunkType: "function",
            parentSymbolId: "Bar",
            parentType: "class",
            relativePath: "lib/foo/bar.rb",
            language: "ruby",
            content: "def load\nend",
            startLine: 12,
            endLine: 20,
          },
        },
      ];

      const results = resolveSymbols(chunks, "Foo::Bar");

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBe("Bar\n  Foo::Bar#save\n  Foo::Bar#load");
    });

    it("lists a class cut into several class-level blocks once, without its own id as a member", () => {
      // Ruby `Platform::Async::Operation::Worker` on taxdome: the class body is
      // several `block` chunks whose symbolId, name AND parentSymbolId are all
      // the class FQN.
      const block = (id: string, startLine: number, endLine: number) => ({
        id,
        payload: {
          symbolId: "Platform::Async::Operation::Worker",
          name: "Platform::Async::Operation::Worker",
          chunkType: "block",
          parentSymbolId: "Platform::Async::Operation::Worker",
          parentType: "class",
          relativePath: "lib/platform/async/operation/worker.rb",
          language: "ruby",
          content: `# class body ${startLine}`,
          startLine,
          endLine,
        },
      });
      const chunks = [
        block("block-34", 34, 35),
        block("block-126", 126, 126),
        {
          id: "perform",
          payload: {
            symbolId: "Platform::Async::Operation::Worker#perform",
            name: "perform",
            chunkType: "function",
            parentSymbolId: "Platform::Async::Operation::Worker",
            parentType: "class",
            relativePath: "lib/platform/async/operation/worker.rb",
            language: "ruby",
            content: "def perform(id)\n  run(id)\nend",
            startLine: 86,
            endLine: 116,
          },
        },
      ];

      const results = resolveSymbols(chunks, "Platform::Async::Operation::Worker");

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBe(
        "Platform::Async::Operation::Worker\n  Platform::Async::Operation::Worker#perform",
      );
    });

    it("does not synthesise an outline when the shared parent is not a class/module container", () => {
      const nested = (id: string, symbolId: string) => ({
        id,
        payload: {
          symbolId,
          chunkType: "function",
          parentSymbolId: "handler",
          parentType: "function_declaration",
          relativePath: "src/handler.ts",
          language: "typescript",
          content: `function ${symbolId}() {}`,
          startLine: 1,
          endLine: 3,
        },
      });

      const results = resolveSymbols([nested("n1", "handler.first"), nested("n2", "handler.second")], "handler");

      expect(results.map((r) => r.payload?.content)).toEqual(
        expect.arrayContaining(["function handler.first() {}", "function handler.second() {}"]),
      );
    });
  });

  describe("test chunks under a class query (A1 / A2)", () => {
    const workerFqn = "Platform::Async::Operation::Worker";
    const workerSpec = "spec/lib/platform/async/operation/worker_spec.rb";
    const describeWorker = `${workerFqn}.RSpec.describe ${workerFqn}`;
    // Real shapes from taxdome: every chunk of worker_spec.rb carries the
    // top-level describe id and points at the described class.
    const specChunk = (id: string, startLine: number, endLine: number) => ({
      id,
      payload: {
        symbolId: describeWorker,
        name: `RSpec.describe ${workerFqn}`,
        chunkType: "test",
        isTest: true,
        parentSymbolId: workerFqn,
        parentType: "call",
        relativePath: workerSpec,
        language: "ruby",
        content: `it "works ${startLine}" do\n  expect(worker).to be_ok\nend`,
        startLine,
        endLine,
        git: { file: { commitCount: 4, ageDays: 7 }, chunk: { commitCount: 1, ageDays: 26 } },
        codegraph: { symbols: { file: { skippedAs: "test" }, chunk: { skippedAs: "test" } } },
      },
    });
    const workerSource = [
      {
        id: "worker-block",
        payload: {
          symbolId: workerFqn,
          name: workerFqn,
          chunkType: "block",
          parentSymbolId: workerFqn,
          parentType: "class",
          relativePath: "lib/platform/async/operation/worker.rb",
          language: "ruby",
          content: "class Worker\n  include Sidekiq::Job",
          startLine: 34,
          endLine: 35,
          git: { file: { commitCount: 4, ageDays: 7 }, chunk: { commitCount: 1, ageDays: 26 } },
        },
      },
      {
        id: "worker-record-class",
        payload: {
          symbolId: `${workerFqn}.record_class`,
          name: "record_class",
          chunkType: "function",
          parentSymbolId: workerFqn,
          parentType: "class",
          relativePath: "lib/platform/async/operation/worker.rb",
          language: "ruby",
          content: "def self.record_class\n  Record\nend",
          startLine: 54,
          endLine: 57,
        },
      },
      {
        id: "worker-perform",
        payload: {
          symbolId: `${workerFqn}#perform`,
          name: "perform",
          chunkType: "function",
          parentSymbolId: workerFqn,
          parentType: "class",
          relativePath: "lib/platform/async/operation/worker.rb",
          language: "ruby",
          content: "def perform(id)\n  run(id)\nend",
          startLine: 86,
          endLine: 116,
        },
      },
    ];
    const workerSpecChunks = [
      specChunk("spec-99", 99, 105),
      specChunk("spec-76", 76, 89),
      specChunk("spec-91", 91, 97),
    ];

    it("drops the class's spec chunks from a response that outlines the class", () => {
      const results = resolveSymbols([...workerSpecChunks, ...workerSource], workerFqn);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBe(
        [workerFqn, `  ${workerFqn}.record_class`, `  ${workerFqn}#perform`].join("\n"),
      );
      expect(results.map((r) => r.payload?.relativePath)).not.toContain(workerSpec);
    });

    it("drops test chunks from every file, whether they name the class by symbolId or by name", () => {
      const testChunk = (
        id: string,
        symbolId: string,
        parentSymbolId: string,
        relativePath: string,
        extra: object,
      ) => ({
        id,
        payload: {
          symbolId,
          parentSymbolId,
          parentType: "call",
          relativePath,
          language: "ruby",
          content: `# test body ${id}`,
          startLine: 1,
          endLine: 9,
          ...extra,
        },
      });
      const chunks = [
        {
          id: "class-bar",
          payload: {
            symbolId: "Foo::Bar",
            name: "Bar",
            chunkType: "class",
            relativePath: "lib/foo/bar.rb",
            language: "ruby",
            content: "class Bar\nend",
            startLine: 1,
            endLine: 30,
          },
        },
        {
          id: "bar-save",
          payload: {
            symbolId: "Foo::Bar#save",
            name: "save",
            chunkType: "function",
            parentSymbolId: "Foo::Bar",
            parentType: "class",
            relativePath: "lib/foo/bar.rb",
            language: "ruby",
            content: "def save\nend",
            startLine: 5,
            endLine: 10,
          },
        },
        testChunk("by-fqn", "Foo::Bar.RSpec.describe Foo::Bar", "Foo::Bar", "spec/lib/foo/bar_spec.rb", {
          chunkType: "test",
          isTest: true,
        }),
        testChunk("setup-by-name", "Bar.let(:bar)", "Bar", "spec/legacy/bar_spec.rb", { chunkType: "test_setup" }),
        testChunk("flagged-block", "Bar.shared_examples 'saves'", "Bar", "spec/support/bar_examples.rb", {
          chunkType: "block",
          isTest: true,
        }),
      ];

      const results = resolveSymbols(chunks, "Foo::Bar");

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBe("Bar\n  Foo::Bar#save");
    });

    it("drops test chunks from a response whose outline is synthesised from member chunks", () => {
      const member = (id: string, method: string, startLine: number) => ({
        id,
        payload: {
          symbolId: `StatsCache#${method}`,
          name: method,
          chunkType: "function",
          parentSymbolId: "StatsCache",
          parentType: "class_declaration",
          relativePath: "src/core/infra/stats-cache.ts",
          language: "typescript",
          content: `${method}() {}`,
          startLine,
          endLine: startLine + 10,
        },
      });
      const chunks = [
        member("load-id", "load", 51),
        member("save-id", "save", 92),
        {
          id: "stats-cache-test",
          payload: {
            symbolId: 'StatsCache.describe "StatsCache"',
            chunkType: "test",
            isTest: true,
            parentSymbolId: "StatsCache",
            parentType: "call_expression",
            relativePath: "tests/core/infra/stats-cache.test.ts",
            language: "typescript",
            content: 'describe("StatsCache", () => {})',
            startLine: 1,
            endLine: 40,
          },
        },
      ];

      const results = resolveSymbols(chunks, "StatsCache");

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBe("StatsCache\n  StatsCache#load\n  StatsCache#save");
    });

    it("merges test chunks by symbolId when the scroll holds no source class or member for the query", () => {
      const results = resolveSymbols(workerSpecChunks, workerFqn);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe(describeWorker);
      expect(results[0].payload?.relativePath).toBe(workerSpec);
      expect(results[0].payload?.mergedChunkIds).toEqual(["spec-76", "spec-91", "spec-99"]);
      expect(results[0].payload?.content).toBe(
        [76, 91, 99].map((line) => `it "works ${line}" do\n  expect(worker).to be_ok\nend`).join("\n"),
      );
    });

    it("keeps one merged result per test symbolId when only tests are in the scroll", () => {
      const otherSpec = "spec/lib/platform/async/operation/worker_retry_spec.rb";
      const retryChunk = {
        id: "retry-spec",
        payload: {
          ...specChunk("retry-spec", 3, 20).payload,
          symbolId: `${workerFqn}.RSpec.describe ${workerFqn}, "retries"`,
          relativePath: otherSpec,
          content: "it retries",
        },
      };

      const results = resolveSymbols([...workerSpecChunks, retryChunk], workerFqn);

      expect(results).toHaveLength(2);
      const byPath = new Map(results.map((r) => [r.payload?.relativePath, r.payload?.symbolId]));
      expect(byPath.get(workerSpec)).toBe(describeWorker);
      expect(byPath.get(otherSpec)).toBe(`${workerFqn}.RSpec.describe ${workerFqn}, "retries"`);
    });
  });
});
