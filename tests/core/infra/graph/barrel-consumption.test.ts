/**
 * Barrel import-direction guard for the `src/core/infra/graph` foundation
 * primitives (bd tea-rags-mcp-g7ca1).
 *
 * `infra/graph/` owns the pure graph algorithms (Tarjan SCC, PageRank, Otsu
 * split, weighted-threshold components) behind an `index.ts` barrel. Consumers
 * in `src/` and `tests/` MUST import the capability through that barrel;
 * importing `infra/graph/tarjan-scc.js`, `infra/graph/page-rank.js` etc.
 * directly past it is the leakingAbstraction BYPASS kind: the barrel cannot
 * vouch for (or re-shape) the graph surface without auditing every deep
 * importer by hand.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/language/facade-walker-barrel.test.ts`: a source-level
 * scan of runtime named import statements, resolved relative to the importing
 * file. `import type` clauses are erased at compile time and stay legal.
 *
 * The primitives' own unit tests (`tests/core/infra/graph/*.test.ts`) are
 * exempt: a unit test exercises its unit under test directly, that is the
 * intra-module case Rule 2 of `.claude/rules/barrel-files.md` allows.
 *
 * The dependency-norms facade contract test is also exempt: its deep import is
 * the test's SUBJECT — `expect(barrelName).toBe(deepName)` pins that the
 * barrel re-exports the primitive itself, not a wrapper. Repointing it to the
 * barrel would make that identity assertion compare the barrel with itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The barrel home whose consumers this guard pins. */
const BARREL_DIR = "src/core/infra/graph";
/** Unit tests of the primitives themselves — the intra-module exemption. */
const BARREL_UNIT_TESTS = "tests/core/infra/graph";

/** Deep specifiers must route through this barrel file instead. */
const DEEP_SPECIFIER = /infra\/graph\/(?!index\.js$)[^"']+\.js$/;

/** Files whose deep import is the assertion itself (barrel-identity pins). */
const IDENTITY_TEST_EXEMPTS = [
  "tests/core/domains/trajectory/codegraph/symbols/dependency-norms/facade-contract.test.ts",
] as const;

/** Scan roots for consumer files, each relative to the repo root. */
const SCAN_ROOTS = ["src", "tests"] as const;

interface RuntimeImport {
  names: string[];
  specifier: string;
}

/**
 * Named-form import statements carrying at least one RUNTIME clause.
 * `import type { A }` is erased at compile time; a mixed statement
 * (`import { f, type T }`) is runtime because `f` is a value edge.
 */
function runtimeImports(text: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const isTypeStatement = match[0].startsWith("import type");
    const names = match[1]
      .split(",")
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !/^type\s+/.test(clause));
    if (isTypeStatement || names.length === 0) continue;
    imports.push({ names, specifier: match[2] });
  }
  return imports;
}

/** Every `.ts` file under `scanRoot`, relative to the repo root. */
function tsFiles(scanRoot: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  visit(join(ROOT, scanRoot));
  return files.map((file) => relative(ROOT, file));
}

describe("infra/graph primitives are consumed through the barrel", () => {
  it("no file outside src/core/infra/graph/ runtime-imports an infra/graph/<file>.js deep path", () => {
    const offenders: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of tsFiles(scanRoot)) {
        if (file === `${BARREL_DIR}/index.ts`) continue;
        if (file.startsWith(`${BARREL_DIR}/`)) continue;
        if (file.startsWith(`${BARREL_UNIT_TESTS}/`)) continue;
        if ((IDENTITY_TEST_EXEMPTS as readonly string[]).includes(file)) continue;
        const text = readFileSync(join(ROOT, file), "utf-8");
        for (const statement of runtimeImports(text)) {
          if (!DEEP_SPECIFIER.test(statement.specifier)) continue;
          offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the graph barrel exposes the names its consumers import from it", () => {
    const barrel = readFileSync(join(ROOT, `${BARREL_DIR}/index.ts`), "utf-8");
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of tsFiles(scanRoot)) {
        const text = readFileSync(join(ROOT, file), "utf-8");
        for (const statement of runtimeImports(text)) {
          if (!statement.specifier.endsWith("infra/graph/index.js")) continue;
          for (const name of statement.names) {
            expect(barrel, `${BARREL_DIR}/index.ts must re-export "${name}" for ${file}`).toMatch(
              new RegExp(`\\b${name}\\b`),
            );
          }
        }
      }
    }
  });
});
