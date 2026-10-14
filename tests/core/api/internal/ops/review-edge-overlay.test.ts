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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffAddedEdges, DiffDetectorRun } from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import {
  readWorkingTreeFileEdges,
  workingTreeExtractionContext,
  type ReviewEdgeExtractionDeps,
  type ReviewEdgeReadContext,
} from "../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import { readReviewChangeEdges } from "../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import {
  buildReviewSymbolTable,
  type IndexedSymbolRows,
} from "../../../../../src/core/api/internal/ops/review-symbol-table.js";
import type { SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
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

  it("reports indexedSymbolsUnavailable for a language whose file edges read the symbol table, when no table was hydrated", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", 'class User < ApplicationRecord\n  def name = "n"\nend\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "app/models/user.rb");

    // The walk succeeds (the Ruby grammar is installed); the resolver reads the
    // symbol table, and none was hydrated — never read as "the project holds nothing".
    expect(read.language).toBe("ruby");
    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("indexedSymbolsUnavailable");
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
  // The TypeScript walker records a type-only import's export names exactly as
  // the value form's (`typeOnlyImportRef`, bd tea-rags-mcp-dourd), so the
  // index's type-only edge carries them — and so does the overlay's.
  it("yields the edge the value-import form yields for an `import type`, names included", async () => {
    const tree = freshWorkTree();
    writeFile("src/deep/internal.ts", "export interface Shape { a: number }\nexport const SHAPE = 1;\n");
    writeFile("src/value.ts", 'import { Shape } from "./deep/internal";\nexport const v: Shape = { a: 1 };\n');
    writeFile("src/typed.ts", 'import type { Shape } from "./deep/internal";\nexport const v: Shape = { a: 1 };\n');

    const value = await readWorkingTreeFileEdges(realDeps(), tree, "src/value.ts");
    const typed = await readWorkingTreeFileEdges(realDeps(), tree, "src/typed.ts");

    expect(value.edges).toEqual([
      { sourceRelPath: "src/value.ts", targetRelPath: "src/deep/internal.ts", importedExportNames: ["Shape"] },
    ]);
    expect(typed.edges).toEqual([
      { sourceRelPath: "src/typed.ts", targetRelPath: "src/deep/internal.ts", importedExportNames: ["Shape"] },
    ]);
  });

  // Same rule as the index's runner: one edge per target, the runtime
  // statement's names first, then the type-only statement's (bd tea-rags-mcp-dourd).
  it("collapses a runtime and a type-only import of one target into one edge carrying both statements' names", async () => {
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
      { sourceRelPath: "src/both.ts", targetRelPath: "src/b.ts", importedExportNames: ["B", "Shape"] },
      { sourceRelPath: "src/both.ts", targetRelPath: "src/c.ts", importedExportNames: ["Other"] },
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

/** A definition row as `cg_symbols` persists it. */
function indexedDefinition(relPath: string, fqName: string): SymbolDefinition {
  const shortName = fqName.split(/::|\.|#/).pop()!;
  return { symbolId: fqName, fqName, shortName, relPath, scope: [] };
}

/** The review's table over `rows`, the tree untouched by the change. */
function hydratedTable(tree: string, rows: IndexedSymbolRows): ReviewEdgeReadContext {
  return {
    symbolTable: {
      table: buildReviewSymbolTable(rows, { workTree: tree, touchedFiles: new Set(), treeExtractions: [] }),
    },
  };
}

describe("readWorkingTreeFileEdges — table-backed languages over the hydrated index (bd tea-rags-mcp-vdhjc)", () => {
  it("resolves a Ruby Zeitwerk constant ref and a superclass to their declaring files", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/application_record.rb", "class ApplicationRecord\nend\n");
    writeFile("app/models/billing/invoice.rb", "module Billing\n  class Invoice\n  end\nend\n");
    writeFile(
      "app/models/user.rb",
      "class User < ApplicationRecord\n  def bill\n    Billing::Invoice.new\n  end\nend\n",
    );
    const context = hydratedTable(tree, {
      definitions: [
        indexedDefinition("app/models/application_record.rb", "ApplicationRecord"),
        indexedDefinition("app/models/billing/invoice.rb", "Billing"),
        indexedDefinition("app/models/billing/invoice.rb", "Billing::Invoice"),
      ],
      files: ["app/models/application_record.rb", "app/models/billing/invoice.rb", "app/models/user.rb"],
    });

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "app/models/user.rb", context);

    expect(read.skip).toBeUndefined();
    expect(read.edges.map((edge) => edge.targetRelPath).sort()).toEqual([
      "app/models/application_record.rb",
      "app/models/billing/invoice.rb",
    ]);
  });

  it("resolves a JavaScript relative import to the indexed file it names", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.js", "export const b = 1;\n");
    writeFile("src/a.js", 'import { b } from "./b.js";\nexport const a = b;\n');
    const context = hydratedTable(tree, { definitions: [], files: ["src/a.js", "src/b.js"] });

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.js", context);

    expect(read.skip).toBeUndefined();
    expect(read.edges.map((edge) => edge.targetRelPath)).toEqual(["src/b.js"]);
  });

  it("resolves a Python absolute import to the indexed module file", async () => {
    const tree = freshWorkTree();
    writeFile("pkg/__init__.py", "");
    writeFile("pkg/mod.py", "def f():\n    return 1\n");
    writeFile("app.py", "from pkg.mod import f\n\nf()\n");
    const context = hydratedTable(tree, {
      definitions: [indexedDefinition("pkg/mod.py", "pkg.mod.f")],
      files: ["pkg/__init__.py", "pkg/mod.py", "app.py"],
    });

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "app.py", context);

    expect(read.skip).toBeUndefined();
    expect(read.edges.map((edge) => edge.targetRelPath)).toEqual(["pkg/mod.py"]);
  });

  it("carries the hydration failure as the skip detail", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", "class User < ApplicationRecord\nend\n");

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "app/models/user.rb", {
      symbolTable: { unavailable: "reading the indexed symbol table failed: daemon down" },
    });

    expect(read.edges).toEqual([]);
    expect(read.skip).toEqual({
      reason: "indexedSymbolsUnavailable",
      detail: "reading the indexed symbol table failed: daemon down",
    });
  });

  it("keeps TypeScript resolving from disk when no table could be hydrated", async () => {
    const tree = freshWorkTree();
    writeFile("src/b.ts", "export const B = 1;\n");
    writeFile("src/a.ts", 'import { B } from "./b";\nexport const A = B;\n');

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "src/a.ts", {
      symbolTable: { unavailable: "the collection has no codegraph database" },
    });

    expect(read.skip).toBeUndefined();
    expect(read.edges.map((edge) => edge.targetRelPath)).toEqual(["src/b.ts"]);
  });

  it("reports resolvedCallsUnavailable for a language whose file edges derive from resolved calls", async () => {
    const tree = freshWorkTree();
    writeFile("Sources/App/main.swift", "import Foundation\nfunc run() { helper() }\n");
    const context = hydratedTable(tree, { definitions: [], files: ["Sources/App/main.swift"] });

    const read = await readWorkingTreeFileEdges(realDeps(), tree, "Sources/App/main.swift", context);

    // An empty edge list here would mask the file's indexed edges as removed.
    expect(read.edges).toEqual([]);
    expect(read.skip?.reason).toBe("resolvedCallsUnavailable");
  });
});

describe("readReviewChangeEdges — one hydrated table per review read", () => {
  it("overlays the tree on the indexed rows: a constant whose file the change adds resolves", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/application_record.rb", "class ApplicationRecord\nend\n");
    writeFile("app/models/ledger.rb", "class Ledger < ApplicationRecord\nend\n");
    writeFile("app/models/user.rb", "class User < ApplicationRecord\n  def l = Ledger.new\nend\n");
    const files = ["app/models/user.rb", "app/models/ledger.rb"];

    const { overlay } = await readReviewChangeEdges(
      { workTree: tree, mergeBase: "0".repeat(40), files, touchedFiles: new Set(files) },
      realDeps(),
      {
        rows: {
          definitions: [indexedDefinition("app/models/application_record.rb", "ApplicationRecord")],
          files: ["app/models/application_record.rb", "app/models/user.rb"],
        },
      },
    );

    expect(overlay.unsupported()).toEqual([]);
    expect(
      overlay
        .edgesFrom("app/models/user.rb")
        .map((edge) => edge.targetRelPath)
        .sort(),
    ).toEqual(["app/models/application_record.rb", "app/models/ledger.rb"]);
  });

  it("skips every table-backed file with the reason when the index rows are unavailable", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", "class User < ApplicationRecord\nend\n");
    const files = ["app/models/user.rb"];

    const { overlay } = await readReviewChangeEdges(
      { workTree: tree, mergeBase: "0".repeat(40), files, touchedFiles: new Set(files) },
      realDeps(),
      { unavailable: "the collection has no codegraph database" },
    );

    expect(overlay.unsupported()).toEqual([
      {
        relPath: "app/models/user.rb",
        reason: "indexedSymbolsUnavailable",
        detail: "the collection has no codegraph database",
      },
    ]);
  });

  it("marks every touched path the working tree no longer holds as deleted (bd tea-rags-mcp-ah66x)", async () => {
    const tree = freshWorkTree();
    writeFile("app/models/user.rb", "class User\nend\n");
    const files = ["app/models/user.rb"];

    const { overlay } = await readReviewChangeEdges(
      {
        workTree: tree,
        mergeBase: "0".repeat(40),
        files,
        touchedFiles: new Set([...files, "app/models/gone.rb"]),
      },
      realDeps(),
      { unavailable: "the collection has no codegraph database" },
    );

    expect([...overlay.deleted]).toEqual(["app/models/gone.rb"]);
  });
});

/** Runs git in the temp tree with a fixed identity — the fixture never reads the user's config. */
function gitIn(tree: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd: tree,
    encoding: "utf8",
  }).trim();
}

/** Commits the temp tree as the diff base; returns its sha. */
function commitBase(tree: string): string {
  gitIn(tree, "init", "-q");
  gitIn(tree, "add", "-A");
  gitIn(tree, "commit", "-q", "--no-verify", "-m", "base");
  return gitIn(tree, "rev-parse", "HEAD");
}

// bd tea-rags-mcp-slsia: both sides resolve against ONE table built from the
// index + the tree, so a base text naming a constant the tree has since renamed
// resolved nowhere and the tree's edge to the SAME file read as added. The
// index below has caught up to the tree, as it had on taxdome.
describe("readReviewChangeEdges — the base side of a rename (bd tea-rags-mcp-slsia)", () => {
  const CONTROLLER = "app/controllers/app_controller.rb";
  const AUTH = "lib/platform/concerns/auth_methods.rb";
  const INVOICE = "app/models/billing/invoice.rb";

  async function addedEdges(
    tree: string,
    scope: { mergeBase: string; files: string[]; touchedFiles: string[]; renamedFrom?: Map<string, string> },
    definitions: SymbolDefinition[],
  ): Promise<string[]> {
    const { overlay, baseEdges } = await readReviewChangeEdges(
      { workTree: tree, ...scope, touchedFiles: new Set(scope.touchedFiles) },
      realDeps(),
      { rows: { definitions, files: [...new Set(definitions.map((def) => def.relPath))] } },
    );
    expect(overlay.unsupported()).toEqual([]);
    expect(baseEdges).toBeDefined();
    return diffAddedEdges(scope.files, overlay, { baseEdges }).map((edge) => `${edge.source} -> ${edge.target}`);
  }

  it("a module constant renamed inside its file is no added edge — the base names the same file", async () => {
    const tree = freshWorkTree();
    writeFile(AUTH, "module Platform\n  module Concerns\n    module AuthMethods\n    end\n  end\nend\n");
    writeFile(CONTROLLER, "class AppController\n  include Platform::Concerns::AuthMethods\nend\n");
    const mergeBase = commitBase(tree);
    writeFile(AUTH, "module Platform\n  module AuthMethods\n  end\nend\n");
    writeFile(CONTROLLER, "class AppController\n  include Platform::AuthMethods\nend\n");

    const added = await addedEdges(tree, { mergeBase, files: [CONTROLLER], touchedFiles: [CONTROLLER, AUTH] }, [
      indexedDefinition(AUTH, "Platform"),
      indexedDefinition(AUTH, "Platform::AuthMethods"),
      indexedDefinition(CONTROLLER, "AppController"),
    ]);

    expect(added).toEqual([]);
  });

  it("a constant the base text never named stays added, though its file's definitions changed too", async () => {
    const tree = freshWorkTree();
    writeFile(INVOICE, "module Billing\n  class Bill\n  end\nend\n");
    writeFile(CONTROLLER, "class AppController\nend\n");
    const mergeBase = commitBase(tree);
    writeFile(INVOICE, "module Billing\n  class Invoice\n  end\nend\n");
    writeFile(CONTROLLER, "class AppController\n  def show = Billing::Invoice.new\nend\n");

    const added = await addedEdges(tree, { mergeBase, files: [CONTROLLER], touchedFiles: [CONTROLLER, INVOICE] }, [
      indexedDefinition(INVOICE, "Billing"),
      indexedDefinition(INVOICE, "Billing::Invoice"),
      indexedDefinition(CONTROLLER, "AppController"),
    ]);

    expect(added).toEqual([`${CONTROLLER} -> ${INVOICE}`]);
  });

  it("a moved source file is read at the path the base held it — its unchanged references are not added", async () => {
    const tree = freshWorkTree();
    const oldChannel = "app/channels/v1/messages_channel.rb";
    const newChannel = "app/channels/communication/v1/messages_channel.rb";
    const channelText = "class MessagesChannel\n  def typing = Billing::Invoice.new\nend\n";
    writeFile(INVOICE, "module Billing\n  class Invoice\n  end\nend\n");
    writeFile(oldChannel, channelText);
    const mergeBase = commitBase(tree);
    rmSync(join(tree, oldChannel));
    writeFile(newChannel, channelText);

    const added = await addedEdges(
      tree,
      {
        mergeBase,
        files: [newChannel],
        touchedFiles: [newChannel, oldChannel],
        renamedFrom: new Map([[newChannel, oldChannel]]),
      },
      [
        indexedDefinition(INVOICE, "Billing"),
        indexedDefinition(INVOICE, "Billing::Invoice"),
        indexedDefinition(newChannel, "MessagesChannel"),
      ],
    );

    expect(added).toEqual([]);
  });

  it("a target moved with its namespace is no added edge — the base named it under its old constant", async () => {
    const tree = freshWorkTree();
    const oldSerializer = "app/serializers/api/show_serializer.rb";
    const newSerializer = "app/serializers/tech/api/show_serializer.rb";
    writeFile(oldSerializer, "class Api::ShowSerializer\nend\n");
    writeFile(CONTROLLER, "class AppController\n  def show = Api::ShowSerializer.new\nend\n");
    const mergeBase = commitBase(tree);
    rmSync(join(tree, oldSerializer));
    writeFile(newSerializer, "class Tech::Api::ShowSerializer\nend\n");
    writeFile(CONTROLLER, "class AppController\n  def show = Tech::Api::ShowSerializer.new\nend\n");

    const added = await addedEdges(
      tree,
      {
        mergeBase,
        files: [CONTROLLER],
        touchedFiles: [CONTROLLER, oldSerializer, newSerializer],
        renamedFrom: new Map([[newSerializer, oldSerializer]]),
      },
      [indexedDefinition(newSerializer, "Tech::Api::ShowSerializer"), indexedDefinition(CONTROLLER, "AppController")],
    );

    expect(added).toEqual([]);
  });
});
