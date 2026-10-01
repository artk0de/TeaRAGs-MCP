/**
 * `readReviewFileEdges` + `ReviewEdgeOverlay` — slice A of the working-tree
 * file-edge overlay (bd tea-rags-mcp-89k7k.1.2, F1): one changed file's import
 * edges read from the working tree the diff belongs to, and the pure
 * per-review view F2's detectors will read the indexed graph through.
 *
 * A temp working tree holds the files; no index, no DuckDB. TypeScript is the
 * one language whose import→file mapper answers from disk (tsconfig + project
 * file probe, bound through the language facade the injected factory returns),
 * so it is the one that resolves here; the other codegraph languages' mappers
 * answer from the indexed symbol table and report `unsupportedLanguage` until
 * slice B hydrates it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readReviewFileEdges,
  ReviewEdgeOverlay,
  workingTreeExtractionContext,
  type ReviewEdgeExtractionDeps,
  type ReviewFileEdgeRead,
} from "../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../src/core/domains/language/index.js";

/** One temp working tree per test; removed afterwards. */
let workTree: string | undefined;

afterEach(() => {
  if (workTree !== undefined) rmSync(workTree, { recursive: true, force: true });
  workTree = undefined;
});

/** Creates `workTree` and writes `text` at `relPath`, making parent dirs. */
function writeFile(relPath: string, text: string): string {
  const absolute = join(workTree!, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
  return relPath;
}

function freshWorkTree(): string {
  workTree = mkdtempSync(join(tmpdir(), "review-edge-overlay-"));
  return workTree;
}

/** The real trio, the same wires `createNamingReviewExtractor` uses. */
function realDeps(): ReviewEdgeExtractionDeps {
  return {
    languageFactory: new LanguageFactory({}),
    collectSymbols,
    composer: new DefaultSymbolIdComposer(),
  };
}

describe("readReviewFileEdges", () => {
  it("resolves a relative import to the working-tree file it names", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/a.ts", 'import { B } from "./b";\nexport const A = B;\n');

    const read = await readReviewFileEdges(realDeps(), tree, "src/a.ts");

    expect(read.relPath).toBe("src/a.ts");
    expect(read.language).toBe("typescript");
    expect(read.skip).toBeUndefined();
    expect(read.edges).toEqual([{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" }]);
  });

  it("gives no edge for a package-style import a tsconfig-less tree cannot resolve", async () => {
    const tree = freshWorkTree();
    writeFile("src/a.ts", 'import { X } from "some-pkg/x";\nexport const A = X;\n');

    const read = await readReviewFileEdges(realDeps(), tree, "src/a.ts");

    // Honest slice-A pin: a bare specifier without a tsconfig `paths` alias and
    // without node_modules names no project file, so no edge is fabricated.
    expect(read.edges).toEqual([]);
    expect(read.skip).toBeUndefined();
  });

  it("resolves a package-style import through the working tree's own tsconfig paths", async () => {
    const tree = freshWorkTree();
    writeFile("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/alias.ts", 'import { B } from "@/b";\nexport const A = B;\n');

    const read = await readReviewFileEdges(realDeps(), tree, "src/alias.ts");

    expect(read.edges).toEqual([{ sourceRelPath: "src/alias.ts", targetRelPath: "src/b.ts" }]);
  });

  it("drops an import whose target the working tree no longer holds", async () => {
    const tree = freshWorkTree();
    // `./gone` names no file on disk: the mapper's unverified `.ts` fallback
    // must not survive the working-tree existence gate.
    writeFile("src/a.ts", 'import { NOPE } from "./gone";\nexport const A = 1;\n');

    const read = await readReviewFileEdges(realDeps(), tree, "src/a.ts");

    expect(read.edges).toEqual([]);
    expect(read.skip).toBeUndefined();
  });

  it("reports noCodegraphLanguage for an extension no codegraph language walks", async () => {
    const tree = freshWorkTree();
    writeFile("docs/notes.md", "# Notes\n\nProse only.\n");

    const read = await readReviewFileEdges(realDeps(), tree, "docs/notes.md");

    expect(read.language).toBeUndefined();
    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("noCodegraphLanguage");
  });

  it("reports unreadable for a path the working tree does not hold", async () => {
    const tree = freshWorkTree();

    const read = await readReviewFileEdges(realDeps(), tree, "src/missing.ts");

    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("unreadable");
    expect(read.skip?.detail).toBeTruthy();
  });

  it("reports unsupportedLanguage for a language whose import mapper is index-backed", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", 'class User\n  def name = "n"\nend\n');

    const read = await readReviewFileEdges(realDeps(), tree, "app/models/user.rb");

    // The walk succeeds (the Ruby grammar is installed); the gate is the
    // mapper: Ruby's file edges answer from indexed state slice A cannot hydrate.
    expect(read.language).toBe("ruby");
    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("unsupportedLanguage");
  });

  it("still extracts a syntax-broken TypeScript file — the walk is error-tolerant, not parseFailed", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/broken.ts", 'import { B } from "./b";\nconst x: = {{{{\nfunction f( {\n');

    const read = await readReviewFileEdges(realDeps(), tree, "src/broken.ts");

    // Honest pin: tree-sitter recovers, the walker extracts the import, and the
    // review gains the edge. `parseFailed` fires only when the walk THROWS.
    expect(read.language).toBe("typescript");
    expect(read.skip).toBeUndefined();
    expect(read.edges).toEqual([{ sourceRelPath: "src/broken.ts", targetRelPath: "src/b.ts" }]);
  });

  it("reports parseFailed for a file whose extraction throws, without killing the batch", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/a.ts", 'import { B } from "./b";\nexport function f(): void {}\n');
    const throwing: ReviewEdgeExtractionDeps = {
      languageFactory: new LanguageFactory({}),
      collectSymbols: () => {
        throw new Error("collectSymbols exploded");
      },
      composer: new DefaultSymbolIdComposer(),
    };

    const bad = await readReviewFileEdges(throwing, tree, "src/a.ts");
    const good = await readReviewFileEdges(realDeps(), tree, "src/a.ts");

    expect(bad.skip?.reason).toBe("parseFailed");
    expect(bad.skip?.detail).toContain("collectSymbols exploded");
    expect(bad.edges).toEqual([]);
    expect(good.skip).toBeUndefined();
    expect(good.edges).toEqual([{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" }]);
  });

  it("drops self-edges and dedupes imports that resolve to the same target", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile(
      "src/self.ts",
      'import { S } from "./self";\nimport { S2 } from "./self.js";\nexport const S = 1;\nexport const S2 = 2;\n',
    );
    writeFile(
      "src/twice.ts",
      'import { B } from "./b";\nimport { B as B2 } from "./b.js";\nexport const T = B + B2;\n',
    );

    const self = await readReviewFileEdges(realDeps(), tree, "src/self.ts");
    const twice = await readReviewFileEdges(realDeps(), tree, "src/twice.ts");

    expect(self.edges).toEqual([]);
    expect(twice.edges).toEqual([{ sourceRelPath: "src/twice.ts", targetRelPath: "src/b.ts" }]);
  });
});

describe("workingTreeExtractionContext", () => {
  it("carries the working tree's Gemfile content when one is present", () => {
    const tree = freshWorkTree();
    writeFile("Gemfile", 'source "https://rubygems.org"\n');

    const context = workingTreeExtractionContext(tree, new LanguageFactory({}));

    expect(context.gemfileContent).toBe('source "https://rubygems.org"\n');
    expect(context.declaredDependencies).toBeUndefined();
  });

  it("carries neither half when the tree declares no manifest", () => {
    const tree = freshWorkTree();

    const context = workingTreeExtractionContext(tree, new LanguageFactory({}));

    expect(context.gemfileContent).toBeUndefined();
    expect(context.declaredDependencies).toBeUndefined();
  });
});

describe("ReviewEdgeOverlay", () => {
  function read(
    relPath: string,
    edges: readonly [string, string][],
    skip?: ReviewFileEdgeRead["skip"],
  ): ReviewFileEdgeRead {
    return {
      relPath,
      edges: edges.map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath })),
      ...(skip !== undefined ? { skip } : {}),
    };
  }

  it("masks every read relPath, whatever the read found", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [["src/a.ts", "src/b.ts"]]),
      read("src/empty.ts", []),
      read("docs/notes.md", [], { reason: "noCodegraphLanguage" }),
      read("src/gone.ts", [], { reason: "unreadable", detail: "ENOENT" }),
    ]);

    expect([...overlay.masked].sort()).toEqual(["docs/notes.md", "src/a.ts", "src/empty.ts", "src/gone.ts"]);
  });

  it("answers edgesFrom for a file with edges, without edges, and outside the read", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [
        ["src/a.ts", "src/b.ts"],
        ["src/a.ts", "src/c.ts"],
      ]),
      read("src/empty.ts", []),
    ]);

    expect(overlay.edgesFrom("src/a.ts")).toEqual([
      { sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" },
      { sourceRelPath: "src/a.ts", targetRelPath: "src/c.ts" },
    ]);
    expect(overlay.edgesFrom("src/empty.ts")).toEqual([]);
    expect(overlay.edgesFrom("src/unchanged.ts")).toEqual([]);
  });

  it("lists the skipped reads with their reasons and details", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [["src/a.ts", "src/b.ts"]]),
      read("docs/notes.md", [], { reason: "noCodegraphLanguage" }),
      read("src/gone.ts", [], { reason: "unreadable", detail: "ENOENT: no such file" }),
      read("app/user.rb", [], { reason: "unsupportedLanguage", detail: "index-backed mapper" }),
      read("src/broken.py", [], { reason: "parseFailed", detail: "grammar missing" }),
    ]);

    expect(overlay.unsupported()).toEqual([
      { relPath: "docs/notes.md", reason: "noCodegraphLanguage" },
      { relPath: "src/gone.ts", reason: "unreadable", detail: "ENOENT: no such file" },
      { relPath: "app/user.rb", reason: "unsupportedLanguage", detail: "index-backed mapper" },
      { relPath: "src/broken.py", reason: "parseFailed", detail: "grammar missing" },
    ]);
  });

  it("hands out frozen edge views — the overlay is pure after construction", () => {
    const overlay = new ReviewEdgeOverlay([read("src/a.ts", [["src/a.ts", "src/b.ts"]])]);

    expect(Object.isFrozen(overlay.edgesFrom("src/a.ts"))).toBe(true);
    expect(Object.isFrozen(overlay.edgesFrom("src/empty.ts"))).toBe(true);
  });
});
