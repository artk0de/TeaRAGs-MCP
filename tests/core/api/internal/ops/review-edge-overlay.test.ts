/**
 * `readWorkingTreeFileEdges` — slice A of the working-tree
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

import { DiffDetectorRun } from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import {
  readWorkingTreeFileEdges,
  workingTreeExtractionContext,
  type ReviewEdgeExtractionDeps,
} from "../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../src/core/domains/language/index.js";
import {
  ReviewEdgeOverlay,
  type LayeringReading,
} from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import { catalogOf, graphOf } from "./__helpers__/diff-run-fixtures.js";

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

describe("readWorkingTreeFileEdges", () => {
  it("resolves a relative import to the working-tree file it names", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/a.ts", 'import { B } from "./b";\nexport const A = B;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.ts");

    expect(read.relPath).toBe("src/a.ts");
    expect(read.language).toBe("typescript");
    expect(read.skip).toBeUndefined();
    expect(read.edges).toEqual([{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] }]);
  });

  it("gives no edge for a package-style import a tsconfig-less tree cannot resolve", async () => {
    const tree = freshWorkTree();
    writeFile("src/a.ts", 'import { X } from "some-pkg/x";\nexport const A = X;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.ts");

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

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/alias.ts");

    expect(read.edges).toEqual([
      { sourceRelPath: "src/alias.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] },
    ]);
  });

  it("drops an import whose target the working tree no longer holds", async () => {
    const tree = freshWorkTree();
    // `./gone` names no file on disk: the mapper's unverified `.ts` fallback
    // must not survive the working-tree existence gate.
    writeFile("src/a.ts", 'import { NOPE } from "./gone";\nexport const A = 1;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.ts");

    expect(read.edges).toEqual([]);
    expect(read.skip).toBeUndefined();
  });

  it("reports noCodegraphLanguage for an extension no codegraph language walks", async () => {
    const tree = freshWorkTree();
    writeFile("docs/notes.md", "# Notes\n\nProse only.\n");

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "docs/notes.md");

    expect(read.language).toBeUndefined();
    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("noCodegraphLanguage");
  });

  it("reports unreadable for a path the working tree does not hold", async () => {
    const tree = freshWorkTree();

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/missing.ts");

    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("unreadable");
    expect(read.skip?.detail).toBeTruthy();
  });

  it("reports unsupportedLanguage for a language whose import mapper is index-backed", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", 'class User\n  def name = "n"\nend\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "app/models/user.rb");

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

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/broken.ts");

    // Honest pin: tree-sitter recovers, the walker extracts the import, and the
    // review gains the edge. `parseFailed` fires only when the walk THROWS.
    expect(read.language).toBe("typescript");
    expect(read.skip).toBeUndefined();
    expect(read.edges).toEqual([
      { sourceRelPath: "src/broken.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] },
    ]);
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

    const bad = await readWorkingTreeFileEdges(throwing, tree, "src/a.ts");
    const good = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.ts");

    expect(bad.skip?.reason).toBe("parseFailed");
    expect(bad.skip?.detail).toContain("collectSymbols exploded");
    expect(bad.edges).toEqual([]);
    expect(good.skip).toBeUndefined();
    expect(good.edges).toEqual([{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] }]);
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

    const self = await readWorkingTreeFileEdges(realDeps(), tree, "src/self.ts");
    const twice = await readWorkingTreeFileEdges(realDeps(), tree, "src/twice.ts");

    expect(self.edges).toEqual([]);
    expect(twice.edges).toEqual([
      { sourceRelPath: "src/twice.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] },
    ]);
  });

  it("keeps the export names each statement records — imported and re-exported — through read and overlay", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/c.ts", "export const C = 1;\n");
    writeFile("src/facade.ts", 'import { C } from "./c";\nexport { B } from "./b";\nexport const F = 1;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/facade.ts");
    const overlay = new ReviewEdgeOverlay([read]);

    expect(overlay.edgesFrom("src/facade.ts")).toEqual([
      { sourceRelPath: "src/facade.ts", targetRelPath: "src/c.ts", importedExportNames: ["C"] },
      { sourceRelPath: "src/facade.ts", targetRelPath: "src/b.ts", reexportedExportNames: ["B"] },
    ]);
  });

  it("unions the names of duplicate targets in first-seen order — two statements, one edge", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\nexport const C = 2;\n");
    writeFile("src/twice.ts", 'import { B } from "./b";\nimport { C } from "./b.js";\nexport const T = B + C;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/twice.ts");

    expect(read.edges).toEqual([
      { sourceRelPath: "src/twice.ts", targetRelPath: "src/b.ts", importedExportNames: ["B", "C"] },
    ]);
  });
});

/**
 * Type-only imports are structural dependencies (bd tea-rags-mcp-89k7k.31): the
 * index merges their resolved edges into `cg_symbols_edges_file`, so the
 * review's overlay must carry them too, or a diff judges a smaller graph than
 * the whole-repo report does (bd tea-rags-mcp-c9a40).
 */
describe("readWorkingTreeFileEdges — type-only imports", () => {
  // The TypeScript walker records a type-only import's specifier and line only
  // (`typeOnlyImportRef`), so the index's type-only edge carries no export
  // names — and neither does the overlay's: parity, not a richer read.
  it("yields the edge the value-import form yields for an `import type`, names unrecorded as in the index", async () => {
    const tree = freshWorkTree();
    writeFile("src/deep/internal.ts", "export interface Shape { a: number }\nexport const SHAPE = 1;\n");
    writeFile("src/value.ts", 'import { Shape } from "./deep/internal";\nexport const v: Shape = { a: 1 };\n');
    writeFile("src/typed.ts", 'import type { Shape } from "./deep/internal";\nexport const v: Shape = { a: 1 };\n');

    const value = await readWorkingTreeFileEdges(realDeps(), tree, "src/value.ts");
    const typed = await readWorkingTreeFileEdges(realDeps(), tree, "src/typed.ts");

    expect(value.edges).toEqual([
      { sourceRelPath: "src/value.ts", targetRelPath: "src/deep/internal.ts", importedExportNames: ["Shape"] },
    ]);
    expect(typed.edges).toEqual([{ sourceRelPath: "src/typed.ts", targetRelPath: "src/deep/internal.ts" }]);
  });

  it("collapses a runtime and a type-only import of one target into one edge, the runtime names kept", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export interface Shape { a: number }\nexport const B = 1;\n");
    writeFile("src/c.ts", "export interface Other { c: number }\n");
    writeFile(
      "src/both.ts",
      'import { B } from "./b";\nimport type { Shape } from "./b.js";\nimport type { Other } from "./c";\n' +
        "export const v: Shape = { a: B };\nexport type O = Other;\n",
    );

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/both.ts");

    expect(read.edges).toEqual([
      { sourceRelPath: "src/both.ts", targetRelPath: "src/b.ts", importedExportNames: ["B"] },
      { sourceRelPath: "src/both.ts", targetRelPath: "src/c.ts" },
    ]);
  });

  it("an `import type` from a foundation into a higher layer is the layeringBackEdge the value import is", async () => {
    const tree = freshWorkTree();
    writeFile("src/app/service.ts", "export interface Service { run(): void }\nexport const SERVICE = 1;\n");
    writeFile("src/primitives/value.ts", 'import { Service } from "../app/service";\nexport type V = Service;\n');
    writeFile("src/primitives/typed.ts", 'import type { Service } from "../app/service";\nexport type T = Service;\n');
    const components: Readonly<Record<string, string>> = {
      "src/primitives/value.ts": "primitives",
      "src/primitives/typed.ts": "primitives",
      "src/app/service.ts": "app",
    };
    const levels: Readonly<Record<string, number>> = { primitives: 0, app: 1 };
    const layering: LayeringReading = {
      positionOf: (component) =>
        component in levels ? { level: levels[component] ?? 0, depth: 0, inKnot: false } : undefined,
      knotClosedBy: () => undefined,
      isComposition: () => false,
      filesOf: (component) =>
        Object.entries(components)
          .filter(([, name]) => name === component)
          .map(([relPath]) => relPath),
    };
    const catalog = catalogOf(
      new Map(
        Object.entries(components).map(([relPath, name]) => [
          relPath,
          { name, instability: 0.5, distanceFromMainSequence: 0 },
        ]),
      ),
    );
    const backEdgeSubjectsOf = async (relPath: string): Promise<string[]> => {
      const read = await readWorkingTreeFileEdges(realDeps(), tree, relPath);
      const result = new DiffDetectorRun({ graph: graphOf([]), catalog, layering }).run(
        { changedFiles: [relPath] },
        new ReviewEdgeOverlay([read]),
      );
      return result.findings
        .filter((finding) => finding.detector === "layeringBackEdge")
        .map((finding) => finding.subject);
    };

    expect(await backEdgeSubjectsOf("src/primitives/value.ts")).toEqual([
      "src/primitives/value.ts -> src/app/service.ts",
    ]);
    expect(await backEdgeSubjectsOf("src/primitives/typed.ts")).toEqual([
      "src/primitives/typed.ts -> src/app/service.ts",
    ]);
  });
});

describe("workingTreeExtractionContext", () => {
  it("carries the working tree's Gemfile gems as Ruby's declared set when one is present", () => {
    const tree = freshWorkTree();
    writeFile("Gemfile", 'source "https://rubygems.org"\ngem "rails"\n');

    const context = workingTreeExtractionContext(tree, new LanguageFactory({}));

    expect(context.declaredDependencies?.get("ruby")).toEqual(new Set(["rails"]));
    expect(context.declaredDependencies?.has("python")).toBe(false);
  });

  it("carries no language's set when the tree declares no manifest", () => {
    const tree = freshWorkTree();

    const context = workingTreeExtractionContext(tree, new LanguageFactory({}));

    expect(context.declaredDependencies?.size).toBe(0);
  });
});
