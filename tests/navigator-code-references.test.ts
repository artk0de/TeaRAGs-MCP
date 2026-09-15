/**
 * Domain navigators cite code by SYMBOL, never by line number (bd tea-rags-mcp-39xca.8).
 *
 * The nested `src/**\/CLAUDE.md` navigators are read by agents who then follow
 * each pointer into the code. A `file.ts:123` pointer drifts silently: the file
 * keeps its name, line 123 becomes something else, and the reader lands on the
 * wrong statement with nothing telling them so. Measured before this guard: the
 * codegraph navigator sent readers to `completion-runner.ts:121` for the deferred
 * chunk pass and the enrichment navigator put `createRunState` "at :742" when it
 * had moved ~460 lines down.
 *
 * A symbol reference (`Class#method`, `Class.method`, `functionName`, or a file
 * plus a symbol) is what `find_symbol` resolves, and it breaks loudly — the
 * lookup comes back empty — instead of pointing somewhere plausible.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Extensions a line-number citation into this repo can carry. */
const SOURCE_EXTENSIONS = "ts|tsx|mts|cts|js|mjs|cjs|json|py|rb|go|rs|java|sql|sh|ya?ml|md";

/** `:12`, `:12-34`, `:12, 40`, `:82-88,91-94,100` — one number, a range, or a list of either. */
const LINE_SPEC = String.raw`\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*:?\d+(?:\s*[-–]\s*\d+)?)*`;

/**
 * Each pattern names one citation shape. They are matched independently and
 * de-duplicated by position, so a shape two patterns both see is reported once.
 */
const LINE_REFERENCE_PATTERNS: readonly RegExp[] = [
  // `file.ts:123`, `sync/quarantine-store.ts:51`, `worker-pool.ts:19-30, factory.ts:273`
  new RegExp(String.raw`[\w./-]*\.(?:${SOURCE_EXTENSIONS}):${LINE_SPEC}`, "g"),
  // bare `:742`, `(:83-89)`, `at :430`, `` `:326` `` — a colon directly after a
  // boundary. The boundary excludes digits (`10:30`, `3:1`), word characters
  // (`localhost:6333`, `node:fs`), `:` (`Outer::Inner`) and `[` (slices `[:10]`).
  new RegExp(String.raw`(?<=^|[\s(\x60,;])(?::${LINE_SPEC})(?![\w:])`, "g"),
  // GitHub-style anchors: `#L123`, `#L12-L34`
  /#L\d+(?:-L?\d+)?\b/g,
  // `L12-L34` ranges and multi-digit `L123` markers. Single-digit `L3` stays
  // legal: it names a LEVEL (alpha-blending L3, locality L1 / L2 / L3).
  /\bL\d+-L\d+\b|\bL\d{2,}\b/g,
];

interface LineReferenceOffense {
  /** 1-based line inside the navigator. */
  line: number;
  text: string;
}

/** Every line-number code reference in `markdown`, in document order. */
function findLineNumberReferences(markdown: string): LineReferenceOffense[] {
  return markdown.split("\n").flatMap((content, index) => {
    const matches = LINE_REFERENCE_PATTERNS.flatMap((pattern) =>
      [...content.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      })),
    ).sort((a, b) => a.start - b.start || b.end - a.end);
    // Keep the widest match at each position; drop any that starts inside a kept one.
    const kept: typeof matches = [];
    for (const match of matches) {
      const previous = kept.at(-1);
      if (previous === undefined || match.start >= previous.end) kept.push(match);
    }
    return kept.map((match) => ({ line: index + 1, text: match.text }));
  });
}

/** Every nested navigator under `src/`, repo-relative with POSIX separators. */
function navigators(): string[] {
  return readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .map((entry) => `src/${entry.split(/[\\/]/).join("/")}`)
    .filter((file) => file.endsWith("/CLAUDE.md"))
    .sort();
}

describe("findLineNumberReferences", () => {
  it.each([
    ["file with a line", "see (completion-runner.ts:121) for the pass", "completion-runner.ts:121"],
    ["path with a range", "`freshness/freshness-check.ts:57-66` reads", "freshness/freshness-check.ts:57-66"],
    ["path with a list", "`reindexing.ts:185,207,617` all pass", "reindexing.ts:185,207,617"],
    ["path with a spaced list", "(applier.ts:295, 343, 348)", "applier.ts:295, 343, 348"],
    ["non-ts source", "`cleanup-worktree-clone.sh:34-40`", "cleanup-worktree-clone.sh:34-40"],
    ["bare line in parens", "`#markFailed` (:83-89) persists", ":83-89"],
    ["bare line after at", "`createRunState` at :742 — own applier", ":742"],
    ["bare line in backticks", "and `:326` is the only way", ":326"],
    ["bare mixed list", "then read sessions (:90,95-98), while", ":90,95-98"],
    ["github anchor", "blob/main/src/a.ts#L42", "#L42"],
    ["L range", "lines L12-L34 of the walker", "L12-L34"],
    ["multi-digit L marker", "the check at L123 declines", "L123"],
  ])("flags a %s", (_label, markdown, expected) => {
    expect(findLineNumberReferences(markdown).map((offense) => offense.text)).toEqual([expected]);
  });

  it("reports each citation once, even when two shapes overlap", () => {
    expect(findLineNumberReferences("(worker-pool.ts:19-30, factory.ts:273)").map((o) => o.text)).toEqual([
      "worker-pool.ts:19-30",
      "factory.ts:273",
    ]);
  });

  it.each([
    ["a clock time", "the watcher fired at 10:30 and again at 23:59"],
    ["a ratio", "a 3:1 split between file and chunk weight"],
    ["a version string", "tea-rags v1.41.0, walker 5, node 24.14.1"],
    ["a host port", "QDRANT_URL=http://localhost:6333"],
    ["a node builtin", 'import { readFileSync } from "node:fs"'],
    ["a namespace separator", "`Outer::Inner` resolves through the constant pass"],
    ["a python slice", "`parts[:2]` keeps the package prefix"],
    ["a symbol reference", "`TSProgramCache#acquire` and `LanguageFactory.create`"],
    ["a level marker", "Alpha-Blending (L3) and the L1 / L2 / L3 locality cascade"],
    ["a corpus line number in prose", "puts the module, not the class, on lines 205 and 206"],
    ["a file without a line", "`chunker/infra/pool.ts` forks the compiled worker"],
    ["a label colon", "Why: the maturity gate"],
  ])("leaves %s alone", (_label, markdown) => {
    expect(findLineNumberReferences(markdown)).toEqual([]);
  });
});

describe("domain navigators", () => {
  it("finds the navigators to scan", () => {
    expect(navigators().length).toBeGreaterThan(0);
  });

  it("cite code by symbol, never by line number", () => {
    const offenses = navigators().flatMap((path) =>
      findLineNumberReferences(readFileSync(join(ROOT, path), "utf8")).map(
        (offense) => `${path}:${offense.line} → ${offense.text}`,
      ),
    );
    // Joined, not compared as an array: vitest truncates a long array diff to its
    // length, and the whole point of the failure is the list of places to fix.
    expect(
      offenses.join("\n"),
      `${offenses.length} line-number code reference(s); cite a symbol find_symbol resolves instead`,
    ).toBe("");
  });
});
